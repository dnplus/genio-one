import type { FastifyInstance } from "fastify"
import { Readable } from "node:stream"
import { HANDS_PROVIDER_DESCRIPTORS, type HandsProvider } from "@genioone/protocol/hands"
import { requestAccessToken, requestPrincipal } from "../auth"
import { handsBackendFor } from "../hands-provider"
import type { BotServerContext } from "../context"
import { executeHandsIsolate } from "../hands-isolate"

function errorCode(error: unknown) { return error instanceof Error ? error.message : "WORKSPACE_REQUEST_FAILED" }

export async function workspaceRoutes(app: FastifyInstance, context: BotServerContext) {
  app.get("/api/hands/providers", async (request, reply) => {
    try {
      await requestPrincipal(request)
      const selectedByDefault = process.env.GENIO_BOT_RUNTIME?.trim() || "e2b-self-hosted"
      return reply.send(HANDS_PROVIDER_DESCRIPTORS.map((descriptor) => ({
        ...descriptor,
        deploymentDefault: descriptor.provider === selectedByDefault,
        configured: descriptor.provider === "cloudflare-hands"
          ? Boolean(process.env.GENIO_CF_HANDS_ORIGIN?.trim() && process.env.GENIO_CF_HANDS_TOKEN?.trim())
          : Boolean(process.env.E2B_API_KEY?.trim() && process.env.E2B_DOMAIN?.trim()),
      })))
    } catch (error) { return reply.code(401).send({ error: errorCode(error) }) }
  })

  app.get("/api/hands/recoverable-workspaces", async (request, reply) => {
    try { return reply.send(context.workspaces.recoverable(await requestPrincipal(request))) }
    catch (error) { return reply.code(401).send({ error: errorCode(error) }) }
  })

  app.get("/api/hands/recoverable-workspaces/:workspaceId/export", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      const { workspaceId } = request.params as { workspaceId: string }
      const workspace = context.workspaces.getRecoverable(principal, workspaceId)
      if (!workspace) return reply.code(404).send({ error: "WORKSPACE_NOT_FOUND" })
      reply.header("cache-control", "no-store")
      const response = await handsBackendFor(workspace.provider).exportWorkspace(workspace, context.workspaces, principal.acting_client_id)
      if (response.status === 204) return reply.code(204).send()
      if (!response.body) throw new Error("WORKSPACE_EXPORT_EMPTY")
      const gzip = response.headers.get("content-type") === "application/gzip"
      reply.header("content-disposition", `attachment; filename="genio-workspace-${workspace.workspaceId}.${gzip ? "tar.gz" : "tar"}"`)
      reply.header("content-type", gzip ? "application/gzip" : "application/octet-stream")
      return reply.send(Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]))
    } catch (error) { return reply.code(400).send({ error: errorCode(error) }) }
  })

  app.get("/api/bots/:botId/workspaces", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      const { botId } = request.params as { botId: string }
      const workspaces = context.workspaces.list(principal, botId)
      return reply.send({ workspaces, activeWorkspaceId: context.workspaces.active(principal, botId)?.workspaceId ?? null })
    } catch (error) { return reply.code(400).send({ error: errorCode(error) }) }
  })

  app.post("/api/bots/:botId/workspaces", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      const accessToken = requestAccessToken(request)
      const { botId } = request.params as { botId: string }
      const body = request.body as { provider?: HandsProvider } | undefined
      const current = context.runtimeBroker.findByPrincipal(principal)
      if (context.runtimeBroker.hasActiveBotLease(principal.tenant_id, principal.subject_id, botId) || context.workspaces.hasInFlightForBot(botId)) throw new Error("WORKSPACE_BUSY")
      const actor = { principal, botId, accessToken, sessionId: current?.id }
      const provider = body?.provider ?? await context.handsPlacement.providerForNew(actor)
      if (provider !== "e2b-self-hosted" && provider !== "cloudflare-hands") throw new Error("HANDS_PROVIDER_INVALID")
      const workspace = await context.handsPlacement.run(actor, provider, () => context.workspaces.create(principal, botId, provider))
      if (current?.selectedBotId === botId) context.runtimeBroker.refreshWorkspaceDetails(current.id)
      return reply.code(201).send(workspace)
    } catch (error) { return reply.code(errorCode(error) === "WORKSPACE_BUSY" ? 409 : 400).send({ error: errorCode(error) }) }
  })

  app.post("/api/bots/:botId/workspaces/:workspaceId/activate", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      const accessToken = requestAccessToken(request)
      const { botId, workspaceId } = request.params as { botId: string; workspaceId: string }
      const current = context.runtimeBroker.findByPrincipal(principal)
      if (context.runtimeBroker.hasActiveBotLease(principal.tenant_id, principal.subject_id, botId) || context.workspaces.hasInFlightForBot(botId)) throw new Error("WORKSPACE_BUSY")
      const candidate = context.workspaces.get(principal, botId, workspaceId)
      if (!candidate) throw new Error("WORKSPACE_NOT_FOUND")
      const workspace = await context.handsPlacement.run({ principal, botId, accessToken, sessionId: current?.id }, candidate.provider, () => context.workspaces.setActive(principal, botId, workspaceId))
      if (current?.selectedBotId === botId) context.runtimeBroker.refreshWorkspaceDetails(current.id)
      return reply.send(workspace)
    } catch (error) { return reply.code(errorCode(error) === "WORKSPACE_BUSY" ? 409 : 400).send({ error: errorCode(error) }) }
  })

  app.post("/api/bots/:botId/workspaces/:workspaceId/isolate", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      const accessToken = requestAccessToken(request)
      const { botId, workspaceId } = request.params as { botId: string; workspaceId: string }
      const body = request.body as { requestId?: string; code?: string; workspaceAccess?: "none" | "read" | "read-write"; timeoutMs?: number } | undefined
      const result = await executeHandsIsolate(context, principal, botId, accessToken, {
        workspaceId,
        requestId: body?.requestId ?? "",
        code: body?.code ?? "",
        workspaceAccess: body?.workspaceAccess,
        ...(body?.timeoutMs === undefined ? {} : { timeoutMs: body.timeoutMs }),
      })
      return reply.send(result)
    } catch (error) { return reply.code(errorCode(error) === "WORKSPACE_BUSY" ? 409 : 400).send({ error: errorCode(error) }) }
  })
}
