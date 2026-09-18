import { createHttpConnectionVerifier } from "../src/local-slice-verifiers"
import assert from "node:assert/strict"
import test from "node:test"
import { createInMemoryResourceConnectionRegistry } from "../src/capabilities/connections/memory"
import { createInMemoryOrganizationDirectory } from "../src/capabilities/organizations/memory"
import { createInMemoryProviderProfileCatalog } from "../src/capabilities/providers/memory"
import { createInMemoryResourceRegistry } from "../src/capabilities/resources/memory"
import { createResourceMemoryState } from "../src/capabilities/resources/state"

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
