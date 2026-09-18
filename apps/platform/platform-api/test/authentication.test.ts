import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import test from "node:test"
import WebSocket from "ws"

import { createManagementApi } from "../src/app"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createInMemoryGatewayAggregateRuntimeControlStore } from "../src/capabilities/gateway-runtime-control/memory"
import {
  createEnvironmentPrincipalAuthenticator,
  createStaticPrincipalAuthenticator,
} from "../src/capabilities/tenancy-auth/memory"

const principals = {
  "user-token": {
    tenant_id: "tenant-acme",
    subject_id: "user-1",
    role: "USER" as const,
    organization_ids: [],
    client_id: "client-user",
  },
  "org-token": {
    tenant_id: "tenant-acme",
    subject_id: "org-admin-1",
    role: "ORGANIZATION_ADMINISTRATOR" as const,
    organization_ids: ["org-owned"],
    client_id: "client-org",
  },
  "tenant-token": {
    tenant_id: "tenant-acme",
    subject_id: "tenant-admin-1",
    role: "TENANT_ADMINISTRATOR" as const,
    organization_ids: [],
    client_id: "client-tenant",
  },
  "other-tenant-token": {
    tenant_id: "tenant-other",
    subject_id: "tenant-admin-other",
    role: "TENANT_ADMINISTRATOR" as const,
    organization_ids: [],
    client_id: "client-other",
  },
}

function dependencies(withResolver = true) {
  const modules = createInMemoryPlatformModules()
  return {
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator(principals),
    ...(withResolver
      ? {
          entitlementResolver: {
            async resolve() {
              return ["model-authorized"]
            },
          },
        }
      : {}),
  }
}

async function seedGatewayRuntime(
  modules: ReturnType<typeof createInMemoryPlatformModules>,
  clientId: string,
) {
  const { publicKey } = generateKeyPairSync("ed25519")
  const reportPublicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString()
  await modules.runtimeControl.registerGatewayRuntime({
    tenantId: "tenant-acme",
    runtimeId: "gateway-auth-test",
    targetId: "gateway-target-auth-test",
    oidcClientId: clientId,
    reportKeyId: "report-key-auth-test",
    reportPublicKeyPem,
  })
}

async function inject(
  app: Awaited<ReturnType<typeof createManagementApi>>,
  token: string | undefined,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    ...(payload === undefined ? {} : { payload: payload as object }),
  })
}

test("one production web bundle serves Management and Self-service entry points", async () => {
  const html = "<!doctype html><html><body><div id=\"root\"></div></body></html>"
  const app = await createManagementApi({ ...dependencies(), webHtml: html })

  for (const url of ["/management", "/management/", "/self-service", "/self-service/"]) {
    const response = await app.inject({ method: "GET", url })
    assert.equal(response.statusCode, 200)
    assert.match(response.headers["content-type"] ?? "", /^text\/html/)
    assert.equal(response.body, html)
  }

  await app.close()
})

test("Management API authenticates tenant routes and rejects cross-tenant access", async () => {
  const app = await createManagementApi(dependencies())

  const missing = await inject(
    app,
    undefined,
    "POST",
    "/v1/tenants/tenant-acme/organizations",
    { display_name: "Commerce" },
  )
  assert.equal(missing.statusCode, 401)
  assert.equal(missing.json().code, "UNAUTHENTICATED")

  const crossTenant = await inject(
    app,
    "other-tenant-token",
    "POST",
    "/v1/tenants/tenant-acme/organizations",
    { display_name: "Should not cross tenants" },
  )
  assert.equal(crossTenant.statusCode, 403)
  assert.equal(crossTenant.json().code, "TENANT_ACCESS_DENIED")

  const traversal = await inject(
    app,
    "admin-token",
    "POST",
    "/v1/tenants/tenant-acme/%2e%2e/organizations",
    { display_name: "Should reject traversal" },
  )
  assert.equal(traversal.statusCode, 401)
  assert.equal(traversal.json().code, "UNAUTHENTICATED")

  await app.close()
})

