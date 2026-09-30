import assert from "node:assert/strict"
import test from "node:test"

import type { GatewayAuthorizationAuditIngest } from "../src/capabilities/audit-events/contract"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import {
  createSecurityFindingJournal,
  REVOKED_AUTHORITY_CONTINUED_USE,
} from "../src/capabilities/security-findings/journal"

function decision(input: {
  auditEventId: string
  entitlementId: string
  occurredAt: number
  upstreamAttempted: boolean
  subjectId?: string
}): GatewayAuthorizationAuditIngest {
  return {
    audit_event_id: input.auditEventId,
    correlation_id: `correlation-${input.auditEventId}`,
    kind: "ONE_POLICY_DECISION",
    outcome: "ALLOW",
    subject: { subject_id: input.subjectId ?? "person-a", evidence_level: "VERIFIED" },
    target_subject_id: null,
    actor_subject: null,
    acting_client: { acting_client_id: "client-a", evidence_level: "VERIFIED" },
    resource_id: "resource-ai",
    capability_id: "llm.invoke",
    device_id: null,
    endpoint_version: null,
    desired_state_revision: null,
    applied_state_revision: null,
    applied_policy_version: "policy-1",
    policy_proposal_id: null,
    proposed_policy_version: null,
    access_group_id: null,
    destination_host: null,
    routing_policy_rule_id: null,
    route: "MANAGED",
    missing_deployment_capability: null,
    decision: {
      decision_id: `decision-${input.auditEventId}`,
      correlation_id: `correlation-${input.auditEventId}`,
      policy_version: "policy-1",
      winning_rule_id: null,
      reason: "ALLOWED_BY_RULE",
      visibility: "VISIBLE",
      access: "ENTITLED",
      route: "MANAGED",
      obligations: [],
      entitlement_conditions: {
        required_verified_acting_client_id: null,
        requires_device: false,
      },
      entitlement_id: input.entitlementId,
      auto_grant_valid_for: null,
      input_receipt: { requested_model_id: null, effective_model_id: null },
      agent_authority: null,
    },
    access_request_id: null,
    entitlement_id: input.entitlementId,
    enforcement_point_id: "AI_GATEWAY",
    obligation_kind: null,
    runaway_trigger: null,
    upstream_attempted: input.upstreamAttempted,
    occurred_at: input.occurredAt,
  }
}

test("revoked credential generation use opens one deduplicated finding", () => {
  const journal = createSecurityFindingJournal()
  journal.recordRevocation({
    tenantId: "tenant-a",
    authority: { kind: "CREDENTIAL_GENERATION", credential_id: "cred-1", generation: 2 },
    revokedAt: 2_000,
    subjectId: "app-subject",
  })

  assert.equal(journal.observeUse({
    tenantId: "tenant-a",
    subjectId: "app-subject",
    occurredAt: 1_500,
    auditEventId: "before",
    correlationId: "before",
    upstreamAttempted: true,
    authority: { kind: "CREDENTIAL_GENERATION", credential_id: "cred-1", generation: 2 },
  }), null)
  assert.equal(journal.observeUse({
    tenantId: "tenant-a",
    subjectId: "app-subject",
    occurredAt: 2_500,
    auditEventId: "other-generation",
    correlationId: "other-generation",
    upstreamAttempted: true,
    authority: { kind: "CREDENTIAL_GENERATION", credential_id: "cred-1", generation: 3 },
  }), null)

  const opened = journal.observeUse({
    tenantId: "tenant-a",
    subjectId: "app-subject",
    occurredAt: 2_500,
    auditEventId: "use-1",
    correlationId: "corr-1",
    upstreamAttempted: false,
    authority: { kind: "CREDENTIAL_GENERATION", credential_id: "cred-1", generation: 2 },
  })
  const repeated = journal.observeUse({
    tenantId: "tenant-a",
    subjectId: "app-subject",
    occurredAt: 2_800,
    auditEventId: "use-2",
    correlationId: "corr-2",
    upstreamAttempted: true,
    authority: { kind: "CREDENTIAL_GENERATION", credential_id: "cred-1", generation: 2 },
  })
  journal.observeUse({
    tenantId: "tenant-a",
    subjectId: "app-subject",
    occurredAt: 2_800,
    auditEventId: "use-2",
    correlationId: "corr-2",
    upstreamAttempted: true,
    authority: { kind: "CREDENTIAL_GENERATION", credential_id: "cred-1", generation: 2 },
  })

  assert.equal(opened?.rule_id, REVOKED_AUTHORITY_CONTINUED_USE)
  assert.equal(opened?.severity, "HIGH")
  assert.equal(repeated?.finding_id, opened?.finding_id)
  assert.equal(repeated?.status, "OPEN")
  assert.equal(repeated?.evidence.use_count, 2)
  assert.equal(repeated?.evidence.upstream_attempted, true)
  assert.deepEqual(journal.list("tenant-b"), [])
})

