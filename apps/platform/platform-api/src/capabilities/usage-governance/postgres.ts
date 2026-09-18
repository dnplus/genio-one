import type { SqlAdapter, SqlTransaction } from "../../persistence/sql-adapter"
import type { ResourceLifecycleReleasePublisher } from "../resources/module"
import type { UsagePolicyRevision } from "./contract"
import type { UsageGovernanceDirectory, UseCase } from "./directory"

type Row = Record<string, unknown>

function timestamp(value: unknown): number {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000)
  const numeric = Number(value)
  if (Number.isSafeInteger(numeric)) return numeric
  const parsed = Date.parse(String(value))
  if (!Number.isFinite(parsed)) throw new Error("USAGE_GOVERNANCE_DATA_INVALID")
  return Math.floor(parsed / 1000)
}

function json<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T
}

function useCase(row: Row): UseCase {
  return {
    tenant_id: String(row.tenant_id),
    organization_id: String(row.organization_id),
    use_case_id: String(row.use_case_id),
    display_name: String(row.display_name),
    risk_level: row.risk_level as UseCase["risk_level"],
    state: row.state as UseCase["state"],
    created_at: timestamp(row.created_at),
  }
}

function policy(row: Row): UsagePolicyRevision {
  return {
    tenant_id: String(row.tenant_id),
    usage_policy_id: String(row.usage_policy_id),
    display_name: row.display_name ? String(row.display_name) : undefined,
    revision: Number(row.revision),
    owner_organization_id: String(row.owner_organization_id),
    accounting_key_id: String(row.accounting_key_id),
    selectors: json(row.selectors),
    limits: json(row.limits),
    state: row.state as UsagePolicyRevision["state"],
    created_at: timestamp(row.created_at),
  }
}

async function reconcileUsageReleases(input: {
  transaction: SqlTransaction
  tenantId: string
  issuedAt: number
  releasePublisher?: ResourceLifecycleReleasePublisher
}) {
  if (!input.releasePublisher) return
  const gateways = await input.transaction.query<Row>(
    `select distinct gateway_id
       from genio_one_publications
      where tenant_id = $1
        and gateway_id is not null
        and publication_state in ('PUBLISHED', 'DEPRECATED')
      order by gateway_id`,
    [input.tenantId],
  )
  for (const row of gateways.rows) {
    await input.releasePublisher.reconcileInTransaction({
      transaction: input.transaction,
      tenantId: input.tenantId,
      gatewayId: String(row.gateway_id),
      issuedAt: input.issuedAt,
    })
  }
}

export function createPostgresUsageGovernanceDirectory(
  sql: SqlAdapter,
  options: { releasePublisher?: ResourceLifecycleReleasePublisher; now?: () => number } = {},
): UsageGovernanceDirectory {
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000))
  return {
    async createUseCase(value) {
      return sql.transaction(async (transaction) => {
        const result = await transaction.query<Row>(
          `insert into genio_one_use_cases
            (tenant_id, organization_id, use_case_id, display_name, risk_level, state, created_at)
           values ($1,$2,$3,$4,$5,$6,to_timestamp($7))
           returning *`,
          [value.tenant_id, value.organization_id, value.use_case_id, value.display_name, value.risk_level, value.state, value.created_at],
        )
        await reconcileUsageReleases({
          transaction,
          tenantId: value.tenant_id,
          issuedAt: now(),
          releasePublisher: options.releasePublisher,
        })
        return useCase(result.rows[0]!)
      })
    },
    async listUseCases(input) {
      const result = await sql.query<Row>(
        `select * from genio_one_use_cases
          where tenant_id = $1 and organization_id = $2
          order by display_name, use_case_id`,
        [input.tenant_id, input.organization_id],
      )
      return result.rows.map(useCase)
    },
    async getActiveUseCase(input) {
      const result = await sql.query<Row>(
        `select * from genio_one_use_cases
          where tenant_id = $1 and organization_id = $2 and use_case_id = $3 and state = 'ACTIVE'`,
        [input.tenant_id, input.organization_id, input.use_case_id],
      )
      return result.rows[0] ? useCase(result.rows[0]) : null
    },
    async createPolicyRevision(value) {
      return sql.transaction(async (transaction) => {
        const result = await transaction.query<Row>(
          `insert into genio_one_usage_policy_revisions
            (tenant_id, usage_policy_id, display_name, revision, owner_organization_id,
             accounting_key_id, selectors, limits, state, created_at)
           select $1,$2,$3,$4,$5,$6,$7::text::jsonb,$8::text::jsonb,$9,to_timestamp($10)
            where $4 = coalesce((select max(revision) + 1 from genio_one_usage_policy_revisions
              where tenant_id = $1 and usage_policy_id = $2), 1)
           returning *`,
          [value.tenant_id, value.usage_policy_id, value.display_name ?? value.usage_policy_id, value.revision, value.owner_organization_id,
            value.accounting_key_id, JSON.stringify(value.selectors), JSON.stringify(value.limits),
            value.state, value.created_at],
        )
        if (!result.rows[0]) throw new Error("USAGE_POLICY_REVISION_INVALID")
        await reconcileUsageReleases({
          transaction,
          tenantId: value.tenant_id,
          issuedAt: now(),
          releasePublisher: options.releasePublisher,
        })
        return policy(result.rows[0])
      })
    },
    async listActivePolicies(input) {
      const result = await sql.query<Row>(
        `select distinct on (usage_policy_id) *
           from genio_one_usage_policy_revisions
          where tenant_id = $1
          order by usage_policy_id, revision desc`,
        [input.tenant_id],
      )
      return result.rows.map(policy).filter((value) => value.state === "ACTIVE")
    },
  }
}
