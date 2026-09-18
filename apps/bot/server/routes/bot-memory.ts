import type { FastifyInstance } from "fastify"
import type { BotServerContext } from "../context"
import { requestPrincipal } from "../auth"

export async function botMemoryRoutes(app: FastifyInstance, context: BotServerContext) {
  app.get("/api/bots/:botId/memory", async (request, reply) => {
    const botId = (request.params as { botId: string }).botId
    if (!context.botRegistry.getOwned(botId, await requestPrincipal(request))) return reply.code(404).send({ error: "BOT_NOT_FOUND" })
    return context.botRegistry.memory.list(botId, (request.query as { includeForgotten?: string }).includeForgotten === "true")
  })
  for (const method of ["POST", "PATCH"] as const) {
    app.route({ method, url: method === "POST" ? "/api/bots/:botId/memory" : "/api/bots/:botId/memory/:memoryId", handler: async (request, reply) => {
      const { botId, memoryId } = request.params as { botId: string; memoryId: string }
      if (!context.botRegistry.getOwned(botId, await requestPrincipal(request))) return reply.code(404).send({ error: "BOT_NOT_FOUND" })
      const body = request.body as any
      try {
        if (!body || typeof body !== "object") throw new Error("BOT_MEMORY_INVALID")
        if (method === "POST") return context.botRegistry.memory.save(botId, body, "user")
        if (typeof body.forgotten !== "boolean") throw new Error("BOT_MEMORY_INVALID")
        return context.botRegistry.memory.setForgotten(botId, memoryId, body.forgotten, body.expectedRevision)
      } catch (error) {
        const message = error instanceof Error ? error.message : "BOT_MEMORY_FAILED"
        return reply.code(message === "BOT_MEMORY_CONFLICT" ? 409 : 400).send({ error: message })
      }
    } })
  }
}
