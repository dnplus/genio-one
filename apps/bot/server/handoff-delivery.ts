import type { BotServerContext } from "./context"
import type { GenioPrincipal } from "./runtime-broker"
import { runApprovedBotInvocation } from "./routes/invocations"

const deliveries = new WeakMap<BotServerContext, Map<string, Promise<unknown>>>()

export function deliverHandoff(context: BotServerContext, principal: GenioPrincipal, handoffId: string, accessToken?: string): Promise<unknown> {
  if (!context.botRegistry.getHandoff(principal, handoffId)) return Promise.reject(new Error("HANDOFF_NOT_FOUND"))
  let active = deliveries.get(context)
  if (!active) { active = new Map(); deliveries.set(context, active) }
  const existing = active.get(handoffId)
  if (existing) return existing
  const delivery = (async () => {
    const result = context.botRegistry.processHandoff(principal, handoffId)
    if (result.invocationId) await runApprovedBotInvocation(context, result.invocationId, accessToken)
    const invocation = result.invocationId ? context.botRegistry.getInvocationForService(result.invocationId) : null
    return { ...result, state: invocation?.state ?? result.state, reply: invocation?.state === "COMPLETED" ? invocation.resultSummary : null }
  })().finally(() => { if (active!.get(handoffId) === delivery) active!.delete(handoffId) })
  active.set(handoffId, delivery)
  return delivery
}
