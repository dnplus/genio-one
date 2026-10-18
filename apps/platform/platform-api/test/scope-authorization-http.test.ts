import assert from "node:assert/strict"
import test from "node:test"
import { GENIOONE_SCOPES, MANAGEMENT_SCOPES } from "@genioone/protocol/authorization-scopes"
import { createManagementApi } from "../src/app"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"

const tenantId = "tenant-scope-boundary"
const base = { tenant_id: tenantId, subject_id: "person-admin", role: "TENANT_ADMINISTRATOR" as const, organization_ids: [], client_id: "explicit-client" }

test("HTTP Resource publication evaluates parsed lifecycle before accepting write scopes", async () => {
  const modules = createInMemoryPlatformModules()
  const organization = await modules.organizations.create({ tenantId, display_name: "Dedicated scope test" })
  const resource = await modules.resources.createResource({ tenantId, value: {
    display_name: "Dedicated extension", kind: "EXTENSION", owner_organization_id: organization.organization_id,
    authentication_strategy: "OAUTH", environment_id: "test", version: "1.0.0", capabilities: [], enforcement_point_id: "test",
  } })
  const app = await createManagementApi({ modules, resourceCatalog: modules.resources, principalAuthenticator: createStaticPrincipalAuthenticator({
    read: { ...base, scopes: [MANAGEMENT_SCOPES.resourcesRead] },
    write: { ...base, scopes: [GENIOONE_SCOPES.read, GENIOONE_SCOPES.write, MANAGEMENT_SCOPES.resourcesWrite] },
    publish: { ...base, scopes: [MANAGEMENT_SCOPES.policiesPublish] },
  }) })
  try {
    for (const token of ["read", "write"]) {
      const response = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/resources/${resource.resource_id}/lifecycle`, headers: { authorization: `Bearer ${token}` }, payload: { lifecycle: "PUBLISHED" } })
      assert.equal(response.statusCode, 403, response.body)
      assert.equal(response.json().code, "INSUFFICIENT_SCOPE")
      assert.equal((await modules.resources.getResource({ tenantId, resourceId: resource.resource_id })).lifecycle, "DRAFT")
    }
    const deniedAudits = await modules.auditEvents.query({ tenantId, kind: "MANAGEMENT_AUTHORIZATION", outcome: "DENY", offset: 0, limit: 10 })
    assert.equal(deniedAudits.events.length, 2)
    for (const event of deniedAudits.events) {
      assert.equal(event.kind, "MANAGEMENT_AUTHORIZATION")
      if (event.kind !== "MANAGEMENT_AUTHORIZATION") continue
      assert.equal(event.code, "INSUFFICIENT_SCOPE")
      assert.equal(event.subject.subject_id, base.subject_id)
      assert.equal(event.request_context.requested_tenant_id, tenantId)
      assert.equal(event.request_context.target.resource_id, resource.resource_id)
    }
    const published = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/resources/${resource.resource_id}/lifecycle`, headers: { authorization: "Bearer publish" }, payload: { lifecycle: "PUBLISHED" } })
    assert.equal(published.statusCode, 200, published.body)
    assert.equal(published.json().lifecycle, "PUBLISHED")
  } finally {
    await app.close()
  }
})

test("HTTP scope checks reject missing or legacy scopes before a management mutation", async () => {
  const modules = createInMemoryPlatformModules()
  const app = await createManagementApi({ modules, resourceCatalog: modules.resources, principalAuthenticator: createStaticPrincipalAuthenticator({
    missing: base,
    legacy: { ...base, scopes: ["genioone-management"] },
    general: { ...base, scopes: [GENIOONE_SCOPES.read, GENIOONE_SCOPES.write, GENIOONE_SCOPES.invoke] },
    write: { ...base, scopes: [MANAGEMENT_SCOPES.identityWrite] },
  }) })
  try {
    for (const token of ["missing", "legacy", "general"]) {
      const denied = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/organizations`, headers: { authorization: `Bearer ${token}` }, payload: { display_name: "Denied" } })
      assert.equal(denied.statusCode, 403, denied.body)
      assert.equal(denied.json().code, "INSUFFICIENT_SCOPE")
    }
    const accepted = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/organizations`, headers: { authorization: "Bearer write" }, payload: { display_name: "Explicit grant" } })
    assert.equal(accepted.statusCode, 201, accepted.body)
  } finally {
    await app.close()
  }
})


test("HTTP Usage Policy revisions require publish scope because every state affects the selected revision", async () => {
  const modules = createInMemoryPlatformModules()
  const organization = await modules.organizations.create({ tenantId, display_name: "Usage policy scope test" })
  const app = await createManagementApi({ modules, resourceCatalog: modules.resources, principalAuthenticator: createStaticPrincipalAuthenticator({
    write: { ...base, scopes: [MANAGEMENT_SCOPES.policiesWrite] },
    publish: { ...base, scopes: [MANAGEMENT_SCOPES.policiesPublish] },
  }) })
  const value = { usage_policy_id: "dedicated-budget", revision: 1, owner_organization_id: organization.organization_id,
    accounting_key_id: "dedicated-account", selectors: { consumer_organization_id: organization.organization_id },
    limits: { request_quota: { limit: 10, window_seconds: 60 } }, state: "ACTIVE" as const }
  await modules.usageGovernance.createPolicyRevision({ ...value, tenant_id: tenantId, created_at: 1 })
  try {
    for (const state of ["ACTIVE", "RETIRED", "DRAFT"]) {
      const denied = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/usage-policies`, headers: { authorization: "Bearer write" }, payload: { ...value, revision: 2, state } })
      assert.equal(denied.statusCode, 403, denied.body)
      assert.equal(denied.json().code, "INSUFFICIENT_SCOPE")
      assert.equal((await modules.usageGovernance.listActivePolicies({ tenant_id: tenantId }))[0]?.revision, 1)
    }
    const retired = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/usage-policies`, headers: { authorization: "Bearer publish" }, payload: { ...value, revision: 2, state: "RETIRED" } })
    assert.equal(retired.statusCode, 201, retired.body)
    assert.deepEqual(await modules.usageGovernance.listActivePolicies({ tenant_id: tenantId }), [])
  } finally {
    await app.close()
  }
})


