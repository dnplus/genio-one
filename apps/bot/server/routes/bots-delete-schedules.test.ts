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
import { BotDeletionReconciler } from "../bot-deletion-reconciler"
import type { ManagedDesktop } from "../runtime"

function desktop(): ManagedDesktop {
  return {
    details: { kind: "e2b-self-hosted", tier: "headless", cwd: "/home/user", desktopUrl: null, sandboxId: "test", environmentId: "test", execServerUrl: "ws://test", execReady: true },
    async close() {},
  }
}

test("DELETE /api/bots/:botId atomically removes its active schedules", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-delete-schedules-"))
  const registry = new BotRegistry(join(directory, "registry.sqlite"), join(directory, "artifacts"))
  const schedules = new BotSchedules(registry.db)
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const bot = registry.create(principal, { name: "待刪除 Bot" })
  schedules.create(principal, bot.id, { clientRequestId: "delete-schedule", prompt: "不應執行", schedule: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() } })
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input)
    if (url.includes("/v1/identity/session")) return Response.json(principal)
    calls.push(url)
    expect(init?.method).toBe("DELETE")
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer owner-token")
    expect(registry.getOwned(bot.id, principal)).toBeNull()
    expect(schedules.listActive()).toHaveLength(1)
    return Response.json({ bot_id: bot.id, cancelled_count: 1 })
  }) as unknown as typeof fetch
  const broker = new RuntimeBroker({ provision: async () => { throw new Error("UNEXPECTED_PROVISION") } })
  const policy: RuntimePolicyResolver = { read: async () => { throw new Error("UNEXPECTED_POLICY") }, resolve: async () => { throw new Error("UNEXPECTED_POLICY") }, authorize: async () => { throw new Error("UNEXPECTED_POLICY") }, report: async () => {} }
  const app = await createBotApp({ botRegistry: registry, botSchedules: schedules, botToolSessions: new BotToolSessions(), runtimeBroker: broker, capabilityGate: createCapabilityGate({ mode: "fixture", personalBotAllowlist: ["tenant:owner"] }), runtimePolicy: policy })
  try {
    const response = await app.inject({ method: "DELETE", url: `/api/bots/${bot.id}`, headers: { authorization: "Bearer owner-token" } })
    expect(response.statusCode).toBe(200)
    expect(registry.getOwned(bot.id, principal)).toBeNull()
    expect(schedules.list(principal, bot.id)).toEqual([])
    expect(schedules.listActive()).toEqual([])
    expect(calls).toEqual([`http://127.0.0.1:58082/v1/tenants/${principal.tenant_id}/distillation-markers/bots/${bot.id}`])
  } finally {
    await app.close()
    registry.close()
    globalThis.fetch = originalFetch
    rmSync(directory, { recursive: true, force: true })
  }
})

test("DELETE /api/bots/:botId preserves local data when Platform cancellation is unavailable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-delete-cancel-outage-"))
  const registry = new BotRegistry(join(directory, "registry.sqlite"), join(directory, "artifacts"))
  const schedules = new BotSchedules(registry.db)
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const bot = registry.create(principal, { name: "保留 Bot" })
  schedules.create(principal, bot.id, { clientRequestId: "keep-schedule", prompt: "仍要執行", schedule: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() } })
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    if (String(input).includes("/v1/identity/session")) return Response.json(principal)
    throw new TypeError("Platform unavailable")
  }) as unknown as typeof fetch
  const broker = new RuntimeBroker({ provision: async () => { throw new Error("UNEXPECTED_PROVISION") } })
  const policy: RuntimePolicyResolver = { read: async () => { throw new Error("UNEXPECTED_POLICY") }, resolve: async () => { throw new Error("UNEXPECTED_POLICY") }, authorize: async () => { throw new Error("UNEXPECTED_POLICY") }, report: async () => {} }
  const app = await createBotApp({ botRegistry: registry, botSchedules: schedules, botToolSessions: new BotToolSessions(), runtimeBroker: broker, capabilityGate: createCapabilityGate({ mode: "fixture", personalBotAllowlist: ["tenant:owner"] }), runtimePolicy: policy })
  try {
    const response = await app.inject({ method: "DELETE", url: `/api/bots/${bot.id}`, headers: { authorization: "Bearer owner-token" } })
    expect(response.statusCode).toBe(503)
    expect((response.json() as { error: string }).error).toBe("DISTILLATION_CANCELLATION_UNAVAILABLE")
    expect(registry.getOwned(bot.id, principal)).toBeNull()
    expect(registry.pendingDeletions()).toHaveLength(1)
    expect(schedules.listActive()).toHaveLength(1)
  } finally {
    await app.close()
    registry.close()
    globalThis.fetch = originalFetch
    rmSync(directory, { recursive: true, force: true })
  }
})

