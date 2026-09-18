import type { SqlAdapter } from "../../persistence/sql-adapter"
import { PlatformApiError } from "../errors"
import type {
  EndpointActivityEvent,
  EndpointActivityResourceSummary,
} from "./contract"
import type { EndpointActivityStore } from "./module"
import { canonicalDestination, endpointClient } from "./shared"

type Row = Record<string, unknown>

function text(row: Row, name: string): string {
  const value = row[name]
  return typeof value === "string" ? value : String(value ?? "")
}

function nullable(row: Row, name: string): string | null {
  const value = row[name]
  return typeof value === "string" && value ? value : null
}

function integer(value: unknown): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new PlatformApiError("ENDPOINT_ACTIVITY_DATA_INVALID", 500)
  }
  return result
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new PlatformApiError("ENDPOINT_ACTIVITY_DATA_INVALID", 500)
  }
  return value as string[]
}

function mapEvent(row: Row): EndpointActivityEvent {
  const kind = text(row, "kind")
  const resourceClass = text(row, "resource_class")
  const clientStatus = text(row, "client_status")
  const route = text(row, "route")
  if (
    (kind !== "DISCOVERY" && kind !== "USAGE") ||
    (resourceClass !== "KNOWN" && resourceClass !== "UNCLASSIFIED") ||
    (clientStatus !== "UNKNOWN" && clientStatus !== "VERIFIED") ||
    (route !== "DIRECT" && route !== "MANAGED" && route !== "BLOCK")
  ) throw new PlatformApiError("ENDPOINT_ACTIVITY_DATA_INVALID", 500)
  const actingClientId = nullable(row, "acting_client_id")
  if (clientStatus === "VERIFIED" && !actingClientId) {
    throw new PlatformApiError("ENDPOINT_ACTIVITY_DATA_INVALID", 500)
  }
  return {
    activity_id: text(row, "activity_id"),
    correlation_id: text(row, "correlation_id"),
    kind,
    tenant_id: text(row, "tenant_id"),
    subject_id: text(row, "subject_id"),
    device_id: text(row, "device_id"),
    destination_host: text(row, "destination_host"),
    resource_id: text(row, "resource_id"),
    resource_class: resourceClass,
    client: clientStatus === "VERIFIED"
      ? { status: "VERIFIED", acting_client_id: actingClientId! }
      : { status: "UNKNOWN" },
    route,
    routing_policy_rule_id: nullable(row, "routing_policy_rule_id"),
    applied_state_revision: text(row, "applied_state_revision"),
    applied_policy_version: text(row, "applied_policy_version"),
    request_count: integer(row.request_count),
    bytes_sent: integer(row.bytes_sent),
    bytes_received: integer(row.bytes_received),
    observed_at: integer(row.observed_at),
  }
}

function same(left: EndpointActivityEvent, right: {
  subjectId: string
  destination: string
  route: string
  requestCount: number
  bytesSent: number
  bytesReceived: number
  observedAt: number
  client: ReturnType<typeof endpointClient>
}): boolean {
  return left.subject_id === right.subjectId &&
    left.destination_host === right.destination &&
    left.route === right.route &&
    left.request_count === right.requestCount &&
    left.bytes_sent === right.bytesSent &&
    left.bytes_received === right.bytesReceived &&
    left.observed_at === right.observedAt &&
    JSON.stringify(left.client) === JSON.stringify(right.client)
}

