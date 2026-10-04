import type { GatewayAuthorizationAuditStore } from "../audit-events/module"
import type { ResourceConnectionRegistry } from "../connections/module"
import type { GatewayActivityEvent, GatewayActivityIngest } from "./contract"
import type { GatewayActivityMaterializer, GatewayActivityStore } from "./module"
import type { PostHogGatewayActivitySink } from "./posthog"
import type { HttpFetch } from "../../../../../../runtimes/gateway/services/shared/http-fetch"

interface OTelAccessLogRow {
  observed_at_millis: number | string
  trace_id?: string | null
  resource_tenant_id?: string | null
  attributes: Record<string, string>
}

interface OTelMcpSpanRow {
  service_name: string | null
  trace_id: string | null
  span_id: string | null
  parent_span_id: string | null
  span_name: string | null
  span_kind: string | null
  correlation_id: string | null
  resource_tenant_id: string | null
  span_tenant_id: string | null
  http_status: string | number | null
  status_code: string | null
  mcp_method: string | null
  mcp_tool: string | null
  error_type: string | null
  has_exception_event: boolean | number | string | null
  has_exception_type: boolean | number | string | null
}

const MAX_ACTIVITY_ROWS = 2_000
const MAX_MCP_SPAN_ROWS = MAX_ACTIVITY_ROWS * 3
const TRUSTED_MCP_PROXY_SERVICE_PATTERN = "^genio-ai-mcp-gateway(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)?$"
const TRUSTED_MCP_FINAL_SERVICE_NAME = "ai-gateway"
const TRUSTED_MCP_COMPLETION_SPAN_NAME = "ingress"
const TRUSTED_MCP_COMPLETION_SPAN_KIND = "Server"
const TRUSTED_MCP_FINAL_SPAN_NAME_PREFIX = "tools/call "
const TRUSTED_MCP_FINAL_SPAN_KIND = "Client"
const MCP_TOOL_RESULT_ERROR = "MCP_TOOL_RESULT_ERROR"
const trustedMcpProxyService = new RegExp(TRUSTED_MCP_PROXY_SERVICE_PATTERN)

function databaseIdentifier(value: string): string {
  if (!/^[a-zA-Z0-9_]+$/.test(value)) {
    throw new Error(`INVALID_CLICKHOUSE_DATABASE_NAME:${value}`)
  }
  return value
}

