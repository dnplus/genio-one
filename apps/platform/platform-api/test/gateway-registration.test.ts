import assert from "node:assert/strict"
import test from "node:test"

import { createManagementApi } from "../src/app"
import { createInMemoryGatewayRegistrationRepository } from "../src/capabilities/gateway-registration/memory"
import { createGatewayRegistrationLifecycle } from "../src/capabilities/gateway-registration/module"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"

test("Tenant Administrator registers, provisions once, lists, and retires a Gateway Runtime", async () => {
  const modules = createInMemoryPlatformModules({ now: () => 100 })
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      admin: {
        tenant_id: "tenant-acme",
        subject_id: "person-admin",
        role: "TENANT_ADMINISTRATOR",
        organization_ids: [],
        client_id: "management-ui",
        scopes: ["genioone-management"],
      },
    }),
  })

  const bootstrapResponse = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/gateways",
    headers: { authorization: "Bearer admin" },
    payload: {
      correlation_id: "register-1",
      runtime_id: "gateway-taipei-1",
      display_name: "Taipei Gateway",
      gateway_id: "genio-ai-mcp-gateway",
      site_id: "taipei",
      region: "tw-north",
      labels: { boundary: "core" },
    },
  })
  assert.equal(bootstrapResponse.statusCode, 201, bootstrapResponse.body)
  const bootstrap = bootstrapResponse.json()
  assert.equal(bootstrap.schema_version, "genio.one.gateway-bootstrap.v1")
  assert.equal(bootstrap.registration.state, "ACTIVE")
  assert.equal(bootstrap.tenant_id, "tenant-acme")
  assert.equal(bootstrap.runtime_id, "gateway-taipei-1")
  assert.equal(bootstrap.gateway_id, "genio-ai-mcp-gateway")
  assert.equal(bootstrap.oidc.client_id, "gateway-taipei-1")
  assert.match(bootstrap.report_signing.private_key_pem, /BEGIN PRIVATE KEY/)
  assert.equal(bootstrap.credential_delivery, "ONE_TIME")

  const runtime = await modules.runtimeControl.getGatewayRuntime({
    tenantId: "tenant-acme",
    runtimeId: "gateway-taipei-1",
  })
  assert.equal(runtime?.target_id, "genio-ai-mcp-gateway")
  assert.equal(runtime?.status, "ACTIVE")

  const listed = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/gateways",
    headers: { authorization: "Bearer admin" },
  })
  assert.equal(listed.statusCode, 200)
  assert.deepEqual(listed.json()[0], bootstrap.registration)

  const reprovisioned = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/gateways/gateway-taipei-1/provision",
    headers: { authorization: "Bearer admin" },
    payload: { correlation_id: "provision-again" },
  })
  assert.equal(reprovisioned.statusCode, 409)
  assert.equal(reprovisioned.json().code, "GATEWAY_BOOTSTRAP_ALREADY_DELIVERED")

  const retired = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/gateways/gateway-taipei-1/retire",
    headers: { authorization: "Bearer admin" },
    payload: { correlation_id: "retire-1" },
  })
  assert.equal(retired.statusCode, 200)
  assert.equal(retired.json().state, "RETIRED")
  assert.equal((await modules.runtimeControl.getGatewayRuntime({
    tenantId: "tenant-acme",
    runtimeId: "gateway-taipei-1",
  }))?.status, "REVOKED")

  const generatedBootstrapResponse = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/gateways",
    headers: { authorization: "Bearer admin" },
    payload: {
      correlation_id: "register-generated",
      display_name: "Generated Gateway",
      site_id: "taipei",
      region: "tw-north",
      labels: {},
    },
  })
  assert.equal(generatedBootstrapResponse.statusCode, 201, generatedBootstrapResponse.body)
  assert.match(generatedBootstrapResponse.json().runtime_id, /^gateway-runtime-/)
  assert.equal(generatedBootstrapResponse.json().oidc.client_id, generatedBootstrapResponse.json().runtime_id)

  await app.close()
})

test("failed identity provisioning leaves a retryable Gateway registration", async () => {
  const modules = createInMemoryPlatformModules({ now: () => 100 })
  let fail = true
  const store = createInMemoryGatewayRegistrationRepository({ now: () => 100 })
  const retryable = createGatewayRegistrationLifecycle({
    repository: store,
    provisioner: {
      async provision({ clientId }) {
        if (fail) throw new Error("identity provider unavailable")
        return {
          issuer: "https://issuer.example.test",
          token_endpoint: "https://issuer.example.test/token",
          audience: "genio-one-product-api",
          scope: "genioone-gateway-runtime",
          client_id: clientId,
          client_secret: "gateway-secret",
        }
      },
      async revoke() {},
    },
    runtimeControl: modules.runtimeControl,
    platformOrigin: "https://one.example.test",
    defaultGatewayId: "genio-ai-mcp-gateway",
    runtimeCommandVerificationKeys: { schema_version: 1, keys: [{ key_id: "command", public_key_pem: "public" }] },
    policyReleaseRootKeys: { schema_version: 1, keys: [{ key_id: "release", public_key_pem: "public" }] },
  })

  await assert.rejects(retryable.register({
    tenantId: "tenant-acme",
    actorSubjectId: "person-admin",
    value: {
      correlation_id: "register-2",
      runtime_id: "gateway-retry-1",
      display_name: "Retry Gateway",
      site_id: "taipei",
      region: "tw-north",
      labels: {},
    },
  }), /identity provider unavailable/)
  assert.equal((await store.get({ tenantId: "tenant-acme", runtimeId: "gateway-retry-1" }))?.state, "PROVISIONING")

  fail = false
  const bootstrap = await retryable.provision({
    tenantId: "tenant-acme",
    actorSubjectId: "person-admin",
    runtimeId: "gateway-retry-1",
  })
  assert.equal(bootstrap.registration.state, "ACTIVE")
})
