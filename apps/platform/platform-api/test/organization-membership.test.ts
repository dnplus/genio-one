import assert from "node:assert/strict"
import test from "node:test"

import { createManagementApi } from "../src/app"
import { createInMemoryIdentityDirectory } from "../src/capabilities/identity/memory"
import { createInMemoryOrganizationDirectory } from "../src/capabilities/organizations/memory"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createCanonicalPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/canonical"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"

test("Organization membership drives canonical Organization Administrator scope", async () => {
  const identity = createInMemoryIdentityDirectory()
  const organizations = createInMemoryOrganizationDirectory({ idFactory: () => "org-ai" })
  await identity.bootstrap({
    tenantId: "tenant-acme",
    subjects: [{
      subject_id: "person-org-admin",
      kind: "PERSON",
      role: "USER",
      external_identities: [{
        provider_id: "keycloak-acme",
        external_subject_id: "external-org-admin",
      }],
    }],
  })
  const organization = await organizations.create({
    tenantId: "tenant-acme",
    display_name: "AI Platform",
    member_subject_ids: ["person-org-admin"],
  })
  await organizations.update({
    tenantId: "tenant-acme",
    organizationId: organization.organization_id,
    value: {
      display_name: organization.display_name,
      member_subject_ids: ["person-org-admin"],
      organization_administrator_subject_ids: ["person-org-admin"],
      membership_sources: [{ kind: "MANUAL", reference: "console", status: "SYNCED" }],
    },
  })

  const authenticator = createCanonicalPrincipalAuthenticator({
    delegate: createStaticPrincipalAuthenticator({
      token: {
        tenant_id: "tenant-acme",
        subject_id: "external-org-admin",
        client_id: "management-ui",
        role: "TENANT_ADMINISTRATOR",
        organization_ids: ["attacker-controlled-org"],
        external_identity: {
          provider_id: "keycloak-acme",
          external_subject_id: "external-org-admin",
        },
      },
    }),
    identity,
    organizations,
  })

  assert.deepEqual(
    await authenticator.authenticate({ token: "token", tenantId: "tenant-acme" }),
    {
      tenant_id: "tenant-acme",
      subject_id: "person-org-admin",
      client_id: "management-ui",
      role: "ORGANIZATION_ADMINISTRATOR",
      organization_ids: ["org-ai"],
      administrator_organization_ids: ["org-ai"],
      external_identity: {
        provider_id: "keycloak-acme",
        external_subject_id: "external-org-admin",
      },
    },
  )
})

test("canonical session preserves member visibility and limits Organization mutation to administrator scope", async () => {
  const tenantId = "tenant-acme"
  const modules = createInMemoryPlatformModules()
  await modules.identity.bootstrap({
    tenantId,
    subjects: [
      { subject_id: "person-kevin", kind: "PERSON", role: "USER" },
      { subject_id: "person-tenant-admin", kind: "PERSON", role: "TENANT_ADMINISTRATOR" },
    ],
  })
  const sales = await modules.organizations.create({
    tenantId,
    display_name: "Sales",
    member_subject_ids: ["person-kevin"],
  })
  const uatAccess = await modules.organizations.create({
    tenantId,
    display_name: "UAT Access",
    member_subject_ids: ["person-kevin"],
  })
  await modules.organizations.update({
    tenantId,
    organizationId: uatAccess.organization_id,
    value: {
      display_name: uatAccess.display_name,
      member_subject_ids: uatAccess.member_subject_ids,
      organization_administrator_subject_ids: ["person-kevin"],
      membership_sources: uatAccess.membership_sources,
    },
  })
  const principalAuthenticator = createCanonicalPrincipalAuthenticator({
    delegate: createStaticPrincipalAuthenticator({
      kevin: {
        tenant_id: tenantId,
        subject_id: "person-kevin",
        client_id: "management-ui",
        role: "USER",
        organization_ids: [],
      },
      "tenant-admin": {
        tenant_id: tenantId,
        subject_id: "person-tenant-admin",
        client_id: "management-ui",
        role: "USER",
        organization_ids: [],
      },
    }),
    identity: modules.identity,
    organizations: modules.organizations,
  })
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator,
    browserIdentity: {
      tenant_id: tenantId,
      issuer: "https://identity.example.test/realms/genio-one",
      authorization_endpoint: "https://identity.example.test/realms/genio-one/protocol/openid-connect/auth",
      token_endpoint: "https://identity.example.test/realms/genio-one/protocol/openid-connect/token",
      client_id: "self-service-ui",
      scopes: ["genioone-invocation"],
      management_client_id: "management-ui",
      management_scopes: ["genioone-management"],
    },
  })
  const headers = (token: string) => ({ authorization: `Bearer ${token}` })
  const organizationPayload = (organization: typeof sales) => ({
    display_name: organization.display_name,
    member_subject_ids: organization.member_subject_ids,
    organization_administrator_subject_ids: organization.organization_administrator_subject_ids,
    membership_sources: organization.membership_sources,
  })
  try {
    const session = await app.inject({
      method: "GET",
      url: "/v1/identity/session",
      headers: headers("kevin"),
    })
    assert.equal(session.statusCode, 200, session.body)
    assert.deepEqual(session.json(), {
      tenant_id: tenantId,
      subject_id: "person-kevin",
      display_name: null,
      email: null,
      acting_client_id: "management-ui",
      role: "ORGANIZATION_ADMINISTRATOR",
      organization_ids: [sales.organization_id, uatAccess.organization_id],
      administrator_organization_ids: [uatAccess.organization_id],
      scopes: ["genioone-management"],
      acr: "oidc",
      amr: ["oidc"],
    })

    const salesUpdate = await app.inject({
      method: "PUT",
      url: `/v1/tenants/${tenantId}/organizations/${sales.organization_id}`,
      headers: headers("kevin"),
      payload: organizationPayload(sales),
    })
    assert.equal(salesUpdate.statusCode, 403, salesUpdate.body)
    assert.equal(salesUpdate.json().code, "RESOURCE_OWNER_OR_TENANT_ADMIN_REQUIRED")

    const uatAccessUpdate = await app.inject({
      method: "PUT",
      url: `/v1/tenants/${tenantId}/organizations/${uatAccess.organization_id}`,
      headers: headers("kevin"),
      payload: organizationPayload({
        ...uatAccess,
        organization_administrator_subject_ids: ["person-kevin"],
      }),
    })
    assert.equal(uatAccessUpdate.statusCode, 200, uatAccessUpdate.body)

    const tenantUpdate = await app.inject({
      method: "PUT",
      url: `/v1/tenants/${tenantId}/organizations/${sales.organization_id}`,
      headers: headers("tenant-admin"),
      payload: organizationPayload(sales),
    })
    assert.equal(tenantUpdate.statusCode, 200, tenantUpdate.body)
  } finally {
    await app.close()
  }
})

