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
    assert.ok(!JSON.stringify(exports).includes("must-not-export"))
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
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    if (request.url.startsWith("http://provider.test")) {
      received = { body: await request.text(), correlation: request.headers.get("x-genio-correlation-id"), traceparent: request.headers.get("traceparent") }
      return new Response("provider-result")
    }
    return new Response("{}")
  }) as typeof fetch
  try {
    const response = await observationContext.run({ traceId: "a".repeat(32), spanId: "b".repeat(16), correlationId: "parent", tenantId: "qa" }, () => observedFetch("relay", "http://provider.test/v1/chat", { method: "POST", headers: { "x-genio-correlation-id": "domain-correlation" }, body: "request-body" }))
    assert.equal(await response.text(), "provider-result")
    await flushOtel()
    assert.equal(received?.body, "request-body")
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
