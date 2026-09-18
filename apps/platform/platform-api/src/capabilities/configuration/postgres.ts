import type { SqlAdapter, SqlTransaction } from "../../persistence/sql-adapter"
import { PlatformApiError } from "../errors"
import type { TenantConfiguration, TenantConfigurationRevision } from "./contract"
import { assertTenantConfiguration, transitionConfiguration } from "./lifecycle"
import type { TenantConfigurationStore } from "./module"

type Row = Record<string, unknown>

function text(row: Row, key: string): string {
  const value = row[key]
  return typeof value === "string" ? value : String(value ?? "")
}
function nullableText(row: Row, key: string): string | null {
  return row[key] === null || row[key] === undefined ? null : text(row, key)
}
function seconds(value: unknown): number {
  if (value instanceof Date) return Math.floor(value.getTime() / 1_000)
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : Number(value)
}
function nullableSeconds(value: unknown): number | null {
  return value === null || value === undefined ? null : seconds(value)
}
function settings(value: unknown): TenantConfiguration {
  return (typeof value === "string" ? JSON.parse(value) : value) as TenantConfiguration
}

function revision(row: Row): TenantConfigurationRevision {
  const desiredRevision = text(row, "revision")
  return {
    tenant_id: text(row, "tenant_id"),
    revision: desiredRevision,
    state: text(row, "state") as TenantConfigurationRevision["state"],
    settings: settings(row.settings),
    created_by: {
      subject_id: text(row, "created_by_subject_id"),
      evidence_level: "VERIFIED",
    },
    created_at: seconds(row.created_at),
    validated_at: nullableSeconds(row.validated_at),
    previewed_at: nullableSeconds(row.previewed_at),
    reviewed_at: nullableSeconds(row.reviewed_at),
    published_at: nullableSeconds(row.published_at),
    projection: {
      desired_revision: desiredRevision,
      observed_revision: nullableText(row, "observed_revision"),
      status: text(row, "projection_status") as TenantConfigurationRevision["projection"]["status"],
      drift: row.projection_drift === true || row.projection_drift === "true",
      last_error: nullableText(row, "projection_last_error"),
      retry_count: Number(row.projection_retry_count),
      last_reconciled_at: nullableSeconds(row.projection_last_reconciled_at),
    },
    rolled_back_from: nullableText(row, "rolled_back_from"),
  }
}

const COLUMNS = `tenant_id, revision, state, settings, created_by_subject_id, created_at,
  validated_at, previewed_at, reviewed_at, published_at, observed_revision,
  projection_status, projection_drift, projection_last_error,
  projection_retry_count, projection_last_reconciled_at, rolled_back_from`

async function locked(
  transaction: SqlTransaction,
  tenantId: string,
  revisionId: string,
): Promise<TenantConfigurationRevision> {
  const result = await transaction.query<Row>(
    `select ${COLUMNS} from genio_one_tenant_configuration_revisions
      where tenant_id = $1 and revision = $2 for update`,
    [tenantId, revisionId],
  )
  if (!result.rows[0]) throw new PlatformApiError("CONFIGURATION_REVISION_NOT_FOUND", 404)
  return revision(result.rows[0])
}

async function update(
  transaction: SqlTransaction,
  value: TenantConfigurationRevision,
): Promise<TenantConfigurationRevision> {
  const result = await transaction.query<Row>(
    `update genio_one_tenant_configuration_revisions
        set state = $3, validated_at = to_timestamp($4), previewed_at = to_timestamp($5),
            reviewed_at = to_timestamp($6), published_at = to_timestamp($7),
            observed_revision = $8, projection_status = $9, projection_drift = $10,
            projection_last_error = $11, projection_retry_count = $12,
            projection_last_reconciled_at = to_timestamp($13), rolled_back_from = $14
      where tenant_id = $1 and revision = $2
      returning ${COLUMNS}`,
    [
      value.tenant_id, value.revision, value.state,
      value.validated_at, value.previewed_at, value.reviewed_at, value.published_at,
      value.projection.observed_revision, value.projection.status, value.projection.drift,
      value.projection.last_error, value.projection.retry_count,
      value.projection.last_reconciled_at, value.rolled_back_from,
    ],
  )
  return revision(result.rows[0]!)
}

async function activateSelfServiceProjection(
  transaction: SqlTransaction,
  value: TenantConfigurationRevision,
  at: number,
): Promise<TenantConfigurationRevision> {
  await transaction.query(
    `insert into genio_one_self_service_configuration_projections
       (tenant_id, revision, projected_at)
     values ($1, $2, to_timestamp($3))
     on conflict (tenant_id) do update
       set revision = excluded.revision, projected_at = excluded.projected_at`,
    [value.tenant_id, value.revision, at],
  )
  value.projection.observed_revision = value.revision
  value.projection.status = value.projection.status === "ROLLED_BACK"
    ? "ROLLED_BACK"
    : "CONVERGED"
  value.projection.drift = false
  value.projection.last_error = null
  value.projection.last_reconciled_at = at
  return update(transaction, value)
}

