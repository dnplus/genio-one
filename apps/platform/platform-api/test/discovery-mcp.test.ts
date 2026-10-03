import { expect, test } from "bun:test"
import { createManagementApi } from "../src/app"
import { createArdPublisher } from "../src/capabilities/ard-publisher/module"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"

const tenantId = "tenant-discovery"
const otherTenantId = "tenant-discovery-other"
const memoryCapabilityId = "genio-one-personal-memory"
const principal = { tenant_id: tenantId, subject_id: "person-alice", role: "USER" as const, organization_ids: [], client_id: "bot", scopes: ["genioone-invocation"] }
const owner = { ...principal, client_id: "genio-one-self-service" }

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
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      user: principal,
      management: { ...principal, scopes: ["genioone-management"] },
      "other-tenant": { ...principal, tenant_id: otherTenantId },
      runtime: { ...principal, scopes: ["genioone-gateway-runtime"] },
    }),
  })
  const post = (body: unknown, token = "user", tenant = tenantId) => app.inject({ method: "POST", url: `/v1/tenants/${tenant}/discovery/mcp`, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, payload: JSON.stringify(body) })
  const memoryMcp = (body: unknown, token = "user", tenant = tenantId) => app.inject({ method: "POST", url: `/v1/tenants/${tenant}/memory/mcp`, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, payload: JSON.stringify(body) })
  const grant = () => modules.memories.enablePersonalAgent(owner, { actor: owner, management_authorized: true, person_subject: true }, { agent_id: principal.client_id })
  const revoke = () => modules.memories.revokePersonalAgent(owner, { actor: owner, management_authorized: true, person_subject: true }, { agent_id: principal.client_id })
  return { app, post, memoryMcp, grant, revoke, actors, disable: () => { enabled = false } }
}

function initialize(id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "discovery-mcp-test", version: "1" } },
  }
}

function searchNativeMemory() {
  return { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_resources", arguments: {} } }
}

function getNativeMemory() {
  return { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_resource", arguments: { native_capability_id: memoryCapabilityId } } }
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
    const init = await post(initialize())
    expect(init.statusCode).toBe(200)
    expect(init.json().result.serverInfo.name).toBe("genio-one-discovery")
    const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    expect(list.json().result.tools.map((tool: { name: string }) => tool.name)).toEqual(["search_resources", "get_resource"])
    expect(list.json().result.tools.find((tool: { name: string }) => tool.name === "search_resources").description).toContain("native_capabilities")
    const result = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_resources", arguments: { query: "客服", subject_id: "admin" } } })
    expect(result.statusCode).toBe(200)
    expect(result.json().result.structuredContent.resources[0].tools[0].access).toBe("REQUEST")
    expect(result.json().result.structuredContent.native_capabilities).toEqual([])
    expect(actors).toEqual([{ tenantId: principal.tenant_id, actor: { subjectId: "person-alice", clientId: "bot", role: "USER", organizationIds: [] } }])
    expect(result.headers["cache-control"]).toBe("no-store")
    expect(result.headers["x-request-id"]).toBeTruthy()
  } finally { await app.close() }
})

test("Discovery hides the native Memory MCP without an active grant", async () => {
  const { app, post, memoryMcp } = await fixture()
  try {
    const search = await post(searchNativeMemory())
    expect(search.statusCode).toBe(200)
    expect(search.json().result.structuredContent.native_capabilities).toEqual([])

    const detail = await post(getNativeMemory())
    expect(detail.json().result.isError).toBe(true)
    expect(detail.body).toContain("NATIVE_CAPABILITY_NOT_FOUND_OR_NOT_VISIBLE")

    const direct = await memoryMcp(initialize(3))
    expect(direct.statusCode).toBe(403)
    expect(direct.body).toContain("MEMORY_AGENT_GRANT_INVALID")
  } finally { await app.close() }
})

test("Discovery returns an active agent's native Memory MCP descriptor and its direct route", async () => {
  const { app, post, memoryMcp, grant } = await fixture()
  try {
    await grant()

    const search = await post(searchNativeMemory())
    const descriptor = search.json().result.structuredContent.native_capabilities[0]
    expect(descriptor).toEqual({
      native_capability_id: memoryCapabilityId,
      display_name: "記憶 MCP",
      description: "提供 PERSONAL、TEAM 與 ORGANIZATION 範圍的記憶操作；實際可用範圍由權限與成員資格決定。",
      transport: "streamable-http",
      direct_mcp_route: `/v1/tenants/${tenantId}/memory/mcp`,
      authorization: { scheme: "bearer", token_source: "same_discovery_request" },
    })

    const detail = await post(getNativeMemory())
    expect(detail.json().result.structuredContent.native_capability).toEqual(descriptor)

    const direct = await memoryMcp(initialize(3))
    expect(direct.statusCode).toBe(200)
    expect(direct.json().result.serverInfo.name).toBe("genio-one-memory")
  } finally { await app.close() }
})

