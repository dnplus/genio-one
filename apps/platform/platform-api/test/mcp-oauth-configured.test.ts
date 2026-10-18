import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import { canonicalizeDownstreamIdentity } from "../src/capabilities/connections/contract"
import { PlatformApiError } from "../src/capabilities/errors"
import { createInMemoryResourceConnectionRegistry } from "../src/capabilities/connections/memory"
import { createInMemoryOrganizationDirectory } from "../src/capabilities/organizations/memory"
import { createInMemoryProviderProfileCatalog } from "../src/capabilities/providers/memory"
import { createInMemoryResourceRegistry } from "../src/capabilities/resources/memory"
import { createResourceMemoryState } from "../src/capabilities/resources/state"
import type { ResourceConnectionRegistry } from "../src/capabilities/connections/module"
import { createInMemoryMcpOAuthStore } from "../src/capabilities/mcp-oauth/memory"
import { createMcpOAuthSecretCodec } from "../src/capabilities/mcp-oauth/crypto"
import { createMcpOAuthService } from "../src/capabilities/mcp-oauth/module"
import { exchangeConfiguredCode } from "../src/capabilities/mcp-oauth/configured-client"

const client = {
  issuer: "https://acme.service-now.com",
  authorization_endpoint: "https://acme.service-now.com/oauth_auth.do",
  token_endpoint: "https://acme.service-now.com/oauth_token.do",
  client_id: "registered-client",
  scopes: ["useraccount"],
}

test("pre-registered OAuth uses PKCE, seals credentials in CP and scopes access to the user", async () => {
  const store = createInMemoryMcpOAuthStore()
  const codec = createMcpOAuthSecretCodec(Buffer.alloc(32, 9))
  let codeVerifier = ""
  let now = 1000
  const connection = { connection_kind: "MCP", endpoint: "https://connector.internal/mcp", downstream_identity: { mode: "USER_OAUTH", oauth_client: client } }
  const service = createMcpOAuthService({
    store, codec,
    connections: { async get() { return connection } } as unknown as ResourceConnectionRegistry,
    identity: { async canonicalSubjectId(input) { return input.subjectId } },
    publicOrigin: "https://cp.example.com",
    managementUiOrigin: "https://ui.example.com",
    now: () => now,
    exchangeConfiguredCode: async (input) => {
      assert.equal(input.code, "one-use-code")
      assert.equal(input.redirectUri, "https://cp.example.com/v1/mcp-oauth/callback")
      codeVerifier = input.verifier
      return { access_token: "access-one", refresh_token: "refresh-one", expires_in: 60, token_type: "Bearer", issuer: client.issuer }
    },
    refreshAuthorization: async (_url, options) => {
      assert.equal(options.refreshToken, "refresh-one")
      return { access_token: "access-two", expires_in: 3600, token_type: "Bearer" }
    },
  })
  const identity = { tenantId: "tenant-one", resourceId: "servicenow", connectionId: "connection-one", subjectId: "user-one" }
  const start = await service.start(identity)
  const authorization = new URL(start.authorization_url)
  assert.equal(authorization.origin, client.issuer)
  assert.equal(authorization.searchParams.get("client_id"), client.client_id)
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256")
  const state = authorization.searchParams.get("state")!
  const result = await service.complete({ state, code: "one-use-code", iss: client.issuer })
  assert.equal(new URL(result).searchParams.get("mcp_oauth"), "connected")
  assert.equal(authorization.searchParams.get("code_challenge"), createHash("sha256").update(codeVerifier).digest("base64url"))
  const saved = await store.getBinding(identity)
  assert.ok(saved)
  assert.equal(saved.sealed_state.includes("refresh-one"), false)
  assert.equal(JSON.stringify(await service.status(identity)).includes("access-one"), false)
  await assert.rejects(service.resolveAccessToken({ ...identity, subjectId: "user-two" }))
  await assert.rejects(service.resolveAccessToken({ ...identity, tenantId: "tenant-two" }))
  assert.equal((await service.resolveAccessToken(identity)).accessToken, "access-one")
  now = 1070
  assert.equal((await service.resolveAccessToken(identity)).accessToken, "access-two")
  const refreshed = await store.getBinding(identity)
  assert.equal(codec.open<{ tokens: { refresh_token: string } }>(refreshed!.sealed_state).tokens.refresh_token, "refresh-one")
  await service.disconnect(identity)
  await assert.rejects(service.resolveAccessToken(identity))
  await assert.rejects(service.complete({ state, code: "one-use-code" }))
})