test("Unrelated management scopes never grant tenant-wide workspace visibility", async () => {
  const modules = createInMemoryPlatformModules()
  const workspace = await modules.distillation.createWorkspace({ tenantId, createdBy: "dedicated-owner", value: {
    organization_id: "dedicated-org", display_name: "Dedicated private workspace", reader_access_group_id: "private-readers",
    contributor_access_group_id: "private-contributors", maintainer_access_group_id: "private-maintainers",
  } })
  const app = await createManagementApi({ modules, resourceCatalog: modules.resources, principalAuthenticator: createStaticPrincipalAuthenticator({
    identity: { ...base, scopes: [GENIOONE_SCOPES.read, MANAGEMENT_SCOPES.identityRead] },
    resources: { ...base, scopes: [GENIOONE_SCOPES.read, MANAGEMENT_SCOPES.resourcesRead] },
  }) })
  try {
    const unrelated = await app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/team-workspaces`, headers: { authorization: "Bearer identity" } })
    assert.equal(unrelated.statusCode, 200, unrelated.body)
    assert.deepEqual(unrelated.json(), [])
    const denied = await app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/team-workspaces/${workspace.workspace_id}`, headers: { authorization: "Bearer identity" } })
    assert.equal(denied.statusCode, 403, denied.body)
    const managed = await app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/team-workspaces`, headers: { authorization: "Bearer resources" } })
    assert.equal(managed.statusCode, 200, managed.body)
    assert.equal(managed.json()[0]?.workspace_id, workspace.workspace_id)
  } finally {
    await app.close()
  }
})

test("Encoded opaque capability IDs preserve tenant authentication and scope enforcement", async () => {
  const modules = createInMemoryPlatformModules()
  const organization = await modules.organizations.create({ tenantId, display_name: "Encoded identifier test" })
  const resource = await modules.resources.createResource({ tenantId, value: {
    display_name: "Encoded identifier service", kind: "LLM", owner_organization_id: organization.organization_id,
    authentication_strategy: "OAUTH", environment_id: "test", version: "1.0.0",
    capabilities: [{ capability_id: "chat/read", display_name: "Chat read" }], enforcement_point_id: "test",
  } })
  await modules.enforcementRevisionStore.save({ tenantId, chain: {
    chain_id: "encoded-capability-chain", tenant_id: tenantId, resource_id: resource.resource_id, capability_id: "chat/read",
    eligible_connection_ids: ["private-connection"], one_policy_revision: 1,
    steps: [
      { step_id: "authenticate", kind: "AUTHENTICATE", phase: "REQUEST", implementation: "NATIVE", config: {
        schema_version: "genio.one.auth.jwt.v1", provider: "keycloak", issuer: "https://identity.test/realms/scope-test",
        audiences: ["genio-one-product-api"], remote_jwks_uri: "https://identity.test/realms/scope-test/protocol/openid-connect/certs",
        subject_claim: "sub", client_claim: "azp",
      } },
      { step_id: "authorize", kind: "AUTHORIZE", phase: "REQUEST", implementation: "EXT_AUTH", depends_on: ["authenticate"] },
      { step_id: "route", kind: "ROUTE", phase: "ROUTING", implementation: "AIGW_NATIVE", depends_on: ["authorize"] },
    ], request_filter_order: ["authorize"], response_filter_order: [],
  } })
  const app = await createManagementApi({ modules, resourceCatalog: modules.resources, principalAuthenticator: createStaticPrincipalAuthenticator({
    general: { ...base, scopes: [GENIOONE_SCOPES.read] },
    policy: { ...base, scopes: [MANAGEMENT_SCOPES.policiesRead] },
  }) })
  const url = `/v1/tenants/${tenantId}/resources/${resource.resource_id}/capabilities/${encodeURIComponent("chat/read")}/enforcement-chain`
  try {
    const anonymous = await app.inject({ method: "GET", url })
    assert.equal(anonymous.statusCode, 401, anonymous.body)
    assert.equal(anonymous.json().code, "UNAUTHENTICATED")
    const unrelated = await app.inject({ method: "GET", url, headers: { authorization: "Bearer general" } })
    assert.equal(unrelated.statusCode, 403, unrelated.body)
    assert.equal(unrelated.json().code, "INSUFFICIENT_SCOPE")
    const authorized = await app.inject({ method: "GET", url, headers: { authorization: "Bearer policy" } })
    assert.equal(authorized.statusCode, 200, authorized.body)
    assert.equal(authorized.json().capability_id, "chat/read")
  } finally {
    await app.close()
  }
})
