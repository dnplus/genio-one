import { expect, test } from "bun:test"
import Fastify from "fastify"
import { BotRegistry } from "./bot-registry"
import { BotSchedules } from "./bot-schedules"
import { BotToolSessions } from "./bot-tool-sessions"
import { createCapabilityGate } from "./capability-gate"
import { createBotModelDirectory } from "./model-directory"
import { RuntimeBroker } from "./runtime-broker"
import { modelGatewayRelayRoutes } from "./model-gateway-relay"
import { createRuntimePolicyClient } from "./runtime-policy"
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
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", organization_ids: ["org-a"], scopes: [] }
  const originalFetch = globalThis.fetch
  const originalUrl = process.env.GENIO_ONE_MCP_URL
  const originalPlatform = process.env.GENIO_ONE_PLATFORM_ORIGIN
  const tokens: string[] = []
  const forwardedHeaders: Headers[] = []
  let starts = 0
  let closes = 0
  process.env.GENIO_ONE_MCP_URL = "https://mcp.example.test/mcp"
  process.env.GENIO_ONE_PLATFORM_ORIGIN = "https://platform.example.test"
  globalThis.fetch = (async (_input, init) => {
    const headers = new Headers(init?.headers)
    tokens.push(headers.get("authorization") || "")
    forwardedHeaders.push(headers)
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { headers: { "content-type": "application/json" } })
  }) as typeof fetch
  try {
    let factorySecret = ""
    const session = await broker.start(principal, { onMessage() {}, onExit() {} }, (_callbacks, _runtimeSessionId, relaySecret) => {
      factorySecret = relaySecret
      starts++
      return { send: async () => {}, close: async () => { closes++ } }
    }, "first-token")
    await modelGatewayRelayRoutes(app, { runtimeBroker: broker } as BotServerContext)
    const relaySecret = session.relaySecret
    expect(factorySecret).toBe(relaySecret)
    const request = {
      method: "POST" as const,
      url: `/api/mcp-gateway/${session.id}/mcp`,
      headers: {
        authorization: `Bearer ${relaySecret}`,
        "x-request-id": "forged-request-id",
        "x-genio-correlation-id": "forged-correlation",
        "x-genio-session-id": "forged-session",
        "x-genio-organization-id": "forged-org",
        "x-genio-use-case-id": "forged-use-case",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    }
    const discoveryRequest = { ...request, url: `/api/discovery-mcp/${session.id}/mcp` }
    expect((await app.inject(request)).statusCode).toBe(410)
    expect((await app.inject(discoveryRequest)).statusCode).toBe(200)
    const resumed = await broker.start(principal, { onMessage() {}, onExit() {} }, () => { throw new Error("must reuse runtime") }, "second-token")
    expect(resumed.id).toBe(session.id)
    expect(resumed.relaySecret).toBe(relaySecret)
    expect((await app.inject(request)).statusCode).toBe(410)
    expect((await app.inject(discoveryRequest)).statusCode).toBe(200)
    expect((await app.inject({ ...discoveryRequest, payload: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "unexpected", arguments: {} } } })).statusCode).toBe(403)
    expect(tokens).toEqual(["Bearer first-token", "Bearer second-token"])
    expect(forwardedHeaders).toHaveLength(2)
    for (const headers of forwardedHeaders) {
      expect(headers.get("x-request-id")).not.toBe("forged-request-id")
      expect(headers.get("x-request-id")).toBe(headers.get("x-genio-correlation-id"))
      expect(headers.get("x-genio-session-id")).toBe(session.id)
      expect(headers.get("x-genio-organization-id")).toBeNull()
      expect(headers.get("x-genio-use-case-id")).toBeNull()
    }
    expect(starts).toBe(1)
    expect(closes).toBe(0)
    await broker.stop(session.id)
    expect(broker.get(session.id)).toBeNull()
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

