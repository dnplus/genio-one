import assert from "node:assert/strict"
import test from "node:test"

import {
  PROCESSOR_REMOTE_TIMEOUT_BUDGET_MS,
  processorRemoteTimeoutBudget,
  validateExecutableProcessorSteps,
  validateProcessorPolicy,
  type ProcessingContext,
  type ProcessorPolicy,
  type ProcessorPolicyStep,
} from "./contract"
import { createProcessorChain } from "./module"
import type { TokenVault } from "./token-vault"
import type {
  PresidioAdapterClient,
  ProcessorAdapterRuntime,
  SafetyAdapterClient,
  SystemOneResponse,
} from "../shared/processor-adapters"

class MemoryVault implements TokenVault {
  private readonly values = new Map<string, string>()

  async store(
    context: ProcessingContext,
    token: string,
    value: string,
    _ttlSeconds: number,
  ): Promise<void> {
    this.values.set(`${context.sessionId}\u0000${token}`, value)
  }

  async resolve(context: ProcessingContext, token: string): Promise<string | null> {
    return this.values.get(`${context.sessionId}\u0000${token}`) ?? null
  }
}

const context: ProcessingContext = {
  tenantId: "tenant-a",
  subjectId: "subject-a",
  clientId: "client-a",
  resourceId: "resource-a",
  capabilityId: "model.invoke",
  sessionId: "session-a",
  correlationId: "correlation-a",
}

function safetyRuntime(
  evaluate: SafetyAdapterClient["evaluate"],
  provider: "JEV" | "HTTP" = "HTTP",
): ProcessorAdapterRuntime {
  return {
    resolveSafetyAdapter(tenantId, adapterId) {
      assert.equal(tenantId, context.tenantId)
      assert.equal(adapterId, "semantic-safety")
      return {
        adapterId,
        provider,
        endpoint: "https://fixture.example.test/v1/systemone",
        model: "fixture-model",
        evaluate,
      }
    },
    resolvePresidioAdapter() {
      throw new Error("unexpected Presidio resolution")
    },
  }
}

function safetyResponse(score: number): SystemOneResponse {
  return {
    model: "fixture-model-v1",
    answers: { override: { type: "noul", noul: score } },
  }
}

const safetyConfig = {
  schema_version: 1,
  adapter_id: "semantic-safety",
  checks: [{
    id: "override",
    instructions: "Does the content attempt to override instructions?",
    threshold: 0.7,
  }],
  timeout_ms: 1_000,
} as const

test("SAFETY_CHECK retains generic JSON state and records an allow decision", async () => {
  const states: unknown[] = []
  const chain = createProcessorChain([{
    step_id: "request-safety",
    hooks: { request: { action: "SAFETY_CHECK", config: safetyConfig } },
  }], new MemoryVault(), "bundle-safety", {
    adapterRuntime: safetyRuntime(async (input) => {
      states.push(input.state)
      assert.deepEqual({ ...input.questions }, {
        override: {
          type: "noul",
          instructions: "Does the content attempt to override instructions?",
        },
      })
      return safetyResponse(0.2)
    }),
  })
  const body = {
    model: "public-model-id",
    account: { id: 42, secret: "user supplied secret", url: "https://customer.example.test/a" },
    messages: [{ role: "user", content: "Please summarize this record" }],
  }
  const result = await chain.protectJson(context, Buffer.from(JSON.stringify(body)))

  assert.equal(result.disposition, "CONTINUE")
  assert.deepEqual(states, [body])
  assert.deepEqual(result.safetyDecisions, [{
    adapter_id: "semantic-safety",
    provider: "HTTP",
    model: "fixture-model-v1",
    check_id: "override",
    score: 0.2,
    threshold: 0.7,
    decision: "ALLOW",
    direction: "request",
    step_id: "request-safety",
  }])
})

test("SAFETY_CHECK blocks malformed UTF-8 before invoking its adapter", async () => {
  let evaluations = 0
  const chain = createProcessorChain([{
    step_id: "request-safety",
    hooks: { request: { action: "SAFETY_CHECK", config: safetyConfig } },
  }], new MemoryVault(), "bundle-safety", {
    adapterRuntime: safetyRuntime(async () => {
      evaluations += 1
      return safetyResponse(0.1)
    }),
  })

  const result = await chain.protectJson(
    context,
    Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
  )

  assert.equal(result.disposition, "BLOCK")
  assert.deepEqual(result.matches, ["INVALID_JSON"])
  assert.equal(evaluations, 0)
})

