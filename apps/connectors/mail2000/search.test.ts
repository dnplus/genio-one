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
    get mailbox() { return { uidValidity: folders[current]!.uidValidity, uidNext: Math.max(0, ...folders[current]!.rows.map((row) => row.uid)) + 1, exists: folders[current]!.rows.length } },
    async connect() {},
    async logout() {},
    async getMailboxLock(folder: string) { current = folder; return { release() {} } },
    async search(criteria: Record<string, unknown>) {
      searches.push({ folder: current, criteria })
      const since = criteria.since as Date | undefined
      const [lowest, highest] = String(criteria.uid).split(":").map(Number)
      return folders[current]!.rows.filter((row) => row.uid >= lowest! && row.uid <= highest! && (!since || Date.parse(row.date) >= since.getTime())).map((row) => row.uid)
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
  expect(result.truncated).toBe(true)
})

test("an older matching UID outside the range is reported as an incomplete search", async () => {
  const box = mailbox({ Archive: { uidValidity: 7n, rows: [
    { uid: 1, subject: "older match", from: "sales", date: recent(100) },
    { uid: 10_000, subject: "recent match", from: "sales", date: recent(1) },
  ] } })
  const result = await box.api.search(credential, { folder: "Archive", text: "match", since: recent(365).slice(0, 10), limit: 20 })
  expect(box.searches[0]!.criteria.uid).toBe("5001:10000")
  expect(result.messages.map((message) => message.uid)).toEqual([10_000])
  expect(result).toMatchObject({ total: 1, scanned: 1, truncated: true })
  const unfiltered = await box.api.search(credential, { folder: "Archive", limit: 20 })
  expect(unfiltered.messages.map((message) => message.uid)).toEqual([10_000])
  expect(unfiltered).toMatchObject({ total: 1, truncated: true })
})

test("a failed upstream SEARCH cannot be reported as a complete empty result", async () => {
  let released = false
  const client = {
    mailbox: { uidValidity: 7n, uidNext: 2, exists: 1 },
    async connect() {},
    async logout() {},
    async getMailboxLock() { return { release() { released = true } } },
    async search() { return false },
  }
  const api = createMail2000Imap({ host: "mail.test", port: 993 }, () => client as unknown as ImapFlow)
  await expect(api.search(credential, { folder: "INBOX", limit: 20 })).rejects.toThrow("MAIL2000_SEARCH_FAILED")
  expect(released).toBe(true)
})

test("an empty upstream SEARCH is a successful search with no matches", async () => {
  let released = false
  const client = {
    mailbox: { uidValidity: 7n, uidNext: 2, exists: 1 },
    async connect() {},
    async logout() {},
    async getMailboxLock() { return { release() { released = true } } },
    async search(criteria: { seen: boolean; uid: string }) {
      expect(criteria).toMatchObject({ seen: false, uid: "1:1" })
      return []
    },
    async *fetch() { throw new Error("FETCH_UNEXPECTED") },
  }
  const api = createMail2000Imap({ host: "mail.test", port: 993 }, () => client as unknown as ImapFlow)
  expect(await api.search(credential, { folder: "INBOX", unseen: true, limit: 20 })).toMatchObject({ folder: "INBOX", uid_validity: "7", total: 0, truncated: false, messages: [] })
  expect(released).toBe(true)
})

test("keyword envelope scans share one budget across folders", async () => {
  const rows = Array.from({ length: 6000 }, (_, index) => ({ uid: index + 1, subject: "match", from: "sales", date: recent(1) }))
  const box = mailbox({ INBOX: { uidValidity: 1n, rows }, Archive: { uidValidity: 2n, rows } })
  const result = await box.api.search(credential, { folder: "INBOX", folders: ["INBOX", "Archive"], text: "match", limit: 5 })
  expect(result).toMatchObject({ total: 5000, scanned: 5000, truncated: true })
  expect(box.fetchSizes.reduce((sum, size) => sum + size, 0)).toBe(5000)
})

test("a large mailbox is searched through a bounded upstream UID range", async () => {
  let requested = ""
  let fetched = 0
  const client = {
    mailbox: { uidValidity: 12n, uidNext: 100_001, exists: 100_000 },
    async connect() {},
    async logout() {},
    async getMailboxLock() { return { release() {} } },
    async search(criteria: { uid: string }) {
      requested = criteria.uid
      const [lowest, highest] = criteria.uid.split(":").map(Number)
      return Array.from({ length: highest! - lowest! + 1 }, (_, index) => lowest! + index)
    },
    async *fetch(uids: number[]) {
      fetched += uids.length
      for (const uid of uids) yield { uid, flags: new Set<string>(), envelope: { subject: "match", date: new Date() } }
    },
  }
  const api = createMail2000Imap({ host: "mail.test", port: 993 }, () => client as unknown as ImapFlow)
  const result = await api.search(credential, { folder: "INBOX", text: "match", limit: 5 })
  expect(requested).toBe("95001:100000")
  expect(fetched).toBe(5000)
  expect(result).toMatchObject({ total: 5000, scanned: 5000, truncated: true })
  expect(result.messages).toHaveLength(5)
})
