import { instrumentModuleGraph, observedFetch } from "../../../packages/telemetry/src/operation-observability"
import { createDAVClient } from "tsdav"
import type { Mail2000Credential } from "./server"

export function davUrl(value: string, origin?: string): URL {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (origin && url.origin !== origin)) throw new Error("MAIL2000_DAV_URL_REJECTED")
  return url
}

export function createMail2000Dav(config: { url: string; kind: "caldav" | "carddav" }, factory = createDAVClient) {
  const configured = davUrl(config.url)
  async function client(credential: Mail2000Credential) {
    const guardedFetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      let request = new Request(input, init)
      for (let redirects = 0; redirects <= 3; redirects++) {
        davUrl(request.url, configured.origin)
        const replay = request.clone()
        const response = await observedFetch("genio-connector-mail2000", request, { redirect: "manual", signal: AbortSignal.timeout(30_000) })
        if (![301, 302, 307, 308].includes(response.status)) return response
        const location = response.headers.get("location")
        if (!location) return response
        const target = davUrl(new URL(location, request.url).toString(), configured.origin)
        await response.body?.cancel()
        request = new Request(target, replay)
      }
      throw new Error("MAIL2000_DAV_REDIRECT_LIMIT")
    }, { preconnect: fetch.preconnect })
    return factory({ serverUrl: configured.toString().replace("%7Busername%7D", encodeURIComponent(credential.username)).replace("{username}", encodeURIComponent(credential.username)), credentials: credential, authMethod: "Basic", defaultAccountType: config.kind, fetch: guardedFetch })
  }
  async function collection(credential: Mail2000Credential, url: string) {
    const target = davUrl(url, configured.origin).toString()
    const dav = await client(credential)
    const collections = config.kind === "caldav" ? await dav.fetchCalendars() : await dav.fetchAddressBooks()
    const selected = collections.find((item) => new URL(item.url).toString() === target)
    if (!selected) throw new Error("MAIL2000_DAV_COLLECTION_NOT_FOUND")
    return { dav, selected }
  }
  function objectUrl(collectionUrl: string, value: string) {
    const target = davUrl(value, configured.origin)
    const parent = davUrl(collectionUrl, configured.origin)
    if (!target.pathname.startsWith(`${parent.pathname.replace(/\/$/, "")}/`) || /%2f|%5c|%2e/i.test(target.pathname) || target.search) throw new Error("MAIL2000_DAV_OBJECT_REJECTED")
    return target.toString()
  }
  async function result(response: Response) {
    if (!response.ok) throw new Error(response.status === 412 ? "MAIL2000_DAV_CONFLICT" : "MAIL2000_DAV_OPERATION_FAILED")
    return { status: response.status, etag: response.headers.get("etag") }
  }
  const api = {
    async list(credential: Mail2000Credential) {
      const dav = await client(credential)
      const rows = config.kind === "caldav" ? await dav.fetchCalendars() : await dav.fetchAddressBooks()
      return rows.map((row) => ({ url: row.url, display_name: row.displayName ?? "" }))
    },
    async read(credential: Mail2000Credential, args: { collection_url: string; object_url?: string; start?: string; end?: string; limit: number }) {
      if (Boolean(args.start) !== Boolean(args.end) || (args.start && args.end && Date.parse(args.start) >= Date.parse(args.end))) throw new Error("MAIL2000_DAV_TIME_RANGE_INVALID")
      const { dav, selected } = await collection(credential, args.collection_url)
      const objectUrls = args.object_url ? [objectUrl(selected.url, args.object_url)] : undefined
      const rows = config.kind === "caldav"
        ? await dav.fetchCalendarObjects({ calendar: selected, objectUrls, ...(args.start && args.end ? { timeRange: { start: args.start, end: args.end } } : {}) })
        : await dav.fetchVCards({ addressBook: selected, objectUrls })
      return { total: rows.length, objects: rows.slice(0, args.limit).map((row) => ({ url: row.url, etag: row.etag, data: String(row.data ?? "").slice(0, 100_000), truncated: String(row.data ?? "").length > 100_000 })) }
    },
    async create(credential: Mail2000Credential, args: { collection_url: string; filename: string; data: string }) {
      if (!/^[A-Za-z0-9_-]+\.(ics|vcf)$/.test(args.filename) || !args.filename.endsWith(config.kind === "caldav" ? ".ics" : ".vcf")) throw new Error("MAIL2000_DAV_FILENAME_INVALID")
      const { dav, selected } = await collection(credential, args.collection_url)
      const response = config.kind === "caldav"
        ? await dav.createCalendarObject({ calendar: selected, filename: args.filename, iCalString: args.data, headers: { "If-None-Match": "*" } })
        : await dav.createVCard({ addressBook: selected, filename: args.filename, vCardString: args.data, headers: { "If-None-Match": "*" } })
      return { ...await result(response), url: `${selected.url.replace(/\/$/, "")}/${args.filename}` }
    },
    async update(credential: Mail2000Credential, args: { collection_url: string; object_url: string; etag: string; data: string }) {
      const { dav, selected } = await collection(credential, args.collection_url)
      const object = { url: objectUrl(selected.url, args.object_url), etag: args.etag, data: args.data }
      return result(config.kind === "caldav" ? await dav.updateCalendarObject({ calendarObject: object }) : await dav.updateVCard({ vCard: object }))
    },
    async remove(credential: Mail2000Credential, args: { collection_url: string; object_url: string; etag: string }) {
      const { dav, selected } = await collection(credential, args.collection_url)
      const object = { url: objectUrl(selected.url, args.object_url), etag: args.etag }
      return result(config.kind === "caldav" ? await dav.deleteCalendarObject({ calendarObject: object }) : await dav.deleteVCard({ vCard: object }))
    },
  }
  instrumentModuleGraph({ dav: api }, "genio-connector-mail2000")
  return api
}
export type Mail2000Dav = ReturnType<typeof createMail2000Dav>
