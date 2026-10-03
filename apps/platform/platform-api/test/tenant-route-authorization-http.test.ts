import assert from "node:assert/strict"
import test from "node:test"
import type { FastifyRequest } from "fastify"

import { createManagementApi } from "../src/app"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { resourcePolicyKey } from "../src/capabilities/one-policy/drafts"
import { createCanonicalPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/canonical"
import type { Principal } from "../src/capabilities/tenancy-auth/contract"
import {
  createEnvironmentPrincipalAuthenticator,
  createStaticPrincipalAuthenticator,
} from "../src/capabilities/tenancy-auth/memory"
import { tenantRoute } from "../src/capabilities/tenancy-auth/routes"

const tenantId = "tenant-acme"
const managementPrincipal: Principal = {
  tenant_id: tenantId,
  subject_id: "person-admin",
  role: "TENANT_ADMINISTRATOR",
  organization_ids: [],
  client_id: "management-console",
  scopes: ["genioone-management"],
}
const draftPath = `/v1/tenants/${tenantId}/resources/resource-1/capabilities/chat/policy-draft`

function principal(scopes: string[] | undefined, role: Principal["role"] = "TENANT_ADMINISTRATOR"): Principal {
  const { scopes: _scopes, ...identity } = managementPrincipal
  return { ...identity, role, ...(scopes === undefined ? {} : { scopes }) }
}

async function api(principals: Record<string, Principal> = { management: managementPrincipal }) {
  const modules = createInMemoryPlatformModules()
  const owner = await modules.organizations.create({ tenantId, display_name: "Regression owner" })
  await modules.resources.createResource({ tenantId, resourceId: "resource-1", value: {
    display_name: "Regression Resource", kind: "LLM", owner_organization_id: owner.organization_id,
    authentication_strategy: "OAUTH", environment_id: "test", version: "1.0.0",
    enforcement_point_id: "gateway-test",
  } })
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator(principals),
    webHtml: "<html><body>GenioOne</body></html>",
    browserIdentity: {
      tenant_id: tenantId, issuer: "https://identity.example.test",
      authorization_endpoint: "https://identity.example.test/authorize",
      token_endpoint: "https://identity.example.test/token", client_id: "invocation-client",
      scopes: ["genioone-invocation"], management_client_id: "management-console",
      management_scopes: ["genioone-management"],
    },
  })
  return { app, modules }
}

test("invalid tenant and capability segments fail closed before a readable handler", async () => {
  const { app } = await api()
  try {
    const paths = [
      "/v1/tenants/tenant%2Facme/resources/resource-1/capabilities/chat/policy-draft",
      "/v1/tenants/tenant%5cacme/resources/resource-1/capabilities/chat/policy-draft",
      "/v1/tenants/%2e/resources/resource-1/capabilities/chat/policy-draft",
      "/v1/tenants/%2e%2e/resources/resource-1/capabilities/chat/policy-draft",
      draftPath.replace("/chat/", "/chat%2Fread/"),
      draftPath.replace("/chat/", "/chat%5cread/"),
      draftPath.replace("/chat/", "/%2e/"),
      draftPath.replace("/chat/", "/%2e%2e/"),
      draftPath.replace("/chat/", "/chat%00read/"),
      draftPath.replace("/chat/", "/chat\\read/"),
      draftPath.replace("/chat/", "/%ZZ/"),
    ]
    for (const url of paths) {
      assert.throws(() => tenantRoute({ url }), { code: "INVALID_TENANT_PATH", statusCode: 400 })
      const normalizedPath = new URL(url, "http://platform.example.test").pathname
      for (const headers of [{}, { authorization: "Bearer management" }]) {
        const response = await app.inject({ method: "GET", url, headers })
        if (normalizedPath === url) assert.equal(response.statusCode, 400, `${url}: ${response.body}`)
        else assert.ok([400, 401, 403, 404].includes(response.statusCode), `${url}: ${response.body}`)
      }
    }
    const anonymous = await app.inject({ method: "GET", url: draftPath })
    assert.equal(anonymous.statusCode, 401, anonymous.body)
    const authorized = await app.inject({
      method: "GET", url: draftPath, headers: { authorization: "Bearer management" },
    })
    assert.equal(authorized.statusCode, 200, authorized.body)
    assert.equal(authorized.json(), null)
  } finally {
    await app.close()
  }
})

test("encoded static segments cannot enter tenant handlers anonymously", async () => {
  const { app } = await api()
  try {
    for (const url of [
      draftPath.replace("/v1/", "/%761/"),
      draftPath.replace("/tenants/", "/%74enants/"),
      draftPath.replace("/resources/", "/%72esources/"),
      draftPath.replace("/policy-draft", "/%70olicy-draft"),
      draftPath.replace("/resources/", "/%2572esources/"),
    ]) {
      const response = await app.inject({ method: "GET", url })
      assert.ok([400, 401, 404].includes(response.statusCode), `${url}: ${response.body}`)
    }
  } finally {
    await app.close()
  }
})

