import { createHash } from "node:crypto"

import type { GatewayActivityEvent } from "./contract"
import type { PostHogIntegrationStore } from "../posthog-integration/module"

export const POSTHOG_GATEWAY_ACTIVITY_DISTINCT_ID = "genioone-gateway-activity"

type CaptureProperties = Record<string, string | number | boolean>

interface PostHogCapture {
  event: "$ai_generation" | "$mcp_tool_call" | "$ai_span"
  properties: CaptureProperties
}

interface PostHogCaptureRequest {
  api_key: string
  event: PostHogCapture["event"]
  distinct_id: string
  uuid: string
  timestamp: string
  properties: CaptureProperties
}

const MAX_SUCCESSFUL_CAPTURES = 10_000

export interface PostHogGatewayActivitySink {
  capture(input: { event: GatewayActivityEvent }): Promise<void>
}

export interface PostHogGatewayActivitySinkOptions {
  integrations: Pick<PostHogIntegrationStore, "get">
  request?: typeof fetch
  timeoutMillis?: number
}

function contextProperties(input: {
  event: GatewayActivityEvent
}): CaptureProperties {
  const traceId = scopedHash({
    namespace: "trace",
    tenantId: input.event.tenant_id,
    value: input.event.correlation_id,
  }).slice(0, 32)
  const properties: CaptureProperties = {
    $process_person_profile: false,
    $geoip_disable: true,
    tenant_id: input.event.tenant_id,
    resource_id: input.event.resource_id,
    status_code: input.event.status_code,
    $ai_trace_id: traceId,
  }
  if (input.event.session_id) {
    properties.$ai_session_id = scopedHash({
      namespace: "session",
      tenantId: input.event.tenant_id,
      value: input.event.session_id,
    }).slice(0, 32)
  }
  return properties
}

function scopedHash(input: {
  namespace: string
  tenantId: string
  value: string
}): string {
  return createHash("sha256")
    .update(input.namespace)
    .update("\0")
    .update(input.tenantId)
    .update("\0")
    .update(input.value)
    .digest("hex")
}

function isError(event: GatewayActivityEvent): boolean {
  return event.status_code >= 400 || event.outcome === "FAILED" || event.error_code !== null
}

function spanId(event: GatewayActivityEvent, namespace: "generation" | "tool"): string {
  return scopedHash({
    namespace: `${namespace}-span`,
    tenantId: event.tenant_id,
    value: event.correlation_id,
  }).slice(0, 16)
}

function generationProperties(event: GatewayActivityEvent, context: CaptureProperties): CaptureProperties {
  const properties: CaptureProperties = {
    ...context,
    $ai_model: event.effective_model_id!,
    $ai_span_id: spanId(event, "generation"),
    $ai_http_status: event.status_code,
    $ai_is_error: isError(event),
  }
  if (event.provider_id) properties.$ai_provider = event.provider_id
  if (event.latency_millis !== null) properties.$ai_latency = event.latency_millis / 1_000
  if (event.input_tokens !== null) properties.$ai_input_tokens = event.input_tokens
  if (event.output_tokens !== null) properties.$ai_output_tokens = event.output_tokens
  if (event.total_tokens !== null) properties.$ai_total_tokens = event.total_tokens
  return properties
}

function capturesForGatewayActivity(input: {
  event: GatewayActivityEvent
}): PostHogCapture[] {
  const { event } = input
  const context = contextProperties(input)
  const captures: PostHogCapture[] = []
  if (event.upstream_attempted && event.effective_model_id) {
    captures.push({
      event: "$ai_generation",
      properties: generationProperties(event, context),
    })
  }
  if (event.mcp_tool) {
    const properties: CaptureProperties = {
      ...context,
      $mcp_tool_name: event.mcp_tool,
      $mcp_is_error: isError(event),
    }
    if (event.mcp_backend) properties.$mcp_server_name = event.mcp_backend
    if (event.latency_millis !== null) properties.$mcp_duration_ms = event.latency_millis
    captures.push({ event: "$mcp_tool_call", properties })
    const spanProperties: CaptureProperties = {
      ...context,
      $ai_span_name: event.mcp_tool,
      $ai_span_id: spanId(event, "tool"),
      $ai_http_status: event.status_code,
      $ai_is_error: isError(event),
      $mcp_tool_name: event.mcp_tool,
    }
    if (event.mcp_backend) spanProperties.$mcp_server_name = event.mcp_backend
    if (event.upstream_attempted && event.effective_model_id) {
      spanProperties.$ai_parent_id = spanId(event, "generation")
    }
    if (event.latency_millis !== null) spanProperties.$ai_latency = event.latency_millis / 1_000
    captures.push({ event: "$ai_span", properties: spanProperties })
  }
  return captures
}

