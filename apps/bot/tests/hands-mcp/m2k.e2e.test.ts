import { afterAll, beforeAll, expect, test } from "bun:test"
import Fastify from "fastify"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { collectHandsAssets } from "../../server/hands-assets"
import { handsMcpManifest, issueHandsMcpGrant, type HandsMcpGrantHolder } from "../../server/hands-mcp-grant"
import { modelGatewayRelayRoutes } from "../../server/model-gateway-relay"
import { createMail2000Imap } from "../../../connectors/mail2000/imap"
import { createMail2000Handler } from "../../../connectors/mail2000/server"

const live = process.env.M2K_LIVE === "1"
const mail2000Credential = live
  ? { username: process.env.MAIL2000_USERNAME ?? "", password: process.env.MAIL2000_PASSWORD ?? "" }
  : { username: "person@gss.com.tw", password: "fixture-password" }
const packageRoot = resolve(import.meta.dir, "../../../connectors/mail2000/package")

type Row = { uid: number; subject: string; from: string; date: Date }
const daysAgo = (days: number, hour = 9) => new Date(Date.now() - days * 86_400_000 - hour * 3_600_000)
const fixture: Record<string, { uidValidity: bigint; rows: Row[] }> = {
  INBOX: { uidValidity: 11n, rows: [
    { uid: 1, subject: "週會提醒", from: "ting", date: daysAgo(1) },
    { uid: 2, subject: "Re: 國泰人壽 CSM 報價", from: "sales", date: daysAgo(2) },
  ] },
  Archive: { uidValidity: 22n, rows: [
    { uid: 30000, subject: "CFH 國泰金控 合約草案", from: "louis", date: daysAgo(3) },
    { uid: 30001, subject: "ServiceNow Workshop", from: "stan", date: daysAgo(4) },
    { uid: 29000, subject: "國泰 舊案（超出同步範圍）", from: "hugh", date: daysAgo(80) },
  ] },
  Bulk: { uidValidity: 33n, rows: Array.from({ length: 620 }, (_, index) => ({ uid: index + 1, subject: `通知 ${index}`, from: "noreply", date: daysAgo(index % 10, 1 + (index % 20) / 10) })) },
  Junk: { uidValidity: 44n, rows: [{ uid: 1, subject: "國泰 廣告", from: "spam", date: daysAgo(1) }] },
}

function fixtureImap() {
  let current = ""
  const writes: string[] = []
  const client = {
    get mailbox() { return { uidValidity: fixture[current]!.uidValidity } },
    async connect() {},
    async logout() {},
    async list() {
      return Object.keys(fixture).map((path) => ({ path, name: path, flags: new Set<string>(), ...(path === "Junk" ? { specialUse: "\\Junk" } : {}) }))
    },
    async getMailboxLock(folder: string) {
      if (!fixture[folder]) throw new Error("NO_MAILBOX")
      current = folder
      return { release() {} }
    },
    async search(criteria: { since?: Date; before?: Date }) {
      return fixture[current]!.rows.filter((row) => (!criteria.since || row.date >= criteria.since) && (!criteria.before || row.date < criteria.before)).map((row) => row.uid)
    },
    async *fetch(uids: number[]) {
      if (uids.length > 200) throw new Error("UID FETCH missing required argument")
      for (const row of fixture[current]!.rows.filter((item) => uids.includes(item.uid))) {
        yield { uid: row.uid, size: 100, flags: new Set<string>(), internalDate: row.date, envelope: { subject: row.subject, date: row.date, from: [{ name: row.from, address: `${row.from}@gss.com.tw` }], to: [], cc: [] } }
      }
    },
    async fetchOne(uid: string, query: { source?: unknown }) {
      const row = fixture[current]!.rows.find((item) => item.uid === Number(uid))
      if (!row) return undefined
      const source = query.source ? Buffer.from(`Subject: ${row.subject}\r\nFrom: ${row.from}@gss.com.tw\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n報價單請見附件，截止日為下週五。`) : undefined
      return { uid: row.uid, size: 200, flags: new Set<string>(), envelope: { subject: row.subject }, source }
    },
    async messageDelete() { writes.push("delete"); return true },
  }
  return { api: createMail2000Imap({ host: "mail.test", port: 993 }, () => client as never), writes }
}

