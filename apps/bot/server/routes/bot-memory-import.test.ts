import { expect, test } from "bun:test"
import Fastify from "fastify"
import { registerHttpObservability } from "@genioone/telemetry/fastify-observability"
import { BotRegistry } from "../bot-registry"
import type { BotServerContext } from "../context"
import { botMemoryRoutes } from "./bot-memory"

type Principal = { tenant_id: string; subject_id: string; acting_client_id: string; scopes: string[] }
type ImportResult = {
  source: string
  imported: Array<{
    legacyMemory: { id: string; key: string; kind: string; content: string; revision: number }
    platformMemory: { id: string; revision: number; source: { referenceId: string | null } }
    source: { kind: string; botId: string; memoryId: string; revision: number; referenceId: string }
  }>
  failed: Array<{ legacyMemoryId: string; error: string }>
}

test("legacy Bot memory stays preview-only and imports selected active records through the owner's Platform MCP", async () => {
  const registry = new BotRegistry(":memory:")
  const originalOrigin = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://memory-bot-import-collector.test"
  const app = Fastify()
  registerHttpObservability(app, "bot-memory-import-test")
  app.post("/public-evidence", async (request) => request.body)
  const owner: Principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: ["genioone-invocation"] }
  const other: Principal = { ...owner, subject_id: "other" }
  const bot = registry.create(owner, { name: "Owner Bot" })
  const legacy = registry.memory.save(bot.id, { key: "回覆偏好", content: "使用臺灣繁體中文", kind: "preference" }, "user")
  const forgotten = registry.memory.save(bot.id, { key: "舊事實", content: "不要匯入", kind: "fact" }, "user")
  registry.memory.setForgotten(bot.id, forgotten.id, true, forgotten.revision)
  const working = registry.memory.save(bot.id, { key: "current-work", content: "工作摘要不遷移", kind: "working_context" }, "bot")
  await botMemoryRoutes(app, { botRegistry: registry } as BotServerContext)

  const originalFetch = globalThis.fetch
  const principals = new Map<string, Principal>([["owner-token", owner], ["other-token", other]])
  const platformMemories = new Map<string, Record<string, unknown>>()
  const mcpCalls: Array<{ token: string; name: string; args: Record<string, unknown> }> = []
  const observations: any[] = []
  let grant = true
  let sequence = 0
  let readBackMutation: ((value: Record<string, unknown>) => Record<string, unknown>) | null = null
  const mcpResult = (value: Record<string, unknown>) => Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value } })
  const mcpFailure = (code: string) => Response.json({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: code }] } })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin === "http://memory-bot-import-collector.test") {
      observations.push(JSON.parse(String(init?.body)))
      return new Response("{}")
    }
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const token = headers.get("authorization")?.replace(/^Bearer /, "") ?? ""
    const principal = principals.get(token)
    if (url.pathname === "/v1/identity/session") return principal ? Response.json(principal) : new Response("unauthorized", { status: 401 })
    if (!url.pathname.endsWith("/memory/mcp") || !principal) return new Response("not found", { status: 404 })
    const payload = typeof init?.body === "string" ? JSON.parse(init.body) as { params?: { name?: unknown; arguments?: unknown } } : {}
    const name = typeof payload.params?.name === "string" ? payload.params.name : ""
    const args = payload.params?.arguments && typeof payload.params.arguments === "object" && !Array.isArray(payload.params.arguments) ? payload.params.arguments as Record<string, unknown> : {}
    mcpCalls.push({ token, name, args })
    if (!grant) return mcpFailure("MEMORY_AGENT_GRANT_INVALID")
    if (name === "memory_remember") {
      const id = `platform-memory-${++sequence}`
      const value: Record<string, unknown> = {
        memory_id: id,
        tenant_id: principal.tenant_id,
        scope: "PERSONAL",
        owner_subject_id: principal.subject_id,
        team_id: null,
        organization_id: null,
        key: args.key,
        kind: args.kind,
        context: args.context,
        content: args.content,
        assertion_origin: "AGENT_INFERRED",
        source: {
          actor_subject_id: principal.subject_id,
          client_id: principal.acting_client_id,
          agent_id: principal.acting_client_id,
          agent_grant_id: `grant-${principal.subject_id}`,
          reference_id: args.source_reference_id ?? null,
        },
        revision: 1,
        created_at: 1,
        updated_at: 1,
      }
      platformMemories.set(id, value)
      return mcpResult(value)
    }
    if (name === "memory_get") {
      const memoryId = typeof args.memory_id === "string" ? args.memory_id : ""
      const value = platformMemories.get(memoryId)
      if (!value) return mcpFailure("MEMORY_NOT_FOUND")
      return mcpResult(readBackMutation ? readBackMutation(value) : value)
    }
    return mcpFailure("MEMORY_TOOL_NOT_FOUND")
  }) as typeof fetch

  try {
    const headers = { authorization: "Bearer owner-token" }
    expect(mcpCalls).toEqual([])
    const preview = await app.inject({ method: "GET", url: `/api/bots/${bot.id}/memory?query=legacy-memory-query-secret`, headers })
    expect(preview.statusCode).toBe(200)
    expect((preview.json() as Array<{ id: string }>).map((memory) => memory.id)).toContain(legacy.id)
    expect(mcpCalls).toEqual([])
    const unauthenticatedLegacyWrite = await app.inject({ method: "POST", url: `/api/bots/${bot.id}/memory`, payload: { key: "new", content: "must not save", kind: "fact" } })
    expect(unauthenticatedLegacyWrite.statusCode).toBe(401)
    const foreignLegacyWrite = await app.inject({ method: "POST", url: `/api/bots/${bot.id}/memory`, headers: { authorization: "Bearer other-token" }, payload: { key: "new", content: "must not save", kind: "fact" } })
    expect(foreignLegacyWrite.statusCode).toBe(404)
    const foreignLegacyPatch = await app.inject({ method: "PATCH", url: `/api/bots/${bot.id}/memory/${legacy.id}`, headers: { authorization: "Bearer other-token" }, payload: { forgotten: true, expectedRevision: legacy.revision } })
    expect(foreignLegacyPatch.statusCode).toBe(404)
    const unauthenticatedDelete = await app.inject({ method: "DELETE", url: `/api/bots/${bot.id}/memory/${legacy.id}`, payload: { expectedRevision: legacy.revision, content: "legacy-auth-body-secret" } })
    expect(unauthenticatedDelete.statusCode).toBe(401)
    expect(unauthenticatedDelete.json() as unknown).toEqual({ error: "GENIO_ONE_SESSION_TOKEN_REQUIRED" })
    const rejectedDelete = await app.inject({ method: "DELETE", url: `/api/bots/${bot.id}/memory/${legacy.id}`, headers: { authorization: "Bearer rejected-token" }, payload: { expectedRevision: legacy.revision } })
    expect(rejectedDelete.statusCode).toBe(401)
    expect(rejectedDelete.json() as unknown).toEqual({ error: "GENIO_ONE_SESSION_REJECTED" })
    const foreignDelete = await app.inject({ method: "DELETE", url: `/api/bots/${bot.id}/memory/${legacy.id}`, headers: { authorization: "Bearer other-token" }, payload: { expectedRevision: legacy.revision } })
    expect(foreignDelete.statusCode).toBe(404)
    expect(registry.memory.list(bot.id).find((memory) => memory.id === legacy.id)).toMatchObject({ revision: legacy.revision, content: legacy.content })
    const legacyWrite = await app.inject({ method: "POST", url: `/api/bots/${bot.id}/memory`, headers, payload: { key: "new", content: "must not save", kind: "fact" } })
    expect(legacyWrite.statusCode).toBe(410)
    expect(legacyWrite.json() as unknown).toEqual({ error: "BOT_LEGACY_MEMORY_READ_ONLY" })
    const legacyPatch = await app.inject({ method: "PATCH", url: `/api/bots/${bot.id}/memory/${legacy.id}`, headers, payload: { forgotten: true, expectedRevision: legacy.revision } })
    expect(legacyPatch.statusCode).toBe(410)
    expect(legacyPatch.json() as unknown).toEqual({ error: "BOT_LEGACY_MEMORY_READ_ONLY" })
    expect(mcpCalls).toEqual([])

    const imported = await app.inject({ method: "POST", url: `/api/bots/${bot.id}/memory/import`, headers, payload: { memoryIds: [legacy.id] } })
    expect(imported.statusCode).toBe(200)
    const importResult = imported.json() as ImportResult
    expect(importResult.source).toBe("legacy_bot_memory")
    expect(importResult.failed).toEqual([])
    expect(importResult.imported).toHaveLength(1)
    expect(importResult.imported[0]).toMatchObject({
      legacyMemory: { id: legacy.id, revision: legacy.revision, content: "使用臺灣繁體中文" },
      platformMemory: { id: "platform-memory-1", revision: 1, source: { referenceId: `legacy-bot-memory:${bot.id}:${legacy.id}` } },
      source: { kind: "legacy_bot_memory", botId: bot.id, memoryId: legacy.id, revision: legacy.revision },
    })
    expect(mcpCalls.map((call) => call.name)).toEqual(["memory_remember", "memory_get"])
    expect(mcpCalls[0]?.token).toBe("owner-token")
    expect(mcpCalls[0]?.args.source_reference_id).toBe(`legacy-bot-memory:${bot.id}:${legacy.id}`)
    expect(mcpCalls[1]?.args).toEqual({ memory_id: "platform-memory-1" })
    expect(mcpCalls.some((call) => call.name === "memory_retrieve")).toBe(false)
    expect(registry.memory.list(bot.id).find((memory) => memory.id === legacy.id)).toMatchObject({ content: "使用臺灣繁體中文" })

    const list = registry.memory.list.bind(registry.memory)
    registry.memory.list = (() => { throw new Error("unexpected storage failure") }) as typeof registry.memory.list
    const internalFailure = await app.inject({ method: "POST", url: `/api/bots/${bot.id}/memory/import`, headers, payload: { memoryIds: [legacy.id] } })
    expect(internalFailure.statusCode).toBe(500)
    expect(internalFailure.json() as unknown).toEqual({ error: "BOT_LEGACY_MEMORY_IMPORT_FAILED" })
    registry.memory.list = list

    const notOwner = await app.inject({ method: "POST", url: `/api/bots/${bot.id}/memory/import`, headers: { authorization: "Bearer other-token" }, payload: { memoryIds: [legacy.id] } })
    expect(notOwner.statusCode).toBe(404)
    expect(mcpCalls).toHaveLength(2)

    const forgottenImport = await app.inject({ method: "POST", url: `/api/bots/${bot.id}/memory/import`, headers, payload: { memoryIds: [forgotten.id] } })
    expect(forgottenImport.statusCode).toBe(400)
    expect(forgottenImport.json() as unknown).toEqual({ error: "BOT_LEGACY_MEMORY_NOT_IMPORTABLE" })
    const workingImport = await app.inject({ method: "POST", url: `/api/bots/${bot.id}/memory/import`, headers, payload: { memoryIds: [working.id] } })
    expect(workingImport.statusCode).toBe(400)
    expect(workingImport.json() as unknown).toEqual({ error: "BOT_LEGACY_MEMORY_NOT_IMPORTABLE" })

    const readBackFailure = registry.memory.save(bot.id, { key: "完整 read-back", content: "原始內容不能截斷", kind: "decision" }, "user")
    readBackMutation = (value) => ({
      ...value,
      revision: Number(value.revision) + 1,
      content: "被改寫的內容",
      source: { ...(value.source as Record<string, unknown>), reference_id: "legacy-bot-memory:wrong" },
    })
    const mismatched = await app.inject({ method: "POST", url: `/api/bots/${bot.id}/memory/import`, headers, payload: { memoryIds: [readBackFailure.id] } })
    expect(mismatched.statusCode).toBe(207)
    expect(mismatched.json() as unknown).toEqual({
      source: "legacy_bot_memory",
      imported: [],
      failed: [{
        legacyMemoryId: readBackFailure.id,
        error: "PERSONAL_MEMORY_READBACK_FAILED",
        writeResult: {
          id: "platform-memory-2",
          revision: 1,
          referenceId: `legacy-bot-memory:${bot.id}:${readBackFailure.id}`,
        },
      }],
    })
    expect(registry.memory.list(bot.id).find((memory) => memory.id === readBackFailure.id)).toMatchObject({ content: "原始內容不能截斷" })
    expect(mcpCalls.slice(-2).map((call) => call.name)).toEqual(["memory_remember", "memory_get"])
    expect(mcpCalls.at(-1)?.args).toEqual({ memory_id: "platform-memory-2" })
    readBackMutation = null

    const grantless = registry.memory.save(bot.id, { key: "未授權", content: "原始資料保留", kind: "fact" }, "user")
    grant = false
    const unavailable = await app.inject({ method: "POST", url: `/api/bots/${bot.id}/memory/import`, headers, payload: { memoryIds: [grantless.id] } })
    expect(unavailable.statusCode).toBe(207)
    expect(unavailable.json() as unknown).toEqual({ source: "legacy_bot_memory", imported: [], failed: [{ legacyMemoryId: grantless.id, error: "PERSONAL_MEMORY_UNAVAILABLE" }] })
    expect(registry.memory.list(bot.id).find((memory) => memory.id === grantless.id)).toMatchObject({ content: "原始資料保留" })
    expect(mcpCalls.map((call) => call.name)).toEqual(["memory_remember", "memory_get", "memory_remember", "memory_get", "memory_remember"])

    grant = true
    const revisedLegacy = registry.memory.setForgotten(bot.id, legacy.id, true, legacy.revision)
    const staleDelete = await app.inject({ method: "DELETE", url: `/api/bots/${bot.id}/memory/${legacy.id}`, headers, payload: { expectedRevision: legacy.revision } })
    expect(staleDelete.statusCode).toBe(409)
    const deleted = await app.inject({ method: "DELETE", url: `/api/bots/${bot.id}/memory/${legacy.id}`, headers, payload: { expectedRevision: revisedLegacy.revision } })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json() as unknown).toEqual({ id: legacy.id, deletedRevision: revisedLegacy.revision })
    expect(registry.memory.list(bot.id, true).find((memory) => memory.id === legacy.id)).toBeUndefined()
    const publicEvidence = await app.inject({ method: "POST", url: "/public-evidence?query=public-bot-query-evidence", payload: { content: "public-bot-body-evidence" } })
    expect(publicEvidence.statusCode).toBe(200)
    await app.close()
    const serialized = JSON.stringify(observations)
    for (const value of ["legacy-memory-query-secret", "legacy-auth-body-secret", legacy.content, readBackFailure.content, grantless.content, "public-bot-query-evidence", "public-bot-body-evidence"]) expect(serialized).not.toContain(value)
    const spans = observations.flatMap(value => value.resourceSpans ?? []).flatMap(value => value.scopeSpans).flatMap(value => value.spans)
    const publicSpan = spans.find(value => value.name === "POST /public-evidence")
    expect(publicSpan).toBeDefined()
    const publicAttributes = Object.fromEntries(publicSpan.attributes.map((value: any) => [value.key, value.value.stringValue ?? value.value.intValue]))
    expect(publicAttributes["genio.request"]).toBe(JSON.stringify({ availability: "OMITTED_HTTP_REQUEST" }))
    expect(publicAttributes["genio.response"]).toBe(JSON.stringify({ availability: "OMITTED_HTTP_RESPONSE" }))
    expect(publicAttributes["http.response.status_code"]).toBe("200")
    const memorySpans = spans.filter(value => value.name.includes(" /api/bots/"))
    expect(memorySpans.length).toBeGreaterThan(10)
    for (const span of memorySpans) {
      const attributes = Object.fromEntries(span.attributes.map((value: any) => [value.key, value.value.stringValue ?? value.value.intValue]))
      expect(attributes["genio.request"]).toBe(JSON.stringify({ availability: "OMITTED_SENSITIVE_REQUEST" }))
      expect(attributes["genio.response"]).toBe(JSON.stringify({ availability: "OMITTED_SENSITIVE_RESPONSE" }))
      expect(attributes["http.response.status_code"]).toBeTruthy()
    }
  } finally {
    await app.close()
    globalThis.fetch = originalFetch
    if (originalOrigin === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalOrigin
    registry.close()
  }
})
