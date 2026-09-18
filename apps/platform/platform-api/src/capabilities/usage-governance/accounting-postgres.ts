import { createHash } from "node:crypto"

import type { SqlAdapter } from "../../persistence/sql-adapter"
import type { AccountingLedger } from "./accounting"
import type { CanonicalCharge, CostValuation, InvocationAccounting, UsageQuantity } from "./contract"

type Row = Record<string, unknown>

function timestamp(value: unknown): number {
  if (value instanceof Date) return Math.floor(value.getTime() / 1_000)
  const numeric = Number(value)
  if (Number.isSafeInteger(numeric) && numeric >= 0) return numeric
  const parsed = Date.parse(String(value))
  if (!Number.isFinite(parsed)) throw new Error("ACCOUNTING_DATA_INVALID")
  return Math.floor(parsed / 1_000)
}

function json<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T
}

function invocation(row: Row): InvocationAccounting {
  return {
    invocation_id: String(row.invocation_id),
    correlation_id: String(row.correlation_id),
    tenant_id: String(row.tenant_id),
    subject_id: String(row.subject_id),
    consumer_organization_id: String(row.consumer_organization_id),
    resource_owner_organization_id: String(row.resource_owner_organization_id),
    resource_id: String(row.resource_id),
    capability_id: String(row.capability_id),
    use_case_id: String(row.use_case_id),
    usage_policy_revisions: json(row.usage_policy_revisions),
    release_revision: String(row.release_revision),
    accounting_key_id: String(row.accounting_key_id),
    created_at: timestamp(row.created_at),
  }
}

function quantity(row: Row): UsageQuantity {
  return {
    quantity_id: String(row.quantity_id),
    invocation_id: String(row.invocation_id),
    quantity: Number(row.quantity),
    unit: String(row.unit),
    trusted_source: String(row.trusted_source),
    observed_at: timestamp(row.observed_at),
  }
}

function charge(row: Row): CanonicalCharge {
  return {
    charge_id: String(row.charge_id),
    invocation_id: String(row.invocation_id),
    correlation_id: String(row.correlation_id),
    accounting_key_id: String(row.accounting_key_id),
    created_at: timestamp(row.created_at),
  }
}

function valuation(row: Row): CostValuation {
  return {
    valuation_id: String(row.valuation_id),
    charge_id: String(row.charge_id),
    status: row.status as CostValuation["status"],
    currency: String(row.currency),
    amount_micros: Number(row.amount_micros),
    pricing_source: String(row.pricing_source),
    pricing_version: String(row.pricing_version),
    valued_at: timestamp(row.valued_at),
  }
}

function chargeId(invocationId: string, correlationId: string, accountingKeyId: string): string {
  return `charge-${createHash("sha256").update(invocationId).update("\0").update(correlationId).update("\0").update(accountingKeyId).digest("hex")}`
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]))
  }
  return value
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

