import { createHash } from "node:crypto"

import type { CanonicalCharge, CostValuation, InvocationAccounting, UsageQuantity } from "./contract"

export interface AccountingLedger {
  recordInvocation(value: InvocationAccounting): Promise<InvocationAccounting>
  appendQuantity(value: UsageQuantity): Promise<UsageQuantity>
  charge(input: { invocation_id: string; correlation_id: string; accounting_key_id: string; created_at: number }): Promise<CanonicalCharge>
  appendValuation(value: CostValuation): Promise<CostValuation>
  getCharge(input: { invocation_id: string; correlation_id: string; accounting_key_id: string }): Promise<CanonicalCharge | null>
  listValuations(input: { charge_id: string }): Promise<CostValuation[]>
  getByCorrelation(input: { correlation_id: string }): Promise<Array<{
    invocation: InvocationAccounting
    quantities: UsageQuantity[]
    charge: CanonicalCharge
    valuations: CostValuation[]
  }>>
}

function chargeId(invocationId: string, correlationId: string, accountingKeyId: string): string {
  return `charge-${createHash("sha256").update(invocationId).update("\0").update(correlationId).update("\0").update(accountingKeyId).digest("hex")}`
}

export function createInMemoryAccountingLedger(): AccountingLedger {
  const invocations = new Map<string, InvocationAccounting>()
  const quantities = new Map<string, UsageQuantity>()
  const charges = new Map<string, CanonicalCharge>()
  const valuations = new Map<string, CostValuation>()
  return {
    async recordInvocation(value) {
      const previous = invocations.get(value.invocation_id)
      if (previous && JSON.stringify(previous) !== JSON.stringify(value)) throw new Error("INVOCATION_ACCOUNTING_CONFLICT")
      invocations.set(value.invocation_id, structuredClone(value))
      return structuredClone(value)
    },
    async appendQuantity(value) {
      const previous = quantities.get(value.quantity_id)
      if (previous && JSON.stringify(previous) !== JSON.stringify(value)) throw new Error("USAGE_QUANTITY_CONFLICT")
      quantities.set(value.quantity_id, structuredClone(value))
      return structuredClone(value)
    },
    async charge(input) {
      const id = chargeId(input.invocation_id, input.correlation_id, input.accounting_key_id)
      const previous = charges.get(id)
      if (previous) return structuredClone(previous)
      const value = { charge_id: id, ...input }
      charges.set(id, value)
      return structuredClone(value)
    },
    async appendValuation(value) {
      const previous = valuations.get(value.valuation_id)
      if (previous && JSON.stringify(previous) !== JSON.stringify(value)) throw new Error("COST_VALUATION_CONFLICT")
      valuations.set(value.valuation_id, structuredClone(value))
      return structuredClone(value)
    },
    async getCharge(input) {
      return structuredClone(charges.get(chargeId(input.invocation_id, input.correlation_id, input.accounting_key_id)) ?? null)
    },
    async listValuations(input) {
      return [...valuations.values()].filter((value) => value.charge_id === input.charge_id)
        .sort((left, right) => left.valued_at - right.valued_at)
        .map((value) => structuredClone(value))
    },
    async getByCorrelation(input) {
      return [...invocations.values()]
        .filter((value) => value.correlation_id === input.correlation_id)
        .sort((left, right) => left.accounting_key_id.localeCompare(right.accounting_key_id))
        .flatMap((entry) => {
          const canonicalCharge = charges.get(chargeId(
            entry.invocation_id,
            entry.correlation_id,
            entry.accounting_key_id,
          ))
          if (!canonicalCharge) return []
          return [{
            invocation: structuredClone(entry),
            quantities: [...quantities.values()]
              .filter((value) => value.invocation_id === entry.invocation_id)
              .sort((left, right) => left.quantity_id.localeCompare(right.quantity_id))
              .map((value) => structuredClone(value)),
            charge: structuredClone(canonicalCharge),
            valuations: [...valuations.values()]
              .filter((value) => value.charge_id === canonicalCharge.charge_id)
              .sort((left, right) => left.valued_at - right.valued_at)
              .map((value) => structuredClone(value)),
          }]
        })
    },
  }
}
