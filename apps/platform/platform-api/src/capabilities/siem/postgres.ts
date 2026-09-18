import { randomUUID } from "node:crypto"

import type { SqlAdapter } from "../../persistence/sql-adapter"
import { PlatformApiError } from "../errors"
import type { SiemDelivery, SiemDestination } from "./contract"
import type { SiemForwarder } from "./module"
import type { HttpFetch } from "../../../../../../runtimes/gateway/services/shared/http-fetch"

type Row = Record<string, unknown>

function text(row: Row, key: string): string {
  const value = row[key]
  return typeof value === "string" ? value : String(value ?? "")
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key]
  return value === null || value === undefined ? null : text(row, key)
}

function seconds(value: unknown): number {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000)
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return Math.floor(numeric)
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0
}

function nullableSeconds(value: unknown): number | null {
  return value === null || value === undefined ? null : seconds(value)
}

function json<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T
}

function destination(row: Row): SiemDestination {
  return {
    destination_id: text(row, "destination_id"),
    endpoint_url: text(row, "endpoint_url"),
    event_kinds: json<string[]>(row.event_kinds),
    enabled: row.enabled === true || row.enabled === "true",
    configured_by: {
      subject_id: text(row, "configured_by_subject_id"),
      evidence_level: "VERIFIED",
    },
    configured_at: seconds(row.configured_at),
  }
}

function delivery(row: Row): SiemDelivery {
  const status = text(row, "status") as SiemDelivery["status"]
  return {
    tenant_id: text(row, "tenant_id"),
    destination_id: text(row, "destination_id"),
    audit_event_id: text(row, "audit_event_id"),
    endpoint_url: text(row, "endpoint_url"),
    event: json<SiemDelivery["event"]>(row.event),
    status,
    attempt_count: Number(row.attempt_count),
    next_attempt_at: seconds(row.next_attempt_at),
    lease_owner: nullableText(row, "lease_owner"),
    lease_expires_at: nullableSeconds(row.lease_expires_at),
    delivered_at: nullableSeconds(row.delivered_at),
    cancelled_at: nullableSeconds(row.cancelled_at),
    last_error_code: nullableText(row, "last_error_code"),
  }
}

const DESTINATION_COLUMNS = `destination_id, endpoint_url, event_kinds, enabled,
  configured_by_subject_id, configured_at`
const DELIVERY_COLUMNS = `tenant_id, destination_id, audit_event_id, endpoint_url, event,
  status, attempt_count, next_attempt_at, lease_owner, lease_expires_at,
  delivered_at, cancelled_at, last_error_code`

function endpoint(value: string, allowInsecureLoopback: boolean): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new PlatformApiError("SIEM_ENDPOINT_INVALID", 422)
  }
  const loopback = allowInsecureLoopback && url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "::1"].includes(url.hostname)
  if ((url.protocol !== "https:" && !loopback) || url.username || url.password) {
    throw new PlatformApiError("SIEM_ENDPOINT_INVALID", 422)
  }
  return url.toString()
}

