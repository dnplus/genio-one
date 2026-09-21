import assert from "node:assert/strict"
import test from "node:test"

import { createManagementApi } from "../src/app"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createDefaultOnePolicy, PERSONAL_BOT_RESOURCE } from "../src/capabilities/one-policy/default"
import type { ResourceConnectionRegistry } from "../src/capabilities/connections/module"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"

const tenantId = "tenant-acme"

function selfServiceConnectionRegistry(
  modules: ReturnType<typeof createInMemoryPlatformModules>,
  lifecycle: () => "ENABLED" | "DISABLED",
): ResourceConnectionRegistry {
  return {
    ...modules.connections,
    async list(input) {
      if (input.tenantId === tenantId && input.resourceId === PERSONAL_BOT_RESOURCE) {
        return [{
          tenant_id: tenantId,
          connection_id: PERSONAL_BOT_RESOURCE,
          resource_id: PERSONAL_BOT_RESOURCE,
          lifecycle: lifecycle(),
        } as never]
      }
      return modules.connections.list(input)
    },
  }
}

async function createApp(lifecycle: () => "ENABLED" | "DISABLED", identityLookupFails = false) {
  const modules = createInMemoryPlatformModules()
  await modules.identity.bootstrap({
    tenantId,
    subjects: [
      { subject_id: "person-user", kind: "PERSON", role: "USER" },
      { subject_id: "person-second", kind: "PERSON", role: "USER" },
    ],
  })
  await modules.identity.bootstrap({
    tenantId: "tenant-other",
    subjects: [{ subject_id: "person-other", kind: "PERSON", role: "USER" }],
  })
  const botAccessPolicy = createDefaultOnePolicy({ policyAuditSink: modules.auditEvents })
  await botAccessPolicy.publishFirstPartyBotPolicy({
    tenantId,
    baseRevision: 1,
    rules: { allowed_roles: ["USER"], allowed_subject_ids: [] },
    publishedBy: "test-admin",
  })
  const connections = selfServiceConnectionRegistry(modules, lifecycle)
  const identity = identityLookupFails
    ? { ...modules.identity, async inventory() { throw new Error("IDENTITY_LOOKUP_FAILED") } }
    : modules.identity
  const app = await createManagementApi({
    modules: { ...modules, connections, identity, botAccessPolicy },
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      user: {
        tenant_id: tenantId,
        subject_id: "person-user",
        role: "USER",
        organization_ids: [],
        client_id: "genio-one-bot",
        scopes: ["genioone-management", "genioone-invocation"],
      },
      secondUser: {
        tenant_id: tenantId,
        subject_id: "person-second",
        role: "USER",
        organization_ids: [],
        client_id: "genio-one-bot",
        scopes: ["genioone-management", "genioone-invocation"],
      },
      otherTenantUser: {
        tenant_id: "tenant-other",
        subject_id: "person-other",
        role: "USER",
        organization_ids: [],
        client_id: "genio-one-bot",
        scopes: ["genioone-management", "genioone-invocation"],
      },
      agentUser: {
        tenant_id: tenantId,
        subject_id: "agent-existing",
        role: "USER",
        organization_ids: [],
        client_id: "genio-one-bot",
        scopes: ["genioone-management", "genioone-invocation"],
      },
      applicationUser: {
        tenant_id: tenantId,
        subject_id: "application-existing",
        role: "USER",
        organization_ids: [],
        client_id: "genio-one-bot",
        scopes: ["genioone-management", "genioone-invocation"],
      },
      unregisteredUser: {
        tenant_id: tenantId,
        subject_id: "person-unregistered",
        role: "USER",
        organization_ids: [],
        client_id: "genio-one-bot",
        scopes: ["genioone-management", "genioone-invocation"],
      },
    }),
  })
  return { app, modules, botAccessPolicy }
}

