import { createHash } from "node:crypto"

import type { CanonicalCharge, CostValuation, InvocationAccounting, UsageQuantity } from "./contract"

export interface AccountingIngestInput {
  invocation: InvocationAccounting
  quantities: readonly UsageQuantity[]
  valuations: readonly Omit<CostValuation, "charge_id">[]
}

export interface AccountingReceipt {
  invocation: InvocationAccounting
  quantities: UsageQuantity[]
  charge: CanonicalCharge
  valuations: CostValuation[]
}

export interface AccountingLedger {
  recordInvocation(value: InvocationAccounting): Promise<InvocationAccounting>
  appendQuantity(value: UsageQuantity): Promise<UsageQuantity>
  charge(input: { invocation_id: string; correlation_id: string; accounting_key_id: string; created_at: number }): Promise<CanonicalCharge>
  appendValuation(value: CostValuation): Promise<CostValuation>
  recordAccounting(input: AccountingIngestInput): Promise<AccountingReceipt>
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
  let invocations = new Map<string, InvocationAccounting>()
  let quantities = new Map<string, UsageQuantity>()
  let charges = new Map<string, CanonicalCharge>()
  let valuations = new Map<string, CostValuation>()

  function recordInvocationInState(state: Map<string, InvocationAccounting>, value: InvocationAccounting): InvocationAccounting {
    const previous = state.get(value.invocation_id)
    if (previous && JSON.stringify(previous) !== JSON.stringify(value)) throw new Error("INVOCATION_ACCOUNTING_CONFLICT")
    state.set(value.invocation_id, structuredClone(value))
    return structuredClone(value)
  }

  function appendQuantityInState(state: Map<string, UsageQuantity>, value: UsageQuantity): UsageQuantity {
    const previous = state.get(value.quantity_id)
    if (previous && JSON.stringify(previous) !== JSON.stringify(value)) throw new Error("USAGE_QUANTITY_CONFLICT")
    state.set(value.quantity_id, structuredClone(value))
    return structuredClone(value)
  }

  function chargeInState(state: Map<string, CanonicalCharge>, input: { invocation_id: string; correlation_id: string; accounting_key_id: string; created_at: number }): CanonicalCharge {
    const id = chargeId(input.invocation_id, input.correlation_id, input.accounting_key_id)
    const previous = state.get(id)
    if (previous) return structuredClone(previous)
    const value = { charge_id: id, ...input }
    state.set(id, value)
    return structuredClone(value)
  }

  function appendValuationInState(state: Map<string, CostValuation>, value: CostValuation): CostValuation {
    const previous = state.get(value.valuation_id)
    if (previous && JSON.stringify(previous) !== JSON.stringify(value)) throw new Error("COST_VALUATION_CONFLICT")
    state.set(value.valuation_id, structuredClone(value))
    return structuredClone(value)
  }

  return {
    async recordAccounting(input) {
      if (input.quantities.some((value) => value.invocation_id !== input.invocation.invocation_id)) {
        throw new Error("INVOCATION_ACCOUNTING_MISMATCH")
      }
      const nextInvocations = new Map(invocations)
      const nextQuantities = new Map(quantities)
      const nextCharges = new Map(charges)
      const nextValuations = new Map(valuations)
      const invocation = recordInvocationInState(nextInvocations, input.invocation)
      const charge = chargeInState(nextCharges, {
        invocation_id: invocation.invocation_id,
        correlation_id: invocation.correlation_id,
        accounting_key_id: invocation.accounting_key_id,
        created_at: invocation.created_at,
      })
      const recordedQuantities = input.quantities.map((value) => appendQuantityInState(nextQuantities, value))
      const recordedValuations = input.valuations.map((value) => appendValuationInState(nextValuations, {
        ...value,
        charge_id: charge.charge_id,
      }))
      invocations = nextInvocations
      quantities = nextQuantities
      charges = nextCharges
      valuations = nextValuations
      return { invocation, quantities: recordedQuantities, charge, valuations: recordedValuations }
    },
    async recordInvocation(value) {
      return recordInvocationInState(invocations, value)
    },
    async appendQuantity(value) {
      return appendQuantityInState(quantities, value)
    },
    async charge(input) {
      return chargeInState(charges, input)
    },
    async appendValuation(value) {
      return appendValuationInState(valuations, value)
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
