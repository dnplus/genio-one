import type { BotRegistry } from "./bot-registry"
import type { BotServerContext } from "./context"
import { assertCapability, PERSONAL_BOT_USE } from "./capability-gate"
import { runApprovedBotInvocation } from "./routes/invocations"
import type { ThreadTurnsListResponse } from "./generated/v2/ThreadTurnsListResponse"

const dispatching = new WeakSet<BotServerContext>()
const reading = new WeakSet<BotServerContext>()

export async function recoverNativeInvocationResults(context: BotServerContext) {
  if (reading.has(context)) return
  reading.add(context)
  const inspected = new Set<string>()
  try {
    for (const invocation of context.botRegistry.invocations.runningInvocations()) {
      if (inspected.has(invocation.targetBotId)) continue
      const session = context.runtimeBroker.findBySubject(invocation.tenantId, invocation.targetOwnerSubjectId)
      if (!session?.initialized || !session.accessToken || !context.botRegistry.getOwned(invocation.targetBotId, session.principal)) continue
      try { await assertCapability(context.capabilityGate, session.principal, PERSONAL_BOT_USE, session.accessToken) }
      catch { continue }
      inspected.add(invocation.targetBotId)
      for (const segment of context.botRegistry.getSessionThreads(invocation.targetBotId)) {
        if (!context.botRegistry.ownsThread(session.principal, invocation.targetBotId, segment.threadId)) continue
        try {
          let cursor: string | undefined
          const seen = new Set<string>()
          do {
            const revision = context.botRegistry.timeline.revision()
            const page = await context.runtimeBroker.request(session.id, "thread/turns/list", { threadId: segment.threadId, cursor, limit: 50, sortDirection: "desc", itemsView: "full" }) as ThreadTurnsListResponse
            context.botRegistry.importRuntimeHistory(invocation.targetBotId, segment.threadId, page.data, revision)
            if (page.nextCursor && seen.has(page.nextCursor)) throw new Error("BOT_HISTORY_CURSOR_STALLED")
            cursor = page.nextCursor ?? undefined
            if (cursor) seen.add(cursor)
          } while (cursor)
          reconcileTerminalInvocations(context.botRegistry)
        } catch {
          console.warn(JSON.stringify({ event: "bot.invocation.native_recovery_deferred", invocation_id: invocation.requestId, thread_id: segment.threadId }))
        }
      }
    }
  } catch {
    console.warn(JSON.stringify({ event: "bot.invocation.native_scan_deferred" }))
  } finally { reading.delete(context) }
}

export async function recoverApprovedInvocations(context: BotServerContext) {
  if (dispatching.has(context)) return
  dispatching.add(context)
  try {
    context.botRegistry.expirePendingInvocations()
    for (const invocation of context.botRegistry.invocations.approvedInvocations()) {
      if (invocation.expiresAt <= Date.now()) {
        context.botRegistry.beginInvocation(invocation.requestId)
        continue
      }
      const session = context.runtimeBroker.findBySubject(invocation.tenantId, invocation.callerSubjectId)
      if (!session?.initialized || !session.accessToken) continue
      const caller = context.botRegistry.getOwned(invocation.callerBotId, session.principal)
      if (!caller) continue
      try {
        const decision = await assertCapability(context.capabilityGate, session.principal, PERSONAL_BOT_USE, session.accessToken)
        if (decision.model_route !== caller.modelRoute) continue
        void runApprovedBotInvocation(context, invocation.requestId, session.accessToken).catch(() => {
          console.warn(JSON.stringify({ event: "bot.invocation.dispatch_deferred", invocation_id: invocation.requestId }))
        })
      } catch {
        console.warn(JSON.stringify({ event: "bot.invocation.dispatch_deferred", invocation_id: invocation.requestId }))
      }
    }
  } catch {
    console.warn(JSON.stringify({ event: "bot.invocation.dispatch_scan_deferred" }))
  } finally { dispatching.delete(context) }
}

export function reconcileTerminalInvocations(registry: BotRegistry) {
  for (const invocation of registry.invocations.runningInvocations()) {
    const turn = registry.timeline.terminalClientTurn(invocation.targetBotId, `handoff-task:${invocation.requestId}`)
    if (!turn) continue
    if (turn.status !== "completed") {
      registry.failInvocation(invocation.requestId, "TARGET_TURN_INTERRUPTED", "交接工作未完成，已保留原始記錄。請確認執行結果後再接續。")
      console.info(JSON.stringify({ event: "bot.invocation.failure_recovered", invocation_id: invocation.requestId, target_bot_id: invocation.targetBotId, turn_id: turn.id, status: turn.status }))
      continue
    }
    const summary = turn.items.flatMap((item) => item.type === "agentMessage" ? [item.text] : []).join("\n\n").trim()
    registry.completeInvocation(invocation.requestId, (summary || "對方 Bot 已完成工作，沒有文字摘要。").slice(0, 8192))
    console.info(JSON.stringify({ event: "bot.invocation.completion_recovered", invocation_id: invocation.requestId, target_bot_id: invocation.targetBotId, turn_id: turn.id }))
  }
}
