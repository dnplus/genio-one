import assert from "node:assert/strict"
import test from "node:test"

import { createManagementApi } from "../src/app"
import type { AccessActor } from "../src/capabilities/access/module"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"

test("Organization Administrator can revoke an Entitlement owned by its Organization without receiving grant authority", async () => {
  const modules = createInMemoryPlatformModules({ now: () => 100 })
  const revokeActors: AccessActor[] = []
  const app = await createManagementApi({
    modules: {
      ...modules,
      access: {
        ...modules.access,
        async revokeEntitlement({ actor }) {
          revokeActors.push(actor)
          return {
            entitlement_id: "entitlement-1",
            subject_id: "person-user",
            resource_id: "resource-ai",
            capability_id: "model.invoke",
            state: "REVOKED",
            valid_from: 1,
            valid_until: 200,
            revocation_reason: "Access no longer required",
          }
        },
      },
    },
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      "org-admin-token": {
        tenant_id: "tenant-acme",
        subject_id: "person-org-admin",
        client_id: "management-ui",
        role: "ORGANIZATION_ADMINISTRATOR",
        organization_ids: ["org-ai"],
      },
      "self-service-token": {
        tenant_id: "tenant-acme",
        subject_id: "person-user",
        client_id: "self-service-ui",
        role: "USER",
        organization_ids: [],
        scopes: ["genioone-invocation"],
      },
    }),
  })

  const revoked = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/entitlements/entitlement-1/revoke",
    headers: { authorization: "Bearer org-admin-token" },
    payload: { correlation_id: "revoke-1", reason: "Access no longer required" },
  })
  assert.equal(revoked.statusCode, 200)
  assert.equal(revokeActors[0]?.role, "ORGANIZATION_ADMINISTRATOR")
  assert.deepEqual(revokeActors[0]?.organizationIds, ["org-ai"])

  const grant = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/entitlements",
    headers: { authorization: "Bearer org-admin-token" },
    payload: {
      subject_id: "person-user",
      resource_id: "resource-ai",
      capability_id: "model.invoke",
    },
  })
  assert.equal(grant.statusCode, 403)
  assert.equal(grant.json().code, "TENANT_ADMINISTRATOR_REQUIRED")

  const selfServiceConfiguration = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/self-service-configuration",
    headers: { authorization: "Bearer self-service-token" },
  })
  assert.equal(selfServiceConfiguration.statusCode, 200)

  const managementConfiguration = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/configuration-revisions",
    headers: { authorization: "Bearer self-service-token" },
  })
  assert.equal(managementConfiguration.statusCode, 403)
  assert.equal(managementConfiguration.json().code, "INSUFFICIENT_SCOPE")
  await app.close()
})
