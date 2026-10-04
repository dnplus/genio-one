import assert from "node:assert/strict"
import test from "node:test"
import { createNativeTelemetryReceiver } from "./native-telemetry"

test("native telemetry acknowledges durable acceptance and attaches verified identity", async () => {
  const saved: any[] = []
  let available = true
  const receiver = createNativeTelemetryReceiver({ origin: "http://collector.test", identity: { tenantId: "tenant-a", subjectId: "subject-a", runtimeSessionId: "runtime-a" }, persist: async (signal, body) => { saved.push({ signal, body }); return available } })
  try {
    const body = { resourceLogs: [{ resource: { attributes: [{ key: "genio.tenant.id", value: { stringValue: "forged" } }] }, scopeLogs: [{ logRecords: [{ body: { stringValue: "completed" }, attributes: [{ key: "authorization", value: { stringValue: "secret-value" } }, { key: "gen_ai.usage.input_tokens", value: { intValue: "42" } }] }] }] }] }
    body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.push({ key: "url.full", value: { stringValue: `${receiver.origin}/v1/logs` } })
    const send = () => fetch(`${receiver.origin}/v1/logs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    assert.equal((await send()).status, 200)
    assert.equal(saved[0].body.resourceLogs[0].resource.attributes.find((item: any) => item.key === "genio.tenant.id").value.stringValue, "tenant-a")
    // Native attributes stay raw for the collector's single redaction pass; only the receiver's
    // own loopback capability (a local secret for this receiver) is removed.
    assert.ok(JSON.stringify(saved).includes("secret-value"))
    assert.equal(JSON.stringify(saved).includes(new URL(receiver.origin).pathname.slice(1)), false)
    assert.ok(JSON.stringify(saved).includes('"intValue":"42"'))
    available = false
    assert.equal((await send()).status, 503)
    assert.equal((await fetch(`${new URL(receiver.origin).origin}/v1/logs`, { method: "POST" })).status, 404)
  } finally { receiver.close() }
})

// The collector's redaction reads string attribute values only; a nested kvlist such as
// request.headers -> {authorization: …} must reach it as JSON text, not as a map it cannot walk.
test("native structured attribute values are forwarded as JSON strings", async () => {
  const saved: any[] = []
  const receiver = createNativeTelemetryReceiver({ origin: "http://collector.test", identity: { tenantId: "tenant-a" }, persist: async (signal, body) => { saved.push({ signal, body }); return true } })
  try {
    const headers = { kvlistValue: { values: [{ key: "authorization", value: { stringValue: "opaque-secret" } }, { key: "retries", value: { intValue: "2" } }, { key: "hops", value: { arrayValue: { values: [{ stringValue: "a" }, { boolValue: true }] } } }] } }
    const body = { resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ spans: [{ traceId: "a".repeat(32), spanId: "b".repeat(16), name: "tool", attributes: [{ key: "request.headers", value: headers }, { key: "plain", value: { stringValue: "kept" } }] }] }] }] }
    const response = await fetch(`${receiver.origin}/v1/traces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    assert.equal(response.status, 200)
    const attributes = saved[0].body.resourceSpans[0].scopeSpans[0].spans[0].attributes
    assert.deepEqual(attributes.find((item: any) => item.key === "request.headers").value, { stringValue: JSON.stringify({ authorization: "opaque-secret", retries: 2, hops: ["a", true] }) })
    assert.deepEqual(attributes.find((item: any) => item.key === "plain").value, { stringValue: "kept" })
  } finally { receiver.close() }
})

test("native telemetry preserves own JSON prototype fields, redaction and verified identity", async () => {
  const saved: any[] = []
  const receiver = createNativeTelemetryReceiver({ origin: "http://collector.test", identity: { tenantId: "tenant-a", subjectId: "subject-a", runtimeSessionId: "runtime-a" }, persist: async (signal, body) => { saved.push({ signal, body }); return true } })
  try {
    const body = JSON.parse(`{
      "__proto__": { "note": "root" },
      "resourceLogs": [{
        "__proto__": { "note": "group" },
        "resource": { "attributes": [
          { "key": "genio.tenant.id", "value": { "stringValue": "forged-tenant" } },
          { "key": "genio.subject.id", "value": { "stringValue": "forged-subject" } },
          { "key": "genio.runtime.session.id", "value": { "stringValue": "forged-runtime" } }
        ] },
        "scopeLogs": [{ "logRecords": [{
          "__proto__": { "note": "record" },
          "body": { "stringValue": "completed" },
          "attributes": [{ "key": "genio.tenant.id", "value": { "stringValue": "forged-record" } }]
        }] }]
      }]
    }`)
    const capability = new URL(receiver.origin).pathname.slice(1)
    body.__proto__.note += ` ${capability}`
    body.resourceLogs[0].__proto__.note += ` ${capability}`
    body.resourceLogs[0].scopeLogs[0].logRecords[0].__proto__.note += ` ${capability}`
    const response = await fetch(`${receiver.origin}/v1/logs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    assert.equal(response.status, 200)
    assert.equal(saved.length, 1)
    const persisted = saved[0].body
    const group = persisted.resourceLogs[0]
    const record = group.scopeLogs[0].logRecords[0]
    for (const [node, note] of [[persisted, "root"], [group, "group"], [record, "record"]]) {
      assert.equal(Object.hasOwn(node, "__proto__"), true)
      assert.equal(Object.getPrototypeOf(node), Object.prototype)
      assert.deepEqual(node.__proto__, { note: `${note} [REDACTED]` })
      assert.equal(Object.getPrototypeOf(node.__proto__), Object.prototype)
    }
    assert.deepEqual(group.resource.attributes, [
      { key: "genio.tenant.id", value: { stringValue: "tenant-a" } },
      { key: "genio.telemetry.source", value: { stringValue: "native-runtime" } },
      { key: "genio.subject.id", value: { stringValue: "subject-a" } },
      { key: "genio.runtime.session.id", value: { stringValue: "runtime-a" } },
    ])
    assert.deepEqual(record.attributes, [])
    assert.equal(JSON.stringify(persisted).includes(capability), false)
    assert.equal(JSON.stringify(persisted).includes("forged-"), false)
    assert.deepEqual(JSON.parse(JSON.stringify(persisted)).__proto__, { note: "root [REDACTED]" })
  } finally { receiver.close() }
})

test("native telemetry rejects signal containers stored only in JSON prototype fields", async () => {
  const saved: any[] = []
  const receiver = createNativeTelemetryReceiver({ origin: "http://collector.test", identity: { tenantId: "tenant-a" }, persist: async (signal, body) => { saved.push({ signal, body }); return true } })
  try {
    for (const [signal, container] of [["logs", "resourceLogs"], ["traces", "resourceSpans"], ["metrics", "resourceMetrics"]]) {
      const body = JSON.parse(`{"__proto__":{"${container}":[{}]}}`)
      const response = await fetch(`${receiver.origin}/v1/${signal}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      assert.equal(response.status, 400, signal)
    }
    assert.deepEqual(saved, [])
  } finally { receiver.close() }
})

test("native accepted logs callback receives only the Codex allowlist after durable acceptance", async () => {
  const accepted: unknown[] = []
  const receiver = createNativeTelemetryReceiver({
    origin: "http://collector.test",
    identity: { tenantId: "tenant-a", subjectId: "subject-a", runtimeSessionId: "runtime-a" },
    persist: async () => true,
    onAcceptedLogs: (logs) => { accepted.push(logs) },
  })
  try {
    const body = {
      resourceLogs: [{
        resource: { attributes: [] },
        scopeLogs: [{ logRecords: [{
          timeUnixNano: "1700000000000000000",
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          body: { stringValue: "codex.sse_event" },
          attributes: [
            { key: "event.kind", value: { stringValue: "response.completed" } },
            { key: "event.timestamp", value: { stringValue: "2026-10-03T00:00:00.000Z" } },
            { key: "conversation.id", value: { stringValue: "conversation-secret" } },
            { key: "model", value: { stringValue: "gpt-6-astra" } },
            { key: "input_token_count", value: { intValue: "12" } },
            { key: "output_token_count", value: { intValue: "7" } },
            { key: "prompt", value: { stringValue: "do not forward" } },
            { key: "email", value: { stringValue: "person@example.com" } },
          ],
        }] }],
      }],
    }
    const response = await fetch(`${receiver.origin}/v1/logs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    assert.equal(response.status, 200)
    await new Promise(resolve => queueMicrotask(resolve))
    assert.deepEqual(accepted, [[{
      eventName: "codex.sse_event",
      eventKind: "response.completed",
      eventTimestamp: "2026-10-03T00:00:00.000Z",
      observedTimestamp: "2023-11-14T22:13:20.000Z",
      userPromptTimestamp: undefined,
      conversationId: "conversation-secret",
      model: "gpt-6-astra",
      provider: undefined,
      providerName: undefined,
      inputTokenCount: 12,
      outputTokenCount: 7,
      cachedTokenCount: undefined,
      reasoningTokenCount: undefined,
      ttftMs: undefined,
      callId: undefined,
      toolName: undefined,
      mcpServer: undefined,
      durationMs: undefined,
      success: undefined,
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      parentSpanId: undefined,
      operation: undefined,
    }]])
    assert.equal(JSON.stringify(accepted).includes("do not forward"), false)
    assert.equal(JSON.stringify(accepted).includes("person@example.com"), false)
  } finally { receiver.close() }
})

test("native accepted logs reads Codex event names from event.name when the OTLP body is empty", async () => {
  const accepted: any[] = []
  const receiver = createNativeTelemetryReceiver({
    origin: "http://collector.test",
    identity: { tenantId: "tenant-a" },
    persist: async () => true,
    onAcceptedLogs: (logs) => { accepted.push(...logs) },
  })
  try {
    const body = {
      resourceLogs: [{
        resource: { attributes: [] },
        scopeLogs: [{ logRecords: [
          { body: {}, attributes: [
            { key: "event.name", value: { stringValue: "codex.conversation_starts" } },
            { key: "event.timestamp", value: { stringValue: "2026-10-03T00:00:00.000Z" } },
            { key: "conversation.id", value: { stringValue: "conversation-a" } },
            { key: "model", value: { stringValue: "gpt-6-luna" } },
            { key: "provider_name", value: { stringValue: "openai" } },
          ] },
          { body: {}, attributes: [
            { key: "event.name", value: { stringValue: "codex.user_prompt" } },
            { key: "event.timestamp", value: { stringValue: "2026-10-03T00:00:00.100Z" } },
            { key: "conversation.id", value: { stringValue: "conversation-a" } },
            { key: "prompt", value: { stringValue: "never forward" } },
          ] },
          { body: {}, attributes: [
            { key: "event.name", value: { stringValue: "codex.sse_event" } },
            { key: "event.kind", value: { stringValue: "response.completed" } },
            { key: "event.timestamp", value: { stringValue: "2026-10-03T00:00:01.000Z" } },
            { key: "conversation.id", value: { stringValue: "conversation-a" } },
            { key: "model", value: { stringValue: "gpt-6-luna" } },
            { key: "input_token_count", value: { intValue: "2" } },
            { key: "output_token_count", value: { intValue: "3" } },
          ] },
        ] }],
      }],
    }
    const response = await fetch(`${receiver.origin}/v1/logs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    assert.equal(response.status, 200)
    await new Promise(resolve => queueMicrotask(resolve))
    assert.deepEqual(accepted.map(event => [event.eventName, event.providerName]), [
      ["codex.conversation_starts", "openai"],
      ["codex.user_prompt", undefined],
      ["codex.sse_event", undefined],
    ])
    assert.equal(JSON.stringify(accepted).includes("never forward"), false)
  } finally { receiver.close() }
})
