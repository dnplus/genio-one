import type { FastifyInstance } from "fastify"
import { requestPrincipal } from "../auth"
import type { BotServerContext } from "../context"

export async function healthRoutes(app: FastifyInstance, context: BotServerContext) {
  const configuration = () => ({
    configured: process.env.GENIO_BOT_RUNTIME?.trim() || "e2b-self-hosted",
    capabilityGate: context.capabilityGate.mode,
    modelDirectory: "one-policy",
  })
  app.get("/healthz", async () => ({ status: "ok", component: "genio-one-bot", ...configuration() }))
  app.get("/api/runtime", async (request, reply) => {
    reply.header("cache-control", "no-store")
    let principal
    try {
      principal = await requestPrincipal(request)
    } catch (error) {
      const message = error instanceof Error ? error.message : ""
      const status = error && typeof error === "object" && "status" in error ? error.status : null
      const rejected = message === "GENIO_ONE_SESSION_TOKEN_REQUIRED" || (message === "GENIO_ONE_SESSION_REJECTED" && (status === 401 || status === 403))
      return reply.code(rejected ? 401 : 503).send({ error: rejected ? message : "GENIO_ONE_SESSION_UNAVAILABLE" })
    }
    const details = context.runtimeBroker.findByPrincipal(principal)?.details
    return {
      ...configuration(),
      active: details ? {
        kind: details.kind,
        tier: details.tier,
        execReady: details.execReady,
        hasEnvironment: Boolean(details.environmentId),
        hasSandbox: Boolean(details.sandboxId),
        hasDesktop: Boolean(details.desktopUrl),
      } : null,
    }
  })
}
