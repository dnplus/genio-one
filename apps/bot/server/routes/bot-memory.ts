import type { FastifyInstance } from "fastify"
import type { BotMemory } from "../../shared/bot-memory"
import { requestAccessToken, requestPrincipal } from "../auth"
import type { BotServerContext } from "../context"
import { getPlatformPersonalMemory, PlatformMemoryOperationError, PlatformMemoryUnavailableError, rememberPlatformPersonalMemory } from "../platform-memory"

type ImportableBotMemory = BotMemory & { kind: "preference" | "fact" | "decision" }

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function memoryIds(value: unknown) {
  const body = record(value)
  const ids = body?.memoryIds
  if (!body || Object.keys(body).some((key) => key !== "memoryIds") || !Array.isArray(ids) || ids.length === 0 || ids.length > 200 || ids.some((id) => typeof id !== "string" || !id || id.length > 256)) throw new Error("BOT_LEGACY_MEMORY_IMPORT_INVALID")
  return [...new Set(ids)] as string[]
}

function sourceReference(botId: string, memory: BotMemory) {
  const value = `legacy-bot-memory:${botId}:${memory.id}`
  if (value.length > 256) throw new Error("BOT_LEGACY_MEMORY_IMPORT_INVALID")
  return value
}

function importError(error: unknown) {
  if (error instanceof PlatformMemoryUnavailableError || error instanceof PlatformMemoryOperationError) return error.message
  return error instanceof Error ? error.message : "PERSONAL_MEMORY_IMPORT_FAILED"
}

function sameSource(
  left: Awaited<ReturnType<typeof rememberPlatformPersonalMemory>>["source"],
  right: Awaited<ReturnType<typeof rememberPlatformPersonalMemory>>["source"],
) {
  return left.actorSubjectId === right.actorSubjectId &&
    left.clientId === right.clientId &&
    left.agentId === right.agentId &&
    left.agentGrantId === right.agentGrantId &&
    left.referenceId === right.referenceId
}

