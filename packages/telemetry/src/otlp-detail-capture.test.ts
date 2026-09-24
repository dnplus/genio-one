import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import {
  createOtlpGatewayDetailCapture,
  gatewayDetailActivityReference,
  GatewayDetailBodyBuffer,
  captureDetailBody,
  createDetailBodyDecoder,
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


// Accounting needs the payload the gateway actually carried. Redaction is the analytics
// collector's job (transform/redact_credentials); if the SDK rewrote bodies, the collector
// could never be tuned against real traffic and AAA identifiers would be lost at the source.
test("detail capture exports request and response bodies unmodified", async () => {
  let payload: Record<string, any> | undefined
  const capture = createOtlpGatewayDetailCapture({
    endpoint: "http://collector.test/v1/traces",
    persist: async (_signal, body) => {
      payload = body as Record<string, any>
      return true
    },
  })
  const request = JSON.stringify({ credential_id: "cred-1", token_type: "Bearer", authorization: "Bearer raw-request-token" })
  const response = "data: {\"choices\":[{\"delta\":{\"content\":\"streamed\"}}]}\n\n"
  await capture.capture({
    tenantId: "tenant-test",
    correlationId: "correlation-raw",
    requestBody: Buffer.from(request),
    requestBodyTruncated: false,
    requestContentType: "application/json",
    responseBody: Buffer.from(response),
    responseBodyTruncated: false,
    responseContentType: "text/event-stream",
  })

  const span = payload?.resourceSpans[0].scopeSpans[0].spans[0]
  const attributes = new Map(span.attributes.map((attribute: any) => [
    attribute.key,
    attribute.value.stringValue ?? attribute.value.boolValue,
  ]))
  assert.equal(attributes.get("input.value"), request)
  assert.equal(attributes.get("output.value"), response)
  assert.equal(attributes.get("input.encoding"), "utf8")
  assert.equal(attributes.get("output.mime_type"), "text/event-stream")
  assert.match(String(attributes.get("input.sha256")), /^[a-f0-9]{64}$/)
})

// The collector can only redact text it can read, so a body with invalid UTF-8 (binary,
// multipart) must stay text rather than become base64 that hides a credential from it.
test("non-UTF-8 bodies stay redactable text and keep the original digest", () => {
  const binary = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("&access_token=raw-in-binary")])
  const captured = captureDetailBody(binary)
  assert.equal(captured.encoding, "utf8-lossy")
  assert.ok(captured.value.includes("access_token=raw-in-binary"))
  assert.equal(captured.digest, createHash("sha256").update(binary).digest("hex"))
  assert.equal(captureDetailBody(Buffer.from("{not-json")).value, "{not-json")
})

// Evidence must not silently lose bytes: an incomplete multibyte prefix buffered from one part
// that turns invalid in the next part is kept (as U+FFFD), not dropped.
test("streamed decoding keeps a buffered prefix when the sequence turns invalid", () => {
  const decode = createDetailBodyDecoder()
  const first = decode(Uint8Array.from([0x61, 0xe2]), false)
  const second = decode(Uint8Array.from([0x41]), true)
  assert.equal(first.value + second.value, "a\uFFFDA")
  assert.equal(first.encoding, "utf8")
  assert.equal(second.encoding, "utf8-lossy")
})
