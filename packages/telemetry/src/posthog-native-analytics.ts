import { createHash } from "node:crypto"
import type { NativeTelemetryAcceptedLog } from "./native-telemetry"

export type NativePostHogEventName = "$ai_generation" | "$ai_span"
export type NativePostHogProperties = Record<string, string | number | boolean>
export type PostHogNativeRequest = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface NativePostHogCapture {
  event: NativePostHogEventName
  distinct_id: string
  uuid: string
  timestamp: string
  properties: NativePostHogProperties
}

export interface PostHogNativeAnalyticsOptions {
  tenantId: string
  runtimeId?: string
  accessToken: string
  platformOrigin?: string
  enabled?: boolean
  request?: PostHogNativeRequest
  timeoutMillis?: number
  bindingTtlMillis?: number
  maxQueue?: number
  retryBaseMillis?: number
  retryMaxMillis?: number
  report?: (event: Record<string, unknown>) => void
}

export interface PostHogNativeAnalytics {
  accept(logs: NativeTelemetryAcceptedLog[]): void
  flush(): Promise<void>
  close(): Promise<void>
  updateAccessToken?(accessToken: string): void
}

interface PostHogBinding {
  host: "https://us.i.posthog.com" | "https://eu.i.posthog.com"
  projectId: number
  projectToken: string
}

interface PendingCapture {
  capture: NativePostHogCapture
  key: string
}

const posthogHosts = new Set<PostHogBinding["host"]>([
  "https://us.i.posthog.com",
  "https://eu.i.posthog.com",
])
const posthogProjectToken = /^phc_[A-Za-z0-9_-]+$/
const maximumSuccessfulCaptures = 10_000
const maximumConversationContexts = 10_000
const defaultQueueSize = 1_024
const defaultBindingTtlMillis = 30_000
const defaultRetryBaseMillis = 100
const defaultRetryMaxMillis = 30_000
const defaultTimeoutMillis = 5_000

function reportEvent(report: (event: Record<string, unknown>) => void, event: Record<string, unknown>) {
  try { report(event) } catch {}
}

function scopedHash(namespace: string, tenantId: string, ...values: string[]): string {
  const hash = createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(tenantId)
  for (const value of values) hash.update("\0").update(value)
  return hash.digest("hex")
}

function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V, maximum: number) {
  map.set(key, value)
  if (map.size > maximum) map.delete(map.keys().next().value!)
}

function uuidFromHash(hash: string): string {
  const bytes = Buffer.from(hash.slice(0, 32), "hex")
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function stableNativePostHogUuid(input: {
  tenantId: string
  conversationId?: string
  eventTimestamp?: string
  traceId?: string
  spanId?: string
  operation?: string
  event: NativePostHogEventName
}): string {
  return uuidFromHash(scopedHash(
    "native-posthog-event",
    input.tenantId,
    input.conversationId ?? "",
    input.eventTimestamp ?? "",
    input.traceId ?? "",
    input.spanId ?? "",
    input.operation ?? "",
    input.event,
  ))
}

function normalizedProvider(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (trimmed?.toLowerCase().replace(/\s+/g, " ") === "genioone ai gateway") return "genio_one"
  const normalized = trimmed?.toLowerCase().replaceAll("-", "_")
  return normalized || undefined
}

function numericTimestamp(value: string | number | undefined): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value !== "string" || !value.trim()) return undefined
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : undefined
}

function timestampValue(value: string | number | undefined): string | undefined {
  const numeric = numericTimestamp(value)
  if (numeric !== undefined) {
    const milliseconds = numeric >= 1e17 ? numeric / 1e6 : numeric >= 1e14 ? numeric / 1e3 : numeric >= 1e11 ? numeric : numeric * 1e3
    const date = new Date(milliseconds)
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
  }
  if (typeof value !== "string") return undefined
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

function bindingValue(value: unknown): PostHogBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    record.enabled !== true ||
    typeof record.host !== "string" ||
    !posthogHosts.has(record.host as PostHogBinding["host"]) ||
    typeof record.project_id !== "number" ||
    !Number.isSafeInteger(record.project_id) ||
    record.project_id <= 0 ||
    typeof record.project_token !== "string" ||
    !posthogProjectToken.test(record.project_token)
  ) return null
  return {
    host: record.host as PostHogBinding["host"],
    projectId: record.project_id,
    projectToken: record.project_token,
  }
}

