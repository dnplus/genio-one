import assert from "node:assert/strict"
import { request as httpRequest } from "node:http"
import { createServer as createNetServer } from "node:net"
import test from "node:test"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import protoLoader from "@grpc/proto-loader"
import { Value } from "typebox/value"

import type { ProcessingContext, ProcessorPolicyStep } from "./contract"
import { createExternalProcessorHandler } from "./grpc"
import { startProcessorHttpBridge } from "./http"
import type { ProcessorPolicySnapshot } from "./policy-store"
import type { TokenVault } from "./token-vault"
import type { GatewayActivityIngest } from "../shared/gateway-activity"
import type { GatewayRoutingScope } from "../shared/gateway-routing-artifact"
import {
  MAX_SAFETY_DECISION_HANDOFF_BYTES,
  PROCESSOR_SAFETY_DECISIONS_HEADER,
  SafetyDecisionReceiptSchema,
  mergeSafetyDecisionReceipts,
  safetyDecisionReceiptSerializedBytes,
  serializeSafetyDecisionReceipts,
  type SafetyDecisionReceipt,
} from "../shared/safety-decision"
import type {
  ProcessorAdapterRuntime,
  SafetyAdapterClient,
  SystemOneResponse,
} from "../shared/processor-adapters"

class MemoryVault implements TokenVault {
  async store(): Promise<void> {}

  async resolve(): Promise<string | null> {
    return null
  }
}

const context: ProcessingContext = {
  tenantId: "tenant-safety",
  subjectId: "subject-safety",
  clientId: "client-safety",
  resourceId: "resource-safety",
  capabilityId: "invoke",
  sessionId: "session-safety",
  correlationId: "correlation-safety",
}

const bundleRevision = "bundle-safety"
const releaseReference = {
  schema_version: "genio.one.gateway-release-ref.v1" as const,
  release_id: "release-safety",
  gateway_id: "gateway-safety",
  head_revision: 1,
  package_digest: "a".repeat(64),
  projection_count: 1,
}

const safetyConfig = {
  schema_version: 1,
  adapter_id: "semantic-safety",
  checks: [{
    id: "policy",
    instructions: "Assess whether the content violates policy.",
    threshold: 0.7,
  }],
  timeout_ms: 1_000,
} as const

function snapshot(
  steps: ProcessorPolicyStep[],
  tenantId = context.tenantId,
  routingScope?: GatewayRoutingScope,
): ProcessorPolicySnapshot {
  const scopes = [{
    resourceId: context.resourceId,
    capabilityId: context.capabilityId,
    steps,
  }]
  return {
    tenantId,
    bundleRevision,
    releaseId: releaseReference.release_id,
    releaseReference,
    policyVersion: "policy-safety",
    captureMessageContent: false,
    scopes,
    stepsFor(resourceId, capabilityId) {
      return scopes.find((scope) =>
        scope.resourceId === resourceId && scope.capabilityId === capabilityId
      )?.steps
    },
    routingScopeFor() {
      return routingScope
    },
  }
}

function deterministicRoutingScope(): GatewayRoutingScope {
  return {
    owner_organization_id: "org-safety",
    resource_id: context.resourceId,
    capability_id: context.capabilityId,
    routing_policy_id: "routing-safety",
    routing_revision: 1,
    one_policy_revision: 1,
    route_mode: "DETERMINISTIC",
    default_public_model_id: "model-safety",
    candidate_set_digest: "a".repeat(64),
    candidates: [{
      order: 1,
      public_model_id: "model-safety",
      public_model_name: "safety-model",
      mappings: [],
    }],
  }
}

function adapterRuntime(
  evaluate: SafetyAdapterClient["evaluate"],
): ProcessorAdapterRuntime {
  return {
    resolveSafetyAdapter(tenantId, adapterId) {
      assert.equal(tenantId, context.tenantId)
      assert.equal(adapterId, safetyConfig.adapter_id)
      return {
        adapterId,
        provider: "HTTP",
        endpoint: "https://adapter.example.test/systemone",
        model: "gateway-safety-model",
        evaluate,
      }
    },
    resolvePresidioAdapter() {
      throw new Error("unexpected Presidio adapter resolution")
    },
  }
}

