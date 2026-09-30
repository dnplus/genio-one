export interface Mail2000ReadOnlyMcpToolMetadata {
  title: string
  description: string
  input_schema: Record<string, unknown>
}

const draft7 = "http://json-schema.org/draft-07/schema#"

function objectSchema(properties: Record<string, unknown>, required?: string[]): Record<string, unknown> {
  return {
    $schema: draft7,
    type: "object",
    properties,
    ...(required?.length ? { required } : {}),
  }
}

const folder = {
  type: "string",
  minLength: 1,
  maxLength: 1024,
  pattern: "^[^\\x00\\r\\n]+$",
}

const uid = {
  type: "integer",
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
}

const uidValidity = {
  type: "string",
  pattern: "^[0-9]+$",
}

const reference = objectSchema({
  folder,
  uid,
  uid_validity: uidValidity,
}, ["folder", "uid", "uid_validity"])

export const MAIL2000_READ_ONLY_MCP_TOOLS: Readonly<Record<string, Mail2000ReadOnlyMcpToolMetadata>> = {
  "mail2000__list_mailboxes": {
    title: "列出 Mail2000 郵件資料夾",
    description: "使用目前使用者的 Mail2000 連線列出可用郵件資料夾。",
    input_schema: objectSchema({}),
  },
  "mail2000__search_mail": {
    title: "搜尋郵件",
    description: "搜尋 Mail2000 郵件，依日期新到舊回傳，每筆附 folder、uid、uid_validity 供後續讀取或管理。folders 可一次搜尋多個資料夾（先用 list_mailboxes 取得）。text 比對主旨、寄件者、收件者與副本，不含內文；有 text 或 from 時預設只搜最近 30 天，可用 since 指定更早日期；truncated 為 true 時 total 只是已掃描範圍內的筆數。",
    input_schema: objectSchema({
      folder: { default: "INBOX", ...folder },
      folders: {
        minItems: 1,
        maxItems: 10,
        type: "array",
        items: folder,
      },
      text: { type: "string", maxLength: 1000 },
      from: { type: "string", maxLength: 512 },
      unseen: { type: "boolean" },
      since: { description: "YYYY-MM-DD，含當日", type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      before: { description: "YYYY-MM-DD，不含當日", type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      limit: { default: 20, type: "integer", minimum: 1, maximum: 500 },
    }),
  },
  "mail2000__read_mail": {
    title: "讀取郵件",
    description: "讀取指定 UID 的郵件；內容最多 100KB，過長會標示 truncated。",
    input_schema: reference,
  },
}

export function mail2000ReadOnlyMcpToolMetadata(name: string): Mail2000ReadOnlyMcpToolMetadata | undefined {
  return MAIL2000_READ_ONLY_MCP_TOOLS[name]
}
