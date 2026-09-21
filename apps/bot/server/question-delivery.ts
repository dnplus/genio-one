import type { BotServerContext } from "./context"
import type { BotQuestion } from "../shared/bot-question"
import type { RuntimeSession } from "./runtime-broker"
import type { Turn } from "./generated/v2/Turn"
import { assertCapability, PERSONAL_BOT_USE } from "./capability-gate"
import { botTurnContext } from "./bot-context"
import { canonicalizeNativeParams } from "./native-runtime-params"
import { readNativeRuntimeExposure } from "./native-runtime-policy"
import { createRuntimePolicyLifecycle } from "./runtime-policy-lifecycle"

export async function reconcileQuestionDelivery(context: BotServerContext, session: RuntimeSession, question: BotQuestion) {
  if (!question.deliveryThreadId) return question
  if (!context.botRegistry.ownsThread(session.principal, question.botId, question.deliveryThreadId)) throw new Error("BOT_THREAD_NOT_OWNED")
  let cursor: string | undefined
  const seen = new Set<string>()
  do {
    const page = await context.runtimeBroker.request(session.id, "thread/turns/list", { threadId: question.deliveryThreadId, cursor, limit: 50, sortDirection: "desc", itemsView: "full" }) as { data: Turn[]; nextCursor?: string }
    context.botRegistry.questions.reconcile(question.botId, question.deliveryThreadId, page.data)
    if (context.botRegistry.questions.get(question.botId, question.id).delivery === "delivered") break
    if (page.nextCursor && seen.has(page.nextCursor)) throw new Error("BOT_HISTORY_CURSOR_STALLED")
    cursor = page.nextCursor ?? undefined
    if (cursor) seen.add(cursor)
  } while (cursor)
  return context.botRegistry.questions.get(question.botId, question.id)
}

const scanning = new WeakSet<BotServerContext>()

