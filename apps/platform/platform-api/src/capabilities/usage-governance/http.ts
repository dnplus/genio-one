import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"
import { Type } from "typebox"

import { PlatformApiError } from "../errors"
import type { UsagePolicyLimits } from "./contract"
import type { UsageGovernanceDirectory } from "./directory"
import type { AccountingLedger } from "./accounting"
import type { UsageCounterStore } from "./admission"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })
const Path = Type.Object({ tenant_id: Identifier, organization_id: Identifier })
const UseCaseSchema = Type.Object({
  tenant_id: Identifier,
  organization_id: Identifier,
  use_case_id: Identifier,
  display_name: Identifier,
  risk_level: Type.Union([
    Type.Literal("LOW"),
    Type.Literal("MEDIUM"),
    Type.Literal("HIGH"),
    Type.Literal("CRITICAL"),
  ]),
  state: Type.Union([Type.Literal("ACTIVE"), Type.Literal("DISABLED")]),
  created_at: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })
const SelectorsSchema = Type.Object({
  subject_id: Type.Optional(Identifier),
  consumer_organization_id: Type.Optional(Identifier),
  resource_id: Type.Optional(Identifier),
  capability_id: Type.Optional(Identifier),
  use_case_id: Type.Optional(Identifier),
}, { additionalProperties: false })
const LimitsSchema = Type.Object({
  request_quota: Type.Optional(Type.Object({ limit: Type.Integer({ minimum: 1 }), window_seconds: Type.Integer({ minimum: 1 }) })),
  concurrency: Type.Optional(Type.Object({ limit: Type.Integer({ minimum: 1 }), lease_ttl_seconds: Type.Integer({ minimum: 1 }) })),
  credit_budget: Type.Optional(Type.Object({ allocation_id: Identifier, limit: Type.Integer({ minimum: 1 }), credits_per_admitted_request: Type.Integer({ minimum: 1 }) })),
  currency_budget: Type.Optional(Type.Object({ allocation_id: Identifier, window_seconds: Type.Integer({ minimum: 1 }), currency: Type.String({ pattern: "^[A-Z]{3}$" }), limit_micros: Type.Integer({ minimum: 0 }) })),
}, { additionalProperties: false })
const PolicyLimitsInputSchema = Type.Object({
  request_quota: Type.Optional(Type.Object({ limit: Type.Integer({ minimum: 1 }), window_seconds: Type.Integer({ minimum: 1 }) })),
  concurrency: Type.Optional(Type.Object({ limit: Type.Integer({ minimum: 1 }), lease_ttl_seconds: Type.Integer({ minimum: 1 }) })),
  credit_budget: Type.Optional(Type.Object({ allocation_id: Type.Optional(Identifier), limit: Type.Integer({ minimum: 1 }), credits_per_admitted_request: Type.Integer({ minimum: 1 }) })),
  currency_budget: Type.Optional(Type.Object({ allocation_id: Type.Optional(Identifier), window_seconds: Type.Integer({ minimum: 1 }), currency: Type.String({ pattern: "^[A-Z]{3}$" }), limit_micros: Type.Integer({ minimum: 0 }) })),
}, { additionalProperties: false })
const PolicySchema = Type.Object({
  usage_policy_id: Identifier,
  display_name: Type.Optional(Identifier),
  revision: Type.Integer({ minimum: 1 }),
  tenant_id: Identifier,
  owner_organization_id: Identifier,
  accounting_key_id: Identifier,
  selectors: SelectorsSchema,
  limits: LimitsSchema,
  state: Type.Union([Type.Literal("DRAFT"), Type.Literal("ACTIVE"), Type.Literal("RETIRED")]),
  created_at: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })
const CreateUsagePolicyRevisionSchema = Type.Object({
  usage_policy_id: Type.Optional(Identifier),
  display_name: Type.Optional(Identifier),
  revision: Type.Optional(Type.Integer({ minimum: 1 })),
  owner_organization_id: Identifier,
  accounting_key_id: Type.Optional(Identifier),
  selectors: SelectorsSchema,
  limits: PolicyLimitsInputSchema,
  state: Type.Union([Type.Literal("DRAFT"), Type.Literal("ACTIVE"), Type.Literal("RETIRED")]),
}, { additionalProperties: false })

const RuntimePath = Type.Object({
  tenant_id: Identifier,
  runtime_id: Identifier,
})
const InvocationSchema = Type.Object({
  invocation_id: Identifier,
  correlation_id: Identifier,
  tenant_id: Identifier,
  subject_id: Identifier,
  consumer_organization_id: Identifier,
  resource_owner_organization_id: Identifier,
  resource_id: Identifier,
  capability_id: Identifier,
  use_case_id: Identifier,
  usage_policy_revisions: Type.Array(Identifier),
  release_revision: Identifier,
  accounting_key_id: Identifier,
  created_at: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })
