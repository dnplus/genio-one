import assert from "node:assert/strict"
import test from "node:test"

import { createManagementApi } from "../src/app"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"
import { desiredRuntimeStateRevision, runtimeHealthTimedOut } from "../src/capabilities/runtime-inventory/http"

test("Runtime inventory retains a failed release as desired while exposing the last successful revision", () => {
  assert.equal(desiredRuntimeStateRevision({
    pendingRevision: null,
    observedRevision: "294",
    appliedRevision: "292",
  }), "294")
  assert.equal(desiredRuntimeStateRevision({
    pendingRevision: "295",
    observedRevision: "294",
    appliedRevision: "292",
  }), "295")
  assert.notEqual(desiredRuntimeStateRevision({
    pendingRevision: null,
    observedRevision: "294",
    appliedRevision: "292",
  }), "292")
})

test("Runtime inventory marks stale observed health as timed out at the exact deadline", () => {
  assert.equal(runtimeHealthTimedOut({ connected: true, observedAt: 970, now: 999, timeoutSeconds: 30 }), false)
  assert.equal(runtimeHealthTimedOut({ connected: true, observedAt: 970, now: 1_000, timeoutSeconds: 30 }), true)
  assert.equal(runtimeHealthTimedOut({ connected: false, observedAt: 900, now: 1_000, timeoutSeconds: 30 }), false)
})

test("Runtime inventory exposes registered and connected Gateway state to Tenant Administrators", async () => {
  const now = () => 1_000
  const modules = createInMemoryPlatformModules({ now })
  await modules.gatewayRegistrations.register({
    tenantId: "tenant-acme",
    actorSubjectId: "person-admin",
    value: {
      correlation_id: "correlation-register-gateway",
      runtime_id: "gateway-runtime-1",
      display_name: "Taipei Gateway",
      gateway_id: "genio-ai-mcp-gateway",
      site_id: "gateway-site-1",
      region: "ap-east",
      labels: {},
    },
  })
  await modules.runtimeControl.claimGatewaySessionLease({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    ownerId: "runtime-control",
    leaseId: "lease-1",
    ttlSeconds: 30,
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
        client_id: "management-ui",
        role: "USER",
        organization_ids: [],
      },
    }),
  })

  const runtimes = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/runtimes",
    headers: { authorization: "Bearer admin" },
  })
  assert.equal(runtimes.statusCode, 200)
  assert.equal(runtimes.json()[0].runtime_id, "gateway-runtime-1")
  assert.equal(runtimes.json()[0].connected, true)
  assert.equal(runtimes.json()[0].operator_state, "AWAITING_REPORT")

  const gateways = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/gateways",
    headers: { authorization: "Bearer admin" },
  })
  assert.equal(gateways.statusCode, 200)
  assert.equal(gateways.json()[0].site_id, "gateway-site-1")

  const fleet = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/gateway-sites",
    headers: { authorization: "Bearer admin" },
  })
  assert.equal(fleet.statusCode, 200)
  assert.equal(fleet.json().sites[0].gateway_id, "genio-ai-mcp-gateway")
  assert.equal(fleet.json().sites[0].site_id, "gateway-site-1")
  assert.equal(fleet.json().sites[0].region, "ap-east")
  assert.equal(fleet.json().sites[0].registered_instance_count, 1)

  const denied = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/runtimes",
    headers: { authorization: "Bearer user" },
  })
  assert.equal(denied.statusCode, 403)
  assert.equal(denied.json().code, "TENANT_ADMINISTRATOR_REQUIRED")
  await app.close()
})
