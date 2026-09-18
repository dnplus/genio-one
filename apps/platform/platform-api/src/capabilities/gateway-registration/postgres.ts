import type { SqlAdapter } from "../../persistence/sql-adapter"
import { PlatformApiError } from "../errors"
import type { GatewayRegistration } from "./contract"
import type { GatewayRegistrationRepository } from "./module"

type Row = Record<string, unknown>

const COLUMNS = `tenant_id, runtime_id, display_name, gateway_id, site_id, region,
  labels, identity_client_id, state, registered_by_subject_id, registered_at,
  activated_at, retired_at, row_revision`

function text(row: Row, key: string): string {
  const value = row[key]
  return typeof value === "string" ? value : String(value ?? "")
}

function timestamp(value: unknown): number {
  if (value instanceof Date) return Math.floor(value.getTime() / 1_000)
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : Number(value)
}

function nullableTimestamp(value: unknown): number | null {
  return value === null || value === undefined ? null : timestamp(value)
}

function labels(value: unknown): Record<string, string> {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PlatformApiError("GATEWAY_REGISTRATION_DATA_INVALID", 500)
  }
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry !== "string") throw new PlatformApiError("GATEWAY_REGISTRATION_DATA_INVALID", 500)
    result[key] = entry
  }
  return result
}

function registration(row: Row): GatewayRegistration {
  const state = text(row, "state")
  if (state !== "PROVISIONING" && state !== "ACTIVE" && state !== "RETIRED") {
    throw new PlatformApiError("GATEWAY_REGISTRATION_DATA_INVALID", 500)
  }
  return {
    tenant_id: text(row, "tenant_id"),
    runtime_id: text(row, "runtime_id"),
    display_name: text(row, "display_name"),
    gateway_id: text(row, "gateway_id"),
    site_id: text(row, "site_id"),
    region: text(row, "region"),
    labels: labels(row.labels),
    identity_client_id: text(row, "identity_client_id"),
    state,
    registered_by: text(row, "registered_by_subject_id"),
    registered_at: timestamp(row.registered_at),
    activated_at: nullableTimestamp(row.activated_at),
    retired_at: nullableTimestamp(row.retired_at),
    row_revision: Number(row.row_revision),
  }
}

export function createPostgresGatewayRegistrationRepository(options: {
  sql: SqlAdapter
}): GatewayRegistrationRepository {
  const get: GatewayRegistrationRepository["get"] = async ({ tenantId, runtimeId }) => {
    const result = await options.sql.query<Row>(
      `select ${COLUMNS}
         from genio_one_gateway_registrations
        where tenant_id = $1 and runtime_id = $2`,
      [tenantId, runtimeId],
    )
    return result.rows[0] ? registration(result.rows[0]) : null
  }
  return {
    async list({ tenantId }) {
      const result = await options.sql.query<Row>(
        `select ${COLUMNS}
           from genio_one_gateway_registrations
          where tenant_id = $1
          order by registered_at desc, runtime_id`,
        [tenantId],
      )
      return result.rows.map(registration)
    },
    get,
    async create({ tenantId, actorSubjectId, gatewayId, value }) {
      try {
        const result = await options.sql.query<Row>(
          `insert into genio_one_gateway_registrations
             (tenant_id, runtime_id, display_name, gateway_id, site_id, region,
              labels, identity_client_id, state, registered_by_subject_id)
           values ($1,$2,$3,$4,$5,$6,$7::text::jsonb,$2,'PROVISIONING',$8)
           returning ${COLUMNS}`,
          [tenantId, value.runtime_id, value.display_name, gatewayId, value.site_id,
            value.region, JSON.stringify(value.labels), actorSubjectId],
        )
        return registration(result.rows[0]!)
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
          throw new PlatformApiError("GATEWAY_ALREADY_REGISTERED", 409)
        }
        throw error
      }
    },
    async activate({ tenantId, runtimeId }) {
      const result = await options.sql.query<Row>(
        `update genio_one_gateway_registrations
            set state = 'ACTIVE', activated_at = now(), row_revision = row_revision + 1
          where tenant_id = $1 and runtime_id = $2 and state = 'PROVISIONING'
          returning ${COLUMNS}`,
        [tenantId, runtimeId],
      )
      if (!result.rows[0]) throw new PlatformApiError("GATEWAY_PROVISIONING_STATE_INVALID", 409)
      return registration(result.rows[0])
    },
    async retire({ tenantId, runtimeId }) {
      const result = await options.sql.query<Row>(
        `update genio_one_gateway_registrations
            set state = 'RETIRED', retired_at = now(), row_revision = row_revision + 1
          where tenant_id = $1 and runtime_id = $2 and state <> 'RETIRED'
          returning ${COLUMNS}`,
        [tenantId, runtimeId],
      )
      if (result.rows[0]) return registration(result.rows[0])
      const existing = await get({ tenantId, runtimeId })
      if (!existing) throw new PlatformApiError("GATEWAY_NOT_FOUND", 404)
      return existing
    },
  }
}
