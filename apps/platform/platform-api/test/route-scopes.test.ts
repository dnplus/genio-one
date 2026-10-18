import assert from "node:assert/strict"
import test from "node:test"
import { GENIOONE_SCOPES, MANAGEMENT_SCOPES, hasAnyScope } from "@genioone/protocol/authorization-scopes"
import { createManagementApi } from "../src/app"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { requiredPlatformRouteScopes, platformRouteScopeRequirements } from "../src/capabilities/management-authorization/route-scopes"

function required(path: string, method = "GET", body?: unknown) {
  return requiredPlatformRouteScopes({ rest: path.split("/").filter(Boolean) }, method, body)
}

test("General read and write scopes never authorize management reads or mutations", () => {
  for (const [path, method] of [["identity", "GET"], ["organizations", "POST"], ["resources/r1", "GET"], ["resources/r1", "PATCH"], ["one-policy/first-party-bot/draft", "PUT"], ["applications/a1/api-credentials", "POST"]]) {
    assert.equal(hasAnyScope([GENIOONE_SCOPES.read, GENIOONE_SCOPES.write, GENIOONE_SCOPES.invoke], required(path!, method!)), false)
  }
})

test("A management scope grants only its own domain and operation", () => {
  assert.equal(hasAnyScope([MANAGEMENT_SCOPES.identityRead], required("identity")), true)
  assert.equal(hasAnyScope([MANAGEMENT_SCOPES.identityRead], required("identity/subjects", "POST")), false)
  assert.equal(hasAnyScope([MANAGEMENT_SCOPES.identityWrite], required("applications/a1/api-credentials", "POST")), false)
  assert.equal(hasAnyScope([MANAGEMENT_SCOPES.resourcesWrite], required("resources/r1/capabilities/c1/policy-draft", "PUT")), false)
})

test("Policy editing cannot approve, publish, or change effective policy revisions", () => {
  for (const [path, method, body] of [
    ["one-policy/first-party-bot/draft/publish", "POST", undefined],
    ["one-policy/first-party-bot/draft/review", "POST", undefined],
    ["one-policy/first-party-bot", "PATCH", { enabled: false }],
    ["resources/r1/capabilities/c1/model-routing-policy", "PUT", {}],
    ["resources/r1/publication-requests/p1/review", "POST", {}],
    ["resources/r1/lifecycle", "POST", { lifecycle: "PUBLISHED" }],
    ["configuration-revisions/2/publish", "POST", {}],
  ] as const) {
    const scopes = required(path, method, body)
    assert.equal(hasAnyScope([MANAGEMENT_SCOPES.policiesWrite, MANAGEMENT_SCOPES.resourcesWrite, MANAGEMENT_SCOPES.systemWrite], scopes), false)
    assert.equal(hasAnyScope([MANAGEMENT_SCOPES.policiesPublish], scopes), true)
  }
  assert.equal(hasAnyScope([MANAGEMENT_SCOPES.policiesWrite], required("one-policy/first-party-bot/draft", "PUT")), true)
})

test("Access configuration does not approve requests or issue grants", () => {
  for (const path of ["access-requests/r1/decision", "execution-grant-requests/r1/decision", "entitlements", "agent-delegations"]) {
    assert.equal(hasAnyScope([MANAGEMENT_SCOPES.accessWrite], required(path, "POST")), false)
    assert.equal(hasAnyScope([MANAGEMENT_SCOPES.accessApprove], required(path, "POST")), true)
  }
  assert.equal(hasAnyScope([MANAGEMENT_SCOPES.accessWrite], required("agent-delegations/d1/revoke", "POST")), true)
})

test("Audit read never grants export", () => {
  assert.equal(hasAnyScope([MANAGEMENT_SCOPES.auditRead], required("audit-events")), true)
  assert.equal(hasAnyScope([MANAGEMENT_SCOPES.auditRead], required("audit-export")), false)
  assert.equal(hasAnyScope([MANAGEMENT_SCOPES.auditExport], required("audit-export")), true)
})

test("Model invocation is distinct from data reads and mutations", () => {
  for (const path of ["model-routing/resolve", "invocations/authorize", "one-policy/runtime-authorize", "one-policy/runtime-report"]) {
    assert.equal(hasAnyScope([GENIOONE_SCOPES.read, GENIOONE_SCOPES.write, MANAGEMENT_SCOPES.policiesWrite], required(path, "POST")), false)
    assert.equal(hasAnyScope([GENIOONE_SCOPES.invoke], required(path, "POST")), true)
  }
})

