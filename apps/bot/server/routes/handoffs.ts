import type { FastifyInstance } from "fastify"

import { requestAccessToken, requestPrincipal } from "../auth"
import type { BotServerContext } from "../context"
import { HandoffFanOutError } from "../bot-handoff"
import { deliverHandoff } from "../handoff-delivery"

export async function handoffRoutes(app: FastifyInstance, context: BotServerContext) {
  const { botRegistry } = context

  app.post("/api/bot-handoffs", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      const body = (request.body ?? {}) as Record<string, unknown>
      const toBotIds = Array.isArray(body.toBotIds)
        ? body.toBotIds.filter((value): value is string => typeof value === "string")
        : undefined
      const acks = botRegistry.createHandoffs(principal, {
        clientRequestId: typeof body.clientRequestId === "string" ? body.clientRequestId : undefined,
        originalMessage: typeof body.originalMessage === "string" ? body.originalMessage : undefined,
        sourceAuthor: "user",
        fromBotId: typeof body.fromBotId === "string" ? body.fromBotId : "",
        toBotId: typeof body.toBotId === "string" ? body.toBotId : undefined,
        toBotIds,
        fanOutExplicit: body.fanOutExplicit === true,
        fact: typeof body.fact === "string" ? body.fact : "",
        kind: body.kind === "fyi" ? "fyi" : "task",
        visibility: body.visibility === "silent" || body.visibility === "visible" ? body.visibility : undefined,
      })
      const accessToken = requestAccessToken(request)
      for (const ack of acks) {
        void deliverHandoff(context, principal, ack.handoffId, accessToken).catch(() => {
          console.warn(JSON.stringify({ event: "bot.handoff.delivery_failed", handoff_id: ack.handoffId }))
        })
      }
      console.info(JSON.stringify({
        event: "bot.handoff.acked",
        count: acks.length,
        handoff_ids: acks.map((ack) => ack.handoffId),
        async: true,
        correlation_id: acks[0]?.handoffId,
      }))
      // Single target → object; explicit fan-out → array (still per-target ack, no same-turn process)
      return reply.code(201).send(acks.length === 1 ? acks[0] : { acks, async: true, processed: false })
    } catch (error) {
      if (error instanceof HandoffFanOutError) {
        return reply.code(400).send({ error: error.code, message: error.message })
      }
      const message = error instanceof Error ? error.message : "BOT_HANDOFF_FAILED"
      const code = message === "HANDOFF_REQUEST_CONFLICT" ? 409 : message === "BOT_NOT_FOUND" || message === "BOT_NOT_SHARED" ? 404 : 400
      return reply.code(code).send({ error: message })
    }
  })

  app.post("/api/bot-handoffs/:handoffId/process", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      const handoffId = (request.params as { handoffId: string }).handoffId
      return reply.send(await deliverHandoff(context, principal, handoffId, requestAccessToken(request)))
    } catch (error) {
      const message = error instanceof Error ? error.message : "BOT_HANDOFF_PROCESS_FAILED"
      return reply.code(400).send({ error: message })
    }
  })

  app.get("/api/bot-handoffs/:handoffId", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      const handoff = botRegistry.getHandoff(principal, (request.params as { handoffId: string }).handoffId)
      if (!handoff) return reply.code(404).send({ error: "HANDOFF_NOT_FOUND" })
      return reply.send(handoff)
    } catch (error) {
      return reply.code(401).send({ error: error instanceof Error ? error.message : "BOT_AUTH_REQUIRED" })
    }
  })

  app.get("/api/bots/:botId/handoff-events", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      const botId = (request.params as { botId: string }).botId
      const includeSilent = (request.query as { includeSilent?: string }).includeSilent === "1"
        || (request.query as { includeSilent?: string }).includeSilent === "true"
      return reply.send(botRegistry.listHandoffEvents(principal, botId, { includeSilent }))
    } catch (error) {
      const message = error instanceof Error ? error.message : "BOT_HANDOFF_EVENTS_FAILED"
      const code = message === "HANDOFF_REQUEST_CONFLICT" ? 409 : message === "BOT_NOT_FOUND" ? 404 : 401
      return reply.code(code).send({ error: message })
    }
  })
}
