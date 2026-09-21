import { expect, test } from "bun:test"
import Fastify from "fastify"
import { RuntimeBroker } from "./runtime-broker"
import { modelGatewayRelayRoutes } from "./model-gateway-relay"
import type { BotServerContext } from "./context"

function allowRuntimePolicy() {
  return {
    async authorize(input: Record<string, unknown>) {
      return {
        tenant_id: "tenant",
        subject_id: "owner",
        client_id: "genio-one-bot",
        bot_id: input.botId,
        runtime_id: "codex",
        policy_id: "one-policy.runtime.capabilities",
        policy_display_name: "Runtime capabilities",
        policy_revision: 1,
        capability_id: input.capabilityId,
        action: input.action,
        target: `runtime:codex:${input.capabilityId}`,
        decision: "ALLOW" as const,
        reason_code: "RULE_ALLOW:mcp",
        constraints: [],
        obligations: [],
        correlation_id: input.correlationId,
        session_id: input.sessionId,
        evaluated_at: 1_757_000_000,
      }
    },
    async report() {},
  }
}

test("retires the generic relay while catalog Discovery follows the current session token", async () => {
  const broker = new RuntimeBroker({ provision: async () => { throw new Error("not used") } })
  const app = Fastify()
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const originalFetch = globalThis.fetch
  const originalUrl = process.env.GENIO_ONE_MCP_URL
  const originalPlatform = process.env.GENIO_ONE_PLATFORM_ORIGIN
  const tokens: string[] = []
  let starts = 0
  let closes = 0
  process.env.GENIO_ONE_MCP_URL = "https://mcp.example.test/mcp"
  process.env.GENIO_ONE_PLATFORM_ORIGIN = "https://platform.example.test"
  globalThis.fetch = (async (_input, init) => {
    tokens.push(new Headers(init?.headers).get("authorization") || "")
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { headers: { "content-type": "application/json" } })
  }) as typeof fetch
  try {
    const session = await broker.start(principal, { onMessage() {}, onExit() {} }, () => { starts++; return { send: async () => {}, close: async () => { closes++ } } }, "first-token")
    await modelGatewayRelayRoutes(app, { runtimeBroker: broker } as BotServerContext)
    const request = { method: "POST" as const, url: `/api/mcp-gateway/${session.id}/mcp`, headers: { authorization: "Bearer first-token" }, payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } }
    const discoveryRequest = { ...request, url: `/api/discovery-mcp/${session.id}/mcp` }
    expect((await app.inject(request)).statusCode).toBe(410)
    expect((await app.inject(discoveryRequest)).statusCode).toBe(200)
    const resumed = await broker.start(principal, { onMessage() {}, onExit() {} }, () => { throw new Error("must reuse runtime") }, "second-token")
    expect(resumed.id).toBe(session.id)
    expect((await app.inject(request)).statusCode).toBe(410)
    expect((await app.inject(discoveryRequest)).statusCode).toBe(200)
    expect((await app.inject({ ...discoveryRequest, payload: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "unexpected", arguments: {} } } })).statusCode).toBe(403)
    expect(tokens).toEqual(["Bearer first-token", "Bearer second-token"])
    expect(starts).toBe(1)
    expect(closes).toBe(0)
    await broker.stop(session.id)
    expect((await app.inject(request)).statusCode).toBe(410)
    expect((await app.inject(discoveryRequest)).statusCode).toBe(404)
    expect(tokens).toHaveLength(2)
    expect(closes).toBe(1)
  } finally {
    globalThis.fetch = originalFetch
    if (originalUrl === undefined) delete process.env.GENIO_ONE_MCP_URL
    else process.env.GENIO_ONE_MCP_URL = originalUrl
    if (originalPlatform === undefined) delete process.env.GENIO_ONE_PLATFORM_ORIGIN
    else process.env.GENIO_ONE_PLATFORM_ORIGIN = originalPlatform
    await app.close(); await broker.close()
  }
})