function safetyAnswer(score: number): SystemOneResponse {
  return {
    model: "gateway-safety-model-v1",
    answers: { policy: { type: "noul", noul: score } },
  }
}

function requestHeaders(
  contentType = "application/json",
  additionalHeaders: Array<[string, string]> = [],
) {
  return {
    request_headers: {
      headers: {
        headers: [
          ["x-genio-trusted-tenant-id", context.tenantId],
          ["x-genio-trusted-subject-id", context.subjectId],
          ["x-genio-trusted-client-id", context.clientId],
          ["x-genio-trusted-resource-id", context.resourceId],
          ["x-genio-trusted-capability-id", context.capabilityId],
          ["x-genio-trusted-correlation-id", context.correlationId],
          ["x-genio-bundle-revision", bundleRevision],
          ["x-genio-trusted-release-id", releaseReference.release_id],
          ["x-genio-trusted-release-gateway-id", releaseReference.gateway_id],
          ["x-genio-trusted-release-head-revision", String(releaseReference.head_revision)],
          ["x-genio-trusted-release-package-digest", releaseReference.package_digest],
          ["x-genio-trusted-release-projection-count", String(releaseReference.projection_count)],
          ["x-genio-session-id", context.sessionId],
          ["x-request-id", context.correlationId],
          ["content-type", contentType],
          ...additionalHeaders,
        ].map(([key, value]) => ({ key, value })),
      },
    },
  }
}

async function unusedPort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("temporary port is unavailable")
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

async function postChunks(
  port: number,
  chunks: readonly Uint8Array[],
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/v1/process/request",
      headers: { "transfer-encoding": "chunked", ...headers },
    }, (response) => {
      const responseChunks: Buffer[] = []
      response.on("data", (chunk) => responseChunks.push(Buffer.from(chunk)))
      response.on("error", reject)
      response.on("end", () => resolve({
        statusCode: response.statusCode ?? 0,
        body: Buffer.concat(responseChunks).toString("utf8"),
      }))
    })
    request.on("error", reject)
    request.write(chunks[0]!)
    setTimeout(() => {
      for (const chunk of chunks.slice(1)) request.write(chunk)
      request.end()
    }, 5)
  })
}

function responseHeaders(contentType: string) {
  return {
    response_headers: {
      headers: {
        headers: [
          { key: ":status", value: "200" },
          { key: "content-type", value: contentType },
        ],
      },
    },
  }
}

async function run(
  steps: ProcessorPolicyStep[],
  runtime: ProcessorAdapterRuntime,
  messages: unknown[],
  snapshotTenantId = context.tenantId,
  safetyBufferBytes?: number,
): Promise<{
  destroyed?: Error
  responses: Record<string, any>[]
  activity: GatewayActivityIngest[]
}> {
  const listeners = new Map<string, Array<(value?: unknown) => void>>()
  const responses: Record<string, any>[] = []
  const activity: GatewayActivityIngest[] = []
  let destroyed: Error | undefined
  let finish!: () => void
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  const call = {
    on(event: string, listener: (value?: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return call
    },
    write(value: Record<string, any>) {
      responses.push(value)
      return true
    },
    end() {
      finish()
    },
    destroy(error: Error) {
      destroyed = error
      finish()
    },
    emit(event: string, value?: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(value)
    },
  }
  createExternalProcessorHandler({
    policySource: { async current() { return snapshot(steps, snapshotTenantId) } },
    tokenVault: new MemoryVault(),
    adapterRuntime: runtime,
    safetyBufferBytes,
    onActivity(event) {
      activity.push(event)
    },
  })(call as never)
  for (const message of messages) call.emit("data", message)
  call.emit("end")
  await finished
  return { destroyed, responses, activity }
}

function httpHeaders(tenantId = context.tenantId): Record<string, string> {
  return Object.fromEntries(
    requestHeaders().request_headers.headers.headers.map((header) => [
      header.key,
      header.key === "x-genio-trusted-tenant-id" ? tenantId : header.value,
    ]),
  )
}

function immediateCode(value: Record<string, any>): string | undefined {
  const body = value.immediate_response?.body
  return body ? JSON.parse(Buffer.from(body).toString("utf8")).code : undefined
}

function roundTripProcessingResponse(value: unknown): Record<string, any> {
  const protoPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "proto/external_processor_minimal.proto",
  )
  const definition = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: Number,
    defaults: true,
    oneofs: true,
  })
  const message = definition["envoy.service.ext_proc.v3.ProcessingResponse"] as {
    serialize(value: unknown): Buffer
    deserialize(value: Buffer): Record<string, any>
  }
  return message.deserialize(message.serialize(value))
}