export function createPostgresSiemForwarder(options: {
  sql: SqlAdapter
  allowInsecureLoopback?: boolean
  fetch?: HttpFetch
}): SiemForwarder {
  const send = options.fetch ?? fetch
  return {
    async getDestination({ tenantId }) {
      const result = await options.sql.query<Row>(
        `select ${DESTINATION_COLUMNS} from genio_one_siem_destinations where tenant_id = $1`,
        [tenantId],
      )
      return result.rows[0] ? destination(result.rows[0]) : null
    },
    async configure({ tenantId, configuredBySubjectId, value }) {
      const eventKinds = [...new Set(value.event_kinds.map((kind) => kind.trim()).filter(Boolean))]
      const result = await options.sql.query<Row>(
        `insert into genio_one_siem_destinations
           (tenant_id, destination_id, endpoint_url, event_kinds, enabled,
            configured_by_subject_id, configured_at)
         values ($1, $2, $3, $4::text::jsonb, $5, $6, now())
         on conflict (tenant_id)
         do update set destination_id = excluded.destination_id,
                       endpoint_url = excluded.endpoint_url,
                       event_kinds = excluded.event_kinds,
                       enabled = excluded.enabled,
                       configured_by_subject_id = excluded.configured_by_subject_id,
                       configured_at = now(), updated_at = now()
         returning ${DESTINATION_COLUMNS}`,
        [
          tenantId,
          value.destination_id.trim(),
          endpoint(value.endpoint_url, options.allowInsecureLoopback === true),
          JSON.stringify(eventKinds),
          value.enabled,
          configuredBySubjectId,
        ],
      )
      return destination(result.rows[0]!)
    },
    async listDeliveries({ tenantId, limit }) {
      const result = await options.sql.query<Row>(
        `select ${DELIVERY_COLUMNS} from genio_one_siem_deliveries
          where tenant_id = $1
          order by created_at desc, audit_event_id desc limit $2`,
        [tenantId, limit],
      )
      return result.rows.map(delivery)
    },
    async deliverDue(input = {}) {
      const limit = input.limit ?? 25
      await options.sql.query(
        `insert into genio_one_siem_deliveries
           (tenant_id, destination_id, audit_event_id, endpoint_url, event)
         select destination.tenant_id, destination.destination_id,
                audit.audit_event_id, destination.endpoint_url, audit.event
           from genio_one_siem_destinations destination
           join genio_one_gateway_authorization_audit_events audit
             on audit.tenant_id = destination.tenant_id
          where destination.enabled = true
            and (destination.event_kinds = '[]'::jsonb
              or destination.event_kinds ? (audit.event ->> 'kind'))
         on conflict (tenant_id, destination_id, audit_event_id) do nothing`,
      )
      const owner = `siem-worker-${randomUUID()}`
      const claimed = await options.sql.transaction(async (transaction) => {
        const candidates = await transaction.query<Row>(
          `select ${DELIVERY_COLUMNS} from genio_one_siem_deliveries
            where status in ('PENDING', 'RETRY_SCHEDULED') and next_attempt_at <= now()
            order by next_attempt_at asc, audit_event_id asc
            for update skip locked limit $1`,
          [limit],
        )
        const values: SiemDelivery[] = []
        for (const candidate of candidates.rows) {
          const updated = await transaction.query<Row>(
            `update genio_one_siem_deliveries
                set status = 'IN_FLIGHT', attempt_count = attempt_count + 1,
                    lease_owner = $4, lease_expires_at = now() + interval '30 seconds',
                    updated_at = now()
              where tenant_id = $1 and destination_id = $2 and audit_event_id = $3
              returning ${DELIVERY_COLUMNS}`,
            [candidate.tenant_id, candidate.destination_id, candidate.audit_event_id, owner],
          )
          values.push(delivery(updated.rows[0]!))
        }
        return values
      })
      let delivered = 0
      for (const value of claimed) {
        let errorCode: string | null = null
        try {
          const response = await send(value.endpoint_url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-genio-audit-event-id": value.audit_event_id },
            body: JSON.stringify(value.event),
          })
          if (!response.ok) errorCode = `HTTP_${response.status}`
        } catch {
          errorCode = "NETWORK_ERROR"
        }
        if (errorCode === null) {
          await options.sql.query(
            `update genio_one_siem_deliveries set status = 'DELIVERED', delivered_at = now(),
                    lease_owner = null, lease_expires_at = null, last_error_code = null, updated_at = now()
              where tenant_id = $1 and destination_id = $2 and audit_event_id = $3 and lease_owner = $4`,
            [value.tenant_id, value.destination_id, value.audit_event_id, owner],
          )
          delivered += 1
        } else {
          const retrySeconds = Math.min(300, 2 ** Math.min(value.attempt_count, 8))
          await options.sql.query(
            `update genio_one_siem_deliveries set status = 'RETRY_SCHEDULED',
                    next_attempt_at = now() + ($5 * interval '1 second'),
                    lease_owner = null, lease_expires_at = null, last_error_code = $4, updated_at = now()
              where tenant_id = $1 and destination_id = $2 and audit_event_id = $3 and lease_owner = $6`,
            [value.tenant_id, value.destination_id, value.audit_event_id, errorCode, retrySeconds, owner],
          )
        }
      }
      return delivered
    },
  }
}
