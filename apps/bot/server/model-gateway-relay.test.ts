import { afterEach, describe, expect, test } from "bun:test"

import { modelGatewayRelayRoutes, responsesToChatRequest } from "./model-gateway-relay"

class Reply {
  statusCode = 200
  body: unknown
  readonly headers = new Headers()

  code(statusCode: number) {
    this.statusCode = statusCode
    return this
  }

  header(name: string, value: string) {
    this.headers.set(name, value)
    return this
  }

  send(body: unknown) {
    this.body = body
    return body
  }
}

function waitFor(check: () => boolean) {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 1_000
    const tick = () => {
      if (check()) return resolve()
      if (Date.now() >= deadline) return reject(new Error("MCP_RELAY_TEST_TIMEOUT"))
      setTimeout(tick, 1)
    }
    tick()
  })
}

function decision(correlationId: string) {
  return {
    tenant_id: "tenant-uat",
    subject_id: "person-dylan",
    client_id: "genio-one-bot",
    bot_id: "bot-dylan",
    runtime_id: "codex",
    policy_id: "one-policy.uat.engineering",
    policy_display_name: "Engineering Runtime Policy",
    policy_revision: 3,
    capability_id: "model.invoke",
    action: "invoke" as const,
    target: "runtime:codex:model.invoke",
    decision: "ALLOW" as const,
    reason_code: "RULE_ALLOW:dylan.model.invoke",
    constraints: [],
    obligations: [{ kind: "audit", enforcement_point_id: "AGENT_RUNTIME", parameters: {} }],
    correlation_id: correlationId,
    session_id: "runtime-session",
    evaluated_at: 1_757_000_000,
  }
}

describe("model gateway relay governance context", () => {
  const originalFetch = globalThis.fetch
  const originalGateway = process.env.GENIO_ONE_MODEL_GATEWAY_BASE_URL

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalGateway === undefined) delete process.env.GENIO_ONE_MODEL_GATEWAY_BASE_URL
    else process.env.GENIO_ONE_MODEL_GATEWAY_BASE_URL = originalGateway
  })

  test("authorizes and reports with one server correlation and forwards only verified usage context", async () => {
    process.env.GENIO_ONE_MODEL_GATEWAY_BASE_URL = "https://gateway.example/v1"
    const upstream: Array<{ url: string; headers: Headers; body: string }> = []
    globalThis.fetch = (async (input, init) => {
      upstream.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body) })
      return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\n", { status: 200 })
    }) as typeof fetch
    const authorizations: Array<Record<string, unknown>> = []
    const reports: Array<Record<string, unknown>> = []
    const session = {
      id: "runtime-session",
      principal: {
        tenant_id: "tenant-uat",
        subject_id: "person-dylan",
        acting_client_id: "genio-one-bot",
        organization_ids: ["org-engineering"],
        scopes: ["genioone-invocation"],
      },
      selectedBotId: "bot-dylan",
      usageContext: { consumerOrganizationId: "org-engineering", useCaseId: "uat-purpose-dylan" },
      accessToken: "session-token",
    }
    let handler: ((request: unknown, reply: Reply) => Promise<unknown>) | null = null
    const context = {
      runtimeBroker: { get: () => session },
      botRegistry: {
        getOwned: () => ({
          id: "bot-dylan",
          modelRoute: "genio-gateway",
          ownerOrganizationId: "org-engineering",
          useCaseId: "uat-purpose-dylan",
        }),
      },
      runtimePolicy: {
        async authorize(input: Record<string, unknown>) {
          authorizations.push(input)
          return decision(String(input.correlationId))
        },
        async report(input: Record<string, unknown>) {
          reports.push(input)
        },
      },
    }
    await modelGatewayRelayRoutes({
      post: (_path: string, route: (request: unknown, reply: Reply) => Promise<unknown>) => { handler = route },
      all: () => {},
    } as never, context as never)

    const reply = new Reply()
    await handler!({
      params: { runtimeSessionId: "runtime-session" },
      headers: {
        "x-request-id": "forged-correlation",
        "x-genio-organization-id": "forged-organization",
        "x-genio-use-case-id": "forged-purpose",
      },
      body: { model: "gemini-2.5-flash-lite", input: "hello" },
    }, reply)

    for await (const _chunk of reply.body as AsyncIterable<unknown>) {}
    expect(authorizations).toHaveLength(1)
    expect(upstream).toHaveLength(1)
    expect(reports).toHaveLength(1)
    const correlationId = String(authorizations[0]!.correlationId)
    expect(correlationId).not.toBe("forged-correlation")
    expect(upstream[0]!.headers.get("x-request-id")).toBe(correlationId)
    expect(upstream[0]!.headers.get("x-genio-correlation-id")).toBe(correlationId)
    expect(upstream[0]!.headers.get("x-genio-session-id")).toBe("runtime-session")
    expect(upstream[0]!.headers.get("x-genio-organization-id")).toBe("org-engineering")
    expect(upstream[0]!.headers.get("x-genio-use-case-id")).toBe("uat-purpose-dylan")
    expect(reports[0]!.correlationId).toBe(correlationId)
    expect(reports[0]!.outcome).toBe("COMPLETED")
    expect(reply.statusCode).toBe(200)
    expect(reply.headers.get("x-request-id")).toBe(correlationId)
  })

  test("rejects a session context that does not match the server-owned Bot binding", async () => {
    let handler: ((request: unknown, reply: Reply) => Promise<unknown>) | null = null
    let authorized = false
    const session = {
      id: "runtime-session",
      principal: { tenant_id: "tenant-uat", subject_id: "person-dylan", acting_client_id: "genio-one-bot", organization_ids: ["org-engineering"], scopes: [] },
      selectedBotId: "bot-dylan",
      usageContext: { consumerOrganizationId: "org-attacker", useCaseId: "forged-purpose" },
      accessToken: "session-token",
    }
    await modelGatewayRelayRoutes({
      post: (_path: string, route: (request: unknown, reply: Reply) => Promise<unknown>) => { handler = route },
      all: () => {},
    } as never, {
      runtimeBroker: { get: () => session },
      botRegistry: { getOwned: () => ({ id: "bot-dylan", modelRoute: "genio-gateway", ownerOrganizationId: "org-engineering", useCaseId: "uat-purpose-dylan" }) },
      runtimePolicy: {
        async authorize() { authorized = true; return decision("unused") },
        async report() {},
      },
    } as never)
    const reply = new Reply()
    await handler!({ params: { runtimeSessionId: "runtime-session" }, headers: {}, body: {} }, reply)
    expect(reply.statusCode).toBe(409)
    expect((reply.body as { error: string }).error).toBe("USE_CASE_REQUIRED")
    expect(authorized).toBe(false)
  })
})

