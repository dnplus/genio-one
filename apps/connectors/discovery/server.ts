import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { z } from "zod"

export interface DiscoveryCapability {
  resource_id: string
  resource_display_name: string
  capability_id: string
  capability_display_name: string
  connection_status: string
  access: string
  hub_status: string
}

export interface DiscoveryCatalog {
  catalog_revision: string
  capabilities: DiscoveryCapability[]
}

export interface DiscoveryNativeMcpCapability {
  native_capability_id: string
  display_name: string
  description: string
  transport: "streamable-http"
  direct_mcp_route: string
  authorization: {
    scheme: "bearer"
    token_source: "same_discovery_request"
  }
}

export const DISCOVERY_TOOLS = [
  { capability_id: "search_resources", display_name: "搜尋可見資源與工具" },
  { capability_id: "get_resource", display_name: "查詢資源工具與存取狀態" },
] as const

type ResourceGroup = {
  resource_id: string
  display_name: string
  tools: Array<Omit<DiscoveryCapability, "resource_id" | "resource_display_name">>
}

function getResourceMap(catalog: DiscoveryCatalog): Map<string, ResourceGroup> {
  const groups = new Map<string, ResourceGroup>()
  for (let i = 0; i < catalog.capabilities.length; i++) {
    const capability = catalog.capabilities[i]
    const { resource_id, resource_display_name, capability_id, capability_display_name, connection_status, access, hub_status } = capability
    let group = groups.get(resource_id)
    if (!group) {
      group = { resource_id, display_name: resource_display_name, tools: [] }
      groups.set(resource_id, group)
    }
    group.tools.push({ capability_id, capability_display_name, connection_status, access, hub_status })
  }
  return groups
}

export async function handleDiscoveryMcp(request: Request, options: {
  catalog: () => Promise<DiscoveryCatalog>
  nativeCapabilities?: () => Promise<DiscoveryNativeMcpCapability[]>
  completed: (tool: string, count: number, revision: string) => void
}): Promise<Response> {
  const server = new McpServer({ name: "genio-one-discovery", version: "1.0.0" })
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  const result = (value: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value })

  server.registerTool("search_resources", {
    title: "搜尋 GenioOne 資源",
    description: "搜尋目前登入者可見的企業資源與能力。結果包含工具與存取狀態，以及不屬於一般 Resource 的 native_capabilities；可見不代表已授權。未設定或未發布的 connector 不會出現在結果中。",
    inputSchema: { query: z.string().max(256).default(""), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(20) },
    annotations,
  }, async ({ query, offset, limit }) => {
    const catalog = await options.catalog()
    const needle = query.trim().toLocaleLowerCase()
    const resourceMap = getResourceMap(catalog)
    const allResources = Array.from(resourceMap.values())
    const matches = needle
      ? allResources.filter((resource) => JSON.stringify(resource).toLowerCase().includes(needle))
      : allResources
    const page = matches.slice(offset, offset + limit)
    const nativeCapabilities = await options.nativeCapabilities?.() ?? []
    const visibleNativeCapabilities = needle
      ? nativeCapabilities.filter((capability) => JSON.stringify(capability).toLowerCase().includes(needle))
      : nativeCapabilities
    options.completed("search_resources", page.length + visibleNativeCapabilities.length, catalog.catalog_revision)
    return result({ catalog_revision: catalog.catalog_revision, resources: page, native_capabilities: visibleNativeCapabilities, total: matches.length, next_offset: offset + limit < matches.length ? offset + limit : null })
  })

  server.registerTool("get_resource", {
    title: "查詢 GenioOne 資源",
    description: "以 search_resources 回傳的 resource_id 或 native_capability_id 查詢可見項目。不揭露隱藏資源、上游憑證或其他人的授權。",
    inputSchema: {
      resource_id: z.string().min(1).max(256).optional(),
      native_capability_id: z.string().min(1).max(256).optional(),
    }, annotations,
  }, async ({ resource_id, native_capability_id }) => {
    const catalog = await options.catalog()
    if (resource_id && native_capability_id) {
      options.completed("get_resource", 0, catalog.catalog_revision)
      return { isError: true, content: [{ type: "text" as const, text: "RESOURCE_AND_NATIVE_CAPABILITY_ID_MUTUALLY_EXCLUSIVE" }] }
    }
    if (native_capability_id) {
      const nativeCapability = (await options.nativeCapabilities?.() ?? []).find((capability) => capability.native_capability_id === native_capability_id)
      options.completed("get_resource", nativeCapability ? 1 : 0, catalog.catalog_revision)
      if (!nativeCapability) return { isError: true, content: [{ type: "text" as const, text: "NATIVE_CAPABILITY_NOT_FOUND_OR_NOT_VISIBLE" }] }
      return result({ catalog_revision: catalog.catalog_revision, native_capability: nativeCapability })
    }
    if (!resource_id) {
      options.completed("get_resource", 0, catalog.catalog_revision)
      return { isError: true, content: [{ type: "text" as const, text: "RESOURCE_OR_NATIVE_CAPABILITY_ID_REQUIRED" }] }
    }
    const resourceMap = getResourceMap(catalog)
    const resource = resourceMap.get(resource_id)
    options.completed("get_resource", resource ? 1 : 0, catalog.catalog_revision)
    if (!resource) return { isError: true, content: [{ type: "text" as const, text: "RESOURCE_NOT_FOUND_OR_NOT_VISIBLE" }] }
    return result({ catalog_revision: catalog.catalog_revision, resource })
  })

  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  try { return await transport.handleRequest(request) }
  finally { await server.close() }
}
