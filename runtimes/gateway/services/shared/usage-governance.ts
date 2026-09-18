import { createHash, randomUUID } from "node:crypto"

export type UsageAdmissionReason =
  | "QUOTA_EXHAUSTED"
  | "CONCURRENCY_EXHAUSTED"
  | "CREDIT_EXHAUSTED"
  | "COST_BUDGET_EXHAUSTED"
  | "UNPRICED_USAGE"
  | "STORE_UNAVAILABLE"

export interface UsagePolicySelectors {
  subject_id?: string
  consumer_organization_id?: string
  resource_id?: string
  capability_id?: string
  use_case_id?: string
}

export interface UsagePolicyLimits {
  request_quota?: { limit: number; window_seconds: number }
  concurrency?: { limit: number; lease_ttl_seconds: number }
  credit_budget?: { allocation_id: string; limit: number; credits_per_admitted_request: number }
  currency_budget?: { allocation_id: string; window_seconds: number; currency: string; limit_micros: number }
}

export interface UsagePolicyForAdmission {
  usage_policy_id: string
  revision: number
  accounting_key_id: string
  selectors: UsagePolicySelectors
  limits: UsagePolicyLimits
  state?: "DRAFT" | "ACTIVE" | "RETIRED"
}

export interface UsageDecisionContext {
  tenant_id: string
  subject_id: string
  consumer_organization_id: string
  resource_owner_organization_id: string
  resource_id: string
  capability_id: string
  use_case_id: string
  correlation_id: string
  priced_currency?: string
  estimated_cost_micros?: number
  pricing?: { currency: string; source: string; version: string }
  now: number
}

export interface CurrencyAllocation {
  accounting_key_id: string
  allocation_id: string
  currency: string
  window_seconds: number
  window_bucket: number
}

export type UsageAdmissionDecision =
  | {
      disposition: "ADMIT"
      admission_id: string
      matched_policy_revisions: string[]
      accounting_key_ids: string[]
      concurrency_lease_ids: string[]
      currency_allocations: CurrencyAllocation[]
    }
  | {
      disposition: "REJECT"
      reason: UsageAdmissionReason
      matched_policy_revisions: string[]
      accounting_key_id: string
    }

export interface UsageCounterStore {
  admitBatch(input: {
    operation_id: string
    now: number
    policies: Array<{
      accounting_key_id: string
      counter_namespace: string
      request_quota?: { limit: number; window_seconds: number }
      concurrency?: { limit: number; lease_ttl_seconds: number }
      credit_budget?: { allocation_id: string; limit: number; amount: number }
      currency_budget?: { allocation_id: string; window_seconds: number; currency: string; limit_micros: number; reserve_micros: number }
    }>
  }): Promise<
    { admitted: true; concurrency_lease_ids: string[] } |
    { admitted: false; policy_index: number; reason: Exclude<UsageAdmissionReason, "UNPRICED_USAGE" | "STORE_UNAVAILABLE"> }
  >
  releaseConcurrency(input: { lease_id: string }): Promise<void>
  settleCurrency(input: {
    settlement_id: string
    accounting_key_id: string
    allocation_id: string
    window_seconds: number
    window_bucket: number
    amount_micros: number
  }): Promise<void>
}

function matches(policy: UsagePolicyForAdmission, context: UsageDecisionContext): boolean {
  const selectors = policy.selectors
  return (policy.state === undefined || policy.state === "ACTIVE") &&
    (selectors.subject_id === undefined || selectors.subject_id === context.subject_id) &&
    (selectors.consumer_organization_id === undefined || selectors.consumer_organization_id === context.consumer_organization_id) &&
    (selectors.resource_id === undefined || selectors.resource_id === context.resource_id) &&
    (selectors.capability_id === undefined || selectors.capability_id === context.capability_id) &&
    (selectors.use_case_id === undefined || selectors.use_case_id === context.use_case_id)
}

function policyRef(policy: UsagePolicyForAdmission): string {
  return `${policy.usage_policy_id}:${policy.revision}`
}