export async function deliverQuestionAnswers(context: BotServerContext) {
  if (scanning.has(context)) return
  scanning.add(context)
  try {
    for (const entry of context.botRegistry.questions.pending()) {
      const row = context.botRegistry.db.query("select tenant_id, owner_subject_id from bots where id = ?").get(entry.botId) as { tenant_id: string; owner_subject_id: string } | null
      if (!row) continue
      const principal = { tenant_id: row.tenant_id, subject_id: row.owner_subject_id, acting_client_id: "genio-one-bot", scopes: ["genioone-invocation"] }
      const session = context.runtimeBroker.findByPrincipal(principal)
      if (!session?.initialized || !session.accessToken) continue
      const release = context.runtimeBroker.claimBotTurn(entry.botId)
      if (!release) continue
      try {
        await assertCapability(context.capabilityGate, principal, PERSONAL_BOT_USE, session.accessToken)
        let question = context.botRegistry.questions.get(entry.botId, entry.id)
        if (question.delivery === "sending" || question.delivery === "uncertain") {
          question = await reconcileQuestionDelivery(context, session, question)
          if (question.delivery !== "delivered") context.botRegistry.questions.mark(question.botId, question.id, "uncertain", { error: "送達結果待確認，已保留答案；請核對後重試。" })
          continue
        }
        if (question.delivery !== "queued") continue
        const active = context.botRegistry.timeline.activeTurns(question.botId)
        let threadId = context.botRegistry.getSession(question.botId)?.appServerThreadId ?? undefined
        const originalStillActive = active.length === 1 && active[0]!.threadId === threadId && active[0]!.threadId === question.sourceThreadId && active[0]!.turnId === question.sourceTurnId
        if (active.length && !originalStillActive) continue
        if (!originalStillActive && threadId) {
          const read = await context.runtimeBroker.request(session.id, "thread/read", { threadId })
          if (read.thread?.status?.type === "active") continue
        }
        const bot = context.botRegistry.getOwned(question.botId, principal)
        if (!bot) continue
        const lifecycle = createRuntimePolicyLifecycle({ policy: context.runtimePolicy, accessToken: () => session.accessToken ?? null, onReportFailure: () => console.warn(JSON.stringify({ event: "bot.question.audit_deferred", question_id: question.id })) })
        const decision = bot.modelRoute === "codex-subscription" ? await lifecycle.authorize(session, bot.id, "codex.subscription", "use") : null
        let sent = false
        try {
          const exposure = await readNativeRuntimeExposure({ runtimePolicy: context.runtimePolicy, session, botId: bot.id, accessToken: session.accessToken })
          const canonical = (method: "thread/start" | "thread/resume" | "turn/start", params: Record<string, unknown>) => canonicalizeNativeParams({ method, params, session, botId: bot.id, exposure, environment: { hasRuntimeEnvironment: false, hasDesktopRuntime: false }, botRegistry: context.botRegistry, modelDirectory: context.modelDirectory, accessToken: session.accessToken })
          if (!originalStillActive) {
            if (threadId) {
              const params = await canonical("thread/resume", { threadId, excludeTurns: true })
              params.config = { ...(params.config as object), "mcp_servers.genio_bot": context.botToolSessions.config(bot.id, principal, session.id), "features.memories": false }
              await context.runtimeBroker.request(session.id, "thread/resume", params)
            } else {
              const params = await canonical("thread/start", {})
              params.config = { ...(params.config as object), "mcp_servers.genio_bot": context.botToolSessions.config(bot.id, principal, session.id), "features.memories": false }
              const result = await context.runtimeBroker.request(session.id, "thread/start", params)
              threadId = result.thread.id
              context.botRegistry.saveSession({ botId: bot.id, appServerThreadId: threadId!, activeRuntimeTier: "none" })
            }
          }
          const input = [{ type: "text", text: `The user answered a previously saved clarification question. Continue the relevant work using this answer. This is clarification, not a tool approval or permission to expand scope. Original question: ${question.title}\nAnswer: ${question.answer}`, text_elements: [] }]
          const clientUserMessageId = `question-answer:${question.id}:${question.clientAnswerId}`
          const params = originalStillActive
            ? { threadId, expectedTurnId: question.sourceTurnId, clientUserMessageId, input }
            : await canonical("turn/start", { threadId, clientUserMessageId, input, additionalContext: botTurnContext(context.botRegistry, bot.id, threadId!, {}, bot, principal) })
          context.botRegistry.questions.mark(bot.id, question.id, "sending", { deliveryThreadId: threadId, error: undefined })
          sent = true
          const result = await context.runtimeBroker.request(session.id, originalStillActive ? "turn/steer" : "turn/start", params)
          if (result.turn) context.botRegistry.recordRuntimeEvent(principal, JSON.stringify({ method: "turn/started", params: { threadId, turn: result.turn } }))
          context.botRegistry.questions.mark(bot.id, question.id, "delivered", { deliveryTurnId: result.turn?.id ?? result.turnId ?? question.sourceTurnId })
          console.info(JSON.stringify({ event: "bot.question.answer_delivered", bot_id: bot.id, question_id: question.id, thread_id: threadId, turn_id: result.turn?.id ?? result.turnId, correlation_id: decision?.correlation_id, transport: originalStillActive ? "steer" : "start" }))
          if (decision) await lifecycle.report(session, bot.id, decision, "ALLOW")
        } catch (error) {
          if (decision) await lifecycle.report(session, bot.id, decision, "FAILED", sent ? "ANSWER_DELIVERY_UNCERTAIN" : "ANSWER_PREPARATION_FAILED")
          const rejectedSteer = originalStillActive && /no active turn|expected.*turn|turn.*mismatch/i.test(error instanceof Error ? error.message : "")
          context.botRegistry.questions.mark(question.botId, question.id, rejectedSteer ? "queued" : sent ? "uncertain" : "failed", { error: rejectedSteer ? undefined : sent ? "送達結果待確認，請核對後重試。" : "目前無法接續，請確認模型與授權後重試。" })
        }
      } catch {
        const current = context.botRegistry.questions.get(entry.botId, entry.id)
        if (current.delivery === "queued") context.botRegistry.questions.mark(entry.botId, entry.id, "failed", { error: "接續所需的授權或執行環境尚未就緒；答案已保存，確認後可重試。" })
        if (current.delivery === "sending") context.botRegistry.questions.mark(entry.botId, entry.id, "uncertain", { error: "送達結果尚未確認，請核對後重試。" })
        console.warn(JSON.stringify({ event: "bot.question.delivery_deferred", bot_id: entry.botId, question_id: entry.id }))
      } finally { release() }
    }
  } finally { scanning.delete(context) }
}
