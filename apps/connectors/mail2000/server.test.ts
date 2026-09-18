import { test, expect } from "bun:test"
import { createMail2000Handler, readMail2000Credential } from "./server"

function request(method: string, authorization?: string) {
  return new Request("http://mail.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(authorization ? { authorization } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: method === "tools/call" ? { name: "list_mailboxes", arguments: {} } : {} }) })
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
