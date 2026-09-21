import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import { dirname, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import protoLoader from "@grpc/proto-loader"

import {
  validateProcessorPolicy,
  type ProcessingContext,
  type ProcessorPolicy,
  type ProcessorPolicyStep,
} from "./contract"
import { createExternalProcessorHandler, createExternalProcessorServer } from "./grpc"
import { createProcessorChain, DataProcessor, SseLineBuffer } from "./module"
import { verifyProcessorPolicy, type ProcessorPolicySnapshot } from "./policy-store"
import type { TokenVault } from "./token-vault"
import type { GatewayActivityIngest } from "../shared/gateway-activity"
import type { UsageCounterStore } from "../shared/usage-governance"

class MemoryVault implements TokenVault {
  readonly values = new Map<string, string>()

  async store(
    context: ProcessingContext,
    token: string,
    value: string,
    _ttlSeconds: number,
  ): Promise<void> {
    this.values.set(
      [
        context.tenantId,
        context.subjectId,
        context.clientId,
        context.resourceId,
        context.capabilityId,
        context.sessionId,
        token,
      ].join(":"),
      value,
    )
  }

  async resolve(context: ProcessingContext, token: string): Promise<string | null> {
    return (
      this.values.get(
        [
          context.tenantId,
          context.subjectId,
          context.clientId,
          context.resourceId,
          context.capabilityId,
          context.sessionId,
          token,
        ].join(":"),
      ) ?? null
    )
  }
}

const context = {
  tenantId: "tenant-ai",
  subjectId: "person-1",
  clientId: "codex",
  resourceId: "corporate-gpt",
  capabilityId: "chat",
  sessionId: "session-1",
  correlationId: "correlation-1",
}
const policy: ProcessorPolicy = {
  schema_version: 1,
  revision: "processor-1",
  action: "TOKENIZE",
  token_ttl_seconds: 600,
  patterns: [
    {
      name: "EMAIL",
      expression: "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}",
    },
  ],
}
const builtinConfig = {
  patterns: policy.patterns,
  token_ttl_seconds: policy.token_ttl_seconds,
}
const bundleRevision = "bundle-7"
const releaseReference = {
  schema_version: "genio.one.gateway-release-ref.v1" as const,
  release_id: "release-7",
  gateway_id: "ai-gateway",
  head_revision: 7,
  package_digest: "a".repeat(64),
  projection_count: 2,
}

function policySnapshot(
  revision = bundleRevision,
  release = releaseReference,
): ProcessorPolicySnapshot {
  const scopes = [
    {
      resourceId: context.resourceId,
      capabilityId: context.capabilityId,
      steps: [
        {
          step_id: "protect-sensitive-data",
          hooks: {
            request: { action: "TOKENIZE", config: builtinConfig },
            response: { action: "RESTORE", config: builtinConfig },
          },
        },
      ] satisfies ProcessorPolicyStep[],
    },
  ] as const
  return {
    tenantId: context.tenantId,
    bundleRevision: revision,
    releaseId: release.release_id,
    releaseReference: release,
    policyVersion: "test-policy",
    captureMessageContent: false,
    scopes,
    stepsFor(resourceId: string, capabilityId: string) {
      return scopes.find(
        (scope) =>
          scope.resourceId === resourceId && scope.capabilityId === capabilityId,
      )?.steps
    },
    routingScopeFor() {
      return undefined
    },
  }
}

function externalProcessorOptions(
  tokenVault: TokenVault,
  processorFactory?: () => Pick<
    DataProcessor,
    "protectJson" | "protectSseLine" | "restoreJson" | "restoreSseLine"
  >,
) {
  return {
    policySource: {
      async current() {
        return policySnapshot()
      },
    },
    tokenVault,
    ...(processorFactory ? { processorFactory } : {}),
  }
}

function requestHeaderMessage(overrides: Record<string, string> = {}) {
  const headers: Record<string, string> = {
    "x-genio-trusted-tenant-id": context.tenantId,
    "x-genio-trusted-subject-id": context.subjectId,
    "x-genio-trusted-client-id": context.clientId,
    "x-genio-trusted-resource-id": context.resourceId,
    "x-genio-trusted-capability-id": context.capabilityId,
    "x-genio-trusted-correlation-id": context.correlationId,
    "x-genio-bundle-revision": bundleRevision,
    "x-genio-trusted-release-id": releaseReference.release_id,
    "x-genio-trusted-release-gateway-id": releaseReference.gateway_id,
    "x-genio-trusted-release-head-revision": String(releaseReference.head_revision),
    "x-genio-trusted-release-package-digest": releaseReference.package_digest,
    "x-genio-trusted-release-projection-count": String(releaseReference.projection_count),
    "x-genio-session-id": context.sessionId,
    "x-request-id": context.correlationId,
    "content-type": "application/json",
    ...overrides,
  }
  return {
    request_headers: {
      headers: {
        headers: Object.entries(headers).map(([key, value]) => ({ key, value })),
      },
    },
  }
}

function withoutRequestHeader(
  message: ReturnType<typeof requestHeaderMessage>,
  headerName: string,
) {
  message.request_headers.headers.headers = message.request_headers.headers.headers.filter(
    (header) => header.key !== headerName,
  )
  return message
}

async function runHeaderOnly(
  options: Parameters<typeof createExternalProcessorHandler>[0],
  message = requestHeaderMessage(),
): Promise<{ destroyed?: Error; responses: unknown[] }> {
  const listeners = new Map<string, ((value?: unknown) => void)[]>()
  let destroyed: Error | undefined
  const responses: unknown[] = []
  let finish!: () => void
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  const call = {
    on(event: string, listener: (value?: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return call
    },
    write(value: unknown) {
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
  createExternalProcessorHandler(options)(call as never)
  call.emit("data", message)
  call.emit("end")
  await finished
  return { destroyed, responses }
}

function deterministicRoutingScope() {
  return {
    owner_organization_id: "org-ai",
    resource_id: context.resourceId,
    capability_id: context.capabilityId,
    routing_policy_id: "routing-deterministic",
    routing_revision: 1,
    one_policy_revision: 1,
    route_mode: "DETERMINISTIC" as const,
    default_public_model_id: "model-public",
    candidate_set_digest: "a".repeat(64),
    candidates: [
      {
        order: 1,
        public_model_id: "model-public",
        public_model_name: "genio-chat",
        mappings: [
          {
            order: 1,
            mapping_id: "mapping-1",
            resource_id: context.resourceId,
            connection_id: "connection-1",
            provider_credential_profile_id: "provider-credential-1",
            provider_credential_profile_revision: 4,
            provider_credential_strategy_digest: "b".repeat(64),
            provider_model: "provider-model-1",
            mapping_revision: 1,
            pricing: {
              currency: "USD",
              input_cost_per_token_micros: 2,
              output_cost_per_token_micros: 8,
              source: "LITELLM",
              version: "f".repeat(64),
            },
          },
        ],
      },
    ],
  }
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

function processingErrorDetail(error: Error | undefined): string {
  return error?.cause instanceof Error ? error.cause.message : (error?.message ?? "")
}

test("request protection and response restoration keep sensitive values session-scoped", async () => {
  const vault = new MemoryVault()
  const processor = new DataProcessor({
    policy,
    tokenVault: vault,
    tokenFactory: () => "__GENIO_FIXED__",
  })
  const protectedBody = await processor.protectJson(
    context,
    Buffer.from(JSON.stringify({ messages: [{ content: "email me at user@example.com" }] })),
  )
  assert.equal(protectedBody.disposition, "CONTINUE")
  assert.deepEqual(protectedBody.matches, ["EMAIL"])
  assert.match(Buffer.from(protectedBody.body).toString(), /__GENIO_FIXED__/)

  const restored = await processor.restoreJson(context, protectedBody.body)
  assert.match(Buffer.from(restored.body).toString(), /user@example.com/)
  await assert.rejects(
    processor.restoreJson({ ...context, sessionId: "other-session" }, protectedBody.body),
    /token vault mapping is unavailable/,
  )
  await assert.rejects(
    processor.restoreJson({ ...context, subjectId: "other-subject" }, protectedBody.body),
    /token vault mapping is unavailable/,
  )
  await assert.rejects(
    processor.restoreJson({ ...context, clientId: "other-client" }, protectedBody.body),
    /token vault mapping is unavailable/,
  )
})

test("default tokenization keeps the full semantic type with a short opaque handle", async () => {
  const vault = new MemoryVault()
  const processor = new DataProcessor({ policy, tokenVault: vault })
  const protectedBody = await processor.protectJson(
    context,
    Buffer.from(JSON.stringify({ prompt: "contact user@example.com" })),
  )
  const encoded = Buffer.from(protectedBody.body).toString("utf8")
  const token = encoded.match(/<EMAIL:[A-Za-z0-9_-]{8}>/)?.[0]
  assert.ok(token)
  assert.doesNotMatch(encoded, /user@example\.com/)
  const restored = await processor.restoreJson(
    context,
    Buffer.from(JSON.stringify({ prompt: token })),
  )
  assert.match(Buffer.from(restored.body).toString("utf8"), /user@example\.com/)
})

test("token restoration tolerates type case and spacing only for a scoped vault hit", async () => {
  const vault = new MemoryVault()
  await vault.store(context, "<EMAIL:ABC123>", "user@example.com", 600)
  const processor = new DataProcessor({ policy: { ...policy, action: "RESTORE" }, tokenVault: vault })
  const restored = await processor.restoreJson(
    context,
    Buffer.from(JSON.stringify({ prompt: "<email: ABC123>" })),
  )
  assert.match(Buffer.from(restored.body).toString("utf8"), /user@example\.com/)
  await assert.rejects(
    processor.restoreJson(
      { ...context, sessionId: "other-session" },
      Buffer.from(JSON.stringify({ prompt: "<email: ABC123>" })),
    ),
    /token vault mapping is unavailable/,
  )
})

test("BLOCK action rejects matching payloads before upstream processing", async () => {
  const processor = new DataProcessor({
    policy: { ...policy, action: "BLOCK" },
    tokenVault: new MemoryVault(),
  })
  const result = await processor.protectJson(
    context,
    Buffer.from(JSON.stringify({ prompt: "user@example.com" })),
  )
  assert.equal(result.disposition, "BLOCK")
  assert.deepEqual(result.matches, ["EMAIL"])
})

test("processor policy validation rejects unknown actions, schema versions, and fields", async () => {
  assert.throws(
    () => validateProcessorPolicy({ ...policy, action: "MASK" }),
    /processor policy schema is invalid/,
  )
  assert.throws(
    () => validateProcessorPolicy({ ...policy, schema_version: 2 }),
    /processor policy schema is invalid/,
  )
  assert.throws(
    () =>
      validateProcessorPolicy({
        ...policy,
        patterns: [{ ...policy.patterns[0], action: "TOKENIZE" }],
      }),
    /processor policy schema is invalid/,
  )
  assert.throws(
    () =>
      new DataProcessor({
        policy: { ...policy, action: "MASK" } as unknown as ProcessorPolicy,
        tokenVault: new MemoryVault(),
      }),
    /processor policy schema is invalid/,
  )
  assert.throws(
    () =>
      new DataProcessor({
        policy: {
          ...policy,
          patterns: [{ ...policy.patterns[0], expression: "[" }],
        },
        tokenVault: new MemoryVault(),
      }),
    /processor pattern EMAIL has an invalid expression/,
  )
  await assert.rejects(
    new DataProcessor({
      policy: { ...policy, action: "RESTORE" },
      tokenVault: new MemoryVault(),
    }).protectJson(context, Buffer.from("{}")),
    /RESTORE cannot process a request payload/,
  )
})

test("processor policy must have a known EdDSA signature", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "key-1" })).toString(
    "base64url",
  )
  const payload = Buffer.from(JSON.stringify(policy)).toString("base64url")
  const signature = sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString(
    "base64url",
  )
  const keyRing = {
    schema_version: 1 as const,
    keys: [
      {
        key_id: "key-1",
        public_key_pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      },
    ],
  }
  assert.deepEqual(
    verifyProcessorPolicy(`${header}.${payload}.${signature}`, keyRing),
    policy,
  )
  assert.throws(
    () => verifyProcessorPolicy(`${header}.${payload}.invalid`, keyRing),
    /signature is invalid/,
  )
})

test("SSE restoration buffers split lines and restores tokens before downstream", async () => {
  const vault = new MemoryVault()
  const processor = new DataProcessor({
    policy,
    tokenVault: vault,
    tokenFactory: () => "__GENIO_FIXED__",
  })
  await vault.store(context, "__GENIO_FIXED__", "user@example.com", 600)
  const buffer = new SseLineBuffer()
  const first = await buffer.push(
    Buffer.from('data: {"choices":[{"delta":{"content":"__GENIO_'),
    false,
    (line) => processor.restoreSseLine(context, line),
  )
  assert.equal(Buffer.from(first.body).toString(), "")
  const second = await buffer.push(
    Buffer.from('FIXED__"}}]}\n\ndata: [DONE]\n'),
    true,
    (line) => processor.restoreSseLine(context, line),
  )
  assert.match(Buffer.from(second.body).toString(), /user@example.com/)
  assert.match(Buffer.from(second.body).toString(), /\[DONE\]/)
})

test("SSE restoration holds token fragments across separate data events", async () => {
  const vault = new MemoryVault()
  const processor = new DataProcessor({
    policy,
    tokenVault: vault,
    tokenFactory: () => "__GENIO_FIXED__",
  })
  await vault.store(context, "__GENIO_FIXED__", "user@example.com", 600)

  const first = await processor.restoreSseLine(
    context,
    'data: {"choices":[{"delta":{"content":"__GENIO_"}}]}',
  )
  const second = await processor.restoreSseLine(
    context,
    'data: {"choices":[{"delta":{"content":"FIXED__"}}]}',
  )

  assert.doesNotMatch(Buffer.from(first.body).toString(), /__GENIO_/)
  assert.match(Buffer.from(second.body).toString(), /user@example.com/)
  assert.doesNotMatch(Buffer.from(second.body).toString(), /__GENIO_/)
})

test("SSE restoration holds semantic token fragments across separate data events", async () => {
  const vault = new MemoryVault()
  const processor = new DataProcessor({
    policy: { ...policy, action: "RESTORE" },
    tokenVault: vault,
  })
  await vault.store(context, "<EMAIL:ABC12345>", "user@example.com", 600)

  const first = await processor.restoreSseLine(
    context,
    'data: {"choices":[{"delta":{"content":"<EMAIL:ABC"}}]}',
  )
  const second = await processor.restoreSseLine(
    context,
    'data: {"choices":[{"delta":{"content":"12345>"}}]}',
  )

  assert.doesNotMatch(Buffer.from(first.body).toString(), /<EMAIL:/)
  assert.match(Buffer.from(second.body).toString(), /user@example\.com/)
  assert.doesNotMatch(Buffer.from(second.body).toString(), /<EMAIL:/)
})

test("SSE restoration holds semantic tokens split into single-character deltas", async () => {
  const vault = new MemoryVault()
  const processor = new DataProcessor({
    policy: { ...policy, action: "RESTORE" },
    tokenVault: vault,
  })
  const token = "<EMAIL:ABC12345>"
  await vault.store(context, token, "user@example.com", 600)

  const output: string[] = []
  for (const character of token) {
    const result = await processor.restoreSseLine(
      context,
      `data: ${JSON.stringify({ choices: [{ delta: { content: character } }] })}`,
    )
    output.push(Buffer.from(result.body).toString())
  }

  const restored = output.join("")
  assert.match(restored, /user@example\.com/)
  assert.doesNotMatch(restored, /<EMAIL:|ABC12345/)
})

test("ordered process steps run request forward and response backward", async () => {
  const events: string[] = []
  const fakeProcessor = (action: string) => ({
    async protectJson(_context: ProcessingContext, body: Uint8Array) {
      events.push(`json:${action}`)
      return { disposition: "CONTINUE" as const, body, matches: [] }
    },
    async protectSseLine(_context: ProcessingContext, line: string) {
      events.push(`sse:${action}`)
      return { disposition: "CONTINUE" as const, body: Buffer.from(line), matches: [] }
    },
    async restoreJson(_context: ProcessingContext, body: Uint8Array) {
      events.push(`restore-json:${action}`)
      return { disposition: "CONTINUE" as const, body, matches: [] }
    },
    async restoreSseLine(_context: ProcessingContext, line: string) {
      events.push(`restore-sse:${action}`)
      return { disposition: "CONTINUE" as const, body: Buffer.from(line), matches: [] }
    },
  })
  const chain = createProcessorChain(
    [
      { step_id: "first", hooks: { request: { action: "REDACT" }, response: { action: "REDACT" } } },
      { step_id: "second", hooks: { request: { action: "BLOCK" }, response: { action: "BLOCK" } } },
    ],
    new MemoryVault(),
    bundleRevision,
    (builtPolicy) => fakeProcessor(builtPolicy.action),
  )

  const requestResult = await chain.protectJson(context, Buffer.from("{}"))
  const responseResult = await chain.restoreJson(context, Buffer.from("{}"))
  await chain.protectSseLine(context, "data: {}")
  await chain.restoreSseLine(context, "data: {}")

  assert.deepEqual(events, [
    "json:REDACT",
    "json:BLOCK",
    "json:BLOCK",
    "json:REDACT",
    "sse:REDACT",
    "sse:BLOCK",
    "sse:BLOCK",
    "sse:REDACT",
  ])
  assert.deepEqual(requestResult.executedSteps, [
    { stepId: "first", action: "REDACT" },
    { stepId: "second", action: "BLOCK" },
  ])
  assert.deepEqual(responseResult.executedSteps, [
    { stepId: "second", action: "BLOCK" },
    { stepId: "first", action: "REDACT" },
  ])
})

test("DLP handling emits runtime-owned classification provenance", async () => {
  const chain = createProcessorChain(
    [{
      step_id: "protect-customer-data",
      hooks: {
        request: {
          action: "REDACT",
          config: {
            patterns: [{ name: "CUSTOMER_DATA", expression: "customer-[0-9]+" }],
            token_ttl_seconds: 600,
          },
        },
      },
    }],
    new MemoryVault(),
    bundleRevision,
  )
  const result = await chain.protectJson(
    context,
    Buffer.from(JSON.stringify({ prompt: "review customer-4815" })),
  )
  assert.equal(result.disposition, "CONTINUE")
  assert.match(Buffer.from(result.body).toString("utf8"), /\[REDACTED:CUSTOMER_DATA\]/)
  assert.deepEqual(result.dataClassifications, [{
    classification: "CUSTOMER_DATA",
    handling_action: "REDACT",
    source: "DLP_DETECTOR",
    source_version: "builtin-REDACT-bundle-7-protect-customer-data",
    trust_level: "RUNTIME_OBSERVED",
    step_id: "protect-customer-data",
  }])
})

test("data protection treats an absent API payload as a valid no-op", async () => {
  const chain = createProcessorChain(
    [{ step_id: "redact", hooks: { request: { action: "REDACT" }, response: { action: "REDACT" } } }],
    new MemoryVault(),
    bundleRevision,
  )

  const requestResult = await chain.protectJson(context, Buffer.alloc(0))
  const responseResult = await chain.restoreJson(context, Buffer.alloc(0))

  assert.equal(requestResult.disposition, "CONTINUE")
  assert.equal(requestResult.body.byteLength, 0)
  assert.deepEqual(requestResult.matches, [])
  assert.equal(responseResult.disposition, "CONTINUE")
  assert.equal(responseResult.body.byteLength, 0)
  assert.deepEqual(responseResult.matches, [])
})

test("model classifier rewrites the public model using a strict candidate effect", async () => {
  const chain = createProcessorChain(
    [{
      step_id: "classifier",
      hooks: {
        request: {
          action: "MODEL_CLASSIFIER",
          effect: "SORT_ENTITLEMENT_CANDIDATES",
          config: {
            schema_version: 1,
            strategy: "KEYWORD",
            rules: [{ keywords: ["code", "debug"], public_model_name: "expert-chat" }],
            fallback_public_model_name: "default-chat",
          },
        },
      },
    }],
    new MemoryVault(),
    bundleRevision,
  )

  const matched = await chain.protectJson(context, Buffer.from(JSON.stringify({
    model: "default-chat",
    messages: [{ role: "user", content: "Please debug this code" }],
  })))
  const fallback = await chain.protectJson(context, Buffer.from(JSON.stringify({
    model: "default-chat",
    messages: [{ role: "user", content: "Hello" }],
  })))

  assert.equal(JSON.parse(Buffer.from(matched.body).toString()).model, "expert-chat")
  assert.equal(JSON.parse(Buffer.from(fallback.body).toString()).model, "default-chat")
  assert.deepEqual(matched.executedSteps, [
    { stepId: "classifier", action: "MODEL_CLASSIFIER" },
  ])
})

test("unknown actions and unknown built-in config fail closed before a stream runs", () => {
  assert.throws(
    () =>
      createProcessorChain(
        [{ step_id: "unknown", hooks: { request: { action: "UNKNOWN_ACTION" } } }],
        new MemoryVault(),
        bundleRevision,
      ),
    /processor hook action is unsupported.*UNKNOWN_ACTION/,
  )
  assert.throws(
    () =>
      createProcessorChain(
        [{
          step_id: "redact",
          hooks: {
            request: {
              action: "REDACT",
              config: { patterns: [], token_ttl_seconds: 600, unexpected: true },
            },
          },
        }],
        new MemoryVault(),
        bundleRevision,
      ),
    /processor hook config is invalid.*REDACT/,
  )
})

test("reversible tokenization is one bidirectional process step", () => {
  assert.doesNotThrow(() =>
    createProcessorChain(
      [{
        step_id: "token-vault",
        hooks: {
          request: { action: "TOKENIZE" },
          response: { action: "RESTORE" },
        },
      }],
      new MemoryVault(),
      bundleRevision,
    ),
  )
  assert.throws(
    () =>
      createProcessorChain(
        [{ step_id: "token-vault", hooks: { request: { action: "TOKENIZE" } } }],
        new MemoryVault(),
        bundleRevision,
      ),
    /reversible tokenization must use request TOKENIZE and response RESTORE/,
  )
})

test("ext_proc admits deterministic routing without a caller session", async () => {
  const snapshot: ProcessorPolicySnapshot = {
    tenantId: context.tenantId,
    bundleRevision,
    releaseId: releaseReference.release_id,
    releaseReference,
    policyVersion: "test-policy",
    captureMessageContent: false,
    scopes: [],
    stepsFor() {
      return []
    },
    routingScopeFor() {
      return deterministicRoutingScope()
    },
  }
  const result = await runHeaderOnly(
    {
      ...externalProcessorOptions(new MemoryVault()),
      policySource: { async current() { return snapshot } },
    },
    withoutRequestHeader(requestHeaderMessage(), "x-genio-session-id"),
  )

  assert.equal(result.destroyed, undefined)
  assert.equal(result.responses.length, 1)
})

test("ext_proc releases usage concurrency leases on success and processing failure", async () => {
  const released: string[] = []
  const usageCounterStore = {
    async releaseConcurrency(input: { lease_id: string }) {
      released.push(input.lease_id)
    },
    async settleCurrency() {},
  }
  const success = await runHeaderOnly({
    ...externalProcessorOptions(new MemoryVault()),
    usageCounterStore,
  }, requestHeaderMessage({
    "x-genio-usage-concurrency-leases": '["usage-lease-success"]',
  }))
  assert.equal(success.destroyed, undefined)
  assert.deepEqual(released, ["usage-lease-success"])

  const failure = await runHeaderOnly({
    ...externalProcessorOptions(new MemoryVault()),
    usageCounterStore,
    policySource: {
      async current() {
        return policySnapshot("wrong-revision")
      },
    },
  }, requestHeaderMessage({
    "x-genio-usage-concurrency-leases": '["usage-lease-failure"]',
  }))
  assert.ok(failure.destroyed)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(released, ["usage-lease-success", "usage-lease-failure"])
})

test("deterministic authorization keeps a single trusted public-model alias for receipts", async () => {
  const snapshot: ProcessorPolicySnapshot = {
    tenantId: context.tenantId,
    bundleRevision,
    releaseId: releaseReference.release_id,
    releaseReference,
    policyVersion: "test-policy",
    captureMessageContent: false,
    scopes: [],
    stepsFor() {
      return []
    },
    routingScopeFor() {
      return deterministicRoutingScope()
    },
  }
  const activity: GatewayActivityIngest[] = []
  const accounting: Array<Parameters<NonNullable<
    Parameters<typeof createExternalProcessorHandler>[0]["onAccounting"]
  >>[0]> = []
  const settlements: Array<Parameters<UsageCounterStore["settleCurrency"]>[0]> = []
  const listeners = new Map<string, ((value?: unknown) => void)[]>()
  let destroyed: Error | undefined
  let finish!: () => void
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  const responses: unknown[] = []
  const call = {
    on(event: string, listener: (value?: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return call
    },
    write(value: unknown) {
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
    ...externalProcessorOptions(new MemoryVault()),
    policySource: { async current() { return snapshot } },
    onActivity(event) {
      activity.push(event)
    },
    onAccounting(event) {
      accounting.push(event)
    },
    usageCounterStore: {
      async releaseConcurrency() {},
      async settleCurrency(value) {
        settlements.push(value)
      },
    },
  })(call as never)
  call.emit("data", requestHeaderMessage({
    "x-genio-allowed-public-models": "genio-chat",
    "x-genio-trusted-consumer-organization-id": "organization-consumer",
    "x-genio-trusted-resource-owner-organization-id": "organization-owner",
    "x-genio-trusted-use-case-id": "support-assistant",
    "x-genio-trusted-risk-level": "HIGH",
    "x-genio-usage-accounting-keys": '["accounting-shared"]',
    "x-genio-usage-policy-revisions": '["usage-policy:3"]',
    "x-genio-usage-currency-allocations": '[{"accounting_key_id":"accounting-shared","allocation_id":"currency-september","currency":"USD","window_seconds":2592000,"window_bucket":659}]',
  }))
  call.emit("data", {
    request_body: {
      body: Buffer.from(JSON.stringify({ model: "genio-chat", messages: [] })),
      end_of_stream: true,
    },
  })
  call.emit("data", {
    response_headers: {
      headers: {
        headers: [
          { key: ":status", value: "200" },
          { key: "content-type", value: "application/json" },
        ],
      },
    },
  })
  call.emit("data", {
    response_body: {
      body: Buffer.from(JSON.stringify({
        model: "provider-model-1",
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })),
      end_of_stream: true,
    },
  })
  call.emit("end")
  await finished

  assert.equal(destroyed, undefined)
  assert.ok(responses.length >= 4)
  const responseHeaders = responses.find((value: any) => value?.response_headers) as any
  assert.deepEqual(
    responseHeaders?.response_headers?.response?.header_mutation?.set_headers?.[0]?.header,
    {
      key: "x-genio-correlation-id",
      raw_value: Buffer.from(context.correlationId),
    },
  )
  assert.equal(activity.length, 1)
  assert.equal(activity[0]?.session_id, "session-1")
  assert.equal(activity[0]?.requested_model_id, "genio-chat")
  assert.equal(activity[0]?.connection_id, "connection-1")
  assert.equal(activity[0]?.provider_credential_profile_id, "provider-credential-1")
  assert.equal(activity[0]?.provider_credential_profile_revision, 4)
  assert.equal(activity[0]?.effective_model_id, "provider-model-1")
  assert.equal(activity[0]?.consumer_organization_id, "organization-consumer")
  assert.equal(activity[0]?.resource_owner_organization_id, "organization-owner")
  assert.equal(activity[0]?.use_case_id, "support-assistant")
  assert.equal(accounting.length, 1)
  assert.equal(accounting[0]?.invocation.consumer_organization_id, "organization-consumer")
  assert.equal(accounting[0]?.invocation.resource_owner_organization_id, "organization-owner")
  assert.equal(accounting[0]?.invocation.use_case_id, "support-assistant")
  assert.equal(accounting[0]?.invocation.accounting_key_id, "accounting-shared")
  assert.deepEqual(accounting[0]?.invocation.usage_policy_revisions, ["usage-policy:3"])
  assert.deepEqual(accounting[0]?.quantities.map((value) => [value.unit, value.quantity]), [
    ["INPUT_TOKENS", 1],
    ["OUTPUT_TOKENS", 1],
    ["TOTAL_TOKENS", 2],
  ])
  assert.equal(accounting[0]?.valuations[0]?.status, "ESTIMATED")
  assert.equal(accounting[0]?.valuations[0]?.amount_micros, 10)
  assert.equal(accounting[0]?.valuations[0]?.pricing_source, "LITELLM")
  assert.equal(settlements[0]?.amount_micros, 10)
  assert.equal(settlements[0]?.allocation_id, "currency-september")
})

test("ext_proc keeps reversible processing fail closed without a caller session", async () => {
  const result = await runHeaderOnly(
    externalProcessorOptions(new MemoryVault()),
    withoutRequestHeader(requestHeaderMessage(), "x-genio-session-id"),
  )

  assert.ok(result.destroyed)
  assert.match(processingErrorDetail(result.destroyed), /missing x-genio-session-id header/)
})

test("ext_proc preserves a fail-closed local response created before request headers", async () => {
  const result = await runHeaderOnly(
    externalProcessorOptions(new MemoryVault()),
    {
      response_headers: {
        headers: { headers: [{ key: ":status", value: "403" }] },
      },
    } as never,
  )

  assert.equal(result.destroyed, undefined)
  assert.deepEqual(result.responses, [{ response_headers: { response: { status: 0 } } }])
})

test("optional detail capture ignores internal hops without trusted context", async () => {
  const result = await runHeaderOnly(
    {
      ...externalProcessorOptions(new MemoryVault()),
      captureOnly: true,
    },
    withoutRequestHeader(requestHeaderMessage(), "x-genio-trusted-correlation-id"),
  )

  assert.equal(result.destroyed, undefined)
  assert.deepEqual(result.responses, [{ request_headers: { response: { status: 0 } } }])
})

test("ext_proc serializes async body transforms and preserves response order", async () => {
  const events: string[] = []
  let seenContext: ProcessingContext | undefined
  let startFirst!: () => void
  let releaseFirst!: () => void
  const firstStarted = new Promise<void>((resolve) => {
    startFirst = resolve
  })
  const firstFinished = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const processor = {
    async protectJson(_context: ProcessingContext, body: Uint8Array) {
      seenContext = _context
      const value = Buffer.from(body).toString("utf8")
      events.push(`start:${value}`)
      if (value === "first") {
        startFirst()
        await firstFinished
      }
      events.push(`finish:${value}`)
      return { disposition: "CONTINUE" as const, body, matches: [] }
    },
    async protectSseLine() {
      throw new Error("not expected in ordering test")
    },
    async restoreJson() {
      throw new Error("not expected in ordering test")
    },
    async restoreSseLine() {
      throw new Error("not expected in ordering test")
    },
  } as unknown as DataProcessor

  type Listener = (...args: any[]) => void
  const listeners = new Map<string, Listener[]>()
  let ended = false
  let destroyed: Error | undefined
  const responses: unknown[] = []
  let policyLoads = 0
  let finish!: () => void
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  const call = {
    on(event: string, listener: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return call
    },
    write(response: unknown) {
      responses.push(response)
      return true
    },
    end() {
      ended = true
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

  createExternalProcessorHandler(
    {
      ...externalProcessorOptions(new MemoryVault(), () => processor),
      policySource: {
        async current() {
          policyLoads += 1
          return policySnapshot()
        },
      },
    },
  )(call as never)
  const headers = {
    request_headers: {
      headers: {
        headers: [
          { key: "x-genio-trusted-tenant-id", value: "tenant-ai" },
          { key: "x-genio-trusted-subject-id", value: "person-1" },
          { key: "x-genio-trusted-client-id", value: "codex" },
          { key: "x-genio-trusted-resource-id", value: "corporate-gpt" },
          { key: "x-genio-trusted-capability-id", value: "chat" },
          { key: "x-genio-trusted-correlation-id", value: "correlation-1" },
          { key: "x-genio-bundle-revision", value: bundleRevision },
          { key: "x-genio-trusted-release-id", value: releaseReference.release_id },
          { key: "x-genio-trusted-release-gateway-id", value: releaseReference.gateway_id },
          { key: "x-genio-trusted-release-head-revision", value: "7" },
          {
            key: "x-genio-trusted-release-package-digest",
            value: releaseReference.package_digest,
          },
          { key: "x-genio-trusted-release-projection-count", value: "2" },
          // These caller-controlled lookalikes must not override the ext_authz
          // handoff above.
          { key: "x-genio-tenant-id", value: "attacker-tenant" },
          { key: "x-genio-subject-id", value: "attacker-subject" },
          { key: "x-genio-client-id", value: "attacker-client" },
          { key: "x-genio-resource-id", value: "attacker-resource" },
          { key: "x-genio-capability-id", value: "attacker-capability" },
          { key: "x-genio-correlation-id", value: "attacker-correlation" },
          { key: "x-genio-session-id", value: "session-1" },
          { key: "x-request-id", value: "envoy-request-id" },
          { key: "content-type", value: "application/json" },
        ],
      },
    },
  }
  call.emit("data", headers)
  call.emit("data", { request_body: { body: Buffer.from("first") } })
  call.emit("data", { request_body: { body: Buffer.from("second") } })
  call.emit("end")

  await firstStarted
  assert.deepEqual(events, ["start:first"])
  assert.equal(responses.length, 1)

  releaseFirst()
  await finished
  assert.equal(destroyed, undefined)
  assert.equal(ended, true)
  assert.equal(policyLoads, 1, "one stream must pin one policy snapshot")
  assert.deepEqual(events, ["start:first", "finish:first", "start:second", "finish:second"])
  assert.equal(responses.length, 3)
  assert.deepEqual(responses[0], {
    request_headers: {
      response: {
        status: 0,
        header_mutation: {
          remove_headers: [
            "x-genio-trusted-tenant-id",
            "x-genio-trusted-subject-id",
            "x-genio-trusted-client-id",
            "x-genio-trusted-resource-id",
            "x-genio-trusted-capability-id",
            "x-genio-trusted-correlation-id",
            "x-genio-trusted-consumer-organization-id",
            "x-genio-trusted-use-case-id",
            "x-genio-trusted-risk-level",
            "x-genio-trusted-subject-kind",
            "x-genio-trusted-authority-mode",
            "x-genio-trusted-principal-subject-id",
            "x-genio-trusted-delegation-id",
            "x-genio-trusted-delegation-revision",
            "x-genio-trusted-delegation-generation",
            "x-genio-trusted-agent-acting-chain",
            "x-genio-trusted-required-obligations",
            "x-genio-trusted-execution-grant-id",
            "x-genio-trusted-resource-owner-organization-id",
            "x-genio-trusted-release-id",
            "x-genio-trusted-release-gateway-id",
            "x-genio-trusted-release-head-revision",
            "x-genio-trusted-release-package-digest",
            "x-genio-trusted-release-projection-count",
            "x-genio-route-lease-id",
            "x-genio-route-lease-reused",
            "x-genio-route-connection-id",
            "x-genio-route-provider-model",
            "x-genio-route-provider-credential-profile-id",
            "x-genio-route-provider-credential-profile-revision",
            "x-genio-route-provider-credential-strategy-digest",
            "x-genio-session-id",
            "x-genio-tenant-id",
            "x-genio-subject-id",
            "x-genio-acting-client-id",
            "x-genio-client-id",
            "x-genio-resource-id",
            "x-genio-capability-id",
            "x-genio-verified-subject",
            "x-genio-verified-client",
            "x-ai-eg-model",
            "x-genio-organization-id",
            "x-genio-use-case-id",
            "x-genio-on-behalf-of-subject-id",
            "x-genio-execution-grant-id",
            "x-genio-organization-role",
            "x-genio-role",
            "x-genio-route-public-model",
            "x-genio-decision-id",
            "x-genio-policy-version",
            "x-genio-bundle-revision",
            "x-genio-allowed-public-models",
            "x-genio-allowed-mcp-tools",
            "x-genio-usage-admission-id",
            "x-genio-usage-accounting-keys",
            "x-genio-usage-concurrency-leases",
            "x-genio-usage-policy-revisions",
            "x-genio-usage-currency-allocations",
            "x-genio-processor-safety-decisions",
          ],
        },
      },
    },
    dynamic_metadata: {
      fields: {
        "genio.one.processor": {
          structValue: {
            fields: {
              bundle_revision: { stringValue: bundleRevision },
              request_steps: {
                stringValue: '[{"step_id":"protect-sensitive-data","action":"TOKENIZE"}]',
              },
            },
          },
        },
      },
    },
  })
  assert.deepEqual(seenContext, context)
})

test("ext_proc pins only the exact scoped policy from the authorizer release", async () => {
  const wrongRevision = await runHeaderOnly({
    ...externalProcessorOptions(new MemoryVault()),
    policySource: {
      async current() {
        return policySnapshot("another-release")
      },
    },
  })
  assert.match(
    processingErrorDetail(wrongRevision.destroyed),
    /processor policy release does not match authorization revision/,
  )

  for (const [header, value] of [
    ["x-genio-trusted-release-id", "release-other"],
    ["x-genio-trusted-release-gateway-id", "other-gateway"],
    ["x-genio-trusted-release-head-revision", "8"],
    ["x-genio-trusted-release-projection-count", "3"],
  ] as const) {
    const mismatchedRelease = await runHeaderOnly(
      externalProcessorOptions(new MemoryVault()),
      requestHeaderMessage({ [header]: value }),
    )
    assert.match(
      processingErrorDetail(mismatchedRelease.destroyed),
      /processor policy release does not match authorization release/,
      header,
    )
  }

  const otherReplicaPackage = await runHeaderOnly(
    externalProcessorOptions(new MemoryVault()),
    requestHeaderMessage({ "x-genio-trusted-release-package-digest": "b".repeat(64) }),
  )
  assert.equal(
    otherReplicaPackage.destroyed,
    undefined,
    "runtime-bound package digests may differ inside one Gateway Group release",
  )

  const wrongScope = await runHeaderOnly(
    externalProcessorOptions(new MemoryVault()),
    requestHeaderMessage({ "x-genio-trusted-resource-id": "another-resource" }),
  )
  assert.match(
    processingErrorDetail(wrongScope.destroyed),
    /processor policy and routing scope are unavailable/,
  )
})

test("processor execution receipt survives the ext_proc protobuf wire", async () => {
  const result = await runHeaderOnly(externalProcessorOptions(new MemoryVault()))
  assert.equal(result.destroyed, undefined)
  assert.equal(result.responses.length, 1)

  const decoded = roundTripProcessingResponse(result.responses[0])
  assert.deepEqual(
    decoded.dynamic_metadata.fields["genio.one.processor"].structValue.fields,
    {
      bundle_revision: { stringValue: bundleRevision, kind: "stringValue" },
      request_steps: {
        stringValue: '[{"step_id":"protect-sensitive-data","action":"TOKENIZE"}]',
        kind: "stringValue",
      },
    },
  )
})

test("ext_proc rejects conflicting internal headers", async () => {
  const listeners = new Map<string, ((value?: unknown) => void)[]>()
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
    write() {
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
  createExternalProcessorHandler(externalProcessorOptions(new MemoryVault()))(call as never)
  call.emit("data", {
    request_headers: {
      headers: {
        headers: [
          { key: "x-genio-trusted-tenant-id", value: context.tenantId },
          { key: "x-genio-trusted-tenant-id", value: "different-tenant" },
        ],
      },
    },
  })
  call.emit("end")

  await finished
  assert.ok(destroyed)
  assert.match(
    processingErrorDetail(destroyed),
    /conflicting x-genio-trusted-tenant-id headers/,
  )
})

test("ext_proc fails closed when the ext_authz trusted context is missing", async () => {
  const listeners = new Map<string, ((value?: unknown) => void)[]>()
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
    write() {
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
  createExternalProcessorHandler(externalProcessorOptions(new MemoryVault()))(call as never)
  call.emit("data", {
    request_headers: {
      headers: {
        headers: [
          // Only caller-controlled names are present.  They are deliberately
          // not accepted as a substitute for the ext_authz output.
          { key: "x-genio-tenant-id", value: context.tenantId },
          { key: "x-genio-subject-id", value: context.subjectId },
          { key: "x-genio-client-id", value: context.clientId },
          { key: "x-genio-resource-id", value: context.resourceId },
          { key: "x-genio-capability-id", value: context.capabilityId },
          { key: "x-genio-session-id", value: context.sessionId },
          { key: "x-request-id", value: context.correlationId },
          { key: "content-type", value: "application/json" },
        ],
      },
    },
  })
  call.emit("end")

  await finished
  assert.ok(destroyed)
  assert.match(
    processingErrorDetail(destroyed),
    /missing trusted x-genio-trusted-correlation-id header/,
  )
})

test("ext_proc rejects repeated trusted headers even when their values match", async () => {
  const listeners = new Map<string, ((value?: unknown) => void)[]>()
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
    write() {
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
  createExternalProcessorHandler(externalProcessorOptions(new MemoryVault()))(call as never)
  call.emit("data", {
    request_headers: {
      headers: {
        headers: [
          { key: "x-genio-trusted-tenant-id", value: context.tenantId },
          { key: "x-genio-trusted-tenant-id", value: context.tenantId },
        ],
      },
    },
  })
  call.emit("end")

  await finished
  assert.ok(destroyed)
  assert.match(
    processingErrorDetail(destroyed),
    /repeated x-genio-trusted-tenant-id header/,
  )
})

test("the processor exposes the Envoy ext_proc gRPC interface", () => {
  const server = createExternalProcessorServer(
    externalProcessorOptions(new MemoryVault()),
  )
  server.forceShutdown()
})
