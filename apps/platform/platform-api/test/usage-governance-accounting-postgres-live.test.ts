import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"

import type { AccountingIngestInput } from "../src/capabilities/usage-governance/accounting"
import { createPostgresAccountingLedger } from "../src/capabilities/usage-governance/accounting-postgres"
import { runMigrations } from "../src/persistence/migration-runner"
import { createPostgresSqlAdapter } from "../src/persistence/sql-adapter"

const databaseUrl = process.env.GENIO_ONE_TEST_DATABASE_URL

test(
  "PostgreSQL accounting rolls back a valuation failure and replays one canonical ledger entry",
  {
    skip: databaseUrl ? false : "GENIO_ONE_TEST_DATABASE_URL is required to verify live PostgreSQL rollback and replay",
    timeout: 30_000,
  },
  async () => {
    assert.ok(databaseUrl)
    const schema = `accounting_atomic_${randomUUID().replaceAll("-", "")}`
    const tenantId = "tenant-accounting-live"
    const admin = createPostgresSqlAdapter({ url: databaseUrl, options: { max: 1, onnotice: () => {} } })
    const sql = createPostgresSqlAdapter({
      url: databaseUrl,
      options: { max: 1, connection: { search_path: schema }, onnotice: () => {} },
    })
    const input: AccountingIngestInput = {
      invocation: {
        invocation_id: "invocation-live-atomic",
        correlation_id: "correlation-live-atomic",
        tenant_id: tenantId,
        subject_id: "person-alice",
        consumer_organization_id: "organization-consumer",
        resource_owner_organization_id: "organization-owner",
        resource_id: "resource-ai",
        capability_id: "chat",
        use_case_id: "support",
        usage_policy_revisions: ["usage-policy:3"],
        release_revision: "release-3",
        accounting_key_id: "accounting-shared",
        created_at: 1_700_000_000,
      },
      quantities: [{
        quantity_id: "quantity-live-atomic",
        invocation_id: "invocation-live-atomic",
        quantity: 7,
        unit: "INPUT_TOKENS",
        trusted_source: "PROVIDER_RESPONSE",
        observed_at: 1_700_000_001,
      }],
      valuations: [{
        valuation_id: "valuation-live-atomic",
        status: "ESTIMATED",
        currency: "USD",
        amount_micros: 12,
        pricing_source: "LITELLM",
        pricing_version: "pricebook-live-atomic",
        valued_at: 1_700_000_002,
      }],
    }
    const counts = async () => {
      const result = await sql.query<{ invocations: number; charges: number; quantities: number; valuations: number }>(
        `select
           (select count(*)::integer from genio_one_canonical_invocation_accounting) as invocations,
           (select count(*)::integer from genio_one_canonical_charges) as charges,
           (select count(*)::integer from genio_one_usage_quantities) as quantities,
           (select count(*)::integer from genio_one_cost_valuations) as valuations`,
      )
      return result.rows[0]
    }

    try {
      await admin.query(`create schema ${schema}`)
      await runMigrations(sql, { advisoryLockKey: schema })
      const ledger = createPostgresAccountingLedger(sql, tenantId)
      await sql.query(
        `alter table genio_one_cost_valuations
           add constraint test_accounting_valuation_failure
           check (valuation_id <> 'valuation-live-atomic')`,
      )

      await assert.rejects(
        ledger.recordAccounting(input),
        (error: unknown) => error instanceof Error &&
          (error as { code?: string }).code === "23514" &&
          error.message.includes("test_accounting_valuation_failure"),
      )
      assert.deepEqual(await counts(), { invocations: 0, charges: 0, quantities: 0, valuations: 0 })
      assert.deepEqual(await ledger.getByCorrelation({ correlation_id: input.invocation.correlation_id }), [])
      assert.equal(await ledger.getCharge(input.invocation), null)

      await sql.query("alter table genio_one_cost_valuations drop constraint test_accounting_valuation_failure")
      const first = await ledger.recordAccounting(input)
      assert.deepEqual(first.invocation, input.invocation)
      assert.deepEqual(first.quantities, input.quantities)
      assert.deepEqual(first.charge, {
        charge_id: first.charge.charge_id,
        invocation_id: input.invocation.invocation_id,
        correlation_id: input.invocation.correlation_id,
        accounting_key_id: input.invocation.accounting_key_id,
        created_at: input.invocation.created_at,
      })
      assert.match(first.charge.charge_id, /^charge-[a-f0-9]{64}$/)
      assert.deepEqual(first.valuations, input.valuations.map((value) => ({ ...value, charge_id: first.charge.charge_id })))
      assert.deepEqual(await counts(), { invocations: 1, charges: 1, quantities: 1, valuations: 1 })

      const replayed = await createPostgresAccountingLedger(sql, tenantId).recordAccounting(input)
      assert.deepEqual(replayed, first)
      assert.deepEqual(await counts(), { invocations: 1, charges: 1, quantities: 1, valuations: 1 })
      assert.deepEqual(await ledger.getCharge(input.invocation), first.charge)
      assert.deepEqual(await ledger.listValuations({ charge_id: first.charge.charge_id }), first.valuations)
      assert.deepEqual(await ledger.getByCorrelation({ correlation_id: input.invocation.correlation_id }), [first])
    } finally {
      await sql.end()
      await admin.query(`drop schema if exists ${schema} cascade`)
      await admin.end()
    }
  },
)
