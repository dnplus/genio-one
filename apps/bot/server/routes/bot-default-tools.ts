import type { FastifyInstance } from "fastify"
import { requestAccessToken, requestPrincipal } from "../auth"
import { executeBotDefaultTool, isBotDefaultTool } from "../bot-default-tools"
import type { BotServerContext } from "../context"

export async function botDefaultToolRoutes(app: FastifyInstance, context: BotServerContext) {
  app.post("/api/bots/:botId/default-tools/:toolName", async (request, reply) => {
    const { botId, toolName } = request.params as { botId: string; toolName: string }
    try {
      const accessToken = requestAccessToken(request)
      const principal = await requestPrincipal(request)
      if (!context.botRegistry.getOwned(botId, principal)) return reply.code(404).send({ error: "BOT_NOT_FOUND" })
      if (!isBotDefaultTool(toolName)) return reply.code(404).send({ error: "BOT_TOOL_NOT_FOUND" })
      reply.header("cache-control", "no-store")
      return reply.send(await executeBotDefaultTool(toolName, request.body, { context, botId, principal, accessToken }))
    } catch (error) {
      const message = error instanceof Error ? error.message : "BOT_TOOL_FAILED"
      const status = /GENIO_ONE_SESSION|BOT_AUTH/.test(message) ? 401 : 400
      return reply.code(status).send({ content: [{ type: "text", text: message }], isError: true })
    }
  })
}
