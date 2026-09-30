import { afterEach, expect, test } from "bun:test"
import Fastify from "fastify"

import { BotConnectionInteractions } from "./bot-connection-interactions"
import { modelGatewayRelayRoutes } from "./model-gateway-relay"

const principal = {
  tenant_id: "tenant-brief",
  subject_id: "person-brief",
  acting_client_id: "genio-one-bot",
  scopes: ["genioone-invocation"],
}

const originalFetch = globalThis.fetch
const originalPlatform = process.env.GENIO_ONE_PLATFORM_ORIGIN
const applications: Array<ReturnType<typeof Fastify>> = []

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (originalPlatform === undefined) delete process.env.GENIO_ONE_PLATFORM_ORIGIN
  else process.env.GENIO_ONE_PLATFORM_ORIGIN = originalPlatform
  await Promise.all(applications.splice(0).map((app) => app.close()))
})

function waitFor(check: () => boolean) {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 1_000
    const tick = () => {
      if (check()) return resolve()
      if (Date.now() >= deadline) return reject(new Error("DISCOVERY_CONNECTION_TEST_TIMEOUT"))
      setTimeout(tick, 1)
    }
    tick()
  })
}

type ResourceId = "notion" | "mail2000"

function resourceName(resourceId: ResourceId) {
  return resourceId === "notion" ? "Notion" : "Mail2000"
}

function capabilityId(resourceId: ResourceId) {
  return resourceId === "notion" ? "notion.search" : "mail2000.search"
}

function discoveryResult(resourceIds: readonly ResourceId[] = ["notion"]) {
  const structuredContent = {
    catalog_revision: "catalog-brief",
    resources: resourceIds.map((resourceId) => ({
      resource_id: resourceId,
      display_name: resourceName(resourceId),
      tools: [{
        capability_id: capabilityId(resourceId),
        capability_display_name: "Search",
        connection_status: "READY",
        access: "ENTITLED",
        hub_status: "CONNECTED",
      }],
    })),
    total: resourceIds.length,
    next_offset: null,
  }
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
    },
  }
}

async function boot(personalStatus: "CONNECTED" | "NEEDS_CONNECTION", active = true, resourceIds: ResourceId[] = ["notion"]) {
  process.env.GENIO_ONE_PLATFORM_ORIGIN = "http://platform.test"
  const app = Fastify()
  applications.push(app)
  const interactions = new BotConnectionInteractions()
  const cards: Array<Record<string, unknown>> = []
  const session = { id: "runtime-brief", relaySecret: "relay-brief", principal, accessToken: "brief-token" }
  const statuses = new Map(resourceIds.map((resourceId) => [resourceId, personalStatus]))
  let discoveryCalls = 0
  let connectionCalls = 0
  interactions.subscribe({
    principal,
    botId: "bot-brief",
    runtimeSessionId: session.id,
    send: (request) => cards.push(request as Record<string, unknown>),
  })
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === "http://platform.test/v1/tenants/tenant-brief/discovery/mcp") {
      discoveryCalls += 1
      return new Response(JSON.stringify(discoveryResult(resourceIds)), {
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
      })
    }
    const prefix = "http://platform.test/v1/tenants/tenant-brief/me/resource-connections/"
    if (url.startsWith(prefix)) {
      const resourceId = decodeURIComponent(url.slice(prefix.length)) as ResourceId
      if (!statuses.has(resourceId)) return new Response("not found", { status: 404 })
      connectionCalls += 1
      return Response.json([{
        connection_id: `${resourceId}-personal`,
        display_name: resourceName(resourceId),
        authentication: "OAUTH",
        status: statuses.get(resourceId),
      }])
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch
  await modelGatewayRelayRoutes(app, {
    runtimeBroker: {
      get: (runtimeSessionId: string) => runtimeSessionId === session.id ? session : null,
      accessTokenForBot: () => session.accessToken,
    },
    botRegistry: {
      getOwned: (botId: string) => botId === "bot-brief" ? {
        id: "bot-brief",
        bindings: resourceIds.map((resourceId) => ({ resourceId, capabilityId: capabilityId(resourceId), state: "INSTALLED", kind: "MCP" })),
      } : null,
      timeline: { activeTurns: () => active ? [{ threadId: "thread-brief", turnId: "turn-brief" }] : [] },
    },
    connectionInteractions: interactions,
  } as never)
  const request = {
    method: "POST" as const,
    url: "/api/discovery-mcp/runtime-brief/bots/bot-brief/mcp",
    headers: { authorization: "Bearer relay-brief", "content-type": "application/json" },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_resources", arguments: { query: "notion" } } },
  }
  return {
    app,
    cards,
    complete: async (resourceId: ResourceId = "notion") => {
      statuses.set(resourceId, "CONNECTED")
      const card = cards.find((candidate) => candidate.resourceId === resourceId)!
      await interactions.complete({
        principal,
        runtimeSessionId: session.id,
        requestToken: card.requestToken,
        botId: card.botId,
        threadId: card.threadId,
        turnId: card.turnId,
        resourceId: card.resourceId,
        connectionId: `${resourceId}-personal`,
        status: "CONNECTED",
        accessToken: session.accessToken,
      })
    },
    connectionCalls: () => connectionCalls,
    discoveryCalls: () => discoveryCalls,
    request,
  }
}

