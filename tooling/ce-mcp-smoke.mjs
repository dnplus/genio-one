#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

function endpoint(value, label) {
  const url = new URL(value)
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.hostname.endsWith(".localhost")
  if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && local))) throw new Error(`${label} must use HTTPS, or HTTP on loopback, without credentials or fragments`)
  return url
}

export function parseOptions(argv) {
  const options = { clientId: "codex-mcp", arguments: {} }
  const names = { "--url": "url", "--issuer": "issuer", "--client-id": "clientId", "--token-env": "tokenEnv", "--tool": "tool", "--deny-tool": "denyTool" }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index], value = argv[++index]
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`)
    if (flag === "--argument") {
      const equals = value.indexOf("=")
      if (equals < 1) throw new Error("--argument uses key=value")
      const key = value.slice(0, equals)
      if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Invalid argument key")
      options.arguments[key] = value.slice(equals + 1)
    } else if (names[flag]) options[names[flag]] = value
    else throw new Error(`Unknown option ${flag}`)
  }
  if (!options.url || !options.tool) throw new Error("--url and --tool are required")
  endpoint(options.url, "Gateway URL")
  if (options.tokenEnv && options.issuer) throw new Error("Use either --issuer or --token-env")
  if (!options.tokenEnv && !options.issuer) throw new Error("Supply --issuer for browser sign-in, or --token-env for an existing access token")
  if (options.issuer) endpoint(options.issuer, "OIDC issuer")
  if (options.tokenEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.tokenEnv)) throw new Error("Invalid environment variable name")
  return options
}

export function parseRpc(body) {
  try { return JSON.parse(body) } catch { /* Streamable HTTP SSE */ }
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
    if (!data) continue
    try { const value = JSON.parse(data); if (Object.hasOwn(value, "result") || Object.hasOwn(value, "error")) return value } catch { /* Ignore non-JSON events */ }
  }
  return null
}

export async function browserToken(issuer, clientId, { announce = (url) => console.error(`Open this URL in your browser to sign in:\n${url}`), timeoutMs = 180000 } = {}) {
  const expectedIssuer = endpoint(issuer, "OIDC issuer").href.replace(/\/$/, "")
  const response = await fetch(`${expectedIssuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10000), redirect: "error" })
  if (!response.ok) throw new Error(`OIDC discovery returned HTTP ${response.status}`)
  const metadata = await response.json()
  if (metadata.issuer !== expectedIssuer) throw new Error("OIDC issuer does not match discovery")
  for (const name of ["authorization_endpoint", "token_endpoint"]) {
    if (endpoint(metadata[name], name).origin !== new URL(expectedIssuer).origin) throw new Error("OIDC endpoints must share the configured issuer origin")
  }
  const state = randomBytes(24).toString("base64url"), verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  let complete, fail, timer
  const callback = new Promise((yes, no) => { complete = yes; fail = no })
  // Attach a rejection handler before the browser can return an error.
  callback.catch(() => {})
  const server = createServer((request, reply) => {
    const url = new URL(request.url, "http://127.0.0.1")
    reply.setHeader("content-type", "text/plain; charset=utf-8")
    reply.setHeader("cache-control", "no-store")
    if (request.method !== "GET" || url.pathname !== "/callback") { reply.writeHead(404).end(); return }
    if (url.searchParams.get("state") !== state) { reply.writeHead(400).end("Invalid sign-in state. Return to the original sign-in link."); return }
    if (url.searchParams.has("error") || !url.searchParams.get("code")) {
      reply.writeHead(400).end("Sign-in did not complete. Return to the terminal.")
      fail(new Error("Browser sign-in was denied or returned no code")); return
    }
    reply.end("Sign-in complete. Return to the terminal for the MCP verification result.")
    complete(url.searchParams.get("code"))
  })
  try {
    await new Promise((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes) })
    const redirectUri = `http://127.0.0.1:${server.address().port}/callback`
    const authorization = new URL(metadata.authorization_endpoint)
    for (const [key, value] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: "openid", state, code_challenge: challenge, code_challenge_method: "S256" })) authorization.searchParams.set(key, value)
    timer = setTimeout(() => fail(new Error("Browser sign-in timed out; run the command again")), timeoutMs)
    await announce(authorization.href)
    const code = await callback
    const tokenResponse = await fetch(metadata.token_endpoint, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, redirect_uri: redirectUri, code, code_verifier: verifier }), signal: AbortSignal.timeout(15000), redirect: "error" })
    if (!tokenResponse.ok) throw new Error(`OIDC code exchange returned HTTP ${tokenResponse.status}`)
    const token = await tokenResponse.json()
    if (!token.access_token) throw new Error("OIDC response contained no access token")
    return token.access_token
  } finally {
    clearTimeout(timer)
    server.closeAllConnections()
    await new Promise((yes) => server.close(yes))
  }
}

