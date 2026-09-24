import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { registerHttpObservability } from "./fastify-observability"

test("HTTP observations retain raw regular evidence and omit sensitive responses", async () => {
  const originalFetch = globalThis.fetch
  const originalOrigin = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector.test"
  const exports: any[] = []
  globalThis.fetch = (async (_input, init) => { exports.push(JSON.parse(String(init?.body))); return new Response("{}") }) as typeof fetch
  const app = Fastify()
  registerHttpObservability(app, "test-http")
  app.post("/echo/:id", async (request, reply) => reply.code(201).send(request.body))
  app.get("/evidence", { config: { sensitiveResponse: true } }, async () => ({ turns: [{ text: "evidence-turn-secret" }] }))
  try {
    const response = await app.inject({ method: "POST", url: "/echo/123?purpose=verify", headers: { authorization: "Bearer credential-only-value", traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-00` }, payload: { message: "payload-evidence", password: "credential-only-value" } })
    assert.equal(response.statusCode, 201)
    const evidence = await app.inject({ method: "GET", url: "/evidence" })
    assert.equal(evidence.statusCode, 200)
    const missing = await app.inject({ method: "GET", url: "/missing" })
    assert.equal(missing.statusCode, 404)
    await app.close()
    const spans = exports.flatMap(value => value.resourceSpans?.flatMap((resourceSpan: any) => resourceSpan.scopeSpans.flatMap((scopeSpan: any) => scopeSpan.spans)) ?? [])
    const span = spans.find((value: any) => value.name === "POST /echo/:id")
    assert.ok(span)
    assert.equal(span.traceId, "a".repeat(32))
    assert.equal(span.parentSpanId, "b".repeat(16))
    const attributes = Object.fromEntries(span.attributes.map((value: any) => [value.key, value.value.stringValue ?? value.value.intValue]))
    assert.equal(attributes["http.response.status_code"], "201")
    assert.ok(String(attributes["genio.request"]).includes("payload-evidence"))
    assert.ok(String(attributes["genio.response"]).includes("payload-evidence"))
    const sensitiveSpan = spans.find((value: any) => value.name === "GET /evidence")
    assert.ok(sensitiveSpan)
    const sensitiveAttributes = Object.fromEntries(sensitiveSpan.attributes.map((value: any) => [value.key, value.value.stringValue ?? value.value.intValue]))
    assert.equal(sensitiveAttributes["genio.response"], JSON.stringify({ availability: "OMITTED_SENSITIVE_RESPONSE" }))
    const logs = exports.flatMap(value => value.resourceLogs?.flatMap((resourceLog: any) => resourceLog.scopeLogs.flatMap((scopeLog: any) => scopeLog.logRecords)) ?? [])
    const sensitiveLog = logs.find((value: any) => Object.fromEntries(value.attributes.map((attribute: any) => [attribute.key, attribute.value.stringValue ?? attribute.value.intValue]))["http.route"] === "/evidence")
    assert.ok(sensitiveLog)
    const sensitiveLogAttributes = Object.fromEntries(sensitiveLog.attributes.map((value: any) => [value.key, value.value.stringValue ?? value.value.intValue]))
    assert.equal(sensitiveLogAttributes["genio.response"], JSON.stringify({ availability: "OMITTED_SENSITIVE_RESPONSE" }))
    // Request credentials are exported raw; redaction is the analytics collector's single pass.
    assert.ok(JSON.stringify(exports).includes("credential-only-value"))
    assert.ok(!JSON.stringify(exports).includes("evidence-turn-secret"))
    assert.ok(exports.some(value => value.resourceLogs))
    assert.ok(exports.some(value => value.resourceMetrics))
  } finally {
    await app.close()
    globalThis.fetch = originalFetch
    if (originalOrigin === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalOrigin
  }
})