describe("model gateway relay", () => {
  test("adapts the native Responses request without changing the model route", () => {
    const result = responsesToChatRequest({
      model: "gemini-2.5-flash-lite",
      instructions: "You are Nova.",
      input: [
        { role: "user", content: [{ type: "input_text", text: "Summarize this case." }] },
        { role: "assistant", content: [{ type: "output_text", text: "I will inspect it." }] },
      ],
      tools: [{ type: "function", name: "read_case", description: "Read a ServiceNow case", parameters: { type: "object" } }],
      temperature: 0.2,
      top_p: 0.9,
      max_output_tokens: 128,
    })

    expect(result).toEqual({
      model: "gemini-2.5-flash-lite",
      messages: [
        { role: "system", content: "You are Nova." },
        { role: "user", content: "Summarize this case." },
        { role: "assistant", content: "I will inspect it." },
      ],
      stream: true,
      tools: [{
        type: "function",
        function: {
          name: "read_case",
          description: "Read a ServiceNow case",
          parameters: { type: "object" },
        },
      }],
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 128,
    })
  })

  test("accepts a plain input string for simple turns", () => {
    expect(responsesToChatRequest({ model: "company-model", input: "hello" })).toEqual({
      model: "company-model",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    })
  })
})

function managedMcpDecision(correlationId: string, overrides: Record<string, unknown> = {}) {
  return {
    ...decision(correlationId),
    capability_id: "mcp.invoke",
    action: "invoke" as const,
    target: "runtime:codex:mcp.invoke",
    ...overrides,
  }
}