export async function botMemoryRoutes(app: FastifyInstance, context: BotServerContext) {
  app.get("/api/bots/:botId/memory", { config: { sensitiveRequest: true, sensitiveResponse: true } }, async (request, reply) => {
    const botId = (request.params as { botId: string }).botId
    if (!context.botRegistry.getOwned(botId, await requestPrincipal(request))) return reply.code(404).send({ error: "BOT_NOT_FOUND" })
    return context.botRegistry.memory.list(botId, (request.query as { includeForgotten?: string }).includeForgotten === "true")
  })

  app.post("/api/bots/:botId/memory", { config: { sensitiveRequest: true, sensitiveResponse: true } }, async (request, reply) => {
    try {
      const botId = (request.params as { botId: string }).botId
      if (!context.botRegistry.getOwned(botId, await requestPrincipal(request))) return reply.code(404).send({ error: "BOT_NOT_FOUND" })
      return reply.code(410).send({ error: "BOT_LEGACY_MEMORY_READ_ONLY" })
    } catch (error) {
      const message = error instanceof Error ? error.message : "GENIO_ONE_SESSION_REJECTED"
      return reply.code(message === "GENIO_ONE_SESSION_TOKEN_REQUIRED" || message === "GENIO_ONE_SESSION_REJECTED" ? 401 : 503).send({ error: message })
    }
  })

  app.patch("/api/bots/:botId/memory/:memoryId", { config: { sensitiveRequest: true, sensitiveResponse: true } }, async (request, reply) => {
    try {
      const botId = (request.params as { botId: string }).botId
      if (!context.botRegistry.getOwned(botId, await requestPrincipal(request))) return reply.code(404).send({ error: "BOT_NOT_FOUND" })
      return reply.code(410).send({ error: "BOT_LEGACY_MEMORY_READ_ONLY" })
    } catch (error) {
      const message = error instanceof Error ? error.message : "GENIO_ONE_SESSION_REJECTED"
      return reply.code(message === "GENIO_ONE_SESSION_TOKEN_REQUIRED" || message === "GENIO_ONE_SESSION_REJECTED" ? 401 : 503).send({ error: message })
    }
  })

  app.post("/api/bots/:botId/memory/import", { config: { sensitiveRequest: true, sensitiveResponse: true } }, async (request, reply) => {
    try {
      const accessToken = requestAccessToken(request)
      const principal = await requestPrincipal(request)
      const botId = (request.params as { botId: string }).botId
      if (!context.botRegistry.getOwned(botId, principal)) return reply.code(404).send({ error: "BOT_NOT_FOUND" })
      const selected = memoryIds(request.body)
      const active = new Map(context.botRegistry.memory.list(botId).map((memory) => [memory.id, memory]))
      const legacy = selected.map((memoryId) => active.get(memoryId))
      if (legacy.some((memory) => !memory || memory.kind === "working_context")) return reply.code(400).send({ error: "BOT_LEGACY_MEMORY_NOT_IMPORTABLE" })
      const imported: Array<{
        legacyMemory: Pick<BotMemory, "id" | "key" | "kind" | "content" | "revision">
        platformMemory: Awaited<ReturnType<typeof rememberPlatformPersonalMemory>>
        source: { kind: "legacy_bot_memory"; botId: string; memoryId: string; revision: number; referenceId: string }
      }> = []
      const failed: Array<{ legacyMemoryId: string; error: string; writeResult?: { id: string; revision: number; referenceId: string | null } }> = []
      for (let index = 0; index < legacy.length; index += 1) {
        const memory = legacy[index] as ImportableBotMemory
        const referenceId = sourceReference(botId, memory)
        let written: Awaited<ReturnType<typeof rememberPlatformPersonalMemory>>
        try {
          written = await rememberPlatformPersonalMemory({
            principal,
            accessToken,
            expectedRevision: 0,
            key: memory.key,
            kind: memory.kind,
            content: memory.content,
            sourceReferenceId: referenceId,
          })
        } catch (error) {
          const code = importError(error)
          failed.push({ legacyMemoryId: memory.id, error: code })
          if (code === "PERSONAL_MEMORY_UNAVAILABLE") {
            for (let remaining = index + 1; remaining < legacy.length; remaining += 1) failed.push({ legacyMemoryId: (legacy[remaining] as BotMemory).id, error: code })
            break
          }
          continue
        }
        try {
          const platformMemory = await getPlatformPersonalMemory({ principal, accessToken, memoryId: written.id })
          if (
            platformMemory.id !== written.id ||
            platformMemory.revision !== written.revision ||
            platformMemory.key !== memory.key ||
            platformMemory.kind !== memory.kind ||
            platformMemory.content !== memory.content ||
            platformMemory.context.kind !== "GLOBAL" ||
            platformMemory.context.contextId !== null ||
            platformMemory.source.referenceId !== referenceId ||
            !sameSource(platformMemory.source, written.source)
          ) throw new Error("PERSONAL_MEMORY_READBACK_FAILED")
          imported.push({
            legacyMemory: { id: memory.id, key: memory.key, kind: memory.kind, content: memory.content, revision: memory.revision },
            platformMemory,
            source: { kind: "legacy_bot_memory", botId, memoryId: memory.id, revision: memory.revision, referenceId },
          })
        } catch {
          failed.push({ legacyMemoryId: memory.id, error: "PERSONAL_MEMORY_READBACK_FAILED", writeResult: { id: written.id, revision: written.revision, referenceId: written.source.referenceId } })
        }
      }
      return reply.code(failed.length ? 207 : 200).send({ source: "legacy_bot_memory", imported, failed })
    } catch (error) {
      const message = importError(error)
      if (message === "BOT_LEGACY_MEMORY_NOT_IMPORTABLE" || message === "BOT_LEGACY_MEMORY_IMPORT_INVALID") return reply.code(400).send({ error: message })
      if (message === "GENIO_ONE_SESSION_TOKEN_REQUIRED" || message === "GENIO_ONE_SESSION_REJECTED") return reply.code(401).send({ error: message })
      return reply.code(500).send({ error: "BOT_LEGACY_MEMORY_IMPORT_FAILED" })
    }
  })

  app.delete("/api/bots/:botId/memory/:memoryId", { config: { sensitiveRequest: true, sensitiveResponse: true } }, async (request, reply) => {
    try {
      const botId = (request.params as { botId: string }).botId
      const memoryId = (request.params as { memoryId: string }).memoryId
      if (!context.botRegistry.getOwned(botId, await requestPrincipal(request))) return reply.code(404).send({ error: "BOT_NOT_FOUND" })
      const body = record(request.body)
      if (!body || Object.keys(body).some((key) => key !== "expectedRevision")) throw new Error("BOT_MEMORY_INVALID")
      return context.botRegistry.memory.hardDelete(botId, memoryId, body.expectedRevision)
    } catch (error) {
      const message = error instanceof Error ? error.message : "BOT_MEMORY_DELETE_FAILED"
      const status = message === "GENIO_ONE_SESSION_TOKEN_REQUIRED" || message === "GENIO_ONE_SESSION_REJECTED" ? 401 : message === "BOT_MEMORY_NOT_FOUND" ? 404 : message === "BOT_MEMORY_CONFLICT" ? 409 : 400
      return reply.code(status).send({ error: message })
    }
  })
}
