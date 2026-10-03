import { createHttpConnectionVerifier } from "../src/local-slice-verifiers"
import assert from "node:assert/strict"
import test from "node:test"
import { createInMemoryResourceConnectionRegistry } from "../src/capabilities/connections/memory"
import { createInMemoryOrganizationDirectory } from "../src/capabilities/organizations/memory"
import { createInMemoryProviderProfileCatalog } from "../src/capabilities/providers/memory"
import { createInMemoryResourceRegistry } from "../src/capabilities/resources/memory"
import { createResourceMemoryState } from "../src/capabilities/resources/state"
import type { ConnectionRegistration } from "../src/capabilities/connections/contract"

const mcpConnection = {
  tenant_id: "diagnostic-tenant",
  connection_id: "diagnostic-mcp",
  resource_id: "diagnostic-resource",
  display_name: "Diagnostic MCP",
  connection_kind: "MCP",
  provider_type: null,
  provider_profile_id: null,
  endpoint: "https://qa.example.test/mcp",
  mcp_tool_namespace: null,
  mcp_selected_tools: [],
  mcp_tool_selection_operation_id: null,
  mcp_tool_reviews: [],
  downstream_identity: { mode: "NONE" },
  request_mapping: null,
  status: "DRAFT",
  configuration_revision: 1,
  lifecycle: "DRAFT",
  verification_state: "UNVERIFIED",
  health_state: "UNKNOWN",
  health_observed_at: null,
  health_source_revision: null,
  routing_priority: 0,
  region: null,
  supported_obligations: [],
  created_at: 1,
} satisfies ConnectionRegistration

test("repeatable diagnostics test the current configuration without enabling a disabled connection or replacing runtime health", async () => {
  const tenantId = "diagnostic-tenant"
  const state = createResourceMemoryState()
  const organizations = createInMemoryOrganizationDirectory()
  const organization = await organizations.create({ tenantId, display_name: "QA", slug: "qa" })
  const resources = createInMemoryResourceRegistry({ state, organizations })
  let passed = true
  let called = 0
  const connections = createInMemoryResourceConnectionRegistry({ state, resources, providers: createInMemoryProviderProfileCatalog(), verifier: { verify: () => { called++; return passed } } })
  const resource = await resources.createResource({ tenantId, value: { display_name: "QA MCP", kind: "MCP", owner_organization_id: organization.organization_id, authentication_strategy: "OAUTH", environment_id: "test", version: "v1", capabilities: [{ capability_id: "read", display_name: "Read" }], enforcement_point_id: "ai-gateway" } })
  const created = await connections.create({ tenantId, resourceId: resource.resource_id, value: { display_name: "QA upstream", connection_kind: "MCP", endpoint: "https://qa.example.test/mcp", supported_obligations: [] } })
  const target = { tenantId, resourceId: resource.resource_id, connectionId: created.connection_id }
  const before = await connections.get(target)
  assert.equal((await connections.test(target)).passed, true)
  passed = false
  const failed = await connections.test(target)
  assert.equal(failed.passed, false)
  assert.equal(failed.source, "CONTROL_PLANE")
  assert.equal(called, 2)
  assert.deepEqual(await connections.get(target), before)
  let requests = 0
  const diagnostic = createHttpConnectionVerifier({ fetcher: async () => { requests++; return new Response("{}", { status: 200 }) } })
  const blocked = await diagnostic.diagnose!({ connection: { ...before, endpoint: "http://localhost:1234" } })
  assert.equal(blocked.passed, false)
  assert.equal(blocked.reason_code, "CONNECTION_HTTP_DISABLED")
  assert.equal(requests, 0)
  const reachable = await diagnostic.diagnose!({ connection: { ...before, endpoint: "https://qa.example.test", connection_kind: "API" } })
  assert.equal(reachable.passed, true)
  assert.equal(reachable.http_status, 200)
  assert.equal(requests, 1)
})

test("MCP verification accepts small JSON and SSE responses and a large supported tool catalog", async () => {
  const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } })
  const smallList = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } })
  const largeList = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    result: {
      tools: Array.from({ length: 1024 }, (_, index) => ({
        name: `tool_${index}`,
        description: "d".repeat(2048),
        inputSchema: { type: "object" },
      })),
    },
  })
  assert.ok(new TextEncoder().encode(largeList).byteLength > 1024 * 1024)
  const scenarios = [
    { initialize, list: smallList, contentType: "application/json" },
    { initialize: `event: message\ndata: ${initialize}\n\n`, list: `event: message\ndata: ${smallList}\n\n`, contentType: "text/event-stream" },
    { initialize, list: largeList, contentType: "application/json" },
  ]
  for (const scenario of scenarios) {
    let requests = 0
    const verifier = createHttpConnectionVerifier({
      fetcher: async () => {
        requests++
        if (requests === 1) return new Response(scenario.initialize, { headers: { "content-type": scenario.contentType } })
        if (requests === 2) return new Response(null, { status: 202 })
        return new Response(scenario.list, { headers: { "content-type": scenario.contentType } })
      },
    })
    assert.equal(await verifier.verify({ connection: mcpConnection }), true)
    assert.equal(requests, 3)
  }
})

test("MCP diagnostics reject a declared oversized response and cancel its body", async () => {
  let cancelled = false
  const verifier = createHttpConnectionVerifier({
    fetcher: async () => new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelled = true },
    }), { headers: { "content-length": String(32 * 1024 * 1024 + 1) } }),
  })
  const result = await verifier.diagnose!({ connection: mcpConnection })
  assert.equal(result.passed, false)
  assert.equal(result.reason_code, "CONNECTION_TEST_FAILED")
  assert.equal(result.http_status, 200)
  assert.equal(cancelled, true)
})

test("API verification uses only the response status", async () => {
  const verifier = createHttpConnectionVerifier({
    fetcher: async () => new Response("ignored", {
      status: 200,
      headers: { "content-length": String(32 * 1024 * 1024 + 1) },
    }),
  })
  assert.equal(await verifier.verify({ connection: { ...mcpConnection, connection_kind: "API" } }), true)
})
