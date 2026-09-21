import type { AuditEvent, DecisionAuditEvent, GovernanceAuditEvent } from "./contracts"

export function isGovernanceAuditEvent(event: { kind: string }): event is GovernanceAuditEvent {
  return event.kind === "POLICY_CHANGE" || event.kind === "ACCESS_GROUP_CHANGE"
}

export function isDecisionAuditEvent(event: AuditEvent): event is DecisionAuditEvent {
  return !isGovernanceAuditEvent(event)
}
