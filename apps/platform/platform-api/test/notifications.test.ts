import assert from "node:assert/strict"
import test from "node:test"

import { createManagementApi } from "../src/app"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"

test("Notification subscriptions belong to the authenticated subject", async () => {
  const modules = createInMemoryPlatformModules({ now: () => 1_000 })
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      first: {
        tenant_id: "tenant-acme",
        subject_id: "person-first",
        client_id: "management-ui",
        role: "USER",
        organization_ids: [],
      },
      second: {
        tenant_id: "tenant-acme",
        subject_id: "person-second",
        client_id: "management-ui",
        role: "USER",
        organization_ids: [],
      },
    }),
  })
  const created = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/notification-subscriptions",
    headers: { authorization: "Bearer first" },
    payload: {
      correlation_id: "correlation-1",
      notification_type: "ACCESS_REQUEST",
      channel: "IN_APP",
      enabled: true,
    },
  })
  assert.equal(created.statusCode, 200)
  assert.equal(created.json().subject_id, "person-first")

  const hidden = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/notification-subscriptions",
    headers: { authorization: "Bearer second" },
  })
  assert.deepEqual(hidden.json(), [])

  const denied = await app.inject({
    method: "DELETE",
    url: `/v1/tenants/tenant-acme/notification-subscriptions/${created.json().subscription_id}`,
    headers: { authorization: "Bearer second" },
    payload: { correlation_id: "correlation-2" },
  })
  assert.equal(denied.statusCode, 404)

  const disabled = await app.inject({
    method: "DELETE",
    url: `/v1/tenants/tenant-acme/notification-subscriptions/${created.json().subscription_id}`,
    headers: { authorization: "Bearer first" },
    payload: { correlation_id: "correlation-3" },
  })
  assert.equal(disabled.statusCode, 200)
  assert.equal(disabled.json().enabled, false)
  await app.close()
})
