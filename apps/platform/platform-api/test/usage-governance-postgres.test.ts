import assert from "node:assert/strict"
import test from "node:test"

import { createPostgresUsageGovernanceDirectory } from "../src/capabilities/usage-governance/postgres"
import type { SqlAdapter, SqlQueryResult, SqlTransaction } from "../src/persistence/sql-adapter"

type Row = Record<string, unknown>

class UsageTransaction implements SqlAdapter, SqlTransaction {
  async query<Result extends Row = Row>(text: string): Promise<SqlQueryResult<Result>> {
    const rows = text.includes("insert into genio_one_use_cases")
      ? [{
          tenant_id: "tenant-acme",
          organization_id: "organization-consumer",
          use_case_id: "support",
          display_name: "Customer support",
          risk_level: "HIGH",
          state: "ACTIVE",
          created_at: 100,
        }]
      : text.includes("insert into genio_one_usage_policy_revisions")
        ? [{
            tenant_id: "tenant-acme",
            usage_policy_id: "usage-support",
            revision: 1,
            owner_organization_id: "organization-consumer",
            accounting_key_id: "accounting-shared",
            selectors: { use_case_id: "support" },
            limits: { request_quota: { limit: 10, window_seconds: 60 } },
            state: "ACTIVE",
            created_at: 100,
          }]
        : text.includes("select distinct gateway_id")
          ? [{ gateway_id: "gateway-ai" }]
          : []
    return { rows: rows as unknown as Result[], rowCount: rows.length }
  }

  async transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
    return work(this)
  }

  async end(): Promise<void> {}
}

test("Use Case and Usage Policy mutations publish a successor aggregate release in the same transaction", async () => {
  const sql = new UsageTransaction()
  const reconciled: Array<{ transaction: SqlTransaction; tenantId: string; gatewayId: string }> = []
  const directory = createPostgresUsageGovernanceDirectory(sql, {
    now: () => 101,
    releasePublisher: {
      async reconcileInTransaction(input) {
        reconciled.push(input)
      },
    },
  })
  await directory.createUseCase({
    tenant_id: "tenant-acme",
    organization_id: "organization-consumer",
    use_case_id: "support",
    display_name: "Customer support",
    risk_level: "HIGH",
    state: "ACTIVE",
    created_at: 100,
  })
  await directory.createPolicyRevision({
    tenant_id: "tenant-acme",
    usage_policy_id: "usage-support",
    revision: 1,
    owner_organization_id: "organization-consumer",
    accounting_key_id: "accounting-shared",
    selectors: { use_case_id: "support" },
    limits: { request_quota: { limit: 10, window_seconds: 60 } },
    state: "ACTIVE",
    created_at: 100,
  })
  assert.equal(reconciled.length, 2)
  assert.ok(reconciled.every((value) => value.transaction === sql))
  assert.ok(reconciled.every((value) => value.tenantId === "tenant-acme" && value.gatewayId === "gateway-ai"))
})
