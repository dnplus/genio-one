import assert from "node:assert/strict"
import test from "node:test"
import { recordHttpObservation, flushOtel } from "./otlp-observability"

test("recordHttpObservation exports trace, log, and correctly filtered metric attributes", async () => {
  const originalFetch = globalThis.fetch
  const originalOrigin = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector.test"

  const exported: any[] = []
  globalThis.fetch = (async (_input, init) => {
    exported.push(JSON.parse(String(init?.body)))
    return new Response("{}")
  }) as typeof fetch

  try {
    recordHttpObservation({
      service: "test-service",
      tenantId: "tenant-123",
      subjectId: "sub-456",
      method: "POST",
      route: "/api/v1/resource",
      status: 200,
      correlationId: "corr-789",
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      startedAt: 1000000000n,
      endedAt: 2000000000n,
      details: {
        "genio.request": "request-detail",
        "genio.response": "response-detail"
      }
    })

    await flushOtel()

    assert.ok(exported.length >= 3)
    const tracePayload = exported.find(p => p.resourceSpans)
    const logPayload = exported.find(p => p.resourceLogs)
    const metricPayload = exported.find(p => p.resourceMetrics)

    assert.ok(tracePayload)
    assert.ok(logPayload)
    assert.ok(metricPayload)

    const metricDataPoint = metricPayload.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints[0]
    const metricAttributeKeys = metricDataPoint.attributes.map((a: any) => a.key)

    assert.deepEqual(metricAttributeKeys.sort(), [
      "http.request.method",
      "http.response.status_code",
      "http.route"
    ].sort())
  } finally {
    globalThis.fetch = originalFetch
    if (originalOrigin === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalOrigin
  }
})