test("remote request safety rejects SSE before an upstream body is released", async () => {
  let evaluations = 0
  const result = await run([{
    step_id: "request-safety",
    hooks: { request: { action: "SAFETY_CHECK", config: safetyConfig } },
  }], adapterRuntime(async () => {
    evaluations += 1
    return safetyAnswer(0.1)
  }), [requestHeaders("text/event-stream")])

  assert.equal(evaluations, 0)
  assert.equal(result.responses.length, 1)
  assert.equal(immediateCode(result.responses[0]!), "SAFETY_REQUEST_STREAM_UNSUPPORTED")
  assert.equal(result.responses.some((response) => Boolean(response.request_headers)), false)
  assert.equal(result.activity.length, 1)
  assert.equal(result.activity[0]?.error_code, "SAFETY_REQUEST_STREAM_UNSUPPORTED")
  assert.equal(result.activity[0]?.upstream_attempted, false)
})

test("remote response safety buffers JSON, emits a receipt, and releases no unsafe prefix", async () => {
  const result = await run([{
    step_id: "response-safety",
    hooks: { response: { action: "SAFETY_CHECK", config: safetyConfig } },
  }], adapterRuntime(async () => safetyAnswer(0.9)), [
    requestHeaders(),
    { request_body: { body: Buffer.from(JSON.stringify({ model: "public", stream: false })), end_of_stream: true } },
    responseHeaders("application/json"),
    { response_body: { body: Buffer.from('{"choices":[{"message":{"content":"prefix '), end_of_stream: false } },
    { response_body: { body: Buffer.from('unsafe"}}]}'), end_of_stream: true } },
  ])

  const headers = result.responses.find((response) => response.response_headers)
  assert.ok(headers)
  const decodedHeaders = roundTripProcessingResponse(headers)
  assert.equal(decodedHeaders.mode_override?.response_body_mode, 2)
  const bodyResponses = result.responses.filter((response) => response.response_body)
  assert.equal(bodyResponses.length, 1)
  assert.equal(
    Buffer.from(bodyResponses[0]!.response_body.response.body_mutation.body).toString("utf8"),
    "",
  )
  assert.equal(
    result.responses.some((response) =>
      Buffer.from(response.response_body?.response?.body_mutation?.body ?? Buffer.alloc(0))
        .toString("utf8")
        .includes("prefix unsafe"),
    ),
    false,
  )
  const immediate = result.responses.find((response) => response.immediate_response)
  assert.ok(immediate)
  assert.equal(roundTripProcessingResponse(immediate).immediate_response.status.code, 403)
  assert.equal(immediateCode(immediate), "DATA_PROTECTION_BLOCKED")
  assert.equal(result.activity.length, 1)
  assert.equal(result.activity[0]?.outcome, "BLOCKED")
  assert.equal(result.activity[0]?.status_code, 200)
  assert.deepEqual(result.activity[0]?.safety_decisions, [{
    adapter_id: safetyConfig.adapter_id,
    provider: "HTTP",
    model: "gateway-safety-model-v1",
    check_id: "policy",
    score: 0.9,
    threshold: 0.7,
    decision: "BLOCK",
    direction: "response",
    step_id: "response-safety",
  }])
})

