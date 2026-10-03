import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Fastify from "fastify"
import { createBotApp } from "../app"
import { BotRegistry } from "../bot-registry"
import { BotConnectionInteractions } from "../bot-connection-interactions"
import { BotToolSessions } from "../bot-tool-sessions"
import { createCapabilityGate } from "../capability-gate"
import type { BotServerContext } from "../context"
import { RuntimeBroker } from "../runtime-broker"
import type { RuntimePolicyDecision } from "../runtime-policy-contract"
import type { Turn } from "../generated/v2/Turn"
import { BOT_WORK_SUMMARY_STATUS_GUIDANCE } from "../../shared/bot-work-summary"
import { botToolRoutes } from "./bot-tools"

test("Bot MCP binds the caller to its credential and preserves existing handoff authorization", async () => {
  const scheduleAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString()
  const dir = mkdtempSync(join(tmpdir(), "bot-tools-"))
  const registry = new BotRegistry(join(dir, "registry.sqlite"), join(dir, "artifacts"))

  const sessions = new BotToolSessions()
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const caller = registry.create(principal, { name: "A", description: "Caller" })
  const target = registry.create(principal, { name: "B", description: "Target" })
  const broker = new RuntimeBroker({ provision: async () => { throw new Error("not needed") } })
  const runtime = await broker.start(principal, { onMessage() {}, onExit() {} }, undefined, "refreshed-test-token")
  let replacementRuntimeId: string | undefined
  const config = sessions.config(caller.id, principal, runtime.id)
  expect(config.default_tools_approval_mode).toBe("writes")
  expect(config.tools).toEqual({ request_user_input_async: { approval_mode: "approve" }, update_work_summary: { approval_mode: "approve" } })
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
    const invalid = sessions.config(caller.id, { ...principal, subject_id: "other" }, "other-runtime")
    const tokenBeforeDenied = observedToken
    const denied = await app.inject({ method: "POST", url: "/api/bot-tools", headers: invalid.http_headers, payload: { id: 1, method: "tools/list" } })
    expect(denied.statusCode).toBe(401)
    expect(observedToken).toBe(tokenBeforeDenied)
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

    const invocationTools = sessions.bindInvocation(runtime.id, caller.id, principal, "invocation-a", "delegated-tools-token")
    expect(invocationTools.config.http_headers).toEqual(config.http_headers)
    expect(() => sessions.bindInvocation(runtime.id, caller.id, principal, "invocation-b", "delegated-tools-token-b")).toThrow("BOT_TOOL_INVOCATION_CONFLICT")
    const delegated = await app.inject({ method: "POST", url: "/api/bot-tools", headers: invocationTools.config.http_headers, payload: { jsonrpc: "2.0", id: 2, method: "tools/list" } })
    expect(delegated.statusCode).toBe(200)
    expect(observedToken).toBe("delegated-tools-token")
    const foregroundDuringInvocation = await app.inject({ method: "POST", url: "/api/bot-tools", headers: config.http_headers, payload: { jsonrpc: "2.0", id: 3, method: "tools/list" } })
    expect(foregroundDuringInvocation.statusCode).toBe(200)
    expect(observedToken).toBe("delegated-tools-token")
    await broker.start(principal, { onMessage() {}, onExit() {} }, undefined, "rotated-owner-token")
    const delegatedAfterOwnerRotation = await app.inject({ method: "POST", url: "/api/bot-tools", headers: invocationTools.config.http_headers, payload: { jsonrpc: "2.0", id: 4, method: "tools/list" } })
    expect(delegatedAfterOwnerRotation.statusCode).toBe(200)
    expect(observedToken).toBe("delegated-tools-token")
    invocationTools.release()
    const originalNow = Date.now
    Date.now = () => originalNow() + 32 * 60_000
    try {
      const foregroundAfterRotation = await app.inject({ method: "POST", url: "/api/bot-tools", headers: config.http_headers, payload: { jsonrpc: "2.0", id: 5, method: "tools/list" } })
      expect(foregroundAfterRotation.statusCode).toBe(200)
      expect(observedToken).toBe("rotated-owner-token")
    } finally { Date.now = originalNow }
    const retainedNativeConfig = await app.inject({ method: "POST", url: "/api/bot-tools", headers: invocationTools.config.http_headers, payload: { jsonrpc: "2.0", id: 6, method: "tools/list" } })
    expect(retainedNativeConfig.statusCode).toBe(200)
    expect(observedToken).toBe("rotated-owner-token")
    registry.connectionContinuations.enqueue({
      requestToken: "read-only-continuation",
      botId: caller.id,
      tenantId: principal.tenant_id,
      ownerSubjectId: principal.subject_id,
      sourceThreadId: "connection-thread",
      sourceTurnId: "connection-turn",
      resourceId: "notion",
      resourceName: "Notion",
      capabilityId: "notion.search",
    })
    registry.connectionContinuations.markMcpReloaded("read-only-continuation", ["genio_mcp_notion"])
    expect(registry.connectionContinuations.claim("read-only-continuation")).toBe(true)
    const blockedStartingSchedule = await call("create_schedule", { clientRequestId: "read-only-starting", prompt: "write", schedule: { kind: "once", at: scheduleAt } })
    expect(blockedStartingSchedule.json().result.content[0].text).toBe("CONNECTION_CONTINUATION_READ_ONLY")
    expect(registry.connectionContinuations.retryStarting("read-only-continuation")).toMatchObject({ state: "retrying" })
    const blockedRetrySchedule = await call("create_schedule", { clientRequestId: "read-only-retrying", prompt: "write", schedule: { kind: "once", at: scheduleAt } })
    expect(blockedRetrySchedule.json().result.content[0].text).toBe("CONNECTION_CONTINUATION_READ_ONLY")
    registry.timeline.putTurn(caller.id, "separate-thread", { id: "separate-turn", status: "inProgress", items: [] } as unknown as Turn)
    const separateThreadSchedule = await call("create_schedule", { clientRequestId: "separate-thread", prompt: "write", schedule: { kind: "once", at: scheduleAt } })
    expect(separateThreadSchedule.json().result.content[0].text).toBe("CONNECTION_CONTINUATION_READ_ONLY")
    expect(registry.connectionContinuations.cancel("read-only-continuation", "CONNECTION_SOURCE_SUPERSEDED")).toMatchObject({ state: "guarded" })
    const blockedGuardedSchedule = await call("create_schedule", { clientRequestId: "read-only-guarded", prompt: "write", schedule: { kind: "once", at: scheduleAt } })
    expect(blockedGuardedSchedule.json().result.content[0].text).toBe("CONNECTION_CONTINUATION_READ_ONLY")
    const guarded = registry.connectionContinuations.get("read-only-continuation")
    registry.connectionContinuations.reconcile(guarded, [{ id: "continued-turn", status: "completed", itemsView: "full", error: null, startedAt: 1, completedAt: 2, durationMs: 1, items: [{ type: "userMessage", id: "continued-input", clientId: guarded.clientId, content: [] }] } as Turn])
    const terminalAfterGuardedSchedule = await call("create_schedule", { clientRequestId: "after-guarded-terminal", prompt: "write", schedule: { kind: "once", at: scheduleAt } })
    expect(terminalAfterGuardedSchedule.json().result.isError).toBe(false)
    await broker.stop(runtime.id)
    const replacement = await broker.start(principal, { onMessage() {}, onExit() {} }, undefined, "replacement-owner-token")
    replacementRuntimeId = replacement.id
    const tokenBeforeReplacementDenied = observedToken
    const replacementDenied = await app.inject({ method: "POST", url: "/api/bot-tools", headers: config.http_headers, payload: { jsonrpc: "2.0", id: 7, method: "tools/list" } })
    expect(replacementDenied.statusCode).toBe(401)
    expect(observedToken).toBe(tokenBeforeReplacementDenied)
  } finally { await app.close(); if (replacementRuntimeId) await broker.stop(replacementRuntimeId); await broker.stop(runtime.id); registry.close(); rmSync(dir, { recursive: true, force: true }) }
})

