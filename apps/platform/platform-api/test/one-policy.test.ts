import assert from "node:assert/strict"
import test from "node:test"

import { createManagementApi } from "../src/app"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createDefaultOnePolicy, PERSONAL_BOT_RESOURCE } from "../src/capabilities/one-policy/default"
import type { ResourceConnectionRegistry } from "../src/capabilities/connections/module"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"

test("the first-party One Policy gives the local Tenant Administrator the default Bot route", async () => {
  const modules = createInMemoryPlatformModules()
  const botAccessPolicy = createDefaultOnePolicy()
  const app = await createManagementApi({
    modules: { ...modules, botAccessPolicy },
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      "bot-admin": {
        tenant_id: "tenant-keycloak-local",
        subject_id: "person-platform-admin",
        client_id: "genio-one-bot",
        role: "TENANT_ADMINISTRATOR",
        organization_ids: [],
        scopes: ["genioone-management", "genioone-invocation"],
      },
      "bot-user": {
        tenant_id: "tenant-keycloak-local",
        subject_id: "person-user",
        client_id: "genio-one-bot",
        role: "USER",
        organization_ids: [],
        scopes: ["genioone-management", "genioone-invocation"],
      },
    }),
  })

  try {
    const allowed = await app.inject({
      method: "GET",
      url: "/v1/tenants/tenant-keycloak-local/one-policy/bot-access?capability_id=personal_bot.use",
      headers: { authorization: "Bearer bot-admin" },
    })
    assert.equal(allowed.statusCode, 200)
    assert.deepEqual(allowed.json(), {
      tenant_id: "tenant-keycloak-local",
      subject_id: "person-platform-admin",
      client_id: "genio-one-bot",
      resource_id: "genio.personal-bot",
      capability_id: "personal_bot.use",
      decision: "ALLOW",
      policy_id: "one-policy.first-party.bot-default",
      policy_revision: 1,
      model_route: "codex-subscription",
      reason_code: "DEFAULT_ADMIN_BOT_ACCESS",
    })

    const denied = await app.inject({
      method: "GET",
      url: "/v1/tenants/tenant-keycloak-local/one-policy/bot-access?capability_id=personal_bot.use",
      headers: { authorization: "Bearer bot-user" },
    })
    assert.equal(denied.statusCode, 200)
    assert.equal(denied.json().decision, "DENY")
    assert.equal(denied.json().reason_code, "TENANT_ADMINISTRATOR_REQUIRED")

    const seed = await app.inject({
      method: "GET",
      url: "/v1/tenants/tenant-keycloak-local/one-policy/first-party-bot",
      headers: { authorization: "Bearer bot-admin" },
    })
    assert.equal(seed.statusCode, 200)
    assert.equal(seed.json().seed, true)
    assert.equal(seed.json().enabled, true)

    const disabled = await app.inject({
      method: "PATCH",
      url: "/v1/tenants/tenant-keycloak-local/one-policy/first-party-bot",
      headers: { authorization: "Bearer bot-admin" },
      payload: { enabled: false },
    })
    assert.equal(disabled.statusCode, 200)
    assert.equal(disabled.json().enabled, false)

    const deniedWhenDisabled = await app.inject({
      method: "GET",
      url: "/v1/tenants/tenant-keycloak-local/one-policy/bot-access?capability_id=personal_bot.use",
      headers: { authorization: "Bearer bot-admin" },
    })
    assert.equal(deniedWhenDisabled.statusCode, 200)
    assert.equal(deniedWhenDisabled.json().decision, "DENY")
    assert.equal(deniedWhenDisabled.json().reason_code, "FIRST_PARTY_POLICY_DISABLED")

    const forbidden = await app.inject({
      method: "PATCH",
      url: "/v1/tenants/tenant-keycloak-local/one-policy/first-party-bot",
      headers: { authorization: "Bearer bot-user" },
      payload: { enabled: true },
    })
    assert.equal(forbidden.statusCode, 403)

    const reenabled = await app.inject({
      method: "PATCH",
      url: "/v1/tenants/tenant-keycloak-local/one-policy/first-party-bot",
      headers: { authorization: "Bearer bot-admin" },
      payload: { enabled: true },
    })
    assert.equal(reenabled.statusCode, 200)
    assert.equal(reenabled.json().enabled, true)
  } finally {
    await app.close()
  }
})

