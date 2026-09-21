import { requireBotPolicyDraft, policyDraftFromStoredValue, defaultBotRules, type BotRules, type BotPolicyRevision } from "./drafts"
import { PlatformApiError } from "../errors"
import type { SqlAdapter, SqlTransaction } from "../../persistence/sql-adapter"
import type { OnePolicyBotSeed } from "./contract"
import { POLICY_ID, POLICY_REVISION } from "./default"
import type { OnePolicySeedStore } from "./module"
import type { GatewayAuthorizationAuditStore } from "../audit-events/module"
import { policyChangeAuditEvent, policyEnabledAuditEvent, policySystemPublishAuditEvent } from "./lifecycle"

type Row = Record<string, unknown>

function text(row: Row, key: string): string {
  const value = row[key]
  return typeof value === "string" ? value : String(value ?? "")
}

function timestamp(value: unknown): number {
  if (value instanceof Date) return Math.floor(value.getTime() / 1_000)
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : Number(value)
}

function boolean(value: unknown): boolean {
  return value === true || value === "true"
}

function mapSeed(row: Row): OnePolicyBotSeed {
  return {
    tenant_id: text(row, "tenant_id"),
    policy_id: text(row, "policy_id") as OnePolicyBotSeed["policy_id"],
    policy_revision: Number(row.policy_revision) as OnePolicyBotSeed["policy_revision"],
    seed: true,
    rules: (row.rules ?? structuredClone(defaultBotRules)) as BotRules,
    enabled: boolean(row.enabled),
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at),
  }
}

const COLUMNS = `tenant_id, policy_id, policy_revision, seed, enabled, rules, created_at, updated_at`

