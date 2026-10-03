import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { registerHttpObservability } from "./fastify-observability"

test("HTTP observations keep safe metadata and omit HTTP evidence", async () => {
  const originalFetch = globalThis.fetch
  const originalOrigin = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector.test"
  const exports: any[] = []
  globalThis.fetch = (async (_input, init) => { exports.push(JSON.parse(String(init?.body))); return new Response("{}") }) as typeof fetch
  const app = Fastify()
  registerHttpObservability(app, "test-http")
  app.post("/echo/:id", async (request, reply) => {
    Object.assign(request, { principal: { tenant_id: "trusted-tenant", subject_id: "verified-subject" } })
    return reply.code(201).send(request.body)
  })
  app.get("/evidence", { config: { sensitiveResponse: true } }, async () => ({ turns: [{ text: "evidence-turn-secret" }] }))
  app.get("/traces", async () => ({ records: [{ trace_id: "trace-reference-secret", span_id: "span-reference-secret", record_id: "record-reference-secret" }] }))
  app.get("/logs", async () => ({ records: [{ body: "log-reference-secret", token: "log-token-secret" }] }))
  try {
    const response = await app.inject({ method: "POST", url: "/echo/path-secret-value?purpose=verify&company_secret_alias=query-secret-value", headers: { authorization: "Bearer credential-only-value", cookie: "session=cookie-only-value", "proxy-authorization": "Basic proxy-only-value", "x-api-key": "api-key-only-value", "x-session-token": "session-token-only-value", "x-company-secret-alias": "unknown-header-secret-value", "x-genio-correlation-id": "correlation-safe-value", traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-00` }, payload: { message: "payload-evidence", password: "credential-only-value", nested: { unknown_secret_alias: "nested-secret-value" } } })
    assert.equal(response.statusCode, 201)
    const evidence = await app.inject({ method: "GET", url: "/evidence" })
    assert.equal(evidence.statusCode, 200)
    assert.equal((await app.inject({ method: "GET", url: "/traces" })).statusCode, 200)
    assert.equal((await app.inject({ method: "GET", url: "/logs" })).statusCode, 200)
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
    assert.equal(attributes["genio.correlation.id"], "correlation-safe-value")
    assert.equal(attributes["genio.subject.id"], "verified-subject")
    assert.equal(attributes["genio.request"], JSON.stringify({ availability: "OMITTED_HTTP_REQUEST" }))
    assert.equal(attributes["genio.response"], JSON.stringify({ availability: "OMITTED_HTTP_RESPONSE" }))
    const sensitiveSpan = spans.find((value: any) => value.name === "GET /evidence")
    assert.ok(sensitiveSpan)
    const sensitiveAttributes = Object.fromEntries(sensitiveSpan.attributes.map((value: any) => [value.key, value.value.stringValue ?? value.value.intValue]))
    assert.equal(sensitiveAttributes["genio.response"], JSON.stringify({ availability: "OMITTED_SENSITIVE_RESPONSE" }))
    const logs = exports.flatMap(value => value.resourceLogs?.flatMap((resourceLog: any) => resourceLog.scopeLogs.flatMap((scopeLog: any) => scopeLog.logRecords)) ?? [])
    const sensitiveLog = logs.find((value: any) => Object.fromEntries(value.attributes.map((attribute: any) => [attribute.key, attribute.value.stringValue ?? attribute.value.intValue]))["http.route"] === "/evidence")
    assert.ok(sensitiveLog)
    const sensitiveLogAttributes = Object.fromEntries(sensitiveLog.attributes.map((value: any) => [value.key, value.value.stringValue ?? value.value.intValue]))
    assert.equal(sensitiveLogAttributes["genio.response"], JSON.stringify({ availability: "OMITTED_SENSITIVE_RESPONSE" }))
    for (const route of ["/traces", "/logs"]) {
      const routeSpan = spans.find((value: any) => value.name === `GET ${route}`)
      assert.ok(routeSpan)
      const routeAttributes = Object.fromEntries(routeSpan.attributes.map((value: any) => [value.key, value.value.stringValue ?? value.value.intValue]))
      assert.equal(routeAttributes["genio.response"], JSON.stringify({ availability: "OMITTED_HTTP_RESPONSE" }))
    }
    const serializedExports = JSON.stringify(exports)
    for (const secret of ["credential-only-value", "cookie-only-value", "proxy-only-value", "api-key-only-value", "session-token-only-value", "unknown-header-secret-value", "query-secret-value", "path-secret-value", "payload-evidence", "nested-secret-value", "evidence-turn-secret", "trace-reference-secret", "span-reference-secret", "record-reference-secret", "log-reference-secret", "log-token-secret"]) {
      assert.equal(serializedExports.includes(secret), false)
    }
    assert.ok(exports.some(value => value.resourceLogs))
    assert.ok(exports.some(value => value.resourceMetrics))
  } finally {
    await app.close()
    globalThis.fetch = originalFetch
    if (originalOrigin === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalOrigin
  }
})

test("sensitive HTTP routes omit request query, body and success or failure response payloads", async () => {
  const originalFetch = globalThis.fetch
  const originalOrigin = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://memory-http-collector.test"
  const exports: any[] = []
  globalThis.fetch = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    exports.push(JSON.parse(String(init?.body)))
    return new Response("{}")
  }, { preconnect: originalFetch.preconnect })
  const app = Fastify()
  registerHttpObservability(app, "memory-http-test")
  app.route({
    method: ["GET", "POST"],
    url: "/memory",
    config: { sensitiveRequest: true, sensitiveResponse: true },
    handler: async (request) => {
      if ((request.query as { fail?: string }).fail) throw new Error("memory-error-secret", { cause: { content: "memory-cause-secret" } })
      return request.body ?? { content: "memory-response-secret" }
    },
  })
  app.post("/regular", async (request) => request.body)
  try {
    const headers = { "x-genio-correlation-id": "memory-http-correlation" }
    const listed = await app.inject({ method: "GET", url: "/memory?query=memory-query-secret", headers })
    assert.equal(listed.statusCode, 200)
    assert.equal(listed.json().content, "memory-response-secret")
    const written = await app.inject({ method: "POST", url: "/memory?query=memory-query-secret", headers, payload: { content: "memory-body-secret" } })
    assert.equal(written.statusCode, 200)
    assert.equal(written.json().content, "memory-body-secret")
    const failed = await app.inject({ method: "POST", url: "/memory?fail=memory-query-secret", headers, payload: { content: "memory-body-secret" } })
    assert.equal(failed.statusCode, 500)
    assert.equal(failed.json().message, "memory-error-secret")
    const regular = await app.inject({ method: "POST", url: "/regular?query=regular-query-evidence", payload: { content: "regular-body-evidence" } })
    assert.equal(regular.statusCode, 200)
    await app.close()
    const serialized = JSON.stringify(exports)
    for (const value of ["memory-query-secret", "memory-body-secret", "memory-response-secret", "memory-error-secret", "memory-cause-secret", "regular-query-evidence", "regular-body-evidence"]) assert.equal(serialized.includes(value), false)
    const spans = exports.flatMap(value => value.resourceSpans ?? []).flatMap(value => value.scopeSpans).flatMap(value => value.spans)
    const regularSpan = spans.find(value => value.name === "POST /regular")
    assert.ok(regularSpan)
    const regularAttributes = Object.fromEntries(regularSpan.attributes.map((value: any) => [value.key, value.value.stringValue ?? value.value.intValue]))
    assert.equal(regularAttributes["genio.request"], JSON.stringify({ availability: "OMITTED_HTTP_REQUEST" }))
    assert.equal(regularAttributes["genio.response"], JSON.stringify({ availability: "OMITTED_HTTP_RESPONSE" }))
    assert.equal(regularAttributes["http.response.status_code"], "200")
    const memorySpans = spans.filter(value => value.name.endsWith(" /memory"))
    assert.equal(memorySpans.length, 3)
    for (const span of memorySpans) {
      const attributes = Object.fromEntries(span.attributes.map((value: any) => [value.key, value.value.stringValue ?? value.value.intValue]))
      assert.equal(attributes["genio.request"], JSON.stringify({ availability: "OMITTED_SENSITIVE_REQUEST" }))
      assert.equal(attributes["genio.response"], JSON.stringify({ availability: "OMITTED_SENSITIVE_RESPONSE" }))
      assert.equal(attributes["genio.correlation.id"], "memory-http-correlation")
      assert.ok(["200", "500"].includes(attributes["http.response.status_code"]))
    }
    assert.equal(memorySpans.filter(value => value.status.code === 2).length, 1)
    assert.ok(exports.some(value => value.resourceLogs))
    assert.ok(exports.some(value => value.resourceMetrics))
  } finally {
    await app.close()
    globalThis.fetch = originalFetch
    if (originalOrigin === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalOrigin
  }
})
