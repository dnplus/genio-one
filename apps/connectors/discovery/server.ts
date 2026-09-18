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

export const DISCOVERY_TOOLS = [
  { capability_id: "search_resources", display_name: "搜尋可見資源與工具" },
  { capability_id: "get_resource", display_name: "查詢資源工具與存取狀態" },
] as const

export async function handleDiscoveryMcp(request: Request, options: {
  catalog: () => Promise<DiscoveryCatalog>
  completed: (tool: string, count: number, revision: string) => void
}): Promise<Response> {
  const server = new McpServer({ name: "genio-one-discovery", version: "1.0.0" })
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  const result = (value: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value })
  const resources = (catalog: DiscoveryCatalog) => {
    const groups = new Map<string, { resource_id: string; display_name: string; tools: Array<Omit<DiscoveryCapability, "resource_id" | "resource_display_name">> }>()
    for (const capability of catalog.capabilities) {
      const { resource_id, resource_display_name, capability_id, capability_display_name, connection_status, access, hub_status } = capability
      const group = groups.get(resource_id) ?? { resource_id, display_name: resource_display_name, tools: [] }
      group.tools.push({ capability_id, capability_display_name, connection_status, access, hub_status })
      groups.set(resource_id, group)
    }
    return [...groups.values()]
  }
  server.registerTool("search_resources", {
    title: "搜尋 GenioOne 資源",
    description: "搜尋目前登入者可見的企業資源與能力。結果包含工具與存取狀態；可見不代表已授權。未設定或未發布的 connector 不會出現在結果中。",
    inputSchema: { query: z.string().max(256).default(""), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(20) },
    annotations,
  }, async ({ query, offset, limit }) => {
    const catalog = await options.catalog()
    const needle = query.trim().toLocaleLowerCase()
    const matches = resources(catalog).filter((resource) => JSON.stringify(resource).toLocaleLowerCase().includes(needle))
    const page = matches.slice(offset, offset + limit)
    options.completed("search_resources", page.length, catalog.catalog_revision)
    return result({ catalog_revision: catalog.catalog_revision, resources: page, total: matches.length, next_offset: offset + limit < matches.length ? offset + limit : null })
  })
  server.registerTool("get_resource", {
    title: "查詢 GenioOne 資源",
    description: "以 search_resources 回傳的 resource_id 查詢資源的工具、連線可用性與本人存取狀態。不揭露隱藏資源、上游憑證或其他人的授權。",
    inputSchema: { resource_id: z.string().min(1).max(256) }, annotations,
  }, async ({ resource_id }) => {
    const catalog = await options.catalog()
    const resource = resources(catalog).find((entry) => entry.resource_id === resource_id)
    options.completed("get_resource", resource ? 1 : 0, catalog.catalog_revision)
    if (!resource) return { isError: true, content: [{ type: "text" as const, text: "RESOURCE_NOT_FOUND_OR_NOT_VISIBLE" }] }
    return result({ catalog_revision: catalog.catalog_revision, resource })
  })
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  try { return await transport.handleRequest(request) }
  finally { await server.close() }
}
