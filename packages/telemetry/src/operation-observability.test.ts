import assert from "node:assert/strict"
import test from "node:test"
import { instrumentModuleGraph, observationContext, observeOperation, observedFetch } from "./operation-observability"
import { flushOtel } from "./otlp-observability"

test("operation observation preserves callable client fields and correlates module spans", async () => {
  const originalFetch = globalThis.fetch
  const originalOrigin = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  const exports: any[] = []
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector.test"
  globalThis.fetch = (async (_input, init) => { exports.push(JSON.parse(String(init?.body))); return new Response("{}") }) as typeof fetch
  try {
    class Repository {
      client = Object.assign(() => 1, { unsafe: () => 42, begin: () => 3 })
      query() { return this.client.unsafe() }
    }
    const repository = new Repository()
    const modules = { repository, policy: { decide: () => ({ decision: "DENY", password: "must-not-export" }) } }
    instrumentModuleGraph(modules, "platform")
    await observationContext.run({ traceId: "a".repeat(32), spanId: "b".repeat(16), correlationId: "correlation", tenantId: "qa" }, async () => {
      assert.equal(repository.query(), 42)
      assert.equal(repository.client.begin(), 3)
      assert.equal(modules.policy.decide().decision, "DENY")
      await assert.rejects(observeOperation("platform", "failed", {}, async () => { throw new Error("failure") }))
    })
    await flushOtel()
    const spans = exports.flatMap(value => value.resourceSpans ?? []).flatMap(value => value.scopeSpans).flatMap(value => value.spans)
    assert.equal(spans.length, 3)
    assert.ok(spans.every(value => value.traceId === "a".repeat(32) && value.parentSpanId === "b".repeat(16)))
    assert.equal(spans.find(value => value.name === "failed").status.code, 2)
    // Raw evidence: the SDK no longer redacts; the analytics collector does it once, server side.
    assert.ok(JSON.stringify(exports).includes("must-not-export"))
  } finally {
    globalThis.fetch = originalFetch
    if (originalOrigin === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalOrigin
  }
})

test("observed HTTP preserves the request body and explicit domain correlation", async () => {
  const originalFetch = globalThis.fetch
  const originalOrigin = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector.test"
  let received: { body: string; correlation: string | null; traceparent: string | null } | undefined
  const exports: any[] = []
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    if (request.url.startsWith("http://provider.test")) {
      received = { body: await request.text(), correlation: request.headers.get("x-genio-correlation-id"), traceparent: request.headers.get("traceparent") }
      return new Response("provider-result", { status: 201, headers: { "content-type": "text/event-stream" } })
    }
    exports.push(JSON.parse(await request.text()))
    return new Response("{}")
  }) as typeof fetch
  try {
    const response = await observationContext.run({ traceId: "a".repeat(32), spanId: "b".repeat(16), correlationId: "parent", tenantId: "qa" }, () => observedFetch("relay", "http://provider.test/v1/chat", { method: "POST", headers: { "x-genio-correlation-id": "domain-correlation" }, body: "request-body" }))
    assert.equal(response.status, 201)
    assert.equal(await response.text(), "provider-result")
    await flushOtel()
    assert.equal(received?.body, "request-body")
    // The caller still gets the whole stream; the body it read is recorded as response-body logs.
    const bodyLogs = exports.flatMap(value => value.resourceLogs ?? []).flatMap(value => value.scopeLogs).flatMap(value => value.logRecords).filter(value => value.body.stringValue === "http.client.response.body")
    const attributes = Object.fromEntries(bodyLogs[0].attributes.map((value: any) => [value.key, value.value.stringValue]))
    assert.equal(bodyLogs.length, 1)
    assert.equal(attributes["output.value"], "provider-result")
    assert.equal(attributes["output.chunk.final"], "true")
    assert.equal(attributes["output.mime_type"], "text/event-stream")
    assert.equal(received?.correlation, "domain-correlation")
    assert.ok(received?.traceparent?.startsWith(`00-${"a".repeat(32)}-`))
  } finally {
    globalThis.fetch = originalFetch
    if (originalOrigin === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalOrigin
  }
})