test("MCP relay uses each mount's publication endpoint with the configured gateway transport", async () => {
  const broker = new RuntimeBroker({ provision: async () => { throw new Error("not used") } })
  const app = Fastify()
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const originalUrl = process.env.GENIO_ONE_MCP_URL
  const originalFetch = globalThis.fetch
  const targets: Array<{ url: string; host: string | null }> = []
  process.env.GENIO_ONE_MCP_URL = "http://one.localhost:1975/mcp"
  globalThis.fetch = (async (input, init) => {
    targets.push({ url: String(input), host: new Headers(init?.headers).get("host") })
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { headers: { "content-type": "application/json" } })
  }) as typeof fetch
  try {
    const session = await broker.start(principal, { onMessage() {}, onExit() {} }, () => ({ send: async () => {}, close: async () => {} }), "token")
    session.selectedBotId = "ce-bot"
    session.managedMcpMounts = {
      "genio.demo.context7": { resourceId: "genio.demo.context7", capabilityId: "context7", serverName: "genio_mcp_context7", hostname: "context7.stellar-freight.localhost", basePath: "/" },
      "genio.demo.archify": { resourceId: "genio.demo.archify", capabilityId: "archify", serverName: "genio_mcp_archify", hostname: "archify.stellar-freight.localhost", basePath: "/" },
    }
    const bindings = [
      { resourceId: "genio.demo.context7", capabilityId: "context7", state: "INSTALLED", kind: "MCP" },
      { resourceId: "genio.demo.archify", capabilityId: "archify", state: "INSTALLED", kind: "MCP" },
    ]
    await modelGatewayRelayRoutes(app, {
      runtimeBroker: broker,
      botRegistry: { getOwned: () => ({ sourceResourceId: "genio.demo.bot", bindings }) },
      runtimePolicy: allowRuntimePolicy(),
    } as unknown as BotServerContext)
    const request = {
      method: "POST" as const,
      url: `/api/mcp-gateway/${session.id}/genio.demo.context7/mcp`,
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    }
    expect((await app.inject(request)).statusCode).toBe(200)
    expect((await app.inject({ ...request, url: `/api/mcp-gateway/${session.id}/genio.demo.archify/mcp` })).statusCode).toBe(200)
    expect(targets).toEqual([
      { url: "http://127.0.0.1:1975/", host: "context7.stellar-freight.localhost:1975" },
      { url: "http://127.0.0.1:1975/", host: "archify.stellar-freight.localhost:1975" },
    ])
    session.selectedBotId = null
    expect((await app.inject(request)).statusCode).toBe(403)
    expect(targets).toHaveLength(2)
  } finally {
    globalThis.fetch = originalFetch
    if (originalUrl === undefined) delete process.env.GENIO_ONE_MCP_URL
    else process.env.GENIO_ONE_MCP_URL = originalUrl
    await app.close(); await broker.close()
  }
})

test("resource-scoped MCP relay preserves the method, headers, route, and current binding", async () => {
  const broker = new RuntimeBroker({ provision: async () => { throw new Error("not used") } })
  const app = Fastify()
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const notionResourceId = "resource-2a55a5d9-3d76-40af-b65e-04babfe93a8f"
  const originalUrl = process.env.GENIO_ONE_MCP_URL
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; method: string; authorization: string | null; host: string | null; requestId: string | null }> = []
  process.env.GENIO_ONE_MCP_URL = "http://one.localhost:1975/mcp"
  globalThis.fetch = (async (input, init) => {
    const headers = new Headers(init?.headers)
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
      host: headers.get("host"),
      requestId: headers.get("x-request-id"),
    })
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { headers: { "content-type": "application/json" } })
  }) as typeof fetch
  let bindings = [{ resourceId: notionResourceId, capabilityId: "notion.search", state: "INSTALLED", kind: "MCP" }]
  try {
    const session = await broker.start(principal, { onMessage() {}, onExit() {} }, () => ({ send: async () => {}, close: async () => {} }), "active-token")
    session.selectedBotId = "notion-bot"
    session.managedMcpMounts = {
      [notionResourceId]: { resourceId: notionResourceId, capabilityId: "notion.search", serverName: "genio_mcp_notion", hostname: "notion.stellar-freight.localhost", basePath: "/mcp" },
    }
    await modelGatewayRelayRoutes(app, {
      runtimeBroker: broker,
      botRegistry: { getOwned: () => ({ sourceResourceId: "custom-notion-bot", bindings }) },
      runtimePolicy: allowRuntimePolicy(),
    } as unknown as BotServerContext)
    const request = {
      method: "POST" as const,
      url: `/api/mcp-gateway/${session.id}/${notionResourceId}/mcp?cursor=next`,
      headers: { authorization: "Bearer forged", "content-type": "application/json", "x-request-id": "request-123" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    }
    expect((await app.inject(request)).statusCode).toBe(200)
    expect(requests).toEqual([{
      url: "http://127.0.0.1:1975/mcp?cursor=next",
      method: "POST",
      authorization: "Bearer active-token",
      host: "notion.stellar-freight.localhost:1975",
      requestId: "request-123",
    }])
    bindings = []
    expect((await app.inject(request)).statusCode).toBe(403)
    expect((await app.inject({ ...request, url: `/api/mcp-gateway/${session.id}/resource-missing-endpoint/mcp` })).statusCode).toBe(403)
    expect((await app.inject({ ...request, url: `/api/mcp-gateway/${session.id}/resource-unauthorized/mcp` })).statusCode).toBe(403)
    expect(requests).toHaveLength(1)
  } finally {
    globalThis.fetch = originalFetch
    if (originalUrl === undefined) delete process.env.GENIO_ONE_MCP_URL
    else process.env.GENIO_ONE_MCP_URL = originalUrl
    await app.close(); await broker.close()
  }
})
