import { reconcileQuestionDelivery } from "../question-delivery"
import type { FastifyInstance } from "fastify"
import { requestPrincipal } from "../auth"
import type { BotServerContext } from "../context"

export async function botQuestionRoutes(app: FastifyInstance, context: BotServerContext) {
  app.get("/api/bots/:botId/questions", async (request, reply) => {
    const { botId } = request.params as { botId: string }
    if (!context.botRegistry.getOwned(botId, await requestPrincipal(request))) return reply.code(404).send({ error: "BOT_NOT_FOUND" })
    return context.botRegistry.questions.list(botId)
  })
  for (const action of ["answer", "dismiss", "retry"] as const) app.post(`/api/bots/:botId/questions/:questionId/${action}`, async (request, reply) => {
    try {
      const { botId, questionId } = request.params as { botId: string; questionId: string }
      if (!context.botRegistry.getOwned(botId, await requestPrincipal(request))) return reply.code(404).send({ error: "BOT_NOT_FOUND" })
      const body = request.body as { questionRevision?: unknown; clientAnswerId?: unknown; answer?: unknown }
      if (!body || !Number.isSafeInteger(body.questionRevision)) throw new Error("BOT_ANSWER_INVALID")
      if (action === "retry") {
        const question = context.botRegistry.questions.get(botId, questionId)
        if (question.revision !== body.questionRevision) throw new Error("BOT_QUESTION_CONFLICT")
        if (question.delivery === "delivered" || question.delivery === "queued") return question
        if (question.delivery !== "failed" && question.delivery !== "uncertain") throw new Error("BOT_QUESTION_CONFLICT")
        const principal = await requestPrincipal(request)
        const session = context.runtimeBroker.findByPrincipal(principal)
        if (!session?.initialized) throw new Error("BOT_RUNTIME_NOT_READY")
        const release = context.runtimeBroker.claimBotTurn(botId)
        if (!release) throw new Error("BOT_TURN_BUSY")
        try {
          if (question.deliveryThreadId) {
            const read = await context.runtimeBroker.request(session.id, "thread/read", { threadId: question.deliveryThreadId })
            if (read.thread?.status?.type === "active") throw new Error("BOT_TURN_BUSY")
            const reconciled = await reconcileQuestionDelivery(context, session, question)
            if (reconciled.delivery === "delivered") return reconciled
          }
          return context.botRegistry.questions.mark(botId, questionId, "queued", { error: undefined })
        } finally { release() }
      }
      if (action === "dismiss") return context.botRegistry.questions.dismiss(botId, questionId, body.questionRevision as number)
      if (typeof body.clientAnswerId !== "string" || typeof body.answer !== "string") throw new Error("BOT_ANSWER_INVALID")
      return context.botRegistry.questions.answer(botId, questionId, body.questionRevision as number, body.clientAnswerId, body.answer)
    } catch (error) {
      const message = error instanceof Error ? error.message : "BOT_ANSWER_FAILED"
      return reply.code(message === "BOT_QUESTION_CONFLICT" ? 409 : message === "BOT_QUESTION_NOT_FOUND" ? 404 : 400).send({ error: message })
    }
  })
}
