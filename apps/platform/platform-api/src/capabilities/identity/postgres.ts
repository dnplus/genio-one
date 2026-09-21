import { PlatformApiError } from "../errors"
import type { SqlAdapter, SqlTransaction } from "../../persistence/sql-adapter"
import type { BootstrapSubjectInput, CreateSelfServiceAgentInput, CreateSubjectInput, Subject } from "./contract"
import type { IdentityDirectory } from "./module"

type Row = Record<string, unknown>

function text(row: Row, name: string): string {
  const value = row[name]
  return typeof value === "string" ? value : String(value ?? "")
}

function nullable(row: Row, name: string): string | null {
  const value = row[name]
  return typeof value === "string" && value ? value : null
}

function subject(row: Row): Subject {
  const kind = text(row, "kind")
  if (kind !== "PERSON" && kind !== "APPLICATION" && kind !== "AGENT") {
    throw new PlatformApiError("SUBJECT_DATA_INVALID", 500)
  }
  const suspendedAt = row.suspended_at
  const suspendedMillis = suspendedAt instanceof Date
    ? suspendedAt.getTime()
    : typeof suspendedAt === "string" && suspendedAt
      ? Date.parse(suspendedAt)
      : null
  return {
    subject_id: text(row, "subject_id"),
    kind,
    profile: {
      display_name: nullable(row, "display_name"),
      email: nullable(row, "email"),
      department: nullable(row, "department"),
    },
    suspended: suspendedMillis !== null && Number.isFinite(suspendedMillis),
    suspended_at: suspendedMillis !== null && Number.isFinite(suspendedMillis) ? suspendedMillis : null,
    suspended_by: nullable(row, "suspended_by"),
    suspension_reason: nullable(row, "suspension_reason"),
  }
}

function required(value: string, code: string): string {
  const normalized = value.trim()
  if (!normalized) throw new PlatformApiError(code, 422)
  return normalized
}

async function upsertSubject(
  transaction: SqlTransaction,
  tenantId: string,
  value: BootstrapSubjectInput,
): Promise<void> {
  await transaction.query(
    `insert into genio_one_subjects
       (tenant_id, subject_id, kind, display_name, email, department)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (tenant_id, subject_id)
     do update set kind = excluded.kind,
                   display_name = excluded.display_name,
                   email = excluded.email,
                   department = excluded.department,
                   updated_at = now()`,
    [
      tenantId,
      required(value.subject_id, "SUBJECT_ID_REQUIRED"),
      value.kind,
      value.display_name?.trim() || null,
      value.email?.trim() || null,
      value.department?.trim() || null,
    ],
  )
  await transaction.query(
    `insert into genio_one_subject_roles (tenant_id, subject_id, role)
     values ($1, $2, $3)
     on conflict (tenant_id, subject_id, role) do nothing`,
    [tenantId, value.subject_id, value.role ?? "USER"],
  )
  for (const binding of value.external_identities ?? []) {
    await transaction.query(
      `insert into genio_one_external_identity_bindings
         (tenant_id, provider_id, external_subject_id, subject_id)
       values ($1, $2, $3, $4)
       on conflict (tenant_id, provider_id, external_subject_id)
       do update set subject_id = excluded.subject_id`,
      [
        tenantId,
        required(binding.provider_id, "IDENTITY_PROVIDER_REQUIRED"),
        required(binding.external_subject_id, "EXTERNAL_SUBJECT_REQUIRED"),
        value.subject_id,
      ],
    )
  }
}

