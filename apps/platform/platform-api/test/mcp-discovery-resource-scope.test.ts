import assert from "node:assert/strict"
import test from "node:test"

import type { ConnectionRegistration } from "../src/capabilities/connections/contract"
import type { ResourceConnectionRegistry } from "../src/capabilities/connections/module"
import { createInMemoryMcpDiscoveryStore } from "../src/capabilities/mcp-discovery/memory"
import type { ResourceRegistration } from "../src/capabilities/resources/contract"
import type { ResourceRegistry } from "../src/capabilities/resources/module"
import { createResourceMemoryState } from "../src/capabilities/resources/state"

const tenantId = "tenant-discovery"
const connectionId = "shared-connection"
const resourceIds = ["resource-one", "resource-two"] as const
const observation = {
  protocol_version: "2025-11-25",
  server_name: "shared-server",
  server_version: null,
  tools: [{ name: "search", title: "Search", description: "Search records" }],
}

test("in-memory MCP discovery keeps active operations and previous candidates within each Resource", async () => {
  const state = createResourceMemoryState()
  for (const resourceId of resourceIds) {
    state.resources.set(`${tenantId}:${resourceId}`, {
      tenant_id: tenantId,
      resource_id: resourceId,
      kind: "MCP",
      enforcement_point_id: "gateway-discovery",
      publication_request: null,
      capabilities: [],
    } as unknown as ResourceRegistration)
    state.connections.set(`${tenantId}:${resourceId}:${connectionId}`, {
      tenant_id: tenantId,
      resource_id: resourceId,
      connection_id: connectionId,
      connection_kind: "MCP",
      endpoint: `https://${resourceId}.test/mcp`,
      credential_ref: null,
      downstream_identity: { mode: "NONE" },
      mcp_selected_tools: [],
      mcp_tool_reviews: [],
      configuration_revision: 1,
    } as unknown as ConnectionRegistration)
  }
  const resources = {
    async getResource(input: { tenantId: string; resourceId: string }) {
      return state.resources.get(`${input.tenantId}:${input.resourceId}`)
    },
  } as unknown as ResourceRegistry
  const connections = {
    async get(input: { tenantId: string; resourceId: string; connectionId: string }) {
      return state.connections.get(`${input.tenantId}:${input.resourceId}:${input.connectionId}`)
    },
  } as unknown as ResourceConnectionRegistry
  let operationNumber = 0
  let timestamp = 0
  const store = createInMemoryMcpDiscoveryStore({
    state,
    resources,
    connections,
    idFactory: () => `discovery-${++operationNumber}`,
    now: () => ++timestamp,
  })
  const request = (resourceId: string, correlationId: string) => store.request({
    tenantId,
    resourceId,
    connectionId,
    requestedBySubjectId: "alice",
    correlationId,
  })

  const first = await request(resourceIds[0], "same-correlation")
  const second = await request(resourceIds[1], "same-correlation")
  assert.notEqual(first.operation_id, second.operation_id)
  assert.equal(second.resource_id, resourceIds[1])
  assert.equal((await request(resourceIds[0], "retry-one")).operation_id, first.operation_id)
  assert.equal((await request(resourceIds[1], "retry-two")).operation_id, second.operation_id)
  assert.equal((await store.latest({ tenantId, resourceId: resourceIds[0], connectionId }))?.operation_id, first.operation_id)
  assert.equal((await store.latest({ tenantId, resourceId: resourceIds[1], connectionId }))?.operation_id, second.operation_id)

  assert.equal((await store.claimNext({ tenantId, gatewayId: "gateway-discovery", runtimeId: "runtime" }))?.operation_id, first.operation_id)
  assert.equal((await store.claimNext({ tenantId, gatewayId: "gateway-discovery", runtimeId: "runtime" }))?.operation_id, second.operation_id)
  const firstCompleted = await store.complete({
    tenantId,
    runtimeId: "runtime",
    operationId: first.operation_id,
    result: { state: "SUCCEEDED", observation },
  })
  const candidate = firstCompleted.candidates[0]!
  await store.decideCandidate({
    tenantId,
    resourceId: resourceIds[0],
    connectionId,
    candidateId: candidate.candidate_id,
    expectedRevisionDigest: candidate.revision_digest,
    state: "IGNORED",
  })
  assert.equal((await request(resourceIds[1], "still-active")).operation_id, second.operation_id)
  assert.notEqual((await request(resourceIds[0], "next-one")).operation_id, first.operation_id)
  const secondCompleted = await store.complete({
    tenantId,
    runtimeId: "runtime",
    operationId: second.operation_id,
    result: { state: "SUCCEEDED", observation },
  })
  assert.equal(secondCompleted.candidates[0]?.state, "NEW")
  assert.equal(secondCompleted.resource_id, resourceIds[1])
})