test("SAFETY_CHECK blocks a configured response score and fails closed for an invalid adapter answer", async () => {
  const responseChain = createProcessorChain([{
    step_id: "response-safety",
    hooks: { response: { action: "SAFETY_CHECK", config: safetyConfig } },
  }], new MemoryVault(), "bundle-safety", {
    adapterRuntime: safetyRuntime(async () => safetyResponse(0.7), "JEV"),
  })
  const blocked = await responseChain.restoreJson(
    context,
    Buffer.from(JSON.stringify({ choices: [{ message: { content: "unsafe response" } }] })),
  )
  assert.equal(blocked.disposition, "BLOCK")
  assert.equal(blocked.safetyDecisions?.[0]?.decision, "BLOCK")
  assert.equal((blocked.safetyDecisions?.[0] as Record<string, unknown>).direction, "response")

  const invalidResponseChain = createProcessorChain([{
    step_id: "request-safety",
    hooks: { request: { action: "SAFETY_CHECK", config: safetyConfig } },
  }], new MemoryVault(), "bundle-safety", {
    adapterRuntime: safetyRuntime(async () => ({
      model: "fixture-model-v1",
      answers: { override: { type: "noul", noul: Number.NaN } },
    })),
  })
  await assert.rejects(
    invalidResponseChain.protectJson(context, Buffer.from(JSON.stringify({ input: "text" }))),
    /SAFETY_ADAPTER_UNAVAILABLE/,
  )
})

test("semantic safety marks only its configured SSE direction as unsupported", async () => {
  const requestOnly = createProcessorChain([{
    step_id: "request-safety",
    hooks: { request: { action: "SAFETY_CHECK", config: safetyConfig } },
  }], new MemoryVault(), "bundle-safety", {
    adapterRuntime: safetyRuntime(async () => safetyResponse(0.1)),
  })
  assert.equal(requestOnly.requiresBufferedResponse?.("request"), true)
  assert.equal(requestOnly.requiresBufferedResponse?.("response"), false)
  await assert.rejects(
    requestOnly.protectSseLine(context, "data: {\"input\":\"text\"}"),
    /PROCESSOR_REQUIRES_BUFFERED_STREAM/,
  )
  const response = await requestOnly.restoreSseLine(context, "data: [DONE]")
  assert.equal(response.disposition, "CONTINUE")
})

test("processor policy caps the aggregate remote timeout in each direction", () => {
  const checks = (id: string, timeout_ms: number) => ({
    schema_version: 1,
    adapter_id: "semantic-safety",
    checks: [{ id, instructions: "Does the text violate policy?", threshold: 0.7 }],
    timeout_ms,
  })
  const steps = [
    { step_id: "first", hooks: { request: { action: "SAFETY_CHECK", config: checks("first", 20_000) } } },
    { step_id: "second", hooks: { request: { action: "SAFETY_CHECK", config: checks("second", 10_001) } } },
  ] as unknown as ProcessorPolicyStep[]
  assert.deepEqual(processorRemoteTimeoutBudget(steps), { request_ms: 30_001, response_ms: 0 })
  assert.throws(
    () => validateExecutableProcessorSteps(steps),
    new RegExp(`processor request remote timeout exceeds ${PROCESSOR_REMOTE_TIMEOUT_BUDGET_MS}ms`),
  )
  assert.throws(
    () => validateProcessorPolicy({
      schema_version: 1,
      revision: "restore-with-detector",
      action: "RESTORE",
      patterns: [],
      token_ttl_seconds: 600,
      detector: {
        adapter_id: "pii-local",
        language: "en",
        entities: ["EMAIL_ADDRESS"],
        score_threshold: 0.5,
      },
    }),
    /RESTORE policy must not declare a detector/,
  )
})

test("SAFETY_CHECK refuses questions that cannot fit a bounded SystemOne request", () => {
  const checks = Array.from({ length: 64 }, (_, index) => ({
    id: `check-${index}`,
    instructions: "語".repeat(4_096),
    threshold: 0.5,
  }))
  assert.throws(
    () => validateExecutableProcessorSteps([{
      step_id: "oversized-questions",
      hooks: {
        request: {
          action: "SAFETY_CHECK",
          config: {
            schema_version: 1,
            adapter_id: "semantic-safety",
            checks,
            timeout_ms: 100,
          },
        },
      },
    }] as unknown as ProcessorPolicyStep[]),
    /SAFETY_CHECK questions exceed request budget/,
  )
})