test("DELETE /api/bots/:botId preserves Platform authorization failures and local data", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-delete-cancel-auth-"))
  const registry = new BotRegistry(join(directory, "registry.sqlite"), join(directory, "artifacts"))
  const schedules = new BotSchedules(registry.db)
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const bot = registry.create(principal, { name: "授權失敗 Bot" })
  schedules.create(principal, bot.id, { clientRequestId: "auth-schedule", prompt: "保留", schedule: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() } })
  const statuses = [401, 403]
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    if (String(input).includes("/v1/identity/session")) return Response.json(principal)
    return new Response(null, { status: statuses.shift() })
  }) as unknown as typeof fetch
  const broker = new RuntimeBroker({ provision: async () => { throw new Error("UNEXPECTED_PROVISION") } })
  const policy: RuntimePolicyResolver = { read: async () => { throw new Error("UNEXPECTED_POLICY") }, resolve: async () => { throw new Error("UNEXPECTED_POLICY") }, authorize: async () => { throw new Error("UNEXPECTED_POLICY") }, report: async () => {} }
  const app = await createBotApp({ botRegistry: registry, botSchedules: schedules, botToolSessions: new BotToolSessions(), runtimeBroker: broker, capabilityGate: createCapabilityGate({ mode: "fixture", personalBotAllowlist: ["tenant:owner"] }), runtimePolicy: policy })
  try {
    const unauthorized = await app.inject({ method: "DELETE", url: `/api/bots/${bot.id}`, headers: { authorization: "Bearer owner-token" } })
    expect(unauthorized.statusCode).toBe(401)
    expect((unauthorized.json() as { error: string }).error).toBe("DISTILLATION_CANCELLATION_UNAUTHORIZED")
    const forbidden = await app.inject({ method: "DELETE", url: `/api/bots/${bot.id}`, headers: { authorization: "Bearer owner-token" } })
    expect(forbidden.statusCode).toBe(403)
    expect((forbidden.json() as { error: string }).error).toBe("DISTILLATION_CANCELLATION_FORBIDDEN")
    expect(registry.getOwned(bot.id, principal)).not.toBeNull()
    expect(schedules.listActive()).toHaveLength(1)
    expect(registry.pendingDeletions()).toEqual([])
  } finally {
    await app.close()
    registry.close()
    globalThis.fetch = originalFetch
    rmSync(directory, { recursive: true, force: true })
  }
})

test("DELETE /api/bots/:botId verifies ownership before requesting Platform cancellation", async () => {
  const registry = new BotRegistry(":memory:")
  const schedules = new BotSchedules(registry.db)
  const owner = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const other = { ...owner, subject_id: "other" }
  const bot = registry.create(owner, { name: "他人不可刪除 Bot" })
  schedules.create(owner, bot.id, { clientRequestId: "owner-only-schedule", prompt: "保留", schedule: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() } })
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(input).includes("/v1/identity/session")) {
      return Response.json(new Headers(init?.headers).get("authorization") === "Bearer owner-token" ? owner : other)
    }
    throw new Error("PLATFORM_CANCELLATION_MUST_NOT_BE_CALLED")
  }) as unknown as typeof fetch
  const broker = new RuntimeBroker({ provision: async () => { throw new Error("UNEXPECTED_PROVISION") } })
  const policy: RuntimePolicyResolver = { read: async () => { throw new Error("UNEXPECTED_POLICY") }, resolve: async () => { throw new Error("UNEXPECTED_POLICY") }, authorize: async () => { throw new Error("UNEXPECTED_POLICY") }, report: async () => {} }
  const app = await createBotApp({ botRegistry: registry, botSchedules: schedules, botToolSessions: new BotToolSessions(), runtimeBroker: broker, capabilityGate: createCapabilityGate({ mode: "fixture", personalBotAllowlist: ["tenant:owner"] }), runtimePolicy: policy })
  try {
    const response = await app.inject({ method: "DELETE", url: `/api/bots/${bot.id}`, headers: { authorization: "Bearer other-token" } })
    expect(response.statusCode).toBe(404)
    expect(registry.getOwned(bot.id, owner)).not.toBeNull()
    expect(schedules.listActive()).toHaveLength(1)
  } finally {
    await app.close()
    registry.close()
    globalThis.fetch = originalFetch
  }
})

