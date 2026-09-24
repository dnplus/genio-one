import { expect, test } from "bun:test"
import type { createDAVClient } from "tsdav"
import { createMail2000Dav } from "./dav"

const credential = { username: "alice", password: "test" }
const collection = "https://mail.test/cal/alice/"
test("CalDAV create protects existing objects and update retains ETag", async () => {
  let created = false
  let updated = false
  const dav = createMail2000Dav({ url: "https://mail.test/cal/", kind: "caldav" }, (async (options: Parameters<typeof createDAVClient>[0]) => {
    expect(options.credentials).toEqual(credential)
    return {
      async fetchCalendars() { return [{ url: collection }] },
      async createCalendarObject(input: { headers: Record<string, string>; filename: string }) {
        expect(input.headers["If-None-Match"]).toBe("*")
        expect(input.filename).toBe("event.ics")
        created = true
        return new Response(null, { status: 201, headers: { etag: '"v1"' } })
      },
      async updateCalendarObject(input: { calendarObject: { etag: string } }) {
        expect(input.calendarObject.etag).toBe('"v1"')
        updated = true
        return new Response(null, { status: 204 })
      },
    }
  }) as typeof createDAVClient)
  const result = await dav.create(credential, { collection_url: collection, filename: "event.ics", data: "BEGIN:VCALENDAR\r\nEND:VCALENDAR" })
  expect(result.url).toBe(`${collection}event.ics`)
  await dav.update(credential, { collection_url: collection, object_url: result.url, etag: '"v1"', data: "updated" })
  expect(created && updated).toBe(true)
  await expect(dav.create(credential, { collection_url: collection, filename: "../event.ics", data: "invalid" })).rejects.toThrow("MAIL2000_DAV_FILENAME_INVALID")
  await expect(dav.update(credential, { collection_url: collection, object_url: "https://other.test/event.ics", etag: '"v1"', data: "invalid" })).rejects.toThrow("MAIL2000_DAV_URL_REJECTED")
})
test("CardDAV rejects a conflict and objects outside the selected address book", async () => {
  const dav = createMail2000Dav({ url: "https://mail.test/addressbooks/", kind: "carddav" }, (async () => ({
    async fetchAddressBooks() { return [{ url: "https://mail.test/addressbooks/alice/" }] },
    async deleteVCard() { return new Response(null, { status: 412 }) },
  })) as unknown as typeof createDAVClient)
  const args = { collection_url: "https://mail.test/addressbooks/alice/", object_url: "https://mail.test/addressbooks/alice/contact.vcf", etag: '"old"' }
  await expect(dav.remove(credential, args)).rejects.toThrow("MAIL2000_DAV_CONFLICT")
  await expect(dav.remove(credential, { ...args, object_url: "https://mail.test/addressbooks/bob/contact.vcf" })).rejects.toThrow("MAIL2000_DAV_OBJECT_REJECTED")
})
test("CardDAV searches groups and resolves exact member emails from the same directory", async () => {
  const addressBook = { url: "https://mail.test/addressbooks/company/", displayName: "Company" }
  const dav = createMail2000Dav({ url: "https://mail.test/addressbooks/", kind: "carddav" }, (async () => ({
    async fetchAddressBooks() { return [addressBook] },
    async fetchVCards(input: { addressBook: { url: string } }) {
      expect(input.addressBook.url).toBe(addressBook.url)
      return [
        { url: `${addressBook.url}bdsvd.vcf`, data: "BEGIN:VCARD\r\nVERSION:4.0\r\nFN:BDSVD\r\nKIND:group\r\nMEMBER:mailto:member@example.com\r\nEND:VCARD" },
        { url: `${addressBook.url}member.vcf`, data: "BEGIN:VCARD\r\nVERSION:4.0\r\nFN:王小明\r\nEMAIL:member@example.com\r\nORG:GSS;BDSVD\r\nEND:VCARD" },
      ]
    },
  })) as unknown as typeof createDAVClient)
  const result = await dav.searchDirectory(credential, { query: "BDSVD", kind: "group", limit: 10 })
  expect(result.address_books_scanned).toBe(1)
  expect(result.directory_entries_scanned).toBe(2)
  expect(result.results[0]?.members).toEqual([
    { email: "member@example.com", full_name: "王小明", organization: "GSS / BDSVD", title: null, found_in_directory: true },
  ])
  const self = await dav.getSelfContext({ username: "member@example.com", password: "secret" })
  expect(self.match).toBe("exact_email")
  expect(self.self_contact?.full_name).toBe("王小明")
  expect(await dav.getSelfContext({ username: "other@example.com", password: "secret" })).toMatchObject({ match: "not_found", self_contact: null })
})
test("CardDAV directory operations reject CalDAV clients", async () => {
  const dav = createMail2000Dav({ url: "https://mail.test/cal/", kind: "caldav" }, (async () => ({})) as unknown as typeof createDAVClient)
  await expect(dav.searchDirectory(credential, { query: "BDSVD", kind: "all", limit: 10 })).rejects.toThrow("MAIL2000_CARDDAV_REQUIRED")
  await expect(dav.getSelfContext(credential)).rejects.toThrow("MAIL2000_CARDDAV_REQUIRED")
})
test("DAV discovery transport refuses credential forwarding to another origin", async () => {
  const dav = createMail2000Dav({ url: "https://mail.test/cal/", kind: "caldav" }, (async (options: Parameters<typeof createDAVClient>[0]) => {
    await expect(options.fetch!("https://other.test/steal", { headers: { authorization: "Basic test" } })).rejects.toThrow("MAIL2000_DAV_URL_REJECTED")
    return { async fetchCalendars() { return [] } }
  }) as unknown as typeof createDAVClient)
  expect(await dav.list(credential)).toEqual([])
})
