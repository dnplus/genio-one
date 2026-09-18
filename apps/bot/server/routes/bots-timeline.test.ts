import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotRegistry } from "../bot-registry"
import { createBotApp } from "../app"

test("timeline API restores durable messages without a browser cache and enforces ownership", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-timeline-http-"))
  const path = join(dir, "registry.sqlite")
  const principal = { tenant_id: "timeline-tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  let registry = new BotRegistry(path, join(dir, "artifacts"))
  const bot = registry.create(principal, { name: "A", description: "Timeline" })
  registry.rememberThread(bot.id, "native-thread")
  registry.recordRuntimeEvent(principal, JSON.stringify({ method: "item/completed", params: { threadId: "native-thread", turnId: "native-turn", item: { type: "agentMessage", id: "native-item", text: "持久聊天" } } }))
  const artifactText = "<!doctype html><main>CE architecture</main>"
  const artifact = { name: "ce-architecture.html", mimeType: "text/html", text: artifactText, sha256: createHash("sha256").update(artifactText, "utf8").digest("hex") }
  registry.recordRuntimeEvent(principal, JSON.stringify({ method: "item/completed", params: { threadId: "native-thread", turnId: "native-turn", item: {
    type: "mcpToolCall", id: "archify-item", server: "archify", tool: "render", status: "completed", arguments: {}, appContext: null, pluginId: null, readOnlyHint: true,
    result: { content: [{ type: "text", text: "架構圖已產生" }], structuredContent: { diagram: "ce" }, _meta: { "genio/artifacts": [artifact] } }, error: null, durationMs: 1,
  } } }))
  registry.close()
  registry = new BotRegistry(path, join(dir, "artifacts"))
  const originalFetch = globalThis.fetch
  let activePrincipal = principal
  globalThis.fetch = (async (_input: RequestInfo | URL) => Response.json(activePrincipal)) as typeof fetch

  const app = await createBotApp({ botRegistry: registry })
  try {
    const headers = { authorization: "Bearer contract-token" }
    const result = await app.inject({ method: "GET", url: `/api/bots/${bot.id}/timeline`, headers })
    expect(result.statusCode).toBe(200)
    const unchanged = await app.inject({ method: "GET", url: `/api/bots/${bot.id}/timeline`, headers: { ...headers, "if-none-match": String(result.headers.etag) } })
    expect(unchanged.statusCode).toBe(304)
    expect(unchanged.body).toBe("")
    const timeline = result.json()
    expect(timeline.find((message: { id: string }) => message.id === "native-thread:native-item")).toMatchObject({ role: "assistant", text: "持久聊天" })
    expect(timeline.find((message: { id: string }) => message.id === "native-thread:archify-item")).toMatchObject({ runtimeItem: { result: { _meta: { "genio/artifacts": [artifact] } } } })
    const entry = { sourceKey: `genio.bot.messages.${bot.id}.old`, position: 0, message: { role: "user", text: "舊訊息" } }
    const imported = await app.inject({ method: "POST", url: `/api/bots/${bot.id}/timeline/legacy-import`, headers, payload: [entry] })
    expect(imported.statusCode).toBe(200)
    const repeated = await app.inject({ method: "POST", url: `/api/bots/${bot.id}/timeline/legacy-import`, headers, payload: [entry] })
    expect(repeated.statusCode).toBe(200)
    const withLegacy = await app.inject({ method: "GET", url: `/api/bots/${bot.id}/timeline`, headers })
    expect(withLegacy.json()).toHaveLength(3)
    expect(withLegacy.json().find((message: { kind?: string }) => message.kind === "legacy")).toMatchObject({ role: "system", kind: "legacy", text: "舊訊息" })
    const savedMemory = await app.inject({ method: "POST", url: `/api/bots/${bot.id}/memory`, headers, payload: { key: "介面驗證", content: "記憶內容", kind: "fact" } })
    expect(savedMemory.statusCode).toBe(200)
    expect(savedMemory.json().origin).toBe("user")
    const staleMemory = await app.inject({ method: "POST", url: `/api/bots/${bot.id}/memory`, headers, payload: { key: "介面驗證", content: "過期修改", kind: "fact", expectedRevision: 0 } })
    expect(staleMemory.statusCode).toBe(409)
    activePrincipal = { ...principal, subject_id: "different-owner" }
    const rejected = await app.inject({ method: "GET", url: `/api/bots/${bot.id}/timeline`, headers: { authorization: "Bearer other-contract-token" } })
    expect(rejected.statusCode).toBe(404)
    const rejectedImport = await app.inject({ method: "POST", url: `/api/bots/${bot.id}/timeline/legacy-import`, headers: { authorization: "Bearer other-contract-token" }, payload: [entry] })
    expect(rejectedImport.statusCode).toBe(404)
    const deniedMemory = await app.inject({ method: "GET", url: `/api/bots/${bot.id}/memory`, headers: { authorization: "Bearer other-contract-token" } })
    expect(deniedMemory.statusCode).toBe(404)
  } finally {
    globalThis.fetch = originalFetch
    await app.close()
    registry.close()

    rmSync(dir, { recursive: true, force: true })
  }
})
