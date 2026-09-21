import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBotApp } from "../app"
import { BotRegistry } from "../bot-registry"
import { BotToolSessions } from "../bot-tool-sessions"
import { createCapabilityGate } from "../capability-gate"
import { RuntimeBroker } from "../runtime-broker"
import type { RuntimePolicyResolver } from "../runtime-policy-contract"

test("model MCP manages only its own persistent profile, Skills and schedules", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-default-tools-route-"))
  const registry = new BotRegistry(join(directory, "registry.sqlite"), join(directory, "artifacts"))
  const owner = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const bot = registry.create(owner, { name: "A" })
  const other = registry.create(owner, { name: "B" })
  const sessions = new BotToolSessions()
  let provisions = 0
  const broker = new RuntimeBroker({ provision: async () => { provisions += 1; throw new Error("UNEXPECTED_PROVISION") } })
  const runtime = await broker.start(owner, { onMessage() {}, onExit() {} }, undefined, "owner-token")
  const config = sessions.config(bot.id, owner, runtime.id)
  const gate = createCapabilityGate({ mode: "fixture", personalBotAllowlist: ["tenant:owner"] })
  const policy: RuntimePolicyResolver = { read: async () => { throw new Error("DENIED") }, resolve: async () => { throw new Error("DENIED") }, authorize: async () => { throw new Error("DENIED") }, report: async () => {} }
  const app = await createBotApp({ botRegistry: registry, botToolSessions: sessions, runtimeBroker: broker, capabilityGate: gate, runtimePolicy: policy })
  let sequence = 0
  const call = async (name: string, args: unknown) => {
    const response = await app.inject({ method: "POST", url: "/api/bot-tools", headers: config.http_headers, payload: { jsonrpc: "2.0", id: ++sequence, method: "tools/call", params: { name, arguments: args } } })
    return response.json().result as { isError?: boolean; content: Array<{ type: string; text: string }> }
  }
  const read = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0]!.text)
  try {
    const listing = await app.inject({ method: "POST", url: "/api/bot-tools", headers: config.http_headers, payload: { id: ++sequence, method: "tools/list" } })
    const names = listing.json().result.tools.map((tool: { name: string }) => tool.name)
    expect(names).toEqual(expect.arrayContaining(["read_self", "update_self", "create_bot", "write_owned_skill", "create_schedule", "send_to_bot"]))
    expect(names).not.toContain("computer_use")
    expect(new Set(names).size).toBe(names.length)

    const self = read(await call("read_self", {}))
    const updated = await call("update_self", { expectedRevision: self.bot.revision, voice: "Use concise Traditional Chinese" })
    expect(updated.isError).toBe(false)
    expect(registry.getOwned(bot.id, owner)?.voice).toBe("Use concise Traditional Chinese")
    expect(registry.getOwned(other.id, owner)?.voice).toBe("")
    expect((await call("update_self", { expectedRevision: self.bot.revision, name: "stale" })).isError).toBe(true)
    expect((await call("update_self", { expectedRevision: self.bot.revision + 1, botId: other.id, name: "spoof" })).isError).toBe(true)

    const content = "---\nname: daily-check\ndescription: Summarize the user's daily work\n---\nRead the current request and produce three concise next actions.\n"
    const skill = await call("write_owned_skill", { skillName: "daily-check", expectedRevision: 0, files: { "SKILL.md": content } })
    expect(skill.isError).toBe(false)
    expect(read(await call("read_owned_skill", { skillName: "daily-check" })).skill.files).toContainEqual({ path: "SKILL.md", content })
    expect((await call("write_owned_skill", { skillName: "daily-check", expectedRevision: 1, files: { "../escape": "invalid", "SKILL.md": content } })).isError).toBe(true)

    const scheduleInput = { clientRequestId: "one-request", prompt: "Summarize current work", schedule: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() } }
    const created = read(await call("create_schedule", scheduleInput))
    const repeated = read(await call("create_schedule", scheduleInput))
    expect(repeated.schedule.id).toBe(created.schedule.id)
    expect(read(await call("list_schedules", {})).schedules).toHaveLength(1)
    expect((await call("update_schedule", { scheduleId: created.schedule.id, expectedRevision: created.schedule.revision, enabled: false })).isError).toBe(false)
    expect((await call("update_schedule", { scheduleId: created.schedule.id, expectedRevision: created.schedule.revision, enabled: true })).isError).toBe(true)
    expect((await call("computer_use", { operation: "screenshot" })).isError).toBe(true)
    expect(provisions).toBe(0)
    const invalid = sessions.config(other.id, { ...owner, subject_id: "stranger" }, "stranger-runtime")
    const rejected = await app.inject({ method: "POST", url: "/api/bot-tools", headers: invalid.http_headers, payload: { id: ++sequence, method: "tools/call", params: { name: "read_self", arguments: {} } } })
    expect(rejected.statusCode).toBe(401)
  } finally {
    await app.close()
    await broker.stop(runtime.id)
    registry.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
