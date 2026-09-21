import { mergeSafetyDecisionReceipts, type SafetyDecisionReceipt } from "../../../../../../runtimes/gateway/services/shared/safety-decision"
import { PlatformApiError } from "../errors"

export * from "../../../../../../runtimes/gateway/services/shared/gateway-activity"

export const MAX_ACTIVITY_SAFETY_DECISIONS = 4096

export function boundedActivitySafetyDecisions(
  previous: readonly SafetyDecisionReceipt[],
  incoming: readonly SafetyDecisionReceipt[],
): SafetyDecisionReceipt[] {
  const merged: SafetyDecisionReceipt[] = []
  mergeSafetyDecisionReceipts(merged, previous)
  mergeSafetyDecisionReceipts(merged, incoming)
  if (merged.length > MAX_ACTIVITY_SAFETY_DECISIONS) {
    throw new PlatformApiError("SAFETY_DECISION_RECEIPT_LIMIT_EXCEEDED", 422)
  }
  return merged
}