export function createPostgresOnePolicySeedStore(options: {
  sql: SqlAdapter
  now?: () => number
  audit?: GatewayAuthorizationAuditStore
}): OnePolicySeedStore {
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000))
  async function publish(transaction: SqlTransaction, { tenantId, baseRevision, rules, publishedBy }: Parameters<OnePolicySeedStore["publish"]>[0]) {
        const result = await transaction.query<Row>(
          `update genio_one_first_party_policy_seeds set rules = $3::text::jsonb, policy_revision = policy_revision + 1, updated_at = to_timestamp($4)
           where tenant_id = $1 and policy_id = $2 and policy_revision = $5 returning ${COLUMNS}`,
          [tenantId, POLICY_ID, JSON.stringify(rules), now(), baseRevision],
        )
        if (!result.rows[0]) throw new PlatformApiError("POLICY_REVISION_CONFLICT", 409)
        await transaction.query("insert into genio_one_bot_policy_revisions (tenant_id, policy_id, policy_revision, rules, published_by, published_at) values ($1, $2, $3, $4::text::jsonb, $5, $6)", [tenantId, POLICY_ID, baseRevision + 1, JSON.stringify(rules), publishedBy, now()])
        return mapSeed(result.rows[0])
  }
  return {
    async getOrCreate({ tenantId }) {
      await options.sql.query(
        `insert into genio_one_first_party_policy_seeds
           (tenant_id, policy_id, policy_revision, seed, enabled, created_at, updated_at)
         values ($1, $2, $3, true, true, to_timestamp($4), to_timestamp($4))
         on conflict (tenant_id, policy_id) do nothing`,
        [tenantId, POLICY_ID, POLICY_REVISION, now()],
      )
      const result = await options.sql.query<Row>(
        `select ${COLUMNS} from genio_one_first_party_policy_seeds
          where tenant_id = $1 and policy_id = $2`,
        [tenantId, POLICY_ID],
      )
      if (!result.rows[0]) throw new Error("FIRST_PARTY_POLICY_SEED_NOT_FOUND")
      const current = mapSeed(result.rows[0])
      if (current.policy_revision === 1) await options.sql.query("insert into genio_one_bot_policy_revisions (tenant_id, policy_id, policy_revision, rules, published_by, published_at) values ($1, $2, 1, $3::text::jsonb, null, $4) on conflict do nothing", [tenantId, POLICY_ID, JSON.stringify(current.rules), current.created_at])
      return current
    },
    async revisions(tenantId) {
      const result = await options.sql.query<Row>("select policy_revision, rules, published_by, published_at from genio_one_bot_policy_revisions where tenant_id = $1 and policy_id = $2 order by policy_revision desc", [tenantId, POLICY_ID])
      return result.rows.map((row): BotPolicyRevision => ({ policy_revision: Number(row.policy_revision), rules: row.rules as BotRules, published_by: row.published_by ? text(row, "published_by") : null, published_at: Number(row.published_at) }))
    },
    async publish(input) {
      return options.sql.transaction(async (transaction) => {
        const published = await publish(transaction, input)
        if (options.audit) {
          if (!options.audit.recordInTransaction) throw new PlatformApiError("POLICY_AUDIT_TRANSACTION_UNAVAILABLE", 500)
          await options.audit.recordInTransaction({
            transaction,
            tenantId: input.tenantId,
            event: policySystemPublishAuditEvent({
              tenantId: input.tenantId,
              policyKey: POLICY_ID,
              publishedRevision: published.policy_revision,
              content: input.rules,
              actorSubjectId: input.publishedBy,
              correlationId: input.correlationId ?? `policy-system-${POLICY_ID}-${published.policy_revision}`,
              occurredAt: now(),
            }),
          })
        }
        return published
      })
    },
    async publishDraft({ tenantId, expectedVersion, expectedContentDigest, publishedBy, correlationId }) {
      return options.sql.transaction(async (transaction) => {
        const result = await transaction.query<{ value: unknown }>("select value from genio_one_policy_drafts where tenant_id = $1 and policy_key = $2 for update", [tenantId, POLICY_ID])
        const draft = policyDraftFromStoredValue(result.rows[0]?.value ?? null)
        if (!draft) throw new PlatformApiError("POLICY_DRAFT_CONFLICT", 409)
        const definition = requireBotPolicyDraft(draft, expectedVersion, expectedContentDigest)
        const published = await publish(transaction, { tenantId, publishedBy, ...definition })
        if (options.audit) {
          if (!options.audit.recordInTransaction) throw new PlatformApiError("POLICY_AUDIT_TRANSACTION_UNAVAILABLE", 500)
          await options.audit.recordInTransaction({
            transaction,
            tenantId,
            event: policyChangeAuditEvent({
              tenantId,
              policyKey: POLICY_ID,
              draft,
              action: "PUBLISHED",
              actorSubjectId: publishedBy,
              correlationId: correlationId ?? `policy-publish-${POLICY_ID}-${expectedVersion}`,
              occurredAt: now(),
              publishedRevision: published.policy_revision,
            }),
          })
        }
        const removed = await transaction.query("update genio_one_policy_drafts set value = 'null'::jsonb where tenant_id = $1 and policy_key = $2 and (value->>'version')::int = $3 and value->>'content_digest' = $4 and value->>'lifecycle' = 'REVIEWED' returning policy_key", [tenantId, POLICY_ID, expectedVersion, expectedContentDigest])
        if (removed.rowCount !== 1) throw new PlatformApiError("POLICY_DRAFT_CONFLICT", 409)
        return published
      })
    },
    async setEnabled({ tenantId, enabled, publishedBy, correlationId }) {
      return options.sql.transaction(async (transaction) => {
        const audit = options.audit
        if (!audit?.recordInTransaction) throw new PlatformApiError("POLICY_AUDIT_UNAVAILABLE", 503)
        await transaction.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify([tenantId, POLICY_ID])])
        const initialAt = now()
        await transaction.query(
          `insert into genio_one_first_party_policy_seeds
             (tenant_id, policy_id, policy_revision, seed, enabled, created_at, updated_at)
           values ($1, $2, $3, true, true, to_timestamp($4), to_timestamp($4))
           on conflict (tenant_id, policy_id) do nothing`,
          [tenantId, POLICY_ID, POLICY_REVISION, initialAt],
        )
        const currentResult = await transaction.query<Row>(
          `select ${COLUMNS} from genio_one_first_party_policy_seeds
            where tenant_id = $1 and policy_id = $2
            for update`,
          [tenantId, POLICY_ID],
        )
        if (!currentResult.rows[0]) throw new PlatformApiError("FIRST_PARTY_POLICY_SEED_NOT_FOUND", 500)
        const current = mapSeed(currentResult.rows[0])
        if (current.policy_revision === POLICY_REVISION) {
          await transaction.query(
            `insert into genio_one_bot_policy_revisions
               (tenant_id, policy_id, policy_revision, rules, published_by, published_at)
             values ($1, $2, $3, $4::text::jsonb, null, $5)
             on conflict do nothing`,
            [tenantId, POLICY_ID, POLICY_REVISION, JSON.stringify(current.rules), current.created_at],
          )
        }
        const at = now()
        const result = await transaction.query<Row>(
          `update genio_one_first_party_policy_seeds
              set policy_revision = policy_revision + 1,
                  enabled = $3,
                  updated_at = to_timestamp($4)
            where tenant_id = $1 and policy_id = $2 and policy_revision = $5
          returning ${COLUMNS}`,
          [tenantId, POLICY_ID, enabled, at, current.policy_revision],
        )
        if (!result.rows[0]) throw new PlatformApiError("POLICY_REVISION_CONFLICT", 409)
        const next = mapSeed(result.rows[0])
        const history = await transaction.query(
          `insert into genio_one_bot_policy_revisions
             (tenant_id, policy_id, policy_revision, rules, published_by, published_at)
           values ($1, $2, $3, $4::text::jsonb, $5, $6)`,
          [tenantId, POLICY_ID, next.policy_revision, JSON.stringify(next.rules), publishedBy, at],
        )
        if (history.rowCount !== 1) throw new PlatformApiError("POLICY_REVISION_CONFLICT", 409)
        await audit.recordInTransaction({
          transaction,
          tenantId,
          event: policyEnabledAuditEvent({
            tenantId,
            policyKey: POLICY_ID,
            previousRevision: current.policy_revision,
            publishedRevision: next.policy_revision,
            enabled,
            content: { enabled: next.enabled, rules: next.rules },
            actorSubjectId: publishedBy,
            correlationId,
            occurredAt: at,
          }),
        })
        return next
      })
    },
  }
}