test("Management API applies role checks and rejects body actor spoofing", async () => {
  const app = await createManagementApi(dependencies())

  const userCreate = await inject(
    app,
    "user-token",
    "POST",
    "/v1/tenants/tenant-acme/organizations",
    { display_name: "Should be denied" },
  )
  assert.equal(userCreate.statusCode, 403)
  assert.equal(userCreate.json().code, "TENANT_ADMINISTRATOR_REQUIRED")

  const userIdentityInventory = await inject(
    app,
    "user-token",
    "GET",
    "/v1/tenants/tenant-acme/identity",
  )
  assert.equal(userIdentityInventory.statusCode, 403)
  assert.equal(userIdentityInventory.json().code, "TENANT_ADMINISTRATOR_REQUIRED")

  const tenantIdentityInventory = await inject(
    app,
    "tenant-token",
    "GET",
    "/v1/tenants/tenant-acme/identity",
  )
  assert.equal(tenantIdentityInventory.statusCode, 200)

  const wrongOwner = await inject(
    app,
    "org-token",
    "POST",
    "/v1/tenants/tenant-acme/resources",
    {
      display_name: "Wrong owner",
      kind: "LLM",
      owner_organization_id: "org-not-owned",
      authentication_strategy: "OAUTH",
      environment_id: "local",
      version: "1.0.0",
      enforcement_point_id: "ai-gateway-local",
    },
  )
  assert.equal(wrongOwner.statusCode, 403)
  assert.equal(wrongOwner.json().code, "RESOURCE_OWNER_OR_TENANT_ADMIN_REQUIRED")

  const spoofedRequest = await inject(
    app,
    "tenant-token",
    "POST",
    "/v1/tenants/tenant-acme/resources/resource-1/publication-requests",
    { requested_by: "attacker" },
  )
  assert.equal(spoofedRequest.statusCode, 403)
  assert.equal(spoofedRequest.json().code, "ACTOR_SPOOFED")

  const spoofedRoute = await inject(
    app,
    "tenant-token",
    "POST",
    "/v1/tenants/tenant-acme/model-routing/resolve",
    {
      subject_id: "attacker",
      client_id: "client-tenant",
      public_model_id: "public-chat",
      entitled_model_ids: ["attacker-chosen-model"],
    },
  )
  assert.equal(spoofedRoute.statusCode, 403)
  assert.equal(spoofedRoute.json().code, "ACTOR_SPOOFED")

  await app.close()
})

test("OAuth scopes separate management, invocation, and Gateway Runtime routes", async () => {
  const modules = createInMemoryPlatformModules()
  const { publicKey } = generateKeyPairSync("ed25519")
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      management: {
        tenant_id: "tenant-acme",
        subject_id: "tenant-admin-1",
        role: "TENANT_ADMINISTRATOR",
        organization_ids: [],
        client_id: "management-client",
        scopes: ["genioone-management"],
      },
      invocation: {
        tenant_id: "tenant-acme",
        subject_id: "user-1",
        role: "USER",
        organization_ids: [],
        client_id: "self-service-client",
        scopes: ["genioone-invocation"],
      },
      endpoint: {
        tenant_id: "tenant-acme",
        subject_id: "tenant-admin-1",
        role: "TENANT_ADMINISTRATOR",
        organization_ids: [],
        client_id: "endpoint-client",
        scopes: ["genioone-endpoint-runtime"],
      },
      gateway: {
        tenant_id: "tenant-acme",
        subject_id: "gateway-runtime-scope",
        role: "USER",
        organization_ids: [],
        client_id: "gateway-runtime-scope",
        scopes: ["genioone-gateway-runtime"],
      },
    }),
  })

  assert.equal((await inject(app, "management", "GET", "/v1/tenants/tenant-acme/identity")).statusCode, 200)
  assert.equal((await inject(app, "invocation", "GET", "/v1/tenants/tenant-acme/catalog")).statusCode, 200)

  for (const token of ["invocation", "endpoint", "gateway"]) {
    const response = await inject(app, token, "GET", "/v1/tenants/tenant-acme/identity")
    assert.equal(response.statusCode, 403)
    assert.equal(response.json().code, "INSUFFICIENT_SCOPE")
  }

  const registration = await inject(
    app,
    "gateway",
    "PUT",
    "/v1/tenants/tenant-acme/runtime-control/GATEWAY/gateway-runtime-scope/registration",
    {
      target_id: "gateway-scope-target",
      oidc_client_id: "gateway-runtime-scope",
      report_key_id: "gateway-scope-report",
      report_public_key_pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      status: "ACTIVE",
    },
  )
  assert.equal(registration.statusCode, 200, registration.body)

  await app.close()
})

