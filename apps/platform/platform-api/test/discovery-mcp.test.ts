import { expect, test } from "bun:test"
import { createManagementApi } from "../src/app"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"

const principal = { tenant_id: "tenant-discovery", subject_id: "person-alice", role: "USER" as const, organization_ids: [], client_id: "bot", scopes: ["genioone-invocation"] }
async function fixture() {
  const modules = createInMemoryPlatformModules()
  let enabled = true
  modules.connections.get = async () => ({ lifecycle: enabled ? "ENABLED" : "DISABLED" } as Awaited<ReturnType<typeof modules.connections.get>>)
  const actors: unknown[] = []
  modules.access.catalog = async (input) => {
    actors.push(input)
    return { tenant_id: input.tenantId, subject_id: input.actor.subjectId, subject_display_name: "Alice", catalog_revision: "catalog-1", capabilities: [{
      resource_id: "visible-resource", resource_display_name: "客服", capability_id: "list_cases", capability_display_name: "查詢案件", resource_owner_id: "owner", resource_owner_display_name: "Owner", connection_status: "READY", access: "REQUEST", hub_status: "REQUEST_ACCESS",
    }] }
  }
  const app = await createManagementApi({ modules, resourceCatalog: modules.resources, principalAuthenticator: createStaticPrincipalAuthenticator({ user: principal, runtime: { ...principal, scopes: ["genioone-gateway-runtime"] } }) })
  const post = (body: unknown, token = "user", tenant = "tenant-discovery") => app.inject({ method: "POST", url: `/v1/tenants/${tenant}/discovery/mcp`, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, payload: JSON.stringify(body) })
  return { app, post, actors, disable: () => { enabled = false } }
}

test("disabled installed Discovery rejects calls without exposing Catalog", async () => {
  const { app, post, actors, disable } = await fixture()
  try {
    disable()
    const result = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_resources", arguments: {} } })
    expect(result.statusCode).toBe(403)
    expect(result.body).toContain("DISCOVERY_SERVICE_DISABLED")
    expect(actors).toEqual([])
  } finally { await app.close() }
})

test("Discovery speaks MCP and reads Catalog with the verified caller", async () => {
  const { app, post, actors } = await fixture()
  try {
    const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } })
    expect(init.statusCode).toBe(200)
    expect(init.json().result.serverInfo.name).toBe("genio-one-discovery")
    const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    expect(list.json().result.tools.map((tool: { name: string }) => tool.name)).toEqual(["search_resources", "get_resource"])
    const result = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_resources", arguments: { query: "客服", subject_id: "admin" } } })
    expect(result.statusCode).toBe(200)
    expect(result.json().result.structuredContent.resources[0].tools[0].access).toBe("REQUEST")
    expect(actors).toEqual([{ tenantId: principal.tenant_id, actor: { subjectId: "person-alice", clientId: "bot", role: "USER", organizationIds: [] } }])
    expect(result.headers["cache-control"]).toBe("no-store")
    expect(result.headers["x-request-id"]).toBeTruthy()
  } finally { await app.close() }
})

test("Discovery rejects anonymous, foreign tenant and runtime-only tokens", async () => {
  const { app, post, actors } = await fixture()
  try {
    const request = { jsonrpc: "2.0", id: 1, method: "tools/list" }
    expect((await post(request, "invalid")).statusCode).toBe(401)
    expect((await post(request, "user", "tenant-other")).statusCode).toBe(403)
    expect((await post(request, "runtime")).statusCode).toBe(403)
    expect(actors).toEqual([])
  } finally { await app.close() }
})

test("Discovery cannot resolve hidden ids and validates tool arguments", async () => {
  const { app, post } = await fixture()
  try {
    const hidden = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_resource", arguments: { resource_id: "hidden-resource" } } })
    expect(hidden.json().result.isError).toBe(true)
    expect(hidden.body).toContain("RESOURCE_NOT_FOUND_OR_NOT_VISIBLE")
    const invalid = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_resources", arguments: { limit: 1000000 } } })
    expect(invalid.json().result.isError).toBe(true)
    const empty = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_resources", arguments: { query: "absent" } } })
    expect(empty.json().result.structuredContent).toEqual({ catalog_revision: "catalog-1", resources: [], total: 0, next_offset: null })
  } finally { await app.close() }
})
