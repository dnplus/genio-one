import { expect, test } from "bun:test"

import { auditSearchText } from "./management-search-dialog"

test("audit search text accepts POLICY_CHANGE and ACCESS_GROUP_CHANGE records without runtime-only fields", () => {
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
  expect(policy).toContain("policy-change")
  expect(accessGroup).toContain("access_group_change")
})
