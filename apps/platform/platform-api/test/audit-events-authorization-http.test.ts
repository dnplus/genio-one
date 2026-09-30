import assert from "node:assert/strict"
import test from "node:test"

import { createManagementApi } from "../src/app"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
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
