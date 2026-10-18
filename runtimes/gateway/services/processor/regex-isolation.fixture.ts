import assert from "node:assert/strict"

import { DataProcessor } from "./module"
import type { ProcessorPolicy } from "./contract"
import type { ProcessorAdapterRuntime } from "../shared/processor-adapters"

const context = {
  tenantId: "regex-test", subjectId: "subject", clientId: "client",
  resourceId: "resource", capabilityId: "chat", sessionId: "session", correlationId: "regex-test",
}
const policy: ProcessorPolicy = {
  schema_version: 1, revision: "regex-test", action: "REDACT", token_ttl_seconds: 600,
  patterns: [{ name: "SECRET", expression: "^(a+)+$" }],
}
const tokenVault = { async store() {}, async resolve() { return null } }
const body = (value: unknown) => Buffer.from(JSON.stringify(value))
const attack = body("a".repeat(40) + "!")
const mode = process.argv[2]
const runtime: ProcessorAdapterRuntime = {
  resolveSafetyAdapter() { throw new Error("unexpected safety adapter") },
  resolvePresidioAdapter() {
    return {
      adapterId: "pii-test", endpoint: "http://127.0.0.1/analyze",
      async analyze() {
        return mode === "mixed-empty" ? [] : [{ start: 0, end: 1, score: 1, entity_type: "PERSON" }]
      },
    }
  },
}
const processor = new DataProcessor({
  policy: mode?.startsWith("mixed") ? {
    ...policy,
    detector: { adapter_id: "pii-test", language: "en", entities: ["PERSON"], score_threshold: 0.5 },
  } : policy,
  tokenVault, adapterRuntime: runtime,
})

if (mode === "capacity") {
  const pending = Array.from({ length: 4 }, () =>
    assert.rejects(processor.protectJson(context, attack), /REGEX_INSPECTION_TIMEOUT/))
  await assert.rejects(processor.protectJson(context, body("aaa")), /REGEX_INSPECTION_CAPACITY_EXCEEDED/)
  await Promise.all(pending)
  const recovered = await Promise.all(Array.from({ length: 4 }, () => processor.protectJson(context, body("aaa"))))
  assert.ok(recovered.every(result => result.disposition === "CONTINUE"))
} else if (mode === "budget") {
  const slow = new DataProcessor({
    policy: { ...policy, action: "TOKENIZE", patterns: [{ name: "SECRET", expression: "a" }] },
    tokenVault: {
      async store() { await Bun.sleep(150) },
      async resolve() { return null },
    },
  })
  await assert.rejects(slow.protectJson(context, body(["a", "a", "a"])), /REGEX_INSPECTION_TIMEOUT/)
} else {
  const started = Date.now()
  const blocked = assert.rejects(
    mode === "sse"
      ? processor.protectSseLine(context, `data: ${attack.toString()}`)
      : processor.protectJson(context, attack),
    /REGEX_INSPECTION_TIMEOUT/,
  )
  await Bun.sleep(50)
  const normalStarted = Date.now()
  const normal = new DataProcessor({ policy, tokenVault })
  const result = await normal.protectJson(context, body("aaa"))
  assert.equal(result.disposition, "CONTINUE")
  assert.equal(Buffer.from(result.body).toString(), JSON.stringify("[REDACTED:SECRET]"))
  assert.ok(Date.now() - normalStarted < 200, "normal request must finish before the hostile regex budget expires")
  await blocked
  assert.ok(Date.now() - started < 3_000, "hostile regex must reject within a bounded interval")
}
