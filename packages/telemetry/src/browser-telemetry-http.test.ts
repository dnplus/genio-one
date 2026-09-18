import test from "node:test"
import assert from "node:assert/strict"
import Fastify from "fastify"
import { registerBrowserTelemetry } from "./browser-telemetry-http"
import { flushOtel } from "./otlp-observability"

test("browser telemetry uses the verified identity and preserves the incoming trace", async () => {
  const originalOrigin = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  const originalFetch = globalThis.fetch
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://browser-collector.test"
  const sent: any[] = []
  globalThis.fetch = (async (_input, init) => { sent.push(JSON.parse(String(init?.body))); return Response.json({}) }) as typeof fetch
  const app = Fastify()
  registerBrowserTelemetry(app, { path: "/telemetry", service: "browser-test", principal: async request => { if (!request.headers.authorization) throw new Error("unauthorized"); return { tenant_id: "trusted-tenant", subject_id: "trusted-subject" } } })
  const payload = { events: [{ id: "event-1", name: "http.client", traceId: "a".repeat(32), spanId: "b".repeat(16), startedAt: 1000, endedAt: 1100, status: 200, attributes: { tenant_id: "forged", password: "secret" } }] }
  try {
    assert.equal((await app.inject({ method: "POST", url: "/telemetry", payload })).statusCode, 401)
    assert.equal((await app.inject({ method: "POST", url: "/telemetry", payload, headers: { authorization: "verified-by-test" } })).statusCode, 202)
    await flushOtel()
    assert.ok(sent.some(packet => packet.resourceLogs))
    assert.ok(sent.some(packet => packet.resourceMetrics))
    const resource = sent.find(packet => packet.resourceSpans).resourceSpans[0]
    assert.equal(resource.resource.attributes.find((attribute: any) => attribute.key === "genio.tenant.id").value.stringValue, "trusted-tenant")
    assert.equal(resource.scopeSpans[0].spans[0].traceId, "a".repeat(32))
    assert.equal(JSON.stringify(sent).includes('"secret"'), false)
  } finally { await app.close(); globalThis.fetch = originalFetch; if (originalOrigin === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT; else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalOrigin }
})