export function createPostgresTenantConfigurationStore(options: {
  sql: SqlAdapter
  idFactory?: () => string
  now?: () => number
}): TenantConfigurationStore {
  const idFactory = options.idFactory ?? (() => crypto.randomUUID())
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000))
  return {
    async list({ tenantId }) {
      const result = await options.sql.query<Row>(
        `select ${COLUMNS} from genio_one_tenant_configuration_revisions
          where tenant_id = $1 order by created_at asc, revision asc`,
        [tenantId],
      )
      return result.rows.map(revision)
    },
    async published({ tenantId }) {
      const result = await options.sql.query<Row>(
        `select ${COLUMNS} from genio_one_tenant_configuration_revisions
          where tenant_id = $1 and state = 'PUBLISHED'
            and revision = (
              select projection.revision
                from genio_one_self_service_configuration_projections projection
               where projection.tenant_id = $1
            )
          limit 1`,
        [tenantId],
      )
      return result.rows[0] ? revision(result.rows[0]) : null
    },
    async create({ tenantId, createdBySubjectId, value }) {
      assertTenantConfiguration(value.settings)
      const revisionId = `config-revision-${idFactory()}`
      try {
        const result = await options.sql.query<Row>(
          `insert into genio_one_tenant_configuration_revisions
             (tenant_id, revision, state, settings, created_by_subject_id)
           values ($1, $2, 'DRAFT', $3::text::jsonb, $4)
           returning ${COLUMNS}`,
          [tenantId, revisionId, JSON.stringify(value.settings), createdBySubjectId],
        )
        return revision(result.rows[0]!)
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "23503") {
          throw new PlatformApiError("CONFIGURATION_CREATOR_NOT_FOUND", 422)
        }
        throw error
      }
    },
    async transition({ tenantId, revision: revisionId, transition, value }) {
      return options.sql.transaction(async (transaction) => {
        const current = await locked(transaction, tenantId, revisionId)
        return update(transaction, transitionConfiguration(
          current, transition, now(), value.projection_failure_reason,
        ))
      })
    },
    async retry({ tenantId, revision: revisionId }) {
      return options.sql.transaction(async (transaction) => {
        const current = await locked(transaction, tenantId, revisionId)
        if (current.state !== "PUBLISHED" || current.projection.status !== "FAILED") {
          throw new PlatformApiError("CONFIGURATION_PROJECTION_RETRY_INVALID", 409)
        }
        current.projection = {
          ...current.projection,
          observed_revision: null,
          status: "PENDING",
          drift: true,
          last_error: null,
          retry_count: current.projection.retry_count + 1,
          last_reconciled_at: null,
        }
        return update(transaction, current)
      })
    },
    async project({ tenantId, revision: revisionId }) {
      return options.sql.transaction(async (transaction) => {
        const current = await locked(transaction, tenantId, revisionId)
        if (current.state !== "PUBLISHED") {
          throw new PlatformApiError("CONFIGURATION_PROJECTION_INVALID", 409)
        }
        return activateSelfServiceProjection(transaction, current, now())
      })
    },
    async observe({ tenantId, revision: revisionId, value }) {
      return options.sql.transaction(async (transaction) => {
        const current = await locked(transaction, tenantId, revisionId)
        if (current.state !== "PUBLISHED") throw new PlatformApiError("CONFIGURATION_OBSERVATION_INVALID", 409)
        const reason = value.failure_reason?.trim()
        if (value.observed_revision === revisionId && !reason) {
          return activateSelfServiceProjection(transaction, current, now())
        } else if ((value.observed_revision === null || value.observed_revision === undefined) && reason) {
          current.projection.observed_revision = null
          current.projection.status = "FAILED"
          current.projection.drift = true
          current.projection.last_error = reason
        } else {
          throw new PlatformApiError("CONFIGURATION_OBSERVATION_INVALID", 409)
        }
        current.projection.last_reconciled_at = now()
        return update(transaction, current)
      })
    },
    async rollback({ tenantId, createdBySubjectId, value }) {
      return options.sql.transaction(async (transaction) => {
        const failed = await locked(transaction, tenantId, value.failed_revision)
        const target = await locked(transaction, tenantId, value.target_revision)
        if (
          failed.state !== "PUBLISHED" || target.state !== "PUBLISHED" ||
          target.projection.status !== "CONVERGED"
        ) throw new PlatformApiError("CONFIGURATION_ROLLBACK_INVALID", 409)
        const revisionId = `config-revision-${idFactory()}`
        const at = now()
        const result = await transaction.query<Row>(
          `insert into genio_one_tenant_configuration_revisions
             (tenant_id, revision, state, settings, created_by_subject_id, created_at,
              validated_at, previewed_at, reviewed_at, published_at, observed_revision,
              projection_status, projection_drift, projection_last_reconciled_at, rolled_back_from)
           values ($1, $2, 'PUBLISHED', $3::text::jsonb, $4, to_timestamp($5),
                   to_timestamp($5), to_timestamp($5), to_timestamp($5), to_timestamp($5), $2,
                   'ROLLED_BACK', false, to_timestamp($5), $6)
           returning ${COLUMNS}`,
          [tenantId, revisionId, JSON.stringify(target.settings), createdBySubjectId, at, value.failed_revision],
        )
        return activateSelfServiceProjection(transaction, revision(result.rows[0]!), at)
      })
    },
  }
}