export function createPostgresEndpointActivityStore(options: {
  sql: SqlAdapter
  idFactory?: () => string
}): EndpointActivityStore {
  const idFactory = options.idFactory ?? (() => `activity-${crypto.randomUUID()}`)
  return {
    async record({ tenantId, deviceId, subjectId, event }) {
      const destination = canonicalDestination(event.destination_host)
      const resourceId = `unclassified:${destination}`
      const client = endpointClient(event)
      const expected = {
        subjectId,
        destination,
        route: event.route,
        requestCount: event.request_count,
        bytesSent: event.bytes_sent,
        bytesReceived: event.bytes_received,
        observedAt: event.observed_at,
        client,
      }
      return options.sql.transaction(async (transaction) => {
        const existing = await transaction.query<Row>(
          `select * from genio_one_endpoint_activities
            where tenant_id = $1 and device_id = $2 and correlation_id = $3`,
          [tenantId, deviceId, event.correlation_id],
        )
        if (existing.rows[0]) {
          const mapped = mapEvent(existing.rows[0])
          if (!same(mapped, expected)) throw new PlatformApiError("ENDPOINT_ACTIVITY_CONFLICT", 409)
          return mapped
        }
        const prior = await transaction.query<Row>(
          `select 1 from genio_one_endpoint_activities
            where tenant_id = $1 and resource_id = $2 limit 1`,
          [tenantId, resourceId],
        )
        const inserted = await transaction.query<Row>(
          `insert into genio_one_endpoint_activities (
             tenant_id, activity_id, correlation_id, kind, subject_id, device_id,
             destination_host, resource_id, resource_class, client_status,
             acting_client_id, route, routing_policy_rule_id,
             applied_state_revision, applied_policy_version, request_count,
             bytes_sent, bytes_received, observed_at
           ) values (
             $1,$2,$3,$4,$5,$6,$7,$8,'UNCLASSIFIED',$9,$10,$11,null,$12,$13,$14,$15,$16,$17
           ) returning *`,
          [
            tenantId,
            idFactory(),
            event.correlation_id,
            prior.rows.length > 0 ? "USAGE" : "DISCOVERY",
            subjectId,
            deviceId,
            destination,
            resourceId,
            client.status,
            client.status === "VERIFIED" ? client.acting_client_id : null,
            event.route,
            event.applied_state_revision,
            event.applied_policy_version,
            event.request_count,
            event.bytes_sent,
            event.bytes_received,
            event.observed_at,
          ],
        )
        return mapEvent(inserted.rows[0]!)
      })
    },
    async inventory({ tenantId, deviceId, recentLimit }) {
      const parameters: unknown[] = [tenantId]
      const devicePredicate = deviceId ? ` and device_id = $${parameters.push(deviceId)}` : ""
      const recent = await options.sql.query<Row>(
        `select * from genio_one_endpoint_activities
          where tenant_id = $1${devicePredicate}
          order by observed_at desc, activity_id desc
          limit $${parameters.push(recentLimit)}`,
        parameters,
      )
      const summaryParameters: unknown[] = [tenantId]
      const summaryDevicePredicate = deviceId ? ` and device_id = $${summaryParameters.push(deviceId)}` : ""
      const summaries = await options.sql.query<Row>(
        `select resource_id, resource_class,
                array_agg(distinct destination_host order by destination_host) as destination_hosts,
                array_agg(distinct subject_id order by subject_id) as subjects,
                array_agg(distinct device_id order by device_id) as devices,
                jsonb_agg(distinct case
                  when client_status = 'VERIFIED' then jsonb_build_object('status', 'VERIFIED', 'acting_client_id', acting_client_id)
                  else jsonb_build_object('status', 'UNKNOWN')
                end) as clients,
                array_agg(distinct route order by route) as routes,
                min(observed_at) as first_seen_at,
                max(observed_at) as last_seen_at,
                sum(request_count) as request_count,
                sum(bytes_sent) as bytes_sent,
                sum(bytes_received) as bytes_received
           from genio_one_endpoint_activities
          where tenant_id = $1${summaryDevicePredicate}
          group by resource_id, resource_class
          order by resource_id asc`,
        summaryParameters,
      )
      return {
        resources: summaries.rows.map((row): EndpointActivityResourceSummary => ({
          resource_id: text(row, "resource_id"),
          resource_class: text(row, "resource_class") === "KNOWN" ? "KNOWN" : "UNCLASSIFIED",
          destination_hosts: strings(row.destination_hosts),
          subjects: strings(row.subjects),
          devices: strings(row.devices),
          clients: Array.isArray(row.clients)
            ? row.clients.map((value) => {
                if (
                  typeof value === "object" && value !== null &&
                  (value as Row).status === "VERIFIED" &&
                  typeof (value as Row).acting_client_id === "string"
                ) return { status: "VERIFIED" as const, acting_client_id: (value as Row).acting_client_id as string }
                if (typeof value === "object" && value !== null && (value as Row).status === "UNKNOWN") {
                  return { status: "UNKNOWN" as const }
                }
                throw new PlatformApiError("ENDPOINT_ACTIVITY_DATA_INVALID", 500)
              })
            : (() => { throw new PlatformApiError("ENDPOINT_ACTIVITY_DATA_INVALID", 500) })(),
          routes: strings(row.routes) as EndpointActivityResourceSummary["routes"],
          first_seen_at: integer(row.first_seen_at),
          last_seen_at: integer(row.last_seen_at),
          request_count: integer(row.request_count),
          bytes_sent: integer(row.bytes_sent),
          bytes_received: integer(row.bytes_received),
        })),
        recent_activity: recent.rows.map(mapEvent),
      }
    },
  }
}
