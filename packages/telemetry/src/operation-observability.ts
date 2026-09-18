import { createHash } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"
import { exportOtel, otelResource, observabilityOrigin, recordHttpObservation, traceIdentity } from "./otlp-observability"
import { sanitizeGatewayDetailBody } from "./otlp-detail-capture"

export interface ObservationContext { traceId: string; spanId: string; correlationId: string; tenantId: string }
export const observationContext = new AsyncLocalStorage<ObservationContext>()
const wrapped = new WeakSet<object>()
const attr = (key: string, value: string) => ({ key, value: { stringValue: value } })

export function observationEvidence(value: unknown): string {
  try {
    if (typeof value === "string") { try { value = JSON.parse(value) } catch {} }
    const serializable = value instanceof Response ? { status: value.status, content_type: value.headers.get("content-type"), body: "STREAM_NOT_CONSUMED_BY_OBSERVER" } : value
    const json = JSON.stringify(serializable, (_key, item) => typeof item === "bigint" ? String(item) : item)
    const bytes = Buffer.from(json ?? "null")
    const captured = sanitizeGatewayDetailBody(bytes, "application/json")
    return JSON.stringify({ ...captured, availability: captured.disposition === "OMITTED" ? "OMITTED_UNSUPPORTED_FORMAT" : captured.redacted ? "REDACTED" : "CAPTURED", original_bytes: bytes.length, captured_bytes: Buffer.byteLength(captured.value), truncated: false })
  } catch { return JSON.stringify({ availability: "UNSERIALIZABLE" }) }
}

export function observationReference(value: unknown): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(value)
  const bytes = Buffer.from(serialized ?? "null")
  let content = value
  if (typeof value === "string") { try { content = JSON.parse(value) } catch {} }
  const records = Array.isArray(content) ? content : content && typeof content === "object" ? Object.values(content).find(Array.isArray) ?? [] : []
  return JSON.stringify({ availability: "EXISTING_TELEMETRY_REFERENCE", original_bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), record_count: records.length, references: records.map((record: any) => ({ trace_id: record?.trace_id, span_id: record?.span_id, record_id: record?.record_id })) })
}

export function observeOperation<T>(service: string, operation: string, input: unknown, run: () => T): T {
  if (!observabilityOrigin()) return run()
  const parent = observationContext.getStore()
  const identity = traceIdentity(parent ? `00-${parent.traceId}-${parent.spanId}-01` : undefined)
  const candidates = Array.isArray(input) ? input : [input]
  const value = (candidates.find(item => item && typeof item === "object" && (item.tenantId || item.tenant_id || item.principal || item.correlationId || item.correlation_id)) ?? {}) as Record<string, unknown>
  const detail = (value.event ?? value.value ?? value.input ?? value) as Record<string, unknown>
  const principal = value.principal as { tenant_id?: string } | undefined
  const context = { traceId: identity.traceId, spanId: identity.spanId, correlationId: String(detail.correlationId ?? detail.correlation_id ?? value.correlationId ?? value.correlation_id ?? parent?.correlationId ?? identity.traceId), tenantId: String(value.tenantId ?? value.tenant_id ?? principal?.tenant_id ?? parent?.tenantId ?? process.env.GENIO_ONE_TENANT_ID ?? "unassigned") }
  const startedAt = BigInt(Date.now()) * 1_000_000n
  const resource = otelResource(service, context.tenantId)
  const attributes = [attr("genio.correlation.id", context.correlationId), attr("genio.operation", operation), attr("genio.input", observationEvidence(input))]
  exportOtel("logs", { resourceLogs: [{ resource, scopeLogs: [{ scope: { name: "genio.operation" }, logRecords: [{ timeUnixNano: String(startedAt), traceId: identity.traceId, spanId: identity.spanId, severityNumber: 9, severityText: "INFO", body: { stringValue: `${operation}.started` }, attributes }] }] }] })
  const finish = (output: unknown, error?: unknown, failed = false) => {
    const endedAt = BigInt(Date.now()) * 1_000_000n
    const fields = [...attributes, attr("genio.outcome", failed ? "FAILED" : "COMPLETED"), attr(failed ? "genio.error" : "genio.output", (operation.startsWith("traces.") && !failed ? observationReference(output) : observationEvidence(error instanceof Error ? { name: error.name, message: error.message, stack: error.stack, cause: error.cause } : failed ? error : output)))]
    exportOtel("traces", { resourceSpans: [{ resource, scopeSpans: [{ scope: { name: "genio.operation" }, spans: [{ ...identity, name: operation, kind: 1, startTimeUnixNano: String(startedAt), endTimeUnixNano: String(endedAt), attributes: fields, status: { code: failed ? 2 : 1 } }] }] }] })
    exportOtel("logs", { resourceLogs: [{ resource, scopeLogs: [{ scope: { name: "genio.operation" }, logRecords: [{ timeUnixNano: String(endedAt), traceId: identity.traceId, spanId: identity.spanId, severityNumber: failed ? 17 : 9, severityText: failed ? "ERROR" : "INFO", body: { stringValue: `${operation}.${failed ? "failed" : "completed"}` }, attributes: fields }] }] }] })
  }
  return observationContext.run(context, () => {
    try {
      const result = run()
      if (result && typeof (result as { then?: unknown }).then === "function") return Promise.resolve(result).then(value => { finish(value); return value }, error => { finish(undefined, error, true); throw error }) as T
      finish(result)
      return result
    } catch (error) { finish(undefined, error, true); throw error }
  })
}

