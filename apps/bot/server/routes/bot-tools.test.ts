import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBotApp } from "../app"
import { BotRegistry } from "../bot-registry"
import { BotToolSessions } from "../bot-tool-sessions"
import { createCapabilityGate } from "../capability-gate"
import { RuntimeBroker } from "../runtime-broker"
import type { Turn } from "../generated/v2/Turn"
import { BOT_WORK_SUMMARY_STATUS_GUIDANCE } from "../../shared/bot-work-summary"

test("Bot MCP binds the caller to its credential and preserves existing handoff authorization", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-tools-"))
  const registry = new BotRegistry(join(dir, "registry.sqlite"), join(dir, "artifacts"))

  const sessions = new BotToolSessions()
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const caller = registry.create(principal, { name: "A", description: "Caller" })
  const target = registry.create(principal, { name: "B", description: "Target" })
  const config = sessions.config(caller.id, principal, "test-token")
  expect(config.default_tools_approval_mode).toBe("auto")
  expect(config.tools).toEqual({ request_user_input_async: { approval_mode: "approve" }, update_work_summary: { approval_mode: "approve" } })
  const broker = new RuntimeBroker({ provision: async () => { throw new Error("not needed") } })
  const runtime = await broker.start(principal, { onMessage() {}, onExit() {} }, undefined, "refreshed-test-token")
  const gate = createCapabilityGate({ mode: "open" })
  let observedToken: string | undefined
  const app = await createBotApp({ botRegistry: registry, botToolSessions: sessions, runtimeBroker: broker, capabilityGate: { ...gate, resolve: async (owner, capability, token) => { observedToken = token; return gate.resolve(owner, capability, token) } } })
  const call = (name: string, args: unknown) => app.inject({ method: "POST", url: "/api/bot-tools", headers: config.http_headers, payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } })
  try {
    const missing = await app.inject({ method: "POST", url: "/api/bot-tools", payload: { id: 1, method: "tools/list" } })
    expect(missing.statusCode).toBe(401)
    const listedTools = await app.inject({ method: "POST", url: "/api/bot-tools", headers: config.http_headers, payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } })
    const updateWorkSummary = listedTools.json().result.tools.find((tool: { name: string }) => tool.name === "update_work_summary")
    expect(updateWorkSummary.inputSchema.properties.status.description).toBe(BOT_WORK_SUMMARY_STATUS_GUIDANCE)
    const listed = await call("list_bots", {})
    expect(observedToken).toBe("refreshed-test-token")
    const bots = JSON.parse(listed.json().result.content[0].text)
    expect(bots.map((bot: { botId: string }) => bot.botId)).toEqual([target.id])
    const spoofed = await call("send_to_bot", { fromBotId: target.id, botId: target.id, message: "FYI", kind: "fyi" })
    expect(spoofed.json().result.isError).toBe(true)
    const accepted = await call("send_to_bot", { botId: target.id, message: "FYI", kind: "fyi" })
    expect(accepted.json().result.isError).toBe(false)
    const ack = JSON.parse(accepted.json().result.content[0].text)
    expect(registry.getHandoff(principal, ack.handoffId)?.fromBotId).toBe(caller.id)
    const invalid = sessions.config(caller.id, { ...principal, subject_id: "other" }, "other-token")
    const denied = await app.inject({ method: "POST", url: "/api/bot-tools", headers: invalid.http_headers, payload: { id: 1, method: "tools/list" } })
    expect(denied.statusCode).toBe(401)
    const memory = await call("remember", { key: "驗證事實", content: "Bot-owned fact", kind: "fact" })
    expect(memory.json().result.isError).toBe(false)
    expect(registry.memory.list(caller.id)[0]?.origin).toBe("bot")
    expect(registry.memory.recall(target.id).memories).toHaveLength(0)
    const recalled = await call("recall_memory", { query: "驗證事實" })
    const record = JSON.parse(recalled.json().result.content[0].text).memories[0]
    const forgotten = await call("forget_memory", { memoryId: record.id, expectedRevision: record.revision })
    expect(forgotten.json().result.isError).toBe(false)
    expect(registry.memory.recall(caller.id).memories).toHaveLength(0)
    const historyTurn = (id: string, text: string) => ({ id, status: "completed", items: [{ type: "agentMessage", id, text }] } as Turn)
    registry.timeline.putTurn(caller.id, "caller-history", historyTurn("own", "Own saved result"))
    registry.timeline.putTurn(target.id, "target-history", historyTurn("private", "Other Bot private result"))
    const searched = await call("search_history", { query: "saved result" })
    const found = JSON.parse(searched.json().result.content[0].text).messages
    expect(found[0].messageId).toBe("caller-history:own")
    const read = await call("read_history", { messageId: found[0].messageId })
    expect(JSON.parse(read.json().result.content[0].text).text).toBe("Own saved result")
    expect((await call("search_history", { botId: target.id })).json().result.isError).toBe(true)
    expect((await call("read_history", { messageId: "target-history:private" })).json().result.isError).toBe(true)
    const state = JSON.parse((await call("read_work_summary", {})).json().result.content[0].text)
    expect(state).toMatchObject({ expectedRevision: 0, writable: true, entry: null })
    const work = { goal: "Continue saved work", status: "active", decisions: [], progress: ["Read saved result"], nextSteps: ["Compare findings"], blockers: [], sourceMessageIds: ["caller-history:own"], expectedRevision: 0 }
    expect((await call("update_work_summary", work)).json().result.isError).toBe(false)
    expect((await call("update_work_summary", work)).json().result.isError).toBe(true)
    const invalidStatus = (await call("update_work_summary", { ...work, status: "completed", expectedRevision: 1 })).json().result
    expect(invalidStatus.isError).toBe(true)
    expect(invalidStatus.content[0].text).toContain(BOT_WORK_SUMMARY_STATUS_GUIDANCE)
    expect(invalidStatus.content[0].text).toContain("Retry immediately with the current expectedRevision")
    expect(registry.memory.workSummary(caller.id).expectedRevision).toBe(1)
    const recovered = (await call("update_work_summary", { ...work, expectedRevision: 1 })).json().result
    expect(recovered.isError).toBe(false)
    expect(registry.memory.workSummary(caller.id).entry?.workSummary).toMatchObject({ status: "active", nextSteps: work.nextSteps })
    expect((await call("update_work_summary", { ...work, expectedRevision: 2, sourceMessageIds: ["target-history:private"] })).json().result.isError).toBe(true)
    expect(registry.memory.workSummary(caller.id).entry?.workSummary?.goal).toBe(work.goal)
    expect(registry.memory.workSummary(target.id).entry).toBeNull()
  } finally { await app.close(); await broker.stop(runtime.id); registry.close(); rmSync(dir, { recursive: true, force: true }) }
})
