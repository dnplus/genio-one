import { createPublicKey } from "node:crypto"

import type { SqlAdapter, SqlTransaction } from "../../persistence/sql-adapter"
import { PlatformApiError } from "../errors"
import type {
  RuntimeControlStore,
  RuntimeRegistration,
  RuntimeSessionLease,
} from "./contract"
import { lockRuntimeTopology } from "./runtime-topology-lock"

export interface PostgresRuntimeControlStoreOptions {
  sql: SqlAdapter
  now?: () => number
}

const RUNTIME_REGISTRATION_COLUMNS = `
  tenant_id,
  runtime_kind,
  runtime_id,
  target_id,
  oidc_client_id,
  report_key_id,
  report_public_key_pem,
  status,
  row_revision,
  created_at,
  updated_at`

const RUNTIME_LEASE_COLUMNS = `
  tenant_id,
  runtime_kind,
  runtime_id,
  lease_id,
  owner_id,
  claimed_at,
  renewed_at,
  expires_at`

type RuntimeDatabaseRow = Record<string, unknown>

function runtimeIdentifier(value: string, code: string): void {
  if (!value.trim() || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new PlatformApiError(code, 422, `${code} is invalid`)
  }
}

function runtimeKeyMaterial(value: string, code: string): void {
  if (!value.trim()) throw new PlatformApiError(code, 422, `${code} is invalid`)
}

function runtimeStatus(value: unknown): RuntimeRegistration["status"] {
  if (value === "ACTIVE" || value === "DISABLED" || value === "REVOKED") return value
  throw new PlatformApiError("RUNTIME_REGISTRATION_DATA_INVALID", 500)
}

function rowString(row: RuntimeDatabaseRow, key: string, code: string): string {
  const value = row[key]
  if (typeof value !== "string" || !value.trim()) throw new PlatformApiError(code, 500)
  return value
}

function rowInteger(row: RuntimeDatabaseRow, key: string, code: string): number {
  const value = row[key]
  const number = typeof value === "bigint"
    ? Number(value)
    : typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN
  if (!Number.isSafeInteger(number) || number < 1) throw new PlatformApiError(code, 500)
  return number
}

function rowTimestamp(row: RuntimeDatabaseRow, key: string, fallback: number): number {
  const value = row[key]
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return Math.floor(value.getTime() / 1000)
  }
  if (typeof value === "bigint") return Number(value)
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value)
  if (typeof value === "string") {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return Math.floor(numeric)
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000)
  }
  return fallback
}

function validateReportKey(publicKeyPem: string): void {
  try {
    const key = createPublicKey(publicKeyPem)
    if (key.asymmetricKeyType !== "ed25519") throw new Error("not Ed25519")
  } catch {
    throw new PlatformApiError(
      "RUNTIME_REPORT_KEY_INVALID",
      422,
      "Runtime report public key must be a valid Ed25519 key",
    )
  }
}

function mapRegistration(row: RuntimeDatabaseRow, now: () => number): RuntimeRegistration {
  const runtimeKind = rowString(row, "runtime_kind", "RUNTIME_REGISTRATION_DATA_INVALID")
  if (runtimeKind !== "GATEWAY") throw new PlatformApiError("RUNTIME_REGISTRATION_DATA_INVALID", 500)
  return {
    tenant_id: rowString(row, "tenant_id", "RUNTIME_REGISTRATION_DATA_INVALID"),
    runtime_kind: "GATEWAY",
    runtime_id: rowString(row, "runtime_id", "RUNTIME_REGISTRATION_DATA_INVALID"),
    target_id: rowString(row, "target_id", "RUNTIME_REGISTRATION_DATA_INVALID"),
    oidc_client_id: rowString(row, "oidc_client_id", "RUNTIME_REGISTRATION_DATA_INVALID"),
    report_key_id: rowString(row, "report_key_id", "RUNTIME_REGISTRATION_DATA_INVALID"),
    report_public_key_pem: rowString(row, "report_public_key_pem", "RUNTIME_REGISTRATION_DATA_INVALID"),
    status: runtimeStatus(row.status),
    row_revision: rowInteger(row, "row_revision", "RUNTIME_REGISTRATION_DATA_INVALID"),
    created_at: rowTimestamp(row, "created_at", now()),
    updated_at: rowTimestamp(row, "updated_at", now()),
  }
}