function traceIdFor(
  event: NativeTelemetryAcceptedLog,
  tenantId: string,
  traces: Map<string, string>,
): string | undefined {
  const conversationId = event.conversationId
  if (!conversationId) return event.traceId ? scopedHash("trace-fallback", tenantId, event.traceId).slice(0, 32) : undefined
  const promptTimestamp = event.userPromptTimestamp ?? ((event.eventKind === "user_prompt" || event.eventName === "codex.user_prompt") ? event.eventTimestamp : undefined)
  if (promptTimestamp !== undefined) {
    const canonicalPromptTimestamp = String(promptTimestamp)
    const traceId = scopedHash("trace", tenantId, conversationId, canonicalPromptTimestamp).slice(0, 32)
    setBoundedMap(traces, conversationId, traceId, maximumConversationContexts)
    return traceId
  }
  return traces.get(conversationId) ?? scopedHash("trace-conversation", tenantId, conversationId).slice(0, 32)
}

function contextProperties(input: {
  event: NativeTelemetryAcceptedLog
  tenantId: string
  runtimeId?: string
  traces: Map<string, string>
}): { properties: NativePostHogProperties; timestamp: string; identity: { conversationId?: string; traceId?: string } } | null {
  const timestamp = timestampValue(input.event.eventTimestamp) ?? timestampValue(input.event.userPromptTimestamp) ?? input.event.observedTimestamp
  if (!timestamp) return null
  const traceId = traceIdFor(input.event, input.tenantId, input.traces)
  if (!traceId) return null
  const properties: NativePostHogProperties = {
    $process_person_profile: false,
    $geoip_disable: true,
    tenant_id: input.tenantId,
    $ai_trace_id: traceId,
  }
  if (input.runtimeId) properties.runtime_id = input.runtimeId
  if (input.event.conversationId) properties.$ai_session_id = scopedHash("session", input.tenantId, input.event.conversationId).slice(0, 32)
  return { properties, timestamp, identity: { conversationId: input.event.conversationId, traceId } }
}

