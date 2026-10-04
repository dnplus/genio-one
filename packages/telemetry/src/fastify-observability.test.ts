import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { httpRequestCorrelationId, recordHttpMcpToolCompletion, registerHttpObservability } from "./fastify-observability"
import { observationContext } from "./operation-observability"

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

test("structured MCP completion keeps request correlation and records semantic failure without payload", async () => {
  const originalFetch = globalThis.fetch
  const originalOrigin = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://structured-mcp-collector.test"
  const exports: any[] = []
  globalThis.fetch = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    exports.push(JSON.parse(String(init?.body)))
    return new Response("{}")
  }, { preconnect: originalFetch.preconnect })
  const app = Fastify({ genReqId: () => "server-request-id" })
  registerHttpObservability(app, "test-http-mcp")
  app.post("/mcp", async (request) => {
    const correlationId = httpRequestCorrelationId(request)
    assert.equal(correlationId, "canonical-correlation")
    assert.equal(observationContext.getStore()?.correlationId, correlationId)
    request.headers["x-genio-correlation-id"] = "changed-after-request-start"
    assert.equal(httpRequestCorrelationId(request), correlationId)
    const failed = (request.body as { failed?: boolean }).failed === true
    const completion = {
      serverName: "trusted-mcp",
      toolName: "trusted-tool",
      statusCode: 200,
      durationMillis: 12,
      outcome: failed ? "FAILED" as const : "COMPLETED" as const,
      errorCode: failed ? "TRUSTED_TOOL_FAILURE" : null,
      arguments: { content: "completion-argument-secret" },
      result: { content: "completion-result-secret" },
    }
    recordHttpMcpToolCompletion(request, completion)
    return { isError: failed, content: "response-payload-secret" }
  })
  app.get("/uncompleted", async (_request, reply) => reply.code(403).send({ content: "uncompleted-payload-secret" }))
  try {
    const headers = { "x-genio-correlation-id": "canonical-correlation", "x-request-id": "legacy-request-id" }
    const completed = await app.inject({ method: "POST", url: "/mcp", headers, payload: { content: "request-payload-secret" } })
    const failed = await app.inject({ method: "POST", url: "/mcp", headers, payload: { failed: true, content: "request-payload-secret" } })
    assert.equal(completed.statusCode, 200)
    assert.equal(failed.statusCode, 200)
    assert.equal(failed.json().isError, true)
    assert.equal((await app.inject({ method: "GET", url: "/uncompleted" })).statusCode, 403)
    await app.close()
    const spans = exports.flatMap(value => value.resourceSpans ?? []).flatMap(value => value.scopeSpans).flatMap(value => value.spans)
    const toolSpans = spans.filter(value => value.name === "POST /mcp")
    assert.equal(toolSpans.length, 2)
    for (const span of toolSpans) {
      const attributes = Object.fromEntries(span.attributes.map((value: any) => [value.key, value.value.stringValue ?? value.value.intValue]))
      assert.equal(attributes["genio.correlation.id"], "canonical-correlation")
      assert.equal(attributes["http.response.status_code"], "200")
      assert.equal(attributes["mcp.server.name"], "trusted-mcp")
      assert.equal(attributes["mcp.method.name"], "tools/call")
      assert.equal(attributes["mcp.tool.name"], "trusted-tool")
      assert.equal(attributes["genio.mcp.status_code"], "200")
      assert.equal(attributes["genio.mcp.duration_ms"], "12")
      assert.equal(span.status.code, attributes["genio.outcome"] === "FAILED" ? 2 : 1)
      assert.equal(attributes["error.type"], attributes["genio.outcome"] === "FAILED" ? "TRUSTED_TOOL_FAILURE" : undefined)
    }
    const uncompleted = spans.find(value => value.name === "GET /uncompleted")
    assert.ok(uncompleted)
    assert.equal(uncompleted.status.code, 2)
    assert.equal(uncompleted.attributes.some((attribute: any) => attribute.key.startsWith("mcp.") || attribute.key === "genio.outcome"), false)
    const logs = exports.flatMap(value => value.resourceLogs ?? []).flatMap(value => value.scopeLogs).flatMap(value => value.logRecords)
    const toolLogs = logs.filter(value => value.attributes.some((attribute: any) => attribute.key === "mcp.tool.name"))
    assert.equal(toolLogs.length, 2)
    assert.equal(toolLogs.find(value => value.attributes.some((attribute: any) => attribute.key === "genio.outcome" && attribute.value.stringValue === "FAILED"))?.severityText, "ERROR")
    const metricPoints = exports.flatMap(value => value.resourceMetrics ?? []).flatMap(value => value.scopeMetrics).flatMap(value => value.metrics).flatMap(value => value.histogram.dataPoints)
    for (const point of metricPoints) assert.deepEqual(point.attributes.map((attribute: any) => attribute.key).sort(), ["http.request.method", "http.response.status_code", "http.route"])
    const serialized = JSON.stringify(exports)
    for (const secret of ["request-payload-secret", "response-payload-secret", "completion-argument-secret", "completion-result-secret", "uncompleted-payload-secret", "changed-after-request-start", "legacy-request-id"]) assert.equal(serialized.includes(secret), false)
  } finally {
    await app.close()
    globalThis.fetch = originalFetch
    if (originalOrigin === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalOrigin
  }
})