function mapLease(row: RuntimeDatabaseRow, now: () => number): RuntimeSessionLease {
  const runtimeKind = rowString(row, "runtime_kind", "RUNTIME_SESSION_LEASE_DATA_INVALID")
  if (runtimeKind !== "GATEWAY") throw new PlatformApiError("RUNTIME_SESSION_LEASE_DATA_INVALID", 500)
  return {
    tenant_id: rowString(row, "tenant_id", "RUNTIME_SESSION_LEASE_DATA_INVALID"),
    runtime_kind: "GATEWAY",
    runtime_id: rowString(row, "runtime_id", "RUNTIME_SESSION_LEASE_DATA_INVALID"),
    lease_id: rowString(row, "lease_id", "RUNTIME_SESSION_LEASE_DATA_INVALID"),
    owner_id: rowString(row, "owner_id", "RUNTIME_SESSION_LEASE_DATA_INVALID"),
    claimed_at: rowTimestamp(row, "claimed_at", now()),
    renewed_at: rowTimestamp(row, "renewed_at", now()),
    expires_at: rowTimestamp(row, "expires_at", now()),
  }
}

async function selectRuntimeRegistration(
  executor: SqlAdapter | SqlTransaction,
  tenantId: string,
  runtimeId: string,
  forUpdate = false,
): Promise<RuntimeDatabaseRow | null> {
  const result = await executor.query<RuntimeDatabaseRow>(
    `select ${RUNTIME_REGISTRATION_COLUMNS}
       from genio_one_platform_runtime_registrations
      where tenant_id = $1 and runtime_kind = 'GATEWAY' and runtime_id = $2${forUpdate ? " for update" : ""}`,
    [tenantId, runtimeId],
  )
  return result.rows[0] ?? null
}

function assertLeaseInput(input: {
  tenantId: string
  runtimeId: string
  ownerId: string
  leaseId: string
  ttlSeconds?: number
}): void {
  runtimeIdentifier(input.tenantId, "TENANT_REQUIRED")
  runtimeIdentifier(input.runtimeId, "RUNTIME_ID_REQUIRED")
  runtimeIdentifier(input.ownerId, "RUNTIME_SESSION_OWNER_REQUIRED")
  runtimeIdentifier(input.leaseId, "RUNTIME_SESSION_LEASE_ID_REQUIRED")
  if (
    input.ttlSeconds !== undefined &&
    (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > 86_400)
  ) throw new PlatformApiError("RUNTIME_SESSION_LEASE_TTL_INVALID", 422)
}

export interface PostgresRuntimeControlStore extends RuntimeControlStore {}