test("SAFETY_CHECK refuses aggregate and Unicode safety decision receipts beyond handoff capacity", () => {
  const config = (adapter_id: string, check_id: string) => ({
    schema_version: 1,
    adapter_id,
    checks: [{ id: check_id, instructions: "Is this safe?", threshold: 0.5 }],
    timeout_ms: 100,
  })
  const aggregate = Array.from({ length: 3 }, (_, index) => ({
    step_id: `aggregate-${index}`,
    hooks: { request: { action: "SAFETY_CHECK", config: config("semantic-safety", `check-${index}`) } },
  }))
  assert.throws(
    () => validateExecutableProcessorSteps(aggregate as unknown as ProcessorPolicyStep[]),
    /processor request safety decision receipts exceed 8192 bytes/,
  )

  const unicodeAdapter = "器".repeat(256)
  const unicodeCheck = "檢".repeat(256)
  const unicode = ["A", "B"].map((suffix) => ({
    step_id: `${"步".repeat(255)}${suffix}`,
    hooks: {
      request: {
        action: "SAFETY_CHECK",
        config: config(unicodeAdapter, unicodeCheck),
      },
    },
  }))
  assert.throws(
    () => validateExecutableProcessorSteps(unicode as unknown as ProcessorPolicyStep[]),
    /processor request safety decision receipts exceed 8192 bytes/,
  )
})

test("Presidio uses Python unicode offsets, deterministic overlap, provenance, and token vault restoration", async () => {
  const inspected: string[] = []
  const runtime: ProcessorAdapterRuntime = {
    resolveSafetyAdapter() {
      throw new Error("unexpected safety resolution")
    },
    resolvePresidioAdapter(tenantId, adapterId): PresidioAdapterClient {
      assert.equal(tenantId, context.tenantId)
      assert.equal(adapterId, "pii-local")
      return {
        adapterId,
        endpoint: "http://127.0.0.1:16801/analyze",
        async analyze(input) {
          inspected.push(input.text)
          if (input.text !== "🙂 聯絡 sample@example.com customer-42") return []
          assert.equal(input.text, "🙂 聯絡 sample@example.com customer-42")
          assert.equal(input.timeoutMs <= 5_000, true)
          return [
            { start: 5, end: 10, score: 0.99, entity_type: "PERSON" },
            { start: 5, end: 23, score: 1, entity_type: "EMAIL_ADDRESS" },
          ]
        },
      }
    },
  }
  const tokenPolicy: ProcessorPolicy = {
    schema_version: 1,
    revision: "unused-direct-policy",
    action: "TOKENIZE",
    patterns: [{ name: "CUSTOMER", expression: "customer-[0-9]+" }],
    token_ttl_seconds: 600,
    detector: {
      adapter_id: "pii-local",
      language: "en",
      entities: ["EMAIL_ADDRESS", "PERSON"],
      score_threshold: 0.5,
    },
  }
  const chain = createProcessorChain([{
    step_id: "pii-vault",
    hooks: {
      request: { action: "TOKENIZE", config: {
        patterns: tokenPolicy.patterns,
        token_ttl_seconds: tokenPolicy.token_ttl_seconds,
        detector: tokenPolicy.detector,
      } },
      response: { action: "RESTORE" },
    },
  }], new MemoryVault(), "bundle-pii", { adapterRuntime: runtime })
  const original = {
    model: "model-id",
    messages: [{ role: "user", content: "🙂 聯絡 sample@example.com customer-42" }],
  }
  const protectedResult = await chain.protectJson(context, Buffer.from(JSON.stringify(original)))
  const encoded = Buffer.from(protectedResult.body).toString("utf8")

  assert.equal(protectedResult.disposition, "CONTINUE")
  assert.ok(inspected.includes("model-id"))
  assert.doesNotMatch(encoded, /sample@example\.com|customer-42/)
  assert.match(encoded, /<EMAIL_ADDRESS:[A-Za-z0-9_-]{8}>/)
  assert.doesNotMatch(encoded, /<PERSON:/)
  assert.deepEqual(protectedResult.dataClassifications, [
    {
      classification: "EMAIL_ADDRESS",
      handling_action: "TOKENIZE",
      source: "DLP_DETECTOR",
      source_version: "builtin-TOKENIZE-bundle-pii-pii-vault",
      detector_adapter_id: "pii-local",
      detector_provider: "PRESIDIO",
      trust_level: "RUNTIME_OBSERVED",
      step_id: "pii-vault",
    },
    {
      classification: "PERSON",
      handling_action: "TOKENIZE",
      source: "DLP_DETECTOR",
      source_version: "builtin-TOKENIZE-bundle-pii-pii-vault",
      detector_adapter_id: "pii-local",
      detector_provider: "PRESIDIO",
      trust_level: "RUNTIME_OBSERVED",
      step_id: "pii-vault",
    },
    {
      classification: "CUSTOMER",
      handling_action: "TOKENIZE",
      source: "DLP_DETECTOR",
      source_version: "builtin-TOKENIZE-bundle-pii-pii-vault",
      trust_level: "RUNTIME_OBSERVED",
      step_id: "pii-vault",
    },
  ])
  assert.equal(chain.requiresBufferedResponse?.("request"), true)
  assert.equal(chain.requiresBufferedResponse?.("response"), false)
  const restored = await chain.restoreJson(context, protectedResult.body)
  assert.deepEqual(JSON.parse(Buffer.from(restored.body).toString("utf8")), original)
})

