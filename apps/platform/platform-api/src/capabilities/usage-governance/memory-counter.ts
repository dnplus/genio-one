import { randomUUID } from "node:crypto"

import type { UsageCounterStore } from "./admission"

export function createInMemoryUsageCounterStore(): UsageCounterStore {
  const completed = new Map<string, Awaited<ReturnType<UsageCounterStore["admitBatch"]>>>()
  const counters = new Map<string, number>()
  const leases = new Map<string, { key: string; expires_at: number }>()
  const settlements = new Map<string, number>()
  return {
    async admitBatch(input) {
      const previous = completed.get(input.operation_id)
      if (previous) return previous
      for (const [leaseId, lease] of leases) {
        if (lease.expires_at <= input.now) leases.delete(leaseId)
      }
      const entries = input.policies.map((policy) => ({
        policy,
        quotaKey: `${policy.accounting_key_id}:${policy.counter_namespace}:quota:${Math.floor(input.now / (policy.request_quota?.window_seconds ?? 1))}`,
        creditKey: `${policy.accounting_key_id}:credit:${policy.credit_budget?.allocation_id ?? ""}`,
        costKey: `${policy.accounting_key_id}:cost:${policy.currency_budget?.allocation_id ?? ""}:${Math.floor(input.now / (policy.currency_budget?.window_seconds ?? 1))}`,
        concurrencyKey: `${policy.accounting_key_id}:${policy.counter_namespace}:concurrency`,
      }))
      for (const [policy_index, entry] of entries.entries()) {
        const { policy } = entry
        if (policy.request_quota && (counters.get(entry.quotaKey) ?? 0) >= policy.request_quota.limit) {
          return { admitted: false, policy_index, reason: "QUOTA_EXHAUSTED" }
        }
        if (policy.concurrency && [...leases.values()].filter((lease) => lease.key === entry.concurrencyKey).length >= policy.concurrency.limit) {
          return { admitted: false, policy_index, reason: "CONCURRENCY_EXHAUSTED" }
        }
        if (policy.credit_budget && (counters.get(entry.creditKey) ?? 0) + policy.credit_budget.amount > policy.credit_budget.limit) {
          return { admitted: false, policy_index, reason: "CREDIT_EXHAUSTED" }
        }
        if (policy.currency_budget && (counters.get(entry.costKey) ?? 0) + policy.currency_budget.reserve_micros > policy.currency_budget.limit_micros) {
          return { admitted: false, policy_index, reason: "COST_BUDGET_EXHAUSTED" }
        }
      }
      const concurrencyLeaseIds: string[] = []
      for (const entry of entries) {
        const { policy } = entry
        if (policy.request_quota) counters.set(entry.quotaKey, (counters.get(entry.quotaKey) ?? 0) + 1)
        if (policy.credit_budget) counters.set(entry.creditKey, (counters.get(entry.creditKey) ?? 0) + policy.credit_budget.amount)
        if (policy.currency_budget) counters.set(entry.costKey, (counters.get(entry.costKey) ?? 0) + policy.currency_budget.reserve_micros)
        if (policy.concurrency) {
          const leaseId = `usage-lease-${randomUUID()}`
          leases.set(leaseId, {
            key: entry.concurrencyKey,
            expires_at: input.now + policy.concurrency.lease_ttl_seconds,
          })
          concurrencyLeaseIds.push(leaseId)
        }
      }
      const result = { admitted: true as const, concurrency_lease_ids: concurrencyLeaseIds }
      completed.set(input.operation_id, result)
      return result
    },
    async releaseConcurrency(input) {
      leases.delete(input.lease_id)
    },
    async settleCurrency(input) {
      const settlementKey = `${input.accounting_key_id}:${input.allocation_id}:${input.settlement_id}`
      const counterKey = `${input.accounting_key_id}:cost:${input.allocation_id}:${input.window_bucket}`
      const previous = settlements.get(settlementKey) ?? 0
      counters.set(counterKey, (counters.get(counterKey) ?? 0) + input.amount_micros - previous)
      settlements.set(settlementKey, input.amount_micros)
    },
  }
}
