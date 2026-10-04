import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import test from "node:test"
import WebSocket from "ws"

import { createManagementApi } from "../src/app"
import { PlatformApiError } from "../src/capabilities/errors"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createInMemoryGatewayAggregateRuntimeControlStore } from "../src/capabilities/gateway-runtime-control/memory"
import { createInMemoryResourceConnectionRegistry } from "../src/capabilities/connections/memory"
import { createInMemoryResourceRegistry } from "../src/capabilities/resources/memory"
import { createResourceMemoryState } from "../src/capabilities/resources/state"
import type { GatewayProjection } from "../src/capabilities/gateway-projection/contract"
import {
  createEnvironmentPrincipalAuthenticator,
  createStaticPrincipalAuthenticator,
} from "../src/capabilities/tenancy-auth/memory"
import { createOidcPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/oidc"

const principals = {
  "user-token": {
    tenant_id: "tenant-acme",
    subject_id: "user-1",
    role: "USER" as const,
    organization_ids: [],
    client_id: "client-user",
    scopes: ["genioone-management"],
  },
  "org-token": {
    tenant_id: "tenant-acme",
    subject_id: "org-admin-1",
    role: "ORGANIZATION_ADMINISTRATOR" as const,
    organization_ids: ["org-owned"],
    client_id: "client-org",
    scopes: ["genioone-management"],
  },
  "tenant-token": {
    tenant_id: "tenant-acme",
    subject_id: "tenant-admin-1",
    role: "TENANT_ADMINISTRATOR" as const,
    organization_ids: [],
    client_id: "client-tenant",
    scopes: ["genioone-management"],
  },
  "other-tenant-token": {
    tenant_id: "tenant-other",
    subject_id: "tenant-admin-other",
    role: "TENANT_ADMINISTRATOR" as const,
    organization_ids: [],
    client_id: "client-other",
    scopes: ["genioone-management"],
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
  extraHeaders?: Record<string, string>,
) {
  return app.inject({
    method,
    url,
    ...(token || extraHeaders ? { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders } } : {}),
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

test("Management API preserves identity backend errors and records a stable failure code", async () => {
  const deps = dependencies()
  deps.principalAuthenticator = {
    authenticate() {
      throw new PlatformApiError("IDENTITY_PROVIDER_UNAVAILABLE", 503, "Identity provider unavailable")
    },
  }
  const app = await createManagementApi(deps)

  const response = await inject(
    app,
    "backend-failure-token",
    "GET",
    "/v1/tenants/tenant-acme/identity",
  )
  assert.equal(response.statusCode, 503)
  assert.equal(response.json().code, "IDENTITY_PROVIDER_UNAVAILABLE")

  const receipts = await deps.modules.auditEvents.queryAuthenticationAttempts!({
    code: "IDENTITY_PROVIDER_UNAVAILABLE",
    outcome: "FAILURE",
    offset: 0,
    limit: 10,
  })
  assert.equal(receipts.receipts.length, 1)
  assert.equal(receipts.receipts[0]?.verified_tenant_id, null)
  await app.close()
})

test("Management API persists safe authentication receipts and verified authorization decisions", async () => {
  const deps = dependencies()
  deps.principalAuthenticator = createStaticPrincipalAuthenticator({
    ...principals,
    "scope-token": {
      ...principals["user-token"],
      scopes: ["genioone-invocation"],
    },
  })
  const app = await createManagementApi(deps)

  try {
    const missing = await inject(
      app,
      undefined,
      "POST",
      "/v1/tenants/tenant-acme/organizations",
      { display_name: "Missing token" },
      { "x-genio-correlation-id": "corr-missing-token" },
    )
    assert.equal(missing.statusCode, 401)

    const missingReceipts = await deps.modules.auditEvents.queryAuthenticationAttempts!({
      code: "MISSING_BEARER_TOKEN",
      outcome: "FAILURE",
      offset: 0,
      limit: 10,
    })
    assert.equal(missingReceipts.receipts.length, 1)
    assert.equal(missingReceipts.receipts[0]?.verified_tenant_id, null)
    assert.equal(missingReceipts.receipts[0]?.verified_subject_id, null)
    assert.equal(missingReceipts.receipts[0]?.verified_client_id, null)
    assert.equal(missingReceipts.receipts[0]?.correlation_id, "corr-missing-token")
    assert.equal(JSON.stringify(missingReceipts.receipts[0]).includes("tenant-acme"), false)

    const invalidCorrelation = await inject(
      app,
      undefined,
      "POST",
      "/v1/tenants/tenant-acme/organizations",
      { display_name: "Invalid correlation" },
      { "x-genio-correlation-id": "tenant-acme/forged" },
    )
    assert.equal(invalidCorrelation.statusCode, 401)
    const invalidCorrelationReceipts = await deps.modules.auditEvents.queryAuthenticationAttempts!({
      code: "MISSING_BEARER_TOKEN",
      outcome: "FAILURE",
      offset: 0,
      limit: 10,
    })
    assert.equal(invalidCorrelationReceipts.receipts.some((receipt) => receipt.correlation_id === "tenant-acme/forged"), false)

    const crossTenant = await inject(
      app,
      "other-tenant-token",
      "POST",
      "/v1/tenants/tenant-acme/organizations",
      { display_name: "Cross tenant" },
    )
    assert.equal(crossTenant.statusCode, 403)
    const crossTenantAudit = await deps.modules.auditEvents.query({
      tenantId: "tenant-other",
      kind: "MANAGEMENT_AUTHORIZATION",
      outcome: "DENY",
      offset: 0,
      limit: 10,
    })
    assert.equal(crossTenantAudit.events.length, 1)
    assert.equal(crossTenantAudit.events[0]?.kind, "MANAGEMENT_AUTHORIZATION")
    assert.equal(crossTenantAudit.events[0]?.code, "TENANT_ACCESS_DENIED")
    assert.equal(crossTenantAudit.events[0]?.tenant_id, "tenant-other")
    assert.equal(crossTenantAudit.events[0]?.request_context.requested_tenant_id, "tenant-acme")
    assert.equal(crossTenantAudit.events[0]?.request_context.target.organization_id, null)

    const crossTenantOrganization = await inject(
      app,
      "other-tenant-token",
      "PUT",
      "/v1/tenants/tenant-acme/organizations/organization-target",
      { display_name: "Cross tenant organization" },
    )
    assert.equal(crossTenantOrganization.statusCode, 403)
    const crossTenantOrganizationAudit = await deps.modules.auditEvents.query({
      tenantId: "tenant-other",
      kind: "MANAGEMENT_AUTHORIZATION",
      outcome: "DENY",
      offset: 0,
      limit: 10,
    })
    const organizationTargetAudit = crossTenantOrganizationAudit.events.find((event) =>
      event.kind === "MANAGEMENT_AUTHORIZATION" &&
      event.request_context.target.organization_id === "organization-target"
    )
    assert.ok(organizationTargetAudit)
    if (organizationTargetAudit.kind !== "MANAGEMENT_AUTHORIZATION") throw new Error("Expected management authorization audit")
    assert.equal(organizationTargetAudit.request_context.requested_tenant_id, "tenant-acme")
    assert.equal(organizationTargetAudit.tenant_id, "tenant-other")
    assert.equal(JSON.stringify(organizationTargetAudit).includes("Cross tenant organization"), false)

    const missingScope = await inject(
      app,
      "scope-token",
      "GET",
      "/v1/tenants/tenant-acme/identity",
    )
    assert.equal(missingScope.statusCode, 403)
    const scopeAudit = await deps.modules.auditEvents.query({
      tenantId: "tenant-acme",
      kind: "MANAGEMENT_AUTHORIZATION",
      outcome: "DENY",
      offset: 0,
      limit: 10,
    })
    assert.equal(scopeAudit.events.some((event) => event.kind === "MANAGEMENT_AUTHORIZATION" && event.code === "INSUFFICIENT_SCOPE"), true)

    const roleDenied = await inject(
      app,
      "user-token",
      "POST",
      "/v1/tenants/tenant-acme/organizations",
      { display_name: "Role denied" },
    )
    assert.equal(roleDenied.statusCode, 403)
    const roleAudit = await deps.modules.auditEvents.query({
      tenantId: "tenant-acme",
      kind: "MANAGEMENT_AUTHORIZATION",
      outcome: "DENY",
      offset: 0,
      limit: 10,
    })
    assert.equal(roleAudit.events.some((event) => event.kind === "MANAGEMENT_AUTHORIZATION" && event.code === "TENANT_ADMINISTRATOR_REQUIRED"), true)

    const success = await inject(
      app,
      "tenant-token",
      "GET",
      "/v1/tenants/tenant-acme/identity",
    )
    assert.equal(success.statusCode, 200)
    const successAudit = await deps.modules.auditEvents.query({
      tenantId: "tenant-acme",
      kind: "MANAGEMENT_AUTHORIZATION",
      outcome: "ALLOW",
      offset: 0,
      limit: 10,
    })
    assert.equal(successAudit.events.length, 1)
    assert.equal(successAudit.events[0]?.kind, "MANAGEMENT_AUTHORIZATION")
    assert.equal(successAudit.events[0]?.code, "AUTHORIZED")
    assert.equal(JSON.stringify(successAudit.events[0]).includes("tenant-token"), false)
    assert.equal(JSON.stringify(successAudit.events[0]).includes("email"), false)
  } finally {
    await app.close()
  }
})

test("audit export and application creation scope rejections persist authorization decisions", async () => {
  const deps = dependencies()
  const app = await createManagementApi(deps)

  try {
    for (const [method, url, payload, correlationId] of [
      ["GET", "/v1/tenants/tenant-acme/audit-export?from=0&to=1&resource_id=resource-owned", undefined, "corr-audit-export-grant"],
      ["POST", "/v1/tenants/tenant-acme/applications", {
        display_name: "Missing creation grant",
        owner_organization_id: "org-owned",
      }, "corr-application-create-grant"],
    ] as const) {
      const response = await inject(app, "tenant-token", method, url, payload, {
        "x-genio-correlation-id": correlationId,
      })
      assert.equal(response.statusCode, 403, response.body)
      assert.equal(response.json().code, "INSUFFICIENT_SCOPE")
      const audits = await deps.modules.auditEvents.query({
        tenantId: "tenant-acme",
        kind: "MANAGEMENT_AUTHORIZATION",
        outcome: "DENY",
        offset: 0,
        limit: 10,
      })
      const event = audits.events.find((candidate) => candidate.correlation_id === correlationId)
      assert.ok(event)
      if (event.kind !== "MANAGEMENT_AUTHORIZATION") throw new Error("Expected management authorization audit")
      assert.equal(event.code, "INSUFFICIENT_SCOPE")
      assert.equal(event.subject.subject_id, "tenant-admin-1")
      assert.equal(event.acting_client.acting_client_id, "client-tenant")
      assert.equal(event.request_context.requested_tenant_id, "tenant-acme")
    }
  } finally {
    await app.close()
  }
})

test("identity session persists authentication and authorization evidence outside tenant hooks", async () => {
  const deps = dependencies()
  const app = await createManagementApi({
    ...deps,
    browserIdentity: {
      tenant_id: "tenant-acme",
      issuer: "https://identity.example.test/realms/genio-one",
      authorization_endpoint: "https://identity.example.test/authorize",
      token_endpoint: "https://identity.example.test/token",
      client_id: "browser-client",
      scopes: ["openid"],
      management_client_id: "management-client",
      management_scopes: ["genioone-management"],
    },
  })

  try {
    const missing = await inject(app, undefined, "GET", "/v1/identity/session")
    assert.equal(missing.statusCode, 401)
    const missingReceipts = await deps.modules.auditEvents.queryAuthenticationAttempts!({
      code: "MISSING_BEARER_TOKEN",
      outcome: "FAILURE",
      offset: 0,
      limit: 10,
    })
    assert.equal(missingReceipts.receipts.length, 1)

    const success = await inject(app, "tenant-token", "GET", "/v1/identity/session")
    assert.equal(success.statusCode, 200)
    const successAudit = await deps.modules.auditEvents.query({
      tenantId: "tenant-acme",
      kind: "MANAGEMENT_AUTHORIZATION",
      outcome: "ALLOW",
      offset: 0,
      limit: 10,
    })
    assert.equal(successAudit.events.some((event) => event.kind === "MANAGEMENT_AUTHORIZATION" && event.route === "/v1/identity/session"), true)
  } finally {
    await app.close()
  }
})

test("Management API applies role checks and rejects body actor spoofing", async () => {
  const deps = dependencies()
  const app = await createManagementApi(deps)

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

  const deniedAudits = await deps.modules.auditEvents.query({
    tenantId: "tenant-acme",
    kind: "MANAGEMENT_AUTHORIZATION",
    outcome: "DENY",
    offset: 0,
    limit: 20,
  })
  assert.equal(deniedAudits.events.some((event) => event.kind === "MANAGEMENT_AUTHORIZATION" && event.code === "ACTOR_SPOOFED"), true)

  await app.close()
})

test("OAuth scopes separate management, invocation, and Gateway Runtime routes", async () => {
  const modules = createInMemoryPlatformModules()
  const { publicKey } = generateKeyPairSync("ed25519")
  const reportPublicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString()
  await modules.runtimeControl.registerGatewayRuntime({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-scope",
    targetId: "gateway-scope-target",
    oidcClientId: "gateway-runtime-scope",
    reportKeyId: "gateway-scope-report",
    reportPublicKeyPem,
  })
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
      report_public_key_pem: reportPublicKeyPem,
      status: "ACTIVE",
    },
  )
  assert.equal(registration.statusCode, 200, registration.body)

  await app.close()
})

test("missing OAuth grants cannot access tenant routes or establish a browser session", async () => {
  const modules = createInMemoryPlatformModules()
  const { scopes: _scopes, ...unscoped } = principals["tenant-token"]
  const issuer = "https://identity.example.test/realms/acme"
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      missing: unscoped,
      empty: { ...unscoped, scopes: [] },
      unrelated: { ...unscoped, scopes: ["openid"] },
      management: { ...unscoped, scopes: ["genioone-management"] },
      invocation: { ...unscoped, scopes: ["genioone-invocation"] },
    }),
    browserIdentity: {
      tenant_id: "tenant-acme",
      issuer,
      authorization_endpoint: `${issuer}/auth`,
      token_endpoint: `${issuer}/token`,
      client_id: "self-service-client",
      scopes: ["genioone-invocation"],
      management_client_id: "management-client",
      management_scopes: ["genioone-management"],
    },
  })
  try {
    for (const token of ["missing", "empty", "unrelated"]) {
      for (const url of [
        "/v1/tenants/tenant-acme/identity",
        "/v1/tenants/tenant-acme/catalog",
        "/v1/tenants/tenant-acme/runtime-control/GATEWAY/gateway-auth-test/aggregate/commands/next",
        "/v1/identity/session",
      ]) {
        const response = await inject(app, token, "GET", url)
        assert.equal(response.statusCode, 403, `${token} ${url}: ${response.body}`)
        assert.equal(response.json().code, "INSUFFICIENT_SCOPE")
      }
    }
    for (const [token, scopes] of [
      ["management", ["genioone-management"]],
      ["invocation", ["genioone-invocation"]],
    ] as const) {
      const session = await inject(app, token, "GET", "/v1/identity/session")
      assert.equal(session.statusCode, 200, session.body)
      assert.deepEqual(session.json().scopes, scopes)
    }
  } finally {
    await app.close()
  }
})