test("telemetry query references retain identifiers and digest without recursively copying payloads", async () => {
  const { observationReference } = await import("./operation-observability")
  const evidence = JSON.parse(observationReference({ records: [{ record_id: "record-1", trace_id: "trace-1", attributes: { nested_telemetry: "payload-that-must-not-repeat" } }] }))
  assert.equal(evidence.availability, "EXISTING_TELEMETRY_REFERENCE")
  assert.equal(evidence.record_count, 1)
  assert.equal(evidence.references[0].record_id, "record-1")
  assert.match(evidence.sha256, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(evidence).includes("payload-that-must-not-repeat"), false)
})

// Streaming relays (LLM SSE, MCP) must reach the caller byte-for-byte, while the full body is
// still recorded without truncation, in bounded chunks rather than one unbounded buffer.
test("observed HTTP streams large responses through unchanged and records every chunk", async () => {
  const originalFetch = globalThis.fetch
  const originalOrigin = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector.test"
  const exports: any[] = []
  const part = Buffer.alloc(700_000, "a")
  const expected = Buffer.concat([part, Buffer.alloc(700_000, "b"), Buffer.alloc(700_000, "c")])
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    if (request.url.startsWith("http://provider.test")) {
      let sent = 0
      return new Response(new ReadableStream({ pull(controller) {
        if (sent >= expected.length) return controller.close()
        controller.enqueue(expected.subarray(sent, sent + part.length))
        sent += part.length
      } }))
    }
    exports.push(JSON.parse(await request.text()))
    return new Response("{}")
  }) as typeof fetch
  try {
    const response = await observationContext.run({ traceId: "a".repeat(32), spanId: "b".repeat(16), correlationId: "stream", tenantId: "qa" }, () => observedFetch("relay", "http://provider.test/v1/stream"))
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected)
    await flushOtel()
    const chunks = exports.flatMap(value => value.resourceLogs ?? []).flatMap(value => value.scopeLogs).flatMap(value => value.logRecords)
      .filter(value => value.body.stringValue === "http.client.response.body")
      .map(value => Object.fromEntries(value.attributes.map((attribute: any) => [attribute.key, attribute.value.stringValue])))
      .sort((left, right) => Number(left["output.chunk.index"]) - Number(right["output.chunk.index"]))
    // Records are cut at the 1 MiB boundary regardless of how the upstream chunks the stream.
    assert.equal(chunks.length, 3)
    assert.deepEqual(chunks.map(chunk => chunk["output.chunk.final"]), ["false", "false", "true"])
    assert.deepEqual(chunks.map(chunk => Buffer.byteLength(chunk["output.value"])), [1_048_576, 1_048_576, expected.length - 2_097_152])
    assert.equal(chunks.map(chunk => chunk["output.value"]).join(""), expected.toString("utf8"))
  } finally {
    globalThis.fetch = originalFetch
    if (originalOrigin === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalOrigin
  }
})

