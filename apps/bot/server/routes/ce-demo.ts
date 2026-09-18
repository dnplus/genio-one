import type { FastifyInstance } from "fastify"

import { CE_DEMO_PROMPTS, CE_DEMO_RESOURCE_IDS, CE_DEMO_USE_CASE_ID, type CeDemoPromptId } from "../../../../packages/protocol/src/ce-demo"
import { requestAccessToken, verifyGenioOneAccessToken } from "../auth"
import type { BotServerContext } from "../context"
import { packageCatalogForRequest } from "./catalog"

function demoPrompt(id: string): (typeof CE_DEMO_PROMPTS)[number] | null {
  return CE_DEMO_PROMPTS.find((candidate) => candidate.id === id as CeDemoPromptId) ?? null
}

function resourceIdForDemo(id: CeDemoPromptId) {
  return id === "interviews" ? CE_DEMO_RESOURCE_IDS.geminiBot : CE_DEMO_RESOURCE_IDS.bot
}

export async function ceDemoRoutes(app: FastifyInstance, context: BotServerContext) {
  app.get("/api/ce-demo/tasks/:taskId", async (request, reply) => {
    try {
      const task = demoPrompt((request.params as { taskId?: string }).taskId ?? "")
      if (!task) return reply.code(404).send({ error: "CE_DEMO_TASK_NOT_FOUND" })
      const accessToken = requestAccessToken(request)
      const principal = await verifyGenioOneAccessToken(accessToken)
      const resourceId = resourceIdForDemo(task.id)
      const manifest = (await packageCatalogForRequest(context, accessToken, principal)).find((candidate) =>
        candidate.resourceId === resourceId && candidate.modelRoute === task.model_route)
      if (!manifest) return reply.code(404).send({ error: "CE_DEMO_PACKAGE_NOT_FOUND" })
      return reply.send({
        id: task.id,
        title: task.title,
        modelRoute: task.model_route,
        resourceId,
        manifest,
        ...(task.model_route === "genio-gateway" ? { useCaseId: CE_DEMO_USE_CASE_ID } : {}),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : "BOT_AUTH_REQUIRED"
      return reply.code(message === "BOT_CATALOG_UNAVAILABLE" ? 503 : 401).send({ error: message })
    }
  })
}
