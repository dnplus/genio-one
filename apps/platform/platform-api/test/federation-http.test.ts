import assert from "node:assert/strict"
import test from "node:test"

import { createManagementApi } from "../src/app"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"

test("Organization owner manages Federation Trust while token exchange authenticates by assertion", async () => {
  const modules = createInMemoryPlatformModules({ now: () => 1_000 })
  await modules.identity.bootstrap({
    tenantId: "tenant-acme",
    subjects: [{ subject_id: "person-owner", kind: "PERSON", role: "USER" }],
  })
  const organization = await modules.organizations.create({
    tenantId: "tenant-acme",
    display_name: "AI Platform",
    member_subject_ids: ["person-owner"],
  })
  const application = await modules.applications.register({
    tenantId: "tenant-acme",
    registeredBySubjectId: "person-owner",
    value: {
      display_name: "Operations Automation",
      owner_organization_id: organization.organization_id,
    },
  })
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      "owner-token": {
        tenant_id: "tenant-acme",
        subject_id: "person-owner",
        client_id: "management-ui",
        role: "ORGANIZATION_ADMINISTRATOR",
        organization_ids: [organization.organization_id],
        administrator_organization_ids: [organization.organization_id],
      },
    }),
  })

  const created = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-acme/applications/${application.application_id}/federation-trust-revisions`,
    headers: { authorization: "Bearer owner-token" },
    payload: {
      display_name: "CI workload",
      issuer: "https://issuer.example.test",
      jwks_uri: "https://issuer.example.test/jwks",
      audiences: ["genio-one-sts"],
      algorithms: ["RS256"],
      external_subject_id: "repo:acme/service:ref:main",
      required_claims: [{ name: "environment", value: "production" }],
      max_assertion_ttl_seconds: 600,
    },
  })
  assert.equal(created.statusCode, 201, created.body)
  assert.equal(created.json().application_subject_id, application.subject_id)

  const anonymousExchange = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/sts/token-exchange",
    payload: {
      correlation_id: "federation-correlation-1",
      trust_id: created.json().trust_id,
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      subject_token: "external.assertion.signature",
      resource_id: "resource-api",
      capability_id: "incident.list",
      audience: "genio-one-product-api",
      scope: "genioone-invocation",
    },
  })
  assert.equal(anonymousExchange.statusCode, 503)
  assert.equal(anonymousExchange.json().code, "FEDERATION_EXCHANGE_UNAVAILABLE")
  await app.close()
})

test("Federation Trust mutations require owner management scope while membership remains readable", async () => {
  const tenantId = "tenant-acme"
  const modules = createInMemoryPlatformModules({ now: () => 1_000 })
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
  const salesApplication = await modules.applications.register({
    tenantId,
    registeredBySubjectId: "person-kevin",
    value: {
      display_name: "Sales Automation",
      owner_organization_id: sales.organization_id,
    },
  })
  const uatAccessApplication = await modules.applications.register({
    tenantId,
    registeredBySubjectId: "person-kevin",
    value: {
      display_name: "UAT Access Automation",
      owner_organization_id: uatAccess.organization_id,
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
      "tenant-admin": {
        tenant_id: tenantId,
        subject_id: "person-tenant-admin",
        client_id: "management-ui",
        role: "TENANT_ADMINISTRATOR",
        organization_ids: [],
      },
    }),
  })
  const headers = (token: string) => ({ authorization: `Bearer ${token}` })
  const trustsPath = (applicationId: string) =>
    `/v1/tenants/${tenantId}/applications/${applicationId}/federation-trust-revisions`
  const trustPayload = (displayName: string) => ({
    display_name: displayName,
    issuer: "https://issuer.example.test",
    jwks_uri: "https://issuer.example.test/jwks",
    audiences: ["genio-one-sts"],
    algorithms: ["RS256"],
    external_subject_id: "repo:acme/service:ref:main",
    required_claims: [{ name: "environment", value: "production" }],
    max_assertion_ttl_seconds: 600,
  })

  try {
    const salesTrusts = await app.inject({
      method: "GET",
      url: trustsPath(salesApplication.application_id),
      headers: headers("kevin"),
    })
    assert.equal(salesTrusts.statusCode, 200, salesTrusts.body)
    assert.deepEqual(salesTrusts.json(), [])

    const salesTrust = await app.inject({
      method: "POST",
      url: trustsPath(salesApplication.application_id),
      headers: headers("kevin"),
      payload: trustPayload("Sales workload"),
    })
    assert.equal(salesTrust.statusCode, 403, salesTrust.body)
    assert.equal(salesTrust.json().code, "RESOURCE_OWNER_OR_TENANT_ADMIN_REQUIRED")

    const uatAccessTrust = await app.inject({
      method: "POST",
      url: trustsPath(uatAccessApplication.application_id),
      headers: headers("kevin"),
      payload: trustPayload("UAT Access workload"),
    })
    assert.equal(uatAccessTrust.statusCode, 201, uatAccessTrust.body)

    const tenantAdminTrust = await app.inject({
      method: "POST",
      url: trustsPath(salesApplication.application_id),
      headers: headers("tenant-admin"),
      payload: trustPayload("Tenant Admin workload"),
    })
    assert.equal(tenantAdminTrust.statusCode, 201, tenantAdminTrust.body)
  } finally {
    await app.close()
  }
})
