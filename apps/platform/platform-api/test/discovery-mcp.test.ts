import { expect, test } from "bun:test"
import { flushOtel } from "@genioone/telemetry/otlp-observability"
import { createManagementApi } from "../src/app"
import { createArdPublisher } from "../src/capabilities/ard-publisher/module"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"
import { PlatformApiError } from "../src/capabilities/errors"
import type { DiscoveryMcpPostHogEvent } from "../src/capabilities/discovery-mcp/posthog"

const tenantId = "tenant-discovery"
const otherTenantId = "tenant-discovery-other"
const memoryCapabilityId = "genio-one-personal-memory"
const principal = { tenant_id: tenantId, subject_id: "person-alice", role: "USER" as const, organization_ids: [], client_id: "bot", scopes: ["genioone-invocation"] }
const owner = { ...principal, client_id: "genio-one-self-service" }

async function fixture(options: { otherTenantEnabled?: boolean } = {}) {
  const modules = createInMemoryPlatformModules()
  const publicOrigin = "https://cp.example.test"
  let enabled = true
  let catalogFails = false
  let telemetryFails = false
  const telemetry: DiscoveryMcpPostHogEvent[] = []
  modules.connections.get = async ({ tenantId }) => {
    if (tenantId !== principal.tenant_id && !(options.otherTenantEnabled && tenantId === otherTenantId)) throw new PlatformApiError("CONNECTION_NOT_FOUND", 404)
    return {
      tenant_id: tenantId,
      connection_id: "genio-one-discovery",
      resource_id: "genio-one-discovery",
      display_name: "GenioOne Discovery",
      connection_kind: "MCP",
      provider_type: null,
      provider_profile_id: null,
      endpoint: `${publicOrigin}/v1/tenants/${encodeURIComponent(tenantId)}/discovery/mcp`,
      mcp_selected_tools: [],
      lifecycle: enabled ? "ENABLED" : "DISABLED",
    } as unknown as Awaited<ReturnType<typeof modules.connections.get>>
  }
  const actors: unknown[] = []
  modules.access.catalog = async (input) => {
    if (catalogFails) throw new Error("catalog unavailable")
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
    browserIdentity: {
      tenant_id: principal.tenant_id,
      issuer: "https://identity.example.test/realms/genio-one",
      authorization_endpoint: "https://identity.example.test/realms/genio-one/protocol/openid-connect/auth",
      token_endpoint: "https://identity.example.test/realms/genio-one/protocol/openid-connect/token",
      client_id: "genio-one-self-service",
      scopes: ["genioone-invocation"],
      management_client_id: "genio-one-management-console",
      management_scopes: ["genioone-management"],
    },
    mcpOAuthPublicOrigin: publicOrigin,
    discoveryMcpPostHog: {
      async capture(event) {
        telemetry.push(event)
        if (telemetryFails) throw new Error("posthog unavailable")
      },
    },
  })
  const post = (body: unknown, token = "user", tenant = tenantId, host = "evil.example.test", headers: Record<string, string> = {}) => app.inject({ method: "POST", url: `/v1/tenants/${tenant}/discovery/mcp`, headers: { authorization: `Bearer ${token}`, host, "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, payload: JSON.stringify(body) })
  const metadata = (tenant = tenantId, host = "evil.example.test") => app.inject({ method: "GET", url: `/.well-known/oauth-protected-resource/v1/tenants/${tenant}/discovery/mcp`, headers: { host } })
  const memoryMcp = (body: unknown, token = "user", tenant = tenantId) => app.inject({ method: "POST", url: `/v1/tenants/${tenant}/memory/mcp`, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, payload: JSON.stringify(body) })
  const grant = () => modules.memories.enablePersonalAgent(owner, { actor: owner, management_authorized: true, person_subject: true }, { agent_id: principal.client_id })
  const revoke = () => modules.memories.revokePersonalAgent(owner, { actor: owner, management_authorized: true, person_subject: true }, { agent_id: principal.client_id })
  return { app, post, metadata, memoryMcp, grant, revoke, actors, telemetry, disable: () => { enabled = false }, failCatalog: () => { catalogFails = true }, failTelemetry: () => { telemetryFails = true } }
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
  const { app, post, memoryMcp, telemetry } = await fixture()
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
    expect(telemetry).toHaveLength(2)
    expect(telemetry[1]).toEqual({
      tenantId: principal.tenant_id,
      correlationId: String(detail.headers["x-request-id"]),
      completionId: expect.any(String),
      tool: "get_resource",
      resultCount: 0,
      latencyMillis: expect.any(Number),
      statusCode: 200,
      outcome: "FAILED",
      errorCode: "NATIVE_CAPABILITY_NOT_FOUND_OR_NOT_VISIBLE",
      occurredAt: expect.any(Number),
    })
    expect(JSON.stringify(telemetry)).not.toContain(memoryCapabilityId)
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
  const { app, post, memoryMcp, grant, telemetry } = await fixture()
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
    expect(telemetry).toHaveLength(2)
    expect(telemetry[1]).toEqual({
      tenantId: principal.tenant_id,
      correlationId: String(detail.headers["x-request-id"]),
      completionId: expect.any(String),
      tool: "get_resource",
      resultCount: 0,
      latencyMillis: expect.any(Number),
      statusCode: 200,
      outcome: "FAILED",
      errorCode: "NATIVE_CAPABILITY_NOT_FOUND_OR_NOT_VISIBLE",
      occurredAt: expect.any(Number),
    })
    expect(JSON.stringify(telemetry)).not.toContain(memoryCapabilityId)
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
  const { app, post, memoryMcp, grant } = await fixture({ otherTenantEnabled: true })
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
    const anonymous = await post(request, "invalid", "tenant-discovery", "attacker.example.test")
    expect(anonymous.statusCode).toBe(401)
    expect(anonymous.headers["www-authenticate"]).toBe("Bearer resource_metadata=\"https://cp.example.test/.well-known/oauth-protected-resource/v1/tenants/tenant-discovery/discovery/mcp\"")
    const foreignTenant = await post(request, "user", "tenant-other")
    expect(foreignTenant.statusCode).toBe(403)
    expect(foreignTenant.headers["www-authenticate"]).toBeUndefined()
    const runtime = await post(request, "runtime")
    expect(runtime.statusCode).toBe(403)
    expect(runtime.headers["www-authenticate"]).toBeUndefined()
    expect(actors).toEqual([])
  } finally { await app.close() }
})

