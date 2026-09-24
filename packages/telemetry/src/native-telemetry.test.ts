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