// /mcp/<token> carries a signed connector capability: it must never become an http.route,
// span name or metric attribute (credential exposure and unbounded cardinality).
test("incoming connector MCP paths are recorded without their capability token", async () => {
  const { observeIncomingRequest } = await import("./operation-observability")
  const originalFetch = globalThis.fetch
  const originalOrigin = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector.test"
  const exports: any[] = []
  globalThis.fetch = (async (input, init) => { exports.push(JSON.parse(await new Request(input, init).text())); return new Response("{}") }) as typeof fetch
  try {
    await observeIncomingRequest("connector", new Request("http://connector.test/mcp/eyJjb25maWciOnt9.signed-capability"), async () => new Response(null, { status: 403 }))
    await flushOtel()
    const serialized = JSON.stringify(exports)
    assert.equal(serialized.includes("signed-capability"), false)
    assert.ok(serialized.includes("/mcp/:configuration"))
  } finally {
    globalThis.fetch = originalFetch
    if (originalOrigin === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalOrigin
  }
})

// A 1 MiB record boundary can fall inside a multibyte character; the recorded text must still be
// exact UTF-8 (not a lossy or base64 fallback that would hide content from collector redaction).
test("observed HTTP keeps multibyte characters intact across record boundaries", async () => {
  const originalFetch = globalThis.fetch
  const originalOrigin = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector.test"
  const exports: any[] = []
  const text = `${"a".repeat(1_048_575)}é憑證tail`
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    if (request.url.startsWith("http://provider.test")) return new Response(text)
    exports.push(JSON.parse(await request.text()))
    return new Response("{}")
  }) as typeof fetch
  try {
    const response = await observationContext.run({ traceId: "a".repeat(32), spanId: "b".repeat(16), correlationId: "utf8", tenantId: "qa" }, () => observedFetch("relay", "http://provider.test/v1/text"))
    assert.equal(await response.text(), text)
    await flushOtel()
    const chunks = exports.flatMap(value => value.resourceLogs ?? []).flatMap(value => value.scopeLogs).flatMap(value => value.logRecords)
      .filter(value => value.body.stringValue === "http.client.response.body")
      .map(value => Object.fromEntries(value.attributes.map((attribute: any) => [attribute.key, attribute.value.stringValue])))
      .sort((left, right) => Number(left["output.chunk.index"]) - Number(right["output.chunk.index"]))
    assert.equal(chunks.length, 2)
    assert.deepEqual(chunks.map(chunk => chunk["output.encoding"]), ["utf8", "utf8"])
    assert.equal(chunks.map(chunk => chunk["output.value"]).join(""), text)
  } finally {
    globalThis.fetch = originalFetch
    if (originalOrigin === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalOrigin
  }
})

// The collector redacts each record independently: a record ending in `"access_to` with the
// next starting `ken":"…"` would let the secret through, so records end on a safe separator.
test("observed HTTP never splits a credential pair across response-body records", async () => {
  const originalFetch = globalThis.fetch
  const originalOrigin = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector.test"
  const exports: any[] = []
  const pair = '"access_token":"replayable-secret"'
  const prefix = `{"items":["${"x".repeat(1_048_576 - 20)}",`
  const text = `${prefix}${pair},"done":true}`
  assert.ok(prefix.length < 1_048_576 && prefix.length + pair.length > 1_048_576)
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    if (request.url.startsWith("http://provider.test")) return new Response(text)
    exports.push(JSON.parse(await request.text()))
    return new Response("{}")
  }) as typeof fetch
  try {
    const response = await observationContext.run({ traceId: "a".repeat(32), spanId: "b".repeat(16), correlationId: "cut", tenantId: "qa" }, () => observedFetch("relay", "http://provider.test/v1/json"))
    assert.equal(await response.text(), text)
    await flushOtel()
    const values = exports.flatMap(value => value.resourceLogs ?? []).flatMap(value => value.scopeLogs).flatMap(value => value.logRecords)
      .filter(value => value.body.stringValue === "http.client.response.body")
      .map(value => Object.fromEntries(value.attributes.map((attribute: any) => [attribute.key, attribute.value.stringValue])))
      .sort((left, right) => Number(left["output.chunk.index"]) - Number(right["output.chunk.index"]))
      .map(chunk => chunk["output.value"] as string)
    assert.equal(values.join(""), text)
    assert.ok(values.every(value => Buffer.byteLength(value) <= 1_048_576))
    assert.equal(values.filter(value => value.includes(pair)).length, 1)
  } finally {
    globalThis.fetch = originalFetch
    if (originalOrigin === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalOrigin
  }
})

