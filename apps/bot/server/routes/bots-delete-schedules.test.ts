import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBotApp } from "../app"
import { BotRegistry } from "../bot-registry"
import { BotSchedules } from "../bot-schedules"
import { BotToolSessions } from "../bot-tool-sessions"
import { createCapabilityGate } from "../capability-gate"
import { RuntimeBroker } from "../runtime-broker"
import type { RuntimePolicyResolver } from "../runtime-policy-contract"

test("DELETE /api/bots/:botId atomically removes its active schedules", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-delete-schedules-"))
  const registry = new BotRegistry(join(directory, "registry.sqlite"), join(directory, "artifacts"))
  const schedules = new BotSchedules(registry.db)
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const bot = registry.create(principal, { name: "待刪除 Bot" })
  schedules.create(principal, bot.id, { clientRequestId: "delete-schedule", prompt: "不應執行", schedule: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() } })
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => Response.json(principal)) as unknown as typeof fetch
  const broker = new RuntimeBroker({ provision: async () => { throw new Error("UNEXPECTED_PROVISION") } })
  const policy: RuntimePolicyResolver = { read: async () => { throw new Error("UNEXPECTED_POLICY") }, resolve: async () => { throw new Error("UNEXPECTED_POLICY") }, authorize: async () => { throw new Error("UNEXPECTED_POLICY") }, report: async () => {} }
  const app = await createBotApp({ botRegistry: registry, botSchedules: schedules, botToolSessions: new BotToolSessions(), runtimeBroker: broker, capabilityGate: createCapabilityGate({ mode: "fixture", personalBotAllowlist: ["tenant:owner"] }), runtimePolicy: policy })
  try {
    const response = await app.inject({ method: "DELETE", url: `/api/bots/${bot.id}`, headers: { authorization: "Bearer owner-token" } })
    expect(response.statusCode).toBe(200)
    expect(registry.getOwned(bot.id, principal)).toBeNull()
    expect(schedules.list(principal, bot.id)).toEqual([])
    expect(schedules.listActive()).toEqual([])
  } finally {
    await app.close()
    registry.close()
    globalThis.fetch = originalFetch
    rmSync(directory, { recursive: true, force: true })
  }
})
