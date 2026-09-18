import assert from "node:assert/strict"
import test from "node:test"

import type { ResourceConnectionRegistry } from "../src/capabilities/connections/module"
import type { IdentityDirectory } from "../src/capabilities/identity/module"
import { createMcpOAuthSecretCodec } from "../src/capabilities/mcp-oauth/crypto"
import {
  createMcpOAuthService,
  type McpOAuthBindingRecord,
  type McpOAuthStore,
} from "../src/capabilities/mcp-oauth/module"
import { createInMemoryMcpOAuthStore } from "../src/capabilities/mcp-oauth/memory"

test("OAuth refresh cannot restore a binding revoked while the provider request is pending", async () => {
  const store = createInMemoryMcpOAuthStore()
  const codec = createMcpOAuthSecretCodec(Buffer.alloc(32, 6))
  const owner = { tenantId: "tenant", connectionId: "connection", subjectId: "alice" }
  await store.putBinding({ tenant_id: owner.tenantId, resource_id: "resource", connection_id: owner.connectionId, subject_id: owner.subjectId, issuer: "https://auth.test", resource_url: "https://mcp.test", updated_at: 1,
    sealed_state: codec.seal({ tokens: { access_token: "expired", refresh_token: "refresh", token_type: "Bearer", expires_in: 1 }, tokens_saved_at: 1, client_information: { client_id: "client" }, discovery_state: { authorizationServerUrl: "https://auth.test", authorizationServerMetadata: { issuer: "https://auth.test", token_endpoint: "https://auth.test/token", response_types_supported: ["code"] } } }),
  })
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  const service = createMcpOAuthService({ store, codec, connections: { async get() { return {} } } as unknown as ResourceConnectionRegistry, identity: {} as Pick<IdentityDirectory, "canonicalSubjectId">, publicOrigin: "https://cp.test", managementUiOrigin: "https://ui.test", now: () => 1000,
    refreshAuthorization: async () => { entered(); await waiting; return { access_token: "fresh", refresh_token: "rotated", token_type: "Bearer", expires_in: 3600 } },
  })
  const refreshing = service.resolveAccessToken(owner)
  await started
  await service.disconnect(owner)
  release()
  await assert.rejects(refreshing, /MCP_OAUTH_BINDING_CHANGED/)
  assert.equal(await store.getBinding(owner), null)
})

test("schema discovery without an OAuth binding is allowed while invocation remains denied", async () => {
  const service = createMcpOAuthService({
    store: createInMemoryMcpOAuthStore(),
    connections: { async list() { return [{ connection_id: "sn", connection_kind: "MCP", status: "READY", downstream_identity: { mode: "USER_OAUTH" } }] } } as unknown as ResourceConnectionRegistry,
    identity: { async canonicalSubjectId() { return "alice" } },
    codec: createMcpOAuthSecretCodec(Buffer.alloc(32, 5)),
    publicOrigin: "https://cp.test", managementUiOrigin: "https://ui.test",
  })
  const input = { tenantId: "tenant", resourceId: "resource", subjectId: "external-alice" }
  assert.deepEqual(await service.resolveRequestHeaders({ ...input, credentialsOptional: true }), [])
  await assert.rejects(service.resolveRequestHeaders(input), /MCP_OAUTH_AUTHORIZATION_REQUIRED/)
})

test("expired MCP OAuth tokens refresh once and persist without a resource override", async () => {
  const codec = createMcpOAuthSecretCodec(Buffer.alloc(32, 7))
  let binding: McpOAuthBindingRecord = {
    tenant_id: "tenant-acme",
    resource_id: "resource-mcp",
    connection_id: "connection-mcp",
    subject_id: "person-1",
    issuer: "https://auth.example.com",
    resource_url: "https://mcp.example.com/mcp",
    sealed_state: codec.seal({
      tokens: {
        access_token: "expired-access",
        refresh_token: "refresh-1",
        token_type: "Bearer",
        expires_in: 60,
      },
      tokens_saved_at: 100,
      client_information: {
        client_id: "client-1",
      },
      discovery_state: {
        authorizationServerUrl: "https://auth.example.com",
        authorizationServerMetadata: {
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          response_types_supported: ["code"],
        },
      },
    }),
    updated_at: 100,
  }
  const store: McpOAuthStore = {
    async createSession() {},
    async getSessionById() { return null },
    async getSessionByStateHash() { return null },
    async updateSession() {},
    async deleteSession() {},
    async putBinding(value) { binding = value },
    async updateBindingIfCurrent(previous, value) {
      if (binding.sealed_state !== previous.sealed_state) return false
      binding = value
      return true
    },
    async getBinding() { return binding },
    async deleteBinding() {},
    async listBindings() { return [binding] },
  }
  let refreshCalls = 0
  const service = createMcpOAuthService({
    store,
    connections: { async get() { return {} } } as unknown as ResourceConnectionRegistry,
    identity: {} as Pick<IdentityDirectory, "canonicalSubjectId">,
    codec,
    publicOrigin: "https://platform.example.com",
    managementUiOrigin: "https://console.example.com",
    now: () => 1_000,
    refreshAuthorization: async (authorizationServerUrl, options) => {
      refreshCalls += 1
      assert.equal(authorizationServerUrl.toString(), "https://auth.example.com")
      assert.equal("resource" in options, false)
      assert.equal(options.clientInformation.client_id, "client-1")
      assert.equal(options.refreshToken, "refresh-1")
      return {
        access_token: "fresh-access",
        refresh_token: "refresh-2",
        token_type: "Bearer",
        expires_in: 3_600,
      }
    },
  })

  const resolved = await service.resolveAccessToken({
    tenantId: "tenant-acme",
    connectionId: "connection-mcp",
    subjectId: "person-1",
  })

  assert.equal(refreshCalls, 1)
  assert.deepEqual(resolved, {
    accessToken: "fresh-access",
    expiresAt: 4_600,
  })
  assert.equal(binding.updated_at, 1_000)
  const saved = codec.open<{
    tokens: { access_token: string; refresh_token: string }
    tokens_saved_at: number
  }>(binding.sealed_state)
  assert.equal(saved.tokens.access_token, "fresh-access")
  assert.equal(saved.tokens.refresh_token, "refresh-2")
  assert.equal(saved.tokens_saved_at, 1_000)
})

test("service-authenticated MCP resources do not require a canonical user OAuth subject", async () => {
  let identityLookups = 0
  const service = createMcpOAuthService({
    store: {} as McpOAuthStore,
    connections: {
      async list() {
        return [{
          connection_kind: "MCP",
          status: "READY",
          downstream_identity: { mode: "SERVICE", authentication: "API_KEY" },
        }]
      },
    } as unknown as ResourceConnectionRegistry,
    identity: {
      async canonicalSubjectId() {
        identityLookups += 1
        return null
      },
    },
    codec: createMcpOAuthSecretCodec(Buffer.alloc(32, 8)),
    publicOrigin: "https://platform.example.com",
    managementUiOrigin: "https://console.example.com",
    now: () => 1_000,
  })

  const headers = await service.resolveRequestHeaders({
    tenantId: "tenant-acme",
    resourceId: "resource-service-mcp",
    subjectId: "external-oidc-subject",
  })

  assert.deepEqual(headers, [])
  assert.equal(identityLookups, 0)
})
