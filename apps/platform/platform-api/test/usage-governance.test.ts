import assert from "node:assert/strict"
import test from "node:test"

import { createInMemoryAccountingLedger } from "../src/capabilities/usage-governance/accounting"
import { admitUsage } from "../src/capabilities/usage-governance/admission"
import type { UsageDecisionContext, UsagePolicyRevision } from "../src/capabilities/usage-governance/contract"
import { createInMemoryUsageCounterStore } from "../src/capabilities/usage-governance/memory-counter"
import { createInMemoryUsageGovernanceDirectory } from "../src/capabilities/usage-governance/directory"

const context: UsageDecisionContext = {
  tenant_id: "installation-acme",
  subject_id: "person-alice",
  consumer_organization_id: "organization-consumer",
  resource_owner_organization_id: "organization-owner",
  resource_id: "resource-ai",
  capability_id: "chat",
  use_case_id: "support-assistant",
  correlation_id: "correlation-1",
  priced_currency: "USD",
  estimated_cost_micros: 100,
  now: 1_700_000_000,
}

function policy(overrides: Partial<UsagePolicyRevision> = {}): UsagePolicyRevision {
  return {
    usage_policy_id: "usage-policy-ai",
    revision: 1,
    tenant_id: context.tenant_id,
    owner_organization_id: context.resource_owner_organization_id,
    accounting_key_id: "accounting-key-shared-provider",
    selectors: { resource_id: context.resource_id },
    limits: { request_quota: { limit: 1, window_seconds: 60 } },
    state: "ACTIVE",
    created_at: context.now,
    ...overrides,
  }
}

test("shared accounting keys aggregate quota across Connection-independent invocations", async () => {
  const store = createInMemoryUsageCounterStore()
  const first = await admitUsage({ context, policies: [policy()], store })
  assert.equal(first.disposition, "ADMIT")
  const second = await admitUsage({
    context: { ...context, correlation_id: "correlation-2" },
    policies: [policy()],
    store,
  })
  assert.deepEqual(second, {
    disposition: "REJECT",
    reason: "QUOTA_EXHAUSTED",
    matched_policy_revisions: ["usage-policy-ai:1"],
    accounting_key_id: "accounting-key-shared-provider",
  })
  const isolated = await admitUsage({
    context: { ...context, correlation_id: "correlation-3" },
    policies: [policy({ accounting_key_id: "accounting-key-isolated" })],
    store,
  })
  assert.equal(isolated.disposition, "ADMIT")
})

test("all matching policies apply even when they share one accounting key", async () => {
  const store = createInMemoryUsageCounterStore()
  const broad = policy({ usage_policy_id: "broad", limits: { request_quota: { limit: 10, window_seconds: 60 } } })
  const strict = policy({ usage_policy_id: "strict", limits: { request_quota: { limit: 1, window_seconds: 60 } } })
  assert.equal((await admitUsage({ context, policies: [broad, strict], store })).disposition, "ADMIT")
  const rejected = await admitUsage({
    context: { ...context, correlation_id: "correlation-strict-2" },
    policies: [broad, strict],
    store,
  })
  assert.equal(rejected.disposition, "REJECT")
  assert.equal(rejected.reason, "QUOTA_EXHAUSTED")
})

test("one invocation debits a shared credit allocation once across matching policies", async () => {
  const store = createInMemoryUsageCounterStore()
  const limits = {
    credit_budget: {
      allocation_id: "shared-credit-allocation",
      limit: 1,
      credits_per_admitted_request: 1,
    },
  }
  const first = await admitUsage({
    context,
    policies: [
      policy({ usage_policy_id: "credit-broad", limits }),
      policy({ usage_policy_id: "credit-scoped", limits }),
    ],
    store,
  })
  assert.equal(first.disposition, "ADMIT")
  const second = await admitUsage({
    context: { ...context, correlation_id: "correlation-credit-2" },
    policies: [
      policy({ usage_policy_id: "credit-broad", limits }),
      policy({ usage_policy_id: "credit-scoped", limits }),
    ],
    store,
  })
  assert.equal(second.disposition, "REJECT")
  assert.equal(second.reason, "CREDIT_EXHAUSTED")
})

test("hard currency policy rejects unpriced usage and store failure fails closed", async () => {
  const currencyPolicy = policy({
    limits: {
      currency_budget: {
        allocation_id: "allocation-september",
        window_seconds: 2_592_000,
        currency: "USD",
        limit_micros: 1_000,
      },
    },
  })
  const unpriced = await admitUsage({
    context: { ...context, priced_currency: undefined, estimated_cost_micros: undefined },
    policies: [currencyPolicy],
    store: createInMemoryUsageCounterStore(),
  })
  assert.equal(unpriced.disposition, "REJECT")
  assert.equal(unpriced.reason, "UNPRICED_USAGE")
  const unavailable = await admitUsage({
    context,
    policies: [currencyPolicy],
    store: {
      async admitBatch() { throw new Error("unavailable") },
      async releaseConcurrency() {},
      async settleCurrency() {},
    },
  })
  assert.equal(unavailable.disposition, "REJECT")
  assert.equal(unavailable.reason, "STORE_UNAVAILABLE")
})