const imap = live ? { api: createMail2000Imap({ host: "mail.gss.com.tw", port: 993 }), writes: [] as string[] } : fixtureImap()
const servers: Array<{ stop: () => unknown }> = []
const gatewayAuthorizations: string[] = []
const policyCalls: Array<Record<string, unknown>> = []
let home = ""
let grant = ""
let relayOrigin = ""
let egressOrigin = ""
let m2k = ""

beforeAll(async () => {
  const connectorHandle = createMail2000Handler(imap.api)
  const connector = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: connectorHandle })
  const gateway = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      gatewayAuthorizations.push(request.headers.get("authorization") ?? "")
      if (request.headers.get("authorization") !== "Bearer user-access-token") return new Response("forbidden", { status: 403 })
      const headers = new Headers(request.headers)
      headers.set("authorization", `Basic ${Buffer.from(`${mail2000Credential.username}:${mail2000Credential.password}`).toString("base64")}`)
      return fetch(`http://127.0.0.1:${connector.port}/mcp`, { method: request.method, headers, body: await request.text() })
    },
  })
  const platform = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => Response.json({ capabilities: [{ resource_id: "resource-mail2000", capability_id: "mail2000", access: "ENTITLED", publication_endpoint: { hostname: "mail2000.localhost", base_path: "/mcp" } }] }),
  })
  servers.push(connector, gateway, platform)
  process.env.GENIO_ONE_MCP_URL = `http://one.localhost:${gateway.port}/mcp`
  process.env.GENIO_ONE_PLATFORM_ORIGIN = `http://127.0.0.1:${platform.port}`

  const mounts = { "resource-mail2000": { resourceId: "resource-mail2000", capabilityId: "mail2000", serverName: "genio_mcp_mail2000", hostname: "mail2000.localhost", basePath: "/mcp" } }
  const session: HandsMcpGrantHolder & Record<string, unknown> = {
    id: "runtime-e2e",
    relaySecret: "app-server-only-secret",
    principal: { tenant_id: "tenant-uat", subject_id: "person-dylan", acting_client_id: "genio-one-bot", organization_ids: [], scopes: [] },
    accessToken: "user-access-token",
    selectedBotId: "bot-mail",
    managedMcpMountsByBot: { "bot-mail": mounts },
  }
  grant = issueHandsMcpGrant(session, { botId: "bot-mail", tier: "headless" })
  const app = Fastify()
  await modelGatewayRelayRoutes(app as never, {
    runtimeBroker: { get: (id: string) => id === "runtime-e2e" ? session : undefined, accessTokenForBot: () => "user-access-token" },
    botRegistry: { getOwned: (botId: string) => botId === "bot-mail" ? { id: botId, ownerOrganizationId: null, useCaseId: null, bindings: [{ resourceId: "resource-mail2000", capabilityId: "mail2000", state: "INSTALLED", kind: "MCP" }] } : null },
    runtimePolicy: {
      async authorize(input: Record<string, unknown>) {
        policyCalls.push(input)
        return { tenant_id: "tenant-uat", subject_id: "person-dylan", bot_id: "bot-mail", runtime_id: "codex", capability_id: "mcp.invoke", action: "invoke", target: "runtime:codex:mcp.invoke", decision: "ALLOW", reason_code: "RULE_ALLOW", constraints: [], obligations: [], correlation_id: input.correlationId, session_id: "runtime-e2e", evaluated_at: 1 }
      },
      async report() {},
    },
  } as never)
  relayOrigin = await app.listen({ port: 0, host: "127.0.0.1" })
  servers.push({ stop: () => app.close() })
  const egress = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url)
      const headers = new Headers(request.headers)
      headers.set("authorization", `Bearer ${grant}`)
      return fetch(new URL(url.pathname + url.search, relayOrigin), { method: request.method, headers, body: await request.text() })
    },
  })
  servers.push(egress)
  egressOrigin = `http://127.0.0.1:${egress.port}`

  home = mkdtempSync(join(tmpdir(), "m2k-hands-"))
  for (const asset of collectHandsAssets({ root: packageRoot, plugins: [{ name: "mail2000", marketplacePath: join(packageRoot, ".agents/plugins/marketplace.json") }] })) {
    const path = join(home, ".genio/plugins", asset.path)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, Buffer.from(asset.content))
  }
  mkdirSync(join(home, ".genio"), { recursive: true })
  writeFileSync(join(home, ".genio/mcp.json"), JSON.stringify(handsMcpManifest("runtime-e2e", { token: grant, relayOrigin: egressOrigin, botId: "bot-mail", mounts })))
  m2k = join(home, ".genio/plugins/mail2000/bin/m2k.mjs")
})

