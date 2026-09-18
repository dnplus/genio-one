import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"

import { createManagementApi } from "../src/app"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"
import { usageGovernanceHttp } from "../src/capabilities/usage-governance/http"
import { createInMemoryUsageGovernanceDirectory } from "../src/capabilities/usage-governance/directory"
import { createInMemoryAccountingLedger } from "../src/capabilities/usage-governance/accounting"
import { createInMemoryUsageCounterStore } from "../src/capabilities/usage-governance/memory-counter"
import { admitUsage } from "../src/capabilities/usage-governance/admission"

test("scoped Organization Administrator manages Use Cases and immutable Usage Policy revisions", async () => {
  const modules = createInMemoryPlatformModules({ now: () => 1_700_000_000 })
  const organization = await modules.organizations.create({
    tenantId: "tenant-acme",
    display_name: "Consumer AI",
    slug: "consumer-ai",
  })
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      "org-admin": {
        tenant_id: "tenant-acme",
        subject_id: "person-admin",
        role: "ORGANIZATION_ADMINISTRATOR",
        organization_ids: [organization.organization_id],
        client_id: "platform-web",
      },
    }),
  })
  const headers = { authorization: "Bearer org-admin" }
  const useCase = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-acme/organizations/${organization.organization_id}/use-cases`,
    headers,
    payload: { use_case_id: "support", display_name: "Customer support", risk_level: "HIGH" },
  })
  assert.equal(useCase.statusCode, 201)
  assert.equal(useCase.json().risk_level, "HIGH")
  const policy = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/usage-policies",
    headers,
    payload: {
      usage_policy_id: "support-budget",
      revision: 1,
      owner_organization_id: organization.organization_id,
      accounting_key_id: "provider-account-main",
      selectors: {
        consumer_organization_id: organization.organization_id,
        use_case_id: "support",
      },
      limits: { request_quota: { limit: 100, window_seconds: 60 } },
      state: "ACTIVE",
    },
  })
  assert.equal(policy.statusCode, 201)
  const listed = await app.inject({ method: "GET", url: "/v1/tenants/tenant-acme/usage-policies", headers })
  assert.equal(listed.statusCode, 200)
  assert.equal(listed.json()[0].accounting_key_id, "provider-account-main")
  const generatedUseCase = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-acme/organizations/${organization.organization_id}/use-cases`,
    headers,
    payload: { display_name: "Generated purpose" },
  })
  assert.equal(generatedUseCase.statusCode, 201)
  assert.match(generatedUseCase.json().use_case_id, /^use-case-/)
  assert.equal(generatedUseCase.json().risk_level, "LOW")
  const generatedPolicy = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/usage-policies",
    headers,
    payload: {
      display_name: "Generated policy",
      owner_organization_id: organization.organization_id,
      selectors: {},
      limits: { credit_budget: { limit: 10, credits_per_admitted_request: 1 } },
      state: "ACTIVE",
    },
  })
  assert.equal(generatedPolicy.statusCode, 201)
  assert.match(generatedPolicy.json().usage_policy_id, /^usage-policy-/)
  assert.match(generatedPolicy.json().accounting_key_id, /^accounting-key-/)
  assert.match(generatedPolicy.json().limits.credit_budget.allocation_id, /^allocation-/)
  await app.close()
})

test("Use Case catalogs are member-readable and User mutations are denied", async () => {
  const modules = createInMemoryPlatformModules({ now: () => 1_700_000_000 })
  const own = await modules.organizations.create({
    tenantId: "tenant-acme",
    display_name: "Engineering",
    slug: "engineering",
  })
  const other = await modules.organizations.create({
    tenantId: "tenant-acme",
    display_name: "Sales",
    slug: "sales",
  })
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      "own-user": {
        tenant_id: "tenant-acme",
        subject_id: "person-engineer",
        role: "USER",
        organization_ids: [own.organization_id],
        client_id: "platform-web",
        scopes: ["genioone-invocation"],
      },
      "other-user": {
        tenant_id: "tenant-acme",
        subject_id: "person-sales",
        role: "USER",
        organization_ids: [other.organization_id],
        client_id: "platform-web",
        scopes: ["genioone-invocation"],
      },
    }),
  })
  try {
    const ownList = await app.inject({
      method: "GET",
      url: `/v1/tenants/tenant-acme/organizations/${own.organization_id}/use-cases`,
      headers: { authorization: "Bearer own-user" },
    })
    assert.equal(ownList.statusCode, 200)
    const otherList = await app.inject({
      method: "GET",
      url: `/v1/tenants/tenant-acme/organizations/${other.organization_id}/use-cases`,
      headers: { authorization: "Bearer own-user" },
    })
    assert.equal(otherList.statusCode, 403)
    const userMutation = await app.inject({
      method: "POST",
      url: `/v1/tenants/tenant-acme/organizations/${own.organization_id}/use-cases`,
      headers: { authorization: "Bearer own-user" },
      payload: { use_case_id: "forbidden", display_name: "Should fail" },
    })
    assert.equal(userMutation.statusCode, 403)
  } finally {
    await app.close()
  }
})