test("remote request safety buffer overflow returns 413 and records activity", async () => {
  const result = await run([{
    step_id: "request-safety",
    hooks: { request: { action: "SAFETY_CHECK", config: safetyConfig } },
  }], adapterRuntime(async () => safetyAnswer(0.1)), [
    requestHeaders(),
    { request_body: { body: Buffer.from("first"), end_of_stream: false } },
    { request_body: { body: Buffer.from("second"), end_of_stream: true } },
  ], undefined, 8)

  const immediate = result.responses.find((response) => response.immediate_response)
  assert.ok(immediate)
  assert.equal(roundTripProcessingResponse(immediate).immediate_response.status.code, 413)
  assert.equal(immediateCode(immediate), "SAFETY_BUFFER_LIMIT_EXCEEDED")
  assert.equal(result.activity.length, 1)
  assert.equal(result.activity[0]?.error_code, "SAFETY_BUFFER_LIMIT_EXCEEDED")
  assert.equal(result.activity[0]?.status_code, 413)
  assert.equal(result.activity[0]?.upstream_attempted, false)
})

test("remote response safety buffer overflow returns 413 and records activity", async () => {
  const result = await run([{
    step_id: "response-safety",
    hooks: { response: { action: "SAFETY_CHECK", config: safetyConfig } },
  }], adapterRuntime(async () => safetyAnswer(0.1)), [
    requestHeaders(),
    { request_body: { body: Buffer.from('{"stream":false}'), end_of_stream: true } },
    responseHeaders("application/json"),
    { response_body: { body: Buffer.from("a".repeat(20)), end_of_stream: false } },
    { response_body: { body: Buffer.from("b".repeat(20)), end_of_stream: true } },
  ], undefined, 32)

  const immediate = result.responses.find((response) => response.immediate_response)
  assert.ok(immediate)
  assert.equal(roundTripProcessingResponse(immediate).immediate_response.status.code, 413)
  assert.equal(immediateCode(immediate), "SAFETY_BUFFER_LIMIT_EXCEEDED")
  assert.equal(result.activity.length, 1)
  assert.equal(result.activity[0]?.error_code, "SAFETY_BUFFER_LIMIT_EXCEEDED")
  assert.equal(result.activity[0]?.status_code, 413)
  assert.equal(result.activity[0]?.upstream_attempted, true)
})

test("remote response safety rejects declared and upstream SSE before output", async () => {
  const steps: ProcessorPolicyStep[] = [{
    step_id: "response-safety",
    hooks: { response: { action: "SAFETY_CHECK", config: safetyConfig } },
  }]
  const declared = await run(steps, adapterRuntime(async () => safetyAnswer(0.1)), [
    requestHeaders(),
    { request_body: { body: Buffer.from(JSON.stringify({ stream: true })), end_of_stream: true } },
  ])
  assert.equal(declared.responses.some((response) => Boolean(response.request_body)), false)
  assert.equal(immediateCode(declared.responses.at(-1)!), "SAFETY_RESPONSE_STREAM_UNSUPPORTED")
  assert.equal(declared.activity[0]?.upstream_attempted, false)

  const upstream = await run(steps, adapterRuntime(async () => safetyAnswer(0.1)), [
    requestHeaders(),
    { request_body: { body: Buffer.from(JSON.stringify({ stream: false })), end_of_stream: true } },
    responseHeaders("text/event-stream"),
  ])
  assert.equal(upstream.responses.some((response) => Boolean(response.response_headers)), false)
  assert.equal(immediateCode(upstream.responses.at(-1)!), "SAFETY_RESPONSE_STREAM_UNSUPPORTED")
  assert.equal(upstream.activity[0]?.upstream_attempted, true)
})

test("trusted safety receipt handoff preserves Chinese identifiers through gRPC metadata", async () => {
  const handoff: SafetyDecisionReceipt[] = [{
    adapter_id: "安全適配器",
    provider: "HTTP",
    model: "模型一號",
    check_id: "提示注入",
    score: 0.1,
    threshold: 0.7,
    decision: "ALLOW",
    direction: "request",
    step_id: "輸入安全",
  }]
  const serialized = serializeSafetyDecisionReceipts(handoff)
  assert.equal(safetyDecisionReceiptSerializedBytes(handoff), Buffer.byteLength(serialized, "utf8"))
  assert.equal(/[^\u0000-\u007f]/.test(serialized), false)

  const result = await run([{
    step_id: "request-safety",
    hooks: { request: { action: "SAFETY_CHECK", config: safetyConfig } },
  }], adapterRuntime(async () => safetyAnswer(0.1)), [
    requestHeaders("application/json", [[PROCESSOR_SAFETY_DECISIONS_HEADER, serialized]]),
  ])

  const response = result.responses[0]!
  const receiptValue = response.dynamic_metadata.fields["genio.one.processor"].structValue
    .fields.safety_decisions.stringValue
  assert.deepEqual(JSON.parse(receiptValue), handoff)
  assert.ok(response.request_headers.response.header_mutation.remove_headers.includes(
    PROCESSOR_SAFETY_DECISIONS_HEADER,
  ))
})