export function instrumentModuleGraph(modules: Record<string, unknown>, service: string) {
  if (!observabilityOrigin()) return
  for (const [name, value] of Object.entries(modules)) {
    if (name === "sql" || !value || typeof value !== "object" || wrapped.has(value)) continue
    wrapped.add(value)
    const module = value as Record<string, unknown>
    const prototype = Object.getPrototypeOf(module)
    const methods = new Set(prototype && prototype !== Object.prototype ? Object.getOwnPropertyNames(prototype) : Object.keys(module))
    for (const method of methods) {
      if (method === "constructor") continue
      const implementation = module[method]
      if (typeof implementation !== "function") continue
      module[method] = (...args: unknown[]) => observeOperation(service, `${name}.${method}`, args.length === 1 ? args[0] : args, () => implementation.apply(module, args))
    }
  }
}

export function observedFetch(service: string, input: string | URL | Request, init?: RequestInit): Promise<Response> {
  if (!observabilityOrigin()) return fetch(input, init)
  const request = new Request(input, init)
  const url = new URL(request.url)
  let body: unknown = init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : typeof init?.body === "string" ? init.body : request.body ? "REQUEST_STREAM_NOT_CAPTURED" : null
  if (typeof init?.body === "string") { try { body = JSON.parse(init.body) } catch {} }
  return observeOperation(service, "http.client", { correlationId: request.headers.get("x-genio-correlation-id") ?? request.headers.get("x-request-id") ?? undefined, tenantId: url.pathname.match(/\/v1\/tenants\/([^/]+)/)?.[1], method: request.method, query: Object.fromEntries(url.searchParams), body, origin: url.origin, path: url.pathname.replace(/(\/mcp\/)[A-Za-z0-9_.-]+$/, "$1:configuration") }, () => {
    const context = observationContext.getStore()
    if (context) {
      request.headers.set("traceparent", `00-${context.traceId}-${context.spanId}-01`)
      request.headers.set("x-genio-correlation-id", context.correlationId)
    }
    const { body: _body, headers: _headers, ...transportOptions } = init ?? {}
    return fetch(request, { ...transportOptions, headers: request.headers })
  })
}

export function observeIncomingRequest<T>(service: string, request: Request, run: () => T): T {
  if (!observabilityOrigin()) return run()
  const identity = traceIdentity(request.headers.get("traceparent"))
  const correlationId = request.headers.get("x-genio-correlation-id") ?? request.headers.get("x-request-id") ?? identity.traceId
  const tenantId = process.env.GENIO_ONE_TENANT_ID ?? "unassigned"
  const startedAt = BigInt(Date.now()) * 1_000_000n
  const path = new URL(request.url).pathname.replace(/(\/mcp\/)[A-Za-z0-9_.-]+$/, "$1:configuration")
  const finish = (result: unknown, failed = false) => recordHttpObservation({ service, tenantId, ...identity, correlationId, method: request.method, route: path, status: failed ? 500 : result instanceof Response ? result.status : 200, startedAt, endedAt: BigInt(Date.now()) * 1_000_000n })
  return observationContext.run({ ...identity, correlationId, tenantId }, () => {
    try {
      const result = observeOperation(service, "request.handle", { method: request.method, path }, run)
      if (result && typeof (result as { then?: unknown }).then === "function") return Promise.resolve(result).then(value => { finish(value); return value }, error => { finish(undefined, true); throw error }) as T
      finish(result)
      return result
    } catch (error) { finish(undefined, true); throw error }
  })
}
