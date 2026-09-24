import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { z } from "zod"
import type { Mail2000Imap } from "./imap"
import type { Mail2000Dav } from "./dav"
import { sendMailSchema, type OutgoingMail } from "./smtp"

export interface Mail2000Credential { username: string; password: string }
export interface Mailbox { path: string; name: string; specialUse?: string }

export function readMail2000Credential(header: string | null): Mail2000Credential | null {
  const encoded = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(header ?? "")?.[1]
  if (!encoded) return null
  const bytes = Buffer.from(encoded, "base64")
  if (bytes.toString("base64") !== encoded) return null
  const value = bytes.toString("utf8")
  const separator = value.indexOf(":")
  if (separator < 1 || separator === value.length - 1 || value.length > 4609) return null
  const username = value.slice(0, separator)
  if (/[\u0000\r\n]/.test(username)) return null
  return { username, password: value.slice(separator + 1) }
}

export function createMail2000Handler(options: Partial<Mail2000Imap> & { caldav?: Mail2000Dav; carddav?: Mail2000Dav; sendMail?: (credential: Mail2000Credential, args: OutgoingMail) => Promise<unknown> } = {}) {
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname
    if (path === "/health") return Response.json({ service: "genio-connector-mail2000", status: "ready" })
    if (path !== "/mcp") return new Response(null, { status: 404 })
    const credential = readMail2000Credential(request.headers.get("authorization"))
    const server = new McpServer({ name: "genio-mail2000", version: "0.1.0" })
    server.registerTool("list_mailboxes", {
      title: "列出 Mail2000 郵件資料夾", description: "使用目前使用者的 Mail2000 連線列出可用郵件資料夾。", inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async () => {
      if (!credential) return { isError: true, content: [{ type: "text", text: "MAIL2000_CONNECTION_REQUIRED" }] }
      try {
        if (!options.listMailboxes) return { isError: true, content: [{ type: "text", text: "CONNECTOR_CONFIGURATION_REQUIRED" }] }
        const result = { mailboxes: await options.listMailboxes(credential) }
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result }
      } catch {
        return { isError: true, content: [{ type: "text", text: "MAIL2000_IMAP_CONNECTION_FAILED" }] }
      }
    })
    const folder = z.string().min(1).max(1024).regex(/^[^\x00\r\n]+$/)
    const reference = { folder, uid: z.number().int().min(1), uid_validity: z.string().regex(/^[0-9]+$/) }
    const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    const write = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    const execute = async (operation: (credential: Mail2000Credential) => Promise<unknown>, structured = false) => {
      if (!credential) return { isError: true, content: [{ type: "text" as const, text: "MAIL2000_CONNECTION_REQUIRED" }] }
      if (!options.listMailboxes) return { isError: true, content: [{ type: "text" as const, text: "CONNECTOR_CONFIGURATION_REQUIRED" }] }
      try {
        const result = await operation(credential)
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], ...(structured && result !== null && typeof result === "object" ? { structuredContent: result as Record<string, unknown> } : {}) }
      }
      catch (error) {
        const safe = error instanceof Error && /^MAIL2000_[A-Z_]+$/.test(error.message) ? error.message : "MAIL2000_OPERATION_FAILED"
        return { isError: true, content: [{ type: "text" as const, text: safe }] }
      }
    }
    server.registerTool("search_mail", { title: "搜尋郵件", description: "搜尋 Mail2000 郵件，回傳 UID 與 uid_validity 供後續讀取或管理。", inputSchema: { folder: folder.default("INBOX"), text: z.string().max(1000).optional(), from: z.string().max(512).optional(), unseen: z.boolean().optional(), limit: z.number().int().min(1).max(100).default(20) }, annotations: read }, (args) => execute((credential) => options.search!(credential, args)))
    server.registerTool("read_mail", { title: "讀取郵件", description: "讀取指定 UID 的郵件；內容最多 100KB，過長會標示 truncated。", inputSchema: reference, annotations: read }, (args) => execute((credential) => options.read!(credential, args)))
    server.registerTool("set_mail_flags", { title: "更新郵件旗標", description: "設定指定郵件的已讀、星號等旗標，取代原旗標集合。", inputSchema: { ...reference, flags: z.array(z.enum(["\\Seen", "\\Flagged", "\\Answered", "\\Draft"])).max(4) }, annotations: { ...write, idempotentHint: true } }, (args) => execute((credential) => options.setFlags!(credential, args)))
    server.registerTool("move_mail", { title: "搬移郵件", description: "將指定 UID 的郵件搬到目的資料夾。", inputSchema: { ...reference, destination: folder }, annotations: write }, (args) => execute((credential) => options.move!(credential, args)))
    server.registerTool("delete_mail", { title: "刪除郵件", description: "永久刪除指定 UID 的郵件。", inputSchema: reference, annotations: write }, (args) => execute((credential) => options.delete!(credential, args)))
    server.registerTool("append_mail", { title: "新增郵件", description: "將 RFC822 格式郵件存入指定資料夾，不會寄送。重試可能重複建立。", inputSchema: { folder, raw_message: z.string().min(1).max(100000) }, annotations: write }, (args) => execute((credential) => options.append!(credential, args)))
    server.registerTool("create_mailbox", { title: "建立郵件資料夾", description: "建立 Mail2000 郵件資料夾。", inputSchema: { folder }, annotations: write }, (args) => execute((credential) => options.createFolder!(credential, args)))
    server.registerTool("rename_mailbox", { title: "重新命名資料夾", description: "重新命名或搬移 Mail2000 郵件資料夾。", inputSchema: { folder, destination: folder }, annotations: write }, (args) => execute((credential) => options.renameFolder!(credential, args)))
    server.registerTool("delete_mailbox", { title: "刪除郵件資料夾", description: "刪除指定資料夾及其中郵件。", inputSchema: { folder }, annotations: write }, (args) => execute((credential) => options.deleteFolder!(credential, args)))
    server.registerTool("send_mail", { title: "寄送郵件", description: "使用 Mail2000 帳號寄信；寄出無法撤回，重試可能重複寄送。in_reply_to 可指定回覆的 Message-ID。", inputSchema: sendMailSchema, annotations: { ...write, destructiveHint: false } }, (args) => execute((credential) => options.sendMail!(credential, args)))
    for (const [prefix, dav, label] of [["caldav", options.caldav, "行事曆"], ["carddav", options.carddav, "聯絡人"]] as const) {
      if (!dav) continue
      const collection = { collection_url: z.string().url() }
      const object = { ...collection, object_url: z.string().url(), etag: z.string().min(1).max(512).refine((value) => value !== "*" && !/[\r\n]/.test(value)) }
      const data = z.string().min(1).max(100000)
      server.registerTool(`${prefix}_list_collections`, { title: `列出${label}集合`, description: `列出目前帳號可存取的${label}集合。`, inputSchema: {}, annotations: read }, () => execute((credential) => dav!.list(credential)))
      server.registerTool(`${prefix}_read_objects`, { title: `讀取${label}`, description: `讀取集合中的${label}，保留原始 iCalendar/vCard 格式與 ETag。`, inputSchema: { ...collection, object_url: z.string().url().optional(), start: z.string().datetime().optional(), end: z.string().datetime().optional(), limit: z.number().int().min(1).max(100).default(20) }, annotations: read }, (args) => execute((credential) => dav!.read(credential, args)))
      if (prefix === "carddav") {
        server.registerTool("carddav_search_directory", {
          title: "搜尋 Mail2000 組織名錄",
          description: "搜尋目前使用者可讀取的 CardDAV 通訊錄，整理 vCard 姓名、Email、ORG、TITLE、CATEGORIES 與 KIND/MEMBER 群組成員。群組成員會依 Email 對回名錄中的姓名與職稱；結果是通訊錄線索，不代表公司組織圖或正式邀請名單。",
          inputSchema: { query: z.string().trim().min(1).max(200), kind: z.enum(["all", "person", "group"]).default("all"), limit: z.number().int().min(1).max(50).default(20) },
          annotations: read,
        }, (args) => execute((credential) => dav!.searchDirectory(credential, args), true))
        server.registerTool("carddav_get_self_context", {
          title: "查詢 Mail2000 本人通訊錄資料",
          description: "以目前 Mail2000 連線帳號的精確 Email 比對 CardDAV 個人聯絡人，回傳本人姓名、職稱與組織欄位；找不到時明確回報，不猜測身分。",
          inputSchema: {},
          annotations: read,
        }, () => execute((credential) => dav!.getSelfContext(credential), true))
      }
      server.registerTool(`${prefix}_create_object`, { title: `新增${label}`, description: `使用固定檔名新增${label}物件，不覆寫既有檔案。`, inputSchema: { ...collection, filename: z.string().regex(/^[A-Za-z0-9_-]+\.(ics|vcf)$/), data }, annotations: write }, (args) => execute((credential) => dav!.create(credential, args)))
      server.registerTool(`${prefix}_update_object`, { title: `更新${label}`, description: `以讀取時取得的 ETag 更新${label}，版本衝突時拒絕。`, inputSchema: { ...object, data }, annotations: write }, (args) => execute((credential) => dav!.update(credential, args)))
      server.registerTool(`${prefix}_delete_object`, { title: `刪除${label}`, description: `以讀取時取得的 ETag 刪除指定${label}物件。`, inputSchema: object, annotations: write }, (args) => execute((credential) => dav!.remove(credential, args)))
    }
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)
    try { return await transport.handleRequest(request) }
    finally { await server.close() }
  }
}
