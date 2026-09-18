import type { GatewayAuthorizationAuditStore } from "./module"
import type { RuntimePolicyAuditEvent } from "../one-policy/runtime"

export function createInMemoryGatewayAuthorizationAuditStore(): GatewayAuthorizationAuditStore {
  const events = new Map<string, Awaited<ReturnType<GatewayAuthorizationAuditStore["record"]>>>()
  return {
    async record({ tenantId, event }) {
      const value = { ...structuredClone(event), tenant_id: tenantId }
      events.set(`${tenantId}\0${event.audit_event_id}`, value)
      return structuredClone(value)
    },
    async query(input) {
      const matching = [...events.values()]
        .filter((event) => event.tenant_id === input.tenantId)
        .filter((event) => !input.correlationId || event.correlation_id === input.correlationId)
        .filter((event) => !input.enforcementPointId || ("enforcement_point_id" in event && event.enforcement_point_id === input.enforcementPointId))
        .filter((event) => !input.kind || event.kind === input.kind)
        .filter((event) => !input.outcome || event.outcome === input.outcome)
        .filter((event) => !input.resourceId || ("resource_id" in event && event.resource_id === input.resourceId))
        .filter((event) => !input.subjectId || event.subject.subject_id === input.subjectId)
        .filter((event) => input.from === undefined || event.occurred_at >= input.from)
        .filter((event) => input.to === undefined || event.occurred_at <= input.to)
        .sort((left, right) => right.occurred_at - left.occurred_at || right.audit_event_id.localeCompare(left.audit_event_id))
      const page = matching.slice(input.offset, input.offset + input.limit + 1)
      return {
        events: page.slice(0, input.limit).map((event) => structuredClone(event)),
        hasMore: page.length > input.limit,
        sourceRevision: [...events.values()].filter((event) => event.tenant_id === input.tenantId).length,
      }
    },
    async findRuntimeAuthorization({ tenantId, correlationId }) {
      const value = [...events.values()]
        .filter((event): event is RuntimePolicyAuditEvent => event.tenant_id === tenantId && event.kind === "RUNTIME_POLICY_DECISION")
        .filter((event) => event.correlation_id === correlationId && event.phase === "AUTHORIZE")
        .sort((left, right) => right.occurred_at - left.occurred_at)[0]
      return value ? structuredClone(value) : null
    },
    async findRuntimeReport({ tenantId, correlationId }) {
      const value = [...events.values()]
        .filter((event): event is RuntimePolicyAuditEvent => event.tenant_id === tenantId && event.kind === "RUNTIME_POLICY_DECISION")
        .filter((event) => event.correlation_id === correlationId && event.phase === "REPORT")
        .sort((left, right) => right.occurred_at - left.occurred_at)[0]
      return value ? structuredClone(value) : null
    },
  }
}
