import assert from "node:assert/strict"
import test from "node:test"

import { createPostgresAccountingLedger } from "../src/capabilities/usage-governance/accounting-postgres"
import type { SqlAdapter, SqlQueryResult, SqlTransaction } from "../src/persistence/sql-adapter"

type Row = Record<string, unknown>
type TableName = "genio_one_canonical_invocation_accounting" | "genio_one_usage_quantities" | "genio_one_canonical_charges" | "genio_one_cost_valuations"

function emptyTables(): Record<TableName, Map<string, Row>> {
  return {
    genio_one_canonical_invocation_accounting: new Map(),
    genio_one_usage_quantities: new Map(),
    genio_one_canonical_charges: new Map(),
    genio_one_cost_valuations: new Map(),
  }
}

class AtomicSql implements SqlAdapter, SqlTransaction {
  private tables = emptyTables()
  private transactionTables: Record<TableName, Map<string, Row>> | undefined
  private failureTable: TableName | undefined
  transactionCount = 0

  constructor(failureTable?: TableName) {
    this.failureTable = failureTable
  }

  get committedRows(): number {
    return Object.values(this.tables).reduce((count, table) => count + table.size, 0)
  }

  async query<Result extends Row = Row>(text: string, parameters: readonly unknown[] = []): Promise<SqlQueryResult<Result>> {
    const table = (Object.keys(this.tables) as TableName[]).find((name) => text.includes(name))
    if (!table) return { rows: [], rowCount: 0 }
    if (text.trimStart().startsWith("insert into")) {
      if (this.failureTable === table) {
        this.failureTable = undefined
        throw new Error("INJECTED_ACCOUNTING_FAILURE")
      }
      const row = this.insertRow(table, parameters)
      const key = String(rowKey(table, row))
      const target = this.transactionTables?.[table] ?? this.tables[table]
      if (target.has(key)) return { rows: [], rowCount: 0 }
      target.set(key, row)
      return { rows: [row as Result], rowCount: 1 }
    }
    const target = this.transactionTables?.[table] ?? this.tables[table]
    const key = String(selectKey(table, parameters))
    const row = target.get(key)
    return { rows: row ? [row as Result] : [], rowCount: row ? 1 : 0 }
  }

  async transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
    this.transactionCount += 1
    const previous = this.transactionTables
    this.transactionTables = cloneTables(this.tables)
    try {
      const result = await work(this)
      this.tables = this.transactionTables
      return result
    } finally {
      this.transactionTables = previous
    }
  }

  private insertRow(table: TableName, parameters: readonly unknown[]): Row {
    if (table === "genio_one_canonical_invocation_accounting") {
      return {
        tenant_id: parameters[0],
        invocation_id: parameters[1],
        correlation_id: parameters[2],
        subject_id: parameters[3],
        consumer_organization_id: parameters[4],
        resource_owner_organization_id: parameters[5],
        resource_id: parameters[6],
        capability_id: parameters[7],
        use_case_id: parameters[8],
        usage_policy_revisions: JSON.parse(String(parameters[9])),
        release_revision: parameters[10],
        accounting_key_id: parameters[11],
        created_at: parameters[12],
      }
    }
    if (table === "genio_one_usage_quantities") {
      return {
        tenant_id: parameters[0],
        quantity_id: parameters[1],
        invocation_id: parameters[2],
        quantity: parameters[3],
        unit: parameters[4],
        trusted_source: parameters[5],
        observed_at: parameters[6],
      }
    }
    if (table === "genio_one_canonical_charges") {
      return {
        tenant_id: parameters[0],
        charge_id: parameters[1],
        invocation_id: parameters[2],
        correlation_id: parameters[3],
        accounting_key_id: parameters[4],
        created_at: parameters[5],
      }
    }
    return {
      tenant_id: parameters[0],
      valuation_id: parameters[1],
      charge_id: parameters[2],
      status: parameters[3],
      currency: parameters[4],
      amount_micros: parameters[5],
      pricing_source: parameters[6],
      pricing_version: parameters[7],
      valued_at: parameters[8],
    }
  }
}

function rowKey(table: TableName, row: Row): string {
  if (table === "genio_one_canonical_invocation_accounting") return `${row.tenant_id}:${row.invocation_id}`
  if (table === "genio_one_usage_quantities") return `${row.tenant_id}:${row.quantity_id}`
  if (table === "genio_one_canonical_charges") return `${row.tenant_id}:${row.charge_id}`
  return `${row.tenant_id}:${row.valuation_id}`
}

function selectKey(table: TableName, parameters: readonly unknown[]): string {
  if (table === "genio_one_canonical_invocation_accounting") return `${parameters[0]}:${parameters[1]}`
  if (table === "genio_one_usage_quantities") return `${parameters[0]}:${parameters[1]}`
  if (table === "genio_one_canonical_charges") return `${parameters[0]}:${parameters[1]}`
  return `${parameters[0]}:${parameters[1]}`
}

function cloneTables(tables: Record<TableName, Map<string, Row>>): Record<TableName, Map<string, Row>> {
  return {
    genio_one_canonical_invocation_accounting: new Map(tables.genio_one_canonical_invocation_accounting),
    genio_one_usage_quantities: new Map(tables.genio_one_usage_quantities),
    genio_one_canonical_charges: new Map(tables.genio_one_canonical_charges),
    genio_one_cost_valuations: new Map(tables.genio_one_cost_valuations),
  }
}

test("Postgres accounting ingest commits all ledger rows together and retries idempotently", async () => {
  const sql = new AtomicSql("genio_one_cost_valuations")
  const ledger = createPostgresAccountingLedger(sql, "tenant-acme")
  const input = {
    invocation: {
      invocation_id: "invocation-atomic",
      correlation_id: "correlation-atomic",
      tenant_id: "tenant-acme",
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
      quantity_id: "quantity-atomic",
      invocation_id: "invocation-atomic",
      quantity: 7,
      unit: "INPUT_TOKENS",
      trusted_source: "PROVIDER_RESPONSE",
      observed_at: 1_700_000_001,
    }],
    valuations: [{
      valuation_id: "valuation-atomic",
      status: "ESTIMATED" as const,
      currency: "USD",
      amount_micros: 12,
      pricing_source: "LITELLM",
      pricing_version: "pricebook-atomic",
      valued_at: 1_700_000_002,
    }],
  }

  await assert.rejects(ledger.recordAccounting(input), /INJECTED_ACCOUNTING_FAILURE/)
  assert.equal(sql.committedRows, 0)

  const first = await ledger.recordAccounting(input)
  assert.equal(sql.committedRows, 4)
  const repeated = await ledger.recordAccounting(input)
  assert.equal(sql.committedRows, 4)
  assert.equal(repeated.charge.charge_id, first.charge.charge_id)
  assert.deepEqual(repeated.quantities, first.quantities)
  assert.deepEqual(repeated.valuations, first.valuations)
  assert.equal(sql.transactionCount, 3)
})