const QuantitySchema = Type.Object({
  quantity_id: Identifier,
  invocation_id: Identifier,
  quantity: Type.Number({ minimum: 0 }),
  unit: Identifier,
  trusted_source: Identifier,
  observed_at: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })
const ValuationInputSchema = Type.Object({
  valuation_id: Identifier,
  status: Type.Union([Type.Literal("ESTIMATED"), Type.Literal("ACTUAL")]),
  currency: Type.String({ pattern: "^[A-Z]{3}$" }),
  amount_micros: Type.Integer({ minimum: 0 }),
  pricing_source: Identifier,
  pricing_version: Identifier,
  valued_at: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })
const AccountingIngestSchema = Type.Object({
  invocation: InvocationSchema,
  quantities: Type.Array(QuantitySchema),
  valuations: Type.Array(ValuationInputSchema),
  currency_settlements: Type.Array(Type.Object({
    settlement_id: Identifier,
    accounting_key_id: Identifier,
    allocation_id: Identifier,
    window_seconds: Type.Integer({ minimum: 1 }),
    window_bucket: Type.Integer({ minimum: 0 }),
    amount_micros: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false })),
}, { additionalProperties: false })
const ChargeSchema = Type.Object({
  charge_id: Identifier,
  invocation_id: Identifier,
  correlation_id: Identifier,
  accounting_key_id: Identifier,
  created_at: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })
const ValuationSchema = Type.Intersect([
  ValuationInputSchema,
  Type.Object({ charge_id: Identifier }),
])
const AccountingReceiptSchema = Type.Object({
  invocation: InvocationSchema,
  quantities: Type.Array(QuantitySchema),
  charge: ChargeSchema,
  valuations: Type.Array(ValuationSchema),
}, { additionalProperties: false })