test("the first-party One Policy keeps computer control closed by default", async () => {
  const decision = await createDefaultOnePolicy().resolveBotAccess({
    tenantId: "tenant-keycloak-local",
    principal: {
      subject_id: "person-platform-admin",
      client_id: "genio-one-bot",
      role: "TENANT_ADMINISTRATOR",
    },
    capabilityId: "personal_bot.computer_use",
  })
  assert.equal(decision.decision, "DENY")
  assert.equal(decision.reason_code, "COMPUTER_USE_NOT_IN_DEFAULT_POLICY")
})

test("the Platform Bot access gate follows the installed connection lifecycle", async () => {
  const tenantId = "tenant-bot-access"
  let lifecycle: "ENABLED" | "DISABLED" = "ENABLED"
  let connections: ResourceConnectionRegistry | undefined
  const modules = createInMemoryPlatformModules({
    connectionEnabled: async ({ tenantId: candidateTenantId, botId }) => {
      if (botId !== PERSONAL_BOT_RESOURCE || !connections) return false
      const values = await connections.list({ tenantId: candidateTenantId, resourceId: botId })
      return values.some((connection) => connection.resource_id === PERSONAL_BOT_RESOURCE && connection.connection_id === PERSONAL_BOT_RESOURCE && connection.lifecycle === "ENABLED")
    },
  })
  connections = {
    ...modules.connections,
    async list(input) {
      if (input.tenantId === tenantId && input.resourceId === PERSONAL_BOT_RESOURCE) {
        return [{
          tenant_id: tenantId,
          resource_id: PERSONAL_BOT_RESOURCE,
          connection_id: PERSONAL_BOT_RESOURCE,
          lifecycle,
        } as never]
      }
      return modules.connections.list(input)
    },
  }
  const app = await createManagementApi({
    modules: { ...modules, connections },
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      admin: {
        tenant_id: tenantId,
        subject_id: "person-platform-admin",
        client_id: "genio-one-bot",
        role: "TENANT_ADMINISTRATOR",
        organization_ids: [],
        scopes: ["genioone-management", "genioone-invocation"],
      },
    }),
  })
  const access = async () => app.inject({
    method: "GET",
    url: `/v1/tenants/${tenantId}/one-policy/bot-access?capability_id=personal_bot.use`,
    headers: { authorization: "Bearer admin" },
  })
  try {
    assert.equal((await access()).json().decision, "ALLOW")
    lifecycle = "DISABLED"
    const disabled = await access()
    assert.equal(disabled.json().decision, "DENY")
    assert.equal(disabled.json().reason_code, "BOT_CONNECTION_DISABLED")
    lifecycle = "ENABLED"
    assert.equal((await access()).json().decision, "ALLOW")
  } finally {
    await app.close()
  }
})

test("the Platform Bot access gate fails closed when the installed connection lookup fails", async () => {
  const policy = createDefaultOnePolicy({
    connectionEnabled: async () => { throw new Error("CONNECTION_LOOKUP_FAILED") },
  })
  const decision = await policy.resolveBotAccess({
    tenantId: "tenant-bot-access",
    principal: {
      subject_id: "person-platform-admin",
      client_id: "genio-one-bot",
      role: "TENANT_ADMINISTRATOR",
    },
    capabilityId: "personal_bot.use",
  })
  assert.equal(decision.decision, "DENY")
  assert.equal(decision.reason_code, "BOT_CONNECTION_DISABLED")
  assert.equal(decision.policy_id, "one-policy.first-party.bot-default")
  assert.equal(decision.policy_revision, 1)
  assert.equal(decision.model_route, null)
})