test("a verified USER creates an AGENT through the canonical self-service boundary", async () => {
  const { app, modules } = await createApp(() => "ENABLED")
  try {
    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/me/agents`,
      headers: { authorization: "Bearer user" },
      payload: { display_name: "Dylan Bot" },
    })
    assert.equal(response.statusCode, 201)
    const created = response.json()
    assert.equal(created.kind, "AGENT")
    assert.match(created.subject_id, /^agent-/)
    assert.deepEqual(created.profile, { display_name: "Dylan Bot", email: null, department: null })

    const inventory = await modules.identity.inventory({ tenantId })
    assert.deepEqual(inventory.subjects.filter((subject) => subject.subject_id === created.subject_id), [created])
  } finally {
    await app.close()
  }
})

test("a client request id creates one stable agent, detects payload conflicts, and is isolated by verified caller", async () => {
  const { app, modules } = await createApp(() => "ENABLED")
  try {
    const payload = { display_name: "Dylan Bot", client_request_id: "bot-create-1" }
    const first = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/me/agents`, headers: { authorization: "Bearer user" }, payload })
    const repeated = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/me/agents`, headers: { authorization: "Bearer user" }, payload })
    assert.equal(first.statusCode, 201)
    assert.equal(repeated.statusCode, 201)
    assert.equal(repeated.json().subject_id, first.json().subject_id)
    assert.equal((await modules.identity.inventory({ tenantId })).subjects.filter((subject) => subject.kind === "AGENT").length, 1)

    const conflict = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/me/agents`,
      headers: { authorization: "Bearer user" },
      payload: { ...payload, display_name: "Different Bot" },
    })
    assert.equal(conflict.statusCode, 409)
    assert.equal(conflict.json().code, "SELF_SERVICE_AGENT_REQUEST_CONFLICT")

    const otherCaller = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/me/agents`, headers: { authorization: "Bearer secondUser" }, payload })
    assert.equal(otherCaller.statusCode, 201)
    assert.notEqual(otherCaller.json().subject_id, first.json().subject_id)
    assert.equal((await modules.identity.inventory({ tenantId })).subjects.filter((subject) => subject.kind === "AGENT").length, 2)
  } finally {
    await app.close()
  }
})

test("a repeated stable create still denies access after the caller is revoked", async () => {
  const { app, modules, botAccessPolicy } = await createApp(() => "ENABLED")
  try {
    const payload = { display_name: "Dylan Bot", client_request_id: "bot-create-revoked" }
    const first = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/me/agents`, headers: { authorization: "Bearer user" }, payload })
    assert.equal(first.statusCode, 201)
    await botAccessPolicy.setFirstPartyBotSeedEnabled({ tenantId, enabled: false, publishedBy: "test-admin", correlationId: "revoke-stable-create" })
    const denied = await app.inject({ method: "POST", url: `/v1/tenants/${tenantId}/me/agents`, headers: { authorization: "Bearer user" }, payload })
    assert.equal(denied.statusCode, 403)
    assert.equal(denied.json().code, "BOT_ACCESS_DENIED")
    assert.equal((await modules.identity.inventory({ tenantId })).subjects.filter((subject) => subject.kind === "AGENT").length, 1)
  } finally {
    await app.close()
  }
})