test("an Organization Administrator cannot self-register a Gateway Runtime", async () => {
  const deps = dependencies()
  await seedGatewayRuntime(deps.modules, "client-tenant")
  const app = await createManagementApi(deps)
  const registrationBody = {
    target_id: "gateway-target-auth-test",
    oidc_client_id: "client-tenant",
    report_key_id: "report-key-auth-test",
    report_public_key_pem: "not-used-after-role-check",
  }

  const response = await inject(
    app,
    "org-token",
    "PUT",
    "/v1/tenants/tenant-acme/runtime-control/GATEWAY/gateway-auth-test/registration",
    registrationBody,
  )
  assert.equal(response.statusCode, 403, response.body)
  assert.equal(response.json().code, "RUNTIME_SELF_REGISTRATION_DENIED")

  await app.close()
})

test("a Gateway Runtime may self-register only its authenticated runtime id", async () => {
  const deps = dependencies()
  const runtimeId = "gateway-runtime-self"
  const { publicKey } = generateKeyPairSync("ed25519")
  const reportPublicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString()
  const app = await createManagementApi({
    ...deps,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      "runtime-self-token": {
        tenant_id: "tenant-acme",
        subject_id: "keycloak-service-account-subject",
        role: "USER",
        organization_ids: [],
        client_id: runtimeId,
      },
    }),
  })
  const body = {
    target_id: "gateway-self",
    oidc_client_id: runtimeId,
    report_key_id: "runtime-report-self",
    report_public_key_pem: reportPublicKeyPem,
    status: "ACTIVE",
  }

  const accepted = await inject(
    app,
    "runtime-self-token",
    "PUT",
    `/v1/tenants/tenant-acme/runtime-control/GATEWAY/${runtimeId}/registration`,
    body,
  )
  assert.equal(accepted.statusCode, 200)

  const rejected = await inject(
    app,
    "runtime-self-token",
    "PUT",
    "/v1/tenants/tenant-acme/runtime-control/GATEWAY/gateway-runtime-other/registration",
    { ...body, oidc_client_id: "gateway-runtime-other" },
  )
  assert.equal(rejected.statusCode, 403)
  assert.equal(rejected.json().code, "RUNTIME_SELF_REGISTRATION_DENIED")
  await app.close()
})