export async function smoke(options) {
  let session, token
  const requests = []
  async function rpc(auth, method, params, id) {
    const correlationId = randomUUID()
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26", "x-request-id": correlationId }
    if (auth) headers.authorization = `Bearer ${auth}`
    if (session) headers["mcp-session-id"] = session
    const response = await fetch(options.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, ...(params ? { params } : {}) }), redirect: "error", signal: AbortSignal.timeout(45000) })
    const body = await response.text(), payload = parseRpc(body)
    session = response.headers.get("mcp-session-id") ?? session
    const receipt = { method, authenticated: Boolean(auth), correlation_id: correlationId, status: response.status, response_bytes: Buffer.byteLength(body), response_sha256: createHash("sha256").update(body).digest("hex"), ...(payload?.result?.isError === undefined ? {} : { tool_is_error: payload.result.isError }) }
    requests.push(receipt); console.log(JSON.stringify(receipt))
    return { response, payload }
  }
  const initialize = { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "genioone-ce-smoke", version: "1.0" } }
  const anonymous = await rpc(null, "initialize", initialize, 0)
  if (![401, 403].includes(anonymous.response.status)) throw new Error("Anonymous request was not rejected")
  session = undefined
  token = options.tokenEnv ? process.env[options.tokenEnv] : await browserToken(options.issuer, options.clientId)
  if (!token) throw new Error("The configured access-token environment variable is empty")
  const initialized = await rpc(token, "initialize", initialize, 1)
  if (!initialized.response.ok || !initialized.payload?.result) throw new Error("Authenticated MCP initialize failed")
  const notification = await rpc(token, "notifications/initialized")
  if (!notification.response.ok) throw new Error("MCP initialized notification failed")
  const list = await rpc(token, "tools/list", {}, 2)
  const tools = list.payload?.result?.tools ?? []
  if (!list.response.ok || !tools.some((tool) => tool.name === options.tool)) throw new Error("Requested tool is absent from the authorized tool list; check publication and access")
  const call = await rpc(token, "tools/call", { name: options.tool, arguments: options.arguments }, 3)
  if (!call.response.ok || call.payload?.error || call.payload?.result?.isError || !call.payload?.result?.content?.length) throw new Error("MCP tool execution did not succeed")
  if (options.denyTool) {
    const denied = await rpc(token, "tools/call", { name: options.denyTool, arguments: options.arguments }, 4)
    if (denied.response.status !== 403) throw new Error("Expected an ungranted tool to return HTTP 403")
  }
  return { status: "PASS", tool: options.tool, visible_tools: tools.map((tool) => tool.name), requests }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes("--help")) console.log("Usage: node tooling/ce-mcp-smoke.mjs --url URL --tool NAME --argument key=value (--issuer ISSUER | --token-env ENV_NAME) [--client-id codex-mcp] [--deny-tool NAME]\nBrowser sign-in uses authorization code + PKCE. Access tokens stay in memory; only request metadata and result hashes are printed.")
  else { try { console.log(JSON.stringify(await smoke(parseOptions(process.argv.slice(2))))) } catch (error) { console.error(JSON.stringify({ status: "FAIL", error: error.message })); process.exitCode = 1 } }
}