test("User scopes permit only the corresponding self-service operation", () => {
  assert.equal(hasAnyScope([GENIOONE_SCOPES.read], required("catalog")), true)
  assert.equal(hasAnyScope([GENIOONE_SCOPES.read], required("me/agents", "POST")), false)
  assert.equal(hasAnyScope([GENIOONE_SCOPES.write], required("me/agents", "POST")), true)
  assert.equal(hasAnyScope([GENIOONE_SCOPES.invoke], required("catalog")), false)
  assert.equal(hasAnyScope([GENIOONE_SCOPES.write], required("knowledge-candidates/k1/evidence")), false)
})

test("Missing, legacy, unrelated and unknown-route scopes fail closed", () => {
  assert.equal(hasAnyScope(undefined, required("identity")), false)
  assert.equal(hasAnyScope([], required("identity")), false)
  assert.equal(hasAnyScope(["genioone-management"], required("identity")), false)
  assert.equal(hasAnyScope(["genioone-invocation"], required("catalog")), false)
  assert.equal(hasAnyScope([MANAGEMENT_SCOPES.systemRead], required("unclassified-management-route")), false)
})


test("Every registered tenant operation has a deliberate nonempty permission mapping", async () => {
  const modules = createInMemoryPlatformModules()
  const app = await createManagementApi({ modules, resourceCatalog: modules.resources, principalAuthenticator: { authenticate: async () => null } })
  try {
    await app.ready()
    const paths = app.swagger().paths ?? {}
    let checked = 0
    for (const [path, operations] of Object.entries(paths)) {
      const segments = path.split("/").filter(Boolean)
      if (segments[0] !== "v1" || segments[1] !== "tenants" || segments[2] !== "{tenant_id}") continue
      const rest = segments.slice(3)
      for (const method of Object.keys(operations ?? {})) {
        if (!["get", "head", "post", "put", "patch", "delete"].includes(method)) continue
        if (rest[0] === "sts" && rest[1] === "token-exchange") continue
        assert.ok(requiredPlatformRouteScopes({ rest }, method.toUpperCase()).length > 0, `${method.toUpperCase()} ${path} has no scope mapping`)
        checked += 1
      }
    }
    assert.ok(checked > 100, `Expected published tenant operations, checked ${checked}`)
  } finally {
    await app.close()
  }
})

test("native memory MCP scopes follow the registered tool action and exact REST paths", () => {
  const mcp = { rest: ["memory", "mcp"] }
  for (const name of ["memory_list", "memory_retrieve", "memory_get", "memory_scope_list"]) {
    assert.deepEqual(requiredPlatformRouteScopes(mcp, "POST", { method: "tools/call", params: { name } }), [GENIOONE_SCOPES.read])
  }
  for (const name of ["memory_remember", "memory_forget"]) {
    assert.deepEqual(requiredPlatformRouteScopes(mcp, "POST", { method: "tools/call", params: { name } }), [GENIOONE_SCOPES.write])
  }
  assert.deepEqual(requiredPlatformRouteScopes({ rest: ["organizations", "owner", "memories"] }, "GET"), [GENIOONE_SCOPES.read])
  assert.deepEqual(requiredPlatformRouteScopes({ rest: ["organizations", "owner", "memories"] }, "POST"), [GENIOONE_SCOPES.write])
  assert.deepEqual(requiredPlatformRouteScopes({ rest: ["organizations", "owner", "memories", "entry", "corrections", "proposal", "review", "extra"] }, "POST"), [MANAGEMENT_SCOPES.identityWrite])
})

test("native memory batch consent must cover every message", () => {
  const route = { rest: ["memory", "mcp"] }
  const read = { method: "tools/call", params: { name: "memory_list" } }
  const write = { method: "tools/call", params: { name: "memory_remember" } }
  const requirements = platformRouteScopeRequirements(route, "POST", [read, write])
  assert.deepEqual(requirements, [[GENIOONE_SCOPES.read], [GENIOONE_SCOPES.write]])
  assert.equal(requirements.every(scopes => hasAnyScope([GENIOONE_SCOPES.read], scopes)), false)
  assert.equal(requirements.every(scopes => hasAnyScope([GENIOONE_SCOPES.write], scopes)), false)
  assert.equal(requirements.every(scopes => hasAnyScope([GENIOONE_SCOPES.read, GENIOONE_SCOPES.write], scopes)), true)
  assert.deepEqual(platformRouteScopeRequirements(route, "POST", []), [[]])
})