test("aggregate runtime capability negotiation uses runtime identity instead of an administrator role", async () => {
  const base = createInMemoryPlatformModules()
  await seedGatewayRuntime(base, "client-runtime")
  const aggregateStore = createInMemoryGatewayAggregateRuntimeControlStore({
    registrations: base.runtimeControl,
    now: () => 100,
  })
  const modules = {
    ...base,
    gatewayAggregateRuntimeControl: {
      store: aggregateStore,
      packages: { async getPackage() { return null } },
    },
  }
  const runtimePrincipal = {
    tenant_id: "tenant-acme",
    subject_id: "runtime-gateway-auth-test",
    role: "USER" as const,
    organization_ids: [],
    client_id: "client-runtime",
  }
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      "runtime-token": runtimePrincipal,
      "wrong-runtime-token": { ...runtimePrincipal, client_id: "different-client" },
    }),
  })

  const accepted = await inject(
    app,
    "runtime-token",
    "PUT",
    "/v1/tenants/tenant-acme/runtime-control/GATEWAY/gateway-auth-test/capabilities",
    {
      protocol_versions: ["genio.one.runtime.v1"],
      preferred_protocol_version: "genio.one.runtime.v1",
      delivery_mode: "AGGREGATE_RELEASE",
    },
  )
  assert.equal(accepted.statusCode, 200, accepted.body)
  assert.equal(accepted.json().preferred_protocol_version, "genio.one.runtime.v1")

  const healthTargets = await inject(
    app,
    "runtime-token",
    "GET",
    "/v1/tenants/tenant-acme/runtime-control/GATEWAY/gateway-auth-test/connection-health-targets",
  )
  assert.equal(healthTargets.statusCode, 200, healthTargets.body)
  assert.deepEqual(healthTargets.json(), [])

  const healthBatch = await inject(
    app,
    "runtime-token",
    "POST",
    "/v1/tenants/tenant-acme/runtime-control/GATEWAY/gateway-auth-test/connection-health-observations",
    {
      correlation_id: "health-scan-auth",
      observations: [{
        resource_id: "resource-missing",
        connection_id: "connection-missing",
        source_revision: 1,
        state: "UNAVAILABLE",
        observed_at: 100,
      }],
    },
  )
  assert.equal(healthBatch.statusCode, 404, healthBatch.body)
  assert.equal(healthBatch.json().code, "RESOURCE_NOT_FOUND")

  const rejected = await inject(
    app,
    "wrong-runtime-token",
    "PUT",
    "/v1/tenants/tenant-acme/runtime-control/GATEWAY/gateway-auth-test/capabilities",
    {
      protocol_versions: ["genio.one.runtime.v1"],
      preferred_protocol_version: "genio.one.runtime.v1",
      delivery_mode: "AGGREGATE_RELEASE",
    },
  )
  assert.equal(rejected.statusCode, 403)
  assert.equal(rejected.json().code, "RUNTIME_ACCESS_DENIED")

  const rejectedHealthTargets = await inject(
    app,
    "wrong-runtime-token",
    "GET",
    "/v1/tenants/tenant-acme/runtime-control/GATEWAY/gateway-auth-test/connection-health-targets",
  )
  assert.equal(rejectedHealthTargets.statusCode, 403)
  assert.equal(rejectedHealthTargets.json().code, "RUNTIME_ACCESS_DENIED")

  const rejectedHealthBatch = await inject(
    app,
    "wrong-runtime-token",
    "POST",
    "/v1/tenants/tenant-acme/runtime-control/GATEWAY/gateway-auth-test/connection-health-observations",
    {
      correlation_id: "health-scan-wrong-runtime",
      observations: [{
        resource_id: "resource-missing",
        connection_id: "connection-missing",
        source_revision: 1,
        state: "UNAVAILABLE",
        observed_at: 100,
      }],
    },
  )
  assert.equal(rejectedHealthBatch.statusCode, 403)
  assert.equal(rejectedHealthBatch.json().code, "RUNTIME_ACCESS_DENIED")

  await app.close()
})

test("authenticated aggregate Runtime WebSocket establishes a leased session", async () => {
  const base = createInMemoryPlatformModules()
  const { publicKey } = generateKeyPairSync("ed25519")
  await base.runtimeControl.registerGatewayRuntime({
    tenantId: "tenant-acme",
    runtimeId: "gateway-websocket-auth",
    targetId: "gateway-websocket-auth",
    oidcClientId: "runtime-websocket-client",
    reportKeyId: "runtime-websocket-report",
    reportPublicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  })
  const aggregate = createInMemoryGatewayAggregateRuntimeControlStore({
    registrations: base.runtimeControl,
  })
  const modules = {
    ...base,
    gatewayAggregateRuntimeControl: {
      store: aggregate,
      packages: { async getPackage() { return null } },
    },
  }
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      "runtime-websocket-token": {
        ...principals["tenant-token"],
        client_id: "runtime-websocket-client",
      },
    }),
  })
  await app.ready()
  await app.listen({ port: 0, host: "127.0.0.1" })
  const address = app.server.address()
  assert.ok(address && typeof address === "object")
  const capabilities = await inject(
    app,
    "runtime-websocket-token",
    "PUT",
    "/v1/tenants/tenant-acme/runtime-control/GATEWAY/gateway-websocket-auth/capabilities",
    {
      protocol_versions: ["genio.one.runtime.v1"],
      preferred_protocol_version: "genio.one.runtime.v1",
      delivery_mode: "AGGREGATE_RELEASE",
    },
  )
  assert.equal(capabilities.statusCode, 200, capabilities.body)
  const url = `ws://127.0.0.1:${address.port}/v1/tenants/tenant-acme/runtime-control/GATEWAY/gateway-websocket-auth/aggregate/connect`
  const socket = new WebSocket(url, { headers: { authorization: "Bearer runtime-websocket-token" } })
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.ok(await base.runtimeControl.getGatewaySessionLease({
      tenantId: "tenant-acme",
      runtimeId: "gateway-websocket-auth",
    }))
  } finally {
    socket.close()
    await app.close()
  }
})