test("DELETE /api/bots/:botId retains local data for malformed Platform success responses", async () => {
  const registry = new BotRegistry(":memory:")
  const schedules = new BotSchedules(registry.db)
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const bot = registry.create(principal, { name: "驗證回應 Bot" })
  schedules.create(principal, bot.id, { clientRequestId: "response-schedule", prompt: "保留", schedule: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() } })
  const invalidBodies = [{ bot_id: "another-bot", cancelled_count: 0 }, { bot_id: bot.id, cancelled_count: -1 }]
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    if (String(input).includes("/v1/identity/session")) return Response.json(principal)
    return Response.json(invalidBodies.shift())
  }) as unknown as typeof fetch
  const broker = new RuntimeBroker({ provision: async () => { throw new Error("UNEXPECTED_PROVISION") } })
  const policy: RuntimePolicyResolver = { read: async () => { throw new Error("UNEXPECTED_POLICY") }, resolve: async () => { throw new Error("UNEXPECTED_POLICY") }, authorize: async () => { throw new Error("UNEXPECTED_POLICY") }, report: async () => {} }
  const app = await createBotApp({ botRegistry: registry, botSchedules: schedules, botToolSessions: new BotToolSessions(), runtimeBroker: broker, capabilityGate: createCapabilityGate({ mode: "fixture", personalBotAllowlist: ["tenant:owner"] }), runtimePolicy: policy })
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await app.inject({ method: "DELETE", url: `/api/bots/${bot.id}`, headers: { authorization: "Bearer owner-token" } })
      expect(response.statusCode).toBe(503)
      expect(registry.getOwned(bot.id, principal)).toBeNull()
      expect(schedules.listActive()).toHaveLength(1)
    }
  } finally {
    await app.close()
    registry.close()
    globalThis.fetch = originalFetch
  }
})

test("DELETE /api/bots/:botId retries an indeterminate cancellation without changing unrelated Bot data", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-delete-cancel-retry-"))
  const registry = new BotRegistry(join(directory, "registry.sqlite"), join(directory, "artifacts"))
  const schedules = new BotSchedules(registry.db)
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const deleted = registry.create(principal, { name: "待重試 Bot" })
  const retained = registry.create(principal, { name: "保留的其他 Bot" })
  schedules.create(principal, deleted.id, { clientRequestId: "retry-delete", prompt: "取消", schedule: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() } })
  schedules.create(principal, retained.id, { clientRequestId: "retain-schedule", prompt: "保留", schedule: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() } })
  let cancellations = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    if (String(input).includes("/v1/identity/session")) return Response.json(principal)
    cancellations += 1
    if (cancellations === 1) throw new TypeError("response lost after cancellation")
    return Response.json({ bot_id: deleted.id, cancelled_count: 0 })
  }) as unknown as typeof fetch
  const broker = new RuntimeBroker({ provision: async () => { throw new Error("UNEXPECTED_PROVISION") } })
  const policy: RuntimePolicyResolver = { read: async () => { throw new Error("UNEXPECTED_POLICY") }, resolve: async () => { throw new Error("UNEXPECTED_POLICY") }, authorize: async () => { throw new Error("UNEXPECTED_POLICY") }, report: async () => {} }
  const app = await createBotApp({ botRegistry: registry, botSchedules: schedules, botToolSessions: new BotToolSessions(), runtimeBroker: broker, capabilityGate: createCapabilityGate({ mode: "fixture", personalBotAllowlist: ["tenant:owner"] }), runtimePolicy: policy })
  try {
    const first = await app.inject({ method: "DELETE", url: `/api/bots/${deleted.id}`, headers: { authorization: "Bearer owner-token" } })
    expect(first.statusCode).toBe(503)
    expect(registry.getOwned(deleted.id, principal)).toBeNull()
    expect(schedules.list(principal, deleted.id)).toHaveLength(1)

    const retried = await app.inject({ method: "DELETE", url: `/api/bots/${deleted.id}`, headers: { authorization: "Bearer owner-token" } })
    expect(retried.statusCode).toBe(200)
    expect(cancellations).toBe(2)
    expect(registry.getOwned(deleted.id, principal)).toBeNull()
    expect(registry.getOwned(retained.id, principal)).not.toBeNull()
    expect(schedules.list(principal, retained.id)).toHaveLength(1)
  } finally {
    await app.close()
    registry.close()
    globalThis.fetch = originalFetch
    rmSync(directory, { recursive: true, force: true })
  }
})