test("gateway audit after entitlement revoke is acknowledged, closed, and reopened", async () => {
  let clock = 1_000
  const modules = createInMemoryPlatformModules({ now: () => clock })
  const entitlement = await modules.entitlements.grant({
    tenantId: "tenant-a",
    value: {
      subject_id: "person-a",
      resource_id: "resource-ai",
      capability_id: "llm.invoke",
    },
  })

  await modules.auditEvents.record({
    tenantId: "tenant-a",
    event: decision({
      auditEventId: "before-revoke",
      entitlementId: entitlement.entitlement_id,
      occurredAt: clock,
      upstreamAttempted: true,
    }),
  })
  clock = 2_000
  await modules.entitlements.revoke({
    tenantId: "tenant-a",
    entitlementId: entitlement.entitlement_id,
  })
  await modules.auditEvents.record({
    tenantId: "tenant-a",
    event: decision({
      auditEventId: "at-revoke",
      entitlementId: entitlement.entitlement_id,
      occurredAt: clock,
      upstreamAttempted: true,
    }),
  })
  clock = 3_000
  await modules.auditEvents.record({
    tenantId: "tenant-a",
    event: decision({
      auditEventId: "after-revoke",
      entitlementId: entitlement.entitlement_id,
      occurredAt: clock,
      upstreamAttempted: false,
    }),
  })
  await modules.auditEvents.record({
    tenantId: "tenant-a",
    event: decision({
      auditEventId: "after-revoke-again",
      entitlementId: entitlement.entitlement_id,
      occurredAt: clock + 10,
      upstreamAttempted: false,
      subjectId: "person-b",
    }),
  })

  const open = modules.securityFindings.list("tenant-a")
  assert.equal(open.length, 2)
  assert.equal(open.every((finding) => finding.status === "OPEN"), true)

  const personA = open.find((finding) => finding.subject_id === "person-a")
  assert.ok(personA)
  assert.equal(personA.evidence.use_count, 1)
  assert.equal(personA.evidence.upstream_attempted, false)
  assert.deepEqual(personA.authority, {
    kind: "ENTITLEMENT",
    entitlement_id: entitlement.entitlement_id,
  })

  const acknowledged = modules.securityFindings.acknowledge({
    tenantId: "tenant-a",
    findingId: personA.finding_id,
    at: 3_100,
  })
  clock = 3_200
  await modules.auditEvents.record({
    tenantId: "tenant-a",
    event: decision({
      auditEventId: "while-acknowledged",
      entitlementId: entitlement.entitlement_id,
      occurredAt: clock,
      upstreamAttempted: true,
    }),
  })
  const stillOne = modules.securityFindings.list("tenant-a").filter((finding) => finding.subject_id === "person-a")
  assert.equal(stillOne.length, 1)
  assert.equal(stillOne[0]?.status, "ACKNOWLEDGED")
  assert.equal(stillOne[0]?.evidence.use_count, 2)
  assert.equal(acknowledged.status, "ACKNOWLEDGED")

  modules.securityFindings.close({
    tenantId: "tenant-a",
    findingId: personA.finding_id,
    at: 3_300,
  })
  clock = 3_400
  await modules.auditEvents.record({
    tenantId: "tenant-a",
    event: decision({
      auditEventId: "after-close",
      entitlementId: entitlement.entitlement_id,
      occurredAt: clock,
      upstreamAttempted: true,
    }),
  })
  const personAFindings = modules.securityFindings.list("tenant-a")
    .filter((finding) => finding.subject_id === "person-a")
  assert.deepEqual(personAFindings.map((finding) => finding.status), ["OPEN", "CLOSED"])
})
