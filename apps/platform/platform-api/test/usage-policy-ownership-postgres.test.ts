import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"

import { PlatformApiError } from "../src/capabilities/errors"
import type { UsagePolicyRevision } from "../src/capabilities/usage-governance/contract"
import { createPostgresUsageGovernanceDirectory } from "../src/capabilities/usage-governance/postgres"
import { runMigrations } from "../src/persistence/migration-runner"
import { createPostgresSqlAdapter } from "../src/persistence/sql-adapter"

const databaseUrl = process.env.GENIO_ONE_TEST_DATABASE_URL
const tenantId = "tenant-usage-ownership"

function policy(overrides: Partial<UsagePolicyRevision> = {}): UsagePolicyRevision {
  return {
    tenant_id: tenantId,
    usage_policy_id: "shared-policy",
    revision: 1,
    owner_organization_id: "organization-a",
    accounting_key_id: "stable-accounting-key",
    selectors: { consumer_organization_id: "organization-b" },
    limits: { request_quota: { limit: 10, window_seconds: 60 } },
    state: "ACTIVE",
    created_at: 100,
    ...overrides,
  }
}

function conflict(code: string) {
  return (error: unknown) => error instanceof PlatformApiError && error.statusCode === 409 && error.code === code
}

test("PostgreSQL Usage Policy writes serialize first revisions and updates, preserve identity, and roll back releases", { skip: !databaseUrl, timeout: 60_000 }, async () => {
  assert.ok(databaseUrl)
  const schema = `usage_ownership_${randomUUID().replaceAll("-", "")}`
  const admin = createPostgresSqlAdapter({ url: databaseUrl, options: { max: 1, onnotice: () => {} } })
  const sql = createPostgresSqlAdapter({ url: databaseUrl, options: { max: 4, connection: { search_path: schema }, onnotice: () => {} } })
  let reconciliationCalls = 0
  let failReconciliation = false
  const options = {
    now: () => 101,
    releasePublisher: {
      async reconcileInTransaction(input: { transaction: import("../src/persistence/sql-adapter").SqlTransaction; tenantId: string; gatewayId: string; issuedAt: number }) {
        reconciliationCalls += 1
        assert.equal(input.tenantId, tenantId)
        assert.equal(input.gatewayId, "gateway-test")
        await input.transaction.query(
          `insert into usage_reconciliation_receipts (revision_count)
           select count(*) from genio_one_usage_policy_revisions where tenant_id = $1`,
          [tenantId],
        )
        if (failReconciliation) throw new Error("USAGE_TEST_RELEASE_FAILURE")
      },
    },
  }
  try {
    await admin.query(`create schema ${schema}`)
    await runMigrations(sql, { advisoryLockKey: schema })
    await sql.query(
      `insert into genio_one_organizations (tenant_id, organization_id, display_name, slug)
       values ($1, 'organization-a', 'A', 'a'), ($1, 'organization-b', 'B', 'b')`,
      [tenantId],
    )
    await sql.query(
      `insert into genio_one_resources
       (tenant_id, resource_id, display_name, kind, owner_organization_id, authentication_strategy,
        environment_id, version, enforcement_point_id)
       values ($1, 'resource-test', 'Test', 'API', 'organization-a', 'NONE', 'environment-test', 'v1', 'gateway-test')`,
      [tenantId],
    )
    await sql.query(
      `insert into genio_one_publications
       (tenant_id, publication_id, resource_id, endpoint_revision, resource_revision, resource_digest,
        policy_revision, gateway_id, hostname, publication_state)
       values ($1, 'publication-test', 'resource-test', 1, 1, $2, 0, 'gateway-test', 'usage.test', 'PUBLISHED')`,
      [tenantId, "a".repeat(64)],
    )
    await sql.query("create table usage_reconciliation_receipts (revision_count bigint not null)")
    const firstDirectory = createPostgresUsageGovernanceDirectory(sql, options)
    const secondDirectory = createPostgresUsageGovernanceDirectory(sql, options)
    const latestInput = { tenant_id: tenantId, usage_policy_id: "shared-policy" }
    const receiptCount = async () => {
      const result = await sql.query<{ count: string }>("select count(*)::text as count from usage_reconciliation_receipts")
      return Number(result.rows[0]?.count)
    }
    const assertOneWinner = (results: PromiseSettledResult<UsagePolicyRevision>[], revision: number) => {
      const successful = results.filter((result) => result.status === "fulfilled")
      const rejected = results.filter((result) => result.status === "rejected")
      assert.equal(successful.length, 1)
      assert.equal(rejected.length, 1)
      assert.equal(successful[0]?.status === "fulfilled" ? successful[0].value.revision : null, revision)
      assert.ok(rejected[0]?.status === "rejected" && conflict("USAGE_POLICY_REVISION_EXISTS")(rejected[0].reason))
    }
    assert.equal(await firstDirectory.getLatestPolicy(latestInput), null)
    assertOneWinner(await Promise.allSettled([
      firstDirectory.createPolicyRevision(policy()),
      secondDirectory.createPolicyRevision(policy()),
    ]), 1)
    assert.equal(reconciliationCalls, 1)
    assert.equal(await receiptCount(), 1)
    assertOneWinner(await Promise.allSettled([
      firstDirectory.createPolicyRevision(policy({ revision: 2, display_name: "Updated" })),
      secondDirectory.createPolicyRevision(policy({ revision: 2, display_name: "Updated" })),
    ]), 2)
    assert.equal(reconciliationCalls, 2)
    assert.equal(await receiptCount(), 2)
    await assert.rejects(firstDirectory.createPolicyRevision(policy({ revision: 3, owner_organization_id: "organization-b" })), conflict("USAGE_POLICY_OWNER_IMMUTABLE"))
    await assert.rejects(firstDirectory.createPolicyRevision(policy({ revision: 3, accounting_key_id: "reset-key" })), conflict("USAGE_POLICY_ACCOUNTING_KEY_IMMUTABLE"))
    await assert.rejects(firstDirectory.createPolicyRevision(policy({ revision: 4 })), conflict("USAGE_POLICY_REVISION_INVALID"))
    assert.equal(reconciliationCalls, 2)
    assert.equal(await receiptCount(), 2)
    assert.equal((await firstDirectory.getLatestPolicy(latestInput))?.revision, 2)
    await firstDirectory.createPolicyRevision(policy({ revision: 3, state: "RETIRED" }))
    assert.equal((await secondDirectory.getLatestPolicy(latestInput))?.state, "RETIRED")
    assert.deepEqual(await secondDirectory.listActivePolicies({ tenant_id: tenantId }), [])
    await assert.rejects(secondDirectory.createPolicyRevision(policy({ revision: 4, owner_organization_id: "organization-b" })), conflict("USAGE_POLICY_OWNER_IMMUTABLE"))
    await assert.rejects(secondDirectory.createPolicyRevision(policy({ revision: 4, accounting_key_id: "reset-key" })), conflict("USAGE_POLICY_ACCOUNTING_KEY_IMMUTABLE"))
    assert.equal(reconciliationCalls, 3)
    failReconciliation = true
    await assert.rejects(firstDirectory.createPolicyRevision(policy({ revision: 4 })), /USAGE_TEST_RELEASE_FAILURE/)
    assert.equal((await secondDirectory.getLatestPolicy(latestInput))?.revision, 3)
    assert.equal(await receiptCount(), 3)
    const failedRevision = await sql.query("select * from genio_one_usage_policy_revisions where tenant_id = $1 and usage_policy_id = $2 and revision = 4", [tenantId, "shared-policy"])
    assert.equal(failedRevision.rows.length, 0)
    failReconciliation = false
    const restored = await secondDirectory.createPolicyRevision(policy({ revision: 4 }))
    assert.equal(restored.owner_organization_id, "organization-a")
    assert.equal(restored.accounting_key_id, "stable-accounting-key")
    assert.equal(restored.selectors.consumer_organization_id, "organization-b")
    await firstDirectory.createPolicyRevision(policy({ usage_policy_id: "policy-b", owner_organization_id: "organization-b", accounting_key_id: "key-b" }))
    const list = (owner_organization_ids?: readonly string[]) => firstDirectory.listActivePolicies({ tenant_id: tenantId, owner_organization_ids })
    assert.deepEqual((await list()).map((value) => value.usage_policy_id), ["policy-b", "shared-policy"])
    assert.deepEqual((await list(["organization-a"])).map((value) => value.usage_policy_id), ["shared-policy"])
    assert.deepEqual((await list(["organization-b"])).map((value) => value.usage_policy_id), ["policy-b"])
    assert.deepEqual(await list([]), [])
    assert.equal(await firstDirectory.getLatestPolicy({ ...latestInput, tenant_id: "other-tenant" }), null)
    const receipts = await sql.query<{ revision_count: string }>("select revision_count::text as revision_count from usage_reconciliation_receipts order by revision_count")
    assert.deepEqual(receipts.rows.map((row) => Number(row.revision_count)), [1, 2, 3, 4, 5])
  } finally {
    await sql.end()
    await admin.query(`drop schema if exists ${schema} cascade`)
    await admin.end()
  }
})