test("Model routing fails closed without trusted entitlements", async () => {
  const app = await createManagementApi(dependencies(false))
  const response = await inject(
    app,
    "tenant-token",
    "POST",
    "/v1/tenants/tenant-acme/model-routing/resolve",
    {
      subject_id: "tenant-admin-1",
      client_id: "client-tenant",
      public_model_id: "public-chat",
      entitled_model_ids: ["attacker-chosen-model"],
    },
  )
  assert.equal(response.statusCode, 503)
  assert.equal(response.json().code, "ENTITLEMENT_RESOLVER_UNAVAILABLE")
  await app.close()
})

test("environment authentication requires explicit configuration and fails closed by default", async () => {
  const principal = principals["tenant-token"]
  const development = createEnvironmentPrincipalAuthenticator({
    NODE_ENV: "development",
    GENIO_ONE_MANAGEMENT_API_AUTH_MODE: "static-dev",
    GENIO_ONE_MANAGEMENT_API_PRINCIPALS_JSON: JSON.stringify({ "dev-token": principal }),
  })
  assert.deepEqual(
    await development.authenticate({ token: "dev-token", tenantId: "tenant-acme" }),
    principal,
  )

  const production = createEnvironmentPrincipalAuthenticator({
    NODE_ENV: "production",
  })
  assert.equal(
    await production.authenticate({ token: "dev-token", tenantId: "tenant-acme" }),
    null,
  )

  const rejectedProductionFixture = createEnvironmentPrincipalAuthenticator({
    NODE_ENV: "production",
    GENIO_ONE_MANAGEMENT_API_AUTH_MODE: "static-dev",
    GENIO_ONE_MANAGEMENT_API_PRINCIPALS_JSON: JSON.stringify({ "dev-token": principal }),
  })
  assert.equal(
    await rejectedProductionFixture.authenticate({
      token: "dev-token",
      tenantId: "tenant-acme",
    }),
    null,
  )
})

test("management reads do not expose tenant-wide Resource inventory to a User", async () => {
  const modules = createInMemoryPlatformModules()
  const catalog = {
    async listResources() {
      return [
        {
          tenant_id: "tenant-acme",
          resource_id: "resource-private",
          display_name: "Private draft",
          kind: "LLM" as const,
          owner_organization_id: "org-owned",
          authentication_strategy: "OAUTH" as const,
          environment_id: "production",
          version: "1.0.0",
          lifecycle: "DRAFT" as const,
          operational_state: "UNKNOWN" as const,
          capabilities: [],
          enforcement_point_id: "ai-gateway",
          created_at: 1,
        },
      ]
    },
    async getResource() {
      return (await this.listResources())[0]
    },
  }
  const app = await createManagementApi({
    modules,
    resourceCatalog: catalog,
    principalAuthenticator: createStaticPrincipalAuthenticator(principals),
  })

  const user = await inject(
    app,
    "user-token",
    "GET",
    "/v1/tenants/tenant-acme/resources",
  )
  assert.equal(user.statusCode, 200)
  assert.deepEqual(user.json(), [])

  const owner = await inject(
    app,
    "org-token",
    "GET",
    "/v1/tenants/tenant-acme/resources",
  )
  assert.equal(owner.statusCode, 200)
  assert.equal(owner.json()[0]?.resource_id, "resource-private")

  const tenant = await inject(
    app,
    "tenant-token",
    "GET",
    "/v1/tenants/tenant-acme/resources",
  )
  assert.equal(tenant.statusCode, 200)
  assert.equal(tenant.json()[0]?.resource_id, "resource-private")
  await app.close()
})