export function createPostgresIdentityDirectory(options: { sql: SqlAdapter }): IdentityDirectory {
  const create = async ({ tenantId, value }: { tenantId: string; value: CreateSubjectInput }) => {
    const normalizedTenant = required(tenantId, "TENANT_REQUIRED")
    const subjectId = value.subject_id?.trim() || `agent-${crypto.randomUUID()}`
    try {
      return await options.sql.transaction(async (transaction) => {
        const result = await transaction.query<Row>(
          `insert into genio_one_subjects
             (tenant_id, subject_id, kind, display_name, email, department)
           values ($1, $2, 'AGENT', $3, $4, $5)
           returning subject_id, kind, display_name, email, department, suspended_at, suspended_by, suspension_reason`,
          [
            normalizedTenant,
            subjectId,
            required(value.display_name, "SUBJECT_DISPLAY_NAME_REQUIRED"),
            value.email?.trim() || null,
            value.department?.trim() || null,
          ],
        )
        await transaction.query(
          `insert into genio_one_subject_roles (tenant_id, subject_id, role)
           values ($1, $2, 'USER')`,
          [normalizedTenant, subjectId],
        )
        return subject(result.rows[0]!)
      })
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
        throw new PlatformApiError("SUBJECT_EXISTS", 409)
      }
      throw error
    }
  }
  const createSelfServiceAgent = async ({ tenantId, value, subjectId }: { tenantId: string; value: CreateSelfServiceAgentInput; subjectId?: string }) => {
    const normalizedTenant = required(tenantId, "TENANT_REQUIRED")
    const displayName = required(value.display_name, "SUBJECT_DISPLAY_NAME_REQUIRED")
    const stableSubjectId = subjectId?.trim()
    if (!stableSubjectId) return create({ tenantId: normalizedTenant, value: { subject_id: `agent-${crypto.randomUUID()}`, kind: "AGENT", display_name: displayName } })
    const existing = async () => {
      const result = await options.sql.query<Row>(
        `select subject_id, kind, display_name, email, department, suspended_at, suspended_by, suspension_reason
           from genio_one_subjects where tenant_id = $1 and subject_id = $2`,
        [normalizedTenant, stableSubjectId],
      )
      return result.rows[0] ? subject(result.rows[0]) : null
    }
    const compatible = (candidate: Subject) => {
      if (candidate.kind === "AGENT" && candidate.profile.display_name === displayName) return candidate
      throw new PlatformApiError("SELF_SERVICE_AGENT_REQUEST_CONFLICT", 409)
    }
    const before = await existing()
    if (before) return compatible(before)
    try {
      return await create({ tenantId: normalizedTenant, value: { subject_id: stableSubjectId, kind: "AGENT", display_name: displayName } })
    } catch (error) {
      if (!(error instanceof PlatformApiError) || error.code !== "SUBJECT_EXISTS") throw error
      const after = await existing()
      if (!after) throw error
      return compatible(after)
    }
  }
  return {
    async inventory({ tenantId }) {
      const normalizedTenant = required(tenantId, "TENANT_REQUIRED")
      const [subjectRows, bindingRows, administratorRows] = await Promise.all([
        options.sql.query<Row>(
          `select subject_id, kind, display_name, email, department, suspended_at, suspended_by, suspension_reason
             from genio_one_subjects
            where tenant_id = $1
            order by kind asc, coalesce(display_name, subject_id) asc, subject_id asc`,
          [normalizedTenant],
        ),
        options.sql.query<Row>(
          `select provider_id, external_subject_id, subject_id
             from genio_one_external_identity_bindings
            where tenant_id = $1
            order by provider_id asc, external_subject_id asc`,
          [normalizedTenant],
        ),
        options.sql.query<Row>(
          `select subject_id
             from genio_one_subject_roles
            where tenant_id = $1 and role = 'TENANT_ADMINISTRATOR'
            order by subject_id asc`,
          [normalizedTenant],
        ),
      ])
      return {
        tenant_id: normalizedTenant,
        subjects: subjectRows.rows.map(subject),
        external_identity_bindings: bindingRows.rows.map((row) => ({
          provider_id: text(row, "provider_id"),
          external_subject_id: text(row, "external_subject_id"),
          subject_id: text(row, "subject_id"),
        })),
        tenant_administrators: administratorRows.rows.map((row) => text(row, "subject_id")),
      }
    },
    create,
    createSelfServiceAgent,
    async bootstrap({ tenantId, subjects }) {
      const normalizedTenant = required(tenantId, "TENANT_REQUIRED")
      await options.sql.transaction(async (transaction) => {
        for (const value of subjects) await upsertSubject(transaction, normalizedTenant, value)
      })
    },
    async suspend({ tenantId, subjectId, suspendedBy, value }) {
      const result = await options.sql.query<Row>(
        `update genio_one_subjects
            set suspended_at = coalesce(suspended_at, now()),
                suspended_by = coalesce(suspended_by, $3),
                suspension_reason = coalesce(suspension_reason, $4),
                updated_at = now()
          where tenant_id = $1 and subject_id = $2
      returning subject_id, kind, display_name, email, department, suspended_at, suspended_by, suspension_reason`,
        [
          required(tenantId, "TENANT_REQUIRED"),
          required(subjectId, "SUBJECT_REQUIRED"),
          required(suspendedBy, "SUBJECT_REQUIRED"),
          value.reason?.trim() || null,
        ],
      )
      const row = result.rows[0]
      if (!row) throw new PlatformApiError("SUBJECT_NOT_FOUND", 404)
      return subject(row)
    },
    async restore({ tenantId, subjectId }) {
      const result = await options.sql.query<Row>(
        `update genio_one_subjects
            set suspended_at = null,
                suspended_by = null,
                suspension_reason = null,
                updated_at = now()
          where tenant_id = $1 and subject_id = $2
      returning subject_id, kind, display_name, email, department, suspended_at, suspended_by, suspension_reason`,
        [required(tenantId, "TENANT_REQUIRED"), required(subjectId, "SUBJECT_REQUIRED")],
      )
      const row = result.rows[0]
      if (!row) throw new PlatformApiError("SUBJECT_NOT_FOUND", 404)
      return subject(row)
    },
    async authorizationForSubject({ tenantId, subjectId }) {
      const normalizedTenant = required(tenantId, "TENANT_REQUIRED")
      const normalizedSubject = required(subjectId, "SUBJECT_REQUIRED")
      const result = await options.sql.query<Row>(
        `select exists(
           select 1 from genio_one_subjects
            where tenant_id = $1 and subject_id = $2
         ) as registered,
         exists(
           select 1 from genio_one_subject_roles
            where tenant_id = $1 and subject_id = $2 and role = 'TENANT_ADMINISTRATOR'
         ) as tenant_administrator,
         exists(
           select 1 from genio_one_subjects
            where tenant_id = $1 and subject_id = $2 and suspended_at is not null
         ) as suspended`,
        [normalizedTenant, normalizedSubject],
      )
      const row = result.rows[0] ?? {}
      return {
        registered: row.registered === true || row.registered === "true",
        tenant_administrator:
          row.tenant_administrator === true || row.tenant_administrator === "true",
        suspended: row.suspended === true || row.suspended === "true",
      }
    },
    async subjectForExternalIdentity({ tenantId, providerId, externalSubjectId }) {
      const result = await options.sql.query<Row>(
        `select subject_id
           from genio_one_external_identity_bindings
          where tenant_id = $1 and provider_id = $2 and external_subject_id = $3`,
        [
          required(tenantId, "TENANT_REQUIRED"),
          required(providerId, "IDENTITY_PROVIDER_REQUIRED"),
          required(externalSubjectId, "EXTERNAL_SUBJECT_REQUIRED"),
        ],
      )
      return result.rows[0] ? text(result.rows[0], "subject_id") : null
    },
    async canonicalSubjectId({ tenantId, subjectId }) {
      const result = await options.sql.query<Row>(
        `select distinct subject_id
           from (
             select subject_id
               from genio_one_subjects
              where tenant_id = $1 and subject_id = $2
             union all
             select subject_id
               from genio_one_external_identity_bindings
              where tenant_id = $1 and external_subject_id = $2
           ) identities
          order by subject_id asc
          limit 2`,
        [
          required(tenantId, "TENANT_REQUIRED"),
          required(subjectId, "SUBJECT_REQUIRED"),
        ],
      )
      if (result.rows.length > 1) {
        throw new PlatformApiError("SUBJECT_IDENTITY_AMBIGUOUS", 409)
      }
      return result.rows[0] ? text(result.rows[0], "subject_id") : null
    },
  }
}
