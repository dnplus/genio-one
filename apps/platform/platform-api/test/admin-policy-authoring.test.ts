import assert from "node:assert/strict"
import test from "node:test"
import { createManagementApi } from "../src/app"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createDefaultOnePolicy } from "../src/capabilities/one-policy/default"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"
import { createPolicyDraftStore, defaultBotRules } from "../src/capabilities/one-policy/drafts"

const tenantId = "tenant-admin-ui"
const headers = { authorization: "Bearer admin" }

test("Bot policy draft is isolated, role protected, published with history and used by actual decisions", async () => {
  const modules = createInMemoryPlatformModules()
  const botAccessPolicy = createDefaultOnePolicy({ drafts: modules.policyDrafts as import("../src/capabilities/one-policy/drafts").MemoryPolicyDraftStore })
  const app = await createManagementApi({ modules: { ...modules, botAccessPolicy }, resourceCatalog: modules.resources, principalAuthenticator: createStaticPrincipalAuthenticator({
    admin: { tenant_id: tenantId, subject_id: "admin", client_id: "genio-one-bot", role: "TENANT_ADMINISTRATOR", organization_ids: [], scopes: ["genioone-management", "genioone-invocation"] },
    user: { tenant_id: tenantId, subject_id: "user", client_id: "genio-one-bot", role: "USER", organization_ids: [], scopes: ["genioone-management", "genioone-invocation"] },
  }) })
  const base = `/v1/tenants/${tenantId}/one-policy/first-party-bot`
  const decisionPath = `/v1/tenants/${tenantId}/one-policy/bot-access`
  try {
    const active = await app.inject({ method: "GET", url: base, headers })
    assert.equal(active.statusCode, 200)
    const content = { kind: "BOT_ACCESS", definition: { allowed_roles: [], allowed_subject_ids: [] } }
    const saved = await app.inject({ method: "PUT", url: `${base}/draft`, headers, payload: { expected_version: 0, base_revision: 1, content } })
    assert.equal(saved.statusCode, 200, saved.body)
    assert.equal((await app.inject({ method: "GET", url: decisionPath, headers })).json().decision, "ALLOW")
    const unauthorized = await app.inject({ method: "PUT", url: `${base}/draft`, headers: { authorization: "Bearer user" }, payload: { expected_version: 1, base_revision: 1, content } })
    assert.equal(unauthorized.statusCode, 403)
    const conflict = await app.inject({ method: "PUT", url: `${base}/draft`, headers, payload: { expected_version: 0, base_revision: 1, content } })
    assert.equal(conflict.statusCode, 409)
    const published = await app.inject({ method: "POST", url: `${base}/draft/publish`, headers, payload: { expected_version: 1 } })
    assert.equal(published.statusCode, 200, published.body)
    assert.equal(published.json().policy_revision, 2)
    assert.equal((await app.inject({ method: "GET", url: decisionPath, headers })).json().decision, "DENY")
    assert.equal((await app.inject({ method: "GET", url: `${base}/draft`, headers })).json(), null)
    const history = (await app.inject({ method: "GET", url: `${base}/revisions`, headers })).json()
    assert.equal(history[0].published_by, "admin")
    assert.deepEqual(history[1].rules, defaultBotRules)
    const stale = await app.inject({ method: "PUT", url: `${base}/draft`, headers, payload: { expected_version: 0, base_revision: 1, content } })
    assert.equal(stale.statusCode, 409)
  } finally { await app.close() }
})

test("draft stores isolate tenants and preserve a newer draft when an older publication completes", async () => {
  const store = createPolicyDraftStore()
  const first = await store.save("a", "policy", { expected_version: 0, base_revision: 1, content: { kind: "BOT_ACCESS", definition: defaultBotRules } })
  assert.equal(await store.get("b", "policy"), null)
  const second = await store.save("a", "policy", { expected_version: first.version, base_revision: 1, content: { kind: "BOT_ACCESS", definition: { allowed_roles: [], allowed_subject_ids: [] } } })
  await store.remove("a", "policy", first.version)
  assert.equal((await store.get("a", "policy"))?.version, second.version)
})

test("Resource policy draft survives editor reload, validates on publish and becomes one immutable enforcement revision", async () => {
  const modules = createInMemoryPlatformModules()
  const organization = await modules.organizations.create({ tenantId, display_name: "QA", slug: "qa" })
  const resource = await modules.resources.createResource({ tenantId, value: { display_name: "QA MCP", kind: "MCP", owner_organization_id: organization.organization_id, authentication_strategy: "OAUTH", environment_id: "test", version: "v1", capabilities: [{ capability_id: "read", display_name: "Read" }], enforcement_point_id: "ai-gateway" } })
  const connection = await modules.connections.create({ tenantId, resourceId: resource.resource_id, value: { display_name: "QA upstream", connection_kind: "MCP", endpoint: "https://qa.example.test/mcp", supported_obligations: [] } })
  await modules.connections.verify({ tenantId, resourceId: resource.resource_id, connectionId: connection.connection_id })
  const app = await createManagementApi({ modules, resourceCatalog: modules.resources, principalAuthenticator: createStaticPrincipalAuthenticator({ admin: { tenant_id: tenantId, subject_id: "admin", client_id: "console", role: "TENANT_ADMINISTRATOR", organization_ids: [], scopes: ["genioone-management"] } }) })
  const base = `/v1/tenants/${tenantId}/resources/${resource.resource_id}/capabilities/read`
  const definition = { one_policy_revision: 1, eligible_connection_ids: [connection.connection_id], steps: [
    { step_id: "authenticate", kind: "AUTHENTICATE", phase: "REQUEST", implementation: "NATIVE", config: { schema_version: "genio.one.auth.jwt.v1", provider: "keycloak", issuer: "https://identity.example.test", audiences: ["genio-one"], remote_jwks_uri: "https://identity.example.test/jwks", subject_claim: "sub", client_claim: "azp" } },
    { step_id: "authorize", kind: "AUTHORIZE", phase: "REQUEST", implementation: "EXT_AUTH", depends_on: ["authenticate"] },
    { step_id: "route", kind: "ROUTE", phase: "ROUTING", implementation: "AIGW_NATIVE", depends_on: ["authorize"] },
  ] }
  try {
    const saved = await app.inject({ method: "PUT", url: `${base}/policy-draft`, headers, payload: { expected_version: 0, base_revision: 0, content: { kind: "RESOURCE_CAPABILITY", definition } } })
    assert.equal(saved.statusCode, 200, saved.body)
    assert.equal((await app.inject({ method: "GET", url: `${base}/enforcement-chain`, headers })).statusCode, 404)
    const reloaded = await app.inject({ method: "GET", url: `${base}/policy-draft`, headers })
    assert.deepEqual(reloaded.json().content.definition, definition)
    const published = await app.inject({ method: "POST", url: `${base}/policy-draft/publish`, headers, payload: { expected_version: 1 } })
    assert.equal(published.statusCode, 200, published.body)
    assert.equal(published.json().one_policy_revision, 1)
    assert.equal((await app.inject({ method: "GET", url: `${base}/enforcement-chain`, headers })).json().chain_digest, published.json().chain_digest)
    assert.equal((await app.inject({ method: "GET", url: `${base}/policy-draft`, headers })).json(), null)
    await modules.resources.updateResource({ tenantId, resourceId: resource.resource_id, value: { documentation: "Saved documentation" } })
    assert.equal((await modules.resources.getResource({ tenantId, resourceId: resource.resource_id })).documentation, "Saved documentation")
  } finally { await app.close() }
})
