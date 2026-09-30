import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createBotApp } from "../app"
import { BotRegistry } from "../bot-registry"
import { BotToolSessions } from "../bot-tool-sessions"
import { RuntimeBroker } from "../runtime-broker"

const principal = { tenant_id: "connection-recovery", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "bots-connection-recovery-"))
  const registry = new BotRegistry(":memory:", join(directory, "artifacts"))
  const bot = registry.create(principal, { name: "Weekly brief" })
  registry.connectionContinuations.enqueue({ requestToken: "request", botId: bot.id, tenantId: principal.tenant_id, ownerSubjectId: principal.subject_id, sourceThreadId: "thread", sourceTurnId: "turn", resourceId: "notion", resourceName: "Notion", capabilityId: "notion.search" })
  registry.connectionContinuations.markMcpReloaded("request", ["genio_mcp_notion"])
  expect(registry.connectionContinuations.claim("request")).toBe(true)
  registry.connectionContinuations.retryStarting("request")
  registry.connectionContinuations.cancel("request", "CONNECTION_SOURCE_SUPERSEDED")
  const broker = new RuntimeBroker({ provision: async () => { throw new Error("UNUSED") } })
  const runtime = await broker.start(principal, { onMessage() {}, onExit() {} }, () => ({ async send() {}, async close() {} }), "access-token")
  runtime.initialized = true
  runtime.selectedBotId = bot.id
  const sessions = new BotToolSessions()
  const tools = sessions.config(bot.id, principal, runtime.id)
  const app = await createBotApp({ botRegistry: registry, runtimeBroker: broker, botToolSessions: sessions })
  return { app, bot, broker, registry, runtime, tools, directory }
}

test("owner resets only the guarded Bot runtime and expires its tool token", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => Response.json(principal)) as unknown as typeof fetch
  const value = await fixture()
  try {
    const headers = { authorization: "Bearer owner-token" }
    const recovery = await value.app.inject({ method: "GET", url: `/api/bots/${value.bot.id}/connection-recovery`, headers })
    expect(recovery.json()).toMatchObject({ state: "guarded", requestToken: "request", runtimeSessionId: value.runtime.id, canReset: true })
    const reset = await value.app.inject({ method: "POST", url: `/api/bots/${value.bot.id}/connection-recovery/reset`, headers, payload: { requestToken: "request", runtimeSessionId: value.runtime.id } })
    expect(reset.statusCode).toBe(200)
    expect(reset.json() as unknown).toEqual({ state: "ready", reset: true })
    expect(value.broker.get(value.runtime.id)).toBeNull()
    expect(value.registry.connectionContinuations.get("request")).toMatchObject({ state: "failed", error: "CONNECTION_CONTINUATION_USER_SESSION_RESET" })
    const oldTool = await value.app.inject({ method: "POST", url: "/api/bot-tools", headers: value.tools.http_headers, payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } })
    expect(oldTool.statusCode).toBe(401)
  } finally {
    globalThis.fetch = originalFetch
    await value.app.close()
    value.registry.close()
    rmSync(value.directory, { recursive: true, force: true })
  }
})

test("does not reset a guarded Bot while another Bot owns the runtime", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => Response.json(principal)) as unknown as typeof fetch
  const value = await fixture()
  const other = value.registry.create(principal, { name: "Other" })
  const release = value.broker.claimBotTurn(other.id, value.runtime.id)!
  try {
    const response = await value.app.inject({ method: "POST", url: `/api/bots/${value.bot.id}/connection-recovery/reset`, headers: { authorization: "Bearer owner-token" }, payload: { requestToken: "request", runtimeSessionId: value.runtime.id } })
    expect(response.statusCode).toBe(409)
    expect(response.json() as unknown).toEqual({ error: "CONNECTION_RECOVERY_RUNTIME_CHANGED" })
    expect(value.broker.get(value.runtime.id)).toBeDefined()
    expect(value.registry.connectionContinuations.get("request")).toMatchObject({ state: "guarded" })
  } finally {
    release()
    globalThis.fetch = originalFetch
    await value.app.close()
    value.registry.close()
    rmSync(value.directory, { recursive: true, force: true })
  }
})

test("does not expose or reset a same-owner runtime from another acting client", async () => {
  const originalFetch = globalThis.fetch
  let activePrincipal = principal
  globalThis.fetch = (async () => Response.json(activePrincipal)) as unknown as typeof fetch
  const value = await fixture()
  try {
    activePrincipal = { ...principal, acting_client_id: "other-client" }
    const headers = { authorization: "Bearer other-client-token" }
    const recovery = await value.app.inject({ method: "GET", url: `/api/bots/${value.bot.id}/connection-recovery`, headers })
    expect(recovery.json()).toMatchObject({ state: "guarded", runtimeSessionId: null, canReset: false })
    const reset = await value.app.inject({ method: "POST", url: `/api/bots/${value.bot.id}/connection-recovery/reset`, headers, payload: { requestToken: "request", runtimeSessionId: value.runtime.id } })
    expect(reset.statusCode).toBe(409)
    expect(reset.json() as unknown).toEqual({ error: "CONNECTION_RECOVERY_RUNTIME_CHANGED" })
    expect(value.broker.get(value.runtime.id)).toBeDefined()
    expect(value.registry.connectionContinuations.get("request")).toMatchObject({ state: "guarded" })
  } finally {
    globalThis.fetch = originalFetch
    await value.app.close()
    value.registry.close()
    rmSync(value.directory, { recursive: true, force: true })
  }
})