test("configured OAuth completion retains separate bindings for equal Connection IDs on different Resources", async () => {
  const store = createInMemoryMcpOAuthStore()
  const codec = createMcpOAuthSecretCodec(Buffer.alloc(32, 13))
  const service = createMcpOAuthService({
    store,
    codec,
    connections: {
      async get(input: { resourceId: string }) {
        return {
          connection_kind: "MCP",
          endpoint: `https://connector.test/${input.resourceId}`,
          downstream_identity: { mode: "USER_OAUTH", oauth_client: client },
        }
      },
    } as unknown as ResourceConnectionRegistry,
    identity: { async canonicalSubjectId(input) { return input.subjectId } },
    publicOrigin: "https://cp.test",
    managementUiOrigin: "https://ui.test",
    exchangeConfiguredCode: async (input) => ({
      access_token: `token-${input.code}`,
      token_type: "Bearer",
      issuer: client.issuer,
    }),
  })
  const ownerOne = { tenantId: "tenant", resourceId: "resource-one", connectionId: "shared", subjectId: "alice" }
  const ownerTwo = { ...ownerOne, resourceId: "resource-two" }
  for (const owner of [ownerOne, ownerTwo]) {
    const authorization = await service.start(owner)
    const state = new URL(authorization.authorization_url).searchParams.get("state")!
    await service.complete({ state, code: owner.resourceId })
  }

  assert.equal((await service.resolveAccessToken(ownerOne)).accessToken, "token-resource-one")
  assert.equal((await service.resolveAccessToken(ownerTwo)).accessToken, "token-resource-two")
  assert.equal((await service.status(ownerOne))?.resource_id, ownerOne.resourceId)
  assert.equal((await service.status(ownerTwo))?.resource_id, ownerTwo.resourceId)
  assert.equal((await store.getBinding(ownerOne))?.resource_id, ownerOne.resourceId)
  assert.equal((await store.getBinding(ownerTwo))?.resource_id, ownerTwo.resourceId)
  await service.disconnect(ownerOne)
  await assert.rejects(service.resolveAccessToken(ownerOne), /MCP_OAUTH_AUTHORIZATION_REQUIRED/)
  assert.equal((await service.resolveAccessToken(ownerTwo)).accessToken, "token-resource-two")
})

test("OAuth endpoints cannot redirect credentials to another origin or use another identity mode", () => {
  assert.ok(canonicalizeDownstreamIdentity({ mode: "USER_OAUTH", oauth_client: client }))
  assert.equal(canonicalizeDownstreamIdentity({ mode: "SERVICE", authentication: "API_KEY", oauth_client: client }), null)
  assert.equal(canonicalizeDownstreamIdentity({ mode: "USER_OAUTH", oauth_client: { ...client, token_endpoint: "https://other.example.com/token" } }), null)
  assert.equal(canonicalizeDownstreamIdentity({ mode: "USER_OAUTH", oauth_client: { ...client, authorization_endpoint: "http://acme.service-now.com/authorize" } }), null)
})

test("configured token exchange sends PKCE without redirects and normalizes provider expiry", async () => {
  const token = await exchangeConfiguredCode({
    client, code: "code", verifier: "verifier", redirectUri: "https://cp.example.com/callback",
    request: async (url, init) => {
      assert.equal(url, client.token_endpoint)
      assert.equal(init.redirect, "error")
      const form = init.body as URLSearchParams
      assert.equal(form.get("code_verifier"), "verifier")
      assert.equal(form.get("grant_type"), "authorization_code")
      return Response.json({ access_token: "access", token_type: "Bearer", expires_in: "3600" })
    },
  })
  assert.equal(token.expires_in, 3600)
})

