import type { RuntimeSession } from "./runtime-broker"
import { requireRuntimePolicyDecision } from "./runtime-policy"
import { RUNTIME_POLICY_RUNTIME_ID, type RuntimePolicyCapabilityId, type RuntimePolicyDecision, type RuntimePolicyResolver } from "./runtime-policy-contract"

export function createRuntimePolicyLifecycle(options: {
  policy: RuntimePolicyResolver
  accessToken: () => string | null
  onReportFailure: () => void
}) {
  const report = async (
    session: RuntimeSession,
    botId: string,
    decision: RuntimePolicyDecision,
    outcome: "ALLOW" | "DENY" | "COMPLETED" | "FAILED",
    reasonCode?: string,
    isCurrent: () => boolean = () => true,
  ): Promise<boolean> => {
    if (!decision.correlation_id) {
      console.warn(JSON.stringify({
        event: "runtime.policy.report_skipped",
        reason: "RUNTIME_POLICY_CORRELATION_MISSING",
        capability_id: decision.capability_id,
        action: decision.action,
        bot_id: botId,
        outcome,
      }))
      if (isCurrent()) options.onReportFailure()
      return false
    }
    try {
      await options.policy.report({
        principal: session.principal,
        botId,
        runtimeId: RUNTIME_POLICY_RUNTIME_ID,
        capabilityId: decision.capability_id,
        action: decision.action,
        sessionId: session.id,
        accessToken: options.accessToken() ?? session.accessToken,
        correlationId: decision.correlation_id,
        outcome,
        ...(reasonCode ? { reasonCode } : {}),
      })
    } catch (error) {
      console.warn(JSON.stringify({
        event: "runtime.policy.report_failed",
        reason: error instanceof Error ? error.message : "RUNTIME_POLICY_REPORT_UNAVAILABLE",
        correlation_id: decision.correlation_id,
        capability_id: decision.capability_id,
        action: decision.action,
        bot_id: botId,
        outcome,
      }))
      if (isCurrent()) options.onReportFailure()
      return false
    }
    return true
  }

  const authorize = async (
    session: RuntimeSession,
    botId: string,
    capabilityId: RuntimePolicyCapabilityId,
    action: "expose" | "invoke" | "use",
    isCurrent: () => boolean = () => true,
  ) => {
    const input = {
      principal: session.principal,
      botId,
      runtimeId: RUNTIME_POLICY_RUNTIME_ID,
      capabilityId,
      action,
      sessionId: session.id,
      accessToken: options.accessToken() ?? session.accessToken,
    } as const
    return options.policy.authorize(input).then(async (decision) => {
      try {
        return requireRuntimePolicyDecision(decision)
      } catch (error) {
        await report(session, botId, decision, "DENY", error instanceof Error ? error.message : "RUNTIME_POLICY_DENIED", isCurrent)
        throw error
      }
    })
  }

  return { authorize, report }
}