test("mixed Presidio and regex tokenization does not re-tokenize generated token references", async () => {
  const original = { input: "alice@example.com" }
  const runtime: ProcessorAdapterRuntime = {
    resolveSafetyAdapter() {
      throw new Error("unexpected safety resolution")
    },
    resolvePresidioAdapter(): PresidioAdapterClient {
      return {
        adapterId: "pii-mixed",
        endpoint: "http://127.0.0.1:16801/analyze",
        async analyze(input) {
          return input.text === original.input
            ? [{ start: 0, end: original.input.length, score: 1, entity_type: "EMAIL_ADDRESS" }]
            : []
        },
      }
    },
  }
  const chain = createProcessorChain([{
    step_id: "mixed-tokenization",
    hooks: {
      request: {
        action: "TOKENIZE",
        config: {
          patterns: [{ name: "PLACEHOLDER", expression: "<[^>]+>" }],
          token_ttl_seconds: 600,
          detector: {
            adapter_id: "pii-mixed",
            language: "en",
            entities: ["EMAIL_ADDRESS"],
            score_threshold: 0.5,
          },
        },
      },
      response: { action: "RESTORE" },
    },
  }], new MemoryVault(), "bundle-mixed", { adapterRuntime: runtime })

  const protectedResult = await chain.protectJson(context, Buffer.from(JSON.stringify(original)))
  const encoded = Buffer.from(protectedResult.body).toString("utf8")
  assert.match(encoded, /<EMAIL_ADDRESS:[A-Za-z0-9_-]{8}>/)
  assert.doesNotMatch(encoded, /<PLACEHOLDER:/)
  assert.deepEqual(protectedResult.dataClassifications?.map((receipt) => receipt.classification), ["EMAIL_ADDRESS"])

  const restored = await chain.restoreJson(context, protectedResult.body)
  assert.deepEqual(JSON.parse(Buffer.from(restored.body).toString("utf8")), original)
})

