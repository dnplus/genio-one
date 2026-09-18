import { test, expect } from "bun:test"
import type { ImapFlow } from "imapflow"
import { createMail2000Imap } from "./imap"
import { createMail2000Handler } from "./server"

function fixture() {
  let released = 0
  let loggedOut = 0
  let deleted = 0
  const locks: boolean[] = []
  const client = {
    mailbox: { uidValidity: 42n },
    async connect() {},
    async logout() { loggedOut++ },
    async getMailboxLock(_folder: string, options: { readOnly: boolean }) { locks.push(options.readOnly); return { release() { released++ } } },
    async fetchOne(_uid: string, query: { source?: unknown }, options: { uid: boolean }) {
      expect(options.uid).toBe(true)
      return { uid: 9, size: 200000, source: query.source ? Buffer.from("Subject: Test\r\n\r\nBody") : undefined, flags: new Set(["\\Seen"]), envelope: { subject: "Test" } }
    },
    async messageDelete(uids: number[], options: { uid: boolean }) { expect(uids).toEqual([9]); expect(options.uid).toBe(true); deleted++; return true },
  }
  const api = createMail2000Imap({ host: "mail.test", port: 993 }, () => client as unknown as ImapFlow)
  return { api, counts: () => ({ released, loggedOut, deleted, locks }) }
}
const credential = { username: "user", password: "test" }
const reference = { folder: "INBOX", uid: 9, uid_validity: "42" }

test("stale mailbox UIDVALIDITY refuses deletion and releases the lock", async () => {
  const { api, counts } = fixture()
  await expect(api.delete(credential, { ...reference, uid_validity: "41" })).rejects.toThrow("MAIL2000_MAILBOX_CHANGED")
  expect(counts()).toEqual({ released: 1, loggedOut: 1, deleted: 0, locks: [false] })
})
test("reads use a read-only mailbox and report truncated source", async () => {
  const { api, counts } = fixture()
  const value = await api.read(credential, reference)
  expect(value.truncated).toBe(true)
  expect(value.uid_validity).toBe("42")
  expect(counts()).toEqual({ released: 1, loggedOut: 1, deleted: 0, locks: [true] })
})
test("valid deletion targets the exact UID", async () => {
  const { api, counts } = fixture()
  expect((await api.delete(credential, reference)).deleted).toBe(true)
  expect(counts()).toEqual({ released: 1, loggedOut: 1, deleted: 1, locks: [false] })
})
test("MCP publishes all IMAP operations with read/write classifications", async () => {
  const { api } = fixture()
  const handle = createMail2000Handler(api)
  const response = await handle(new Request("http://mail.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }))
  const body = await response.json() as { result: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }> } }
  expect(body.result.tools.filter((tool) => !tool.name.startsWith("caldav_") && !tool.name.startsWith("carddav_") && tool.name !== "send_mail")).toHaveLength(10)
  expect(body.result.tools.find((tool) => tool.name === "read_mail")?.annotations.readOnlyHint).toBe(true)
  expect(body.result.tools.find((tool) => tool.name === "delete_mail")?.annotations.destructiveHint).toBe(true)
})