export function nativePostHogCaptures(input: {
  event: NativeTelemetryAcceptedLog
  tenantId: string
  runtimeId?: string
  provider?: string
  traces?: Map<string, string>
}): NativePostHogCapture[] {
  const traces = input.traces ?? new Map<string, string>()
  const context = contextProperties({ ...input, traces })
  if (!context) return []
  const conversationId = context.identity.conversationId
  const eventTimestamp = timestampValue(input.event.eventTimestamp) ?? timestampValue(input.event.userPromptTimestamp) ?? input.event.observedTimestamp
  if (!conversationId || !eventTimestamp) return []
  const eventIdentityTimestamp = input.event.eventTimestamp !== undefined
    ? String(input.event.eventTimestamp)
    : input.event.userPromptTimestamp !== undefined
      ? String(input.event.userPromptTimestamp)
      : input.event.observedTimestamp ?? eventTimestamp
  const captures: NativePostHogCapture[] = []
  const provider = normalizedProvider(input.event.provider ?? input.event.providerName ?? input.provider)
  const responseEvent = input.event.eventName === "codex.sse_event" && ["response.completed", "response.failed", "response.incomplete", "response.error"].includes(input.event.eventKind ?? "")
  if (
    responseEvent &&
    input.event.model &&
    provider !== undefined &&
    provider !== "genio_one"
  ) {
    const properties: NativePostHogProperties = {
      ...context.properties,
      $ai_model: input.event.model,
      $ai_is_error: input.event.eventKind !== "response.completed",
    }
    if (provider) properties.$ai_provider = provider
    if (input.event.inputTokenCount !== undefined) properties.$ai_input_tokens = input.event.inputTokenCount
    if (input.event.outputTokenCount !== undefined) properties.$ai_output_tokens = input.event.outputTokenCount
    if (input.event.cachedTokenCount !== undefined) properties.$ai_cache_read_input_tokens = input.event.cachedTokenCount
    if (input.event.reasoningTokenCount !== undefined) properties.$ai_reasoning_tokens = input.event.reasoningTokenCount
    if (input.event.ttftMs !== undefined) properties.$ai_time_to_first_token = input.event.ttftMs / 1_000
    captures.push({
      event: "$ai_generation",
      distinct_id: `genioone-native-${input.tenantId}`,
      uuid: stableNativePostHogUuid({ tenantId: input.tenantId, conversationId, eventTimestamp: eventIdentityTimestamp, traceId: input.event.traceId, spanId: input.event.spanId, operation: input.event.operation, event: "$ai_generation" }),
      timestamp: eventTimestamp,
      properties,
    })
  }
  if (responseEvent && !input.event.model && input.event.eventKind !== "response.completed" && provider !== "genio_one") {
    const spanName = "turn"
    captures.push({
      event: "$ai_span",
      distinct_id: `genioone-native-${input.tenantId}`,
      uuid: stableNativePostHogUuid({ tenantId: input.tenantId, conversationId, eventTimestamp: eventIdentityTimestamp, traceId: input.event.traceId, spanId: input.event.spanId, operation: spanName, event: "$ai_span" }),
      timestamp: eventTimestamp,
      properties: {
        ...context.properties,
        $ai_span_name: spanName,
        $ai_span_id: scopedHash("turn-span", input.tenantId, conversationId, eventTimestamp, input.event.traceId ?? "", input.event.spanId ?? "").slice(0, 16),
        $ai_is_error: true,
      },
    })
  }
  if (input.event.eventName === "codex.tool_result") {
    const spanKey = input.event.callId ?? input.event.operation ?? input.event.toolName ?? input.event.spanId ?? "tool"
    const properties: NativePostHogProperties = {
      ...context.properties,
      $ai_span_name: input.event.toolName ?? "tool",
      $ai_span_id: scopedHash("span", input.tenantId, conversationId, eventTimestamp, input.event.traceId ?? "", input.event.spanId ?? "", spanKey).slice(0, 16),
    }
    if (input.event.parentSpanId) properties.$ai_parent_id = scopedHash("parent-span", input.tenantId, input.event.parentSpanId).slice(0, 16)
    if (input.event.toolName) properties.$mcp_tool_name = input.event.toolName
    if (input.event.mcpServer) properties.$mcp_server_name = input.event.mcpServer
    if (input.event.durationMs !== undefined) properties.$ai_latency = input.event.durationMs / 1_000
    if (input.event.success !== undefined) properties.$ai_is_error = !input.event.success
    captures.push({
      event: "$ai_span",
      distinct_id: `genioone-native-${input.tenantId}`,
      uuid: stableNativePostHogUuid({ tenantId: input.tenantId, conversationId, eventTimestamp: eventIdentityTimestamp, traceId: input.event.traceId, spanId: input.event.spanId, operation: spanKey, event: "$ai_span" }),
      timestamp: eventTimestamp,
      properties,
    })
  }
  return captures
}

function enabledValue(value: boolean | undefined, environment: NodeJS.ProcessEnv = process.env): boolean {
  if (value !== undefined) return value
  const configured = environment.GENIO_ONE_POSTHOG_NATIVE_ANALYTICS?.trim().toLowerCase()
  return configured !== "0" && configured !== "false" && configured !== "off" && configured !== "disabled"
}

