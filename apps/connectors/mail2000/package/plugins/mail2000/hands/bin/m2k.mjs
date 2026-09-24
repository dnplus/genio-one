#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const MANIFEST = process.env.GENIO_MCP_MANIFEST || join(homedir(), ".genio", "mcp.json")
const CACHE = join(process.env.M2K_HOME || join(homedir(), ".genio", "mail2000"), "cache.json")
const DEFAULT_DAYS = 14
const MAX_DAYS = 90
const PAGE = 500
const FOLDER_GROUP = 10
const STALE_MS = 60 * 60 * 1000
const DAY_MS = 86_400_000

function fail(error, detail) {
  console.error(JSON.stringify({ error, ...(detail ? { detail } : {}) }))
  process.exit(1)
}

function parse(argv) {
  const options = {}
  const positional = []
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (!value.startsWith("--")) { positional.push(value); continue }
    const key = value.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith("--")) options[key] = true
    else { options[key] = next; index++ }
  }
  return { options, positional }
}

function integer(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10)
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, min), max) : fallback
}

const day = (date) => date.toISOString().slice(0, 10)

function endpoint() {
  let manifest
  try { manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) } catch { fail("M2K_MANIFEST_UNAVAILABLE", MANIFEST) }
  const wanted = process.env.M2K_RESOURCE
  const resource = (manifest.resources ?? []).find((item) => wanted ? item.resource_id === wanted : /mail2000/i.test(`${item.server_name} ${item.resource_id}`))
  if (!resource?.url) fail("M2K_RESOURCE_NOT_MOUNTED")
  return resource.url
}

let nextId = 1
async function rpc(url, method, params) {
  let response
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, ...(params ? { params } : {}) }),
      signal: AbortSignal.timeout(180_000),
    })
  } catch (error) {
    fail("M2K_RELAY_UNREACHABLE", error instanceof Error ? error.name : String(error))
  }
  const text = await response.text()
  if (!response.ok) fail("M2K_RELAY_REJECTED", `${response.status} ${text.slice(0, 200)}`)
  const payload = (response.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((message) => "result" in message || "error" in message)
    : JSON.parse(text)
  if (!payload || payload.error) fail("M2K_MCP_ERROR", JSON.stringify(payload?.error ?? null))
  return payload.result
}

async function tool(url, name, args) {
  const result = await rpc(url, "tools/call", { name, arguments: args })
  const text = result?.content?.find((item) => item.type === "text")?.text ?? ""
  if (result?.isError) fail("M2K_TOOL_FAILED", `${name}: ${text}`)
  return result.structuredContent ?? JSON.parse(text)
}

async function connect() {
  const url = endpoint()
  await rpc(url, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "m2k", version: "1" } })
  const listed = await rpc(url, "tools/list")
  const names = new Set((listed?.tools ?? []).map((item) => item.name))
  for (const required of ["list_mailboxes", "search_mail", "read_mail"]) if (!names.has(required)) fail("M2K_TOOL_UNAVAILABLE", required)
  return url
}

async function syncRange(url, folders, since, before, messages, gaps) {
  const result = await tool(url, "search_mail", { folder: folders[0], folders, since, before, limit: PAGE })
  const days = Math.round((Date.parse(`${before}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / DAY_MS)
  if (result.total > result.messages.length && days > 1) {
    const middle = day(new Date(Date.parse(`${since}T00:00:00Z`) + Math.floor(days / 2) * DAY_MS))
    await syncRange(url, folders, since, middle, messages, gaps)
    await syncRange(url, folders, middle, before, messages, gaps)
    return
  }
  for (const message of result.messages) messages.set(`${message.folder}\u0000${message.uid_validity}\u0000${message.uid}`, message)
  if (result.total > result.messages.length) gaps.push({ day: since, folders, total: result.total, cached: result.messages.length })
}

function loadCache() {
  if (!existsSync(CACHE)) fail("M2K_CACHE_EMPTY", "run `m2k sync` first")
  const cache = JSON.parse(readFileSync(CACHE, "utf8"))
  return { ...cache, stale: Date.now() - Date.parse(cache.synced_at) > STALE_MS }
}

function cacheSummary(cache) {
  return { synced_at: cache.synced_at, since: cache.since, stale: cache.stale, messages: cache.messages.length, gaps: cache.gaps }
}

const commands = {
  async sync({ options }) {
    const days = integer(options.days, DEFAULT_DAYS, 1, MAX_DAYS)
    const since = day(new Date(Date.now() - (days - 1) * DAY_MS))
    const url = await connect()
    const { mailboxes } = await tool(url, "list_mailboxes", {})
    const folders = typeof options.folders === "string"
      ? options.folders.split(",").filter(Boolean)
      : mailboxes.filter((mailbox) => !/\\(Junk|Trash)/i.test(mailbox.specialUse ?? "")).map((mailbox) => mailbox.path)
    const messages = new Map()
    const gaps = []
    for (let index = 0; index < folders.length; index += FOLDER_GROUP) {
      await syncRange(url, folders.slice(index, index + FOLDER_GROUP), since, day(new Date(Date.now() + DAY_MS)), messages, gaps)
    }
    const cache = {
      version: 1,
      synced_at: new Date().toISOString(),
      since,
      folders,
      gaps,
      messages: [...messages.values()].filter((message) => !message.date || message.date.slice(0, 10) >= since).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "")),
    }
    mkdirSync(dirname(CACHE), { recursive: true, mode: 0o700 })
    writeFileSync(`${CACHE}.tmp`, JSON.stringify(cache), { mode: 0o600 })
    renameSync(`${CACHE}.tmp`, CACHE)
    console.log(JSON.stringify(cacheSummary({ ...cache, stale: false })))
  },

  async search({ options, positional }) {
    const cache = loadCache()
    const text = positional.join(" ").toLowerCase()
    const from = typeof options.from === "string" ? options.from.toLowerCase() : ""
    const people = (message) => (message.from ?? []).flatMap((item) => [item.name, item.address]).filter(Boolean).join(" ").toLowerCase()
    const hits = cache.messages.filter((message) =>
      (!text || `${message.subject ?? ""} ${people(message)}`.toLowerCase().includes(text)) &&
      (!from || people(message).includes(from)) &&
      (typeof options.folder !== "string" || message.folder === options.folder) &&
      (typeof options.since !== "string" || (message.date ?? "") >= options.since) &&
      (!options.unseen || !(message.flags ?? []).includes("\\Seen")))
    const limit = integer(options.limit, 20, 1, 200)
    console.log(JSON.stringify({ total: hits.length, cache: cacheSummary(cache), messages: hits.slice(0, limit) }))
  },

  async read({ positional }) {
    const [folder, uid, uidValidity] = positional
    if (!folder || !uid || !uidValidity) fail("M2K_USAGE", "m2k read <folder> <uid> <uid_validity>")
    const url = await connect()
    console.log(JSON.stringify(await tool(url, "read_mail", { folder, uid: Number(uid), uid_validity: uidValidity })))
  },

  async status() {
    console.log(JSON.stringify(existsSync(CACHE) ? cacheSummary(loadCache()) : { messages: 0 }))
  },

  async clean() {
    rmSync(CACHE, { force: true })
    console.log(JSON.stringify({ cleaned: true }))
  },
}

const [command, ...rest] = process.argv.slice(2)
const run = commands[command]
if (!run) fail("M2K_USAGE", "m2k sync [--days N] [--folders a,b] | search <text> [--from x] [--folder f] [--since YYYY-MM-DD] [--unseen] [--limit N] | read <folder> <uid> <uid_validity> | status | clean")
await run(parse(rest))
