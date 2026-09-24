import { afterEach, describe, expect, test } from "bun:test"

import {
  HANDS_MCP_GRANT_TTL_MS,
  checkHandsMcpRequest,
  filterHandsToolList,
  handsMcpGrantFor,
  handsMcpManifest,
  handsMcpNetwork,
  issueHandsMcpGrant,
  revokeHandsMcpGrants,
  type HandsMcpGrantHolder,
} from "./hands-mcp-grant"
import { modelGatewayRelayRoutes } from "./model-gateway-relay"

const mounts = {
  "resource-mail2000": { resourceId: "resource-mail2000", capabilityId: "mail2000", serverName: "genio_mcp_mail2000", hostname: "mail2000.example", basePath: "/mcp" },
}
const toolList = {
  jsonrpc: "2.0",
  id: 1,
  result: { tools: [
    { name: "search_mail", annotations: { readOnlyHint: true } },
    { name: "read_mail", annotations: { readOnlyHint: true } },
    { name: "delete_mail", annotations: { readOnlyHint: false, destructiveHint: true } },
    { name: "send_mail" },
  ] },
}

describe("hands MCP grant", () => {
  test("keeps only a digest of the token, so a heap or log dump of the session cannot replay it", () => {
    const holder: HandsMcpGrantHolder = {}
    const token = issueHandsMcpGrant(holder, { botId: "bot-dylan", tier: "headless" })

    expect([...holder.handsMcpGrants!.keys()].join()).not.toContain(token)
    expect(handsMcpGrantFor(holder, `Bearer ${token}`)?.botId).toBe("bot-dylan")
    expect(handsMcpGrantFor(holder, token)).toBeNull()
    expect(handsMcpGrantFor(holder, "Bearer forged")).toBeNull()
  })

  test("expires with the sandbox lifetime and is revoked with its lease only", () => {
    const holder: HandsMcpGrantHolder = {}
    const headless = issueHandsMcpGrant(holder, { botId: "bot-dylan", tier: "headless", now: 0 })
    const desktop = issueHandsMcpGrant(holder, { botId: "bot-dylan", tier: "desktop", now: 0 })

    expect(handsMcpGrantFor(holder, `Bearer ${headless}`, HANDS_MCP_GRANT_TTL_MS)).toBeNull()
    const fresh = issueHandsMcpGrant(holder, { botId: "bot-dylan", tier: "headless" })
    revokeHandsMcpGrants(holder, "headless")
    expect(handsMcpGrantFor(holder, `Bearer ${fresh}`)).toBeNull()
    expect(handsMcpGrantFor(holder, `Bearer ${desktop}`, 1)).not.toBeNull()
  })

  test("the sandbox manifest carries endpoints but never the credential; only the egress rule does", () => {
    const provision = { token: "grant-secret-value", relayOrigin: "https://bot.internal:5181", botId: "bot-dylan", mounts }

    const manifest = JSON.stringify(handsMcpManifest("runtime-session", provision))
    expect(manifest).not.toContain("grant-secret-value")
    expect(manifest).toContain("https://bot.internal:5181/api/mcp-gateway/runtime-session/bots/bot-dylan/resource-mail2000/mcp")
    expect(handsMcpNetwork(provision)).toEqual({
      rules: { "bot.internal": [{ transform: { headers: { Authorization: "Bearer grant-secret-value" } } }] },
    })
  })

  test("lists and allows only tools the connector declared read-only", () => {
    const holder: HandsMcpGrantHolder = {}
    const grant = handsMcpGrantFor(holder, `Bearer ${issueHandsMcpGrant(holder, { botId: "bot-dylan", tier: "headless" })}`)!
    const call = (name: string) => checkHandsMcpRequest(grant, "resource-mail2000", "POST", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name } })

    expect(call("search_mail")).toEqual({ allowed: false, error: "HANDS_MCP_TOOL_NOT_READ_ONLY" })
    const listed = JSON.parse(filterHandsToolList(grant, "resource-mail2000", "application/json", JSON.stringify(toolList)))
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["search_mail", "read_mail"])
    expect(call("search_mail")).toEqual({ allowed: true, method: "tools/call", tool: "search_mail" })
    expect(call("delete_mail").allowed).toBe(false)
    expect(call("send_mail").allowed).toBe(false)
    expect(checkHandsMcpRequest(grant, "resource-other", "POST", { method: "tools/call", params: { name: "search_mail" } }).allowed).toBe(false)
  })

  test("replaces learned read-only tools after each successful tool list", () => {
    const holder: HandsMcpGrantHolder = {}
    const grant = handsMcpGrantFor(holder, `Bearer ${issueHandsMcpGrant(holder, { botId: "bot-dylan", tier: "headless" })}`)!
    const call = (name: string) => checkHandsMcpRequest(grant, "resource-mail2000", "POST", { method: "tools/call", params: { name } })

    filterHandsToolList(grant, "resource-mail2000", "application/json", JSON.stringify(toolList))
    filterHandsToolList(grant, "resource-mail2000", "application/json", JSON.stringify({
      ...toolList,
      result: { tools: [{ name: "read_mail", annotations: { readOnlyHint: true } }] },
    }))

    expect(call("search_mail")).toEqual({ allowed: false, error: "HANDS_MCP_TOOL_NOT_READ_ONLY" })
    expect(call("read_mail")).toEqual({ allowed: true, method: "tools/call", tool: "read_mail" })
  })

  test("filters SSE tool lists and rejects batches, streams and other MCP methods", () => {
    const holder: HandsMcpGrantHolder = {}
    const grant = handsMcpGrantFor(holder, `Bearer ${issueHandsMcpGrant(holder, { botId: "bot-dylan", tier: "headless" })}`)!
    const sse = filterHandsToolList(grant, "resource-mail2000", "text/event-stream", `event: message\ndata: ${JSON.stringify(toolList)}\n\n`)

    expect(sse).not.toContain("delete_mail")
    expect(grant.readOnlyTools.get("resource-mail2000")).toEqual(new Set(["search_mail", "read_mail"]))
    expect(checkHandsMcpRequest(grant, "resource-mail2000", "POST", [{ method: "tools/list" }]).allowed).toBe(false)
    expect(checkHandsMcpRequest(grant, "resource-mail2000", "GET", undefined).allowed).toBe(false)
    expect(checkHandsMcpRequest(grant, "resource-mail2000", "POST", { method: "resources/read" }).allowed).toBe(false)
  })
})