test("OAuth resource retry refreshes the current Bot MCP mount before completing the tool response", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-tools-oauth-"))
  const registry = new BotRegistry(join(dir, "registry.sqlite"), join(dir, "artifacts"))
  const sessions = new BotToolSessions()
  const interactions = new BotConnectionInteractions()
  const principal = { tenant_id: "tenant-oauth", subject_id: "owner-oauth", acting_client_id: "genio-one-bot", scopes: [] }
  const bot = registry.create(principal, { name: "OAuth Bot", description: "Refreshes its connection" })
  const broker = new RuntimeBroker({ provision: async () => { throw new Error("not needed") } })
  const runtime = await broker.start(principal, { onMessage() {}, onExit() {} }, undefined, "oauth-tool-token")
  runtime.selectedBotId = bot.id
  const config = sessions.config(bot.id, principal, runtime.id)
  const requests: Array<{ method: string; params: unknown }> = []
  const reports: Array<Record<string, unknown>> = []
  let correlation = 0
  const decision = (capabilityId: string, action: string) => ({
    tenant_id: principal.tenant_id,
    subject_id: principal.subject_id,
    client_id: principal.acting_client_id,
    bot_id: bot.id,
    runtime_id: "codex",
    policy_id: "runtime-policy",
    policy_display_name: "Runtime policy",
    policy_revision: 1,
    capability_id: capabilityId,
    action,
    target: `runtime:codex:${capabilityId}`,
    decision: "ALLOW",
    reason_code: "RULE_ALLOW",
    constraints: [],
    obligations: [],
    correlation_id: `oauth-correlation-${++correlation}`,
    session_id: runtime.id,
    evaluated_at: 1_757_000_000,
  }) as RuntimePolicyDecision
  const runtimePolicy = {
    async authorize(input: { capabilityId: string; action: string }) { return decision(input.capabilityId, input.action) },
    async resolve(input: { capabilityId: string; action: string }) { return decision(input.capabilityId, input.action) },
    async read() { return { decisions: [] } },
    async report(input: Record<string, unknown>) { reports.push(input) },
  }
  ;(broker as unknown as { request: (sessionId: string, method: string, params: unknown) => Promise<unknown> }).request = async (_sessionId, method, params) => {
    requests.push({ method, params })
    if (method === "config/read") {
      return { layers: [{ name: { type: "user" }, version: "sha256:one", config: { mcp_servers: { external: { command: "external-mcp" } } } }] }
    }
    return {}
  }
  const context = {
    botToolSessions: sessions,
    botRegistry: registry,
    runtimeBroker: broker,
    capabilityGate: createCapabilityGate({ mode: "open" }),
    runtimePolicy,
    connectionInteractions: interactions,
  } as unknown as BotServerContext
  const app = Fastify()
  await botToolRoutes(app, context)
  const originalFetch = globalThis.fetch
  const originalPlatformOrigin = process.env.GENIO_ONE_PLATFORM_ORIGIN
  const originalMcpUrl = process.env.GENIO_ONE_MCP_URL
  const originalRelayOrigin = process.env.GENIO_ONE_MCP_RELAY_ORIGIN
  process.env.GENIO_ONE_PLATFORM_ORIGIN = "http://platform.test"
  process.env.GENIO_ONE_MCP_URL = "http://one.test/mcp"
  process.env.GENIO_ONE_MCP_RELAY_ORIGIN = "https://bot.test"
  let connected = false
  type DeliveredRequest = { requestToken: string; botId: string; threadId: string; turnId: string; resourceId: string }
  let resolveRequest!: (request: DeliveredRequest) => void
  let rejectRequest!: (error: Error) => void
  const delivered = new Promise<DeliveredRequest>((resolve, reject) => {
    resolveRequest = resolve
    rejectRequest = reject
  })
  const deliveryTimeout = setTimeout(() => rejectRequest(new Error("BOT_CONNECTION_REQUEST_NOT_DELIVERED")), 1_000)
  deliveryTimeout.unref()
  const unsubscribe = interactions.subscribe({
    principal,
    botId: bot.id,
    runtimeSessionId: runtime.id,
    send: (pending) => resolveRequest(pending),
  })
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname
    if (path.endsWith("/catalog")) {
      return Response.json({ capabilities: [{
        resource_id: "notion",
        resource_display_name: "Notion",
        capability_id: "notion.search",
        access: "AUTO_GRANT",
        publication_endpoint: { hostname: "notion.example.test", base_path: "/mcp" },
      }] })
    }
    if (path.endsWith("/me/resource-connections/notion")) {
      return Response.json([{ connection_id: "notion-connection", authentication: "OAUTH", status: connected ? "CONNECTED" : "NEEDS_CONNECTION" }])
    }
    throw new Error(`unexpected fetch: ${path}`)
  }) as typeof fetch
  try {
    registry.timeline.putTurn(bot.id, "thread-oauth", { id: "turn-oauth", status: "inProgress", items: [] } as unknown as Turn)
    const pending = app.inject({
      method: "POST",
      url: "/api/bot-tools",
      headers: config.http_headers,
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "add_enterprise_resource", arguments: { botId: bot.id, resourceId: "notion", capabilityId: "notion.search" } } },
    })
    const request = await delivered
    clearTimeout(deliveryTimeout)
    connected = true
    await interactions.complete({
      principal,
      runtimeSessionId: runtime.id,
      requestToken: request.requestToken,
      botId: request.botId,
      threadId: request.threadId,
      turnId: request.turnId,
      resourceId: request.resourceId,
      connectionId: "notion-connection",
      status: "CONNECTED",
      accessToken: "oauth-tool-token",
    })
    const response = await pending
    const value = JSON.parse(response.json().result.content[0].text)
    expect(value).toMatchObject({
      addState: "CONNECTED",
      pendingApply: true,
      applyState: "PENDING_NEW_TURN",
      continuationState: "AUTOMATIC_CONTINUATION_QUEUED",
      binding: { state: "INSTALLED", resourceId: "notion", capabilityId: "notion.search" },
    })
    expect(requests).toEqual([])
    expect(runtime.managedMcpMountsByBot).toBeUndefined()
    expect(registry.connectionContinuations.pending()).toEqual([expect.objectContaining({
      requestToken: request.requestToken,
      botId: bot.id,
      sourceThreadId: "thread-oauth",
      sourceTurnId: "turn-oauth",
      resourceId: "notion",
      capabilityId: "notion.search",
      state: "queued",
    })])
    expect(reports).toEqual([])
  } finally {
    clearTimeout(deliveryTimeout)
    unsubscribe()
    globalThis.fetch = originalFetch
    if (originalPlatformOrigin === undefined) delete process.env.GENIO_ONE_PLATFORM_ORIGIN
    else process.env.GENIO_ONE_PLATFORM_ORIGIN = originalPlatformOrigin
    if (originalMcpUrl === undefined) delete process.env.GENIO_ONE_MCP_URL
    else process.env.GENIO_ONE_MCP_URL = originalMcpUrl
    if (originalRelayOrigin === undefined) delete process.env.GENIO_ONE_MCP_RELAY_ORIGIN
    else process.env.GENIO_ONE_MCP_RELAY_ORIGIN = originalRelayOrigin
    await app.close()
    await broker.stop(runtime.id)
    registry.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
