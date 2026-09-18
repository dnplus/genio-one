import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import test from "node:test"

import Fastify from "fastify"

import type { McpDiscoveryOperation } from "../src/capabilities/mcp-discovery/contract"
import { mcpDiscoveryHttp } from "../src/capabilities/mcp-discovery/http"
import type { McpDiscoveryStore } from "../src/capabilities/mcp-discovery/module"
import type { McpOAuthService } from "../src/capabilities/mcp-oauth/module"
import { createInMemoryRuntimeControlStore } from "../src/capabilities/runtime-control/memory"

const tenantId = "tenant-mcp-discovery"
const runtimeId = "runtime-mcp-discovery"
const gatewayId = "gateway-mcp-discovery"
const resourceId = "resource-mcp-discovery"
const connectionId = "connection-mcp-discovery"

function fixtureOperation(): McpDiscoveryOperation {
  return {
    tenant_id: tenantId,
    operation_id: "operation-mcp-discovery",
    gateway_id: gatewayId,
    resource_id: resourceId,
    connection_id: connectionId,
    requested_by_subject_id: "person-admin",
    correlation_id: "correlation-mcp-discovery",
    state: "PENDING",
    runtime_id: null,
    endpoint: "http://127.0.0.1:19003/mcp",
    credential_ref: "mcp-service-api-key-local",
    downstream_identity: { mode: "SERVICE", authentication: "API_KEY" },
    observation: null,
    candidates: [],
    error_code: null,
    error_message: null,
    created_at: 1,
    claimed_at: null,
    completed_at: null,
    updated_at: 1,
  }
}

test("Management UI request is claimed once by its Gateway Runtime group and reports discovery", async () => {
  let operation: McpDiscoveryOperation | null = null
  const store: McpDiscoveryStore = {
    async request(input) {
      operation = {
        ...fixtureOperation(),
        requested_by_subject_id: input.requestedBySubjectId,
        correlation_id: input.correlationId,
      }
      return operation
    },
    async latest() {
      return operation
    },
    async get() {
      return operation
    },
    async claimNext(input) {
      if (!operation || operation.state !== "PENDING" || input.gatewayId !== gatewayId) return null
      operation = { ...operation, state: "RUNNING", runtime_id: input.runtimeId, claimed_at: 2, updated_at: 2 }
      return operation
    },
    async complete(input) {
      assert.ok(operation)
      assert.equal(input.runtimeId, operation.runtime_id)
      operation = input.result.state === "SUCCEEDED"
        ? { ...operation, state: "SUCCEEDED", observation: input.result.observation, completed_at: 3, updated_at: 3 }
        : { ...operation, state: "FAILED", error_code: input.result.error_code, error_message: input.result.error_message, completed_at: 3, updated_at: 3 }
      return operation
    },
    async decideCandidate() {
      assert.ok(operation)
      return operation
    },
  }
  const registrations = createInMemoryRuntimeControlStore()
  const { publicKey } = generateKeyPairSync("ed25519")
  await registrations.registerGatewayRuntime({
    tenantId,
    runtimeId,
    targetId: gatewayId,
    oidcClientId: runtimeId,
    reportKeyId: "runtime-report-key",
    reportPublicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  })
  const app = Fastify({ logger: false })
  const oauth: McpOAuthService = {
    async start() { throw new Error("not used") },
    async complete() { throw new Error("not used") },
    async status() { return null },
    async disconnect() {},
    async resolveAccessToken() { throw new Error("not used") },
    async resolveRequestHeaders() { return [] },
  }
  app.addHook("preHandler", async (request) => {
    request.principal = {
      tenant_id: tenantId,
      subject_id: "person-admin",
      role: "TENANT_ADMINISTRATOR",
      organization_ids: [],
      client_id: runtimeId,
    }
  })
  await app.register(mcpDiscoveryHttp, {
    store,
    registrations,
    authorizeRuntime: async () => true,
    oauth,
  })
  await app.ready()
  try {
    const requested = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/resources/${resourceId}/connections/${connectionId}/mcp-discovery`,
      payload: { correlation_id: "console-correlation" },
    })
    assert.equal(requested.statusCode, 202, requested.body)
    assert.equal(requested.json().requested_by_subject_id, "person-admin")

    const claimed = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/runtime-control/GATEWAY/${runtimeId}/operations/mcp-discovery/next`,
    })
    assert.equal(claimed.statusCode, 200, claimed.body)
    assert.equal(claimed.json().state, "RUNNING")
    assert.equal(claimed.json().runtime_id, runtimeId)

    const noSecondClaim = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/runtime-control/GATEWAY/${runtimeId}/operations/mcp-discovery/next`,
    })
    assert.equal(noSecondClaim.statusCode, 200, noSecondClaim.body)
    assert.equal(noSecondClaim.json(), null)

    const completed = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/runtime-control/GATEWAY/${runtimeId}/operations/mcp-discovery/operation-mcp-discovery/result`,
      payload: {
        state: "SUCCEEDED",
        observation: {
          protocol_version: "2025-06-18",
          server_name: "genio-one-local",
          server_version: "0.1.0",
          tools: [{ name: "echo", title: null, description: "Return the supplied text." }],
        },
      },
    })
    assert.equal(completed.statusCode, 200, completed.body)
    assert.equal(completed.json().state, "SUCCEEDED")
    assert.equal(completed.json().observation.tools[0].name, "echo")

    const latest = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/resources/${resourceId}/connections/${connectionId}/mcp-discovery/latest`,
    })
    assert.equal(latest.statusCode, 200, latest.body)
    assert.equal(latest.json().correlation_id, "console-correlation")
    assert.equal(latest.json().runtime_id, runtimeId)
  } finally {
    await app.close()
  }
})
