import { requireBotPolicyDraft, type PolicyDraft, defaultBotRules, type BotRules, type BotPolicyRevision } from "./drafts"
import { PlatformApiError } from "../errors"
import type { SqlAdapter, SqlTransaction } from "../../persistence/sql-adapter"
import type { OnePolicyBotSeed } from "./contract"
import { POLICY_ID, POLICY_REVISION } from "./default"
import type { OnePolicySeedStore } from "./module"

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
      return options.sql.transaction((transaction) => publish(transaction, input))
    },
    async publishDraft({ tenantId, expectedVersion, publishedBy }) {
      return options.sql.transaction(async (transaction) => {
        const result = await transaction.query<{ value: PolicyDraft }>("select value from genio_one_policy_drafts where tenant_id = $1 and policy_key = $2 for update", [tenantId, POLICY_ID])
        const definition = requireBotPolicyDraft(result.rows[0]?.value ?? null, expectedVersion)
        const published = await publish(transaction, { tenantId, publishedBy, ...definition })
        const removed = await transaction.query("update genio_one_policy_drafts set value = 'null'::jsonb where tenant_id = $1 and policy_key = $2 and (value->>'version')::int = $3 returning policy_key", [tenantId, POLICY_ID, expectedVersion])
        if (removed.rowCount !== 1) throw new PlatformApiError("POLICY_DRAFT_CONFLICT", 409)
        return published
      })
    },
    async setEnabled({ tenantId, enabled }) {
      const at = now()
      const result = await options.sql.query<Row>(
        `insert into genio_one_first_party_policy_seeds
           (tenant_id, policy_id, policy_revision, seed, enabled, created_at, updated_at)
         values ($1, $2, $3, true, $4, to_timestamp($5), to_timestamp($5))
         on conflict (tenant_id, policy_id) do update
           set enabled = excluded.enabled, updated_at = excluded.updated_at
         returning ${COLUMNS}`,
        [tenantId, POLICY_ID, POLICY_REVISION, enabled, at],
      )
      return mapSeed(result.rows[0]!)
    },
  }
}
