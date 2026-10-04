import assert from "node:assert/strict"
import test from "node:test"
import {
  createPostHogNativeAnalytics,
  nativePostHogCaptures,
  stableNativePostHogUuid,
} from "./posthog-native-analytics"
import type { NativeTelemetryAcceptedLog } from "./native-telemetry"

function completed(overrides: Partial<NativeTelemetryAcceptedLog> = {}): NativeTelemetryAcceptedLog {
  return {
    eventName: "codex.sse_event",
    eventKind: "response.completed",
    eventTimestamp: "2026-10-03T00:00:00.000Z",
    conversationId: "conversation-a",
    model: "gpt-6-astra",
    inputTokenCount: 12,
    outputTokenCount: 7,
    cachedTokenCount: 2,
    reasoningTokenCount: 3,
    ttftMs: 125,
    provider: "openai",
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    ...overrides,
  }
}

test("native PostHog projection captures a real completion with scoped identities and no raw content", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const analytics = createPostHogNativeAnalytics({
    tenantId: "tenant-a",
    runtimeId: "runtime-a",
    accessToken: "session-token",
    platformOrigin: "https://platform.example",
    request: async (input, init) => {
      calls.push({ url: String(input), init })
      if (String(input).includes("browser-configuration")) return Response.json({ enabled: true, host: "https://us.i.posthog.com", project_id: 7, project_token: "phc_native" })
      return new Response("", { status: 200 })
    },
  })
  try {
    analytics.accept([completed()])
    await analytics.flush()
    const post = calls.find(call => call.url === "https://us.i.posthog.com/i/v0/e/")!
    const body = JSON.parse(String(post.init?.body)) as Record<string, any>
    assert.equal(body.api_key, "phc_native")
    assert.equal(body.event, "$ai_generation")
    assert.match(body.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.equal(body.properties.$ai_model, "gpt-6-astra")
    assert.equal(body.properties.$ai_input_tokens, 12)
    assert.equal(body.properties.$ai_output_tokens, 7)
    assert.equal(body.properties.$ai_cache_read_input_tokens, 2)
    assert.equal(body.properties.$ai_reasoning_tokens, 3)
    assert.equal(body.properties.$ai_time_to_first_token, 0.125)
    assert.match(body.properties.$ai_session_id, /^[0-9a-f]{32}$/)
    assert.match(body.properties.$ai_trace_id, /^[0-9a-f]{32}$/)
    assert.equal(body.properties.runtime_id, "runtime-a")
    assert.equal(JSON.stringify(body).includes("conversation-a"), false)
    assert.equal(JSON.stringify(body).includes("session-token"), false)
  } finally { await analytics.close() }
})

test("native PostHog projection keeps a tool span, skips GenioOne generations, and retries with one UUID", async () => {
  let deliveryAttempts = 0
  const sent: any[] = []
  const analytics = createPostHogNativeAnalytics({
    tenantId: "tenant-a",
    accessToken: "session-token",
    platformOrigin: "https://platform.example",
    retryBaseMillis: 1,
    retryMaxMillis: 2,
    request: async (input, init) => {
      if (String(input).includes("browser-configuration")) return Response.json({ enabled: true, host: "https://eu.i.posthog.com", project_id: 9, project_token: "phc_native" })
      deliveryAttempts += 1
      sent.push(JSON.parse(String(init?.body)))
      return new Response("", { status: deliveryAttempts === 1 ? 503 : 200 })
    },
  })
  try {
    analytics.accept([completed({ provider: "genio_one" }), {
      eventName: "codex.tool_result",
      eventKind: "tool.completed",
      eventTimestamp: "2026-10-03T00:00:01.000Z",
      conversationId: "conversation-a",
      callId: "call-a",
      toolName: "mail.send",
      mcpServer: "mail2000",
      durationMs: 250,
      success: false,
      traceId: "c".repeat(32),
      spanId: "d".repeat(16),
      arguments: "must never exist",
    } as NativeTelemetryAcceptedLog])
    await analytics.flush()
    assert.equal(sent.length, 2)
    assert.equal(sent[0].event, "$ai_span")
    assert.equal(sent[1].event, "$ai_span")
    assert.equal(sent[0].uuid, sent[1].uuid)
    assert.equal(sent[1].properties.$ai_span_name, "mail.send")
    assert.equal(sent[1].properties.$mcp_server_name, "mail2000")
    assert.equal(sent[1].properties.$ai_latency, 0.25)
    assert.equal(sent[1].properties.$ai_is_error, true)
    assert.equal(sent.some(body => body.event === "$ai_generation"), false)
    assert.equal(JSON.stringify(sent).includes("must never exist"), false)
  } finally { await analytics.close() }
})