// Accounting needs the whole body: a fast 16 MiB response must not overflow the outbox's 8 MiB
// pending-memory bound and silently lose records, so body persistence backpressures the stream.
test("observed HTTP records every part of a large, fast response", async () => {
  const originalFetch = globalThis.fetch
  const originalOrigin = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector.test"
  const exports: any[] = []
  const part = Buffer.alloc(1_048_576, "z")
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    if (request.url.startsWith("http://provider.test")) {
      let sent = 0
      return new Response(new ReadableStream({ pull(controller) { if (sent++ === 16) controller.close(); else controller.enqueue(part) } }))
    }
    exports.push(JSON.parse(await request.text()))
    return new Response("{}")
  }) as typeof fetch
  try {
    const response = await observationContext.run({ traceId: "a".repeat(32), spanId: "b".repeat(16), correlationId: "large", tenantId: "qa" }, () => observedFetch("relay", "http://provider.test/v1/large"))
    assert.equal((await response.arrayBuffer()).byteLength, 16 * 1_048_576)
    await flushOtel()
    const recorded = exports.flatMap(value => value.resourceLogs ?? []).flatMap(value => value.scopeLogs).flatMap(value => value.logRecords)
      .filter(value => value.body.stringValue === "http.client.response.body")
      .map(value => Object.fromEntries(value.attributes.map((attribute: any) => [attribute.key, attribute.value.stringValue])))
    assert.equal(recorded.reduce((total, chunk) => total + Buffer.byteLength(chunk["output.value"]), 0), 16 * 1_048_576)
    assert.ok(recorded.some(chunk => chunk["output.chunk.final"] === "true"))
  } finally {
    globalThis.fetch = originalFetch
    if (originalOrigin === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalOrigin
  }
})

async function bodyRecords(respond: () => Response, consume: (response: Response) => Promise<unknown>) {
  const originalFetch = globalThis.fetch
  const originalOrigin = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector.test"
  const exports: any[] = []
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    if (request.url.startsWith("http://provider.test")) return respond()
    exports.push(JSON.parse(await request.text()))
    return new Response("{}")
  }) as typeof fetch
  try {
    const response = await observationContext.run({ traceId: "a".repeat(32), spanId: "b".repeat(16), correlationId: "tail", tenantId: "qa" }, () => observedFetch("relay", "http://provider.test/v1/body"))
    await consume(response)
    await flushOtel()
    return exports.flatMap(value => value.resourceLogs ?? []).flatMap(value => value.scopeLogs).flatMap(value => value.logRecords)
      .filter(value => value.body.stringValue === "http.client.response.body")
      .map(value => Object.fromEntries(value.attributes.map((attribute: any) => [attribute.key, attribute.value.stringValue])))
      .sort((left, right) => Number(left["output.chunk.index"]) - Number(right["output.chunk.index"]))
  } finally {
    globalThis.fetch = originalFetch
    if (originalOrigin === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalOrigin
  }
}

// A provider that fails mid-stream is exactly when the body matters for diagnosis/accounting:
// bytes already delivered to the caller must be persisted, marked as an errored stream.
test("observed HTTP persists the delivered tail when the upstream stream errors", async () => {
  let pulls = 0
  const records = await bodyRecords(() => new Response(new ReadableStream({ pull(controller) {
    if (pulls++ === 0) controller.enqueue(new TextEncoder().encode("partial provider output"))
    else controller.error(new Error("upstream reset"))
  } })), async response => {
    const reader = response.body!.getReader()
    assert.equal(new TextDecoder().decode((await reader.read()).value), "partial provider output")
    await assert.rejects(reader.read())
  })
  assert.equal(records.length, 1)
  assert.equal(records[0]!["output.value"], "partial provider output")
  assert.equal(records[0]!["output.stream.outcome"], "ERRORED")
})

test("observed HTTP persists the tail when the caller cancels the stream", async () => {
  const records = await bodyRecords(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("first part")) } })), async response => {
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel()
  })
  assert.equal(records.at(-1)!["output.value"], "first part")
  assert.equal(records.at(-1)!["output.stream.outcome"], "CANCELLED")
})

// An "&" can sit inside a JSON string value; when a JSON separator is available it wins, so a
// value such as "first&secret" is never split away from its key.
test("observed HTTP prefers a JSON separator over an ampersand inside a value", async () => {
  const pair = '"password":"first&replayable-secret"'
  const prefix = `{"pad":"${"x".repeat(1_048_576 - 40)}",`
  const text = `${prefix}${pair},"done":true}`
  assert.ok(prefix.length < 1_048_576 && prefix.length + pair.length > 1_048_576)
  const records = await bodyRecords(() => new Response(text), response => response.text())
  const values = records.map(record => record["output.value"] as string)
  assert.equal(values.join(""), text)
  assert.equal(values.filter(value => value.includes(pair)).length, 1)
  assert.equal(records.at(-1)!["output.stream.outcome"], "COMPLETED")
})
