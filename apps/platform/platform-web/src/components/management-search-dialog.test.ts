import { expect, test } from "bun:test"

import { auditSearchText } from "./management-search-dialog"

test("audit search text accepts governance records without runtime-only fields", () => {
  const policy = auditSearchText({
    audit_event_id: "policy-change-1",
    correlation_id: "policy-correlation",
    kind: "POLICY_CHANGE",
    outcome: "SUCCESS",
    subject: { subject_id: "admin", evidence_level: "VERIFIED" },
    actor_subject: { subject_id: "admin", evidence_level: "VERIFIED" },
    tenant_id: "test",
    policy_key: "policy",
    action: "DRAFT_SAVED",
    policy_draft_version: 1,
    base_revision: 0,
    published_revision: null,
    lifecycle: "DRAFT",
    content_digest: "a".repeat(64),
    occurred_at: 1,
  })
  const accessGroup = auditSearchText({
    audit_event_id: "access-group-change-1",
    correlation_id: "group-correlation",
    kind: "ACCESS_GROUP_CHANGE",
    outcome: "SUCCESS",
    subject: { subject_id: "admin", evidence_level: "VERIFIED" },
    actor_subject: { subject_id: "admin", evidence_level: "VERIFIED" },
    tenant_id: "test",
    access_group_id: "group",
    operation: "MEMBERS_REPLACED",
    before_revision: 1,
    after_revision: 2,
    occurred_at: 1,
  })
  const accessGovernance = auditSearchText({
    audit_event_id: "access-governance-change-1",
    correlation_id: "access-correlation",
    kind: "ACCESS_GOVERNANCE_CHANGE",
    outcome: "SUCCESS",
    subject: { subject_id: "anrita", evidence_level: "VERIFIED" },
    actor_subject: { subject_id: "kevin", evidence_level: "VERIFIED" },
    acting_client: { acting_client_id: "client-self-service", evidence_level: "VERIFIED" },
    tenant_id: "test",
    resource_id: "resource-access",
    capability_id: "capability-access",
    access_request_id: "request-access",
    entitlement_id: null,
    operation: "APPROVE",
    occurred_at: 1,
  })
  expect(policy).toContain("policy-change")
  expect(accessGroup).toContain("access_group_change")
  expect(accessGovernance).toContain("resource-access")
  expect(accessGovernance).toContain("capability-access")
  expect(accessGovernance).toContain("access-correlation")
})