test("native PostHog projection uses conversation provider_name metadata for subscription completions", async () => {
  const sent: any[] = []
  const analytics = createPostHogNativeAnalytics({
    tenantId: "tenant-a",
    accessToken: "session-token",
    platformOrigin: "https://platform.example",
    request: async (input, init) => {
      if (String(input).includes("browser-configuration")) return Response.json({ enabled: true, host: "https://us.i.posthog.com", project_id: 9, project_token: "phc_native" })
      sent.push(JSON.parse(String(init?.body)))
      return new Response("", { status: 200 })
    },
  })
  try {
    analytics.accept([{
      eventName: "codex.conversation_starts",
      eventTimestamp: "2026-10-03T00:00:00.000Z",
      conversationId: "conversation-subscription",
      providerName: "openai",
    }, completed({ conversationId: "conversation-subscription", provider: undefined })])
    await analytics.flush()
    assert.equal(sent.length, 1)
    assert.equal(sent[0].event, "$ai_generation")
    assert.equal(sent[0].properties.$ai_model, "gpt-6-astra")
  } finally { await analytics.close() }
})

test("native PostHog treats the owned GenioOne provider friendly name as genio_one", async () => {
  const sent: any[] = []
  const analytics = createPostHogNativeAnalytics({
    tenantId: "tenant-a",
    accessToken: "session-token",
    platformOrigin: "https://platform.example",
    request: async (input, init) => {
      if (String(input).includes("browser-configuration")) return Response.json({ enabled: true, host: "https://us.i.posthog.com", project_id: 9, project_token: "phc_native" })
      sent.push(JSON.parse(String(init?.body)))
      return new Response("", { status: 200 })
    },
  })
  try {
    analytics.accept([{
      eventName: "codex.conversation_starts",
      eventTimestamp: "2026-10-03T00:00:00.000Z",
      conversationId: "conversation-genio",
      providerName: "GenioOne AI Gateway",
    }, completed({ conversationId: "conversation-genio", provider: undefined }), {
      eventName: "codex.tool_result",
      eventTimestamp: "2026-10-03T00:00:01.000Z",
      conversationId: "conversation-genio",
      callId: "call-genio",
      toolName: "search",
      success: true,
    }])
    await analytics.flush()
    assert.equal(sent.length, 1)
    assert.equal(sent[0].event, "$ai_span")
  } finally { await analytics.close() }
})

test("native PostHog fails closed for an unresolved provider but keeps tool spans", async () => {
  const sent: any[] = []
  const analytics = createPostHogNativeAnalytics({
    tenantId: "tenant-a",
    accessToken: "session-token",
    platformOrigin: "https://platform.example",
    request: async (input, init) => {
      if (String(input).includes("browser-configuration")) return Response.json({ enabled: true, host: "https://us.i.posthog.com", project_id: 9, project_token: "phc_native" })
      sent.push(JSON.parse(String(init?.body)))
      return new Response("", { status: 200 })
    },
  })
  try {
    analytics.accept([completed({ conversationId: "conversation-unresolved", provider: undefined }), {
      eventName: "codex.tool_result",
      eventTimestamp: "2026-10-03T00:00:01.000Z",
      conversationId: "conversation-unresolved",
      callId: "call-unresolved",
      toolName: "search",
      success: true,
    }])
    await analytics.flush()
    assert.equal(sent.some(body => body.event === "$ai_generation"), false)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].event, "$ai_span")
    assert.equal(sent[0].properties.$ai_span_name, "search")
  } finally { await analytics.close() }
})