test("Discovery protected-resource metadata is public only for enabled seeded tenants", async () => {
  const { app, metadata, disable } = await fixture()
  try {
    const result = await metadata()
    expect(result.statusCode).toBe(200)
    expect(JSON.parse(result.body)).toEqual({
      resource: "https://cp.example.test/v1/tenants/tenant-discovery/discovery/mcp",
      authorization_servers: ["https://identity.example.test/realms/genio-one"],
      scopes_supported: ["genioone-invocation"],
      bearer_methods_supported: ["header"],
    })
    expect(result.headers["cache-control"]).toBe("no-store")
    disable()
    expect((await metadata()).statusCode).toBe(404)
    expect((await metadata("tenant-missing")).statusCode).toBe(404)
  } finally { await app.close() }
})

test("Discovery telemetry failure does not block a completed MCP response", async () => {
  const { app, post, failTelemetry } = await fixture()
  try {
    failTelemetry()
    const response = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_resources", arguments: {} } })
    expect(response.statusCode).toBe(200)
    expect(response.json().result.structuredContent.catalog_revision).toBe("catalog-1")
  } finally { await app.close() }
})

test("Discovery catalog failures keep MCP HTTP 200 and report a semantic error", async () => {
  const { app, post, telemetry, failCatalog } = await fixture()
  try {
    failCatalog()
    const response = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_resources", arguments: {} } })
    await Promise.resolve()
    expect(response.statusCode).toBe(200)
    expect(response.json().result.isError).toBe(true)
    expect(response.body).toContain("DISCOVERY_CATALOG_UNAVAILABLE")
    expect(telemetry).toHaveLength(1)
    expect(telemetry[0]).toMatchObject({ statusCode: 200, outcome: "FAILED", errorCode: "DISCOVERY_CATALOG_UNAVAILABLE" })
  } finally { await app.close() }
})