test("safety receipt identity rejects delimiter control values and remains unambiguous", () => {
  const receipt = {
    adapter_id: "adapter",
    provider: "HTTP" as const,
    model: "model",
    check_id: "check",
    score: 0.1,
    threshold: 0.7,
    decision: "ALLOW" as const,
    direction: "request" as const,
    step_id: "step",
  }
  for (const invalid of [
    { ...receipt, adapter_id: " adapter" },
    { ...receipt, check_id: "check " },
    { ...receipt, step_id: "step\u0000adapter" },
    { ...receipt, step_id: "step\rcheck" },
    { ...receipt, step_id: "step\ncheck" },
  ]) {
    assert.equal(Value.Check(SafetyDecisionReceiptSchema, invalid), false)
  }

  const first = { ...receipt, step_id: "step\u0000adapter", adapter_id: "check", check_id: "rule" }
  const second = { ...receipt, step_id: "step", adapter_id: "adapter", check_id: "check\u0000rule" }
  const receipts = [first as SafetyDecisionReceipt]
  mergeSafetyDecisionReceipts(receipts, [second as SafetyDecisionReceipt])
  assert.equal(receipts.length, 2)
})

test("oversized safety receipt handoff is rejected before an Envoy header is emitted", () => {
  const oversized: SafetyDecisionReceipt[] = Array.from({ length: 64 }, (_, index) => ({
    adapter_id: `adapter-${index}`,
    provider: "HTTP" as const,
    model: "模".repeat(512),
    check_id: `check-${index}`,
    score: 0.1,
    threshold: 0.7,
    decision: "ALLOW" as const,
    direction: "request" as const,
    step_id: `step-${index}`,
  }))
  assert.ok(safetyDecisionReceiptSerializedBytes(oversized) > MAX_SAFETY_DECISION_HANDOFF_BYTES)
  assert.throws(() => serializeSafetyDecisionReceipts(oversized), /handoff limit/)
})

test("gRPC rejects a trusted tenant that differs from the verified release before resolving an adapter", async () => {
  let resolutions = 0
  const result = await run([{
    step_id: "request-safety",
    hooks: { request: { action: "SAFETY_CHECK", config: safetyConfig } },
  }], {
    resolveSafetyAdapter() {
      resolutions += 1
      return {
        adapterId: safetyConfig.adapter_id,
        provider: "HTTP",
        endpoint: "https://adapter.example.test/systemone",
        model: "gateway-safety-model",
        async evaluate() {
          return safetyAnswer(0.1)
        },
      }
    },
    resolvePresidioAdapter() {
      throw new Error("unexpected Presidio adapter resolution")
    },
  }, [requestHeaders()], "tenant-release")

  assert.equal(resolutions, 0)
  assert.ok(result.destroyed)
  assert.match(String(result.destroyed.cause), /processor policy release does not match authorization tenant/)
  assert.equal(result.responses.length, 0)
})

