import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import { canonicalizeDownstreamIdentity } from "../src/capabilities/connections/contract"
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
