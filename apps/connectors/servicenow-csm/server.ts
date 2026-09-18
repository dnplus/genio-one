import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { z } from "zod"
import { createCaseClient, serviceNowOrigin, ServiceNowError, type HttpRequest } from "./client"

export function createServiceNowHandler(options: { instanceUrl?: string; request?: HttpRequest } = {}) {
  const instanceUrl = options.instanceUrl ? serviceNowOrigin(options.instanceUrl) : null
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (url.pathname === "/health") return Response.json({ service: "genio-connector-servicenow-csm", status: "ready" })
    if (url.pathname !== "/mcp") return new Response(null, { status: 404 })
    const match = /^Bearer ([^\s\x00-\x1f\x7f]+)$/.exec(request.headers.get("authorization") ?? "")
    const server = new McpServer({ name: "genio-servicenow-csm", version: "0.1.0" })
    server.registerTool("list_cases", {
      title: "查詢 ServiceNow 客服案件",
      description: "列出目前授權帳號有權讀取的 CSM 案件，可依案件編號或狀態篩選。",
      inputSchema: {
        case_number: z.string().regex(/^CS[0-9]+$/i).optional(),
        state: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async (args) => {
      try {
        if (!match) return { isError: true, content: [{ type: "text", text: "SERVICENOW_AUTHORIZATION_REQUIRED" }] }
        if (!instanceUrl) return { isError: true, content: [{ type: "text", text: "CONNECTOR_CONFIGURATION_REQUIRED" }] }
        const client = createCaseClient(instanceUrl, match[1], options.request)
        const cases = await client.list({ caseNumber: args.case_number, state: args.state, limit: args.limit, offset: args.offset })
        const result = { cases, count: cases.length, offset: args.offset }
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result }
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error instanceof ServiceNowError ? error.code : "SERVICENOW_REQUEST_FAILED" }] }
      }
    })
    const sysId = z.string().regex(/^[a-f0-9]{32}$/i)
    const fields = z.object({
      short_description: z.string().min(1).max(160).optional(), description: z.string().max(100000).optional(),
      priority: z.number().int().min(1).max(5).optional(), state: z.number().int().min(0).optional(),
      contact: sysId.optional(), account: sysId.optional(), assigned_to: sysId.optional(), work_notes: z.string().max(100000).optional(),
    }).strict()
    const execute = async (operation: (client: ReturnType<typeof createCaseClient>) => Promise<unknown>) => {
      if (!match) return { isError: true, content: [{ type: "text" as const, text: "SERVICENOW_AUTHORIZATION_REQUIRED" }] }
      if (!instanceUrl) return { isError: true, content: [{ type: "text" as const, text: "CONNECTOR_CONFIGURATION_REQUIRED" }] }
      try { return { content: [{ type: "text" as const, text: JSON.stringify(await operation(createCaseClient(instanceUrl, match[1], options.request))) }] } }
      catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof ServiceNowError ? error.code : "SERVICENOW_REQUEST_FAILED" }] } }
    }
    const write = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    server.registerTool("get_case", { title: "讀取客服案件", description: "依 ServiceNow sys_id 讀取 CSM 案件。", inputSchema: { sys_id: sysId }, annotations: { ...write, readOnlyHint: true, destructiveHint: false, idempotentHint: true } }, (args) => execute((client) => client.get(args.sys_id)))
    server.registerTool("create_case", { title: "建立客服案件", description: "建立 ServiceNow CSM 案件；請提供站台要求的聯絡人或客戶等欄位。重試可能重複建立。", inputSchema: { fields: fields.extend({ short_description: z.string().min(1).max(160) }) }, annotations: { ...write, destructiveHint: false } }, (args) => execute((client) => client.create(args.fields)))
    server.registerTool("update_case", { title: "更新客服案件", description: "更新指定 CSM 案件欄位；work_notes 會新增紀錄，重試可能重複。", inputSchema: { sys_id: sysId, fields: fields.refine((value) => Object.keys(value).length > 0) }, annotations: write }, (args) => execute((client) => client.update(args.sys_id, args.fields)))
    server.registerTool("delete_case", { title: "刪除客服案件", description: "刪除指定 ServiceNow CSM 案件，需要外部帳號具備刪除權限。", inputSchema: { sys_id: sysId }, annotations: write }, (args) => execute((client) => client.remove(args.sys_id)))
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)
    try {
      return await transport.handleRequest(request)
    } finally {
      await server.close()
    }
  }
}