test("Resource details remain member-readable while Connection management and mutations require administrator scope", async () => {
  const tenantId = "tenant-acme"
  const modules = createInMemoryPlatformModules()
  const sales = await modules.organizations.create({
    tenantId,
    display_name: "Sales",
    member_subject_ids: ["person-kevin"],
  })
  const uatAccess = await modules.organizations.create({
    tenantId,
    display_name: "UAT Access",
    member_subject_ids: ["person-kevin"],
  })
  const salesResource = await modules.resources.createResource({
    tenantId,
    value: {
      display_name: "Sales MCP",
      kind: "MCP",
      owner_organization_id: sales.organization_id,
      authentication_strategy: "NONE",
      environment_id: "test",
      version: "1.0.0",
      capabilities: [{ capability_id: "sales.read", display_name: "Read sales" }],
      enforcement_point_id: "ai-gateway",
    },
  })
  const uatAccessResource = await modules.resources.createResource({
    tenantId,
    value: {
      display_name: "UAT Access MCP",
      kind: "MCP",
      owner_organization_id: uatAccess.organization_id,
      authentication_strategy: "NONE",
      environment_id: "test",
      version: "1.0.0",
      capabilities: [{ capability_id: "uat.read", display_name: "Read UAT Access" }],
      enforcement_point_id: "ai-gateway",
    },
  })
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      kevin: {
        tenant_id: tenantId,
        subject_id: "person-kevin",
        client_id: "management-ui",
        role: "ORGANIZATION_ADMINISTRATOR",
        organization_ids: [sales.organization_id, uatAccess.organization_id],
        administrator_organization_ids: [uatAccess.organization_id],
      },
    }),
  })
  const headers = { authorization: "Bearer kevin" }
  try {
    const salesDetail = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/resources/${salesResource.resource_id}`,
      headers,
    })
    assert.equal(salesDetail.statusCode, 200, salesDetail.body)

    const salesConnections = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/resources/${salesResource.resource_id}/connections`,
      headers,
    })
    assert.equal(salesConnections.statusCode, 403, salesConnections.body)
    assert.equal(salesConnections.json().code, "RESOURCE_OWNER_OR_TENANT_ADMIN_REQUIRED")

    const salesMutation = await app.inject({
      method: "PATCH",
      url: `/v1/tenants/${tenantId}/resources/${salesResource.resource_id}`,
      headers,
      payload: { display_name: "Sales MCP revised" },
    })
    assert.equal(salesMutation.statusCode, 403, salesMutation.body)
    assert.equal(salesMutation.json().code, "RESOURCE_OWNER_OR_TENANT_ADMIN_REQUIRED")

    const uatAccessMutation = await app.inject({
      method: "PATCH",
      url: `/v1/tenants/${tenantId}/resources/${uatAccessResource.resource_id}`,
      headers,
      payload: { display_name: "UAT Access MCP revised" },
    })
    assert.equal(uatAccessMutation.statusCode, 200, uatAccessMutation.body)
  } finally {
    await app.close()
  }
})

test("Gateway Runtime transport keeps its registration identity outside the directory", async () => {
  const identity = createInMemoryIdentityDirectory()
  const organizations = createInMemoryOrganizationDirectory()
  const runtimePrincipal = {
    tenant_id: "tenant-acme",
    subject_id: "gateway-runtime-1",
    client_id: "gateway-runtime-1",
    role: "USER" as const,
    organization_ids: [],
  }
  const authenticator = createCanonicalPrincipalAuthenticator({
    delegate: createStaticPrincipalAuthenticator({ runtime: runtimePrincipal }),
    identity,
    organizations,
  })

  assert.deepEqual(
    await authenticator.authenticate({
      token: "runtime",
      tenantId: "tenant-acme",
      request: { url: "/v1/tenants/tenant-acme/runtime-control/GATEWAY/gateway-runtime-1/aggregate/connect" } as never,
    }),
    runtimePrincipal,
  )
})
