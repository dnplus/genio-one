import { cleanupInactiveOtelSpools } from "./otlp-spool-cleanup"
import { hostname } from "node:os"
import { randomBytes, createHash } from "node:crypto"
import { resolve } from "node:path"
import { OtlpOutbox } from "./otlp-outbox"

const attribute = (key: string, value: string | number) => ({ key, value: typeof value === "number" ? { intValue: String(value) } : { stringValue: value } })
const METRIC_ATTRIBUTE_KEYS = new Set(["http.request.method", "http.route", "http.response.status_code"])
const outboxes = new Map<string, OtlpOutbox>()
const spoolRoots = new Map<string, Set<string>>()

export function otelResource(service: string, tenantId: string) {
  return { attributes: [attribute("service.name", service), attribute("service.instance.id", `${hostname()}:${process.pid}`), attribute("service.version", process.env.GENIO_ONE_BUILD_REVISION ?? process.env.npm_package_version ?? "unknown"), attribute("deployment.environment.name", process.env.NODE_ENV ?? "development"), attribute("host.name", hostname()), attribute("process.pid", process.pid), attribute("genio.tenant.id", tenantId), attribute("telemetry.sdk.name", "genio.otel"), attribute("telemetry.sdk.version", "1"), attribute("process.runtime.version", process.version), attribute("genio.build.availability", process.env.GENIO_ONE_BUILD_REVISION ? "CAPTURED" : "NOT_CONFIGURED")] }
}

export function observabilityOrigin(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  return (environment.OTEL_EXPORTER_OTLP_ENDPOINT || environment.GENIO_ONE_OTEL_COLLECTOR_ORIGIN || environment.GENIO_ONE_OTEL_INTERNAL_ORIGIN || (environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.replace(/\/v1\/traces$/, "")) || (environment.GENIO_ONE_GATEWAY_OTEL_HOST ? `http://${environment.GENIO_ONE_GATEWAY_OTEL_HOST}:${environment.GENIO_ONE_GATEWAY_OTEL_HTTP_PORT || "4318"}` : undefined))?.replace(/\/$/, "")
}

export function exportOtel(signal: "traces" | "logs" | "metrics", body: unknown, origin = observabilityOrigin()): void {
  if (!origin) return
  void persistOtel(signal, body, origin)
}

export function persistOtel(signal: "traces" | "logs" | "metrics", body: unknown, origin: string): Promise<boolean> {
  return outboxFor(origin).enqueue(signal, body)
}

function outboxFor(origin: string) {
  let outbox = outboxes.get(origin)
  if (!outbox) {
    const root = resolve(process.env.GENIO_ONE_OTEL_SPOOL_DIR ?? ".local/otel-outbox")
    const hash = createHash("sha256").update(origin).digest("hex").slice(0, 16)
    if (!spoolRoots.has(root)) {
      const active = new Set<string>()
      spoolRoots.set(root, active)
      const cleanup = () => { void cleanupInactiveOtelSpools(root, active).then(result => { if (result.removed) process.stderr.write(`${JSON.stringify({ event: "otel.outbox.dropped", reason: "inactive_destination_expired", batches: result.removed, bytes: result.bytes })}\n`) }).catch(() => {}) }
      const timer = setInterval(cleanup, 60000)
      timer.unref()
      queueMicrotask(cleanup)
    }
    spoolRoots.get(root)!.add(hash)
    const directory = resolve(root, hash)
    outbox = new OtlpOutbox({ directory, origin })
    outboxes.set(origin, outbox)
    const tenantId = process.env.GENIO_ONE_TENANT_ID ?? process.env.GENIO_ONE_GATEWAY_TENANT_ID ?? process.env.GENIO_ONE_BOOTSTRAP_TENANT_ID
    if (tenantId) {
      const healthTimer = setInterval(() => {
        const snapshot = outbox!.health()
        const attributes = [attribute("genio.delivery.health", JSON.stringify(snapshot)), attribute("genio.delivery.destination.id", hash)]
        void outbox!.enqueue("logs", { resourceLogs: [{ resource: otelResource(process.env.OTEL_SERVICE_NAME ?? "genio-one-telemetry-delivery", tenantId), scopeLogs: [{ scope: { name: "genio.delivery" }, logRecords: [{ timeUnixNano: String(BigInt(Date.now()) * 1000000n), severityNumber: snapshot.consecutive_failures ? 13 : 9, severityText: snapshot.consecutive_failures ? "WARN" : "INFO", body: { stringValue: "telemetry.delivery.health" }, attributes }] }] }] })
      }, 30000)
      healthTimer.unref()
    }
  }
  return outbox
}

