import { expect, test } from "bun:test"
import { mail2000DavSettings } from "./site"
import { createMail2000Dav } from "./dav"
import type { createDAVClient } from "tsdav"

test("GSS defaults use the user's full identity without appending a second domain", async () => {
  const settings = mail2000DavSettings({ imap_host: "mail.gss.com.tw" })
  let endpoint = ""
  const dav = createMail2000Dav({ url: settings.caldav_url!, kind: "caldav" }, (async (options: Parameters<typeof createDAVClient>[0]) => {
    endpoint = options.serverUrl
    return { async fetchCalendars() { return [] } }
  }) as unknown as typeof createDAVClient)
  await dav.list({ username: "alice@gss.com.tw", password: "test" })
  expect(endpoint).toBe("https://mail.gss.com.tw/cgi-bin/cal/caldav/calendars/alice%40gss.com.tw/default")
  expect(settings.carddav_url).toBe("https://mail.gss.com.tw/cgi-bin/carddav/principals/mPA.000@gss.com.tw")
})

test("custom DAV settings win and other IMAP hosts do not imply a web origin", () => {
  expect(mail2000DavSettings({ imap_host: "other.example" })).toEqual({ caldav_url: undefined, carddav_url: undefined })
  expect(mail2000DavSettings({ imap_host: "mail.gss.com.tw", caldav_url: "https://custom.example/calendar", carddav_url: "https://custom.example/contacts" })).toEqual({ caldav_url: "https://custom.example/calendar", carddav_url: "https://custom.example/contacts" })
})
