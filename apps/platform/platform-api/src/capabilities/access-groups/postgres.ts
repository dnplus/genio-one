import * as Value from "typebox/value"

import type { SqlAdapter } from "../../persistence/sql-adapter"
import { PlatformApiError } from "../errors"
import type { AccessGroupAuditEvent, AccessGroupAuditWriter } from "./audit"
import { AccessGroupSchema, type AccessGroup } from "./contract"
import type { AccessGroupRepository } from "./module"

export function normalizeStoredAccessGroup(value: unknown): AccessGroup {
  let decoded = value
  if (typeof value === "string") {
    try {
      decoded = JSON.parse(value)
    } catch {
      throw new PlatformApiError("ACCESS_GROUP_DATA_INVALID", 500)
    }
  }
  if (Value.Check(AccessGroupSchema, decoded)) return structuredClone(decoded)
  throw new PlatformApiError("ACCESS_GROUP_DATA_INVALID", 500)
}

export function createPostgresAccessGroupRepository(options: { sql: SqlAdapter; audit: AccessGroupAuditWriter }): AccessGroupRepository {
  return {
    async list(tenantId) {
      const result = await options.sql.query<{ value: unknown }>(
        "select value from genio_one_access_groups where tenant_id = $1 order by value->>'display_name', access_group_id",
        [tenantId],
      )
      return result.rows.map((row) => normalizeStoredAccessGroup(row.value))
    },
    async forSubject(tenantId, subjectId) {
      const result = await options.sql.query<{ value: unknown }>(
        "select value from genio_one_access_groups where tenant_id = $1 and value->'membership_sources' @> $2::text::jsonb order by access_group_id",
        [tenantId, JSON.stringify([{ subject_ids: [subjectId] }])],
      )
      return result.rows.map((row) => normalizeStoredAccessGroup(row.value))
    },
    async get(tenantId, accessGroupId) {
      const result = await options.sql.query<{ value: unknown }>(
        "select value from genio_one_access_groups where tenant_id = $1 and access_group_id = $2",
        [tenantId, accessGroupId],
      )
      return result.rows[0] ? normalizeStoredAccessGroup(result.rows[0].value) : null
    },
    async save(value, expectedRevision, audit: AccessGroupAuditEvent) {
      return options.sql.transaction(async (transaction) => {
        await transaction.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify([value.tenant_id, "access-group", value.access_group_id])])
        const current = await transaction.query<{ revision: number | string }>(
          "select revision from genio_one_access_groups where tenant_id = $1 and access_group_id = $2 for update",
          [value.tenant_id, value.access_group_id],
        )
        if (Number(current.rows[0]?.revision ?? 0) !== expectedRevision) {
          throw new PlatformApiError("ACCESS_GROUP_REVISION_CONFLICT", 409)
        }
        await transaction.query(
          "insert into genio_one_access_groups (tenant_id, access_group_id, organization_id, revision, value) values ($1,$2,$3,$4,$5::text::jsonb) on conflict (tenant_id, access_group_id) do update set organization_id = excluded.organization_id, revision = excluded.revision, value = excluded.value",
          [value.tenant_id, value.access_group_id, value.organization_id, value.revision, JSON.stringify(value)],
        )
        await transaction.query(
          "insert into genio_one_access_group_revisions (tenant_id, access_group_id, organization_id, revision, value) values ($1,$2,$3,$4,$5::text::jsonb)",
          [value.tenant_id, value.access_group_id, value.organization_id, value.revision, JSON.stringify(value)],
        )
        if (!options.audit.recordInTransaction) {
          throw new PlatformApiError("ACCESS_GROUP_AUDIT_TRANSACTION_REQUIRED", 503)
        }
        await options.audit.recordInTransaction({ transaction, tenantId: value.tenant_id, event: audit })
        return structuredClone(value)
      })
    },
    async history(tenantId, accessGroupId) {
      const result = await options.sql.query<{ value: unknown }>(
        "select value from genio_one_access_group_revisions where tenant_id = $1 and access_group_id = $2 order by revision",
        [tenantId, accessGroupId],
      )
      return result.rows.map((row) => normalizeStoredAccessGroup(row.value))
    },
  }
}
