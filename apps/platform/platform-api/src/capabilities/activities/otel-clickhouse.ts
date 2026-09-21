import type { GatewayAuthorizationAuditStore } from "../audit-events/module"
import type { ResourceConnectionRegistry } from "../connections/module"
import type { GatewayActivityIngest } from "./contract"
import type { GatewayActivityMaterializer, GatewayActivityStore } from "./module"
import type { HttpFetch } from "../../../../../../runtimes/gateway/services/shared/http-fetch"

interface OTelAccessLogRow {
  observed_at_millis: number | string
  attributes: Record<string, string>
}

function quote(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`
}

function value(attributes: Record<string, string>, name: string): string | null {
  const current = attributes[name]
  return current && current !== "-" ? current : null
}

function integer(value: string | null): number | null {
  if (value === null) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
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
  fetch?: HttpFetch
  lookbackSeconds?: number
}): GatewayActivityMaterializer {
  const request = options.fetch ?? fetch
  const origin = options.origin.replace(/\/$/, "")
  const authorization = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`
  const lookbackSeconds = Math.max(60, Math.min(3_600, options.lookbackSeconds ?? 900))

  return {
    async refresh({ tenantId }) {
      const query = `
        select
          toUnixTimestamp64Milli(Timestamp) as observed_at_millis,
          LogAttributes as attributes
        from ${options.database}.otel_logs
        where ResourceAttributes['genio.tenant.id'] = ${quote(tenantId)}
          and LogAttributes['genio.event.kind'] = 'ai_gateway_activity'
          and Timestamp >= now() - interval ${lookbackSeconds} second
        order by Timestamp asc
        limit 2000
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

      for (const [correlationId, candidates] of grouped) {
        const audit = (await options.audits.query({
          tenantId,
          correlationId,
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
        try {
          await options.activities.record({
            tenantId,
            event: {
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
            outcome: outcome(status),
            error_code: status >= 400 ? value(main.attributes, "response_code_details") : null,
            latency_millis: integer(value(main.attributes, "duration")),
            upstream_attempted: value((provider ?? main).attributes, "upstream_host") !== null,
            requested_model_id: null,
            effective_model_id: null,
            provider_id: null,
            connection_id: mcpConnection?.connection_id ?? selectedConnection?.connection_id ?? connectionId(backend),
            mcp_method: provider && value(provider.attributes, "mcp.tool.name")
              ? value(provider.attributes, "mcp.method.name")
              : audit.decision?.input_receipt?.mcp_method ??
                (provider ? value(provider.attributes, "mcp.method.name") : null),
            mcp_tool: audit.decision?.input_receipt?.mcp_tool ??
              (provider ? value(provider.attributes, "mcp.tool.name") : null),
            mcp_backend: backend,
            processor_bundle_revision: null,
            processor_request_steps: [],
            processor_response_steps: [],
            data_classifications: [],
            safety_decisions: [],
            input_tokens: null,
            output_tokens: null,
            total_tokens: null,
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
            },
          })
        } catch (error) {
          process.stderr.write(`${JSON.stringify({
            component: "gateway-activity-materializer",
            event: "activity-record-rejected",
            correlation_id: correlationId,
            reason: error instanceof Error ? error.message : "unknown",
          })}\n`)
        }
      }
    },
  }
}