test("verified OIDC identity without a scope claim is denied even with an administrator mapping", async () => {
  const issuer = "https://identity.example.test/realms/acme"
  const app = await createManagementApi({
    ...dependencies(),
    principalAuthenticator: createOidcPrincipalAuthenticator({
      tenants: [{
        tenant_id: "tenant-acme",
        issuer,
        audiences: ["management-client"],
        jwks_uri: `${issuer}/certs`,
        algorithms: ["RS256"],
        claims: { subject: "sub", client: "azp", role: "role", organizations: "groups" },
        principal_mappings: [{
          external_subject_id: "external-admin",
          subject_id: "tenant-admin-1",
          role: "TENANT_ADMINISTRATOR",
          organization_ids: [],
        }],
      }],
      async verifyToken(token) {
        return {
          sub: "external-admin",
          azp: "management-client",
          ...(token === "scoped" ? { scope: "genioone-management" } : {}),
        }
      },
    }),
  })
  try {
    const denied = await inject(app, "unscoped", "GET", "/v1/tenants/tenant-acme/identity")
    assert.equal(denied.statusCode, 403, denied.body)
    assert.equal(denied.json().code, "INSUFFICIENT_SCOPE")
    const accepted = await inject(app, "scoped", "GET", "/v1/tenants/tenant-acme/identity")
    assert.equal(accepted.statusCode, 200, accepted.body)
  } finally {
    await app.close()
  }
})