function quote(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`
}

function integerParam<T extends number | undefined>(value: T, name: string): T {
  if (value === undefined) return value
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw Object.assign(new Error(`INVALID_ACTIVITY_QUERY_PARAMETER:${name}`), { statusCode: 400 })
  }
  return value
}

function value(attributes: Record<string, string>, name: string): string | null {
  const current = attributes[name]
  return current && current !== "-" ? current : null
}

function integer(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value !== "" && value !== "-" ? value : null
}

function outcome(status: number): GatewayActivityIngest["outcome"] {
  if (status === 401) return "UNAUTHENTICATED"
  if (status === 403) return "DENIED"
  if (status === 429) return "RATE_LIMITED"
  if (status >= 400) return "FAILED"
  return "COMPLETED"
}

function connectionId(backend: string | null): string | null {
  return backend?.match(/(connection-[a-f0-9-]+)-backend$/)?.[1] ?? null
}

function endpointHost(endpoint: string): string | null {
  try {
    const url = new URL(endpoint)
    const port = url.port || (url.protocol === "https:" ? "443" : "80")
    return `${url.hostname}:${port}`
  } catch {
    return null
  }
}

function attemptedHosts(attributes: Record<string, string>): string[] {
  return (value(attributes, "upstream_hosts_attempted") ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean)
}

export function createClickHouseGatewayActivityMaterializer(options: {
  origin: string
  database: string
  username: string
  password: string
  activities: Pick<GatewayActivityStore, "record" | "recordAttempt"> &
    Partial<Pick<GatewayActivityStore, "get">>
  audits: Pick<GatewayAuthorizationAuditStore, "query">
  connections: Pick<ResourceConnectionRegistry, "list">
  postHog?: PostHogGatewayActivitySink
  fetch?: HttpFetch
  lookbackSeconds?: number
}): GatewayActivityMaterializer {
  const request = options.fetch ?? fetch
  const origin = options.origin.replace(/\/$/, "")
  const database = databaseIdentifier(options.database)
  const authorization = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`
  const validatedLookback = integerParam(options.lookbackSeconds, "lookbackSeconds")
  const lookbackSeconds = Math.max(60, Math.min(3_600, validatedLookback ?? 900))

  async function queryMcpSpans(
    tenantId: string,
    correlationIds: readonly string[],
    ownedTraceIds: readonly string[],
  ): Promise<OTelMcpSpanRow[]> {
    if (correlationIds.length === 0) return []
    const tenantScopes = [
      `ResourceAttributes['genio.tenant.id'] = ${quote(tenantId)}`,
      `SpanAttributes['genio.tenant.id'] = ${quote(tenantId)}`,
    ]
    if (ownedTraceIds.length > 0) {
      tenantScopes.push(`(
          (empty(ResourceAttributes['genio.tenant.id']) or ResourceAttributes['genio.tenant.id'] = '-')
          and (empty(SpanAttributes['genio.tenant.id']) or SpanAttributes['genio.tenant.id'] = '-')
          and TraceId in (${ownedTraceIds.map(quote).join(", ")})
        )`)
    }
    const query = `
      select
        ServiceName as service_name,
        TraceId as trace_id,
        SpanId as span_id,
        ParentSpanId as parent_span_id,
        SpanName as span_name,
        SpanKind as span_kind,
        SpanAttributes['genio.correlation.id'] as correlation_id,
        ResourceAttributes['genio.tenant.id'] as resource_tenant_id,
        SpanAttributes['genio.tenant.id'] as span_tenant_id,
        SpanAttributes['http.status_code'] as http_status,
        StatusCode as status_code,
        SpanAttributes['mcp.method.name'] as mcp_method,
        SpanAttributes['mcp.tool.name'] as mcp_tool,
        SpanAttributes['error.type'] as error_type,
        has(Events.Name, 'exception') as has_exception_event,
        arrayExists(attributes -> attributes['exception.type'] != '' and attributes['exception.type'] != '-', Events.Attributes) as has_exception_type
      from ${database}.otel_traces
      where (
        match(ServiceName, ${quote(TRUSTED_MCP_PROXY_SERVICE_PATTERN)})
        or ServiceName = ${quote(TRUSTED_MCP_FINAL_SERVICE_NAME)}
      )
        and Timestamp >= now() - interval ${lookbackSeconds} second
        and (
          (
            match(ServiceName, ${quote(TRUSTED_MCP_PROXY_SERVICE_PATTERN)})
            and (
              (
                SpanName = ${quote(TRUSTED_MCP_COMPLETION_SPAN_NAME)}
                and SpanKind = ${quote(TRUSTED_MCP_COMPLETION_SPAN_KIND)}
                and StatusCode in ('Error', 'Ok', 'Unset')
                and SpanAttributes['http.status_code'] = '200'
              )
              or TraceId in (${ownedTraceIds.length > 0 ? ownedTraceIds.map(quote).join(", ") : quote("")})
            )
          )
          or (
            ServiceName = ${quote(TRUSTED_MCP_FINAL_SERVICE_NAME)}
            and SpanKind = ${quote(TRUSTED_MCP_FINAL_SPAN_KIND)}
            and startsWith(SpanName, ${quote(TRUSTED_MCP_FINAL_SPAN_NAME_PREFIX)})
            and StatusCode in ('Error', 'Ok', 'Unset')
            and SpanAttributes['mcp.method.name'] = 'tools/call'
          )
        )
        and (
          SpanAttributes['genio.correlation.id'] in (${correlationIds.map(quote).join(", ")})
          or TraceId in (${ownedTraceIds.length > 0 ? ownedTraceIds.map(quote).join(", ") : quote("")})
        )
        and (${tenantScopes.join(" or ")})
      order by Timestamp asc
      limit ${MAX_MCP_SPAN_ROWS}
      format JSONEachRow`
    const response = await request(`${origin}/`, {
      method: "POST",
      headers: { authorization, "content-type": "text/plain; charset=utf-8" },
      body: query,
    })
    if (!response.ok) throw new Error(`CLICKHOUSE_MCP_SPAN_QUERY_FAILED:${response.status}`)
    return (await response.text()).split("\n").filter(Boolean).map(
      (line) => JSON.parse(line) as OTelMcpSpanRow,
    )
  }

  function trustedMcpSpanState(input: {
    tenantId: string
    correlationId: string
    mcpMethod: string | null
    mcpTool: string | null
    candidates: readonly OTelAccessLogRow[]
    spans: readonly OTelMcpSpanRow[]
  }): "FAILED" | "COMPLETED" | null {
    if (input.mcpMethod !== "tools/call") return null
    const ownedTraceIds = new Set(
      input.candidates
        .filter((row) => stringValue(row.resource_tenant_id) === input.tenantId)
        .map((row) => stringValue(row.trace_id))
        .filter((traceId): traceId is string => traceId !== null),
    )
    const spanByKey = new Map<string, OTelMcpSpanRow>(
      input.spans.flatMap((span) => {
        const traceId = stringValue(span.trace_id)
        const spanId = stringValue(span.span_id)
        return traceId && spanId ? [[`${traceId}:${spanId}`, span] as const] : []
      }),
    )
    const isTenantOwned = (span: OTelMcpSpanRow): boolean => {
      const tenantIds = [span.resource_tenant_id, span.span_tenant_id]
        .map(stringValue)
        .filter((tenantId): tenantId is string => tenantId !== null)
      if (tenantIds.some((tenantId) => tenantId !== input.tenantId)) return false
      if (tenantIds.length > 0) return true
      const traceId = stringValue(span.trace_id)
      return traceId !== null && ownedTraceIds.has(traceId)
    }
    const isCorrelationOwned = (span: OTelMcpSpanRow): boolean => {
      const correlationId = stringValue(span.correlation_id)
      return correlationId === null || correlationId === input.correlationId
    }
    const isTrustedIngress = (span: OTelMcpSpanRow): boolean =>
      trustedMcpProxyService.test(stringValue(span.service_name) ?? "") &&
      span.span_name === TRUSTED_MCP_COMPLETION_SPAN_NAME &&
      span.span_kind === TRUSTED_MCP_COMPLETION_SPAN_KIND &&
      ["Error", "Ok", "Unset"].includes(span.status_code ?? "") &&
      integer(span.http_status) === 200 &&
      isTenantOwned(span) &&
      isCorrelationOwned(span)
    const hasTrustedIngressAncestor = (span: OTelMcpSpanRow): boolean => {
      const traceId = stringValue(span.trace_id)
      if (!traceId || !ownedTraceIds.has(traceId)) return false
      const visited = new Set<string>()
      let parentSpanId = stringValue(span.parent_span_id)
      while (parentSpanId !== null) {
        const key = `${traceId}:${parentSpanId}`
        if (visited.has(key)) return false
        visited.add(key)
        const parent = spanByKey.get(key)
        if (!parent) return false
        if (!isTenantOwned(parent) || !isCorrelationOwned(parent)) return false
        if (isTrustedIngress(parent)) return true
        if (!trustedMcpProxyService.test(stringValue(parent.service_name) ?? "")) return false
        parentSpanId = stringValue(parent.parent_span_id)
      }
      return false
    }
    const trusted = input.spans.filter((span) => {
      if (span.service_name !== TRUSTED_MCP_FINAL_SERVICE_NAME) return false
      if (stringValue(span.correlation_id) !== input.correlationId) return false
      if (
        span.span_kind !== TRUSTED_MCP_FINAL_SPAN_KIND ||
        !["Error", "Ok", "Unset"].includes(span.status_code ?? "") ||
        !span.span_name?.startsWith(TRUSTED_MCP_FINAL_SPAN_NAME_PREFIX) ||
        span.mcp_method !== "tools/call"
      ) return false
      if (!hasTrustedIngressAncestor(span)) return false
      const spanTool = stringValue(span.span_name?.slice(TRUSTED_MCP_FINAL_SPAN_NAME_PREFIX.length))
      if (spanTool !== input.mcpTool) return false
      const reportedTool = stringValue(span.mcp_tool)
      if (reportedTool !== null && reportedTool !== input.mcpTool) return false
      const tenantIds = [span.resource_tenant_id, span.span_tenant_id]
        .map(stringValue)
        .filter((tenantId): tenantId is string => tenantId !== null)
      if (tenantIds.some((tenantId) => tenantId !== input.tenantId)) return false
      return tenantIds.length === 0 || tenantIds.includes(input.tenantId)
    })
    if (trusted.some((span) => span.status_code === "Error")) return "FAILED"
    if (trusted.some((span) => span.status_code === "Ok")) return "COMPLETED"
    return null
  }

  return {
    async refresh({ tenantId }) {
      const query = `
        select
          toUnixTimestamp64Milli(Timestamp) as observed_at_millis,
          TraceId as trace_id,
          ResourceAttributes['genio.tenant.id'] as resource_tenant_id,
          LogAttributes as attributes
        from ${database}.otel_logs
        where ResourceAttributes['genio.tenant.id'] = ${quote(tenantId)}
          and LogAttributes['genio.event.kind'] = 'ai_gateway_activity'
          and Timestamp >= now() - interval ${lookbackSeconds} second
        order by Timestamp asc
        limit ${MAX_ACTIVITY_ROWS}
        format JSONEachRow`
      const response = await request(`${origin}/`, {
        method: "POST",
        headers: { authorization, "content-type": "text/plain; charset=utf-8" },
        body: query,
      })
      if (!response.ok) throw new Error(`CLICKHOUSE_ACTIVITY_QUERY_FAILED:${response.status}`)
      const rows = (await response.text()).split("\n").filter(Boolean).map(
        (line) => JSON.parse(line) as OTelAccessLogRow,
      )
      const grouped = new Map<string, OTelAccessLogRow[]>()
      for (const row of rows) {
        const correlationId = value(row.attributes, "x-request-id")
        if (!correlationId) continue
        grouped.set(correlationId, [...(grouped.get(correlationId) ?? []), row])
      }

      const mcpCorrelationIds = [...grouped.entries()]
        .filter(([, candidates]) => candidates.some((row) =>
          value(row.attributes, "mcp.tool.name") !== null ||
          value(row.attributes, "mcp.method.name") === "tools/call",
        ))
        .map(([correlationId]) => correlationId)
      let mcpSpans: OTelMcpSpanRow[] = []
      let mcpSpanQuerySucceeded = mcpCorrelationIds.length === 0
      if (mcpCorrelationIds.length > 0) {
        try {
          const ownedTraceIds = [...new Set(
            mcpCorrelationIds.flatMap((correlationId) =>
              (grouped.get(correlationId) ?? [])
                .filter((row) => stringValue(row.resource_tenant_id) === tenantId)
                .map((row) => stringValue(row.trace_id))
                .filter((traceId): traceId is string => traceId !== null),
            ),
          )].slice(0, MAX_ACTIVITY_ROWS)
          mcpSpans = await queryMcpSpans(
            tenantId,
            mcpCorrelationIds.slice(0, MAX_ACTIVITY_ROWS),
            ownedTraceIds,
          )
          mcpSpanQuerySucceeded = true
        } catch (error) {
          process.stderr.write(`${JSON.stringify({
            component: "gateway-activity-materializer",
            event: "mcp-span-enrichment-failed",
            reason: error instanceof Error ? error.message : "unknown",
          })}\n`)
        }
      }
      const mcpSpansByCorrelation = new Map<string, OTelMcpSpanRow[]>()
      const ownedTraceIdsByCorrelation = new Map(
        mcpCorrelationIds.map((correlationId) => [correlationId, new Set(
          (grouped.get(correlationId) ?? [])
            .filter((row) => stringValue(row.resource_tenant_id) === tenantId)
            .map((row) => stringValue(row.trace_id))
            .filter((traceId): traceId is string => traceId !== null),
        )]),
      )
      for (const span of mcpSpans) {
        const correlationIds = new Set<string>()
        const directCorrelationId = stringValue(span.correlation_id)
        if (directCorrelationId) correlationIds.add(directCorrelationId)
        const traceId = stringValue(span.trace_id)
        if (traceId) {
          for (const [correlationId, ownedTraceIds] of ownedTraceIdsByCorrelation) {
            if (ownedTraceIds.has(traceId)) correlationIds.add(correlationId)
          }
        }
        for (const correlationId of correlationIds) {
          mcpSpansByCorrelation.set(correlationId, [
            ...(mcpSpansByCorrelation.get(correlationId) ?? []),
            span,
          ])
        }
      }

      for (const [correlationId, candidates] of grouped) {
        const audit = (await options.audits.query({
          tenantId,
          correlationId,
          kind: "ONE_POLICY_DECISION",
          offset: 0,
          limit: 1,
        })).events[0]
        if (!audit || audit.kind !== "ONE_POLICY_DECISION" || !audit.resource_id || !audit.capability_id) continue
        const activityCandidates = candidates.filter(
          (row) => value(row.attributes, "genio.event.kind") === "ai_gateway_activity",
        )
        if (activityCandidates.length === 0) continue
        const connections = await options.connections.list({
          tenantId,
          resourceId: audit.resource_id,
        })
        const connectionByHost = new Map(connections.flatMap((connection) => {
          const host = endpointHost(connection.endpoint)
          return host ? [[host, connection] as const] : []
        }))
        const existing = await options.activities.get?.({ tenantId, correlationId })
        const attemptSource = activityCandidates
          .map((row) => ({
            row,
            count: integer(value(row.attributes, "upstream_request_attempt_count")) ?? 0,
            selected: connectionByHost.get(value(row.attributes, "upstream_host") ?? ""),
            connections: attemptedHosts(row.attributes).flatMap((host) => {
              const connection = connectionByHost.get(host)
              return connection ? [connection] : []
            }),
          }))
          .sort((left, right) =>
            right.count - left.count || right.connections.length - left.connections.length,
          )[0]
        const frozenCandidates = (existing?.candidate_connection_ids ?? []).flatMap((connectionId) => {
          const connection = connections.find((candidate) => candidate.connection_id === connectionId)
          return connection ? [connection] : []
        })
        const frozenAttemptConnections = attemptSource &&
          attemptSource.count > 0 &&
          frozenCandidates.length >= attemptSource.count &&
          frozenCandidates[attemptSource.count - 1]?.connection_id === attemptSource.selected?.connection_id
          ? frozenCandidates.slice(0, attemptSource.count)
          : []
        const attemptConnections = frozenAttemptConnections.length > 0
          ? frozenAttemptConnections
          : attemptSource?.connections ?? []
        for (const [index, connection] of attemptConnections.entries()) {
          const order = index + 1
          const selected = order === attemptConnections.length
          const status = attemptSource
            ? integer(value(attemptSource.row.attributes, "response_code"))
            : null
          await options.activities.recordAttempt?.({
            tenantId,
            event: {
              correlation_id: correlationId,
              attempt_id: `${correlationId}:attempt:${order}`,
              order,
              connection_id: connection.connection_id,
              connection_configuration_revision: connection.configuration_revision,
              priority: connection.routing_priority,
              outcome: selected ? "SELECTED" : "RETRIED_BEFORE_RESPONSE",
              response_started: selected && status !== null && status > 0,
              occurred_at: Math.floor(Number(attemptSource?.row.observed_at_millis ?? 0) / 1_000),
            },
          })
        }
        const selectedConnection = attemptSource?.selected ?? attemptConnections.at(-1)
        const descending = [...activityCandidates].reverse()
        const provider = descending.find((row) => value(row.attributes, "mcp.tool.name")) ??
          descending.find((row) => value(row.attributes, "mcp.method.name"))
        const main = activityCandidates.find((row) => {
          const authority = value(row.attributes, "authority")
          return authority !== null && authority !== "host.docker.internal"
        }) ?? provider ?? activityCandidates[0]
        if (!main) continue
        const status = integer(value(main.attributes, "response_code")) ??
          integer(provider ? value(provider.attributes, "response_code") : null)
        if (status === null || status < 100 || status > 599) continue
        const backend = provider ? value(provider.attributes, "mcp.provider.name") : null
        const mcpConnection = backend
          ? connections.find(
              (connection) =>
                connection.connection_kind === "MCP" &&
                connection.mcp_tool_namespace === backend,
            )
          : undefined
        const startedAt = Date.parse(value(main.attributes, "start_time") ?? "")
        const observedAttributes = activityCandidates.map((candidate) => candidate.attributes)
        const observedValue = (name: string): string | null =>
          observedAttributes.map((attributes) => value(attributes, name)).find(
            (current): current is string => current !== null,
          ) ?? null
        const mcpMethod = provider && value(provider.attributes, "mcp.tool.name")
          ? value(provider.attributes, "mcp.method.name")
          : audit.decision?.input_receipt?.mcp_method ??
            (provider ? value(provider.attributes, "mcp.method.name") : null)
        const mcpTool = audit.decision?.input_receipt?.mcp_tool ??
          (provider ? value(provider.attributes, "mcp.tool.name") : null)
        const mcpSpanState = status === 200 && mcpTool !== null
          ? trustedMcpSpanState({
              tenantId,
              correlationId,
              mcpMethod,
              mcpTool,
              candidates: activityCandidates,
              spans: mcpSpansByCorrelation.get(correlationId) ?? [],
            })
          : null
        const event: GatewayActivityIngest = {
          correlation_id: correlationId,
          resource_id: audit.resource_id,
          capability_id: audit.capability_id,
          application_id: audit.acting_client?.acting_client_id ?? null,
          subject_id: audit.subject?.subject_id ?? null,
          acting_client_id: audit.acting_client?.acting_client_id ?? null,
          entitlement_id: audit.entitlement_id ?? null,
          usage_admission_id: null,
          usage_admission_disposition: "NOT_APPLICABLE",
          usage_admission_reason: null,
          consumer_organization_id: null,
          resource_owner_organization_id: null,
          use_case_id: null,
          enforcement_point_id: audit.enforcement_point_id,
          route: "MANAGED",
          method: value(main.attributes, "method") ?? "POST",
          path: value(main.attributes, "path") ?? "/",
          status_code: status,
          outcome: mcpSpanState === "FAILED" ? "FAILED" : outcome(status),
          error_code: mcpSpanState === "FAILED"
            ? MCP_TOOL_RESULT_ERROR
            : status >= 400 ? value(main.attributes, "response_code_details") : null,
          latency_millis: integer(value(main.attributes, "duration")),
          upstream_attempted: value((provider ?? main).attributes, "upstream_host") !== null,
          requested_model_id: observedValue("gen_ai.request.model"),
          effective_model_id: observedValue("gen_ai.response.model"),
          provider_id: observedValue("gen_ai.provider.name"),
          connection_id: mcpConnection?.connection_id ?? selectedConnection?.connection_id ?? connectionId(backend),
          mcp_method: mcpMethod,
          mcp_tool: mcpTool,
          mcp_backend: backend,
          processor_bundle_revision: null,
          processor_request_steps: [],
          processor_response_steps: [],
          data_classifications: [],
          safety_decisions: [],
          input_tokens: integer(observedValue("gen_ai.usage.input_tokens")),
          output_tokens: integer(observedValue("gen_ai.usage.output_tokens")),
          total_tokens: integer(observedValue("gen_ai.usage.total_tokens")),
          route_mode: null,
          route_lease_id: null,
          route_lease_reused: null,
          routing_policy_id: null,
          routing_revision: null,
          candidate_set_digest: null,
          detail_availability: "NOT_CAPTURED",
          detail_ref: null,
          detail_expires_at: null,
          occurred_at: Number.isFinite(startedAt)
            ? Math.floor(startedAt / 1_000)
            : Math.floor(Number((provider ?? main).observed_at_millis) / 1_000),
        }
        let persisted: GatewayActivityEvent
        try {
          persisted = await options.activities.record({
            tenantId,
            event,
          })
        } catch (error) {
          process.stderr.write(`${JSON.stringify({
            component: "gateway-activity-materializer",
            event: "activity-record-rejected",
            correlation_id: correlationId,
            reason: error instanceof Error ? error.message : "unknown",
          })}\n`)
          continue
        }
        const captureMcp = mcpTool === null
          ? true
          : status === 200
            ? mcpSpanQuerySucceeded && mcpSpanState !== null
            : true
        if (captureMcp) {
          try {
            await options.postHog?.capture({ event: persisted })
          } catch {
            process.stderr.write(`${JSON.stringify({
              component: "gateway-activity-materializer",
              event: "posthog-projection-failed",
              correlation_id: correlationId,
            })}\n`)
          }
        }
      }
    },
  }
}
