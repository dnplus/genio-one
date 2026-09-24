import { expect, test } from "bun:test"
import Fastify from "fastify"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotRegistry } from "../bot-registry"
import { BotWorkspaceStore } from "../bot-workspace-store"
import { RuntimeBroker } from "../runtime-broker"
import { workspaceRoutes } from "./workspaces"

test("Bot deletion preserves an owner-only checkpoint export", async () => {
  const root = mkdtempSync(join(tmpdir(), "genio-hands-export-"))
  const originalFetch = globalThis.fetch
  const owner = { tenant_id: "tenant-a", subject_id: "owner-a", acting_client_id: "client-a", scopes: [] }
  const stranger = { ...owner, subject_id: "owner-b" }
  const registry = new BotRegistry(":memory:", join(root, "artifacts"))
  const workspaces = new BotWorkspaceStore(registry.db, (botId, principal) => registry.getOwned(botId, principal), join(root, "workspaces"))
  const broker = new RuntimeBroker({ async provision() { throw new Error("not used") } }, 600_000, workspaces)
  const app = Fastify()
  globalThis.fetch = (async (_input, init) => Response.json(new Headers(init?.headers).get("authorization") === "Bearer owner" ? owner : stranger)) as typeof fetch
  try {
    await workspaceRoutes(app, { workspaces, runtimeBroker: broker, botRegistry: registry, handsPlacement: { providerForNew: async () => "e2b-self-hosted", run: async (_actor: unknown, _provider: unknown, task: () => unknown) => task() } } as any)
    const bot = registry.create(owner, { name: "Export", description: "Recoverable workspace" })
    const workspace = workspaces.ensureActive(owner, bot.id)
    workspaces.saveCheckpoint(workspace.workspaceId, 0, Buffer.from("checkpoint bytes"))
    registry.delete(bot.id, owner)

    const mine = await app.inject({ method: "GET", url: "/api/hands/recoverable-workspaces", headers: { authorization: "Bearer owner" } })
    expect(mine.statusCode).toBe(200)
    expect(mine.json()[0].workspaceId).toBe(workspace.workspaceId)
    const exported = await app.inject({ method: "GET", url: `/api/hands/recoverable-workspaces/${workspace.workspaceId}/export`, headers: { authorization: "Bearer owner" } })
    expect(exported.statusCode).toBe(200)
    expect(exported.body).toBe("checkpoint bytes")
    expect(exported.headers["content-disposition"]).toContain(".tar.gz")

    const denied = await app.inject({ method: "GET", url: `/api/hands/recoverable-workspaces/${workspace.workspaceId}/export`, headers: { authorization: "Bearer stranger" } })
    expect(denied.statusCode).toBe(404)
  } finally {
    globalThis.fetch = originalFetch
    await app.close()
    await broker.close()
    registry.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("workspace switch is blocked while another acting client holds its Bot lease", async () => {
  const root = mkdtempSync(join(tmpdir(), "genio-hands-busy-"))
  const originalFetch = globalThis.fetch
  const owner = { tenant_id: "tenant-a", subject_id: "owner-a", acting_client_id: "client-a", scopes: [] }
  const otherClient = { ...owner, acting_client_id: "client-b" }
  const registry = new BotRegistry(":memory:", join(root, "artifacts"))
  const workspaces = new BotWorkspaceStore(registry.db, (botId, principal) => registry.getOwned(botId, principal), join(root, "workspaces"))
  const broker = new RuntimeBroker({
    async provision(request) {
      return {
        details: {
          kind: "e2b-self-hosted" as const,
          tier: request.tier,
          cwd: "/home/user",
          desktopUrl: null,
          sandboxId: "sandbox-a",
          environmentId: "environment-a",
          execServerUrl: "ws://executor.test",
          execReady: true,
          botId: request.botId,
          workspaceId: request.workspace?.workspaceId,
        },
        async close() {},
      }
    },
  }, 600_000, workspaces)
  const app = Fastify()
  globalThis.fetch = (async (_input, init) => Response.json(new Headers(init?.headers).get("authorization") === "Bearer other" ? otherClient : owner)) as typeof fetch
  try {
    await workspaceRoutes(app, { workspaces, runtimeBroker: broker, botRegistry: registry, handsPlacement: { providerForNew: async () => "e2b-self-hosted", run: async (_actor: unknown, _provider: unknown, task: () => unknown) => task() } } as any)
    const bot = registry.create(owner, { name: "Busy", description: "Cross-client lease" })
    const session = await broker.start(otherClient, { onMessage() {}, onExit() {} })
    await broker.ensure(session.id, "headless", bot.id)

    const blocked = await app.inject({ method: "POST", url: `/api/bots/${bot.id}/workspaces`, headers: { authorization: "Bearer owner" }, payload: { provider: "cloudflare-hands" } })
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().error).toBe("WORKSPACE_BUSY")
    await broker.stop(session.id, "headless")
    const created = await app.inject({ method: "POST", url: `/api/bots/${bot.id}/workspaces`, headers: { authorization: "Bearer owner" }, payload: { provider: "cloudflare-hands" } })
    expect(created.statusCode).toBe(201)
    expect(created.json().provider).toBe("cloudflare-hands")
  } finally {
    globalThis.fetch = originalFetch
    await app.close()
    await broker.close()
    registry.close()
    rmSync(root, { recursive: true, force: true })
  }
})
