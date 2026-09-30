import type { AuditEvent, DecisionAuditEvent, GovernanceAuditEvent, IdentitySession } from "./contracts"

export function canReadTenantAudit(role?: IdentitySession["role"]) {
  return role === "TENANT_ADMINISTRATOR"
}

export function isGovernanceAuditEvent(event: { kind: string }): event is GovernanceAuditEvent {
  return event.kind === "POLICY_CHANGE" || event.kind === "ACCESS_GROUP_CHANGE" || event.kind === "ACCESS_GOVERNANCE_CHANGE"
}

export function isDecisionAuditEvent(event: AuditEvent): event is DecisionAuditEvent {
  return !isGovernanceAuditEvent(event)
}