test("DELETE keeps a pending Bot schedule fenced from due and runnable claims", async () => {
  const registry = new BotRegistry(":memory:")
  const schedules = new BotSchedules(registry.db)
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const bot = registry.create(principal, { name: "已封鎖排程 Bot" })
  const schedule = schedules.create(principal, bot.id, { clientRequestId: "fenced-schedule", prompt: "不得執行", schedule: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() } }).schedule!
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => String(input).includes("/v1/identity/session") ? Response.json(principal) : Promise.reject(new TypeError("outage"))) as unknown as typeof fetch
  const app = await createBotApp({ botRegistry: registry, botSchedules: schedules, runtimeBroker: new RuntimeBroker({ provision: async () => { throw new Error("UNUSED") } }) })
  try {
    const response = await app.inject({ method: "DELETE", url: `/api/bots/${bot.id}`, headers: { authorization: "Bearer owner-token" } })
    expect(response.statusCode).toBe(503)
    registry.db.query("update bot_schedules set next_run_at = ? where id = ?").run(Date.now() - 1, schedule.id)
    expect(schedules.claimDue()).toEqual([])
    expect(schedules.claimRunnable()).toEqual([])
  } finally {
    await app.close()
    registry.close()
    globalThis.fetch = originalFetch
  }
})

test("reopened pending deletion completes after a fresh initialized owner session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-delete-reconcile-restart-"))
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  let registry = new BotRegistry(join(directory, "registry.sqlite"), join(directory, "artifacts"))
  let schedules = new BotSchedules(registry.db)
  const bot = registry.create(principal, { name: "重啟後刪除 Bot" })
  schedules.create(principal, bot.id, { clientRequestId: "restart-schedule", prompt: "取消", schedule: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() } })
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => String(input).includes("/v1/identity/session") ? Response.json(principal) : Promise.reject(new TypeError("lost response"))) as unknown as typeof fetch
  const firstApp = await createBotApp({ botRegistry: registry, botSchedules: schedules, runtimeBroker: new RuntimeBroker({ provision: async () => { throw new Error("UNUSED") } }) })
  try {
    expect((await firstApp.inject({ method: "DELETE", url: `/api/bots/${bot.id}`, headers: { authorization: "Bearer owner-token" } })).statusCode).toBe(503)
  } finally {
    await firstApp.close()
    registry.close()
  }
  registry = new BotRegistry(join(directory, "registry.sqlite"), join(directory, "artifacts"))
  schedules = new BotSchedules(registry.db)
  const broker = new RuntimeBroker({ provision: async () => desktop() })
  const reopenedApp = await createBotApp({ botRegistry: registry, botSchedules: schedules, runtimeBroker: broker })
  const session = await broker.start(principal, { onMessage() {}, onExit() {} }, undefined, "fresh-owner-token")
  session.initialized = true
  globalThis.fetch = (async () => Response.json({ bot_id: bot.id, cancelled_count: 0 })) as unknown as typeof fetch
  try {
    await Bun.sleep(2_050)
    expect(registry.pendingDeletions()).toEqual([])
    expect(registry.getOwned(bot.id, principal)).toBeNull()
    expect(schedules.list(principal, bot.id)).toEqual([])
  } finally {
    await reopenedApp.close()
    registry.close()
    globalThis.fetch = originalFetch
    rmSync(directory, { recursive: true, force: true })
  }
})

