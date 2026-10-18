import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import Fastify from "fastify"
import { redactApplicationApiKeys } from "./application-api-key-redaction"
import { registerHttpObservability } from "./fastify-observability"
import { instrumentModuleGraph, observationEvidence, observedFetch } from "./operation-observability"
import { createOtlpGatewayDetailCapture } from "./otlp-detail-capture"
import { flushOtel } from "./otlp-observability"
import { OtlpOutbox } from "./otlp-outbox"

const key = `genio_app_${"AbCd0123456789_-".repeat(3).slice(0, 43)}`
const prefix = key.slice(0, 16)
const omitted = "[REDACTED_APPLICATION_API_KEY]"

test("application key masking recognizes complete keys and preserves short metadata", () => {
  assert.equal(redactApplicationApiKeys(`Bearer ${key}`), `Bearer ${omitted}`)
  assert.equal(redactApplicationApiKeys(`{"key":"${key}","prefix":"${prefix}"}`), `{"key":"${omitted}","prefix":"${prefix}"}`)
  for (const value of [prefix, `${key}a`, `a${key}`, "Bearer existing-oauth-token", "arbitrary-payload"]) {
    assert.equal(redactApplicationApiKeys(value), value)
  }
})

test("operation evidence hashes the masked application key representation", () => {
  const input = { token: key, nested: [{ authorization: `Bearer ${key}` }], prefix, note: "harmless", password: "existing-credential" }
  const evidence = JSON.parse(observationEvidence(input))
  assert.equal(input.token, key)
  assert.equal(evidence.value.token, omitted)
  assert.equal(evidence.value.nested[0].authorization, `Bearer ${omitted}`)
  assert.equal(evidence.value.prefix, prefix)
  assert.equal(evidence.value.password, "existing-credential")
  const captured = JSON.stringify(evidence.value)
  assert.equal(evidence.sha256, createHash("sha256").update(captured).digest("hex"))
  assert.equal(evidence.original_bytes, Buffer.byteLength(captured))
  assert.equal(JSON.stringify(evidence).includes(key), false)
})

test("gateway detail capture masks application keys before persistence and digest", async () => {
  let payload: any
  const capture = createOtlpGatewayDetailCapture({ endpoint: "http://collector.test/v1/traces", persist: async (_signal, body) => { payload = body; return true } })
  await capture.capture({
    tenantId: "test-tenant", correlationId: "application-key-detail",
    requestBody: Buffer.from(JSON.stringify({ api_key: key, prefix })), requestBodyTruncated: false, requestContentType: "application/json",
    responseBody: Buffer.from(`result ${key}`), responseBodyTruncated: false, responseContentType: "text/plain",
  })
  const attributes = Object.fromEntries(payload.resourceSpans[0].scopeSpans[0].spans[0].attributes.map((attribute: any) => [attribute.key, attribute.value.stringValue]))
  assert.equal(JSON.stringify(payload).includes(key), false)
  assert.equal(JSON.parse(attributes["input.value"]).prefix, prefix)
  for (const name of ["input", "output"]) {
    assert.equal(attributes[`${name}.sha256`], createHash("sha256").update(attributes[`${name}.value`]).digest("hex"))
  }
})

