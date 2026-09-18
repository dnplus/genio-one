import assert from "node:assert/strict"
import test from "node:test"
import { createNativeTelemetryReceiver } from "./native-telemetry"

test("native telemetry acknowledges durable acceptance and attaches verified identity", async () => {
  const saved: any[] = []
  let available = true
  const receiver = createNativeTelemetryReceiver({ origin: "http://collector.test", identity: { tenantId: "tenant-a", subjectId: "subject-a", runtimeSessionId: "runtime-a" }, persist: async (signal, body) => { saved.push({ signal, body }); return available } })
  try {
    const body = { resourceLogs: [{ resource: { attributes: [{ key: "genio.tenant.id", value: { stringValue: "forged" } }] }, scopeLogs: [{ logRecords: [{ body: { stringValue: "completed" }, attributes: [{ key: "authorization", value: { stringValue: "secret-value" } }, { key: "gen_ai.usage.input_tokens", value: { intValue: "42" } }] }] }] }] }
    const send = () => fetch(`${receiver.origin}/v1/logs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    assert.equal((await send()).status, 200)
    assert.equal(saved[0].body.resourceLogs[0].resource.attributes.find((item: any) => item.key === "genio.tenant.id").value.stringValue, "tenant-a")
    assert.equal(JSON.stringify(saved).includes("secret-value"), false)
    assert.ok(JSON.stringify(saved).includes('"intValue":"42"'))
    available = false
    assert.equal((await send()).status, 503)
    assert.equal((await fetch(`${new URL(receiver.origin).origin}/v1/logs`, { method: "POST" })).status, 404)
  } finally { receiver.close() }
})
