import assert from "node:assert/strict"
import test from "node:test"

import { createInMemoryExecutionGrantRepository } from "../src/capabilities/execution-grants/memory"
import { createExecutionGrantDirectory } from "../src/capabilities/execution-grants/module"

const now = 1_800_000_000

function directory() {
  return createExecutionGrantDirectory({
    repository: createInMemoryExecutionGrantRepository(),
    entitlements: {
      async list() {
        return [{
          tenant_id: "tenant-1",
          entitlement_id: "entitlement-1",
          subject_id: "agent-1",
          acting_client_id: "agent-client",
          resource_id: "resource-1",
          capability_id: "refund.execute",
          public_model_ids: [],
          starts_at: now - 10,
          expires_at: now + 600,
          state: "ACTIVE" as const,
          revision: 1,
          granted_by: "person-approver",
          created_at: now - 10,
          revoked_at: null,
          revocation_reason: null,
        }]
      },
    } as never,
    resources: {
      async getResource() { return { owner_organization_id: "org-owner" } },
    } as never,
    organizations: {
      async get() { return { organization_administrator_subject_ids: ["person-approver"] } },
      async accessForSubject(input: { subjectId: string }) {
        return {
          organization_ids: input.subjectId === "person-approver" ? ["org-owner"] : [],
          administrator_organization_ids: input.subjectId === "person-approver" ? ["org-owner"] : [],
        }
      },
    } as never,
    now: () => now,
    idFactory: (kind) => `execution-${kind}-1`,
  })
}

test("Human confirmation creates a bounded Execution Grant without creating another Entitlement", async () => {
  const grants = directory()
  const request = await grants.request({
    tenantId: "tenant-1",
    actor: { subjectId: "agent-1", actingClientId: "agent-client" },
    value: {
      resource_id: "resource-1",
      capability_id: "refund.execute",
      action_digest: "a".repeat(64),
      requested_expires_at: now + 300,
    },
  })
  assert.equal(request.state, "PENDING")
  assert.equal(request.execution_grant_id, null)

  const approved = await grants.decide({
    tenantId: "tenant-1",
    requestId: request.request_id,
    actor: { subjectId: "person-approver", tenantAdministrator: false },
    value: { expected_revision: 1, decision: "APPROVE", reason: "Confirmed exact refund" },
  })
  assert.equal(approved.state, "APPROVED")
  assert.equal(approved.execution_grant_id, "execution-grant-1")
  assert.equal(approved.revision, 2)
})

test("an Execution Grant request requires existing authority for the full requested window", async () => {
  const grants = directory()
  await assert.rejects(
    grants.request({
      tenantId: "tenant-1",
      actor: { subjectId: "agent-1", actingClientId: "agent-client" },
      value: {
        resource_id: "resource-1",
        capability_id: "refund.execute",
        action_digest: "b".repeat(64),
        requested_expires_at: now + 700,
      },
    }),
    /EXECUTION_GRANT_ENTITLEMENT_REQUIRED/,
  )
})

test("Resource Owner Organization administrators can list pending confirmations", async () => {
  const grants = directory()
  const request = await grants.request({
    tenantId: "tenant-1",
    actor: { subjectId: "agent-1", actingClientId: "agent-client" },
    value: {
      resource_id: "resource-1",
      capability_id: "refund.execute",
      action_digest: "c".repeat(64),
      requested_expires_at: now + 300,
    },
  })

  const ownerRequests = await grants.list({
    tenantId: "tenant-1",
    actor: { subjectId: "person-approver", tenantAdministrator: false },
  })
  const unrelatedRequests = await grants.list({
    tenantId: "tenant-1",
    actor: { subjectId: "person-unrelated", tenantAdministrator: false },
  })

  assert.deepEqual(ownerRequests, [request])
  assert.deepEqual(unrelatedRequests, [])
})
