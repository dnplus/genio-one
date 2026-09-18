import type { FastifyInstance, FastifyRequest } from "fastify"
import { persistOtel, observabilityOrigin } from "./otlp-observability"
import { observationEvidence } from "./operation-observability"
import type { BrowserTelemetryEvent } from "./browser-observability"

export function registerBrowserTelemetry(app: FastifyInstance, options: { path: string; service: string; principal: (request: FastifyRequest) => Promise<{ tenant_id: string; subject_id: string }> }) {
  const principals = new WeakMap<object, { tenant_id: string; subject_id: string }>()
  app.post<{ Body: { events: BrowserTelemetryEvent[] } }>(options.path, { bodyLimit: 8 * 1024 * 1024, onRequest: async (request, reply) => {
    try { principals.set(request, await options.principal(request)) } catch { return reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" }) }
  }, schema: { body: { type: "object", required: ["events"], additionalProperties: false, properties: { events: { type: "array", maxItems: 100, items: { type: "object", required: ["id", "name", "traceId", "spanId", "startedAt", "endedAt", "status", "attributes"], additionalProperties: false, properties: {
    id: { type: "string", maxLength: 128 }, name: { type: "string", maxLength: 128 }, traceId: { type: "string", pattern: "^[a-f0-9]{32}$" }, spanId: { type: "string", pattern: "^[a-f0-9]{16}$" }, startedAt: { type: "integer", minimum: 0 }, endedAt: { type: "integer", minimum: 0 }, status: { type: "integer", minimum: 0, maximum: 599 }, attributes: { type: "object", maxProperties: 64, additionalProperties: { type: "string" } },
  } } } } } } }, async (request, reply) => {
    const principal = principals.get(request)!
    const origin = observabilityOrigin()
    if (!origin) return reply.code(503).send({ error: "TELEMETRY_EXPORT_UNAVAILABLE" })
    const resource = { attributes: [{ key: "service.name", value: { stringValue: options.service } }, { key: "genio.tenant.id", value: { stringValue: principal.tenant_id } }, { key: "genio.resource.host.availability", value: { stringValue: "NOT_APPLICABLE_BROWSER" } }, { key: "genio.evidence.source", value: { stringValue: "CLIENT_REPORTED" } }] }
    const spans = request.body.events.map(event => ({ traceId: event.traceId, spanId: event.spanId, name: event.name, kind: event.name === "http.client" ? 3 : 1, startTimeUnixNano: String(BigInt(event.startedAt) * 1000000n), endTimeUnixNano: String(BigInt(Math.max(event.startedAt, event.endedAt)) * 1000000n), attributes: [
      { key: "genio.correlation.id", value: { stringValue: event.attributes.correlationId ?? event.traceId } },
      { key: "genio.event.id", value: { stringValue: event.id } }, { key: "genio.subject.id", value: { stringValue: principal.subject_id } }, { key: "genio.evidence.source", value: { stringValue: "CLIENT_REPORTED" } }, { key: "genio.browser.attributes", value: { stringValue: observationEvidence(event.attributes) } }, { key: "http.response.status_code", value: { intValue: String(event.status) } },
    ], status: { code: event.status === 0 || event.status >= 400 ? 2 : 1 } }))
    const resources = spans.map((span, index) => ({ resource: { attributes: [...resource.attributes, { key: "service.instance.id", value: { stringValue: request.body.events[index]!.attributes["browser.page_instance"] ?? "unknown" } }, { key: "genio.build.availability", value: { stringValue: "NOT_CONFIGURED" } }] }, span }))
    const scope = { name: "genio.browser", version: "1" }
    const packets = {
      traces: { resourceSpans: resources.map(({ resource, span }) => ({ resource, scopeSpans: [{ scope, spans: [span] }] })) },
      logs: { resourceLogs: resources.map(({ resource, span }) => ({ resource, scopeLogs: [{ scope, logRecords: [{ timeUnixNano: span.endTimeUnixNano, traceId: span.traceId, spanId: span.spanId, severityNumber: span.status.code === 2 ? 17 : 9, severityText: span.status.code === 2 ? "ERROR" : "INFO", body: { stringValue: span.name }, attributes: span.attributes }] }] })) },
      metrics: { resourceMetrics: resources.map(({ resource, span }) => ({ resource, scopeMetrics: [{ scope, metrics: [{ name: "browser.events", sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: [{ startTimeUnixNano: span.startTimeUnixNano, timeUnixNano: span.endTimeUnixNano, asInt: "1", attributes: [{ key: "event.name", value: { stringValue: span.name } }], exemplars: [{ timeUnixNano: span.endTimeUnixNano, asInt: "1", traceId: span.traceId, spanId: span.spanId }] }] } }] }] })) },
    }
    const saved = (await Promise.all((Object.keys(packets) as Array<keyof typeof packets>).map(signal => persistOtel(signal, packets[signal], origin)))).every(Boolean)
    return reply.code(saved ? 202 : 503).send({ accepted: saved })
  })
}
