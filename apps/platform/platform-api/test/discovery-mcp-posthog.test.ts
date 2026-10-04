import assert from "node:assert/strict"
import test from "node:test"

import {
  createDiscoveryMcpPostHogSink,
  type DiscoveryMcpPostHogEvent,
} from "../src/capabilities/discovery-mcp/posthog"
import { createInMemoryPostHogIntegrationStore } from "../src/capabilities/posthog-integration/memory"

type Capture = {
  event: string
  uuid: string
  properties: Record<string, unknown>
}

const completion: DiscoveryMcpPostHogEvent = {
  tenantId: "tenant-secret",
  correlationId: "request-secret",
  completionId: "completion-1",
  tool: "search_resources",
  resultCount: 3,
  latencyMillis: 42,
  statusCode: 200,
  outcome: "COMPLETED",
  errorCode: null,
  occurredAt: 1_700_000_000,
}

async function configuredSink(captured: Capture[]) {
  const integrations = createInMemoryPostHogIntegrationStore()
  await integrations.update({
    tenantId: completion.tenantId,
    configuredBySubjectId: "admin",
    value: {
      enabled: true,
      host: "https://us.i.posthog.com",
      project_id: 7,
      project_token: "phc_discovery",
    },
  })
  const request = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { event: string; uuid: string; properties: Record<string, unknown> }
    captured.push(body)
    return new Response("", { status: 200 })
  }) as typeof fetch
  return createDiscoveryMcpPostHogSink({ integrations, request })
}

test("Discovery PostHog emits privacy-preserving tool call and span once", async () => {
  const captured: Capture[] = []
  const sink = await configuredSink(captured)
  const unexpectedPayload = {
    ...completion,
    arguments: { query: "query-string", resource_id: "resource-1" },
    email: "actor-secret@example.test",
    output: "private-result",
  }
  await sink.capture(unexpectedPayload)
  await sink.capture(completion)

  assert.equal(captured.length, 2)
  assert.deepEqual(new Set(captured.map((entry) => entry.event)), new Set(["$mcp_tool_call", "$ai_span"]))
  assert.equal(captured[0]?.properties.$mcp_server_name, "genio-one-discovery")
  assert.equal(captured[0]?.properties.server, "genio-one-discovery")
  assert.equal(captured[0]?.properties.source, "platform_discovery")
  assert.equal(captured[0]?.properties.$mcp_tool_name, "search_resources")
  assert.equal(captured[0]?.properties.$mcp_is_error, false)
  assert.equal(captured[0]?.properties.result_count, 3)
  assert.equal(captured[0]?.properties.$mcp_duration_ms, 42)
  assert.match(String(captured[0]?.properties.$ai_trace_id), /^[0-9a-f]{32}$/)
  assert.match(String(captured[0]?.properties.tenant_hash), /^[0-9a-f]{32}$/)
  assert.match(String(captured[0]?.properties.correlation_hash), /^[0-9a-f]{32}$/)
  assert.equal(JSON.stringify(captured).includes(completion.tenantId), false)
  assert.equal(JSON.stringify(captured).includes(completion.correlationId), false)
  assert.doesNotMatch(JSON.stringify(captured), /query-string|resource-1|person-alice|subject_id|actor-secret|private-result|客服/u)
  assert.equal(new Set(captured.map((entry) => entry.uuid)).size, 2)
  for (const entry of captured) assert.match(entry.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  await sink.capture({ ...completion, completionId: "completion-2" })
  assert.equal(captured.length, 4)
  assert.equal(new Set(captured.map((entry) => entry.uuid)).size, 4)
  assert.equal(new Set(captured.map((entry) => entry.properties.$ai_span_id)).size, 2)
})

test("Discovery semantic and catalog failures emit error metadata without content", async () => {
  const captured: Capture[] = []
  const sink = await configuredSink(captured)
  await sink.capture({
    ...completion,
    completionId: "completion-error",
    tool: "get_resource",
    resultCount: 0,
    outcome: "FAILED",
    errorCode: "RESOURCE_NOT_FOUND_OR_NOT_VISIBLE",
  })

  assert.equal(captured.length, 2)
  for (const event of captured) {
    assert.equal(event.properties.$mcp_is_error, true)
    assert.equal(event.properties.$ai_is_error, true)
    assert.equal(event.properties.error_code, "RESOURCE_NOT_FOUND_OR_NOT_VISIBLE")
    assert.equal(event.properties.result_count, 0)
    assert.equal(JSON.stringify(event).includes("tenant-secret"), false)
    assert.equal(JSON.stringify(event).includes("request-secret"), false)
  }
  assert.equal(captured.find((event) => event.event === "$ai_span")?.properties.$ai_span_name, "get_resource")
})

test("Discovery PostHog skips disabled bindings and bounds delivery", async () => {
  const integrations = createInMemoryPostHogIntegrationStore()
  let requests = 0
  const sink = createDiscoveryMcpPostHogSink({
    integrations,
    request: (async (_input, init) => {
      requests++
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
      })
      return new Response("", { status: 200 })
    }) as typeof fetch,
    timeoutMillis: 5,
  })
  await sink.capture(completion)
  assert.equal(requests, 0)

  await integrations.update({
    tenantId: completion.tenantId,
    configuredBySubjectId: "admin",
    value: {
      enabled: true,
      host: "https://us.i.posthog.com",
      project_id: 7,
      project_token: "phc_discovery",
    },
  })
  await assert.rejects(sink.capture(completion), /TimeoutError|aborted|signal/u)
  assert.equal(requests, 2)
})
