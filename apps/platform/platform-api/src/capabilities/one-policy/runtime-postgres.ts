import { requireRuntimePolicyDraft, runtimePolicyDraftKey, type PolicyDraft } from "./drafts"
import { Type } from "typebox"
import * as Value from "typebox/value"

import { PlatformApiError } from "../errors"
import type { SqlAdapter, SqlTransaction } from "../../persistence/sql-adapter"
import type { RuntimePolicyStore } from "./module"
import {
  RuntimePolicyDefinitionSchema,
  RuntimePolicyRevisionSchema,
  RUNTIME_POLICY_ID,
  type RuntimePolicyDefinition,
  type RuntimePolicyRevision,
} from "./runtime"

type Row = Record<string, unknown>

const RuntimePolicyRowSchema = Type.Object({
  tenant_id: Type.String(),
  policy_id: Type.String(),
  revision: Type.Union([Type.Integer(), Type.String()]),
  display_name: Type.String(),
  provenance: Type.String(),
  enabled: Type.Union([Type.Boolean(), Type.Literal("true"), Type.Literal("false")]),
  scope: Type.Unknown(),
  rules: Type.Unknown(),
  published_by_subject_id: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.Unknown(),
  published_at: Type.Unknown(),
})

const COLUMNS = `tenant_id, policy_id, revision, display_name, provenance, enabled,
  scope, rules, published_by_subject_id,
  extract(epoch from created_at)::bigint as created_at,
  extract(epoch from published_at)::bigint as published_at`

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new PlatformApiError("RUNTIME_POLICY_DATA_INVALID", 500)
  }
}

function timestamp(value: unknown): number {
  if (value instanceof Date) return Math.floor(value.getTime() / 1_000)
  const numberValue = Number(value)
  if (Number.isSafeInteger(numberValue)) return numberValue
  const parsed = Date.parse(String(value))
  if (!Number.isFinite(parsed)) throw new PlatformApiError("RUNTIME_POLICY_DATA_INVALID", 500)
  return Math.floor(parsed / 1_000)
}

function integer(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new PlatformApiError("RUNTIME_POLICY_DATA_INVALID", 500)
  return parsed
}

function boolean(value: unknown): boolean {
  if (value === true || value === "true") return true
  if (value === false || value === "false") return false
  throw new PlatformApiError("RUNTIME_POLICY_DATA_INVALID", 500)
}

function mapRevision(row: Row): RuntimePolicyRevision {
  if (!Value.Check(RuntimePolicyRowSchema, row)) throw new PlatformApiError("RUNTIME_POLICY_DATA_INVALID", 500)
  const value = {
    tenant_id: String(row.tenant_id),
    policy_id: String(row.policy_id),
    revision: integer(row.revision),
    display_name: String(row.display_name),
    provenance: row.provenance,
    enabled: boolean(row.enabled),
    scope: jsonValue(row.scope),
    rules: jsonValue(row.rules),
    published_by_subject_id: row.published_by_subject_id,
    created_at: timestamp(row.created_at),
    published_at: timestamp(row.published_at),
  }
  if (!Value.Check(RuntimePolicyRevisionSchema, value)) throw new PlatformApiError("RUNTIME_POLICY_DATA_INVALID", 500)
  return value as RuntimePolicyRevision
}

async function latest(
  executor: SqlAdapter | SqlTransaction,
  tenantId: string,
  policyId: string,
  forUpdate = false,
): Promise<RuntimePolicyRevision | null> {
  const result = await executor.query<Row>(
    `select ${COLUMNS}
       from genio_one_policy_revisions
      where tenant_id = $1 and policy_id = $2
      order by revision desc
      limit 1${forUpdate ? " for update" : ""}`,
    [tenantId, policyId],
  )
  return result.rows[0] ? mapRevision(result.rows[0]) : null
}

