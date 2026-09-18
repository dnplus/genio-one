import assert from "node:assert/strict"
import test from "node:test"

import { createManagementApi } from "../src/app"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"

const settings = {
  brand_name: "GenioOne",
  language: "zh-TW",
  catalog_visibility: "ENTITLED_AND_REQUESTABLE",
  request_form: {
    enabled: true,
    required_fields: ["justification", "requested_ttl"],
    default_ttl_seconds: 28_800,
  },
  ttl_options_seconds: [3_600, 28_800, 86_400],
  approval_workflow_version: "v1.1-default",
  notification_channels: ["IN_APP"],
  login_branding: {
    tagline: "企業 AI 存取治理控制平面",
    logo_url: "",
    primary_color: "#425fea",
    page_color: "#f7f8fa",
    custom_css: "",
  },
}

test("Tenant configuration lifecycle keeps publish and convergence separate", async () => {
  let now = 1_000
  const modules = createInMemoryPlatformModules({ now: () => now })
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      admin: {
        tenant_id: "tenant-acme",
        subject_id: "person-admin",
        client_id: "management-ui",
        role: "TENANT_ADMINISTRATOR",
        organization_ids: [],
      },
      user: {
        tenant_id: "tenant-acme",
        subject_id: "person-user",
        client_id: "self-service-ui",
        role: "USER",
        organization_ids: [],
      },
    }),
  })
  const denied = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/configuration-revisions",
    headers: { authorization: "Bearer user" },
    payload: { correlation_id: "denied", settings },
  })
  assert.equal(denied.statusCode, 403)

  const created = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/configuration-revisions",
    headers: { authorization: "Bearer admin" },
    payload: { correlation_id: "create", settings },
  })
  assert.equal(created.statusCode, 201)
  const revision = created.json().revision as string

  const skipped = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-acme/configuration-revisions/${revision}/publish`,
    headers: { authorization: "Bearer admin" },
    payload: { correlation_id: "skip" },
  })
  assert.equal(skipped.statusCode, 409)

  for (const transition of ["validate", "preview", "review", "publish"] as const) {
    now += 1
    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/tenant-acme/configuration-revisions/${revision}/${transition}`,
      headers: { authorization: "Bearer admin" },
      payload: { correlation_id: transition },
    })
    assert.equal(response.statusCode, 200)
  }

  const published = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/self-service-configuration",
    headers: { authorization: "Bearer user" },
  })
  assert.equal(published.statusCode, 200)
  assert.equal(published.json().state, "PUBLISHED")
  assert.equal(published.json().projection.status, "PENDING")
  assert.equal(published.json().projection.observed_revision, null)
  assert.equal(published.json().projection.drift, true)

  now += 1
  const observed = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-acme/configuration-revisions/${revision}/projection-observation`,
    headers: { authorization: "Bearer admin" },
    payload: { correlation_id: "observed", observed_revision: revision },
  })
  assert.equal(observed.statusCode, 200)
  assert.equal(observed.json().projection.status, "CONVERGED")
  assert.equal(observed.json().projection.drift, false)
  await app.close()
})

test("a configured Self-service projector converges the published revision", async () => {
  let now = 2_000
  const modules = createInMemoryPlatformModules({ now: () => now })
  modules.configuration.project = ({ tenantId, revision }) =>
    modules.configuration.observe({
      tenantId,
      revision,
      value: {
        correlation_id: "project",
        observed_revision: revision,
      },
    })
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      admin: {
        tenant_id: "tenant-acme",
        subject_id: "person-admin",
        client_id: "management-ui",
        role: "TENANT_ADMINISTRATOR",
        organization_ids: [],
      },
      user: {
        tenant_id: "tenant-acme",
        subject_id: "person-user",
        client_id: "self-service-ui",
        role: "USER",
        organization_ids: [],
      },
    }),
  })
  const created = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/configuration-revisions",
    headers: { authorization: "Bearer admin" },
    payload: {
      correlation_id: "create-projected",
      settings: { ...settings, brand_name: "GenioOne Local" },
    },
  })
  const revision = created.json().revision as string
  let response = created
  for (const transition of ["validate", "preview", "review", "publish"] as const) {
    now += 1
    response = await app.inject({
      method: "POST",
      url: `/v1/tenants/tenant-acme/configuration-revisions/${revision}/${transition}`,
      headers: { authorization: "Bearer admin" },
      payload: { correlation_id: `projected-${transition}` },
    })
    assert.equal(response.statusCode, 200)
  }
  assert.equal(response.json().projection.status, "CONVERGED")
  assert.equal(response.json().projection.observed_revision, revision)
  assert.equal(response.json().projection.drift, false)

  const published = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/self-service-configuration",
    headers: { authorization: "Bearer user" },
  })
  assert.equal(published.json().settings.brand_name, "GenioOne Local")
  assert.equal(published.json().revision, revision)
  await app.close()
})

test("the public login branding route exposes only the published tenant branding", async () => {
  let now = 3_000
  const modules = createInMemoryPlatformModules({ now: () => now })
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    browserIdentity: {
      tenant_id: "tenant-acme",
      issuer: "http://127.0.0.1:58080/realms/genio-one",
      authorization_endpoint: "http://127.0.0.1:58080/realms/genio-one/protocol/openid-connect/auth",
      token_endpoint: "http://127.0.0.1:58080/realms/genio-one/protocol/openid-connect/token",
      client_id: "genio-one-management-console",
      scopes: ["openid", "genioone-management"],
      management_client_id: "genio-one-management-console",
      management_scopes: ["openid", "genioone-management"],
    },
    principalAuthenticator: createStaticPrincipalAuthenticator({
      admin: {
        tenant_id: "tenant-acme",
        subject_id: "person-admin",
        client_id: "management-ui",
        role: "TENANT_ADMINISTRATOR",
        organization_ids: [],
      },
    }),
  })

  const initial = await app.inject({
    method: "GET",
    url: "/v1/identity/login-branding",
    headers: { origin: "http://127.0.0.1:58080" },
  })
  assert.equal(initial.statusCode, 200)
  assert.equal(initial.headers["access-control-allow-origin"], "http://127.0.0.1:58080")
  assert.equal(initial.headers.vary, "Origin")
  assert.deepEqual(initial.json(), {
    brand_name: "GenioOne",
    tagline: "企業 AI 存取治理控制平面",
    logo_url: "",
    primary_color: "#425fea",
    page_color: "#f7f8fa",
    custom_css: "",
  })

  const created = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/configuration-revisions",
    headers: { authorization: "Bearer admin" },
    payload: {
      correlation_id: "branding-create",
      settings: {
        ...settings,
        brand_name: "Acme AI",
        login_branding: {
          tagline: "安全地使用企業 AI",
          logo_url: "https://cdn.example.com/acme.svg",
          primary_color: "#123456",
          page_color: "#f5f7fb",
          custom_css: ".genio-brand__tagline { letter-spacing: 0; }",
        },
      },
    },
  })
  const revision = created.json().revision as string
  for (const transition of ["validate", "preview", "review", "publish"] as const) {
    now += 1
    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/tenant-acme/configuration-revisions/${revision}/${transition}`,
      headers: { authorization: "Bearer admin" },
      payload: { correlation_id: `branding-${transition}` },
    })
    assert.equal(response.statusCode, 200)
  }

  const published = await app.inject({ method: "GET", url: "/v1/identity/login-branding" })
  assert.equal(published.statusCode, 200)
  assert.deepEqual(published.json(), {
    brand_name: "Acme AI",
    tagline: "安全地使用企業 AI",
    logo_url: "https://cdn.example.com/acme.svg",
    primary_color: "#123456",
    page_color: "#f5f7fb",
    custom_css: ".genio-brand__tagline { letter-spacing: 0; }",
  })
  assert.equal(published.headers["cache-control"], "no-store")
  await app.close()
})
