import assert from "node:assert/strict"
import test from "node:test"
import { createInMemoryAccessGovernanceStore } from "../src/capabilities/access/memory"

function store(startsAt: number | null) {
  const resource = { tenant_id: "qa", resource_id: "service", display_name: "Service", owner_organization_id: "sales", kind: "MCP", lifecycle: "PUBLISHED", operational_state: "HEALTHY", publication_endpoint: { visibility: "REQUEST", hostname: "service.qa.localhost", base_path: "/mcp/service" }, capabilities: [{ capability_id: "mcp.invoke", display_name: "Invoke" }] }
  return createInMemoryAccessGovernanceStore({ now: () => 100, resources: { listResources: async () => [resource], getResource: async () => resource }, entitlements: { list: async () => startsAt === null ? [] : [{ entitlement_id: "grant", subject_id: "dylan", resource_id: "service", capability_id: "mcp.invoke", state: "ACTIVE", starts_at: startsAt, expires_at: 300 }] }, identity: { inventory: async () => ({ subjects: [] }) }, organizations: { list: async () => [] }, configuration: { published: async () => ({ revision: "1", settings: { request_form: { enabled: true }, ttl_options_seconds: [60], approval_workflow_version: "1" } }) } } as unknown as Parameters<typeof createInMemoryAccessGovernanceStore>[0])
}
const actor = { subjectId: "dylan", clientId: "bot", role: "USER" as const, organizationIds: [] }
const request = { tenantId: "qa", actor, value: { correlation_id: "test", resource_id: "service", capability_id: "mcp.invoke", justification: "Read cases", requested_valid_for_seconds: 60 } }
test("future entitlement is neither usable nor an already-entitled request", async () => {
  const access = store(200)
  const beforeEntitlement = (await access.catalog({ tenantId: "qa", actor })).capabilities[0]
  assert.equal(beforeEntitlement?.access, "REQUEST")
  assert.equal(beforeEntitlement?.publication_endpoint, undefined)
  assert.ok("CREATED" in await access.request(request))
  const entitled = (await store(100).catalog({ tenantId: "qa", actor })).capabilities[0]
  assert.equal(entitled?.access, "ENTITLED")
  assert.deepEqual(entitled?.publication_endpoint, { hostname: "service.qa.localhost", base_path: "/mcp/service" })
})
test("denial and cancellation retain the same stage outcome", async () => {
  for (const cancel of [false, true]) {
    const access = store(null)
    const result = await access.request(request)
    assert.ok("CREATED" in result)
    const id = result.CREATED.access_request_id
    const updated = cancel
      ? await access.cancel({ tenantId: "qa", actor, requestId: id, value: { correlation_id: "test", reason: "No longer needed" } })
      : (await access.decide({ tenantId: "qa", actor: { ...actor, subjectId: "admin", role: "TENANT_ADMINISTRATOR" }, requestId: id, value: { correlation_id: "test", decision: { DENY: { reason: "Not approved" } } } })).request
    assert.equal(updated.state, cancel ? "CANCELLED" : "DENIED")
    assert.equal(updated.approval_stages[0]?.state, updated.state)
  }
})