export async function flushOtel() { await Promise.all([...outboxes.values()].map(outbox => outbox.flush())) }

export function recordHttpObservation(input: { service: string; tenantId: string; subjectId?: string; method: string; route: string; status: number; correlationId: string; traceId: string; spanId: string; parentSpanId?: string; startedAt: bigint; endedAt: bigint; details?: Record<string, string>; origin?: string }) {
  const resource = otelResource(input.service, input.tenantId)
  const attributes = [attribute("http.request.method", input.method), attribute("http.route", input.route), attribute("http.response.status_code", input.status), attribute("genio.correlation.id", input.correlationId), ...(input.subjectId ? [attribute("genio.subject.id", input.subjectId)] : []), ...Object.entries(input.details ?? {}).map(([key, value]) => attribute(key, value))]
  const scope = { name: "genio.http", version: "1" }
  exportOtel("traces", { resourceSpans: [{ resource, scopeSpans: [{ scope, spans: [{ traceId: input.traceId, spanId: input.spanId, ...(input.parentSpanId ? { parentSpanId: input.parentSpanId } : {}), name: `${input.method} ${input.route}`, kind: 2, startTimeUnixNano: String(input.startedAt), endTimeUnixNano: String(input.endedAt), attributes, status: { code: input.status >= 400 ? 2 : 1 } }] }] }] }, input.origin)
  exportOtel("logs", { resourceLogs: [{ resource, scopeLogs: [{ scope, logRecords: [{ timeUnixNano: String(input.endedAt), traceId: input.traceId, spanId: input.spanId, severityNumber: input.status >= 500 ? 17 : input.status >= 400 ? 13 : 9, severityText: input.status >= 500 ? "ERROR" : input.status >= 400 ? "WARN" : "INFO", body: { stringValue: "genio.http.request" }, attributes }] }] }] }, input.origin)
  exportOtel("metrics", { resourceMetrics: [{ resource, scopeMetrics: [{ scope, metrics: [{ name: "http.server.request.duration", unit: "s", histogram: { aggregationTemporality: 1, dataPoints: [{ startTimeUnixNano: String(input.startedAt), timeUnixNano: String(input.endedAt), count: "1", sum: Number(input.endedAt - input.startedAt) / 1e9, bucketCounts: ["1"], explicitBounds: [], attributes: attributes.filter(value => METRIC_ATTRIBUTE_KEYS.has(value.key)) }] } }] }] }] }, input.origin)
}

export function traceIdentity(traceparent: unknown) {
  const match = typeof traceparent === "string" ? /^00-([a-f0-9]{32})-([a-f0-9]{16})-[a-f0-9]{2}$/.exec(traceparent) : null
  return { traceId: match?.[1] && !/^0+$/.test(match[1]) ? match[1] : randomBytes(16).toString("hex"), spanId: randomBytes(8).toString("hex"), ...(match?.[2] && !/^0+$/.test(match[2]) ? { parentSpanId: match[2] } : {}) }
}

export function recordOperationalLog(service: string, level: "INFO" | "WARN" | "ERROR", event: string, fields: Readonly<Record<string, unknown>>) {
  const attributes: ReturnType<typeof attribute>[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) {
      attributes.push(attribute(key, typeof value === "string" || typeof value === "number" ? value : JSON.stringify(value)))
    }
  }
  exportOtel("logs", { resourceLogs: [{ resource: otelResource(`genio-one-${service}`, String(fields.tenant_id ?? process.env.GENIO_ONE_TENANT_ID ?? "unassigned")), scopeLogs: [{ scope: { name: "genio.operational" }, logRecords: [{ timeUnixNano: String(BigInt(Date.now()) * 1_000_000n), severityNumber: level === "ERROR" ? 17 : level === "WARN" ? 13 : 9, severityText: level, body: { stringValue: event }, attributes }] }] }] })
}

const configuredOrigin = observabilityOrigin()
if (configuredOrigin) outboxFor(configuredOrigin)
