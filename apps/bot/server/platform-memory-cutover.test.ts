import { expect, test } from "bun:test"
import Fastify from "fastify"
import { registerHttpObservability } from "@genioone/telemetry/fastify-observability"
import { BotRegistry } from "./bot-registry"
import { BotToolSessions } from "./bot-tool-sessions"
import { botTurnContext } from "./bot-context"
import { createCapabilityGate } from "./capability-gate"
import type { BotServerContext } from "./context"
import type { Turn } from "./generated/v2/Turn"
import { RuntimeBroker } from "./runtime-broker"
import { botToolRoutes } from "./routes/bot-tools"

type Principal = { tenant_id: string; subject_id: string; acting_client_id: string; scopes: string[] }

test("Platform personal memory is shared by same-owner Bots and fails closed without owner access", async () => {
  const registry = new BotRegistry(":memory:")
  const sessions = new BotToolSessions()
  const broker = new RuntimeBroker({ provision: async () => { throw new Error("not needed") } })
  const originalOrigin = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://memory-bot-tools-collector.test"
  const app = Fastify()
  registerHttpObservability(app, "bot-memory-tools-test")
  const owner: Principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: ["genioone-invocation"] }
  const other: Principal = { tenant_id: "tenant", subject_id: "other", acting_client_id: "genio-one-bot", scopes: ["genioone-invocation"] }
  const withoutToken: Principal = { tenant_id: "tenant", subject_id: "without-token", acting_client_id: "genio-one-bot", scopes: ["genioone-invocation"] }
  const ownerA = registry.create(owner, { name: "A" })
  const ownerB = registry.create(owner, { name: "B" })
  const otherBot = registry.create(other, { name: "Other" })
  const noTokenBot = registry.create(withoutToken, { name: "No token" })
  const ownerRuntime = await broker.start(owner, { onMessage() {}, onExit() {} }, undefined, "owner-token")
  const otherRuntime = await broker.start(other, { onMessage() {}, onExit() {} }, undefined, "other-token")
  const noTokenRuntime = await broker.start(withoutToken, { onMessage() {}, onExit() {} })
  const ownerAConfig = sessions.config(ownerA.id, owner, ownerRuntime.id)
  const ownerBConfig = sessions.config(ownerB.id, owner, ownerRuntime.id)
  const otherConfig = sessions.config(otherBot.id, other, otherRuntime.id)
  const noTokenConfig = sessions.config(noTokenBot.id, withoutToken, noTokenRuntime.id)
  await botToolRoutes(app, {
    botRegistry: registry,
    botToolSessions: sessions,
    runtimeBroker: broker,
    capabilityGate: createCapabilityGate({ mode: "open" }),
    workspaces: { active: () => null },
  } as unknown as BotServerContext)

  const originalFetch = globalThis.fetch
  const originalPlatformOrigin = process.env.GENIO_ONE_PLATFORM_ORIGIN
  process.env.GENIO_ONE_PLATFORM_ORIGIN = "http://platform.test"
  const principals = new Map<string, Principal>([["owner-token", owner], ["other-token", other]])
  const memories = new Map<string, Map<string, Record<string, unknown>>>()
  const mcpCalls: Array<{ token: string; name: string; args: Record<string, unknown> }> = []
  const observations: any[] = []
  let sequence = 0
  let memoryAvailable = true
  let loseRememberResponse = false
  const store = (principal: Principal) => {
    const key = `${principal.tenant_id}:${principal.subject_id}`
    let value = memories.get(key)
    if (!value) {
      value = new Map()
      memories.set(key, value)
    }
    return value
  }
  const mcpResult = (value: Record<string, unknown>) => Response.json({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value },
  })
  const mcpFailure = (code: string) => Response.json({
    jsonrpc: "2.0",
    id: 1,
    result: { isError: true, content: [{ type: "text", text: code }] },
  })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin === "http://memory-bot-tools-collector.test") {
      observations.push(JSON.parse(String(init?.body)))
      return new Response("{}")
    }
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const token = headers.get("authorization")?.replace(/^Bearer /, "") ?? ""
    const principal = principals.get(token)
    if (url.pathname === "/v1/identity/session") {
      return principal ? Response.json(principal) : new Response("unauthorized", { status: 401 })
    }
    if (!url.pathname.endsWith("/memory/mcp")) return new Response("not found", { status: 404 })
    if (!principal) return new Response("unauthorized", { status: 401 })
    if (!memoryAvailable) return new Response("forbidden", { status: 403 })
    const request = typeof init?.body === "string" ? JSON.parse(init.body) as { params?: { name?: unknown; arguments?: unknown } } : {}
    const name = typeof request.params?.name === "string" ? request.params.name : ""
    const args = request.params?.arguments && typeof request.params.arguments === "object" && !Array.isArray(request.params.arguments)
      ? request.params.arguments as Record<string, unknown>
      : {}
    mcpCalls.push({ token, name, args })
    const ownerMemories = store(principal)
    if (name === "memory_remember") {
      const id = typeof args.memory_id === "string" ? args.memory_id : `memory-${++sequence}`
      const prior = ownerMemories.get(id)
      const expectedRevision = typeof args.expected_revision === "number" ? args.expected_revision : -1
      if (prior && prior.revision !== expectedRevision) return mcpFailure("MEMORY_CONFLICT")
      if (!prior && expectedRevision !== 0) return mcpFailure("MEMORY_CONFLICT")
      const context = args.context && typeof args.context === "object" && !Array.isArray(args.context) ? args.context as Record<string, unknown> : { kind: "GLOBAL", context_id: null }
      const revision = prior ? Number(prior.revision) + 1 : 1
      const value: Record<string, unknown> = {
        memory_id: id,
        tenant_id: principal.tenant_id,
        scope: "PERSONAL",
        owner_subject_id: principal.subject_id,
        team_id: null,
        organization_id: null,
        key: args.key,
        kind: args.kind,
        context,
        content: args.content,
        assertion_origin: "AGENT_INFERRED",
        source: { actor_subject_id: principal.subject_id, client_id: principal.acting_client_id, agent_id: principal.acting_client_id, agent_grant_id: `grant-${principal.subject_id}`, reference_id: args.source_reference_id ?? null },
        revision,
        created_at: prior?.created_at ?? 1,
        updated_at: revision,
        content_truncated: false,
      }
      ownerMemories.set(id, value)
      if (loseRememberResponse) throw new TypeError("simulated lost response")
      return mcpResult(value)
    }
    if (name === "memory_retrieve") {
      const query = typeof args.query === "string" ? args.query.toLowerCase() : ""
      const context = args.context && typeof args.context === "object" && !Array.isArray(args.context) ? args.context as Record<string, unknown> : { kind: "GLOBAL", context_id: null }
      const entries = [...ownerMemories.values()].filter((memory) => {
        const memoryContext = memory.context as Record<string, unknown>
        const matchesContext = memoryContext.kind === context.kind && memoryContext.context_id === context.context_id
        const matchesQuery = !query || String(memory.key).toLowerCase().includes(query) || String(memory.content).toLowerCase().includes(query)
        return matchesContext && matchesQuery
      })
      const limit = typeof args.limit === "number" ? args.limit : 8
      const selected = entries.slice(0, limit)
      return mcpResult({ memories: selected, context: selected.map((memory) => String(memory.content)).join("\n\n") })
    }
    if (name === "memory_forget") {
      const id = typeof args.memory_id === "string" ? args.memory_id : ""
      const current = ownerMemories.get(id)
      if (!current) return mcpFailure("MEMORY_NOT_FOUND")
      if (current.revision !== args.expected_revision) return mcpFailure("MEMORY_CONFLICT")
      ownerMemories.delete(id)
      return mcpResult({ memory_id: id, scope: "PERSONAL", owner_subject_id: principal.subject_id, deleted_revision: Number(current.revision), deleted_at: 1 })
    }
    return mcpFailure("MEMORY_TOOL_NOT_FOUND")
  }) as typeof fetch

  const call = (config: ReturnType<BotToolSessions["config"]>, name: string, args: unknown, id = 1) => app.inject({
    method: "POST",
    url: "/api/bot-tools",
    headers: config.http_headers,
    payload: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
  })

  try {
    const listed = await app.inject({ method: "POST", url: "/api/bot-tools", headers: ownerAConfig.http_headers, payload: { jsonrpc: "2.0", id: 0, method: "tools/list" } })
    expect(listed.statusCode).toBe(200)
    expect(listed.json().result.isError).not.toBe(true)
    expect(Array.isArray(listed.json().result.tools)).toBe(true)
    const rememberTool = listed.json().result.tools.find((tool: { name: string }) => tool.name === "remember")
    expect(rememberTool.inputSchema.properties.sourceMessageIds.maxItems).toBe(1)
    registry.timeline.putTurn(ownerA.id, "preference", { id: "preference-turn", status: "completed", items: [
      { type: "agentMessage", id: "source", text: "Owner prefers Asia/Taipei." },
      { type: "agentMessage", id: "another", text: "Another source." },
    ] } as unknown as Turn)
    const remembered = (await call(ownerAConfig, "remember", { key: "timezone", content: "Use Asia/Taipei", kind: "preference", sourceMessageIds: ["preference:source"] })).json().result
    expect(remembered.isError).toBe(false)
    const saved = JSON.parse(remembered.content[0].text)
    expect(saved.source.referenceId).toBe("preference:source")
    expect(registry.memory.recall(ownerA.id).memories).toEqual([])
    const beforeRejectedSource = mcpCalls.length
    for (const sourceMessageIds of [["preference:source", "preference:another"], ["missing-source"]]) {
      const rejected = (await call(ownerAConfig, "remember", { key: "extra", content: "Rejected source", kind: "fact", sourceMessageIds })).json().result
      expect(rejected).toMatchObject({ isError: true, content: [{ type: "text", text: "BOT_MEMORY_SOURCE_INVALID" }] })
    }
    expect(mcpCalls).toHaveLength(beforeRejectedSource)

    const bContext = JSON.parse((await botTurnContext(registry, ownerB.id, "b-turn", {}, ownerB, owner, "owner-token"))["genio_bot/memory"].value)
    expect(bContext).toMatchObject({ state: "available", source: "platform_personal_memory_mcp", memories: [expect.objectContaining({ id: saved.id, content: "Use Asia/Taipei", context: { kind: "GLOBAL", contextId: null } })] })
    expect(bContext.guidance).toContain("source")
    expect(bContext.guidance).toContain("applicability")

    const recalledByB = (await call(ownerBConfig, "recall_memory", { query: "timezone" }, 2)).json().result
    expect(recalledByB.isError).toBe(false)
    expect(JSON.parse(recalledByB.content[0].text)).toMatchObject({ source: "platform_personal_memory_mcp", memories: [expect.objectContaining({ id: saved.id, content: "Use Asia/Taipei" })] })

    const recalledByOther = (await call(otherConfig, "recall_memory", { query: "timezone" }, 3)).json().result
    expect(recalledByOther.isError).toBe(false)
    expect(JSON.parse(recalledByOther.content[0].text).memories).toEqual([])

    const rememberedCall = mcpCalls.find((entry) => entry.name === "memory_remember")!
    expect(rememberedCall.args.source_reference_id).toBe("preference:source")
    expect(rememberedCall.args.idempotency_key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(rememberedCall.args.idempotency_key).not.toContain("timezone")

    const deleted = (await call(ownerBConfig, "forget_memory", { memoryId: saved.id, expectedRevision: saved.revision }, 4)).json().result
    expect(deleted.isError).toBe(false)
    const deletedCall = mcpCalls.find((entry) => entry.name === "memory_forget")!
    expect(deletedCall.args.idempotency_key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(JSON.parse((await call(ownerAConfig, "recall_memory", {}, 5)).json().result.content[0].text).memories).toEqual([])

    registry.timeline.putTurn(ownerA.id, "work", { id: "turn", status: "completed", items: [{ type: "agentMessage", id: "source", text: "Work evidence" }] } as unknown as Turn)
    const work = { goal: "Keep A's plan", status: "active", decisions: ["Use Platform memory"], progress: ["Saved owner preference"], nextSteps: ["Continue"], blockers: [], sourceMessageIds: ["work:source"], expectedRevision: 0 }
    expect((await call(ownerAConfig, "update_work_summary", work, 6)).json().result.isError).toBe(false)
    expect(JSON.parse((await call(ownerBConfig, "read_work_summary", {}, 7)).json().result.content[0].text)).toMatchObject({ entry: null, writable: true })
    expect(JSON.parse((await call(ownerAConfig, "read_work_summary", {}, 8)).json().result.content[0].text).entry.workSummary.goal).toBe("Keep A's plan")

    registry.memory.save(ownerA.id, { key: "legacy-only", content: "must never be remote fallback", kind: "fact" }, "user")
    memoryAvailable = false
    const forbidden = (await call(ownerAConfig, "recall_memory", {}, 9)).json().result
    expect(forbidden).toMatchObject({ isError: true })
    expect(forbidden.content[0].text).toContain("PERSONAL_MEMORY_UNAVAILABLE")
    expect(forbidden.content[0].text).not.toContain("must never be remote fallback")
    const forbiddenContext = JSON.parse((await botTurnContext(registry, ownerA.id, "a-turn", {}, ownerA, owner, "owner-token"))["genio_bot/memory"].value)
    expect(forbiddenContext).toMatchObject({ state: "unavailable", memories: [] })
    expect(JSON.stringify(forbiddenContext)).not.toContain("must never be remote fallback")

    registry.memory.save(noTokenBot.id, { key: "legacy-only", content: "no-token legacy", kind: "fact" }, "user")
    const beforeNoToken = mcpCalls.length
    const noTokenTool = (await call(noTokenConfig, "recall_memory", {}, 10)).json().result
    expect(noTokenTool).toMatchObject({ isError: true })
    expect(noTokenTool.content[0].text).toContain("PERSONAL_MEMORY_UNAVAILABLE")
    expect(noTokenTool.content[0].text).not.toContain("no-token legacy")
    expect(mcpCalls).toHaveLength(beforeNoToken)
    const noTokenContext = JSON.parse((await botTurnContext(registry, noTokenBot.id, "no-token-turn", {}, noTokenBot, withoutToken))["genio_bot/memory"].value)
    expect(noTokenContext).toMatchObject({ state: "unavailable", memories: [] })
    expect(JSON.stringify(noTokenContext)).not.toContain("no-token legacy")

    memoryAvailable = true
    loseRememberResponse = true
    const beforeLostResponse = mcpCalls.length
    const lostResponse = (await call(ownerAConfig, "remember", { key: "lost-response-command", kind: "fact", content: "lost-response-memory-secret" }, 11)).json().result
    expect(lostResponse.isError).toBe(true)
    expect(lostResponse.content[0].text).toContain("PERSONAL_MEMORY_UNAVAILABLE")
    expect(mcpCalls).toHaveLength(beforeLostResponse + 1)
    expect([...store(owner).values()].filter((memory) => memory.key === "lost-response-command")).toHaveLength(1)
    const lostCommandKey = mcpCalls.at(-1)?.args.idempotency_key
    loseRememberResponse = false
    const nextCommand = (await call(ownerAConfig, "remember", { key: "new-command", kind: "fact", content: "new-command-memory-secret" }, 12)).json().result
    expect(nextCommand.isError).toBe(false)
    expect(mcpCalls.at(-1)?.args.idempotency_key).not.toBe(lostCommandKey)

    const earlyAuthFailure = await app.inject({ method: "POST", url: "/api/bot-tools", headers: { authorization: "Bearer expired-session" }, payload: { jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "remember", arguments: { content: "early-auth-memory-secret" } } } })
    expect(earlyAuthFailure.statusCode).toBe(401)
    const parseFailure = await app.inject({ method: "POST", url: "/api/bot-tools", headers: { ...ownerAConfig.http_headers, "content-type": "application/json" }, payload: '{"content":"early-parse-memory-secret"' })
    expect(parseFailure.statusCode).toBe(400)
    await app.close()
    const serialized = JSON.stringify(observations)
    for (const value of ["Use Asia/Taipei", "lost-response-memory-secret", "new-command-memory-secret", "early-auth-memory-secret", "early-parse-memory-secret"]) expect(serialized).not.toContain(value)
    expect(serialized).not.toContain("request_user_input_async")
    const spans = observations.flatMap(value => value.resourceSpans ?? []).flatMap(value => value.scopeSpans).flatMap(value => value.spans)
    const attributes = spans.map(span => Object.fromEntries(span.attributes.map((value: any) => [value.key, value.value.stringValue ?? value.value.intValue])))
    const generic = attributes.filter(value => value["genio.request"] === JSON.stringify({ availability: "OMITTED_HTTP_REQUEST" }))
    expect(generic.length).toBeGreaterThanOrEqual(1)
    expect(generic.every(value => value["genio.response"] === JSON.stringify({ availability: "OMITTED_HTTP_RESPONSE" }))).toBe(true)
    const omitted = attributes.filter(value => value["genio.request"] === JSON.stringify({ availability: "OMITTED_SENSITIVE_REQUEST" }))
    expect(omitted.length).toBeGreaterThanOrEqual(8)
    expect(omitted.every(value => value["genio.response"] === JSON.stringify({ availability: "OMITTED_SENSITIVE_RESPONSE" }))).toBe(true)
    expect(omitted.some(value => value["http.response.status_code"] === "401")).toBe(true)
    expect(omitted.some(value => value["http.response.status_code"] === "400")).toBe(true)
  } finally {
    await app.close()
    globalThis.fetch = originalFetch
    if (originalPlatformOrigin === undefined) delete process.env.GENIO_ONE_PLATFORM_ORIGIN
    else process.env.GENIO_ONE_PLATFORM_ORIGIN = originalPlatformOrigin
    if (originalOrigin === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalOrigin
    await broker.close()
    registry.close()
  }
})