test("the self-service body cannot supply an identity kind, subject, or actor", async () => {
  const { app, modules } = await createApp(() => "ENABLED")
  try {
    for (const payload of [
      { display_name: "Tampered Bot", kind: "PERSON" },
      { display_name: "Tampered Bot", subject_id: "person-other" },
      { display_name: "Tampered Bot", actor_subject_id: "person-other" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/tenants/${tenantId}/me/agents`,
        headers: { authorization: "Bearer user" },
        payload,
      })
      assert.equal(response.statusCode, 400)
      assert.equal(response.json().code, "REQUEST_VALIDATION_FAILED")
    }
    assert.equal((await modules.identity.inventory({ tenantId })).subjects.filter((subject) => subject.kind === "AGENT").length, 0)
  } finally {
    await app.close()
  }
})

test("the self-service boundary denies a caller when One Policy is disabled", async () => {
  const { app, modules, botAccessPolicy } = await createApp(() => "ENABLED")
  try {
    await botAccessPolicy.setFirstPartyBotSeedEnabled({
      tenantId,
      enabled: false,
      publishedBy: "test-admin",
      correlationId: "self-service-policy-disable",
    })
    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/me/agents`,
      headers: { authorization: "Bearer user" },
      payload: { display_name: "Denied Bot" },
    })
    assert.equal(response.statusCode, 403)
    assert.equal(response.json().code, "BOT_ACCESS_DENIED")
    assert.equal(response.json().message, "FIRST_PARTY_POLICY_DISABLED")
    assert.equal((await modules.identity.inventory({ tenantId })).subjects.filter((subject) => subject.kind === "AGENT").length, 0)
  } finally {
    await app.close()
  }
})

test("the self-service boundary denies creation while the installed Genio Bot connection is disabled", async () => {
  const { app, modules } = await createApp(() => "DISABLED")
  try {
    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/me/agents`,
      headers: { authorization: "Bearer user" },
      payload: { display_name: "Unavailable Bot" },
    })
    assert.equal(response.statusCode, 403)
    assert.equal(response.json().code, "GENIO_BOT_SERVICE_DISABLED")
    assert.equal((await modules.identity.inventory({ tenantId })).subjects.filter((subject) => subject.kind === "AGENT").length, 0)
  } finally {
    await app.close()
  }
})

test("the self-service boundary rejects a cross-tenant path and preserves the administrator identity route", async () => {
  const { app, modules } = await createApp(() => "ENABLED")
  try {
    const crossTenant = await app.inject({
      method: "POST",
      url: "/v1/tenants/tenant-other/me/agents",
      headers: { authorization: "Bearer user" },
      payload: { display_name: "Other Tenant Bot" },
    })
    assert.equal(crossTenant.statusCode, 403)
    assert.equal(crossTenant.json().code, "TENANT_ACCESS_DENIED")

    const wrongTenantPath = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/me/agents`,
      headers: { authorization: "Bearer otherTenantUser" },
      payload: { display_name: "Cross Tenant Bot" },
    })
    assert.equal(wrongTenantPath.statusCode, 403)
    assert.equal(wrongTenantPath.json().code, "TENANT_ACCESS_DENIED")

    const adminRoute = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/identity/subjects`,
      headers: { authorization: "Bearer user" },
      payload: { kind: "AGENT", display_name: "Should Stay Admin Only" },
    })
    assert.equal(adminRoute.statusCode, 403)
    assert.equal(adminRoute.json().code, "TENANT_ADMINISTRATOR_REQUIRED")
    assert.equal((await modules.identity.inventory({ tenantId })).subjects.filter((subject) => subject.kind === "AGENT").length, 0)
  } finally {
    await app.close()
  }
})

test("the self-service boundary requires a registered PERSON subject even when policy allows the caller", async () => {
  const { app, modules } = await createApp(() => "ENABLED")
  await modules.identity.bootstrap({
    tenantId,
    subjects: [
      { subject_id: "agent-existing", kind: "AGENT", role: "USER" },
      { subject_id: "application-existing", kind: "APPLICATION", role: "USER" },
    ],
  })
  try {
    for (const token of ["agentUser", "applicationUser", "unregisteredUser"]) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/tenants/${tenantId}/me/agents`,
        headers: { authorization: `Bearer ${token}` },
        payload: { display_name: "Should Be Denied" },
      })
      assert.equal(response.statusCode, 403)
      assert.equal(response.json().code, "PERSON_PRINCIPAL_REQUIRED")
    }
    assert.equal((await modules.identity.inventory({ tenantId })).subjects.filter((subject) => subject.kind === "AGENT").length, 1)
  } finally {
    await app.close()
  }
})

test("the self-service boundary fails closed when canonical identity lookup is unavailable", async () => {
  const { app, modules } = await createApp(() => "ENABLED", true)
  try {
    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/me/agents`,
      headers: { authorization: "Bearer user" },
      payload: { display_name: "Unavailable Identity Bot" },
    })
    assert.equal(response.statusCode, 503)
    assert.equal(response.json().code, "IDENTITY_LOOKUP_UNAVAILABLE")
    assert.equal((await modules.identity.inventory({ tenantId })).subjects.filter((subject) => subject.kind === "AGENT").length, 0)
  } finally {
    await app.close()
  }
})
