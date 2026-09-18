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
test("DAV discovery transport refuses credential forwarding to another origin", async () => {
  const dav = createMail2000Dav({ url: "https://mail.test/cal/", kind: "caldav" }, (async (options: Parameters<typeof createDAVClient>[0]) => {
    await expect(options.fetch!("https://other.test/steal", { headers: { authorization: "Basic test" } })).rejects.toThrow("MAIL2000_DAV_URL_REJECTED")
    return { async fetchCalendars() { return [] } }
  }) as unknown as typeof createDAVClient)
  expect(await dav.list(credential)).toEqual([])
})