test("a matched tenant route rejects an invalid raw path instead of becoming public", () => {
  for (const url of ["/%ZZ/tenants/tenant-acme/resources", "/unexpected/path", "/v1/tenants/tenant-acme/resources/chat%2fread"]) {
    assert.throws(() => tenantRoute({
      url,
      routeOptions: { url: "/v1/tenants/:tenant_id/resources/:resource_id" },
    }), { code: "INVALID_TENANT_PATH", statusCode: 400 })
  }
  assert.deepEqual(tenantRoute({ url: "/v1/tenants/tenant-acme/resources?next=/runtime-control/" }), {
    tenantId, rest: ["resources"],
  })
})

test("health, web entry points, and the public federation exchange keep their boundaries", async () => {
  const { app } = await api()
  try {
    for (const url of ["/healthz", "/management", "/self-service"]) {
      const response = await app.inject({ method: "GET", url })
      assert.equal(response.statusCode, 200, response.body)
    }
    const response = await app.inject({
      method: "POST", url: `/v1/tenants/${tenantId}/sts/token-exchange`, payload: {},
    })
    assert.equal(response.statusCode, 400, response.body)
    assert.notEqual(response.json().code, "UNAUTHENTICATED")
    assert.notEqual(response.json().code, "INSUFFICIENT_SCOPE")
  } finally {
    await app.close()
  }
})

for (const authenticatorKind of ["static", "environment", "delegate"] as const) {
  test(`scope absence and empty scopes are denied for the ${authenticatorKind} authenticator`, async () => {
    const modules = createInMemoryPlatformModules()
    const callers = { missing: principal(undefined), empty: principal([]) }
    const principalAuthenticator = authenticatorKind === "static"
      ? createStaticPrincipalAuthenticator(callers)
      : authenticatorKind === "environment"
        ? createEnvironmentPrincipalAuthenticator({
          NODE_ENV: "test", GENIO_ONE_MANAGEMENT_API_AUTH_MODE: "static-dev",
          GENIO_ONE_MANAGEMENT_API_PRINCIPALS_JSON: JSON.stringify(callers),
        })
        : { authenticate: ({ token }: { token: string }) => callers[token as keyof typeof callers] ?? null }
    const app = await createManagementApi({ modules, resourceCatalog: modules.resources, principalAuthenticator })
    try {
      for (const token of ["missing", "empty"]) {
        for (const url of [`/v1/tenants/${tenantId}/resources`, `/v1/tenants/${tenantId}/me`]) {
          const response = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } })
          assert.equal(response.statusCode, 403, response.body)
          assert.equal(response.json().code, "INSUFFICIENT_SCOPE")
        }
      }
    } finally {
      await app.close()
    }
  })
}

test("audit export requires both management and audit.export while preserving administrator checks", async () => {
  const { app } = await api({
    management: principal(["genioone-management"]),
    export: principal(["audit.export"]),
    allowed: principal(["genioone-management", "audit.export"]),
    user: principal(["genioone-management", "audit.export"], "USER"),
  })
  try {
    for (const [token, status, code] of [
      ["management", 403, "INSUFFICIENT_SCOPE"],
      ["export", 403, "INSUFFICIENT_SCOPE"],
      ["allowed", 200, undefined],
      ["user", 403, "TENANT_ADMINISTRATOR_REQUIRED"],
    ] as const) {
      for (const method of ["GET", "HEAD"] as const) {
        const response = await app.inject({
          method, url: `/v1/tenants/${tenantId}/audit-export?from=0&to=1&resource_id=resource-1`,
          headers: { authorization: `Bearer ${token}` },
        })
        assert.equal(response.statusCode, status, response.body)
        if (code && method === "GET") assert.equal(response.json().code, code)
      }
    }
  } finally {
    await app.close()
  }
})

test("application creation requires both management and application.create and preserves ownership checks", async () => {
  const { app, modules } = await api({
    management: principal(["genioone-management"]),
    create: principal(["application.create"]),
    allowed: principal(["genioone-management", "application.create"]),
    user: principal(["genioone-management", "application.create"], "USER"),
  })
  try {
    const organization = await modules.organizations.create({ tenantId, display_name: "Owner", member_subject_ids: [] })
    for (const [token, status, code] of [
      ["management", 403, "INSUFFICIENT_SCOPE"],
      ["create", 403, "INSUFFICIENT_SCOPE"],
      ["user", 403, "RESOURCE_OWNER_OR_TENANT_ADMIN_REQUIRED"],
      ["allowed", 201, undefined],
    ] as const) {
      const response = await app.inject({
        method: "POST", url: `/v1/tenants/${tenantId}/applications`,
        headers: { authorization: `Bearer ${token}` },
        payload: { display_name: `Application ${token}`, owner_organization_id: organization.organization_id },
      })
      assert.equal(response.statusCode, status, response.body)
      if (code) assert.equal(response.json().code, code)
    }
    const applications = await modules.applications.list({ tenantId })
    assert.equal(applications.length, 1)
  } finally {
    await app.close()
  }
})