test("an Organization Administrator cannot self-register a Gateway Runtime", async () => {
  const deps = dependencies()
  await seedGatewayRuntime(deps.modules, "client-tenant")
  const app = await createManagementApi({
    ...deps,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      "org-runtime-token": { ...principals["org-token"], scopes: ["genioone-gateway-runtime"] },
    }),
  })
  const registrationBody = {
    target_id: "gateway-target-auth-test",
    oidc_client_id: "client-tenant",
    report_key_id: "report-key-auth-test",
    report_public_key_pem: "not-used-after-role-check",
  }

  const response = await inject(
    app,
    "org-runtime-token",
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
  await deps.modules.runtimeControl.registerGatewayRuntime({
    tenantId: "tenant-acme",
    runtimeId,
    targetId: "gateway-self",
    oidcClientId: runtimeId,
    reportKeyId: "runtime-report-self",
    reportPublicKeyPem,
  })
  const app = await createManagementApi({
    ...deps,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      "runtime-self-token": {
        tenant_id: "tenant-acme",
        subject_id: "keycloak-service-account-subject",
        role: "USER",
        organization_ids: [],
        client_id: runtimeId,
        scopes: ["genioone-gateway-runtime"],
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

test("Gateway Runtime self-registration only replays its active provisioned trust binding", async () => {
  let timestamp = 100
  const modules = createInMemoryPlatformModules({ now: () => timestamp })
  const runtimeId = "gateway-bound-runtime"
  const reportPublicKeyPem = generateKeyPairSync("ed25519").publicKey
    .export({ type: "spki", format: "pem" }).toString()
  const replacementPublicKeyPem = generateKeyPairSync("ed25519").publicKey
    .export({ type: "spki", format: "pem" }).toString()
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      runtime: {
        tenant_id: "tenant-acme",
        subject_id: "service-account-bound-runtime",
        role: "USER",
        organization_ids: [],
        client_id: runtimeId,
        scopes: ["genioone-gateway-runtime"],
      },
    }),
  })
  const path = `/v1/tenants/tenant-acme/runtime-control/GATEWAY/${runtimeId}/registration`
  const body = {
    target_id: "gateway-bound-target",
    oidc_client_id: runtimeId,
    report_key_id: "bound-report-key",
    report_public_key_pem: reportPublicKeyPem,
  }
  const key = { tenantId: "tenant-acme", runtimeId }
  const trustedInput = {
    ...key,
    targetId: body.target_id,
    oidcClientId: runtimeId,
    reportKeyId: body.report_key_id,
    reportPublicKeyPem,
  }

  const unprovisioned = await inject(app, "runtime", "PUT", path, body)
  assert.equal(unprovisioned.statusCode, 404, unprovisioned.body)
  assert.equal(unprovisioned.json().code, "RUNTIME_REGISTRATION_NOT_FOUND")
  assert.equal(await modules.runtimeControl.getGatewayRuntime(key), null)

  const provisioned = await modules.runtimeControl.registerGatewayRuntime(trustedInput)
  for (const payload of [body, { ...body, status: "ACTIVE" }]) {
    timestamp += 1
    const replay = await inject(app, "runtime", "PUT", path, payload)
    assert.equal(replay.statusCode, 200, replay.body)
    assert.deepEqual(replay.json(), provisioned)
    assert.deepEqual(await modules.runtimeControl.getGatewayRuntime(key), provisioned)
  }

  for (const mutation of [
    { target_id: "other-gateway-target" },
    { oidc_client_id: "other-oidc-client" },
    { report_key_id: "replacement-report-key" },
    { report_public_key_pem: replacementPublicKeyPem },
    { report_public_key_pem: `${reportPublicKeyPem}\n` },
    { status: "DISABLED" },
    { status: "REVOKED" },
  ]) {
    timestamp += 1
    const rejected = await inject(app, "runtime", "PUT", path, { ...body, ...mutation })
    assert.equal(rejected.statusCode, 409, rejected.body)
    assert.equal(rejected.json().code, "RUNTIME_REGISTRATION_MISMATCH")
    assert.deepEqual(await modules.runtimeControl.getGatewayRuntime(key), provisioned)
  }

  for (const status of ["DISABLED", "REVOKED"] as const) {
    timestamp += 1
    const inactive = await modules.runtimeControl.registerGatewayRuntime({ ...trustedInput, status })
    for (const payload of [body, { ...body, status: "ACTIVE" }, { ...body, status }]) {
      timestamp += 1
      const rejected = await inject(app, "runtime", "PUT", path, payload)
      assert.equal(rejected.statusCode, 403, rejected.body)
      assert.equal(rejected.json().code, "RUNTIME_REGISTRATION_NOT_ACTIVE")
      assert.deepEqual(await modules.runtimeControl.getGatewayRuntime(key), inactive)
    }
  }
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
    scopes: ["genioone-gateway-runtime"],
  }
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      "runtime-token": runtimePrincipal,
      "wrong-runtime-token": { ...runtimePrincipal, client_id: "different-client" },
      "management-runtime-token": { ...runtimePrincipal, scopes: ["genioone-management"] },
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

  for (const [token, status, code] of [
    ["runtime-token", 201, undefined],
    ["wrong-runtime-token", 403, "RUNTIME_ACCESS_DENIED"],
    ["management-runtime-token", 403, "INSUFFICIENT_SCOPE"],
  ] as const) {
    const attempt = await inject(app, token, "POST", "/v1/tenants/tenant-acme/runtime-control/GATEWAY/gateway-auth-test/routing-attempts", {
      correlation_id: "routing-auth", attempt_id: "routing-auth-1", order: 1,
      connection_id: "connection-auth", connection_configuration_revision: 1, priority: 0,
      outcome: "SELECTED", response_started: false, occurred_at: 1,
    })
    assert.equal(attempt.statusCode, status, attempt.body)
    if (code) assert.equal(attempt.json().code, code)
  }
  for (const [token, code] of [
    ["runtime-token", "RUNTIME_RELEASE_REFERENCE_UNKNOWN"],
    ["wrong-runtime-token", "RUNTIME_ACCESS_DENIED"],
    ["management-runtime-token", "INSUFFICIENT_SCOPE"],
  ] as const) {
    const credentials = await inject(app, token, "GET", "/v1/tenants/tenant-acme/runtime-control/GATEWAY/gateway-auth-test/aggregate/releases/release-auth/credentials?command_id=command-auth")
    assert.equal(credentials.statusCode, 403, credentials.body)
    assert.equal(credentials.json().code, code)
  }
  for (const suffix of ["observed-state", "report-history"]) {
    const managementRead = await inject(app, "runtime-token", "GET", `/v1/tenants/tenant-acme/runtime-control/GATEWAY/gateway-auth-test/aggregate/${suffix}`)
    assert.equal(managementRead.statusCode, 403, managementRead.body)
    assert.equal(managementRead.json().code, "INSUFFICIENT_SCOPE")
  }


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

test("valid Gateway runtime token cannot report another Gateway's Connection health", async () => {
  const base = createInMemoryPlatformModules({ now: () => 100 })
  for (const [runtimeId, gatewayId] of [
    ["gateway-health-a", "gateway-a"],
    ["gateway-health-b", "gateway-b"],
  ] as const) {
    const { publicKey } = generateKeyPairSync("ed25519")
    await base.runtimeControl.registerGatewayRuntime({
      tenantId: "tenant-acme",
      runtimeId,
      targetId: gatewayId,
      oidcClientId: runtimeId,
      reportKeyId: `report-key-${runtimeId}`,
      reportPublicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    })
  }
  const state = createResourceMemoryState()
  const resources = createInMemoryResourceRegistry({ state, organizations: base.organizations, now: () => 100 })
  const connections = createInMemoryResourceConnectionRegistry({
    state,
    resources,
    providers: base.providers,
    now: () => 100,
    verifier: { verify: () => true },
  })
  const organization = await base.organizations.create({
    tenantId: "tenant-acme",
    display_name: "Health owner",
    slug: "health-owner",
  })
  const resource = await resources.createResource({
    tenantId: "tenant-acme",
    value: {
      display_name: "Health target",
      kind: "MCP",
      owner_organization_id: organization.organization_id,
      authentication_strategy: "NONE",
      environment_id: "local",
      version: "1.0.0",
      capabilities: [{ capability_id: "mcp.invoke", display_name: "Invoke" }],
      enforcement_point_id: "gateway-b",
    },
  })
  const connection = await connections.create({
    tenantId: "tenant-acme",
    resourceId: resource.resource_id,
    value: { display_name: "Backend", connection_kind: "MCP", endpoint: "https://backend.example.test" },
  })
  await connections.verify({ tenantId: "tenant-acme", resourceId: resource.resource_id, connectionId: connection.connection_id })
  state.resources.set(`tenant-acme:${resource.resource_id}`, { ...resource, lifecycle: "PUBLISHED" })
  state.publicationProjections.set(`tenant-acme:publication-health-b`, {
    tenant_id: "tenant-acme",
    resource_id: resource.resource_id,
    operation: "APPLY",
    publication_endpoint: { gateway_id: "gateway-b" },
  } as GatewayProjection)
  const runtimePrincipal = {
    tenant_id: "tenant-acme",
    subject_id: "gateway-runtime",
    role: "USER" as const,
    organization_ids: [],
    scopes: ["genioone-gateway-runtime"],
  }
  const app = await createManagementApi({
    modules: { ...base, connections },
    resourceCatalog: resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      "runtime-a-token": { ...runtimePrincipal, client_id: "gateway-health-a" },
      "runtime-b-token": { ...runtimePrincipal, client_id: "gateway-health-b" },
    }),
  })
  const observation = {
    correlation_id: "health-gateway-binding",
    source_revision: 2,
    state: "UNAVAILABLE",
    observed_at: 100,
  }
  const single = await inject(
    app,
    "runtime-a-token",
    "POST",
    `/v1/tenants/tenant-acme/resources/${resource.resource_id}/connections/${connection.connection_id}/health-observations`,
    observation,
  )
  assert.equal(single.statusCode, 403, single.body)
  assert.equal(single.json().code, "CONNECTION_HEALTH_TARGET_UNASSIGNED")
  const batchPath = "/v1/tenants/tenant-acme/runtime-control/GATEWAY/gateway-health-a/connection-health-observations"
  const batchBody = {
    correlation_id: "health-scan-gateway-binding",
    observations: [{
      resource_id: resource.resource_id,
      connection_id: connection.connection_id,
      source_revision: 2,
      state: "UNAVAILABLE",
      observed_at: 100,
    }],
  }
  const batch = await inject(app, "runtime-a-token", "POST", batchPath, batchBody)
  assert.equal(batch.statusCode, 403, batch.body)
  assert.equal(batch.json().code, "CONNECTION_HEALTH_TARGET_UNASSIGNED")
  assert.equal((await connections.get({ tenantId: "tenant-acme", resourceId: resource.resource_id, connectionId: connection.connection_id })).health_source_revision, 1)
  const targets = await inject(
    app,
    "runtime-a-token",
    "GET",
    "/v1/tenants/tenant-acme/runtime-control/GATEWAY/gateway-health-a/connection-health-targets",
  )
  assert.equal(targets.statusCode, 200, targets.body)
  assert.deepEqual(targets.json(), [])
  const valid = await inject(
    app,
    "runtime-b-token",
    "POST",
    "/v1/tenants/tenant-acme/runtime-control/GATEWAY/gateway-health-b/connection-health-observations",
    batchBody,
  )
  assert.equal(valid.statusCode, 200, valid.body)
  assert.equal((await connections.get({ tenantId: "tenant-acme", resourceId: resource.resource_id, connectionId: connection.connection_id })).health_source_revision, 2)
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
        scopes: ["genioone-gateway-runtime"],
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

test("Management API returns security response headers", async () => {
  const app = await createManagementApi(dependencies())
  const response = await app.inject({ method: "GET", url: "/healthz" })
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers["x-content-type-options"], "nosniff")
  assert.equal(response.headers["x-frame-options"], "DENY")
  assert.equal(response.headers["referrer-policy"], "strict-origin-when-cross-origin")
  assert.equal(response.headers["x-xss-protection"], "0")
  await app.close()
})