test("concurrent DELETE requests share one cancellation attempt", async () => {
  const registry = new BotRegistry(":memory:")
  const schedules = new BotSchedules(registry.db)
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const bot = registry.create(principal, { name: "併發刪除 Bot" })
  const originalFetch = globalThis.fetch
  let cancellations = 0
  let resolveCancellation: ((response: Response) => void) | null = null
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    if (String(input).includes("/v1/identity/session")) return Response.json(principal)
    cancellations += 1
    return await new Promise<Response>((resolve) => { resolveCancellation = resolve })
  }) as unknown as typeof fetch
  const app = await createBotApp({ botRegistry: registry, botSchedules: schedules, runtimeBroker: new RuntimeBroker({ provision: async () => { throw new Error("UNUSED") } }) })
  try {
    const first = app.inject({ method: "DELETE", url: `/api/bots/${bot.id}`, headers: { authorization: "Bearer owner-token" } })
    const second = app.inject({ method: "DELETE", url: `/api/bots/${bot.id}`, headers: { authorization: "Bearer owner-token" } })
    await Bun.sleep(0)
    expect(cancellations).toBe(1)
    resolveCancellation!(Response.json({ bot_id: bot.id, cancelled_count: 0 }))
    expect((await first).statusCode).toBe(200)
    expect((await second).statusCode).toBe(200)
    expect(registry.pendingDeletions()).toEqual([])
    expect(registry.getOwned(bot.id, principal)).toBeNull()
  } finally {
    await app.close()
    registry.close()
    globalThis.fetch = originalFetch
  }
})

test("concurrent owner tokens each reach Platform and a forbidden token cannot undo the successful delete", async () => {
  const registry = new BotRegistry(":memory:")
  const schedules = new BotSchedules(registry.db)
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const bot = registry.create(principal, { name: "雙 Token 成功刪除 Bot" })
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  let resolveHigh: ((response: Response) => void) | null = null
  let highStarted!: () => void
  const highStartedPromise = new Promise<void>((resolve) => { highStarted = resolve })
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(input).includes("/v1/identity/session")) return Response.json(principal)
    const authorization = new Headers(init?.headers).get("authorization") ?? ""
    calls.push(authorization)
    if (authorization === "Bearer high-token") {
      highStarted()
      return await new Promise<Response>((resolve) => { resolveHigh = resolve })
    }
    return new Response(null, { status: 403 })
  }) as unknown as typeof fetch
  const app = await createBotApp({ botRegistry: registry, botSchedules: schedules, runtimeBroker: new RuntimeBroker({ provision: async () => { throw new Error("UNUSED") } }) })
  try {
    const high = app.inject({ method: "DELETE", url: `/api/bots/${bot.id}`, headers: { authorization: "Bearer high-token" } })
    await highStartedPromise
    const low = await app.inject({ method: "DELETE", url: `/api/bots/${bot.id}`, headers: { authorization: "Bearer low-token" } })
    expect(low.statusCode).toBe(403)
    expect(calls).toEqual(["Bearer high-token", "Bearer low-token"])
    resolveHigh!(Response.json({ bot_id: bot.id, cancelled_count: 0 }))
    expect((await high).statusCode).toBe(200)
    expect(registry.pendingDeletions()).toEqual([])
    expect(registry.getOwned(bot.id, principal)).toBeNull()
  } finally {
    await app.close()
    registry.close()
    globalThis.fetch = originalFetch
  }
})

test("a late forbidden initial token cannot unarchive after another token finalizes", async () => {
  const registry = new BotRegistry(":memory:")
  const schedules = new BotSchedules(registry.db)
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const bot = registry.create(principal, { name: "雙 Token 回復競態 Bot" })
  const originalFetch = globalThis.fetch
  let resolveLow: ((response: Response) => void) | null = null
  let lowStarted!: () => void
  const lowStartedPromise = new Promise<void>((resolve) => { lowStarted = resolve })
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(input).includes("/v1/identity/session")) return Response.json(principal)
    const authorization = new Headers(init?.headers).get("authorization")
    if (authorization === "Bearer low-token") {
      lowStarted()
      return await new Promise<Response>((resolve) => { resolveLow = resolve })
    }
    return Response.json({ bot_id: bot.id, cancelled_count: 0 })
  }) as unknown as typeof fetch
  const app = await createBotApp({ botRegistry: registry, botSchedules: schedules, runtimeBroker: new RuntimeBroker({ provision: async () => { throw new Error("UNUSED") } }) })
  try {
    const low = app.inject({ method: "DELETE", url: `/api/bots/${bot.id}`, headers: { authorization: "Bearer low-token" } })
    await lowStartedPromise
    expect((await app.inject({ method: "DELETE", url: `/api/bots/${bot.id}`, headers: { authorization: "Bearer high-token" } })).statusCode).toBe(200)
    resolveLow!(new Response(null, { status: 403 }))
    expect((await low).statusCode).toBe(403)
    expect(registry.pendingDeletions()).toEqual([])
    expect(registry.getOwned(bot.id, principal)).toBeNull()
  } finally {
    await app.close()
    registry.close()
    globalThis.fetch = originalFetch
  }
})