test("native PostHog projection stops on a disabled or unauthorized binding", async () => {
  for (const configuration of [null, { enabled: true, host: "https://us.i.posthog.com", project_id: 7, project_token: "phx_wrong" }]) {
    const calls: string[] = []
    const analytics = createPostHogNativeAnalytics({
      tenantId: "tenant-a",
      accessToken: "session-token",
      platformOrigin: "https://platform.example",
      request: async input => {
        calls.push(String(input))
        return Response.json(configuration)
      },
    })
    analytics.accept([completed()])
    await analytics.flush()
    await analytics.close()
    assert.equal(calls.filter(url => url.includes("/i/v0/e/")).length, 0)
  }
})

test("native PostHog main switch prevents binding lookup and delivery", async () => {
  let calls = 0
  const analytics = createPostHogNativeAnalytics({
    tenantId: "tenant-a",
    accessToken: "session-token",
    enabled: false,
    request: async () => { calls += 1; throw new Error("unexpected request") },
  })
  analytics.accept([completed()])
  await analytics.flush()
  await analytics.close()
  assert.equal(calls, 0)
})

test("native PostHog capture identifiers stay stable across retries and use conversation fallback traces", () => {
  const event = completed({ eventTimestamp: 1_759_449_600, traceId: undefined, spanId: undefined })
  const first = nativePostHogCaptures({ event, tenantId: "tenant-a" })[0]!
  const second = nativePostHogCaptures({ event, tenantId: "tenant-a" })[0]!
  assert.equal(first.uuid, second.uuid)
  assert.equal(first.uuid, stableNativePostHogUuid({ tenantId: "tenant-a", conversationId: "conversation-a", eventTimestamp: String(event.eventTimestamp), event: "$ai_generation" }))
  assert.match(String(first.properties.$ai_trace_id), /^[0-9a-f]{32}$/)
})

test("native PostHog trace groups the next generation and tool span by prompt timestamp", () => {
  const traces = new Map<string, string>()
  const prompt: NativeTelemetryAcceptedLog = {
    eventName: "codex.sse_event",
    eventKind: "user_prompt",
    userPromptTimestamp: "2026-10-03T00:00:00.500Z",
    eventTimestamp: "2026-10-03T00:00:00.500Z",
    conversationId: "conversation-a",
  }
  assert.deepEqual(nativePostHogCaptures({ event: prompt, tenantId: "tenant-a", traces }), [])
  const generation = nativePostHogCaptures({ event: completed({ eventTimestamp: "2026-10-03T00:00:01.000Z" }), tenantId: "tenant-a", traces })[0]!
  const tool = nativePostHogCaptures({
    event: {
      eventName: "codex.tool_result",
      eventTimestamp: "2026-10-03T00:00:01.100Z",
      conversationId: "conversation-a",
      callId: "call-a",
      toolName: "search",
    },
    tenantId: "tenant-a",
    traces,
  })[0]!
  assert.equal(generation.properties.$ai_trace_id, tool.properties.$ai_trace_id)
})

test("native PostHog close reports a permanently pending delivery without blocking the runtime", async () => {
  const reports: any[] = []
  const analytics = createPostHogNativeAnalytics({
    tenantId: "tenant-a",
    accessToken: "session-token",
    platformOrigin: "https://platform.example",
    timeoutMillis: 10,
    retryBaseMillis: 1,
    retryMaxMillis: 1,
    report: event => reports.push(event),
    request: async input => String(input).includes("browser-configuration")
      ? Response.json({ enabled: true, host: "https://us.i.posthog.com", project_id: 9, project_token: "phc_native" })
      : new Response("", { status: 503 }),
  })
  analytics.accept([completed()])
  await new Promise(resolve => setTimeout(resolve, 1))
  const started = Date.now()
  await analytics.close()
  assert.ok(Date.now() - started < 1000)
  assert.ok(reports.some(event => event.event === "posthog.native.queue_remaining"))
})
