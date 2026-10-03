import type { GatewayAuthorizationAuditStore } from "./module"
import type { AuthenticationAttemptReceipt, RuntimePolicyAuditEvent } from "./contract"
import type { PolicyAuthorizationAuditStore } from "./module"
import { canonicalJson } from "@genioone/protocol/canonical"
import { PlatformApiError } from "../errors"

export function createInMemoryGatewayAuthorizationAuditStore(): PolicyAuthorizationAuditStore {
  const events = new Map<string, Awaited<ReturnType<GatewayAuthorizationAuditStore["record"]>>>()
  const authenticationAttempts = new Map<string, AuthenticationAttemptReceipt>()
  return {
    async record({ tenantId, event }) {
      const value = { ...structuredClone(event), tenant_id: tenantId }
      const key = `${tenantId}\0${event.audit_event_id}`
      const existing = events.get(key)
      if (existing) {
        if (canonicalJson(existing) !== canonicalJson(value)) {
          throw new PlatformApiError("AUDIT_EVENT_CONFLICT", 409)
        }
        return structuredClone(existing)
      }
      events.set(key, value)
      return structuredClone(value)
    },
    async recordAuthenticationAttempt({ receipt }) {
      const existing = authenticationAttempts.get(receipt.authentication_attempt_id)
      if (existing) {
        if (canonicalJson(existing) !== canonicalJson(receipt)) {
          throw new PlatformApiError("AUTHENTICATION_ATTEMPT_CONFLICT", 409)
        }
        return structuredClone(existing)
      }
      const value = structuredClone(receipt)
      authenticationAttempts.set(receipt.authentication_attempt_id, value)
      return structuredClone(value)
    },
    async queryAuthenticationAttempts(input) {
      const matching = [...authenticationAttempts.values()]
        .filter((receipt) => !input.correlationId || receipt.correlation_id === input.correlationId)
        .filter((receipt) => !input.code || receipt.code === input.code)
        .filter((receipt) => !input.outcome || receipt.outcome === input.outcome)
        .sort((left, right) => right.occurred_at - left.occurred_at || right.authentication_attempt_id.localeCompare(left.authentication_attempt_id))
      const page = matching.slice(input.offset, input.offset + input.limit + 1)
      return {
        receipts: page.slice(0, input.limit).map((receipt) => structuredClone(receipt)),
        hasMore: page.length > input.limit,
        sourceRevision: authenticationAttempts.size,
      }
    },
    async findById({ tenantId, auditEventId }) {
      const event = events.get(`${tenantId}\0${auditEventId}`)
      return event ? structuredClone(event) : null
    },
    async query(input) {
      const matching = [...events.values()]
        .filter((event) => event.tenant_id === input.tenantId)
        .filter((event) => !input.correlationId || event.correlation_id === input.correlationId)
        .filter((event) => !input.enforcementPointId || ("enforcement_point_id" in event && event.enforcement_point_id === input.enforcementPointId))
        .filter((event) => !input.kind || event.kind === input.kind)
        .filter((event) => !input.outcome || event.outcome === input.outcome)
        .filter((event) => !input.resourceId || ("resource_id" in event && event.resource_id === input.resourceId))
        .filter((event) => !input.subjectId || (event.subject !== null && event.subject.subject_id === input.subjectId))
        .filter((event) => input.from === undefined || event.occurred_at >= input.from)
        .filter((event) => input.to === undefined || event.occurred_at <= input.to)
        .sort((left, right) => right.occurred_at - left.occurred_at || right.audit_event_id.localeCompare(left.audit_event_id))
      const page = matching.slice(input.offset, input.offset + input.limit + 1)
      return {
        events: page.slice(0, input.limit).map((event) => structuredClone(event)),
        hasMore: page.length > input.limit,
        sourceRevision: matching.length,
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
  } as PolicyAuthorizationAuditStore
}