test("two distinct forbidden tokens restore an unambiguous pending deletion", async () => {
  const registry = new BotRegistry(":memory:")
  const schedules = new BotSchedules(registry.db)
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const bot = registry.create(principal, { name: "雙 Token 拒絕回復 Bot" })
  schedules.create(principal, bot.id, { clientRequestId: "two-low-schedule", prompt: "保留", schedule: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() } })
  const originalFetch = globalThis.fetch
  let resolveFirst: ((response: Response) => void) | null = null
  let firstStarted!: () => void
  const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve })
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(input).includes("/v1/identity/session")) return Response.json(principal)
    if (new Headers(init?.headers).get("authorization") === "Bearer low-a") {
      firstStarted()
      return await new Promise<Response>((resolve) => { resolveFirst = resolve })
    }
    return new Response(null, { status: 403 })
  }) as unknown as typeof fetch
  const app = await createBotApp({ botRegistry: registry, botSchedules: schedules, runtimeBroker: new RuntimeBroker({ provision: async () => { throw new Error("UNUSED") } }) })
  try {
    const first = app.inject({ method: "DELETE", url: `/api/bots/${bot.id}`, headers: { authorization: "Bearer low-a" } })
    await firstStartedPromise
    expect((await app.inject({ method: "DELETE", url: `/api/bots/${bot.id}`, headers: { authorization: "Bearer low-b" } })).statusCode).toBe(403)
    resolveFirst!(new Response(null, { status: 403 }))
    expect((await first).statusCode).toBe(403)
    expect(registry.pendingDeletions()).toEqual([])
    expect(registry.getOwned(bot.id, principal)).not.toBeNull()
    expect(schedules.list(principal, bot.id)).toHaveLength(1)
  } finally {
    await app.close()
    registry.close()
    globalThis.fetch = originalFetch
  }
})

test("reconciliation tries a fresh owner session after another session is rejected", async () => {
  const registry = new BotRegistry(":memory:")
  const schedules = new BotSchedules(registry.db)
  const stale = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "stale-client", scopes: [] }
  const fresh = { ...stale, acting_client_id: "fresh-client" }
  const bot = registry.create(stale, { name: "多 Session 協調 Bot" })
  expect(registry.beginPendingDeletion(bot.id, stale)).toEqual({ created: true })
  const broker = new RuntimeBroker({ provision: async () => desktop() })
  const staleSession = await broker.start(stale, { onMessage() {}, onExit() {} }, undefined, "stale-token")
  staleSession.initialized = true
  const freshSession = await broker.start(fresh, { onMessage() {}, onExit() {} }, undefined, "fresh-token")
  freshSession.initialized = true
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const authorization = new Headers(init?.headers).get("authorization") ?? ""
    calls.push(authorization)
    return authorization === "Bearer stale-token" ? new Response(null, { status: 403 }) : Response.json({ bot_id: bot.id, cancelled_count: 0 })
  }) as unknown as typeof fetch
  try {
    await new BotDeletionReconciler(registry, schedules, broker).reconcile()
    expect(calls).toEqual(["Bearer stale-token", "Bearer fresh-token"])
    expect(registry.pendingDeletions()).toEqual([])
    expect(registry.getOwned(bot.id, stale)).toBeNull()
  } finally {
    await broker.close()
    registry.close()
    globalThis.fetch = originalFetch
  }
})