export function createPostgresRuntimeControlStore(
  options: PostgresRuntimeControlStoreOptions,
): PostgresRuntimeControlStore {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  return {
    async registerGatewayRuntime(input) {
      runtimeIdentifier(input.tenantId, "TENANT_REQUIRED")
      runtimeIdentifier(input.runtimeId, "RUNTIME_ID_REQUIRED")
      runtimeIdentifier(input.targetId, "RUNTIME_TARGET_REQUIRED")
      runtimeIdentifier(input.oidcClientId, "RUNTIME_OIDC_CLIENT_REQUIRED")
      runtimeIdentifier(input.reportKeyId, "RUNTIME_REPORT_KEY_ID_REQUIRED")
      runtimeKeyMaterial(input.reportPublicKeyPem, "RUNTIME_REPORT_KEY_REQUIRED")
      validateReportKey(input.reportPublicKeyPem)
      return options.sql.transaction(async (transaction) => {
        await lockRuntimeTopology({ transaction, tenantId: input.tenantId })
        const current = await selectRuntimeRegistration(transaction, input.tenantId, input.runtimeId, true)
        if (current) {
          const mapped = mapRegistration(current, now)
          if (
            mapped.target_id === input.targetId &&
            mapped.oidc_client_id === input.oidcClientId &&
            mapped.report_key_id === input.reportKeyId &&
            mapped.report_public_key_pem === input.reportPublicKeyPem &&
            mapped.status === (input.status ?? mapped.status)
          ) return mapped
          const updated = await transaction.query<RuntimeDatabaseRow>(
            `update genio_one_platform_runtime_registrations
                set target_id = $3,
                    oidc_client_id = $4,
                    report_key_id = $5,
                    report_public_key_pem = $6,
                    status = $7,
                    row_revision = row_revision + 1,
                    updated_at = now()
              where tenant_id = $1 and runtime_kind = 'GATEWAY' and runtime_id = $2
              returning ${RUNTIME_REGISTRATION_COLUMNS}`,
            [input.tenantId, input.runtimeId, input.targetId, input.oidcClientId,
              input.reportKeyId, input.reportPublicKeyPem, input.status ?? mapped.status],
          )
          const row = updated.rows[0]
          if (!row) throw new PlatformApiError("RUNTIME_REGISTRATION_WRITE_RACE", 500)
          return mapRegistration(row, now)
        }
        const upserted = await transaction.query<RuntimeDatabaseRow>(
          `insert into genio_one_platform_runtime_registrations
             (tenant_id, runtime_kind, runtime_id, target_id, oidc_client_id,
              report_key_id, report_public_key_pem, status)
           values ($1, 'GATEWAY', $2, $3, $4, $5, $6, $7)
           on conflict (tenant_id, runtime_kind, runtime_id)
           do update set target_id = excluded.target_id,
                         oidc_client_id = excluded.oidc_client_id,
                         report_key_id = excluded.report_key_id,
                         report_public_key_pem = excluded.report_public_key_pem,
                         status = excluded.status,
                         row_revision = genio_one_platform_runtime_registrations.row_revision + 1,
                         updated_at = now()
           where genio_one_platform_runtime_registrations.target_id is distinct from excluded.target_id
              or genio_one_platform_runtime_registrations.oidc_client_id is distinct from excluded.oidc_client_id
              or genio_one_platform_runtime_registrations.report_key_id is distinct from excluded.report_key_id
              or genio_one_platform_runtime_registrations.report_public_key_pem is distinct from excluded.report_public_key_pem
              or genio_one_platform_runtime_registrations.status is distinct from excluded.status
           returning ${RUNTIME_REGISTRATION_COLUMNS}`,
          [input.tenantId, input.runtimeId, input.targetId, input.oidcClientId,
            input.reportKeyId, input.reportPublicKeyPem, input.status ?? "ACTIVE"],
        )
        const row = upserted.rows[0]
        if (row) return mapRegistration(row, now)
        const unchanged = await selectRuntimeRegistration(transaction, input.tenantId, input.runtimeId, true)
        if (!unchanged) throw new PlatformApiError("RUNTIME_REGISTRATION_WRITE_RACE", 500)
        return mapRegistration(unchanged, now)
      })
    },
    async getGatewayRuntime(input) {
      if (input.runtimeKind !== undefined && input.runtimeKind !== "GATEWAY") return null
      runtimeIdentifier(input.tenantId, "TENANT_REQUIRED")
      runtimeIdentifier(input.runtimeId, "RUNTIME_ID_REQUIRED")
      const row = await selectRuntimeRegistration(options.sql, input.tenantId, input.runtimeId)
      return row ? mapRegistration(row, now) : null
    },
    async listGatewayRuntimes(input) {
      runtimeIdentifier(input.tenantId, "TENANT_REQUIRED")
      if (input.targetId !== undefined) runtimeIdentifier(input.targetId, "RUNTIME_TARGET_REQUIRED")
      const result = await options.sql.query<RuntimeDatabaseRow>(
        `select ${RUNTIME_REGISTRATION_COLUMNS}
           from genio_one_platform_runtime_registrations
          where tenant_id = $1${input.targetId === undefined ? "" : " and target_id = $2"}
          order by runtime_id asc`,
        input.targetId === undefined ? [input.tenantId] : [input.tenantId, input.targetId],
      )
      return result.rows.map((row) => mapRegistration(row, now))
    },
    async claimGatewaySessionLease(input) {
      assertLeaseInput(input)
      return options.sql.transaction(async (transaction) => {
        const registrationRow = await selectRuntimeRegistration(
          transaction,
          input.tenantId,
          input.runtimeId,
          true,
        )
        if (!registrationRow || mapRegistration(registrationRow, now).status !== "ACTIVE") {
          throw new PlatformApiError("RUNTIME_RUNTIME_NOT_ACTIVE", 403)
        }
        const result = await transaction.query<RuntimeDatabaseRow>(
          `insert into genio_one_platform_runtime_session_leases
             (tenant_id, runtime_kind, runtime_id, lease_id, owner_id,
              claimed_at, renewed_at, expires_at)
           values ($1, 'GATEWAY', $2, $3, $4, now(), now(),
                   now() + ($5 * interval '1 second'))
           on conflict (tenant_id, runtime_kind, runtime_id)
           do update set lease_id = excluded.lease_id,
                         owner_id = excluded.owner_id,
                         claimed_at = case
                           when genio_one_platform_runtime_session_leases.owner_id = excluded.owner_id
                            and genio_one_platform_runtime_session_leases.lease_id = excluded.lease_id
                           then genio_one_platform_runtime_session_leases.claimed_at
                           else now()
                         end,
                         renewed_at = now(),
                         expires_at = excluded.expires_at
           where genio_one_platform_runtime_session_leases.expires_at <= now()
              or (genio_one_platform_runtime_session_leases.owner_id = excluded.owner_id
                  and genio_one_platform_runtime_session_leases.lease_id = excluded.lease_id)
           returning ${RUNTIME_LEASE_COLUMNS}`,
          [input.tenantId, input.runtimeId, input.leaseId, input.ownerId, input.ttlSeconds],
        )
        const row = result.rows[0]
        if (row) return mapLease(row, now)
        const current = await transaction.query<RuntimeDatabaseRow>(
          `select ${RUNTIME_LEASE_COLUMNS}
             from genio_one_platform_runtime_session_leases
            where tenant_id = $1 and runtime_kind = 'GATEWAY' and runtime_id = $2
            for update`,
          [input.tenantId, input.runtimeId],
        )
        if (current.rows[0]) throw new PlatformApiError("RUNTIME_SESSION_LEASE_HELD", 409)
        throw new PlatformApiError("RUNTIME_SESSION_LEASE_WRITE_RACE", 500)
      })
    },
    async renewGatewaySessionLease(input) {
      assertLeaseInput(input)
      return options.sql.transaction(async (transaction) => {
        const registrationRow = await selectRuntimeRegistration(
          transaction,
          input.tenantId,
          input.runtimeId,
          true,
        )
        if (!registrationRow || mapRegistration(registrationRow, now).status !== "ACTIVE") {
          throw new PlatformApiError("RUNTIME_RUNTIME_NOT_ACTIVE", 403)
        }
        const updated = await transaction.query<RuntimeDatabaseRow>(
          `update genio_one_platform_runtime_session_leases
              set renewed_at = now(), expires_at = now() + ($5 * interval '1 second')
            where tenant_id = $1 and runtime_kind = 'GATEWAY' and runtime_id = $2
              and lease_id = $3 and owner_id = $4 and expires_at > now()
            returning ${RUNTIME_LEASE_COLUMNS}`,
          [input.tenantId, input.runtimeId, input.leaseId, input.ownerId, input.ttlSeconds],
        )
        if (updated.rows[0]) return mapLease(updated.rows[0], now)
        const current = await transaction.query<RuntimeDatabaseRow>(
          `select ${RUNTIME_LEASE_COLUMNS}
             from genio_one_platform_runtime_session_leases
            where tenant_id = $1 and runtime_kind = 'GATEWAY' and runtime_id = $2
            for update`,
          [input.tenantId, input.runtimeId],
        )
        const row = current.rows[0]
        if (!row) throw new PlatformApiError("RUNTIME_SESSION_LEASE_NOT_FOUND", 404)
        const lease = mapLease(row, now)
        if (lease.expires_at <= now()) throw new PlatformApiError("RUNTIME_SESSION_LEASE_EXPIRED", 409)
        throw new PlatformApiError("RUNTIME_SESSION_LEASE_OWNER_MISMATCH", 409)
      })
    },
    async releaseGatewaySessionLease(input) {
      assertLeaseInput(input)
      await options.sql.transaction(async (transaction) => {
        const result = await transaction.query<RuntimeDatabaseRow>(
          `delete from genio_one_platform_runtime_session_leases
            where tenant_id = $1 and runtime_kind = 'GATEWAY' and runtime_id = $2
              and lease_id = $3 and owner_id = $4
            returning ${RUNTIME_LEASE_COLUMNS}`,
          [input.tenantId, input.runtimeId, input.leaseId, input.ownerId],
        )
        if (result.rows[0]) return
        const current = await transaction.query<RuntimeDatabaseRow>(
          `select ${RUNTIME_LEASE_COLUMNS}
             from genio_one_platform_runtime_session_leases
            where tenant_id = $1 and runtime_kind = 'GATEWAY' and runtime_id = $2`,
          [input.tenantId, input.runtimeId],
        )
        if (current.rows[0]) throw new PlatformApiError("RUNTIME_SESSION_LEASE_OWNER_MISMATCH", 409)
      })
    },
    async getGatewaySessionLease(input) {
      runtimeIdentifier(input.tenantId, "TENANT_REQUIRED")
      runtimeIdentifier(input.runtimeId, "RUNTIME_ID_REQUIRED")
      const result = await options.sql.query<RuntimeDatabaseRow>(
        `select ${RUNTIME_LEASE_COLUMNS}
           from genio_one_platform_runtime_session_leases
          where tenant_id = $1 and runtime_kind = 'GATEWAY' and runtime_id = $2
            and expires_at > now()`,
        [input.tenantId, input.runtimeId],
      )
      return result.rows[0] ? mapLease(result.rows[0], now) : null
    },
  }
}