test("mixed Presidio and regex spans form one restorable source union", async () => {
  const original = { input: "customer:alice@example.com" }
  const runtime: ProcessorAdapterRuntime = {
    resolveSafetyAdapter() {
      throw new Error("unexpected safety resolution")
    },
    resolvePresidioAdapter(): PresidioAdapterClient {
      return {
        adapterId: "pii-overlap",
        endpoint: "http://127.0.0.1:16801/analyze",
        async analyze(input) {
          const email = "alice@example.com"
          const start = input.text.indexOf(email)
          return start >= 0
            ? [{ start, end: start + email.length, score: 1, entity_type: "EMAIL_ADDRESS" }]
            : []
        },
      }
    },
  }
  const chain = createProcessorChain([{
    step_id: "mixed-overlap",
    hooks: {
      request: {
        action: "TOKENIZE",
        config: {
          patterns: [{ name: "CUSTOMER_EMAIL", expression: "customer:[^\\s]+" }],
          token_ttl_seconds: 600,
          detector: {
            adapter_id: "pii-overlap",
            language: "en",
            entities: ["EMAIL_ADDRESS"],
            score_threshold: 0.5,
          },
        },
      },
      response: { action: "RESTORE" },
    },
  }], new MemoryVault(), "bundle-mixed-overlap", { adapterRuntime: runtime })

  const protectedResult = await chain.protectJson(context, Buffer.from(JSON.stringify(original)))
  const encoded = Buffer.from(protectedResult.body).toString("utf8")
  assert.match(encoded, /<CUSTOMER_EMAIL:[A-Za-z0-9_-]{8}>/)
  assert.doesNotMatch(encoded, /alice@example\.com/)
  assert.deepEqual(
    protectedResult.dataClassifications?.map((receipt) => receipt.classification).sort(),
    ["CUSTOMER_EMAIL", "EMAIL_ADDRESS"],
  )
  assert.equal(
    protectedResult.dataClassifications?.find((receipt) => receipt.classification === "EMAIL_ADDRESS")?.detector_provider,
    "PRESIDIO",
  )

  const restored = await chain.restoreJson(context, protectedResult.body)
  assert.deepEqual(JSON.parse(Buffer.from(restored.body).toString("utf8")), original)
})

test("Presidio redaction unions transitive different-start overlaps without leaking a tail", async () => {
  const runtime: ProcessorAdapterRuntime = {
    resolveSafetyAdapter() {
      throw new Error("unexpected safety resolution")
    },
    resolvePresidioAdapter(): PresidioAdapterClient {
      return {
        adapterId: "pii-overlap",
        endpoint: "http://127.0.0.1:16801/analyze",
        async analyze(input) {
          assert.equal(input.text, "0123456789ABC")
          return [
            { start: 0, end: 2, score: 1, entity_type: "PREFIX" },
            { start: 1, end: 10, score: 1, entity_type: "SECRET" },
            { start: 9, end: 13, score: 1, entity_type: "TAIL" },
          ]
        },
      }
    },
  }
  const chain = createProcessorChain([{
    step_id: "redact-overlap",
    hooks: {
      request: {
        action: "REDACT",
        config: {
          patterns: [],
          token_ttl_seconds: 600,
          detector: {
            adapter_id: "pii-overlap",
            language: "en",
            entities: ["PREFIX", "SECRET", "TAIL"],
            score_threshold: 0.5,
          },
        },
      },
    },
  }], new MemoryVault(), "bundle-overlap", { adapterRuntime: runtime })

  const result = await chain.protectJson(context, Buffer.from(JSON.stringify({ input: "0123456789ABC" })))

  assert.equal(result.disposition, "CONTINUE")
  assert.deepEqual(JSON.parse(Buffer.from(result.body).toString("utf8")), {
    input: "[REDACTED:PREFIX]",
  })
  assert.doesNotMatch(Buffer.from(result.body).toString("utf8"), /0123456789ABC|23456789ABC/)
  assert.deepEqual(result.matches, ["PREFIX", "SECRET", "TAIL"])
  assert.deepEqual(result.dataClassifications, [
    {
      classification: "PREFIX",
      handling_action: "REDACT",
      source: "DLP_DETECTOR",
      source_version: "builtin-REDACT-bundle-overlap-redact-overlap",
      detector_adapter_id: "pii-overlap",
      detector_provider: "PRESIDIO",
      trust_level: "RUNTIME_OBSERVED",
      step_id: "redact-overlap",
    },
    {
      classification: "SECRET",
      handling_action: "REDACT",
      source: "DLP_DETECTOR",
      source_version: "builtin-REDACT-bundle-overlap-redact-overlap",
      detector_adapter_id: "pii-overlap",
      detector_provider: "PRESIDIO",
      trust_level: "RUNTIME_OBSERVED",
      step_id: "redact-overlap",
    },
    {
      classification: "TAIL",
      handling_action: "REDACT",
      source: "DLP_DETECTOR",
      source_version: "builtin-REDACT-bundle-overlap-redact-overlap",
      detector_adapter_id: "pii-overlap",
      detector_provider: "PRESIDIO",
      trust_level: "RUNTIME_OBSERVED",
      step_id: "redact-overlap",
    },
  ])
})