export function createPostgresAccountingLedger(sql: SqlAdapter, tenantId: string): AccountingLedger {
  return {
    async recordInvocation(value) {
      if (value.tenant_id !== tenantId) throw new Error("INVOCATION_ACCOUNTING_TENANT_MISMATCH")
      const inserted = await sql.query<Row>(
        `insert into genio_one_canonical_invocation_accounting
          (tenant_id, invocation_id, correlation_id, subject_id,
           consumer_organization_id, resource_owner_organization_id,
           resource_id, capability_id, use_case_id, usage_policy_revisions,
           release_revision, accounting_key_id, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text::jsonb,$11,$12,to_timestamp($13))
         on conflict do nothing
         returning *`,
        [tenantId, value.invocation_id, value.correlation_id, value.subject_id,
          value.consumer_organization_id, value.resource_owner_organization_id,
          value.resource_id, value.capability_id, value.use_case_id,
          JSON.stringify(value.usage_policy_revisions), value.release_revision,
          value.accounting_key_id, value.created_at],
      )
      if (inserted.rows[0]) return invocation(inserted.rows[0])
      const existing = await sql.query<Row>(
        `select * from genio_one_canonical_invocation_accounting
          where tenant_id = $1 and invocation_id = $2`,
        [tenantId, value.invocation_id],
      )
      const previous = existing.rows[0] && invocation(existing.rows[0])
      if (!previous || !equal(previous, value)) throw new Error("INVOCATION_ACCOUNTING_CONFLICT")
      return previous
    },
    async appendQuantity(value) {
      const inserted = await sql.query<Row>(
        `insert into genio_one_usage_quantities
          (tenant_id, quantity_id, invocation_id, quantity, unit, trusted_source, observed_at)
         values ($1,$2,$3,$4,$5,$6,to_timestamp($7))
         on conflict do nothing
         returning *`,
        [tenantId, value.quantity_id, value.invocation_id, value.quantity,
          value.unit, value.trusted_source, value.observed_at],
      )
      if (inserted.rows[0]) return quantity(inserted.rows[0])
      const existing = await sql.query<Row>(
        `select * from genio_one_usage_quantities where tenant_id = $1 and quantity_id = $2`,
        [tenantId, value.quantity_id],
      )
      const previous = existing.rows[0] && quantity(existing.rows[0])
      if (!previous || !equal(previous, value)) throw new Error("USAGE_QUANTITY_CONFLICT")
      return previous
    },
    async charge(input) {
      const id = chargeId(input.invocation_id, input.correlation_id, input.accounting_key_id)
      const inserted = await sql.query<Row>(
        `insert into genio_one_canonical_charges
          (tenant_id, charge_id, invocation_id, correlation_id, accounting_key_id, created_at)
         values ($1,$2,$3,$4,$5,to_timestamp($6))
         on conflict do nothing
         returning *`,
        [tenantId, id, input.invocation_id, input.correlation_id, input.accounting_key_id, input.created_at],
      )
      if (inserted.rows[0]) return charge(inserted.rows[0])
      const existing = await sql.query<Row>(
        `select * from genio_one_canonical_charges where tenant_id = $1 and charge_id = $2`,
        [tenantId, id],
      )
      if (!existing.rows[0]) throw new Error("CANONICAL_CHARGE_CONFLICT")
      return charge(existing.rows[0])
    },
    async appendValuation(value) {
      const inserted = await sql.query<Row>(
        `insert into genio_one_cost_valuations
          (tenant_id, valuation_id, charge_id, status, currency, amount_micros,
           pricing_source, pricing_version, valued_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9))
         on conflict do nothing
         returning *`,
        [tenantId, value.valuation_id, value.charge_id, value.status, value.currency,
          value.amount_micros, value.pricing_source, value.pricing_version, value.valued_at],
      )
      if (inserted.rows[0]) return valuation(inserted.rows[0])
      const existing = await sql.query<Row>(
        `select * from genio_one_cost_valuations where tenant_id = $1 and valuation_id = $2`,
        [tenantId, value.valuation_id],
      )
      const previous = existing.rows[0] && valuation(existing.rows[0])
      if (!previous || !equal(previous, value)) throw new Error("COST_VALUATION_CONFLICT")
      return previous
    },
    async getCharge(input) {
      const existing = await sql.query<Row>(
        `select * from genio_one_canonical_charges
          where tenant_id = $1 and charge_id = $2`,
        [tenantId, chargeId(input.invocation_id, input.correlation_id, input.accounting_key_id)],
      )
      return existing.rows[0] ? charge(existing.rows[0]) : null
    },
    async listValuations(input) {
      const existing = await sql.query<Row>(
        `select * from genio_one_cost_valuations
          where tenant_id = $1 and charge_id = $2
          order by valued_at, valuation_id`,
        [tenantId, input.charge_id],
      )
      return existing.rows.map(valuation)
    },
    async getByCorrelation(input) {
      const invocationRows = await sql.query<Row>(
        `select * from genio_one_canonical_invocation_accounting
          where tenant_id = $1 and correlation_id = $2
          order by accounting_key_id, invocation_id`,
        [tenantId, input.correlation_id],
      )
      const result = []
      for (const row of invocationRows.rows) {
        const currentInvocation = invocation(row)
        const chargeRows = await sql.query<Row>(
          `select * from genio_one_canonical_charges
            where tenant_id = $1 and invocation_id = $2
              and correlation_id = $3 and accounting_key_id = $4`,
          [tenantId, currentInvocation.invocation_id, currentInvocation.correlation_id,
            currentInvocation.accounting_key_id],
        )
        if (!chargeRows.rows[0]) continue
        const currentCharge = charge(chargeRows.rows[0])
        const [quantityRows, valuationRows] = await Promise.all([
          sql.query<Row>(
            `select * from genio_one_usage_quantities
              where tenant_id = $1 and invocation_id = $2
              order by quantity_id`,
            [tenantId, currentInvocation.invocation_id],
          ),
          sql.query<Row>(
            `select * from genio_one_cost_valuations
              where tenant_id = $1 and charge_id = $2
              order by valued_at, valuation_id`,
            [tenantId, currentCharge.charge_id],
          ),
        ])
        result.push({
          invocation: currentInvocation,
          quantities: quantityRows.rows.map(quantity),
          charge: currentCharge,
          valuations: valuationRows.rows.map(valuation),
        })
      }
      return result
    },
  }
}