test("Bot memory tools join the active-grant Platform MCP contract", async () => {
  const tenantId = "tenant-bot-memory-join"
  const ownerId = "owner-bot-memory-join"
  const { createManagementApi } = await import(new URL("../../platform/platform-api/src/app.ts", import.meta.url).href) as { createManagementApi: (input: unknown) => Promise<any> }
  const { createInMemoryPlatformModules } = await import(new URL("../../platform/platform-api/src/capabilities/platform-modules.ts", import.meta.url).href) as { createInMemoryPlatformModules: (input: { now: () => number }) => any }
  const { createStaticPrincipalAuthenticator } = await import(new URL("../../platform/platform-api/src/capabilities/tenancy-auth/memory.ts", import.meta.url).href) as { createStaticPrincipalAuthenticator: (principals: Record<string, unknown>) => any }
  const botActor = {
    tenant_id: tenantId,
    subject_id: ownerId,
    client_id: "genio-one-bot",
    role: "USER",
    organization_ids: [],
    scopes: ["genioone-invocation"],
  }
  const ownerActor = {
    ...botActor,
    client_id: "genio-one-self-service",
  }
  const modules = createInMemoryPlatformModules({ now: () => 1_000 })
  await modules.identity.bootstrap({
    tenantId,
    subjects: [{ subject_id: ownerId, kind: "PERSON" }],
  })
  const platform = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      "bot-token": botActor,
      "owner-enable-token": ownerActor,
    }),
    browserIdentity: {
      tenant_id: tenantId,
      issuer: "https://identity.join.test",
      authorization_endpoint: "https://identity.join.test/authorize",
      token_endpoint: "https://identity.join.test/token",
      client_id: "genio-one-bot",
      scopes: ["genioone-invocation"],
      management_client_id: "genio-one-self-service",
      management_scopes: ["genioone-invocation"],
    },
  })
  const enabled = await platform.inject({
    method: "POST",
    url: `/v1/tenants/${tenantId}/me/memory-agents`,
    headers: { authorization: "Bearer owner-enable-token", "content-type": "application/json" },
    payload: { agent_id: "genio-one-bot" },
  })
  expect(enabled.statusCode).toBe(201)

  const registry = new BotRegistry(":memory:")
  const sessions = new BotToolSessions()
  const broker = new RuntimeBroker({ provision: async () => { throw new Error("not needed") } })
  const app = Fastify()
  const botPrincipal: Principal = { tenant_id: tenantId, subject_id: ownerId, acting_client_id: "genio-one-bot", scopes: ["genioone-invocation"] }
  const botA = registry.create(botPrincipal, { name: "Join A" })
  const botB = registry.create(botPrincipal, { name: "Join B" })
  const runtime = await broker.start(botPrincipal, { onMessage() {}, onExit() {} }, undefined, "bot-token")
  const configA = sessions.config(botA.id, botPrincipal, runtime.id)
  const configB = sessions.config(botB.id, botPrincipal, runtime.id)
  await botToolRoutes(app, {
    botRegistry: registry,
    botToolSessions: sessions,
    runtimeBroker: broker,
    capabilityGate: createCapabilityGate({ mode: "open" }),
  } as unknown as BotServerContext)

  const originalFetch = globalThis.fetch
  const originalPlatformOrigin = process.env.GENIO_ONE_PLATFORM_ORIGIN
  process.env.GENIO_ONE_PLATFORM_ORIGIN = "http://platform.join.test"
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin !== "http://platform.join.test") return new Response("not found", { status: 404 })
    const requestHeaders = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const response = await platform.inject({
      method: init?.method ?? (input instanceof Request ? input.method : "GET"),
      url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(requestHeaders.entries()),
      ...(typeof init?.body === "string" ? { payload: init.body } : {}),
    })
    const contentType = response.headers["content-type"]
    return new Response(response.body, {
      status: response.statusCode,
      headers: typeof contentType === "string" ? { "content-type": contentType } : undefined,
    })
  }) as typeof fetch
  const call = (config: ReturnType<BotToolSessions["config"]>, name: string, args: unknown, id: number) => app.inject({
    method: "POST",
    url: "/api/bot-tools",
    headers: config.http_headers,
    payload: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
  })

  try {
    const remembered = (await call(configA, "remember", { key: "timezone", content: "Use Asia/Taipei", kind: "preference" }, 1)).json().result
    expect(remembered.isError).toBe(false)
    const saved = JSON.parse(remembered.content[0].text)
    expect(saved).toMatchObject({ kind: "preference", content: "Use Asia/Taipei", source: { clientId: "genio-one-bot", agentId: "genio-one-bot" } })

    const recalled = (await call(configB, "recall_memory", { query: "timezone" }, 2)).json().result
    expect(recalled.isError).toBe(false)
    const recalledPayload = JSON.parse(recalled.content[0].text)
    expect(recalledPayload.source).toBe("platform_personal_memory_mcp")
    expect(recalledPayload.memories).toHaveLength(1)
    expect(recalledPayload.memories[0].id).toBe(saved.id)
    expect(recalledPayload.memories[0].content).toBe("Use Asia/Taipei")
    expect(recalledPayload.memories[0].source.clientId).toBe("genio-one-bot")
    expect(recalledPayload.memories[0].source.agentId).toBe("genio-one-bot")
    const context = JSON.parse((await botTurnContext(registry, botB.id, "join-turn", {}, botB, botPrincipal, "bot-token"))["genio_bot/memory"].value)
    expect(context).toMatchObject({ state: "available", memories: [expect.objectContaining({ id: saved.id, context: { kind: "GLOBAL", contextId: null } })] })

    registry.memory.save(botA.id, { key: "legacy-only", content: "must not return after revoke", kind: "fact" }, "user")
    const revoked = await platform.inject({
      method: "DELETE",
      url: `/v1/tenants/${tenantId}/me/memory-agents/genio-one-bot`,
      headers: { authorization: "Bearer owner-enable-token" },
    })
    expect(revoked.statusCode).toBe(200)
    const unavailable = (await call(configB, "recall_memory", {}, 3)).json().result
    expect(unavailable).toMatchObject({ isError: true })
    expect(unavailable.content[0].text).toContain("PERSONAL_MEMORY_UNAVAILABLE")
    expect(unavailable.content[0].text).not.toContain("must not return after revoke")
    const unavailableContext = JSON.parse((await botTurnContext(registry, botA.id, "revoked-turn", {}, botA, botPrincipal, "bot-token"))["genio_bot/memory"].value)
    expect(unavailableContext).toMatchObject({ state: "unavailable", memories: [] })
    expect(JSON.stringify(unavailableContext)).not.toContain("must not return after revoke")
  } finally {
    globalThis.fetch = originalFetch
    if (originalPlatformOrigin === undefined) delete process.env.GENIO_ONE_PLATFORM_ORIGIN
    else process.env.GENIO_ONE_PLATFORM_ORIGIN = originalPlatformOrigin
    await app.close()
    await broker.close()
    registry.close()
    await platform.close()
  }
})
