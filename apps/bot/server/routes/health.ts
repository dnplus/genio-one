import type { FastifyInstance } from "fastify"
import type { BotServerContext } from "../context"

export async function healthRoutes(app: FastifyInstance, context: BotServerContext) {
  app.get("/healthz", async () => ({ status: "ok", component: "genio-one-bot" }))
  app.get("/api/runtime", async () => ({
    configured: process.env.GENIO_BOT_RUNTIME?.trim() || "e2b-self-hosted",
    capabilityGate: context.capabilityGate.mode,
    modelDirectory: "one-policy",
    modelRoutes: context.modelDirectory.availableRoutes(),
    active: context.runtimeBroker.latestDetails(),
    activeCount: context.runtimeBroker.activeCount(),
  }))
}