test("currency budget admits priced in-flight work and blocks subsequent work from settled cost", async () => {
  const store = createInMemoryUsageCounterStore()
  const currencyPolicy = policy({
    limits: {
      currency_budget: {
        allocation_id: "allocation-september",
        window_seconds: 2_592_000,
        currency: "USD",
        limit_micros: 150,
      },
    },
  })
  const pricedContext = {
    ...context,
    estimated_cost_micros: undefined,
    priced_currency: undefined,
    pricing: { currency: "USD", source: "LITELLM", version: "f".repeat(64) },
  }
  const first = await admitUsage({ context: pricedContext, policies: [currencyPolicy], store })
  assert.equal(first.disposition, "ADMIT")
  if (first.disposition !== "ADMIT") throw new Error("expected admission")
  const allocation = first.currency_allocations[0]!
  await store.settleCurrency({
    settlement_id: "invocation-1",
    ...allocation,
    amount_micros: 100,
  })
  const second = await admitUsage({
    context: { ...pricedContext, correlation_id: "correlation-priced-2" },
    policies: [currencyPolicy],
    store,
  })
  assert.equal(second.disposition, "ADMIT")
  await store.settleCurrency({
    settlement_id: "invocation-2",
    ...allocation,
    amount_micros: 100,
  })
  const blocked = await admitUsage({
    context: { ...pricedContext, correlation_id: "correlation-priced-3" },
    policies: [currencyPolicy],
    store,
  })
  assert.equal(blocked.disposition, "REJECT")
  assert.equal(blocked.reason, "COST_BUDGET_EXHAUSTED")
})

test("concurrency leases release and retry-safe admission does not double debit", async () => {
  const store = createInMemoryUsageCounterStore()
  const concurrencyPolicy = policy({
    limits: {
      concurrency: { limit: 1, lease_ttl_seconds: 30 },
      credit_budget: { allocation_id: "credits-1", limit: 2, credits_per_admitted_request: 1 },
    },
  })
  const admitted = await admitUsage({ context, policies: [concurrencyPolicy], store })
  assert.equal(admitted.disposition, "ADMIT")
  const repeated = await admitUsage({ context, policies: [concurrencyPolicy], store })
  assert.equal(repeated.disposition, "ADMIT")
  const blocked = await admitUsage({
    context: { ...context, correlation_id: "correlation-concurrent" },
    policies: [concurrencyPolicy],
    store,
  })
  assert.equal(blocked.disposition, "REJECT")
  assert.equal(blocked.reason, "CONCURRENCY_EXHAUSTED")
  if (admitted.disposition === "ADMIT") {
    await Promise.all(admitted.concurrency_lease_ids.map((lease_id) => store.releaseConcurrency({ lease_id })))
  }
  const afterRelease = await admitUsage({
    context: { ...context, correlation_id: "correlation-after-release" },
    policies: [concurrencyPolicy],
    store,
  })
  assert.equal(afterRelease.disposition, "ADMIT")
})

test("one invocation and accounting key reuse one charge while valuation provenance appends", async () => {
  const ledger = createInMemoryAccountingLedger()
  await ledger.recordInvocation({
    invocation_id: "invocation-1",
    correlation_id: context.correlation_id,
    tenant_id: context.tenant_id,
    subject_id: context.subject_id,
    consumer_organization_id: context.consumer_organization_id,
    resource_owner_organization_id: context.resource_owner_organization_id,
    resource_id: context.resource_id,
    capability_id: context.capability_id,
    use_case_id: context.use_case_id,
    usage_policy_revisions: ["usage-policy-ai:1"],
    release_revision: "release-7",
    accounting_key_id: "accounting-key-shared-provider",
    created_at: context.now,
  })
  const first = await ledger.charge({
    invocation_id: "invocation-1",
    correlation_id: context.correlation_id,
    accounting_key_id: "accounting-key-shared-provider",
    created_at: context.now,
  })
  const retry = await ledger.charge({
    invocation_id: "invocation-1",
    correlation_id: context.correlation_id,
    accounting_key_id: "accounting-key-shared-provider",
    created_at: context.now + 1,
  })
  assert.equal(first.charge_id, retry.charge_id)
  await ledger.appendValuation({
    valuation_id: "valuation-estimated",
    charge_id: first.charge_id,
    status: "ESTIMATED",
    currency: "USD",
    amount_micros: 100,
    pricing_source: "LITELLM",
    pricing_version: "pricebook-1",
    valued_at: context.now,
  })
  await ledger.appendValuation({
    valuation_id: "valuation-actual",
    charge_id: first.charge_id,
    status: "ACTUAL",
    currency: "USD",
    amount_micros: 120,
    pricing_source: "PROVIDER_USAGE",
    pricing_version: "provider-2026-09",
    valued_at: context.now + 60,
  })
  assert.deepEqual((await ledger.listValuations({ charge_id: first.charge_id })).map((value) => value.status), ["ESTIMATED", "ACTUAL"])
})

test("Use Case is an Organization-owned managed entry and Usage Policy revisions are immutable", async () => {
  const directory = createInMemoryUsageGovernanceDirectory()
  await directory.createUseCase({
    tenant_id: context.tenant_id,
    organization_id: context.consumer_organization_id,
    use_case_id: context.use_case_id,
    display_name: "Customer support assistant",
    risk_level: "HIGH",
    state: "ACTIVE",
    created_at: context.now,
  })
  assert.equal((await directory.getActiveUseCase({
    tenant_id: context.tenant_id,
    organization_id: context.consumer_organization_id,
    use_case_id: context.use_case_id,
  }))?.display_name, "Customer support assistant")
  await directory.createPolicyRevision(policy())
  await assert.rejects(directory.createPolicyRevision(policy()), /USAGE_POLICY_REVISION_EXISTS/)
  await directory.createPolicyRevision(policy({ revision: 2 }))
  assert.deepEqual((await directory.listActivePolicies({ tenant_id: context.tenant_id })).map((value) => value.revision), [2])
})