test("Discovery hides native Memory MCP from a management-only bearer", async () => {
  const { app, post, memoryMcp, grant } = await fixture()
  try {
    await grant()

    const search = await post(searchNativeMemory(), "management")
    expect(search.statusCode).toBe(200)
    expect(search.json().result.structuredContent.native_capabilities).toEqual([])

    const detail = await post(getNativeMemory(), "management")
    expect(detail.json().result.isError).toBe(true)
    expect(detail.body).toContain("NATIVE_CAPABILITY_NOT_FOUND_OR_NOT_VISIBLE")

    const direct = await memoryMcp(initialize(3), "management")
    expect(direct.statusCode).toBe(403)
    expect(direct.body).toContain("INSUFFICIENT_SCOPE")
  } finally { await app.close() }
})

test("Discovery's native Memory MCP has no anonymous ARD entry", async () => {
  const modules = createInMemoryPlatformModules()
  const publisher = createArdPublisher({
    config: {
      tenantId,
      publicOrigin: "https://ard.example.test",
      publisherDomain: "ard.example.test",
      namespace: "genioone",
      resourceIds: new Set([memoryCapabilityId]),
    },
    resources: modules.resources,
    publications: modules.publicationWorkflow,
  })

  const manifest = await publisher.manifest()
  expect(manifest.body).toEqual({ entries: [] })
  expect(JSON.stringify(manifest.body)).not.toContain(memoryCapabilityId)
  expect(JSON.stringify(manifest.body)).not.toContain("/memory/mcp")
})

test("Discovery removes the native Memory MCP descriptor after revocation", async () => {
  const { app, post, memoryMcp, grant, revoke } = await fixture()
  try {
    await grant()
    expect((await post(searchNativeMemory())).json().result.structuredContent.native_capabilities).toHaveLength(1)

    await revoke()
    const search = await post(searchNativeMemory())
    expect(search.json().result.structuredContent.native_capabilities).toEqual([])

    const detail = await post(getNativeMemory())
    expect(detail.json().result.isError).toBe(true)
    expect(detail.body).toContain("NATIVE_CAPABILITY_NOT_FOUND_OR_NOT_VISIBLE")

    const direct = await memoryMcp(initialize(3))
    expect(direct.statusCode).toBe(403)
    expect(direct.body).toContain("MEMORY_AGENT_GRANT_INVALID")
  } finally { await app.close() }
})

test("Discovery does not expose a tenant's Memory grant in another tenant", async () => {
  const { app, post, memoryMcp, grant } = await fixture()
  try {
    await grant()

    const search = await post(searchNativeMemory(), "other-tenant", otherTenantId)
    expect(search.statusCode).toBe(200)
    expect(search.json().result.structuredContent.native_capabilities).toEqual([])

    const detail = await post(getNativeMemory(), "other-tenant", otherTenantId)
    expect(detail.json().result.isError).toBe(true)
    expect(detail.body).toContain("NATIVE_CAPABILITY_NOT_FOUND_OR_NOT_VISIBLE")

    const direct = await memoryMcp(initialize(3), "other-tenant", otherTenantId)
    expect(direct.statusCode).toBe(403)
    expect(direct.body).toContain("MEMORY_AGENT_GRANT_INVALID")
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
    const bothIds = await post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_resource", arguments: { resource_id: "visible-resource", native_capability_id: memoryCapabilityId } } })
    expect(bothIds.json().result).toEqual({ isError: true, content: [{ type: "text", text: "RESOURCE_AND_NATIVE_CAPABILITY_ID_MUTUALLY_EXCLUSIVE" }] })
    const missingId = await post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_resource", arguments: {} } })
    expect(missingId.json().result).toEqual({ isError: true, content: [{ type: "text", text: "RESOURCE_OR_NATIVE_CAPABILITY_ID_REQUIRED" }] })
    const empty = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_resources", arguments: { query: "absent" } } })
    expect(empty.json().result.structuredContent).toEqual({ catalog_revision: "catalog-1", resources: [], native_capabilities: [], total: 0, next_offset: null })
  } finally { await app.close() }
})
