import { randomBytes } from "node:crypto"
import { persistOtel } from "./otlp-observability"

type NativeIdentity = { tenantId?: string; subjectId?: string; runtimeSessionId?: string }

export interface NativeTelemetryAcceptedLog {
  eventName: "codex.sse_event" | "codex.tool_result" | "codex.conversation_starts" | "codex.user_prompt"
  eventKind?: string
  eventTimestamp?: string | number
  observedTimestamp?: string
  userPromptTimestamp?: string | number
  conversationId?: string
  model?: string
  provider?: string
  providerName?: string
  inputTokenCount?: number
  outputTokenCount?: number
  cachedTokenCount?: number
  reasoningTokenCount?: number
  ttftMs?: number
  callId?: string
  toolName?: string
  mcpServer?: string
  durationMs?: number
  success?: boolean
  traceId?: string
  spanId?: string
  parentSpanId?: string
  operation?: string
}

export type NativeTelemetryAcceptedLogHandler = (logs: NativeTelemetryAcceptedLog[]) => void | Promise<void>

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
  if (typeof value === "string") {
    return value.includes(capability) ? value.replaceAll(capability, "[REDACTED]") : value
  }
  if (Array.isArray(value)) {
    const len = value.length
    const result = new Array(len)
    for (let i = 0; i < len; i++) {
      result[i] = sanitizeTelemetry(value[i], capability)
    }
    return result
  }
  if (!value || typeof value !== "object") return value
  const source = value as Record<string, any>
  if (typeof source.key === "string" && (source.value?.kvlistValue || source.value?.arrayValue)) {
    const jsonStr = JSON.stringify(plainAnyValue(source.value))
    const redacted = jsonStr.includes(capability) ? jsonStr.replaceAll(capability, "[REDACTED]") : jsonStr
    return { ...source, value: { stringValue: redacted } }
  }
  const result: Record<string, any> = {}
  for (const key of Object.keys(source)) {
    const item = sanitizeTelemetry(source[key], capability)
    if (key === "__proto__") {
      Object.defineProperty(result, key, { value: item, enumerable: true, writable: true, configurable: true })
    } else {
      result[key] = item
    }
  }
  return result
}

function primitiveAttributeValue(value: unknown): string | number | boolean | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  if ("stringValue" in value && typeof value.stringValue === "string") return value.stringValue
  if ("boolValue" in value && typeof value.boolValue === "boolean") return value.boolValue
  if ("intValue" in value) {
    const number = Number(value.intValue)
    return Number.isSafeInteger(number) ? number : null
  }
  if ("doubleValue" in value && typeof value.doubleValue === "number" && Number.isFinite(value.doubleValue)) return value.doubleValue
  return null
}

function attributeValues(record: any): Map<string, string | number | boolean> {
  const values = new Map<string, string | number | boolean>()
  if (!Array.isArray(record?.attributes)) return values
  for (const attribute of record.attributes) {
    if (typeof attribute?.key !== "string") continue
    const value = primitiveAttributeValue(attribute.value)
    if (value !== null) values.set(attribute.key, value)
  }
  return values
}

function stringValue(values: Map<string, string | number | boolean>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = values.get(key)
    if (typeof value === "string" && value.length > 0 && value.length <= 2048) return value
  }
  return undefined
}

function stringOrNumberValue(values: Map<string, string | number | boolean>, keys: string[]): string | number | undefined {
  for (const key of keys) {
    const value = values.get(key)
    if ((typeof value === "string" && value.length > 0 && value.length <= 2048) || typeof value === "number") return value
  }
  return undefined
}

function numericValue(values: Map<string, string | number | boolean>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = values.get(key)
    const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN
    if (Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER) return number
  }
  return undefined
}

function booleanValue(values: Map<string, string | number | boolean>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = values.get(key)
    if (typeof value === "boolean") return value
    if (value === "true") return true
    if (value === "false") return false
    if (value === 1 || value === "1") return true
    if (value === 0 || value === "0") return false
  }
  return undefined
}

function nestedTimestampValue(record: any): string | number | undefined {
  for (const attribute of record?.attributes ?? []) {
    if (attribute?.key !== "user_prompt" && attribute?.key !== "prompt") continue
    const values = attribute?.value?.kvlistValue?.values
    if (!Array.isArray(values)) continue
    for (const item of values) {
      if (item?.key !== "timestamp") continue
      const value = primitiveAttributeValue(item.value)
      if (typeof value === "string" || typeof value === "number") return value
    }
  }
  return undefined
}

function observedTimestamp(record: any): string | undefined {
  const raw = record?.timeUnixNano ?? record?.observedTimeUnixNano
  if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "bigint") return undefined
  try {
    const nanos = BigInt(raw)
    if (nanos <= 0n) return undefined
    const milliseconds = Number(nanos / 1_000_000n)
    if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) return undefined
    const timestamp = new Date(milliseconds)
    return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : undefined
  } catch {
    return undefined
  }
}