class NativePostHogAnalytics implements PostHogNativeAnalytics {
  private readonly request: PostHogNativeRequest
  private readonly report: (event: Record<string, unknown>) => void
  private readonly platformOrigin: string
  private readonly traces = new Map<string, string>()
  private readonly providers = new Map<string, string>()
  private readonly queue: PendingCapture[] = []
  private readonly queued = new Set<string>()
  private readonly successful = new Map<string, true>()
  private readonly waiters: Array<() => void> = []
  private binding: PostHogBinding | null | undefined
  private bindingAt = 0
  private bindingLoading: Promise<PostHogBinding | null> | undefined
  private pumping = false
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private retryAttempt = 0
  private closed = false
  private deliveryStopped = false
  private authenticationFailed = false
  private accessToken: string

  constructor(private readonly options: PostHogNativeAnalyticsOptions) {
    this.request = options.request ?? globalThis.fetch
    this.report = options.report ?? (event => { process.stderr.write(`${JSON.stringify(event)}\n`) })
    this.platformOrigin = (options.platformOrigin ?? process.env.GENIO_ONE_PLATFORM_ORIGIN ?? "http://127.0.0.1:58082").replace(/\/$/, "")
    this.accessToken = options.accessToken
  }

  accept(logs: NativeTelemetryAcceptedLog[]) {
    if (this.closed || !enabledValue(this.options.enabled) || !this.options.tenantId || !this.accessToken) return
    for (const event of logs) {
      const conversationProvider = event.conversationId ? this.providers.get(event.conversationId) : undefined
      const eventProvider = normalizedProvider(event.provider ?? event.providerName)
      if (event.eventName === "codex.conversation_starts" && event.conversationId && eventProvider) setBoundedMap(this.providers, event.conversationId, eventProvider, maximumConversationContexts)
      const captures = nativePostHogCaptures({ event, tenantId: this.options.tenantId, runtimeId: this.options.runtimeId, provider: eventProvider ?? conversationProvider, traces: this.traces })
      for (const capture of captures) {
        const key = `${capture.event}\0${capture.uuid}`
        if (this.successful.has(key) || this.queued.has(key)) continue
        if (this.queue.length >= (this.options.maxQueue ?? defaultQueueSize)) {
          reportEvent(this.report, { event: "posthog.native.queue_dropped", reason: "memory_capacity", queued: this.queue.length })
          continue
        }
        this.queued.add(key)
        this.queue.push({ capture, key })
      }
    }
    void this.pump()
  }

  private async loadBinding(): Promise<PostHogBinding | null> {
    if (this.authenticationFailed) return null
    const ttl = this.options.bindingTtlMillis ?? defaultBindingTtlMillis
    if (this.binding !== undefined && Date.now() - this.bindingAt < ttl) return this.binding
    if (this.bindingLoading) return this.bindingLoading
    this.bindingLoading = (async () => {
      let url: URL
      try { url = new URL(`/v1/tenants/${encodeURIComponent(this.options.tenantId)}/telemetry/posthog/browser-configuration`, this.platformOrigin) } catch { return null }
      let response: Response
      try {
        response = await this.request(url, {
          method: "GET",
          headers: { accept: "application/json", authorization: `Bearer ${this.accessToken}` },
          signal: AbortSignal.timeout(this.options.timeoutMillis ?? defaultTimeoutMillis),
        })
      } catch {
        reportEvent(this.report, { event: "posthog.native.binding_error", reason: "request_failed" })
        throw new Error("POSTHOG_BINDING_REQUEST_FAILED")
      }
      if (response.status === 401 || response.status === 403) {
        this.authenticationFailed = true
        reportEvent(this.report, { event: "posthog.native.binding_error", status: response.status })
        return null
      }
      if (!response.ok) {
        reportEvent(this.report, { event: "posthog.native.binding_error", status: response.status })
        throw new Error(`POSTHOG_BINDING_HTTP_${response.status}`)
      }
      const configuration = bindingValue(await response.json().catch(() => null))
      this.binding = configuration
      this.bindingAt = Date.now()
      return configuration
    })()
    try { return await this.bindingLoading } finally { this.bindingLoading = undefined }
  }

