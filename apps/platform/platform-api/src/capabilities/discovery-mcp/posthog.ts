import { createHash } from "node:crypto"
import type { DiscoveryMcpCompletion } from "../../../../../connectors/discovery/server"

import type { PostHogIntegrationStore } from "../posthog-integration/module"

const DISTINCT_ID = "genio-one-discovery"
const MAX_SUCCESSFUL_CAPTURES = 10_000

type CaptureEvent = "$mcp_tool_call" | "$ai_span"
type CaptureProperties = Record<string, string | number | boolean>

export interface DiscoveryMcpPostHogEvent {
  tenantId: string
  correlationId: string
  completionId: string
  tool: "search_resources" | "get_resource"
  resultCount: number
  latencyMillis: number
  statusCode: number
  outcome: "COMPLETED" | "FAILED"
  errorCode: DiscoveryMcpCompletion["errorCode"]
  occurredAt: number
}

export interface DiscoveryMcpPostHogSink {
  capture(event: DiscoveryMcpPostHogEvent): Promise<void>
}

export interface DiscoveryMcpPostHogSinkOptions {
  integrations: Pick<PostHogIntegrationStore, "get">
  request?: typeof fetch
  timeoutMillis?: number
}

interface CaptureRequest {
  api_key: string
  event: CaptureEvent
  distinct_id: string
  uuid: string
  timestamp: string
  properties: CaptureProperties
}

function scopedHash(namespace: string, tenantId: string, value: string): string {
  return createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(tenantId)
    .update("\0")
    .update(value)
    .digest("hex")
}

function captureUuid(event: DiscoveryMcpPostHogEvent, captureEvent: CaptureEvent): string {
  const digest = createHash("sha256")
    .update("platform-discovery")
    .update("\0")
    .update(event.tenantId)
    .update("\0")
    .update(event.completionId)
    .update("\0")
    .update(event.tool)
    .update("\0")
    .update(captureEvent)
    .digest()
  digest[6] = (digest[6]! & 0x0f) | 0x40
  digest[8] = (digest[8]! & 0x3f) | 0x80
  const hex = digest.subarray(0, 16).toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function captureKey(host: string, projectId: number, uuid: string): string {
  return createHash("sha256")
    .update(host)
    .update("\0")
    .update(String(projectId))
    .update("\0")
    .update(uuid)
    .digest("hex")
}

function contextProperties(event: DiscoveryMcpPostHogEvent): CaptureProperties {
  return {
    $process_person_profile: false,
    $geoip_disable: true,
    $ai_trace_id: scopedHash("platform-discovery-trace", event.tenantId, event.correlationId).slice(0, 32),
    $mcp_server_name: "genio-one-discovery",
    server: "genio-one-discovery",
    source: "platform_discovery",
    tenant_hash: scopedHash("tenant", event.tenantId, "tenant").slice(0, 32),
    correlation_hash: scopedHash("platform-discovery-correlation", event.tenantId, event.correlationId).slice(0, 32),
    outcome: event.outcome,
    status_code: event.statusCode,
    result_count: event.resultCount,
  }
}

function captureProperties(event: DiscoveryMcpPostHogEvent, captureEvent: CaptureEvent): CaptureProperties {
  const failed = event.statusCode >= 400 || event.outcome === "FAILED" || event.errorCode !== null
  const properties: CaptureProperties = {
    ...contextProperties(event),
    $mcp_tool_name: event.tool,
    $mcp_is_error: failed,
    $ai_is_error: failed,
    $ai_span_id: scopedHash("platform-discovery-span", event.tenantId, `${event.completionId}\0${event.tool}`).slice(0, 16),
    $ai_latency: event.latencyMillis / 1_000,
    $ai_http_status: event.statusCode,
  }
  if (captureEvent === "$mcp_tool_call") {
    properties.$mcp_duration_ms = event.latencyMillis
  } else {
    properties.$ai_span_name = event.tool
  }
  if (event.errorCode) properties.error_code = event.errorCode
  return properties
}

export function createDiscoveryMcpPostHogSink(
  options: DiscoveryMcpPostHogSinkOptions,
): DiscoveryMcpPostHogSink {
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

  function captureOnce(input: { key: string; url: URL; body: CaptureRequest }): Promise<void> {
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
    async capture(event) {
      const integration = await options.integrations.get({ tenantId: event.tenantId })
      if (!integration.enabled || !integration.host || !integration.project_id || !integration.project_token) return
      const url = new URL("/i/v0/e/", integration.host)
      const captures: CaptureEvent[] = ["$mcp_tool_call", "$ai_span"]
      await Promise.all(captures.map((captureEvent) => {
        const body: CaptureRequest = {
          api_key: integration.project_token!,
          event: captureEvent,
          distinct_id: DISTINCT_ID,
          uuid: captureUuid(event, captureEvent),
          timestamp: new Date(event.occurredAt * 1_000).toISOString(),
          properties: captureProperties(event, captureEvent),
        }
        return captureOnce({
          key: captureKey(integration.host!, integration.project_id!, body.uuid),
          url,
          body,
        })
      }))
    },
  }
}
