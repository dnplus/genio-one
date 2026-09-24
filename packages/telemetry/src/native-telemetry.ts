import { randomBytes } from "node:crypto"
import { persistOtel } from "./otlp-observability"

type NativeIdentity = { tenantId?: string; subjectId?: string; runtimeSessionId?: string }

const CLAIMED_IDENTITY_KEYS = new Set(["genio.tenant.id", "genio.subject.id", "genio.runtime.session.id"])

export function removeClaimedIdentity(value: any): void {
  if (!value || typeof value !== "object") return
  if (Array.isArray(value.attributes)) {
    value.attributes = value.attributes.filter((attribute: any) => !attribute || !CLAIMED_IDENTITY_KEYS.has(attribute.key))
  }
  for (const key in value) {
    if (key === "attributes") continue
    const nested = value[key]
    if (nested && typeof nested === "object") {
      if (Array.isArray(nested)) {
        for (let i = 0; i < nested.length; i++) {
          removeClaimedIdentity(nested[i])
        }
      } else {
        removeClaimedIdentity(nested)
      }
    }
  }
}

function plainAnyValue(value: any): unknown {
  if (!value || typeof value !== "object") return value
  if ("stringValue" in value) return value.stringValue
  if ("boolValue" in value) return value.boolValue
  if ("intValue" in value) return Number.isSafeInteger(Number(value.intValue)) ? Number(value.intValue) : String(value.intValue)
  if ("doubleValue" in value) return value.doubleValue
  if ("bytesValue" in value) return value.bytesValue
  if (value.arrayValue) return (value.arrayValue.values ?? []).map(plainAnyValue)
  if (value.kvlistValue) return Object.fromEntries((value.kvlistValue.values ?? []).map((entry: any) => [entry?.key, plainAnyValue(entry?.value)]))
  return null
}

// Only the receiver's own loopback capability is removed; credential redaction runs in the collector.
// A structured attribute value (kvlist/array) is flattened to its JSON string — how ClickHouse
// stores it anyway — because the collector's rules only read string attribute values and cannot
// walk nested maps, so {request.headers: {authorization: …}} would otherwise bypass them.
function sanitizeTelemetry(value: unknown, capability: string): unknown {
  if (typeof value === "string") return value.replaceAll(capability, "[REDACTED]")
  if (Array.isArray(value)) return value.map(item => sanitizeTelemetry(item, capability))
  if (!value || typeof value !== "object") return value
  const source = value as Record<string, any>
  if (typeof source.key === "string" && (source.value?.kvlistValue || source.value?.arrayValue)) {
    return { ...source, value: { stringValue: JSON.stringify(plainAnyValue(source.value)).replaceAll(capability, "[REDACTED]") } }
  }
  return Object.fromEntries(Object.entries(source).map(([key, item]) => [key, sanitizeTelemetry(item, capability)]))
}

export function createNativeTelemetryReceiver(options: { origin: string; identity: NativeIdentity; persist?: typeof persistOtel }) {
  const capability = randomBytes(24).toString("hex")
  const persist = options.persist ?? persistOtel
  const pathRegex = new RegExp(`^/${capability}/v1/(logs|traces|metrics)$`)
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 16 * 1024 * 1024, async fetch(request) {
    const signal = new URL(request.url).pathname.match(pathRegex)?.[1] as "logs" | "traces" | "metrics" | undefined
    if (request.method !== "POST" || !signal) return new Response(null, { status: 404 })
    if (!request.headers.get("content-type")?.includes("application/json")) return new Response(null, { status: 415 })
    let body: Record<string, any>
    try { body = sanitizeTelemetry(await request.json(), capability) as Record<string, any> } catch { return new Response(null, { status: 400 }) }
    const key = { logs: "resourceLogs", traces: "resourceSpans", metrics: "resourceMetrics" }[signal]
    if (!body || !Array.isArray(body[key])) return new Response(null, { status: 400 })
    removeClaimedIdentity(body)
    const trusted: Record<string, string> = { "genio.tenant.id": options.identity.tenantId ?? "unassigned", "genio.telemetry.source": "native-runtime" }
    if (options.identity.subjectId) trusted["genio.subject.id"] = options.identity.subjectId
    if (options.identity.runtimeSessionId) trusted["genio.runtime.session.id"] = options.identity.runtimeSessionId
    const trustedAttributes = Object.entries(trusted).map(([key, stringValue]) => ({ key, value: { stringValue } }))

    for (const group of body[key]) {
      group.resource ??= {}
      const attributes = group.resource.attributes
      const filtered = Array.isArray(attributes) ? attributes.filter((attribute: any) => !(attribute?.key in trusted)) : []
      group.resource.attributes = filtered.concat(trustedAttributes)
    }
    const saved = await persist(signal, body, options.origin)
    return Response.json({}, { status: saved ? 200 : 503 })
  } })
  return { origin: `http://127.0.0.1:${server.port}/${capability}`, close: () => server.stop(true) }
}