afterAll(async () => {
  for (const server of servers) await server.stop()
})

async function run(...args: string[]) {
  const child = Bun.spawn(["node", m2k, ...args], { env: { HOME: home, PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (exitCode !== 0) throw new Error(`m2k ${args.join(" ")} failed: ${stderr}`)
  return JSON.parse(stdout)
}

test("the plugin CLI and manifest land in hands without any credential", () => {
  const manifest = readFileSync(join(home, ".genio/mcp.json"), "utf8")
  const cli = readFileSync(m2k, "utf8")

  expect(manifest).not.toContain(grant)
  expect(manifest).not.toContain("user-access-token")
  expect(cli).not.toContain(grant)
})

test("m2k syncs recent mail through the governed relay and searches it locally, including Chinese", async () => {
  const days = live ? "7" : "30"
  const synced = await run("sync", "--days", days)
  expect(synced.messages).toBeGreaterThan(0)
  if (!live) {
    expect(synced.messages).toBe(624)
    expect(synced.gaps).toEqual([])
  }

  const hits = await run("search", "國泰", "--limit", "10")
  expect(hits.total).toBeGreaterThan(0)
  if (!live) expect(hits.messages.map((message: { subject: string }) => message.subject)).toEqual(["Re: 國泰人壽 CSM 報價", "CFH 國泰金控 合約草案"])

  if (live) console.info(JSON.stringify({ m2k_live: { synced: synced.messages, gaps: synced.gaps.length, hits: hits.total, relay_calls: policyCalls.length } }))
  const first = hits.messages[0]
  const read = await run("read", first.folder, String(first.uid), first.uid_validity)
  expect(read.uid).toBe(first.uid)
  if (!live) expect(JSON.stringify(read)).toContain("截止日為下週五")

  expect(new Set(gatewayAuthorizations)).toEqual(new Set(["Bearer user-access-token"]))
  expect(gatewayAuthorizations.length).toBe(policyCalls.length)
  expect(policyCalls.every((call) => call.capabilityId === "mcp.invoke" && call.botId === "bot-mail")).toBe(true)
}, 600_000)

test("the same hands identity cannot change mail, and nothing reaches the relay without the egress injection", async () => {
  const url = handsMcpManifest("runtime-e2e", { token: grant, relayOrigin: egressOrigin, botId: "bot-mail", mounts: { r: { resourceId: "resource-mail2000", capabilityId: "mail2000", serverName: "genio_mcp_mail2000", hostname: "mail2000.localhost", basePath: "/mcp" } } }).resources[0]!.url
  const body = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "delete_mail", arguments: { folder: "INBOX", uid: 1, uid_validity: "11" } } })
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" }
  const before = gatewayAuthorizations.length

  const denied = await fetch(url, { method: "POST", headers, body })
  expect(denied.status).toBe(403)
  expect(await denied.json()).toEqual({ error: "HANDS_MCP_TOOL_NOT_READ_ONLY" })
  const direct = await fetch(url.replace(egressOrigin, relayOrigin), { method: "POST", headers, body })
  expect(direct.status).toBe(401)
  expect(gatewayAuthorizations.length).toBe(before)
  expect(imap.writes).toEqual([])
})
