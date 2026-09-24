import { expect, test } from "bun:test"
import type { ImapFlow } from "imapflow"
import { createMail2000Imap } from "./imap"

type Row = { uid: number; subject: string; from: string; date: string }
const credential = { username: "user", password: "test" }

function mailbox(folders: Record<string, { uidValidity: bigint; rows: Row[] }>) {
  const searches: Array<{ folder: string; criteria: Record<string, unknown> }> = []
  const fetchSizes: number[] = []
  let current = ""
  let perMessageFetches = 0
  const client = {
    get mailbox() { return { uidValidity: folders[current]!.uidValidity } },
    async connect() {},
    async logout() {},
    async getMailboxLock(folder: string) { current = folder; return { release() {} } },
    async search(criteria: Record<string, unknown>) {
      searches.push({ folder: current, criteria })
      const since = criteria.since as Date | undefined
      return folders[current]!.rows.filter((row) => !since || Date.parse(row.date) >= since.getTime()).map((row) => row.uid)
    },
    async *fetch(uids: number[]) {
      fetchSizes.push(uids.length)
      for (const row of folders[current]!.rows.filter((item) => uids.includes(item.uid))) {
        yield { uid: row.uid, size: 1, flags: new Set<string>(), envelope: { subject: row.subject, date: new Date(row.date), from: [{ name: row.from, address: `${row.from}@gss.com.tw` }], to: [], cc: [] } }
      }
    },
    async fetchOne() { perMessageFetches++; return undefined },
  }
  const api = createMail2000Imap({ host: "mail.test", port: 993 }, () => client as unknown as ImapFlow)
  return { api, searches, fetchSizes, perMessageFetches: () => perMessageFetches }
}

const recent = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString()

test("Chinese keywords are matched on envelopes because Mail2000 SEARCH returns nothing for CJK", async () => {
  const box = mailbox({ Archive: { uidValidity: 7n, rows: [
    { uid: 1, subject: "國泰人壽 CSM 報價", from: "sales", date: recent(2) },
    { uid: 2, subject: "週會紀錄", from: "hugh", date: recent(1) },
  ] } })
  const result = await box.api.search(credential, { folder: "Archive", text: "國泰", limit: 20 })

  expect(result.messages.map((message) => message.uid)).toEqual([1])
  expect(result.total).toBe(1)
  expect(result).toMatchObject({ folder: "Archive", uid_validity: "7" })
  expect(box.searches[0]!.criteria).not.toHaveProperty("text")
  expect(box.searches[0]!.criteria).not.toHaveProperty("subject")
})

test("keyword search is bounded to a recent window unless the caller asks for older mail", async () => {
  const box = mailbox({ Archive: { uidValidity: 7n, rows: [
    { uid: 1, subject: "國泰 舊案", from: "sales", date: recent(200) },
    { uid: 2, subject: "國泰 新案", from: "sales", date: recent(3) },
  ] } })
  const bounded = await box.api.search(credential, { folder: "Archive", text: "國泰", limit: 20 })
  const widened = await box.api.search(credential, { folder: "Archive", text: "國泰", since: recent(365).slice(0, 10), limit: 20 })

  expect(bounded.messages.map((message) => message.uid)).toEqual([2])
  expect(widened.messages.map((message) => message.uid)).toEqual([2, 1])
})

test("results come from batched FETCH, not one round trip per message", async () => {
  const rows = Array.from({ length: 450 }, (_, index) => ({ uid: index + 1, subject: `ServiceNow ${index}`, from: "stan", date: recent(1) }))
  const box = mailbox({ Archive: { uidValidity: 7n, rows } })
  const result = await box.api.search(credential, { folder: "Archive", text: "servicenow", limit: 5 })

  expect(result.total).toBe(450)
  expect(result.messages).toHaveLength(5)
  expect(box.perMessageFetches()).toBe(0)
  expect(Math.max(...box.fetchSizes)).toBeLessThanOrEqual(200)
})

test("one call searches several folders and each hit carries the reference read_mail needs", async () => {
  const box = mailbox({
    INBOX: { uidValidity: 1n, rows: [{ uid: 5, subject: "今日提醒", from: "ting", date: recent(1) }] },
    Archive: { uidValidity: 9n, rows: [{ uid: 30000, subject: "CFH 合約", from: "louis", date: recent(0) }] },
  })
  const result = await box.api.search(credential, { folder: "INBOX", folders: ["INBOX", "Archive"], limit: 20 })

  expect(result.messages.map(({ folder, uid, uid_validity }) => ({ folder, uid, uid_validity }))).toEqual([
    { folder: "Archive", uid: 30000, uid_validity: "9" },
    { folder: "INBOX", uid: 5, uid_validity: "1" },
  ])
  expect(result.total).toBe(2)
})