test("an authorization failure on a retry leaves an existing pending deletion fenced", async () => {
  const registry = new BotRegistry(":memory:")
  const schedules = new BotSchedules(registry.db)
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const bot = registry.create(principal, { name: "待重試授權失敗 Bot" })
  schedules.create(principal, bot.id, { clientRequestId: "retry-auth-schedule", prompt: "保留", schedule: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() } })
  const originalFetch = globalThis.fetch
  const statuses = [503, 401, 403]
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    if (String(input).includes("/v1/identity/session")) return Response.json(principal)
    return new Response(null, { status: statuses.shift() })
  }) as unknown as typeof fetch
  const app = await createBotApp({ botRegistry: registry, botSchedules: schedules, runtimeBroker: new RuntimeBroker({ provision: async () => { throw new Error("UNUSED") } }) })
  try {
    expect((await app.inject({ method: "DELETE", url: `/api/bots/${bot.id}`, headers: { authorization: "Bearer owner-token" } })).statusCode).toBe(503)
    for (const expected of [401, 403]) {
      const retry = await app.inject({ method: "DELETE", url: `/api/bots/${bot.id}`, headers: { authorization: "Bearer owner-token" } })
      expect(retry.statusCode).toBe(expected)
      expect(registry.pendingDeletions()).toHaveLength(1)
      expect(registry.getOwned(bot.id, principal)).toBeNull()
      expect(schedules.list(principal, bot.id)).toHaveLength(1)
    }
  } finally {
    await app.close()
    registry.close()
    globalThis.fetch = originalFetch
  }
})

test("a different owner session cannot reconcile a pending deletion", async () => {
  const registry = new BotRegistry(":memory:")
  const schedules = new BotSchedules(registry.db)
  const owner = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const other = { ...owner, subject_id: "other" }
  const bot = registry.create(owner, { name: "限 owner 協調 Bot" })
  expect(registry.beginPendingDeletion(bot.id, owner)).toEqual({ created: true })
  const broker = new RuntimeBroker({ provision: async () => desktop() })
  const session = await broker.start(other, { onMessage() {}, onExit() {} }, undefined, "other-token")
  session.initialized = true
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => { throw new Error("OTHER_OWNER_MUST_NOT_CANCEL") }) as unknown as typeof fetch
  try {
    await new BotDeletionReconciler(registry, schedules, broker).reconcile()
    expect(registry.pendingDeletions()).toHaveLength(1)
    expect(registry.getOwned(bot.id, owner)).toBeNull()
  } finally {
    await broker.close()
    registry.close()
    globalThis.fetch = originalFetch
  }
})

test("DELETE without a bearer token leaves Bot and schedule active", async () => {
  const registry = new BotRegistry(":memory:")
  const schedules = new BotSchedules(registry.db)
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const bot = registry.create(principal, { name: "缺少憑證 Bot" })
  schedules.create(principal, bot.id, { clientRequestId: "token-schedule", prompt: "保留", schedule: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() } })
  const app = await createBotApp({ botRegistry: registry, botSchedules: schedules, runtimeBroker: new RuntimeBroker({ provision: async () => { throw new Error("UNUSED") } }) })
  try {
    const response = await app.inject({ method: "DELETE", url: `/api/bots/${bot.id}` })
    expect(response.statusCode).toBe(401)
    expect(registry.getOwned(bot.id, principal)).not.toBeNull()
    expect(registry.pendingDeletions()).toEqual([])
    expect(schedules.list(principal, bot.id)).toHaveLength(1)
  } finally {
    await app.close()
    registry.close()
  }
})

test("DELETE leaves an archived Bot without a pending deletion unchanged", async () => {
  const registry = new BotRegistry(":memory:")
  const schedules = new BotSchedules(registry.db)
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const bot = registry.create(principal, { name: "既有封存 Bot" })
  schedules.create(principal, bot.id, { clientRequestId: "archived-schedule", prompt: "保留", schedule: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() } })
  registry.db.query("update bots set archived = 1 where id = ?").run(bot.id)
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    if (String(input).includes("/v1/identity/session")) return Response.json(principal)
    throw new Error("ARCHIVED_BOT_MUST_NOT_CANCEL")
  }) as unknown as typeof fetch
  const app = await createBotApp({ botRegistry: registry, botSchedules: schedules, runtimeBroker: new RuntimeBroker({ provision: async () => { throw new Error("UNUSED") } }) })
  try {
    const response = await app.inject({ method: "DELETE", url: `/api/bots/${bot.id}`, headers: { authorization: "Bearer owner-token" } })
    expect(response.statusCode).toBe(404)
    expect(registry.pendingDeletions()).toEqual([])
    expect(registry.db.query("select archived from bots where id = ?").get(bot.id)).toEqual({ archived: 1 })
    expect(schedules.list(principal, bot.id)).toHaveLength(1)
  } finally {
    await app.close()
    registry.close()
    globalThis.fetch = originalFetch
  }
})