class Reply {
  statusCode = 200
  body: unknown
  readonly headers = new Headers()
  code(statusCode: number) { this.statusCode = statusCode; return this }
  header(name: string, value: string) { this.headers.set(name, value); return this }
  send(body: unknown) { this.body = body; return body }
}

async function text(body: unknown) {
  let value = ""
  for await (const chunk of body as AsyncIterable<Buffer>) value += chunk.toString()
  return value
}

describe("managed MCP relay for hands", () => {
  const originalFetch = globalThis.fetch
  const originalMcp = process.env.GENIO_ONE_MCP_URL
  const originalPlatform = process.env.GENIO_ONE_PLATFORM_ORIGIN
  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalMcp === undefined) delete process.env.GENIO_ONE_MCP_URL
    else process.env.GENIO_ONE_MCP_URL = originalMcp
    if (originalPlatform === undefined) delete process.env.GENIO_ONE_PLATFORM_ORIGIN
    else process.env.GENIO_ONE_PLATFORM_ORIGIN = originalPlatform
  })

  async function harness() {
    process.env.GENIO_ONE_MCP_URL = "https://gateway.example/mcp"
    process.env.GENIO_ONE_PLATFORM_ORIGIN = "https://platform.example"
    const session: HandsMcpGrantHolder & Record<string, unknown> = {
      id: "runtime-session",
      relaySecret: "relay-secret",
      principal: { tenant_id: "tenant-uat", subject_id: "person-dylan", acting_client_id: "genio-one-bot", organization_ids: ["org-uat"], scopes: [] },
      accessToken: "user-access-token",
      selectedBotId: "bot-dylan",
      managedMcpMountsByBot: { "bot-dylan": mounts, "bot-other": mounts },
    }
    const upstream: Array<{ body: string; authorization: string | null }> = []
    const authorizations: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (input, init) => {
      if (String(input).endsWith("/catalog")) return Response.json({ capabilities: [{ resource_id: "resource-mail2000", capability_id: "mail2000", access: "ENTITLED", publication_endpoint: { hostname: "mail2000.example", base_path: "/mcp" } }] })
      const body = String(init?.body)
      upstream.push({ body, authorization: new Headers(init?.headers).get("authorization") })
      return Response.json(JSON.parse(body).method === "tools/list" ? toolList : { jsonrpc: "2.0", id: 2, result: { content: [] } })
    }) as typeof fetch
    const routes = new Map<string, (request: unknown, reply: Reply) => Promise<unknown>>()
    await modelGatewayRelayRoutes({ post: () => {}, all: (path: string, handler: never) => { routes.set(path, handler) } } as never, {
      runtimeBroker: { get: () => session, accessTokenForBot: () => session.accessToken },
      botRegistry: { getOwned: (botId: string) => ({ id: botId, ownerOrganizationId: null, useCaseId: null, bindings: [{ resourceId: "resource-mail2000", capabilityId: "mail2000", state: "INSTALLED", kind: "MCP" }] }) },
      runtimePolicy: {
        async authorize(input: Record<string, unknown>) {
          authorizations.push(input)
          return { tenant_id: "tenant-uat", subject_id: "person-dylan", bot_id: input.botId, runtime_id: "codex", capability_id: "mcp.invoke", action: "invoke", target: "runtime:codex:mcp.invoke", decision: "ALLOW", reason_code: "RULE_ALLOW", constraints: [], obligations: [], correlation_id: input.correlationId, session_id: "runtime-session", evaluated_at: 1 }
        },
        async report() {},
      },
    } as never)
    const token = issueHandsMcpGrant(session, { botId: "bot-dylan", tier: "headless" })
    const call = async (body: unknown, options: { botId?: string; authorization?: string } = {}) => {
      const reply = new Reply()
      const botId = options.botId ?? "bot-dylan"
      await routes.get("/api/mcp-gateway/:runtimeSessionId/bots/:botId/:resourceId/mcp")!({
        params: { runtimeSessionId: "runtime-session", botId, resourceId: "resource-mail2000" },
        method: "POST",
        url: `/api/mcp-gateway/runtime-session/bots/${botId}/resource-mail2000/mcp`,
        headers: { authorization: options.authorization ?? `Bearer ${token}`, "content-type": "application/json" },
        body,
      }, reply)
      return reply
    }
    return { session, token, call, upstream, authorizations, routes }
  }

  test("a sandbox CLI sees only read-only tools and calls them with the user's authority, never with its grant", async () => {
    const { call, upstream, authorizations } = await harness()

    const listed = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    expect(JSON.parse(await text(listed.body)).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["search_mail", "read_mail"])
    const searched = await call({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_mail", arguments: { text: "國泰" } } })
    await text(searched.body)

    expect(searched.statusCode).toBe(200)
    expect(upstream.map((item) => item.authorization)).toEqual(["Bearer user-access-token", "Bearer user-access-token"])
    expect(authorizations.map((item) => item.capabilityId)).toEqual(["mcp.invoke", "mcp.invoke"])
  })

  test("a write tool is refused before any upstream or policy call", async () => {
    const { call, upstream, authorizations } = await harness()
    await text((await call({ jsonrpc: "2.0", id: 1, method: "tools/list" })).body)
    upstream.length = 0
    authorizations.length = 0

    const reply = await call({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "delete_mail", arguments: {} } })

    expect(reply.statusCode).toBe(403)
    expect(reply.body).toEqual({ error: "HANDS_MCP_TOOL_NOT_READ_ONLY" })
    expect(upstream).toHaveLength(0)
    expect(authorizations).toHaveLength(0)
  })

  test("a grant is bound to its Bot and stops working once revoked", async () => {
    const { session, call } = await harness()

    expect((await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { botId: "bot-other" })).body).toEqual({ error: "HANDS_MCP_BOT_MISMATCH" })
    session.selectedBotId = "bot-other"
    expect((await call({ jsonrpc: "2.0", id: 1, method: "tools/list" })).body).toEqual({ error: "HANDS_MCP_BOT_MISMATCH" })
    session.selectedBotId = "bot-dylan"
    expect((await call({ jsonrpc: "2.0", id: 1, method: "tools/list" })).statusCode).toBe(200)
    revokeHandsMcpGrants(session)
    const revoked = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    expect(revoked.statusCode).toBe(401)
  })

  test("a grant cannot reach the Discovery or model relays that only the app-server may use", async () => {
    const { token, routes } = await harness()
    const reply = new Reply()
    await routes.get("/api/discovery-mcp/:runtimeSessionId/bots/:botId/mcp")!({
      params: { runtimeSessionId: "runtime-session", botId: "bot-dylan" },
      method: "POST",
      url: "/api/discovery-mcp/runtime-session/bots/bot-dylan/mcp",
      headers: { authorization: `Bearer ${token}` },
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    }, reply)

    expect(reply.statusCode).toBe(401)
  })
})