test("a connector site change cannot reuse or refresh an earlier site's OAuth token", async () => {
  const store = createInMemoryMcpOAuthStore()
  const codec = createMcpOAuthSecretCodec(Buffer.alloc(32, 8))
  const owner = { tenantId: "tenant", resourceId: "resource", connectionId: "connection", subjectId: "person" }
  let endpoint = "https://connector.test/mcp/site-a"
  let refreshCalls = 0
  const service = createMcpOAuthService({ store, codec, connections: {
    async get() { return { endpoint, connection_kind: "MCP", connector_configuration: { kind: "servicenow-csm" } } },
  } as unknown as ResourceConnectionRegistry, identity: { async canonicalSubjectId(input) { return input.subjectId } }, publicOrigin: "https://cp.test", managementUiOrigin: "https://cp.test", now: () => 1000, refreshAuthorization: async () => { refreshCalls++; throw new Error("must not refresh changed site") } })
  await store.putBinding({ tenant_id: owner.tenantId, resource_id: owner.resourceId, connection_id: owner.connectionId, subject_id: owner.subjectId, issuer: client.issuer, resource_url: endpoint, updated_at: 1000, sealed_state: codec.seal({ tokens: { access_token: "old-site-token", token_type: "Bearer" } }) })
  assert.equal((await service.resolveAccessToken(owner)).accessToken, "old-site-token")
  endpoint = "https://connector.test/mcp/site-b"
  await assert.rejects(service.resolveAccessToken(owner), /MCP_OAUTH_REAUTHORIZATION_REQUIRED/)
  assert.equal(await service.status(owner), null)
  assert.equal(refreshCalls, 0)
})

async function registeredOAuthFixture() {
  const tenantId = "tenant-acme"
  const state = createResourceMemoryState()
  const organizations = createInMemoryOrganizationDirectory()
  const organization = await organizations.create({ tenantId, display_name: "Acme", slug: "acme" })
  const resources = createInMemoryResourceRegistry({ state, organizations })
  const connections = createInMemoryResourceConnectionRegistry({
    state, resources, providers: createInMemoryProviderProfileCatalog(),
  })
  const resource = await resources.createResource({
    tenantId,
    value: {
      display_name: "Configured OAuth",
      kind: "MCP",
      owner_organization_id: organization.organization_id,
      authentication_strategy: "NONE",
      environment_id: "local",
      version: "1.0.0",
      capabilities: [{ capability_id: "mcp.invoke", display_name: "Invoke" }],
      enforcement_point_id: "ai-gateway",
    },
  })
  return { connections, tenantId, resourceId: resource.resource_id }
}

