import assert from "node:assert/strict"
import test from "node:test"

import {
  createOtlpGatewayDetailCapture,
  gatewayDetailActivityReference,
  GatewayDetailBodyBuffer,
  sanitizeGatewayDetailBody,
} from "./otlp-detail-capture"

test("captured Activity metadata expires with the detail retention window", () => {
  assert.deepEqual(gatewayDetailActivityReference(true, "correlation-test", 100), {
    detail_availability: "AVAILABLE",
    detail_ref: "correlation-test",
    detail_expires_at: 86_500,
  })
})

test("detail body buffering is bounded and reports truncation", () => {
  const buffer = new GatewayDetailBodyBuffer(8)
  buffer.append(Buffer.from("12345"))
  buffer.append(Buffer.from("67890"))

  assert.equal(buffer.body().toString("utf8"), "12345678")
  assert.equal(buffer.truncated(), true)
})

test("detail capture emits request and response under one OTel correlation", async () => {
  let payload: Record<string, any> | undefined
  const capture = createOtlpGatewayDetailCapture({
    endpoint: "http://collector.test/v1/traces",
    persist: async (_signal, body) => {
      payload = body as Record<string, any>
      return true
    },
  })
  await capture.capture({
    tenantId: "tenant-test",
    correlationId: "correlation-test",
    requestBody: Buffer.from('{"request":true}'),
    requestBodyTruncated: false,
    requestContentType: "application/json",
    responseBody: Buffer.from('{"response":true}'),
    responseBodyTruncated: true,
    responseContentType: "application/json",
  })

  const span = payload?.resourceSpans[0].scopeSpans[0].spans[0]
  const attributes = Object.fromEntries(span.attributes.map((attribute: any) => [
    attribute.key,
    attribute.value.stringValue,
  ]))
  assert.equal(attributes["genio.correlation.id"], "correlation-test")
  assert.equal(attributes["input.value"], '{"request":true}')
  assert.equal(attributes["output.value"], '{"response":true}')
  assert.equal(
    span.attributes.find((attribute: any) => attribute.key === "output.truncated")?.value.boolValue,
    true,
  )
})

test("detail capture removes credentials from structured request and response bodies", async () => {
  let payload: Record<string, any> | undefined
  const capture = createOtlpGatewayDetailCapture({
    endpoint: "http://collector.test/v1/traces",
    persist: async (_signal, body) => {
      payload = body as Record<string, any>
      return true
    },
  })
  await capture.capture({
    tenantId: "tenant-test",
    correlationId: "correlation-secret",
    requestBody: Buffer.from(JSON.stringify({
      prompt: "safe",
      note: "embedded Bearer request-inline-secret must not survive",
      authorization: "Bearer request-secret",
      nested: { api_key: "provider-secret", note: "visible" },
      clientSecret: "camel-secret",
    })),
    requestBodyTruncated: false,
    requestContentType: "application/json; charset=utf-8",
    responseBody: Buffer.from(JSON.stringify({
      result: "safe",
      access_token: "response-secret",
    })),
    responseBodyTruncated: false,
    responseContentType: "application/json",
  })

  const span = payload?.resourceSpans[0].scopeSpans[0].spans[0]
  const attributes = new Map(span.attributes.map((attribute: any) => [
    attribute.key,
    attribute.value.stringValue ?? attribute.value.boolValue,
  ]))
  assert.equal(attributes.get("input.value"), '{"prompt":"safe","note":"embedded [REDACTED] must not survive","authorization":"[REDACTED]","nested":{"api_key":"[REDACTED]","note":"visible"},"clientSecret":"[REDACTED]"}')
  assert.equal(attributes.get("output.value"), '{"result":"safe","access_token":"[REDACTED]"}')
  assert.equal(attributes.get("input.redacted"), true)
  assert.equal(attributes.get("output.redacted"), true)
  assert.match(String(attributes.get("input.sha256")), /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(payload).includes("request-secret"), false)
  assert.equal(JSON.stringify(payload).includes("request-inline-secret"), false)
  assert.equal(JSON.stringify(payload).includes("provider-secret"), false)
  assert.equal(JSON.stringify(payload).includes("camel-secret"), false)
  assert.equal(JSON.stringify(payload).includes("response-secret"), false)
})

test("detail capture omits unstructured and invalid structured payloads", () => {
  const text = sanitizeGatewayDetailBody(Buffer.from("Bearer plaintext-secret"), "text/plain")
  assert.deepEqual(
    { value: text.value, redacted: text.redacted, disposition: text.disposition },
    { value: "[CONTENT_NOT_CAPTURED]", redacted: true, disposition: "OMITTED" },
  )
  const invalidJson = sanitizeGatewayDetailBody(Buffer.from("{not-json"), "application/json")
  assert.equal(invalidJson.value, "[CONTENT_NOT_CAPTURED]")
  assert.equal(invalidJson.redacted, true)
})

test("nested native login payloads redact one-time credentials and callback codes", () => {
  const body = Buffer.from(JSON.stringify({ message: JSON.stringify({ userCode: "private-device-code", verificationUrl: "https://login.test/callback?code=private-callback-code" }) }))
  const captured = sanitizeGatewayDetailBody(body, "application/json")
  assert.equal(captured.redacted, true)
  assert.equal(captured.value.includes("private-device-code"), false)
  assert.equal(captured.value.includes("private-callback-code"), false)
})
