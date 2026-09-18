import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { registerHttpObservability } from "./fastify-observability"

test("HTTP observations retain request and response evidence without exporting credentials", async () => {
  const originalFetch = globalThis.fetch
  const originalOrigin = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector.test"
  const exports: any[] = []
  globalThis.fetch = (async (_input, init) => { exports.push(JSON.parse(String(init?.body))); return new Response("{}") }) as typeof fetch
  const app = Fastify()
  registerHttpObservability(app, "test-http")
  app.post("/echo/:id", async (request, reply) => reply.code(201).send(request.body))
  try {
    const response = await app.inject({ method: "POST", url: "/echo/123?purpose=verify", headers: { authorization: "Bearer credential-only-value", traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-00` }, payload: { message: "payload-evidence", password: "credential-only-value" } })
    assert.equal(response.statusCode, 201)
    await app.close()
    const span = exports.find(value => value.resourceSpans).resourceSpans[0].scopeSpans[0].spans[0]
    assert.equal(span.traceId, "a".repeat(32))
    assert.equal(span.parentSpanId, "b".repeat(16))
    const attributes = Object.fromEntries(span.attributes.map((value: any) => [value.key, value.value.stringValue ?? value.value.intValue]))
    assert.equal(attributes["http.response.status_code"], "201")
    assert.ok(String(attributes["genio.request"]).includes("payload-evidence"))
    assert.ok(String(attributes["genio.response"]).includes("payload-evidence"))
    assert.ok(!JSON.stringify(exports).includes("credential-only-value"))
    assert.ok(exports.some(value => value.resourceLogs))
    assert.ok(exports.some(value => value.resourceMetrics))
  } finally {
    await app.close()
    globalThis.fetch = originalFetch
    if (originalOrigin === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalOrigin
  }
})