function operationId(context: UsageDecisionContext, policies: readonly UsagePolicyForAdmission[]): string {
  const hash = createHash("sha256").update(context.tenant_id).update("\0").update(context.correlation_id)
  for (const policy of policies) {
    hash.update("\0").update(policy.accounting_key_id).update("\0").update(policyRef(policy))
  }
  return hash.digest("hex")
}

export async function admitUsage(input: {
  context: UsageDecisionContext
  policies: readonly UsagePolicyForAdmission[]
  store: UsageCounterStore
}): Promise<UsageAdmissionDecision> {
  const policies = input.policies.filter((policy) => matches(policy, input.context))
    .sort((left, right) => policyRef(left).localeCompare(policyRef(right)))
  const matched = policies.map(policyRef)
  for (const policy of policies) {
    if (policy.limits.currency_budget && (
      (input.context.pricing?.currency ?? input.context.priced_currency) !== policy.limits.currency_budget.currency ||
      (input.context.pricing === undefined && input.context.estimated_cost_micros === undefined)
    )) {
      return {
        disposition: "REJECT",
        reason: "UNPRICED_USAGE",
        matched_policy_revisions: matched,
        accounting_key_id: policy.accounting_key_id,
      }
    }
  }
  const debitedCredits = new Set<string>()
  const reservedCurrencies = new Set<string>()
  try {
    const result = await input.store.admitBatch({
      operation_id: operationId(input.context, policies),
      now: input.context.now,
      policies: policies.map((policy) => {
        const credit = policy.limits.credit_budget
        const currency = policy.limits.currency_budget
        const creditKey = credit ? `${policy.accounting_key_id}:${credit.allocation_id}` : ""
        const currencyKey = currency ? `${policy.accounting_key_id}:${currency.allocation_id}` : ""
        const creditAmount = credit && !debitedCredits.has(creditKey) ? credit.credits_per_admitted_request : 0
        const currencyReserve = currency && !reservedCurrencies.has(currencyKey)
          ? input.context.estimated_cost_micros ?? 0
          : 0
        if (credit) debitedCredits.add(creditKey)
        if (currency) reservedCurrencies.add(currencyKey)
        return {
          accounting_key_id: policy.accounting_key_id,
          counter_namespace: policyRef(policy),
          request_quota: policy.limits.request_quota,
          concurrency: policy.limits.concurrency,
          credit_budget: credit ? { allocation_id: credit.allocation_id, limit: credit.limit, amount: creditAmount } : undefined,
          currency_budget: currency ? { ...currency, reserve_micros: currencyReserve } : undefined,
        }
      }),
    })
    if (!result.admitted) {
      return {
        disposition: "REJECT",
        reason: result.reason,
        matched_policy_revisions: matched,
        accounting_key_id: policies[result.policy_index]?.accounting_key_id ?? "unavailable",
      }
    }
    const allocations = new Map<string, CurrencyAllocation>()
    for (const policy of policies) {
      const budget = policy.limits.currency_budget
      if (!budget) continue
      const value = {
        accounting_key_id: policy.accounting_key_id,
        allocation_id: budget.allocation_id,
        currency: budget.currency,
        window_seconds: budget.window_seconds,
        window_bucket: Math.floor(input.context.now / budget.window_seconds),
      }
      allocations.set(`${value.accounting_key_id}\0${value.allocation_id}`, value)
    }
    return {
      disposition: "ADMIT",
      admission_id: `admission-${randomUUID()}`,
      matched_policy_revisions: matched,
      accounting_key_ids: [...new Set(policies.map((policy) => policy.accounting_key_id))],
      concurrency_lease_ids: result.concurrency_lease_ids,
      currency_allocations: [...allocations.values()],
    }
  } catch {
    return {
      disposition: "REJECT",
      reason: "STORE_UNAVAILABLE",
      matched_policy_revisions: matched,
      accounting_key_id: policies[0]?.accounting_key_id ?? "unavailable",
    }
  }
}
