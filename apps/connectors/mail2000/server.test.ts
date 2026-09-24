import { test, expect } from "bun:test"
import { createMail2000Handler, readMail2000Credential } from "./server"
import type { Mail2000Dav } from "./dav"

function request(method: string, authorization?: string, name = "list_mailboxes", args: Record<string, unknown> = {}) {
  return new Request("http://mail.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(authorization ? { authorization } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: method === "tools/call" ? { name, arguments: args } : {} }) })
}
test("Mail2000 discovery requires no password, invocation does", async () => {
  let calls = 0
  const handle = createMail2000Handler({ listMailboxes: async () => { calls++; return [] } })
  const listed = await (await handle(request("tools/list"))).json() as any
  expect(listed.result.tools[0].name).toBe("list_mailboxes")
  const denied = await (await handle(request("tools/call"))).json() as any
  expect(denied.result.isError).toBe(true)
  expect(calls).toBe(0)
})
test("Mail2000 MCP forwards each caller credential to IMAP without including it in tool output", async () => {
  const users: string[] = []
  const handle = createMail2000Handler({ listMailboxes: async (credential) => {
    users.push(credential.username)
    expect(credential.password).toBe("test:password")
    return [{ path: "INBOX", name: "收件匣" }]
  } })
  for (const user of ["alice", "bob"]) {
    const body = await (await handle(request("tools/call", `Basic ${Buffer.from(`${user}:test:password`).toString("base64")}`))).text()
    expect(JSON.parse(body).result.structuredContent.mailboxes[0].path).toBe("INBOX")
    expect(body).not.toContain("password")
    expect(body).not.toContain(user)
  }
  expect(users).toEqual(["alice", "bob"])
  expect(readMail2000Credential("Bearer platform-token")).toBeNull()
  expect(readMail2000Credential("Basic !!!")).toBeNull()
})
test("Mail2000 publishes structured CardDAV directory tools through MCP", async () => {
  const carddav = {
    async list() { return [] },
    async read() { return { total: 0, objects: [] } },
    async searchDirectory(credential: { username: string }, args: { query: string }) {
      expect(credential.username).toBe("alice@example.com")
      return { query: args.query, directory_entries_scanned: 2, total_matches: 1, results: [{ full_name: "BDSVD", members: [{ email: "alice@example.com" }] }] }
    },
    async getSelfContext(credential: { username: string }) { return { match: "exact_email", self_contact: { full_name: credential.username } } },
    async create() { return {} },
    async update() { return {} },
    async remove() { return {} },
  } as unknown as Mail2000Dav
  const handle = createMail2000Handler({ listMailboxes: async () => [], carddav })
  const tools = await (await handle(request("tools/list"))).json() as any
  expect(tools.result.tools.map((tool: { name: string }) => tool.name)).toContain("carddav_search_directory")
  expect(tools.result.tools.map((tool: { name: string }) => tool.name)).toContain("carddav_get_self_context")
  const auth = `Basic ${Buffer.from("alice@example.com:secret").toString("base64")}`
  const response = await handle(request("tools/call", auth, "carddav_search_directory", { query: "BDSVD" }))
  const result = (await response.json() as any).result
  expect(result.structuredContent.total_matches).toBe(1)
  expect(result.structuredContent.results[0].members[0].email).toBe("alice@example.com")
  expect(await (await handle(request("tools/call", auth, "carddav_get_self_context"))).json()).toMatchObject({ result: { structuredContent: { match: "exact_email" } } })
})
