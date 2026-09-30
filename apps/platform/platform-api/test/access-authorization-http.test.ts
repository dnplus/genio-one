import assert from "node:assert/strict"
import test from "node:test"

import { createManagementApi } from "../src/app"
import type { AccessActor } from "../src/capabilities/access/module"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"

test("Organization Administrator can revoke an Entitlement owned by its Organization without receiving grant authority", async () => {
  const modules = createInMemoryPlatformModules({ now: () => 100 })
  const revokeActors: AccessActor[] = []
  const activationActors: Array<{ actor: AccessActor; correlationId: string }> = []
  const app = await createManagementApi({
    modules: {
      ...modules,
      access: {
        ...modules.access,
        async activateAutoGrant({ actor, value }) {
          activationActors.push({ actor, correlationId: value.correlation_id })
          return {
            entitlement_id: "entitlement-auto-grant-1",
            subject_id: actor.subjectId,
            resource_id: value.resource_id,
            capability_id: value.capability_id,
            state: "ACTIVE",
            valid_from: 100,
            valid_until: null,
            revocation_reason: null,
          }
        },
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
        administrator_organization_ids: ["org-ai"],
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
  assert.deepEqual(revokeActors[0]?.administratorOrganizationIds, ["org-ai"])

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

  const activation = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/me/entitlements/activate",
    headers: { authorization: "Bearer self-service-token" },
    payload: {
      correlation_id: "activate-1",
      resource_id: "resource-ai",
      capability_id: "model.invoke",
    },
  })
  assert.equal(activation.statusCode, 200)
  assert.equal(activation.json().entitlement_id, "entitlement-auto-grant-1")
  assert.equal(activation.json().valid_until, null)
  assert.equal(activationActors[0]?.actor.role, "USER")
  assert.equal(activationActors[0]?.correlationId, "activate-1")

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