describe("managed MCP relay runtime policy", () => {
  const originalMcpGateway = process.env.GENIO_ONE_MCP_URL

  afterEach(() => {
    if (originalMcpGateway === undefined) delete process.env.GENIO_ONE_MCP_URL
    else process.env.GENIO_ONE_MCP_URL = originalMcpGateway
  })

  async function routeFor(context: Record<string, unknown>) {
    const routes = new Map<string, (request: unknown, reply: Reply) => Promise<unknown>>()
    await modelGatewayRelayRoutes({
      post: () => {},
      all: (path: string, handler: (request: unknown, reply: Reply) => Promise<unknown>) => { routes.set(path, handler) },
    } as never, context as never)
    const route = routes.get("/api/mcp-gateway/:runtimeSessionId/:resourceId/mcp")
    if (!route) throw new Error("MCP_RELAY_ROUTE_MISSING")
    return route
  }

  function contextFor(policy: Record<string, unknown>, bindings = [{ resourceId: "resource-context7", capabilityId: "context7", state: "INSTALLED", kind: "MCP" }]) {
    const session = {
      id: "runtime-session",
      principal: {
        tenant_id: "tenant-uat",
        subject_id: "person-dylan",
        acting_client_id: "genio-one-bot",
        scopes: ["genioone-invocation"],
      },
      selectedBotId: "bot-dylan",
      accessToken: "session-token",
      managedMcpMounts: {
        "resource-context7": {
          resourceId: "resource-context7",
          capabilityId: "context7",
          serverName: "genio_mcp_context7",
          hostname: "context7.example",
          basePath: "/mcp",
        },
      },
    }
    return {
      runtimeBroker: { get: () => session },
      botRegistry: { getOwned: () => ({ id: "bot-dylan", bindings }) },
      runtimePolicy: policy,
    }
  }

  function request() {
    return {
      params: { runtimeSessionId: "runtime-session", resourceId: "resource-context7" },
      method: "POST",
      url: "/api/mcp-gateway/runtime-session/resource-context7/mcp?session=1",
      headers: { "content-type": "application/json" },
      body: { jsonrpc: "2.0", id: 1, method: "tools/call" },
    }
  }

  test("keeps the catalog and live binding gate before authorizing an MCP invocation", async () => {
    process.env.GENIO_ONE_MCP_URL = "https://gateway.example/mcp"
    let authorized = false
    const route = await routeFor(contextFor({
      async authorize() { authorized = true; return managedMcpDecision("unused") },
      async report() {},
    }, []))

    const reply = new Reply()
    await route(request(), reply)

    expect(reply.statusCode).toBe(403)
    expect((reply.body as { error: string }).error).toBe("MCP_RESOURCE_NOT_ALLOWED")
    expect(authorized).toBe(false)
  })

  test("reports a completed managed MCP invocation only after its response reaches EOF", async () => {
    process.env.GENIO_ONE_MCP_URL = "https://gateway.example/mcp"
    const authorizations: Array<Record<string, unknown>> = []
    const reports: Array<Record<string, unknown>> = []
    const upstream: Array<{ url: string; headers: Headers }> = []
    globalThis.fetch = (async (input, init) => {
      upstream.push({ url: String(input), headers: new Headers(init?.headers) })
      return Response.json({ jsonrpc: "2.0", id: 1, result: {} })
    }) as typeof fetch
    const route = await routeFor(contextFor({
      async authorize(input: Record<string, unknown>) {
        authorizations.push(input)
        return managedMcpDecision(String(input.correlationId))
      },
      async report(input: Record<string, unknown>) { reports.push(input) },
    }))

    const reply = new Reply()
    await route(request(), reply)
    expect(reports).toHaveLength(0)
    for await (const _chunk of reply.body as AsyncIterable<unknown>) {}

    expect(authorizations).toHaveLength(1)
    expect(authorizations[0]).toMatchObject({ capabilityId: "mcp.invoke", action: "invoke", botId: "bot-dylan" })
    expect(upstream).toHaveLength(1)
    expect(upstream[0]!.url).toBe("https://context7.example/mcp?session=1")
    expect(upstream[0]!.headers.get("authorization")).toBe("Bearer session-token")
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ capabilityId: "mcp.invoke", action: "invoke", outcome: "COMPLETED", correlationId: authorizations[0]!.correlationId })
    expect(reply.statusCode).toBe(200)
  })

  test("reports a failed managed MCP invocation when its response stream interrupts", async () => {
    process.env.GENIO_ONE_MCP_URL = "https://gateway.example/mcp"
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0"}'))
        controller.error(new Error("MCP_STREAM_INTERRUPTED"))
      },
    }))) as unknown as typeof fetch
    const reports: Array<Record<string, unknown>> = []
    const route = await routeFor(contextFor({
      async authorize(input: Record<string, unknown>) { return managedMcpDecision(String(input.correlationId)) },
      async report(input: Record<string, unknown>) { reports.push(input) },
    }))

    const reply = new Reply()
    await route(request(), reply)
    expect(reports).toHaveLength(0)
    let streamFailed = false
    try {
      for await (const _chunk of reply.body as AsyncIterable<unknown>) {}
    } catch {
      streamFailed = true
    }

    expect(streamFailed).toBe(true)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ capabilityId: "mcp.invoke", action: "invoke", outcome: "FAILED", reasonCode: "MCP_GATEWAY_UPSTREAM_STREAM_FAILED" })
  })

  test("reports a failed managed MCP invocation when its response stream is cancelled", async () => {
    process.env.GENIO_ONE_MCP_URL = "https://gateway.example/mcp"
    let cancelled = false
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0"}'))
      },
      cancel() {
        cancelled = true
      },
    }))) as unknown as typeof fetch
    const reports: Array<Record<string, unknown>> = []
    const route = await routeFor(contextFor({
      async authorize(input: Record<string, unknown>) { return managedMcpDecision(String(input.correlationId)) },
      async report(input: Record<string, unknown>) { reports.push(input) },
    }))

    const reply = new Reply()
    await route(request(), reply)
    for await (const _chunk of reply.body as AsyncIterable<unknown>) break
    await waitFor(() => reports.length === 1)

    expect(cancelled).toBe(true)
    expect(reports[0]).toMatchObject({ capabilityId: "mcp.invoke", action: "invoke", outcome: "FAILED", reasonCode: "MCP_GATEWAY_UPSTREAM_STREAM_CANCELLED" })
  })

  test("fails the managed MCP response when EOF cannot be reported", async () => {
    process.env.GENIO_ONE_MCP_URL = "https://gateway.example/mcp"
    globalThis.fetch = (async () => Response.json({ jsonrpc: "2.0", id: 1, result: {} })) as unknown as typeof fetch
    const reports: Array<Record<string, unknown>> = []
    const route = await routeFor(contextFor({
      async authorize(input: Record<string, unknown>) { return managedMcpDecision(String(input.correlationId)) },
      async report(input: Record<string, unknown>) {
        reports.push(input)
        throw new Error("AUDIT_OFFLINE")
      },
    }))

    const reply = new Reply()
    await route(request(), reply)
    let streamFailed = false
    try {
      for await (const _chunk of reply.body as AsyncIterable<unknown>) {}
    } catch {
      streamFailed = true
    }

    expect(streamFailed).toBe(true)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ outcome: "COMPLETED" })
  })

  test("reports a managed MCP policy denial without forwarding", async () => {
    process.env.GENIO_ONE_MCP_URL = "https://gateway.example/mcp"
    let fetched = false
    globalThis.fetch = (async () => {
      fetched = true
      return Response.json({})
    }) as unknown as typeof fetch
    const reports: Array<Record<string, unknown>> = []
    const route = await routeFor(contextFor({
      async authorize(input: Record<string, unknown>) {
        return managedMcpDecision(String(input.correlationId), { decision: "DENY", reason_code: "RULE_DENY:mcp" })
      },
      async report(input: Record<string, unknown>) { reports.push(input) },
    }))

    const reply = new Reply()
    await route(request(), reply)

    expect(reply.statusCode).toBe(403)
    expect((reply.body as { error: string }).error).toBe("RULE_DENY:mcp")
    expect(fetched).toBe(false)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ capabilityId: "mcp.invoke", action: "invoke", outcome: "DENY" })
  })

  test("reports a failed managed MCP invocation when the upstream rejects it", async () => {
    process.env.GENIO_ONE_MCP_URL = "https://gateway.example/mcp"
    globalThis.fetch = (async () => new Response("unavailable", { status: 502 })) as unknown as typeof fetch
    const reports: Array<Record<string, unknown>> = []
    const route = await routeFor(contextFor({
      async authorize(input: Record<string, unknown>) { return managedMcpDecision(String(input.correlationId)) },
      async report(input: Record<string, unknown>) { reports.push(input) },
    }))

    const reply = new Reply()
    await route(request(), reply)
    for await (const _chunk of reply.body as AsyncIterable<unknown>) {}

    expect(reply.statusCode).toBe(502)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ capabilityId: "mcp.invoke", action: "invoke", outcome: "FAILED", reasonCode: "MCP_GATEWAY_UPSTREAM_502" })
  })
})
