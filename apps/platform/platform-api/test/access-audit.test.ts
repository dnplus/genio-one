import assert from "node:assert/strict"
import test from "node:test"

import * as Value from "typebox/value"

import {
  AccessGovernanceAuditEventSchema,
  accessGovernanceAuditEvent,
  type AccessGovernanceAuditEventInput,
} from "../src/capabilities/access/audit"
import { AuthorizationAuditEventSchema } from "../src/capabilities/audit-events/contract"
import { createInMemoryGatewayAuthorizationAuditStore } from "../src/capabilities/audit-events/memory"

const base = {
  tenantId: "tenant-access",
  correlationId: "correlation-access",
  actorSubjectId: "person-approver",
  subjectId: "person-requester",
  actingClientId: "management-ui",
  resourceId: "resource-invoice",
  capabilityId: "invoice.read",
  occurredAt: 1_000,
}

test("access governance audit events cover the request lifecycle without sensitive reason text", () => {
  const cases: readonly AccessGovernanceAuditEventInput[] = [
    { ...base, operation: "CREATED", accessRequestId: "request-created", entitlementId: null },
    { ...base, operation: "DENY", accessRequestId: "request-denied", entitlementId: null },
    { ...base, operation: "APPROVE", accessRequestId: "request-approved", entitlementId: "entitlement-approved" },
    { ...base, operation: "CANCEL", accessRequestId: "request-cancelled", entitlementId: null },
    { ...base, operation: "REVOKE", accessRequestId: null, entitlementId: "entitlement-revoked" },
  ]

  for (const value of cases) {
    const event = accessGovernanceAuditEvent(value)
    assert.equal(event.kind, "ACCESS_GOVERNANCE_CHANGE")
    assert.equal(event.outcome, "SUCCESS")
    assert.equal(event.operation, value.operation)
    assert.equal(event.actor_subject.subject_id, base.actorSubjectId)
    assert.equal(event.subject.subject_id, base.subjectId)
    assert.deepEqual(event.acting_client, { acting_client_id: base.actingClientId, evidence_level: "VERIFIED" })
    assert.equal(event.access_request_id, value.accessRequestId)
    assert.equal(event.entitlement_id, value.entitlementId)
    assert.match(event.audit_event_id, /^access-governance-[a-f0-9]{64}$/)
    assert.equal(Value.Check(AccessGovernanceAuditEventSchema, event), true)
    assert.equal(Value.Check(AuthorizationAuditEventSchema, event), true)
    assert.equal(Value.Check(AccessGovernanceAuditEventSchema, { ...event, reason: "not retained" }), false)
  }

})

test("access governance audit IDs are deterministic for one event and distinct across lifecycle entities", () => {
  const created = accessGovernanceAuditEvent({
    ...base,
    operation: "CREATED",
    accessRequestId: "request-1",
    entitlementId: null,
  })
  const replay = accessGovernanceAuditEvent({
    ...base,
    operation: "CREATED",
    accessRequestId: "request-1",
    entitlementId: null,
    occurredAt: 2_000,
  })
  const secondRequest = accessGovernanceAuditEvent({
    ...base,
    operation: "CREATED",
    accessRequestId: "request-2",
    entitlementId: null,
  })
  const decision = accessGovernanceAuditEvent({
    ...base,
    operation: "DENY",
    accessRequestId: "request-1",
    entitlementId: null,
  })

  assert.equal(replay.audit_event_id, created.audit_event_id)
  assert.notEqual(secondRequest.audit_event_id, created.audit_event_id)
  assert.notEqual(decision.audit_event_id, created.audit_event_id)
})

test("access governance audit events use the unified audit store correlation query", async () => {
  const event = accessGovernanceAuditEvent({
    ...base,
    operation: "APPROVE",
    accessRequestId: "request-unified",
    entitlementId: "entitlement-unified",
  })
  const store = createInMemoryGatewayAuthorizationAuditStore()

  await store.record({ tenantId: base.tenantId, event })
  const result = await store.query({
    tenantId: base.tenantId,
    correlationId: base.correlationId,
    offset: 0,
    limit: 10,
  })

  assert.deepEqual(result.events, [event])
})