function extractAcceptedLogs(body: Record<string, any>, capability?: string): NativeTelemetryAcceptedLog[] {
  const accepted: NativeTelemetryAcceptedLog[] = []
  for (const group of body.resourceLogs ?? []) {
    for (const scope of group?.scopeLogs ?? []) {
      for (const record of scope?.logRecords ?? []) {
        const values = attributeValues(record)
        const eventName = values.get("event.name") ?? record?.body?.stringValue
        if (eventName !== "codex.sse_event" && eventName !== "codex.tool_result" && eventName !== "codex.conversation_starts" && eventName !== "codex.user_prompt") continue
        const contextEvent = eventName === "codex.conversation_starts" || eventName === "codex.user_prompt"
        const event: NativeTelemetryAcceptedLog = {
          eventName: eventName as NativeTelemetryAcceptedLog["eventName"],
          eventTimestamp: stringOrNumberValue(values, ["event.timestamp"]),
          observedTimestamp: observedTimestamp(record),
          conversationId: stringValue(values, ["conversation.id"]),
          model: stringValue(values, ["model", "gen_ai.request.model"]),
          providerName: stringValue(values, ["provider_name"]),
        }
        if (!contextEvent) Object.assign(event, {
          eventKind: stringValue(values, ["event.kind"]),
          userPromptTimestamp: stringOrNumberValue(values, ["user_prompt.timestamp", "prompt.timestamp", "user_prompt_timestamp"]) ?? nestedTimestampValue(record),
          provider: stringValue(values, ["provider", "model_provider", "gen_ai.provider.name"]),
          inputTokenCount: numericValue(values, ["input_token_count"]),
          outputTokenCount: numericValue(values, ["output_token_count"]),
          cachedTokenCount: numericValue(values, ["cached_token_count"]),
          reasoningTokenCount: numericValue(values, ["reasoning_token_count"]),
          ttftMs: numericValue(values, ["ttft_ms"]),
          callId: stringValue(values, ["call_id"]),
          toolName: stringValue(values, ["tool_name"]),
          mcpServer: stringValue(values, ["mcp_server"]),
          durationMs: numericValue(values, ["duration_ms"]),
          success: booleanValue(values, ["success"]),
          traceId: typeof record?.traceId === "string" ? record.traceId : undefined,
          spanId: typeof record?.spanId === "string" ? record.spanId : undefined,
          parentSpanId: typeof record?.parentSpanId === "string" ? record.parentSpanId : undefined,
          operation: stringValue(values, ["operation.name", "operation"]),
        })
        if (capability) {
          for (const key of Object.keys(event) as Array<keyof NativeTelemetryAcceptedLog>) {
            const value = event[key]
            if (typeof value === "string") (event[key] as string) = value.replaceAll(capability, "[REDACTED]")
          }
        }
        accepted.push(event)
      }
    }
  }
  return accepted
}

export function createNativeTelemetryReceiver(options: { origin: string; identity: NativeIdentity; persist?: typeof persistOtel; onAcceptedLogs?: NativeTelemetryAcceptedLogHandler }) {
  const capability = randomBytes(24).toString("hex")
  const persist = options.persist ?? persistOtel
  const pathRegex = new RegExp(`^/${capability}/v1/(logs|traces|metrics)$`)
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 16 * 1024 * 1024, async fetch(request) {
    const signal = new URL(request.url).pathname.match(pathRegex)?.[1] as "logs" | "traces" | "metrics" | undefined
    if (request.method !== "POST" || !signal) return new Response(null, { status: 404 })
    if (!request.headers.get("content-type")?.includes("application/json")) return new Response(null, { status: 415 })
    let body: Record<string, any>
    let received: unknown
    try { received = await request.json(); body = sanitizeTelemetry(received, capability) as Record<string, any> } catch { return new Response(null, { status: 400 }) }
    const key = { logs: "resourceLogs", traces: "resourceSpans", metrics: "resourceMetrics" }[signal]
    if (!body || !Array.isArray(body[key])) return new Response(null, { status: 400 })
    const acceptedLogs = signal === "logs" && received && typeof received === "object" ? extractAcceptedLogs(received as Record<string, any>, capability) : []
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
    if (saved && acceptedLogs.length && options.onAcceptedLogs) {
      queueMicrotask(() => {
        try {
          const result = options.onAcceptedLogs!(acceptedLogs)
          if (result && typeof (result as Promise<void>).catch === "function") void (result as Promise<void>).catch(() => {})
        } catch {}
      })
    }
    return Response.json({}, { status: saved ? 200 : 503 })
  } })
  return { origin: `http://127.0.0.1:${server.port}/${capability}`, close: () => server.stop(true) }
}
