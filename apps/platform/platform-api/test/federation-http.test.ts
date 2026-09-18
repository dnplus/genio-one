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