test("module application key telemetry is masked and HTTP evidence is omitted while client results retain the key", async () => {
  const originalFetch = globalThis.fetch
  const originalOrigin = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://application-key-collector.test"
  const exports: any[] = []
  globalThis.fetch = (async (_input, init) => { exports.push(JSON.parse(String(init?.body))); return Response.json({}) }) as typeof fetch
  const app = Fastify()
  registerHttpObservability(app, "application-key-test")
  const modules = { applicationKeys: { issue: (input: { token: string; headers?: Record<string, string | string[] | undefined> }) => ({ key: input.token, prefix, label: "test-application" }) } }
  instrumentModuleGraph(modules, "application-key-test")
  app.post("/application-key/echo", async request => modules.applicationKeys.issue({ ...(request.body as { token: string }), headers: request.headers }))
  app.post("/application-key/issue", { config: { sensitiveResponse: true } }, async () => modules.applicationKeys.issue({ token: key }))
  try {
    const response = await app.inject({ method: "POST", url: "/application-key/echo", headers: { authorization: `Bearer ${key}`, "x-api-key": key, "x-label": "harmless-header" }, payload: { token: key } })
    assert.equal(response.json().key, key)
    const issued = await app.inject({ method: "POST", url: "/application-key/issue" })
    assert.equal(issued.json().key, key)
    await app.close()
    const serialized = JSON.stringify(exports)
    assert.equal(serialized.includes(key), false)
    assert.ok(serialized.includes(prefix))
    const spans = exports.flatMap(value => value.resourceSpans ?? []).flatMap(value => value.scopeSpans).flatMap(value => value.spans)
    const operation = spans.find(value => value.name === "applicationKeys.issue")
    assert.ok(operation)
    const operationAttributes = Object.fromEntries(operation.attributes.map((attribute: any) => [attribute.key, attribute.value.stringValue]))
    const input = JSON.parse(operationAttributes["genio.input"]).value
    assert.equal(input.token, omitted)
    assert.equal(input.headers.authorization, `Bearer ${omitted}`)
    assert.equal(input.headers["x-api-key"], omitted)
    assert.equal(input.headers["x-label"], "harmless-header")
    const output = JSON.parse(operationAttributes["genio.output"]).value
    assert.equal(output.key, omitted)
    assert.equal(output.prefix, prefix)
    const http = spans.find(value => value.name === "POST /application-key/echo")
    assert.ok(http)
    const attributes = Object.fromEntries(http.attributes.map((attribute: any) => [attribute.key, attribute.value.stringValue]))
    assert.equal(attributes["genio.request"], JSON.stringify({ availability: "OMITTED_HTTP_REQUEST" }))
    assert.equal(attributes["genio.response"], JSON.stringify({ availability: "OMITTED_HTTP_RESPONSE" }))
    const sensitive = spans.find(value => value.name === "POST /application-key/issue")
    assert.ok(sensitive)
    const sensitiveAttributes = Object.fromEntries(sensitive.attributes.map((attribute: any) => [attribute.key, attribute.value.stringValue]))
    assert.equal(sensitiveAttributes["genio.response"], JSON.stringify({ availability: "OMITTED_SENSITIVE_RESPONSE" }))
  } finally {
    await app.close()
    globalThis.fetch = originalFetch
    if (originalOrigin === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalOrigin
  }
})

test("observed HTTP response capture masks an application key without changing transport", async () => {
  const originalFetch = globalThis.fetch
  const originalOrigin = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://application-key-response-collector.test"
  const exports: any[] = []
  const body = JSON.stringify({ key, prefix, note: "provider-result" })
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init)
    if (request.url.startsWith("http://application-key-provider.test")) return new Response(body)
    exports.push(JSON.parse(await request.text()))
    return Response.json({})
  }) as typeof fetch
  try {
    const response = await observedFetch("application-key-relay", "http://application-key-provider.test/result")
    assert.equal(await response.text(), body)
    await flushOtel()
    assert.equal(JSON.stringify(exports).includes(key), false)
    const logs = exports.flatMap(value => value.resourceLogs ?? []).flatMap(value => value.scopeLogs).flatMap(value => value.logRecords)
    const record = logs.find(value => value.body.stringValue === "http.client.response.body")
    const attributes = Object.fromEntries(record.attributes.map((attribute: any) => [attribute.key, attribute.value.stringValue]))
    assert.equal(JSON.parse(attributes["output.value"]).key, omitted)
    assert.equal(JSON.parse(attributes["output.value"]).prefix, prefix)
    assert.equal(attributes["output.sha256"], createHash("sha256").update(attributes["output.value"]).digest("hex"))
  } finally {
    globalThis.fetch = originalFetch
    if (originalOrigin === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalOrigin
  }
})

test("outbox masks application keys before disk storage and preserves export metadata on restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "application-key-outbox-"))
  let box = new OtlpOutbox({ directory, origin: "http://collector.test", send: async () => { throw new Error("offline") }, report: () => {} })
  try {
    assert.equal(await box.enqueue("logs", { resourceLogs: [{ attributes: { authorization: `Bearer ${key}`, nested: JSON.stringify({ api_key: key }), prefix, note: "harmless", access_token: "existing-oauth-token" } }] }), true)
    await box.flush()
    const files = (await readdir(directory)).filter(name => name.endsWith(".json"))
    assert.equal(files.length, 1)
    const saved = await readFile(join(directory, files[0]!), "utf8")
    assert.equal(saved.includes(key), false)
    assert.ok(saved.includes(prefix))
    assert.ok(saved.includes("existing-oauth-token"))
    await box.close()
    const received: string[] = []
    box = new OtlpOutbox({ directory, origin: "http://collector.test", send: async (_input, init) => { received.push(String(init.body)); return Response.json({}) }, report: () => {} })
    await box.flush()
    assert.equal(received.length, 1)
    assert.equal(received[0]!.includes(key), false)
    const attributes = JSON.parse(received[0]!).resourceLogs[0].attributes
    assert.equal(attributes.authorization, `Bearer ${omitted}`)
    assert.equal(attributes.prefix, prefix)
    assert.equal(attributes.note, "harmless")
    assert.equal(attributes.access_token, "existing-oauth-token")
  } finally {
    await box.close()
    await rm(directory, { recursive: true, force: true })
  }
})
