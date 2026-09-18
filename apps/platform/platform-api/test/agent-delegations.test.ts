import assert from "node:assert/strict"
import test from "node:test"

import { PlatformApiError } from "../src/capabilities/errors"
import { createInMemoryIdentityDirectory } from "../src/capabilities/identity/memory"
import { createInMemoryModelEntitlementCatalog } from "../src/capabilities/entitlements/memory"
import { createInMemoryAgentDelegationRepository } from "../src/capabilities/agent-delegations/memory"
import { createAgentDelegationDirectory } from "../src/capabilities/agent-delegations/module"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createManagementApi } from "../src/app"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"

function code(error: unknown) {
  return error instanceof PlatformApiError ? error.code : null
}

async function fixture() {
  const now = () => 1_000
  const identity = createInMemoryIdentityDirectory()
  await identity.bootstrap({
    tenantId: "tenant-1",
    subjects: [{
      subject_id: "person-principal",
      kind: "PERSON",
      display_name: "Principal",
      external_identities: [],
    }],
  })
  await identity.create({
    tenantId: "tenant-1",
    value: { subject_id: "agent-worker", kind: "AGENT", display_name: "Worker" },
  })
  const entitlements = createInMemoryModelEntitlementCatalog({ now })
  for (const subjectId of ["person-principal", "agent-worker"]) {
    await entitlements.grant({
      tenantId: "tenant-1",
      value: {
        subject_id: subjectId,
        resource_id: "resource-support",
        capability_id: "ticket.read",
        public_model_id: null,
        starts_at: 900,
        expires_at: 2_000,
      },
    })
  }
  const directory = createAgentDelegationDirectory({
    repository: createInMemoryAgentDelegationRepository(),
    identity,
    entitlements,
    now,
    idFactory: () => "delegation-1",
  })
  return { directory, entitlements }
}

test("delegated authority is bounded by both Principal and Agent Entitlements", async () => {
  const { directory } = await fixture()
  const delegation = await directory.create({
    tenantId: "tenant-1",
    actor: { subjectId: "person-principal", tenantAdministrator: false },
    value: {
      principal_subject_id: "person-principal",
      agent_subject_id: "agent-worker",
      resource_id: "resource-support",
      capability_ids: ["ticket.read"],
      acting_client_ids: ["agent-runtime"],
      expires_at: 1_500,
    },
  })
  assert.equal(delegation.state, "ACTIVE")
  assert.equal(delegation.revocation_generation, 0)

  await assert.rejects(directory.create({
    tenantId: "tenant-1",
    actor: { subjectId: "person-principal", tenantAdministrator: false },
    value: {
      principal_subject_id: "person-principal",
      agent_subject_id: "agent-worker",
      resource_id: "resource-support",
      capability_ids: ["ticket.delete"],
      acting_client_ids: ["agent-runtime"],
      expires_at: 1_500,
    },
  }), (error: unknown) => code(error) === "AGENT_DELEGATION_AUTHORITY_EXCEEDS_ENTITLEMENT")
  await assert.rejects(directory.create({
    tenantId: "tenant-1",
    actor: { subjectId: "person-principal", tenantAdministrator: false },
    value: {
      principal_subject_id: "person-principal",
      agent_subject_id: "agent-worker",
      resource_id: "resource-support",
      capability_ids: ["ticket.read", "ticket.read"],
      acting_client_ids: ["agent-runtime"],
      expires_at: 1_500,
    },
  }), (error: unknown) => code(error) === "AGENT_DELEGATION_BOUNDS_INVALID")
})

test("revocation is monotonic and only the Principal or Tenant Administrator can advance it", async () => {
  const { directory } = await fixture()
  const active = await directory.create({
    tenantId: "tenant-1",
    actor: { subjectId: "person-principal", tenantAdministrator: false },
    value: {
      principal_subject_id: "person-principal",
      agent_subject_id: "agent-worker",
      resource_id: "resource-support",
      capability_ids: ["ticket.read"],
      acting_client_ids: ["agent-runtime"],
      expires_at: 1_500,
    },
  })
  await assert.rejects(directory.revoke({
    tenantId: "tenant-1",
    delegationId: active.delegation_id,
    expectedRevision: 1,
    actor: { subjectId: "agent-worker", tenantAdministrator: false },
  }), (error: unknown) => code(error) === "AGENT_DELEGATION_ACTOR_DENIED")
  const revoked = await directory.revoke({
    tenantId: "tenant-1",
    delegationId: active.delegation_id,
    expectedRevision: 1,
    actor: { subjectId: "person-principal", tenantAdministrator: false },
  })
  assert.equal(revoked.state, "REVOKED")
  assert.equal(revoked.revision, 2)
  assert.equal(revoked.revocation_generation, 1)
})

test("Agent Delegation HTTP uses the authenticated Principal and never accepts a body actor", async () => {
  const modules = createInMemoryPlatformModules({ now: () => 1_000 })
  await modules.identity.bootstrap({
    tenantId: "tenant-1",
    subjects: [{
      subject_id: "person-principal",
      kind: "PERSON",
      display_name: "Principal",
      external_identities: [],
    }],
  })
  await modules.identity.create({
    tenantId: "tenant-1",
    value: { subject_id: "agent-worker", kind: "AGENT", display_name: "Worker" },
  })
  for (const subjectId of ["person-principal", "agent-worker"]) {
    await modules.entitlements.grant({
      tenantId: "tenant-1",
      value: {
        subject_id: subjectId,
        resource_id: "resource-support",
        capability_id: "ticket.read",
        starts_at: 900,
        expires_at: 2_000,
      },
    })
  }
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      principal: {
        tenant_id: "tenant-1",
        subject_id: "person-principal",
        client_id: "console",
        role: "USER",
        organization_ids: [],
      },
      agent: {
        tenant_id: "tenant-1",
        subject_id: "agent-worker",
        client_id: "agent-runtime",
        role: "USER",
        organization_ids: [],
      },
      outsider: {
        tenant_id: "tenant-1",
        subject_id: "person-outsider",
        client_id: "console",
        role: "USER",
        organization_ids: [],
      },
    }),
  })
  const response = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-1/agent-delegations",
    headers: { authorization: "Bearer principal" },
    payload: {
      principal_subject_id: "person-principal",
      agent_subject_id: "agent-worker",
      resource_id: "resource-support",
      capability_ids: ["ticket.read"],
      acting_client_ids: ["agent-runtime"],
      expires_at: 1_500,
    },
  })
  assert.equal(response.statusCode, 201, response.body)
  assert.equal(response.json().created_by_subject_id, "person-principal")
  assert.equal("actor_subject_id" in response.json(), false)
  for (const token of ["principal", "agent"]) {
    const visible = await app.inject({
      method: "GET",
      url: "/v1/tenants/tenant-1/agent-delegations",
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(visible.statusCode, 200)
    assert.equal(visible.json().length, 1)
  }
  const hidden = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-1/agent-delegations",
    headers: { authorization: "Bearer outsider" },
  })
  assert.equal(hidden.statusCode, 200)
  assert.deepEqual(hidden.json(), [])
  await app.close()
})
