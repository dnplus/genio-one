import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"

import { createManagementApi } from "../src/app"
import { gatewayAuthorizationAuditHttp } from "../src/capabilities/audit-events/http"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createInMemoryGatewayAuthorizationAuditStore } from "../src/capabilities/audit-events/memory"
import type { Principal } from "../src/capabilities/tenancy-auth/contract"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"

const tenantId = "tenant-audit-authorization"

function principal(role: Principal["role"]): Principal {
  return {
    tenant_id: tenantId,
    subject_id: `person-${role.toLowerCase()}`,
    client_id: "management-ui",
    role,
    organization_ids: role === "TENANT_ADMINISTRATOR" ? [] : ["organization-a"],
    scopes: ["genioone-management"],
  }
}

test("audit event list limits GET and HEAD to Tenant Administrators", async () => {
  const modules = createInMemoryPlatformModules()
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      user: principal("USER"),
      "organization-administrator": principal("ORGANIZATION_ADMINISTRATOR"),
      "tenant-administrator": principal("TENANT_ADMINISTRATOR"),
    }),
  })

  try {
    for (const [token, expectedStatus] of [
      ["user", 403],
      ["organization-administrator", 403],
      ["tenant-administrator", 200],
    ] as const) {
      for (const method of ["GET", "HEAD"] as const) {
        const response = await app.inject({
          method,
          url: `/v1/tenants/${tenantId}/audit-events?kind=ACCESS_GOVERNANCE_CHANGE`,
          headers: { authorization: `Bearer ${token}` },
        })
        assert.equal(response.statusCode, expectedStatus, response.body)
        if (expectedStatus === 403 && method === "GET") {
          assert.equal(response.json().code, "TENANT_ADMINISTRATOR_REQUIRED")
        }
      }
    }
  } finally {
    await app.close()
  }
})

test("runtime authenticated Gateway failure ingest keeps actors null and tenant bound to verified runtime", async () => {
  const store = createInMemoryGatewayAuthorizationAuditStore()
  const app = Fastify()
  await app.register(gatewayAuthorizationAuditHttp, {
    store,
    authorizeRuntime: async ({ tenantId: verifiedTenantId, runtimeId }) => {
      assert.equal(verifiedTenantId, "tenant-verified")
      assert.equal(runtimeId, "gateway-runtime")
    },
  })

  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/tenants/tenant-verified/runtime-control/GATEWAY/gateway-runtime/audit-events",
      headers: { authorization: "Bearer verified-runtime" },
      payload: {
        audit_event_id: "gateway-authn-failure-1",
        correlation_id: "gateway-correlation-1",
        kind: "GATEWAY_AUTHENTICATION_FAILURE",
        outcome: "DENY",
        subject: null,
        acting_client: null,
        resource_id: null,
        capability_id: "gateway.authenticate",
        status: 401,
        reason: "JWT_INVALID_SIGNATURE",
        occurred_at: 1_800_000_000,
      },
    })
    assert.equal(response.statusCode, 201, response.body)
    assert.equal(response.json().tenant_id, "tenant-verified")
    assert.equal(response.json().subject, null)
    assert.equal(response.json().acting_client, null)
    const event = await store.findById({ tenantId: "tenant-verified", auditEventId: "gateway-authn-failure-1" })
    assert.equal(event?.kind, "GATEWAY_AUTHENTICATION_FAILURE")
    assert.equal(event && "subject" in event ? event.subject : undefined, null)
  } finally {
    await app.close()
  }
})