test("HTTP bridge rejects a trusted tenant that differs from the verified release before resolving an adapter", async () => {
  let resolutions = 0
  const port = await unusedPort()
  const bridge = startProcessorHttpBridge({
    listen: `127.0.0.1:${port}`,
    policySource: {
      async current() {
        return snapshot([{
          step_id: "request-safety",
          hooks: { request: { action: "SAFETY_CHECK", config: safetyConfig } },
        }], "tenant-release")
      },
    },
    tokenVault: new MemoryVault(),
    safetyBufferBytes: 8,
    adapterRuntime: {
      resolveSafetyAdapter() {
        resolutions += 1
        return {
          adapterId: safetyConfig.adapter_id,
          provider: "HTTP",
          endpoint: "https://adapter.example.test/systemone",
          model: "gateway-safety-model",
          async evaluate() {
            return safetyAnswer(0.1)
          },
        }
      },
      resolvePresidioAdapter() {
        throw new Error("unexpected Presidio adapter resolution")
      },
    },
  })
  await new Promise<void>((resolve, reject) => {
    bridge.once("listening", resolve)
    bridge.once("error", reject)
  })
  try {
    const response = await postChunks(
      port,
      [Buffer.from(JSON.stringify({ messages: [{ role: "user", content: "hello" }] }))],
      httpHeaders(),
    )
    assert.equal(response.statusCode, 503)
    assert.deepEqual(JSON.parse(response.body), { code: "PROCESSOR_REQUEST_REJECTED" })
    assert.equal(resolutions, 0)
  } finally {
    await new Promise<void>((resolve, reject) => bridge.close((error) => error ? reject(error) : resolve()))
  }
})

test("HTTP processor bridge bounds remote safety bodies after verified scope selection and records the denial", async () => {
  const port = await unusedPort()
  const activity: GatewayActivityIngest[] = []
  let evaluations = 0
  const bridge = startProcessorHttpBridge({
    listen: `127.0.0.1:${port}`,
    policySource: {
      async current() {
        return snapshot([{
          step_id: "request-safety",
          hooks: { request: { action: "SAFETY_CHECK", config: safetyConfig } },
        }])
      },
    },
    tokenVault: new MemoryVault(),
    safetyBufferBytes: 8,
    adapterRuntime: adapterRuntime(async () => {
      evaluations += 1
      return safetyAnswer(0.1)
    }),
    onActivity(event) {
      activity.push(event)
    },
  })
  await new Promise<void>((resolve, reject) => {
    bridge.once("listening", resolve)
    bridge.once("error", reject)
  })
  try {
    const response = await postChunks(
      port,
      [Buffer.from("first"), Buffer.from("second")],
      httpHeaders(),
    )
    assert.equal(response.statusCode, 413)
    assert.deepEqual(JSON.parse(response.body), { code: "SAFETY_BUFFER_LIMIT_EXCEEDED" })
    assert.equal(evaluations, 0)
    assert.equal(activity.length, 1)
    assert.equal(activity[0]?.error_code, "SAFETY_BUFFER_LIMIT_EXCEEDED")
    assert.equal(activity[0]?.status_code, 413)
    assert.equal(activity[0]?.outcome, "BLOCKED")
    assert.equal(activity[0]?.upstream_attempted, false)
    assert.deepEqual(activity[0]?.processor_request_steps, [{
      step_id: "request-safety",
      action: "SAFETY_CHECK",
    }])
  } finally {
    await new Promise<void>((resolve, reject) => bridge.close((error) => error ? reject(error) : resolve()))
  }
})

test("HTTP processor bridge does not apply the remote safety cap to legacy redaction and deterministic routing", async () => {
  const port = await unusedPort()
  const bridge = startProcessorHttpBridge({
    listen: `127.0.0.1:${port}`,
    policySource: {
      async current() {
        return snapshot([{
          step_id: "legacy-redaction",
          hooks: {
            request: {
              action: "REDACT",
              config: {
                patterns: [{ name: "SECRET", expression: "secret" }],
                token_ttl_seconds: 600,
              },
            },
          },
        }], context.tenantId, deterministicRoutingScope())
      },
    },
    tokenVault: new MemoryVault(),
    safetyBufferBytes: 8,
  })
  await new Promise<void>((resolve, reject) => {
    bridge.once("listening", resolve)
    bridge.once("error", reject)
  })
  try {
    const body = Buffer.from(JSON.stringify({
      model: "safety-model",
      input: "legacy secret payload exceeds the safety cap",
    }))
    assert.ok(body.byteLength > 8)
    const response = await postChunks(port, [body], httpHeaders())
    assert.equal(response.statusCode, 200)
    assert.match(response.body, /\[REDACTED:SECRET\]/)
  } finally {
    await new Promise<void>((resolve, reject) => bridge.close((error) => error ? reject(error) : resolve()))
  }
})