test("a query or Resource id mentioning runtime-control cannot bypass canonical suspension", async () => {
  const modules = createInMemoryPlatformModules()
  await modules.identity.bootstrap({ tenantId, subjects: [{ subject_id: "person-admin", kind: "PERSON", role: "TENANT_ADMINISTRATOR" }] })
  await modules.identity.suspend({ tenantId, subjectId: "person-admin", suspendedBy: "person-other", value: {} })
  const principalAuthenticator = createCanonicalPrincipalAuthenticator({
    delegate: createStaticPrincipalAuthenticator({ management: managementPrincipal }),
    identity: modules.identity,
    organizations: modules.organizations,
  })
  const app = await createManagementApi({ modules, resourceCatalog: modules.resources, principalAuthenticator })
  try {
    for (const url of [
      `/v1/tenants/${tenantId}/resources?next=/runtime-control/`,
      draftPath.replace("/resource-1/", "/runtime-control/"),
      `/v1/tenants/${tenantId}/runtime-control/GATEWAY/gateway-1/activities`,
    ]) {
      const response = await app.inject({ method: "GET", url, headers: { authorization: "Bearer management" } })
      assert.equal(response.statusCode, 401, `${url}: ${response.body}`)
      assert.equal(response.json().code, "UNAUTHENTICATED")
    }
  } finally {
    await app.close()
  }
})

test("canonical authentication preserves Gateway transport and registration identities", async () => {
  const modules = createInMemoryPlatformModules()
  const runtime = principal(["genioone-gateway-runtime"], "USER")
  await modules.identity.bootstrap({ tenantId, subjects: [{ subject_id: runtime.subject_id, kind: "PERSON" }] })
  await modules.identity.suspend({ tenantId, subjectId: runtime.subject_id, suspendedBy: "person-other", value: {} })
  const authenticator = createCanonicalPrincipalAuthenticator({
    delegate: { authenticate: () => runtime }, identity: modules.identity, organizations: modules.organizations,
  })
  for (const [method, suffix] of [
    ["PUT", "registration"], ["PUT", "capabilities"], ["POST", "activities"],
    ["GET", "aggregate/connect"], ["GET", "aggregate/commands/next"],
    ["POST", "routing-attempts"], ["GET", "aggregate/releases/release-1/credentials"],
  ]) {
    const request = { method, url: `/v1/tenants/${tenantId}/runtime-control/GATEWAY/gateway-1/${suffix}` } as FastifyRequest
    assert.deepEqual(await authenticator.authenticate({ token: "runtime", tenantId, request }), runtime)
  }
})


test("double encoding preserves literal identifiers while enforcing authentication", async () => {
  const { app, modules } = await api()
  const keys: string[] = []
  const get = modules.policyDrafts.get
  modules.policyDrafts.get = async (selectedTenant, key) => {
    assert.equal(selectedTenant, tenantId)
    keys.push(key)
    return get(selectedTenant, key)
  }
  try {
    for (const capability of ["chat%2Fread", "chat%5cread", "%2e", "%2e%2e"]) {
      const url = draftPath.replace("/chat/", `/${encodeURIComponent(capability)}/`)
      const anonymous = await app.inject({ method: "GET", url })
      assert.equal(anonymous.statusCode, 401, `${url}: ${anonymous.body}`)
      const authorized = await app.inject({ method: "GET", url, headers: { authorization: "Bearer management" } })
      assert.equal(authorized.statusCode, 200, `${url}: ${authorized.body}`)
      assert.equal(authorized.json(), null)
      assert.equal(keys.at(-1), resourcePolicyKey("resource-1", capability))
      assert.deepEqual(tenantRoute({ url }), { tenantId, rest: ["resources", "resource-1", "capabilities", capability, "policy-draft"] })
    }
    const literalTenant = "/v1/tenants/tenant%252Facme/resources/resource-1/capabilities/chat/policy-draft"
    assert.equal((await app.inject({ method: "GET", url: literalTenant })).statusCode, 401)
    const crossTenant = await app.inject({ method: "GET", url: literalTenant, headers: { authorization: "Bearer management" } })
    assert.equal(crossTenant.statusCode, 403, crossTenant.body)
    assert.equal(crossTenant.json().code, "TENANT_ACCESS_DENIED")
  } finally {
    await app.close()
  }
})

test("browser identity session requires an explicit browser scope without adding configured scopes", async () => {
  const { app } = await api({
    missing: principal(undefined), empty: principal([]), runtime: principal(["genioone-gateway-runtime"]),
    management: principal(["genioone-management"]), invocation: principal(["genioone-invocation"]),
  })
  try {
    for (const token of ["missing", "empty", "runtime"]) {
      const response = await app.inject({ method: "GET", url: "/v1/identity/session", headers: { authorization: `Bearer ${token}` } })
      assert.equal(response.statusCode, 403, response.body)
      assert.equal(response.json().code, "INSUFFICIENT_SCOPE")
    }
    for (const [token, scope] of [["management", "genioone-management"], ["invocation", "genioone-invocation"]]) {
      const response = await app.inject({ method: "GET", url: "/v1/identity/session", headers: { authorization: `Bearer ${token}` } })
      assert.equal(response.statusCode, 200, response.body)
      assert.deepEqual(response.json().scopes, [scope])
    }
  } finally {
    await app.close()
  }
})