test("Discovery cannot resolve hidden ids and validates tool arguments", async () => {
  const { app, post, telemetry } = await fixture()
  try {
    const hidden = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_resource", arguments: { resource_id: "hidden-resource" } } })
    expect(hidden.json().result.isError).toBe(true)
    expect(hidden.body).toContain("RESOURCE_NOT_FOUND_OR_NOT_VISIBLE")
    await Promise.resolve()
    expect(telemetry).toHaveLength(1)
    expect(telemetry[0]).toMatchObject({ tool: "get_resource", statusCode: 200, outcome: "FAILED", errorCode: "RESOURCE_NOT_FOUND_OR_NOT_VISIBLE" })
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

test("Discovery shares OTel and PostHog request correlation and trusted tool outcomes without content", async () => {
  const originalFetch = globalThis.fetch
  const originalOrigin = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://discovery-platform-collector.test"
  const exports: any[] = []
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    exports.push(JSON.parse(await new Request(input, init).text()))
    return new Response("{}")
  }, { preconnect: originalFetch.preconnect })
  let f: Awaited<ReturnType<typeof fixture>> | undefined
  try {
    f = await fixture()
    const completed = await f.post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_resources", arguments: { query: "discovery-private-query", prompt: "discovery-private-prompt" } } }, "user", tenantId, "evil.example.test", { "x-genio-correlation-id": "discovery-canonical-correlation", "x-request-id": "discovery-legacy-correlation" })
    expect(completed.statusCode).toBe(200)
    expect(completed.json().result.structuredContent.catalog_revision).toBe("catalog-1")
    expect(completed.headers["x-request-id"]).not.toBe("discovery-canonical-correlation")
    const semanticFailure = await f.post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_resource", arguments: { resource_id: "discovery-private-hidden-resource" } } }, "user", tenantId, "evil.example.test", { "x-request-id": "discovery-request-header-correlation" })
    expect(semanticFailure.statusCode).toBe(200)
    expect(semanticFailure.json().result.isError).toBe(true)
    const noCompletion = [
      await f.post(initialize(3)),
      await f.post({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
      await f.post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "discovery-private-unknown-tool", arguments: {} } }),
      await f.post({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "search_resources", arguments: { limit: 1_000_000 } } }),
      await f.post(searchNativeMemory(), "invalid"),
    ]
    expect(noCompletion.map(response => response.statusCode)).toEqual([200, 200, 200, 200, 401])
    f.failCatalog()
    const catalogFailure = await f.post(searchNativeMemory())
    expect(catalogFailure.statusCode).toBe(200)
    expect(catalogFailure.json().result.isError).toBe(true)
    f.disable()
    const disabled = await f.post(searchNativeMemory())
    expect(disabled.statusCode).toBe(403)
    noCompletion.push(disabled)
    await Promise.resolve()
    await f.app.close()
    await flushOtel()
    expect(f.telemetry).toHaveLength(3)
    const spans = exports.flatMap(value => value.resourceSpans ?? []).flatMap(value => value.scopeSpans).filter(value => value.scope.name === "genio.http").flatMap(value => value.spans)
    const toolSpans = spans.filter(value => value.attributes.some((attribute: any) => attribute.key === "mcp.tool.name"))
    expect(toolSpans).toHaveLength(3)
    const expected = [
      { correlationId: "discovery-canonical-correlation", tool: "search_resources", outcome: "COMPLETED", errorCode: null },
      { correlationId: "discovery-request-header-correlation", tool: "get_resource", outcome: "FAILED", errorCode: "RESOURCE_NOT_FOUND_OR_NOT_VISIBLE" },
      { correlationId: catalogFailure.headers["x-request-id"], tool: "search_resources", outcome: "FAILED", errorCode: "DISCOVERY_CATALOG_UNAVAILABLE" },
    ]
    for (const completion of expected) {
      const event = f.telemetry.find(event => event.correlationId === completion.correlationId)
      expect(event).toMatchObject({ ...completion, statusCode: 200 })
      const span = toolSpans.find(value => value.attributes.some((attribute: any) => attribute.key === "genio.correlation.id" && attribute.value.stringValue === completion.correlationId))
      expect(span).toBeDefined()
      const attributes = Object.fromEntries(span.attributes.map((attribute: any) => [attribute.key, attribute.value.stringValue ?? attribute.value.intValue]))
      expect(attributes).toMatchObject({
        "genio.correlation.id": completion.correlationId,
        "http.response.status_code": "200",
        "mcp.server.name": "genio-one-discovery",
        "mcp.method.name": "tools/call",
        "mcp.tool.name": completion.tool,
        "genio.outcome": completion.outcome,
        "genio.mcp.status_code": "200",
        "genio.mcp.duration_ms": String(event?.latencyMillis),
      })
      expect(attributes["error.type"]).toBe(completion.errorCode ?? undefined)
      expect(span.status.code).toBe(completion.outcome === "FAILED" ? 2 : 1)
      expect(event?.latencyMillis).toBeGreaterThanOrEqual(0)
    }
    for (const response of noCompletion) {
      const [, traceId, spanId] = String(response.headers.traceparent).split("-")
      const span = spans.find(value => value.traceId === traceId && value.spanId === spanId)
      expect(span).toBeDefined()
      expect(span.attributes.some((attribute: any) => attribute.key.startsWith("mcp.") || attribute.key === "genio.outcome")).toBe(false)
      expect(span.status.code).toBe(response.statusCode >= 400 ? 2 : 1)
    }
    const logs = exports.flatMap(value => value.resourceLogs ?? []).flatMap(value => value.scopeLogs).filter(value => value.scope.name === "genio.http").flatMap(value => value.logRecords)
    for (const span of toolSpans) {
      const log = logs.find(value => value.traceId === span.traceId && value.spanId === span.spanId)
      expect(log).toBeDefined()
      expect(log.attributes).toEqual(span.attributes)
      expect(log.severityText).toBe(span.status.code === 2 ? "ERROR" : "INFO")
    }
    const serialized = JSON.stringify({ spans, logs, telemetry: f.telemetry })
    for (const value of ["discovery-private-query", "discovery-private-prompt", "discovery-private-hidden-resource", "discovery-private-unknown-tool", "visible-resource", "客服", "list_cases", "discovery-legacy-correlation"]) expect(serialized).not.toContain(value)
  } finally {
    await f?.app.close()
    await flushOtel()
    globalThis.fetch = originalFetch
    if (originalOrigin === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalOrigin
  }
})