test("Discovery surfaces a personal OAuth card and resumes the same call after connection", async () => {
  const fixture = await boot("NEEDS_CONNECTION")
  const pending = fixture.app.inject(fixture.request)

  await waitFor(() => fixture.cards.length === 1)
  expect(fixture.cards[0]).toMatchObject({
    botId: "bot-brief",
    targetBotId: "bot-brief",
    threadId: "thread-brief",
    resourceId: "notion",
    resourceName: "Notion",
    capabilityId: "notion.search",
  })
  expect(fixture.cards[0]).not.toHaveProperty("resume")
  expect(fixture.discoveryCalls()).toBe(1)

  await fixture.complete()
  const response = await pending
  expect(response.statusCode).toBe(200)
  expect(response.json().result.structuredContent.resources[0].tools[0]).toMatchObject({ connection_status: "READY", hub_status: "CONNECTED" })
  expect(fixture.discoveryCalls()).toBe(2)
  expect(fixture.connectionCalls()).toBe(3)
})

test("Discovery keeps a connected personal account card-free", async () => {
  const fixture = await boot("CONNECTED")
  const response = await fixture.app.inject(fixture.request)

  expect(response.statusCode).toBe(200)
  expect(fixture.cards).toEqual([])
  expect(response.json().result.structuredContent.resources[0].tools[0]).toMatchObject({ connection_status: "READY", hub_status: "CONNECTED" })
  expect(fixture.discoveryCalls()).toBe(1)
  expect(fixture.connectionCalls()).toBe(1)
})

test("Discovery requests each missing personal connection before continuing", async () => {
  const fixture = await boot("NEEDS_CONNECTION", true, ["notion", "mail2000"])
  const pending = fixture.app.inject(fixture.request)

  await waitFor(() => fixture.cards.length === 1)
  expect(fixture.cards[0]).toMatchObject({ resourceId: "notion", resourceName: "Notion", capabilityId: "notion.search" })

  await fixture.complete("notion")
  await waitFor(() => fixture.cards.length === 2)
  expect(fixture.cards[1]).toMatchObject({ resourceId: "mail2000", resourceName: "Mail2000", capabilityId: "mail2000.search" })

  await fixture.complete("mail2000")
  const response = await pending
  expect(response.statusCode).toBe(200)
  expect(response.json().result.structuredContent.resources.map((resource: { tools: Array<Record<string, unknown>> }) => resource.tools[0])).toEqual([
    expect.objectContaining({ connection_status: "READY", hub_status: "CONNECTED" }),
    expect.objectContaining({ connection_status: "READY", hub_status: "CONNECTED" }),
  ])
  expect(fixture.discoveryCalls()).toBe(3)
})

test("Discovery never exposes a resource-owned READY state when no active turn can show a card", async () => {
  const fixture = await boot("NEEDS_CONNECTION", false)
  const response = await fixture.app.inject(fixture.request)

  expect(response.statusCode).toBe(200)
  expect(fixture.cards).toEqual([])
  expect(response.json().result.structuredContent.resources[0].tools[0]).toMatchObject({
    connection_status: "UNAVAILABLE",
    hub_status: "AVAILABLE",
    personal_connection_required: true,
  })
  expect(response.headers["content-encoding"]).toBeUndefined()
})