test("runtime accounting ingest is retry-safe and creates one canonical charge", async () => {
  const app = Fastify()
  const ledger = createInMemoryAccountingLedger()
  const usageCounterStore = createInMemoryUsageCounterStore()
  await app.register(usageGovernanceHttp, {
    directory: createInMemoryUsageGovernanceDirectory(),
    accountingLedger: () => ledger,
    usageCounterStore,
    async authorizeRuntime(input) {
      assert.equal(input.tenantId, "tenant-acme")
      assert.equal(input.runtimeId, "gateway-runtime-1")
    },
  })
  const payload = {
    invocation: {
      invocation_id: "invocation-1",
      correlation_id: "correlation-1",
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
      quantity_id: "quantity-input",
      invocation_id: "invocation-1",
      quantity: 7,
      unit: "INPUT_TOKENS",
      trusted_source: "PROVIDER_RESPONSE",
      observed_at: 1_700_000_001,
    }],
    valuations: [{
      valuation_id: "valuation-estimated",
      status: "ESTIMATED",
      currency: "USD",
      amount_micros: 12,
      pricing_source: "LITELLM",
      pricing_version: "2026-09-01",
      valued_at: 1_700_000_002,
    }],
    currency_settlements: [{
      settlement_id: "invocation-1",
      accounting_key_id: "accounting-shared",
      allocation_id: "currency-september",
      window_seconds: 2_592_000,
      window_bucket: 655,
      amount_micros: 12,
    }],
  }
  const url = "/v1/tenants/tenant-acme/runtime-control/GATEWAY/gateway-runtime-1/accounting"
  const first = await app.inject({ method: "POST", url, payload })
  const repeated = await app.inject({ method: "POST", url, payload })
  const actual = await app.inject({
    method: "POST",
    url,
    payload: {
      ...payload,
      valuations: [{
        valuation_id: "valuation-actual",
        status: "ACTUAL",
        currency: "USD",
        amount_micros: 11,
        pricing_source: "PROVIDER_INVOICE",
        pricing_version: "invoice-2026-09",
        valued_at: 1_700_000_003,
      }],
      currency_settlements: [{
        settlement_id: "invocation-1",
        accounting_key_id: "accounting-shared",
        allocation_id: "currency-september",
        window_seconds: 2_592_000,
        window_bucket: 655,
        amount_micros: 11,
      }],
    },
  })
  assert.equal(first.statusCode, 201)
  assert.equal(repeated.statusCode, 201)
  assert.equal(actual.statusCode, 201)
  assert.equal(repeated.json().charge_id, first.json().charge_id)
  assert.equal((await ledger.listValuations({ charge_id: first.json().charge_id })).length, 2)
  const detail = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/activities/correlation-1/accounting",
  })
  assert.equal(detail.statusCode, 200)
  assert.equal(detail.json()[0].invocation.consumer_organization_id, "organization-consumer")
  assert.equal(detail.json()[0].charge.charge_id, first.json().charge_id)
  assert.equal(detail.json()[0].quantities[0].unit, "INPUT_TOKENS")
  assert.deepEqual(detail.json()[0].valuations.map((value: any) => value.status), ["ESTIMATED", "ACTUAL"])
  assert.deepEqual(detail.json()[0].valuations.map((value: any) => value.pricing_source), ["LITELLM", "PROVIDER_INVOICE"])
  const budgetDecision = await admitUsage({
    context: {
      tenant_id: "tenant-acme",
      subject_id: "person-alice",
      consumer_organization_id: "organization-consumer",
      resource_owner_organization_id: "organization-owner",
      resource_id: "resource-ai",
      capability_id: "chat",
      use_case_id: "support",
      correlation_id: "correlation-2",
      pricing: { currency: "USD", source: "LITELLM", version: "f".repeat(64) },
      now: 1_700_000_004,
    },
    policies: [{
      usage_policy_id: "currency-policy",
      revision: 1,
      accounting_key_id: "accounting-shared",
      selectors: { resource_id: "resource-ai" },
      limits: {
        currency_budget: {
          allocation_id: "currency-september",
          window_seconds: 2_592_000,
          currency: "USD",
          limit_micros: 10,
        },
      },
    }],
    store: usageCounterStore,
  })
  assert.equal(budgetDecision.disposition, "REJECT")
  assert.equal(budgetDecision.reason, "COST_BUDGET_EXHAUSTED")
  await app.close()
})