  private async send(pending: PendingCapture, binding: PostHogBinding): Promise<"sent" | "drop"> {
    let response: Response
    try {
      response = await this.request(new URL("/i/v0/e/", binding.host), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: binding.projectToken,
          event: pending.capture.event,
          distinct_id: pending.capture.distinct_id,
          uuid: pending.capture.uuid,
          timestamp: pending.capture.timestamp,
          properties: pending.capture.properties,
        }),
        signal: AbortSignal.timeout(this.options.timeoutMillis ?? defaultTimeoutMillis),
      })
    } catch {
      reportEvent(this.report, { event: "posthog.native.delivery_error", reason: "request_failed" })
      throw new Error("POSTHOG_DELIVERY_REQUEST_FAILED")
    }
    if (response.ok) return "sent"
    reportEvent(this.report, { event: "posthog.native.delivery_error", status: response.status })
    if (response.status === 401 || response.status === 403) {
      this.authenticationFailed = true
      return "drop"
    }
    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) return "drop"
    throw new Error(`POSTHOG_DELIVERY_HTTP_${response.status}`)
  }

  private notifyIdle() {
    if (this.queue.length || this.pumping || this.retryTimer) return
    const waiters = this.waiters.splice(0)
    for (const resolve of waiters) resolve()
  }

  private scheduleRetry() {
    if (this.deliveryStopped || this.retryTimer) return
    const base = this.options.retryBaseMillis ?? defaultRetryBaseMillis
    const maximum = this.options.retryMaxMillis ?? defaultRetryMaxMillis
    const delay = Math.min(maximum, base * 2 ** Math.min(this.retryAttempt, 8))
    this.retryAttempt += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      void this.pump()
    }, delay)
    this.retryTimer.unref?.()
  }

  private async pump() {
    if (this.deliveryStopped || this.pumping || this.retryTimer || !this.queue.length || !enabledValue(this.options.enabled)) {
      this.notifyIdle()
      return
    }
    this.pumping = true
    try {
      while (this.queue.length) {
        const pending = this.queue[0]!
        let binding: PostHogBinding | null
        try { binding = await this.loadBinding() } catch { this.scheduleRetry(); break }
        if (!binding || this.authenticationFailed) {
          this.queue.shift()
          this.queued.delete(pending.key)
          continue
        }
        try {
          const result = await this.send(pending, binding)
          this.queue.shift()
          this.queued.delete(pending.key)
          if (result === "sent") {
            this.successful.set(pending.key, true)
            if (this.successful.size > maximumSuccessfulCaptures) this.successful.delete(this.successful.keys().next().value!)
            this.retryAttempt = 0
          }
        } catch {
          this.scheduleRetry()
          break
        }
      }
    } finally {
      this.pumping = false
      this.notifyIdle()
    }
  }

  flush(): Promise<void> {
    if (!this.queue.length && !this.pumping && !this.retryTimer) return Promise.resolve()
    return new Promise(resolve => this.waiters.push(resolve))
  }

  async close(): Promise<void> {
    this.closed = true
    const pending = this.flush()
    const deadline = this.options.timeoutMillis ?? defaultTimeoutMillis
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      pending,
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, deadline)
      }),
    ])
    if (timer) clearTimeout(timer)
    if (this.queue.length) {
      this.deliveryStopped = true
      if (this.retryTimer) {
        clearTimeout(this.retryTimer)
        this.retryTimer = undefined
      }
      reportEvent(this.report, { event: "posthog.native.queue_remaining", queued: this.queue.length })
      const waiters = this.waiters.splice(0)
      for (const resolve of waiters) resolve()
    }
  }

  updateAccessToken(accessToken: string) {
    const token = accessToken.trim()
    if (!token || token === this.accessToken) return
    this.accessToken = token
    this.authenticationFailed = false
    this.binding = undefined
    this.bindingAt = 0
    void this.pump()
  }
}

export function createPostHogNativeAnalytics(options: PostHogNativeAnalyticsOptions): PostHogNativeAnalytics {
  return new NativePostHogAnalytics(options)
}
