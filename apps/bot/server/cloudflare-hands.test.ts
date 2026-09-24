import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotRegistry } from "./bot-registry"
import { BotWorkspaceStore } from "./bot-workspace-store"
import { CloudflareHandsRuntime } from "./cloudflare-hands"

test("Cloudflare Hands binds workspace identity to every request and releases compute without deleting workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "genio-cf-client-"))
  const originalFetch = globalThis.fetch
  const originalOrigin = process.env.GENIO_CF_HANDS_ORIGIN
  const originalToken = process.env.GENIO_CF_HANDS_TOKEN
  process.env.GENIO_CF_HANDS_ORIGIN = "https://hands.example.test"
  process.env.GENIO_CF_HANDS_TOKEN = "server-secret"
  const calls: Array<{ url: string; method: string; headers: Headers }> = []
  const registry = new BotRegistry(":memory:", join(root, "artifacts"))
  const workspaces = new BotWorkspaceStore(registry.db, (botId, owner) => registry.getOwned(botId, owner), join(root, "workspaces"))
  const principal = { tenant_id: "tenant-a", subject_id: "owner-a", acting_client_id: "client-a", scopes: [] }
  const bot = registry.create(principal, { name: "Cloud", description: "Hands client" })
  const workspace = workspaces.create(principal, bot.id, "cloudflare-hands")
  const base = `/v1/workspaces/${workspace.workspaceId}`
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    const method = init?.method || "GET"
    calls.push({ url, method, headers: new Headers(init?.headers) })
    if (method === "PUT" && new URL(url).pathname === base) return Response.json({ workspaceId: workspace.workspaceId, revision: 0 })
    if (method === "POST" && new URL(url).pathname === `${base}/leases`) return Response.json({ workspaceId: workspace.workspaceId, leaseId: "lease-a", runtimeSessionId: "runtime-a", tier: "headless", revision: 0, cwd: "/workspace", environmentId: "hands-a", execServerPath: `${base}/leases/lease-a/exec`, desktopPath: null })
    if (method === "GET" && new URL(url).pathname.endsWith("/files")) return new Response("saved bytes")
    if (method === "DELETE" && new URL(url).pathname === `${base}/leases/lease-a`) return Response.json({ workspaceId: workspace.workspaceId, leaseId: "lease-a", revision: 1 })
    throw new Error(`UNEXPECTED_HANDS_CALL:${method}:${url}`)
  }) as typeof fetch
  try {
    const lease = await CloudflareHandsRuntime.create({ runtimeSessionId: "runtime-a", tenantId: principal.tenant_id, subjectId: principal.subject_id, actingClientId: principal.acting_client_id, botId: bot.id, tier: "headless", workspace }, workspaces, workspace)
    expect(lease.details.kind).toBe("cloudflare-hands")
    expect(lease.details.cwd).toBe("/workspace")
    expect(Buffer.from(await lease.readFile("中文 檔案.txt")).toString()).toBe("saved bytes")
    expect(new URL(calls[2]!.url).searchParams.get("path")).toBe("中文 檔案.txt")
    await lease.close()
    expect(workspaces.active(principal, bot.id)?.revision).toBe(1)
    expect(calls.map((call) => call.method)).toEqual(["PUT", "POST", "GET", "DELETE"])
    for (const call of calls) {
      expect(call.headers.get("authorization")).toBe("Bearer server-secret")
      expect(call.headers.get("x-hands-tenant-id")).toBe(principal.tenant_id)
      expect(call.headers.get("x-hands-bot-id")).toBe(bot.id)
      expect(call.headers.get("x-hands-subject-id")).toBe(principal.subject_id)
      expect(call.headers.get("x-hands-client-id")).toBe(principal.acting_client_id)
      expect(call.headers.get("x-hands-actor-client-id")).toBe(principal.acting_client_id)
    }
  } finally {
    globalThis.fetch = originalFetch
    if (originalOrigin === undefined) delete process.env.GENIO_CF_HANDS_ORIGIN
    else process.env.GENIO_CF_HANDS_ORIGIN = originalOrigin
    if (originalToken === undefined) delete process.env.GENIO_CF_HANDS_TOKEN
    else process.env.GENIO_CF_HANDS_TOKEN = originalToken
    registry.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("JavaScript isolate is called at workspace scope with a stable request receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "genio-cf-isolate-client-"))
  const originalFetch = globalThis.fetch
  const originalOrigin = process.env.GENIO_CF_HANDS_ORIGIN
  const originalToken = process.env.GENIO_CF_HANDS_TOKEN
  process.env.GENIO_CF_HANDS_ORIGIN = "https://hands.example.test"
  process.env.GENIO_CF_HANDS_TOKEN = "server-secret"
  const paths: string[] = []
  const registry = new BotRegistry(":memory:", join(root, "artifacts"))
  const workspaces = new BotWorkspaceStore(registry.db, (botId, owner) => registry.getOwned(botId, owner), join(root, "workspaces"))
  const principal = { tenant_id: "tenant-a", subject_id: "owner-a", acting_client_id: "client-a", scopes: [] }
  const bot = registry.create(principal, { name: "Isolate", description: "Workspace scoped" })
  const workspace = workspaces.create(principal, bot.id, "cloudflare-hands")
  const requestId = "74e23293-5ec6-47de-a720-01015151daf0"
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname
    paths.push(path)
    if (init?.method === "PUT") return Response.json({ workspaceId: workspace.workspaceId, revision: 0 })
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body))
      expect(body.requestId).toBe(requestId)
      expect(body.runtimeSessionId).toBe("runtime-a")
      return Response.json({ requestId, stdout: "2", stderr: "", exitCode: 0, revision: 1 })
    }
    throw new Error("UNEXPECTED_HANDS_CALL")
  }) as typeof fetch
  try {
    const result = await CloudflareHandsRuntime.isolate(workspace, workspaces, { runtimeSessionId: "runtime-a", requestId, code: "console.log(1+1)", expectedRevision: 0 })
    expect(result.revision).toBe(1)
    expect(workspaces.active(principal, bot.id)?.revision).toBe(1)
    expect(paths).toEqual([`/v1/workspaces/${workspace.workspaceId}`, `/v1/workspaces/${workspace.workspaceId}/isolate`])
  } finally {
    globalThis.fetch = originalFetch
    if (originalOrigin === undefined) delete process.env.GENIO_CF_HANDS_ORIGIN
    else process.env.GENIO_CF_HANDS_ORIGIN = originalOrigin
    if (originalToken === undefined) delete process.env.GENIO_CF_HANDS_TOKEN
    else process.env.GENIO_CF_HANDS_TOKEN = originalToken
    registry.close()
    rmSync(root, { recursive: true, force: true })
  }
})