function captureUuid(input: {
  tenantId: string
  correlationId: string
  event: PostHogCapture["event"]
}): string {
  const digest = createHash("sha256")
    .update(input.tenantId)
    .update("\0")
    .update(input.correlationId)
    .update("\0")
    .update(input.event)
    .digest()
  digest[6] = (digest[6]! & 0x0f) | 0x80
  digest[8] = (digest[8]! & 0x3f) | 0x80
  const hex = digest.subarray(0, 16).toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function captureKey(input: {
  host: string
  projectId: number
  uuid: string
}): string {
  return createHash("sha256")
    .update(input.host)
    .update("\0")
    .update(String(input.projectId))
    .update("\0")
    .update(input.uuid)
    .digest("hex")
}

export function createPostHogGatewayActivitySink(
  options: PostHogGatewayActivitySinkOptions,
): PostHogGatewayActivitySink {
  const request = options.request ?? globalThis.fetch
  const timeoutMillis = options.timeoutMillis ?? 5_000
  const successfulCaptures = new Map<string, true>()
  const inFlightCaptures = new Map<string, Promise<void>>()

  function recordSuccessfulCapture(key: string) {
    successfulCaptures.set(key, true)
    if (successfulCaptures.size > MAX_SUCCESSFUL_CAPTURES) {
      successfulCaptures.delete(successfulCaptures.keys().next().value!)
    }
  }

  function captureOnce(input: {
    key: string
    url: URL
    body: PostHogCaptureRequest
  }): Promise<void> {
    if (successfulCaptures.has(input.key)) return Promise.resolve()
    const inFlight = inFlightCaptures.get(input.key)
    if (inFlight) return inFlight

    const attempted = (async () => {
      const response = await request(input.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input.body),
        signal: AbortSignal.timeout(timeoutMillis),
      })
      if (!response.ok) throw new Error(`PostHog capture failed (${response.status})`)
      recordSuccessfulCapture(input.key)
    })()
    const tracked = attempted.finally(() => {
      if (inFlightCaptures.get(input.key) === tracked) inFlightCaptures.delete(input.key)
    })
    inFlightCaptures.set(input.key, tracked)
    return tracked
  }

  return {
    async capture({ event }) {
      const integration = await options.integrations.get({ tenantId: event.tenant_id })
      if (
        !integration.enabled ||
        !integration.host ||
        !integration.project_id ||
        !integration.project_token
      ) return
      const host = integration.host
      const projectId = integration.project_id
      const projectToken = integration.project_token
      const captures = capturesForGatewayActivity({ event })
      if (captures.length === 0) return
      const url = new URL("/i/v0/e/", host)
      const timestamp = new Date(event.occurred_at * 1_000).toISOString()
      await Promise.all(captures.map((capture) => {
        const body: PostHogCaptureRequest = {
          api_key: projectToken,
          event: capture.event,
          distinct_id: POSTHOG_GATEWAY_ACTIVITY_DISTINCT_ID,
          uuid: captureUuid({
            tenantId: event.tenant_id,
            correlationId: event.correlation_id,
            event: capture.event,
          }),
          timestamp,
          properties: capture.properties,
        }
        return captureOnce({
          key: captureKey({
            host,
            projectId,
            uuid: body.uuid,
          }),
          url,
          body,
        })
      }))
    },
  }
}