test("Bot-bound Discovery keeps an invocation credential with its owned Bot", async () => {
  const broker = new RuntimeBroker({ provision: async () => { throw new Error("not used") } })
  const app = Fastify()
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const originalFetch = globalThis.fetch
  const originalPlatform = process.env.GENIO_ONE_PLATFORM_ORIGIN
  const tokens: string[] = []
  const registry = new BotRegistry(":memory:")
  process.env.GENIO_ONE_PLATFORM_ORIGIN = "https://platform.example.test"
  globalThis.fetch = (async (_input, init) => {
    tokens.push(new Headers(init?.headers).get("authorization") || "")
    return Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } })
  }) as typeof fetch
  try {
    const bot = registry.create(principal, { name: "Discovery", description: "Bot-bound discovery" })
    const session = await broker.start(principal, { onMessage() {}, onExit() {} })
    const release = broker.bindInvocationAccessToken(session.id, bot.id, "invocation-a", "agent-token-a")
    await modelGatewayRelayRoutes(app, {
      runtimeBroker: broker,
      botRegistry: registry,
      botSchedules: new BotSchedules(registry.db),
      botToolSessions: new BotToolSessions(),
      capabilityGate: createCapabilityGate({ mode: "open" }),
      modelDirectory: createBotModelDirectory({}),
      runtimePolicy: createRuntimePolicyClient(),
    })
    const request = {
      method: "POST" as const,
      url: `/api/discovery-mcp/${session.id}/bots/${bot.id}/mcp`,
      headers: { authorization: `Bearer ${session.relaySecret}` },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    }
    expect((await app.inject(request)).statusCode).toBe(200)
    const foreign = await app.inject({ ...request, url: `/api/discovery-mcp/${session.id}/bots/bot-b/mcp` })
    expect(foreign.statusCode).toBe(403)
    expect(JSON.parse(foreign.body)).toEqual({ error: "DISCOVERY_BOT_NOT_ALLOWED" })
    expect(tokens).toEqual(["Bearer agent-token-a"])
    release()
    expect((await app.inject(request)).statusCode).toBe(404)
    expect(tokens).toEqual(["Bearer agent-token-a"])
  } finally {
    globalThis.fetch = originalFetch
    if (originalPlatform === undefined) delete process.env.GENIO_ONE_PLATFORM_ORIGIN
    else process.env.GENIO_ONE_PLATFORM_ORIGIN = originalPlatform
    await app.close(); await broker.close(); registry.close()
  }
})