export function createPostgresRuntimePolicyStore(options: { sql: SqlAdapter; now?: () => number }): RuntimePolicyStore {
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000))
  async function publish(transaction: SqlTransaction, { tenantId, policyId, baseRevision, definition, publishedBy, displayName }: Parameters<RuntimePolicyStore["publish"]>[0]): Promise<RuntimePolicyRevision> {
    if (!Value.Check(RuntimePolicyDefinitionSchema, definition)) throw new PlatformApiError("RUNTIME_POLICY_DEFINITION_INVALID", 422)
    await transaction.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify([tenantId, policyId])])
    const current = await latest(transaction, tenantId, policyId, true)
    if ((!current && baseRevision !== 0) || (current && current.revision !== baseRevision)) throw new PlatformApiError("POLICY_REVISION_CONFLICT", 409)
    const at = now()
    const nextRevision = (current?.revision ?? 0) + 1
    const result = await transaction.query<Row>(
      `insert into genio_one_policy_revisions
        (tenant_id, policy_id, revision, display_name, provenance, enabled, scope, rules, published_by_subject_id, created_at, published_at)
       values ($1,$2,$3,$4,$5,$6,$7::text::jsonb,$8::text::jsonb,$9,to_timestamp($10),to_timestamp($10))
       returning ${COLUMNS}`,
      [tenantId, policyId, nextRevision, displayName ?? definition.display_name ?? current?.display_name ?? policyId, current?.provenance ?? "TENANT_AUTHORED", current?.enabled ?? true, JSON.stringify(definition.scope), JSON.stringify(definition.rules), publishedBy, at],
    )
    if (!result.rows[0]) throw new PlatformApiError("RUNTIME_POLICY_PUBLISH_FAILED", 500)
    return mapRevision(result.rows[0])
  }

  return {
    async list(tenantId) {
      const result = await options.sql.query<Row>(
        `select ${COLUMNS}
           from genio_one_policy_revisions
          where tenant_id = $1
          order by policy_id, revision desc`,
        [tenantId],
      )
      return result.rows.map(mapRevision)
    },
    async listLatest(tenantId) {
      const result = await options.sql.query<Row>(
        `select distinct on (policy_id) ${COLUMNS}
           from genio_one_policy_revisions
          where tenant_id = $1
          order by policy_id, revision desc`,
        [tenantId],
      )
      return result.rows.map(mapRevision).sort((left, right) => left.policy_id.localeCompare(right.policy_id))
    },
    async getLatest({ tenantId, policyId }) {
      if (policyId) return latest(options.sql, tenantId, policyId)
      const values = await this.listLatest(tenantId)
      return values[0] ?? null
    },
    async getRevision({ tenantId, policyId, revision }) {
      const result = await options.sql.query<Row>(
        `select ${COLUMNS}
           from genio_one_policy_revisions
          where tenant_id = $1 and policy_id = $2 and revision = $3`,
        [tenantId, policyId, revision],
      )
      return result.rows[0] ? mapRevision(result.rows[0]) : null
    },
    async ensureDefault({ tenantId }) {
      const current = await latest(options.sql, tenantId, RUNTIME_POLICY_ID)
      if (current) return current
      const at = now()
      const definition: RuntimePolicyDefinition = {
        display_name: "Agent Runtime Capabilities",
        scope: { subject_ids: [], organization_ids: [], roles: [], client_ids: [], bot_ids: [], runtime_ids: [] },
        rules: [],
      }
      const result = await options.sql.query<Row>(
        `insert into genio_one_policy_revisions
          (tenant_id, policy_id, revision, display_name, provenance, enabled, scope, rules, published_by_subject_id, created_at, published_at)
         values ($1,$2,1,$3,'SYSTEM_SEED',true,$4::text::jsonb,$5::text::jsonb,null,to_timestamp($6),to_timestamp($6))
         on conflict (tenant_id, policy_id, revision) do nothing
         returning ${COLUMNS}`,
        [tenantId, RUNTIME_POLICY_ID, definition.display_name, JSON.stringify(definition.scope), JSON.stringify(definition.rules), at],
      )
      if (result.rows[0]) return mapRevision(result.rows[0])
      const raced = await latest(options.sql, tenantId, RUNTIME_POLICY_ID)
      if (!raced) throw new PlatformApiError("RUNTIME_POLICY_DATA_INVALID", 500)
      return raced
    },
    async publish(input) {
      return options.sql.transaction((transaction) => publish(transaction, input))
    },
    async publishDraft({ tenantId, policyId, expectedVersion, publishedBy }) {
      return options.sql.transaction(async (transaction) => {
        const key = runtimePolicyDraftKey(policyId)
        const result = await transaction.query<{ value: PolicyDraft }>(
          "select value from genio_one_policy_drafts where tenant_id = $1 and policy_key = $2 for update",
          [tenantId, key],
        )
        const definition = requireRuntimePolicyDraft(result.rows[0]?.value ?? null, expectedVersion)
        const published = await publish(transaction, { tenantId, policyId, publishedBy, ...definition })
        const removed = await transaction.query(
          "update genio_one_policy_drafts set value = 'null'::jsonb where tenant_id = $1 and policy_key = $2 and (value->>'version')::int = $3 returning policy_key",
          [tenantId, key, expectedVersion],
        )
        if (removed.rowCount !== 1) throw new PlatformApiError("POLICY_DRAFT_CONFLICT", 409)
        return published
      })
    },
    async setEnabled({ tenantId, policyId, expectedRevision, enabled, publishedBy }) {
      return options.sql.transaction(async (transaction) => {
        await transaction.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify([tenantId, policyId])])
        const current = await latest(transaction, tenantId, policyId, true)
        if (!current || current.revision !== expectedRevision) throw new PlatformApiError("POLICY_REVISION_CONFLICT", 409)
        const at = now()
        const result = await transaction.query<Row>(
          `insert into genio_one_policy_revisions
            (tenant_id, policy_id, revision, display_name, provenance, enabled, scope, rules, published_by_subject_id, created_at, published_at)
           values ($1,$2,$3,$4,$5,$6,$7::text::jsonb,$8::text::jsonb,$9,to_timestamp($10),to_timestamp($10))
           returning ${COLUMNS}`,
          [tenantId, policyId, current.revision + 1, current.display_name, current.provenance, enabled, JSON.stringify(current.scope), JSON.stringify(current.rules), publishedBy, at],
        )
        if (!result.rows[0]) throw new PlatformApiError("RUNTIME_POLICY_PUBLISH_FAILED", 500)
        return mapRevision(result.rows[0])
      })
    },
  }
}