export const usageGovernanceHttp: FastifyPluginAsync<{
  directory: UsageGovernanceDirectory
  accountingLedger: (tenantId: string) => AccountingLedger
  usageCounterStore: UsageCounterStore
  authorizeRuntime(input: {
    tenantId: string
    runtimeId: string
    request: { principal?: import("../tenancy-auth/contract").Principal }
  }): Promise<void>
}> = async (app, options) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()
  routes.post("/v1/tenants/:tenant_id/runtime-control/GATEWAY/:runtime_id/accounting", {
    schema: {
      operationId: "recordInvocationAccounting",
      tags: ["Runtime Control"],
      params: RuntimePath,
      body: AccountingIngestSchema,
      response: { 201: Type.Object({ invocation: InvocationSchema, charge_id: Identifier }) },
    },
  }, async (request, reply) => {
    await options.authorizeRuntime({
      tenantId: request.params.tenant_id,
      runtimeId: request.params.runtime_id,
      request,
    })
    if (request.body.invocation.tenant_id !== request.params.tenant_id) {
      throw new PlatformApiError("INVOCATION_ACCOUNTING_TENANT_MISMATCH", 409)
    }
    if (request.body.quantities.some((value) => value.invocation_id !== request.body.invocation.invocation_id)) {
      throw new PlatformApiError("INVOCATION_ACCOUNTING_MISMATCH", 409)
    }
    const ledger = options.accountingLedger(request.params.tenant_id)
    const invocation = await ledger.recordInvocation(request.body.invocation)
    const charge = await ledger.charge({
      invocation_id: invocation.invocation_id,
      correlation_id: invocation.correlation_id,
      accounting_key_id: invocation.accounting_key_id,
      created_at: invocation.created_at,
    })
    for (const quantity of request.body.quantities) await ledger.appendQuantity(quantity)
    for (const valuation of request.body.valuations) {
      await ledger.appendValuation({ ...valuation, charge_id: charge.charge_id })
    }
    for (const settlement of request.body.currency_settlements) {
      await options.usageCounterStore.settleCurrency(settlement)
    }
    return reply.code(201).send({ invocation, charge_id: charge.charge_id })
  })
  routes.get("/v1/tenants/:tenant_id/activities/:correlation_id/accounting", {
    schema: {
      operationId: "getInvocationAccounting",
      tags: ["Activity"],
      params: Type.Object({ tenant_id: Identifier, correlation_id: Identifier }),
      response: { 200: Type.Array(AccountingReceiptSchema) },
    },
  }, async (request) => options.accountingLedger(request.params.tenant_id).getByCorrelation({
    correlation_id: request.params.correlation_id,
  }))
  routes.get("/v1/tenants/:tenant_id/organizations/:organization_id/use-cases", {
    schema: { operationId: "listUseCases", tags: ["Usage Governance"], params: Path, response: { 200: Type.Array(UseCaseSchema) } },
  }, async (request) => {
    const principal = request.principal
    if (!principal || principal.tenant_id !== request.params.tenant_id || (principal.role !== "TENANT_ADMINISTRATOR" && !principal.organization_ids.includes(request.params.organization_id))) {
      throw new PlatformApiError("ORGANIZATION_ACCESS_DENIED", 403)
    }
    return options.directory.listUseCases({
      tenant_id: request.params.tenant_id,
      organization_id: request.params.organization_id,
    })
  })
  routes.post("/v1/tenants/:tenant_id/organizations/:organization_id/use-cases", {
    schema: {
      operationId: "createUseCase",
      tags: ["Usage Governance"],
      params: Path,
      body: Type.Object({
        use_case_id: Type.Optional(Identifier),
        display_name: Identifier,
        risk_level: Type.Optional(Type.Union([
          Type.Literal("LOW"),
          Type.Literal("MEDIUM"),
          Type.Literal("HIGH"),
          Type.Literal("CRITICAL"),
        ])),
      }),
      response: { 201: UseCaseSchema },
    },
  }, async (request, reply) => {
    if (!request.principal || request.principal.tenant_id !== request.params.tenant_id || (request.principal.role !== "TENANT_ADMINISTRATOR" && (request.principal.role !== "ORGANIZATION_ADMINISTRATOR" || !request.principal.organization_ids.includes(request.params.organization_id)))) {
      throw new PlatformApiError("ORGANIZATION_ADMIN_REQUIRED", 403)
    }
    const value = await options.directory.createUseCase({
      tenant_id: request.params.tenant_id,
      organization_id: request.params.organization_id,
      use_case_id: request.body.use_case_id?.trim() || `use-case-${crypto.randomUUID()}`,
      display_name: request.body.display_name,
      risk_level: request.body.risk_level ?? "LOW",
      state: "ACTIVE",
      created_at: Math.floor(Date.now() / 1000),
    })
    return reply.code(201).send(value)
  })
  routes.get("/v1/tenants/:tenant_id/usage-policies", {
    schema: {
      operationId: "listUsagePolicies",
      tags: ["Usage Governance"],
      params: Type.Object({ tenant_id: Identifier }),
      response: { 200: Type.Array(PolicySchema) },
    },
  }, async (request) => options.directory.listActivePolicies({ tenant_id: request.params.tenant_id }))
  routes.post("/v1/tenants/:tenant_id/usage-policies", {
    schema: {
      operationId: "createUsagePolicyRevision",
      tags: ["Usage Governance"],
      params: Type.Object({ tenant_id: Identifier }),
      body: CreateUsagePolicyRevisionSchema,
      response: { 201: PolicySchema },
    },
  }, async (request, reply) => {
    if (request.principal?.role !== "TENANT_ADMINISTRATOR" && !request.principal?.organization_ids.includes(request.body.owner_organization_id)) {
      throw new PlatformApiError("ORGANIZATION_ADMIN_REQUIRED", 403)
    }
    const usagePolicyId = request.body.usage_policy_id?.trim() || `usage-policy-${crypto.randomUUID()}`
    const accountingKeyId = request.body.accounting_key_id?.trim() || `accounting-key-${crypto.randomUUID()}`
    const limits: UsagePolicyLimits = {
      ...(request.body.limits.request_quota ? { request_quota: request.body.limits.request_quota } : {}),
      ...(request.body.limits.concurrency ? { concurrency: request.body.limits.concurrency } : {}),
      ...(request.body.limits.credit_budget ? {
        credit_budget: {
          allocation_id: request.body.limits.credit_budget.allocation_id?.trim() || `allocation-${crypto.randomUUID()}`,
          limit: request.body.limits.credit_budget.limit,
          credits_per_admitted_request: request.body.limits.credit_budget.credits_per_admitted_request,
        },
      } : {}),
      ...(request.body.limits.currency_budget ? {
        currency_budget: {
          allocation_id: request.body.limits.currency_budget.allocation_id?.trim() || `allocation-${crypto.randomUUID()}`,
          window_seconds: request.body.limits.currency_budget.window_seconds,
          currency: request.body.limits.currency_budget.currency,
          limit_micros: request.body.limits.currency_budget.limit_micros,
        },
      } : {}),
    }
    const value = await options.directory.createPolicyRevision({
      ...request.body,
      usage_policy_id: usagePolicyId,
      display_name: request.body.display_name?.trim() || usagePolicyId,
      revision: request.body.revision ?? 1,
      accounting_key_id: accountingKeyId,
      limits,
      tenant_id: request.params.tenant_id,
      created_at: Math.floor(Date.now() / 1000),
    })
    return reply.code(201).send(value)
  })
}
