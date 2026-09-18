import { randomBytes } from "node:crypto"
import { persistOtel } from "./otlp-observability"
import { sanitizeGatewayDetailBody } from "./otlp-detail-capture"

type NativeIdentity = { tenantId?: string; subjectId?: string; runtimeSessionId?: string }

function sanitizeTelemetry(value: unknown, capability: string): unknown {
  if (typeof value === "string") return value.replaceAll(capability, "[REDACTED]")
  if (Array.isArray(value)) return value.map(item => sanitizeTelemetry(item, capability))
  if (!value || typeof value !== "object") return value
  const source = value as Record<string, unknown>
  if (typeof source.key === "string" && source.value && typeof source.value === "object") {
    const attributeValue = source.value as Record<string, unknown>
    const plain = attributeValue.stringValue ?? attributeValue.intValue ?? attributeValue.doubleValue ?? attributeValue.boolValue ?? attributeValue
    const captured = sanitizeGatewayDetailBody(Buffer.from(JSON.stringify({ [source.key]: plain })), "application/json")
    const clean = JSON.parse(captured.value)[source.key]
    if (clean !== plain && typeof clean === "string") return { ...source, value: { stringValue: clean } }
  }
  if (typeof source.stringValue === "string") {
    const captured = sanitizeGatewayDetailBody(Buffer.from(JSON.stringify({ value: source.stringValue })), "application/json")
    return { ...source, stringValue: String(JSON.parse(captured.value).value).replaceAll(capability, "[REDACTED]") }
  }
  return Object.fromEntries(Object.entries(source).map(([key, item]) => [key, sanitizeTelemetry(item, capability)]))
}

export function createNativeTelemetryReceiver(options: { origin: string; identity: NativeIdentity; persist?: typeof persistOtel }) {
  const capability = randomBytes(24).toString("hex")
  const persist = options.persist ?? persistOtel
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 16 * 1024 * 1024, async fetch(request) {
    const signal = new URL(request.url).pathname.match(new RegExp(`^/${capability}/v1/(logs|traces|metrics)$`))?.[1] as "logs" | "traces" | "metrics" | undefined
    if (request.method !== "POST" || !signal) return new Response(null, { status: 404 })
    if (!request.headers.get("content-type")?.includes("application/json")) return new Response(null, { status: 415 })
    let body: Record<string, any>
    try { body = sanitizeTelemetry(await request.json(), capability) as Record<string, any> } catch { return new Response(null, { status: 400 }) }
    const key = { logs: "resourceLogs", traces: "resourceSpans", metrics: "resourceMetrics" }[signal]
    if (!body || !Array.isArray(body[key])) return new Response(null, { status: 400 })
    const removeClaimedIdentity = (value: any): void => {
      if (!value || typeof value !== "object") return
      if (Array.isArray(value.attributes)) value.attributes = value.attributes.filter((attribute: any) => !["genio.tenant.id", "genio.subject.id", "genio.runtime.session.id"].includes(attribute.key))
      for (const nested of Object.values(value)) { if (Array.isArray(nested)) for (const item of nested) removeClaimedIdentity(item); else if (nested && typeof nested === "object") removeClaimedIdentity(nested) }
    }
    removeClaimedIdentity(body)
    for (const group of body[key]) {
      group.resource ??= {}
      const trusted: Record<string, string> = { "genio.tenant.id": options.identity.tenantId ?? "unassigned", "genio.telemetry.source": "native-runtime" }
      if (options.identity.subjectId) trusted["genio.subject.id"] = options.identity.subjectId
      if (options.identity.runtimeSessionId) trusted["genio.runtime.session.id"] = options.identity.runtimeSessionId
      group.resource.attributes = [...(group.resource.attributes ?? []).filter((attribute: any) => !(attribute.key in trusted)), ...Object.entries(trusted).map(([key, stringValue]) => ({ key, value: { stringValue } }))]
    }
    const saved = await persist(signal, body, options.origin)
    return Response.json({}, { status: saved ? 200 : 503 })
  } })
  return { origin: `http://127.0.0.1:${server.port}/${capability}`, close: () => server.stop(true) }
}