for (const scopes of [["useraccount"], []]) {
  test(`registered OAuth preserves provider query and owns authorization parameters with ${scopes.length} scopes`, async () => {
    const { connections, tenantId, resourceId } = await registeredOAuthFixture()
    const endpoint = new URL(client.authorization_endpoint)
    endpoint.search = new URLSearchParams([
      ["sysparm_tenant", "acme_corp"], ["sysparm_tenant", "second"], ["login_hint", "admin"],
      ...["response_type", "client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope"]
        .flatMap((name) => [[name, "endpoint-value"], [name, "duplicate-value"]]),
    ]).toString()
    const configuredClient = { ...client, authorization_endpoint: endpoint.toString(), scopes }
    const registered = await connections.create({
      tenantId, resourceId,
      value: {
        display_name: "Primary", connection_kind: "MCP", endpoint: "https://connector.internal/mcp",
        downstream_identity: { mode: "USER_OAUTH", oauth_client: configuredClient },
      },
    })
    assert.deepEqual((await connections.get({ tenantId, resourceId, connectionId: registered.connection_id })).downstream_identity.oauth_client, configuredClient)
    const store = createInMemoryMcpOAuthStore()
    let codeVerifier = ""
    const service = createMcpOAuthService({
      store, codec: createMcpOAuthSecretCodec(Buffer.alloc(32, 7)), connections,
      identity: { async canonicalSubjectId(input) { return input.subjectId } },
      publicOrigin: "https://cp.example.com", managementUiOrigin: "https://ui.example.com",
      exchangeConfiguredCode: async (input) => {
        assert.deepEqual(input.client, configuredClient)
        assert.equal(input.redirectUri, "https://cp.example.com/v1/mcp-oauth/callback")
        codeVerifier = input.verifier
        return { access_token: "registered-access", token_type: "Bearer", issuer: client.issuer }
      },
    })
    const owner = { tenantId, resourceId, connectionId: registered.connection_id, subjectId: "user-one" }
    const started = await service.start(owner)
    const authorization = new URL(started.authorization_url)
    assert.deepEqual(authorization.searchParams.getAll("sysparm_tenant"), ["acme_corp", "second"])
    assert.deepEqual(authorization.searchParams.getAll("login_hint"), ["admin"])
    for (const [name, value] of [
      ["response_type", "code"], ["client_id", client.client_id],
      ["redirect_uri", "https://cp.example.com/v1/mcp-oauth/callback"], ["code_challenge_method", "S256"],
    ]) assert.deepEqual(authorization.searchParams.getAll(name), [value])
    assert.deepEqual(authorization.searchParams.getAll("scope"), scopes.length ? [scopes.join(" ")] : [])
    const oauthState = authorization.searchParams.get("state")
    assert.ok(oauthState)
    assert.equal(authorization.searchParams.getAll("state").length, 1)
    assert.notEqual(oauthState, "endpoint-value")
    assert.notEqual(oauthState, "duplicate-value")
    await service.complete({ state: oauthState, code: "one-use-code", iss: client.issuer })
    assert.deepEqual(authorization.searchParams.getAll("code_challenge"), [createHash("sha256").update(codeVerifier).digest("base64url")])
    assert.equal((await service.resolveAccessToken(owner)).accessToken, "registered-access")
  })
}

test("OAuth registration keeps issuer, token and Connection endpoint URL restrictions", async () => {
  const { connections, tenantId, resourceId } = await registeredOAuthFixture()
  for (const invalidClient of [
    { ...client, issuer: `${client.issuer}?tenant=acme` },
    { ...client, token_endpoint: `${client.token_endpoint}?tenant=acme` },
    { ...client, authorization_endpoint: `${client.authorization_endpoint}#fragment` },
    { ...client, authorization_endpoint: "https://user:password@acme.service-now.com/authorize?tenant=acme" },
    { ...client, authorization_endpoint: "http://acme.service-now.com/authorize?tenant=acme" },
    { ...client, authorization_endpoint: "https://other.example.com/authorize?tenant=acme" },
  ]) {
    await assert.rejects(connections.create({
      tenantId, resourceId,
      value: {
        display_name: "Invalid", connection_kind: "MCP", endpoint: "https://connector.internal/mcp",
        downstream_identity: { mode: "USER_OAUTH", oauth_client: invalidClient },
      },
    }), (error: unknown) => error instanceof PlatformApiError && error.code === "MCP_IDENTITY_CONFIGURATION_INVALID")
  }
  await assert.rejects(connections.create({
    tenantId, resourceId,
    value: {
      display_name: "Invalid", connection_kind: "MCP", endpoint: "https://connector.internal/mcp?tenant=acme",
      downstream_identity: { mode: "USER_OAUTH", oauth_client: client },
    },
  }), (error: unknown) => error instanceof PlatformApiError && error.code === "CONNECTION_ENDPOINT_SUFFIX_FORBIDDEN")
  assert.deepEqual(await connections.list({ tenantId, resourceId }), [])
})