test("MCP relay uses each mount's publication endpoint with the configured gateway transport", async () => {
  const broker = new RuntimeBroker({ provision: async () => { throw new Error("not used") } })
  const app = Fastify()
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const originalUrl = process.env.GENIO_ONE_MCP_URL
  const originalFetch = globalThis.fetch
  const catalogTokens: string[] = []
  const targets: Array<{ url: string; host: string | null; authorization: string | null }> = []
  process.env.GENIO_ONE_MCP_URL = "http://one.localhost:1975/mcp"
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    if (url.pathname.endsWith("/catalog")) {
      catalogTokens.push(headers.get("authorization") || "")
      return Response.json({ capabilities: [
        { resource_id: "genio.demo.context7", capability_id: "context7", access: "ENTITLED", publication_endpoint: { hostname: "context7.stellar-freight.localhost", base_path: "/" } },
        { resource_id: "genio.demo.archify", capability_id: "archify", access: "ENTITLED", publication_endpoint: { hostname: "archify.stellar-freight.localhost", base_path: "/" } },
      ] })
    }
    targets.push({ url: String(input), host: headers.get("host"), authorization: headers.get("authorization") })
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { headers: { "content-type": "application/json" } })
  }) as typeof fetch
  try {
    const session = await broker.start(principal, { onMessage() {}, onExit() {} }, () => ({ send: async () => {}, close: async () => {} }), "token")
    const release = broker.bindInvocationAccessToken(session.id, "ce-bot", "invocation-a", "agent-token")
    session.selectedBotId = "ce-bot"
    session.usageContext = { consumerOrganizationId: "org-a", useCaseId: "purpose-a" }
    session.managedMcpMountsByBot = {
      "ce-bot": {
        "genio.demo.context7": { resourceId: "genio.demo.context7", capabilityId: "context7", serverName: "genio_mcp_context7", hostname: "context7.stellar-freight.localhost", basePath: "/" },
        "genio.demo.archify": { resourceId: "genio.demo.archify", capabilityId: "archify", serverName: "genio_mcp_archify", hostname: "archify.stellar-freight.localhost", basePath: "/" },
      },
    }
    const bindings = [
      { resourceId: "genio.demo.context7", capabilityId: "context7", state: "INSTALLED", kind: "MCP" },
      { resourceId: "genio.demo.archify", capabilityId: "archify", state: "INSTALLED", kind: "MCP" },
    ]
    await modelGatewayRelayRoutes(app, {
      runtimeBroker: broker,
      botRegistry: { getOwned: (botId: string) => botId === "ce-bot" ? ({ sourceResourceId: "genio.demo.bot", ownerOrganizationId: "org-a", useCaseId: "purpose-a", bindings }) : null },
      runtimePolicy: allowRuntimePolicy(),
    } as unknown as BotServerContext)
    const request = {
      method: "POST" as const,
      url: `/api/mcp-gateway/${session.id}/bots/ce-bot/genio.demo.context7/mcp`,
      headers: { authorization: `Bearer ${session.relaySecret}` },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    }
    expect((await app.inject(request)).statusCode).toBe(200)
    expect((await app.inject({ ...request, url: `/api/mcp-gateway/${session.id}/bots/ce-bot/genio.demo.archify/mcp` })).statusCode).toBe(200)
    expect(targets).toEqual([
      { url: "http://127.0.0.1:1975/", host: "context7.stellar-freight.localhost:1975", authorization: "Bearer agent-token" },
      { url: "http://127.0.0.1:1975/", host: "archify.stellar-freight.localhost:1975", authorization: "Bearer agent-token" },
    ])
    expect(catalogTokens).toEqual(["Bearer agent-token", "Bearer agent-token"])
    session.selectedBotId = "other-ui-bot"
    expect((await app.inject(request)).statusCode).toBe(200)
    expect(targets).toHaveLength(3)
    expect(targets[2]?.authorization).toBe("Bearer agent-token")
    release()
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
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", organization_ids: ["org-a"], scopes: [] }
  const notionResourceId = "resource-2a55a5d9-3d76-40af-b65e-04babfe93a8f"
  const originalUrl = process.env.GENIO_ONE_MCP_URL
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; method: string; authorization: string | null; host: string | null; requestId: string | null; correlationId: string | null; sessionId: string | null; organizationId: string | null; useCaseId: string | null }> = []
  process.env.GENIO_ONE_MCP_URL = "http://one.localhost:1975/mcp"
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/catalog")) return Response.json({ capabilities: [{
      resource_id: notionResourceId,
      capability_id: "notion.search",
      access: "ENTITLED",
      publication_endpoint: { hostname: "notion.stellar-freight.localhost", base_path: "/mcp" },
    }] })
    const headers = new Headers(init?.headers)
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
      host: headers.get("host"),
      requestId: headers.get("x-request-id"),
      correlationId: headers.get("x-genio-correlation-id"),
      sessionId: headers.get("x-genio-session-id"),
      organizationId: headers.get("x-genio-organization-id"),
      useCaseId: headers.get("x-genio-use-case-id"),
    })
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { headers: { "content-type": "application/json" } })
  }) as typeof fetch
  let bindings = [{ resourceId: notionResourceId, capabilityId: "notion.search", state: "INSTALLED", kind: "MCP" }]
  try {
    const session = await broker.start(principal, { onMessage() {}, onExit() {} }, () => ({ send: async () => {}, close: async () => {} }), "active-token")
    session.selectedBotId = "notion-bot"
    session.usageContext = { consumerOrganizationId: "org-a", useCaseId: "purpose-a" }
    session.managedMcpMountsByBot = {
      "notion-bot": {
        [notionResourceId]: { resourceId: notionResourceId, capabilityId: "notion.search", serverName: "genio_mcp_notion", hostname: "notion.stellar-freight.localhost", basePath: "/mcp" },
      },
    }
    await modelGatewayRelayRoutes(app, {
      runtimeBroker: broker,
      botRegistry: { getOwned: (botId: string) => botId === "notion-bot" ? ({ sourceResourceId: "custom-notion-bot", ownerOrganizationId: "org-a", useCaseId: "purpose-a", bindings }) : null },
      runtimePolicy: allowRuntimePolicy(),
    } as unknown as BotServerContext)
    const request = {
      method: "POST" as const,
      url: `/api/mcp-gateway/${session.id}/bots/notion-bot/${notionResourceId}/mcp?cursor=next`,
      headers: { authorization: `Bearer ${session.relaySecret}`, "content-type": "application/json", "x-request-id": "request-123", "x-genio-organization-id": "forged-org", "x-genio-use-case-id": "forged-use-case", "x-genio-session-id": "forged-session", "x-genio-correlation-id": "forged-correlation" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    }
    expect((await app.inject(request)).statusCode).toBe(200)
    expect(requests).toEqual([{
      url: "http://127.0.0.1:1975/mcp?cursor=next",
      method: "POST",
      authorization: "Bearer active-token",
      host: "notion.stellar-freight.localhost:1975",
      requestId: expect.any(String),
      correlationId: expect.any(String),
      sessionId: session.id,
      organizationId: "org-a",
      useCaseId: "purpose-a",
    }])
    expect(requests[0]!.requestId).not.toBe("request-123")
    expect(requests[0]!.requestId).toBe(requests[0]!.correlationId)
    bindings = []
    expect((await app.inject(request)).statusCode).toBe(403)
    expect((await app.inject({ ...request, url: `/api/mcp-gateway/${session.id}/bots/notion-bot/resource-missing-endpoint/mcp` })).statusCode).toBe(403)
    expect((await app.inject({ ...request, url: `/api/mcp-gateway/${session.id}/bots/notion-bot/resource-unauthorized/mcp` })).statusCode).toBe(403)
    expect(requests).toHaveLength(1)
  } finally {
    globalThis.fetch = originalFetch
    if (originalUrl === undefined) delete process.env.GENIO_ONE_MCP_URL
    else process.env.GENIO_ONE_MCP_URL = originalUrl
    await app.close(); await broker.close()
  }
})
