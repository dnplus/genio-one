import assert from "node:assert/strict"
import test from "node:test"

import { PlatformApiError } from "../src/capabilities/errors"
import {
  createPostgresGatewayPolicyInputSource,
} from "../src/capabilities/gateway-policy-release/policy-inputs"
import type { GatewayProjection } from "../src/capabilities/gateway-projection/contract"
import type { SqlQueryResult, SqlTransaction } from "../src/persistence/sql-adapter"

type Row = Record<string, unknown>

const tenantId = "tenant-acme"

function projection(
  resourceId: string,
  overrides: Partial<Pick<
    GatewayProjection,
    "tenant_id" | "operation" | "resource_id" | "capability_id"
  >> = {},
): GatewayProjection {
  return {
    tenant_id: tenantId,
    operation: "APPLY",
    resource_id: resourceId,
    capability_id: "capability-chat",
    resources: [{ kind: "AIGatewayRoute" }],
    ...overrides,
  } as GatewayProjection
}

function modelRow(overrides: Row = {}): Row {
  return {
    tenant_id: tenantId,
    model_id: "model-gpt",
    model_name: "corporate-gpt",
    display_name: "Corporate GPT",
    resource_id: "resource-a",
    visibility: "PUBLIC",
    lifecycle: "PUBLISHED",
    capabilities: JSON.stringify(["CHAT", "STREAMING"]),
    created_at: 100n,
    ...overrides,
  }
}

function entitlementRow(overrides: Row = {}): Row {
  return {
    tenant_id: tenantId,
    entitlement_id: "entitlement-gpt",
    subject_id: "subject-1",
    client_id: "client-1",
    resource_id: "resource-a",
    capability_id: "capability-chat",
    public_model_id: "model-gpt",
    state: "ACTIVE",
    starts_at: 90n,
    expires_at: null,
    created_at: 100n,
    ...overrides,
  }
}

function resourceRow(overrides: Row = {}): Row {
  return {
    tenant_id: tenantId,
    resource_id: "resource-a",
    owner_organization_id: "org-acme",
    lifecycle: "DRAFT",
    ...overrides,
  }
}

function mappingRow(overrides: Row = {}): Row {
  return {
    tenant_id: tenantId,
    mapping_id: "mapping-gpt",
    public_model_id: "model-gpt",
    resource_id: "resource-a",
    connection_id: "connection-openai",
    provider_model: "gpt-4.1",
    mapping_revision: 2n,
    created_at: 100n,
    pricing_source: "LITELLM",
    pricing_version: "f".repeat(64),
    input_cost_per_token: "0.000001",
    output_cost_per_token: "0.000002",
    ...overrides,
  }
}

function routingPolicyRow(overrides: Row = {}): Row {
  return {
    tenant_id: tenantId,
    routing_policy_id: "routing-chat",
    owner_organization_id: "org-acme",
    resource_id: "resource-a",
    capability_id: "capability-chat",
    routing_revision: 3n,
    mode: "DETERMINISTIC",
    default_public_model_id: "model-gpt",
    candidate_public_model_ids: JSON.stringify(["model-gpt"]),
    session_lease_seconds: null,
    created_at: 100n,
    updated_at: 101n,
    ...overrides,
  }
}

function compiledChain(resourceId: string, connectionId: string): Row {
  return {
    chain_id: `chain-${resourceId}-capability-chat`,
    tenant_id: tenantId,
    resource_id: resourceId,
    capability_id: "capability-chat",
    eligible_connection_ids: [connectionId],
    one_policy_revision: 1,
    steps: [
      {
        step_id: "authenticate",
        kind: "AUTHENTICATE",
        phase: "REQUEST",
        implementation: "NATIVE",
        config: {
          schema_version: "genio.one.auth.jwt.v1",
          provider: "tenant-oidc",
          issuer: "https://identity.example.test",
          audiences: ["genio-one"],
          remote_jwks_uri: "https://identity.example.test/.well-known/jwks.json",
          subject_claim: "sub",
          client_claim: "azp",
        },
      },
      {
        step_id: "authorize",
        kind: "AUTHORIZE",
        phase: "REQUEST",
        implementation: "EXT_AUTH",
        depends_on: ["authenticate"],
      },
      {
        step_id: "route",
        kind: "ROUTE",
        phase: "ROUTING",
        implementation: "AIGW_NATIVE",
        depends_on: ["authorize"],
      },
    ],
    request_filter_order: ["authorize"],
    response_filter_order: [],
  }
}

function enforcementChainRow(resourceId: string, connectionId: string): Row {
  const chain = compiledChain(resourceId, connectionId)
  return {
    tenant_id: tenantId,
    resource_id: resourceId,
    capability_id: "capability-chat",
    one_policy_revision: 1,
    chain: JSON.stringify(chain),
  }
}

class PolicyInputTransaction implements SqlTransaction {
  readonly calls: Array<{ text: string; parameters: readonly unknown[] }> = []
  readonly chainRows: Row[]
  readonly subjectRows: Row[]
  readonly delegationRows: Row[]
  readonly executionGrantRows: Row[] = []

  constructor(
    readonly modelRows: Row[] = [],
    readonly entitlementRows: Row[] = [],
    readonly resourceRows: Row[] = [resourceRow()],
    readonly mappingRows: Row[] = [mappingRow()],
    readonly routingPolicyRows: Row[] = [routingPolicyRow()],
    chainRows?: Row[],
    readonly aliasRows: Row[] = [],
    readonly usagePolicyRows: Row[] = [],
    readonly usageContextRows: Row[] = [],
    subjectRows?: Row[],
    delegationRows: Row[] = [],
  ) {
    this.chainRows = chainRows ?? resourceRows.map((row) =>
      enforcementChainRow(String(row.resource_id), `connection-${String(row.resource_id).replace("resource-", "")}`),
    )
    this.subjectRows = subjectRows ?? [...new Set(entitlementRows
      .map((row) => row.subject_id)
      .filter((value): value is string => typeof value === "string"))]
      .map((subject_id) => ({ subject_id, kind: "PERSON" }))
    this.delegationRows = delegationRows
  }

  async query<Result extends Row = Row>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Result>> {
    this.calls.push({ text, parameters })
    if (text.includes("from genio_one_resources")) {
      return {
        rows: this.resourceRows as Result[],
        rowCount: this.resourceRows.length,
      }
    }
    if (text.includes("from genio_one_enforcement_chain_revisions")) {
      return {
        rows: this.chainRows as Result[],
        rowCount: this.chainRows.length,
      }
    }
    if (text.includes("from genio_one_model_entitlements")) {
      return {
        rows: this.entitlementRows as Result[],
        rowCount: this.entitlementRows.length,
      }
    }
    if (text.includes("from genio_one_connection_model_mappings")) {
      return {
        rows: this.mappingRows as Result[],
        rowCount: this.mappingRows.length,
      }
    }
    if (text.includes("from genio_one_model_routing_policies")) {
      return {
        rows: this.routingPolicyRows as Result[],
        rowCount: this.routingPolicyRows.length,
      }
    }
    if (text.includes("from genio_one_public_models")) {
      return {
        rows: this.modelRows as Result[],
        rowCount: this.modelRows.length,
      }
    }
    if (text.includes("from genio_one_external_identity_bindings")) {
      return {
        rows: this.aliasRows as Result[],
        rowCount: this.aliasRows.length,
      }
    }
    if (text.includes("from genio_one_subjects")) {
      return {
        rows: this.subjectRows as Result[],
        rowCount: this.subjectRows.length,
      }
    }
    if (text.includes("from genio_one_agent_delegation_revisions")) {
      return {
        rows: this.delegationRows as Result[],
        rowCount: this.delegationRows.length,
      }
    }
    if (text.includes("from genio_one_execution_grants")) {
      return {
        rows: this.executionGrantRows as Result[],
        rowCount: this.executionGrantRows.length,
      }
    }
    if (text.includes("from genio_one_usage_policy_revisions")) {
      return {
        rows: this.usagePolicyRows as Result[],
        rowCount: this.usagePolicyRows.length,
      }
    }
    if (text.includes("from genio_one_organization_memberships")) {
      return {
        rows: this.usageContextRows as Result[],
        rowCount: this.usageContextRows.length,
      }
    }
    throw new Error(`Unexpected SQL in test: ${text}`)
  }
}

function assertErrorCode(code: string) {
  return (error: unknown): boolean =>
    error instanceof PlatformApiError && error.code === code
}

test("locks and returns a deterministic model and entitlement snapshot from one transaction", async () => {
  const transaction = new PolicyInputTransaction(
    [
      modelRow({ model_id: "model-a", model_name: "alpha", resource_id: "resource-a" }),
      modelRow({ model_id: "model-b", model_name: "beta", resource_id: "resource-b" }),
    ],
    [
      entitlementRow({ entitlement_id: "entitlement-a", public_model_id: "model-a" }),
      entitlementRow({ entitlement_id: "entitlement-b", resource_id: "resource-b", public_model_id: "model-b" }),
    ],
    [
      resourceRow({ resource_id: "resource-a", lifecycle: "DRAFT" }),
      resourceRow({
        resource_id: "resource-b",
        owner_organization_id: "org-beta",
        lifecycle: "PUBLISHED",
      }),
    ],
    [
      mappingRow({
        mapping_id: "mapping-a",
        public_model_id: "model-a",
        connection_id: "connection-a",
      }),
      mappingRow({
        mapping_id: "mapping-b",
        public_model_id: "model-b",
        resource_id: "resource-b",
        connection_id: "connection-b",
        provider_model: "claude-sonnet-4",
      }),
    ],
    [
      routingPolicyRow({
        routing_policy_id: "routing-a",
        resource_id: "resource-a",
        default_public_model_id: "model-a",
        candidate_public_model_ids: JSON.stringify(["model-a"]),
      }),
      routingPolicyRow({
        routing_policy_id: "routing-b",
        owner_organization_id: "org-beta",
        resource_id: "resource-b",
        default_public_model_id: "model-b",
        candidate_public_model_ids: JSON.stringify(["model-b"]),
      }),
    ],
    undefined,
    [],
    [],
    [{
      subject_id: "subject-1",
      consumer_organization_id: "organization-consumer",
      use_case_id: "customer-support",
      risk_level: "HIGH",
    }],
  )
  const source = createPostgresGatewayPolicyInputSource()

  const result = await source.loadForGatewayInTransaction({
    transaction,
    tenantId,
    candidateResourceId: "resource-a",
    // The caller's projection order must not affect the persisted snapshot.
    projections: [projection("resource-b"), projection("resource-a")],
  })

  assert.deepEqual(result, {
    enforcement_chains: [
      compiledChain("resource-a", "connection-a"),
      compiledChain("resource-b", "connection-b"),
    ],
    public_models: [
      {
        tenant_id: tenantId,
        model_id: "model-a",
        model_name: "alpha",
        display_name: "Corporate GPT",
        resource_id: "resource-a",
        visibility: "PUBLIC",
        lifecycle: "PUBLISHED",
        capabilities: ["CHAT", "STREAMING"],
        created_at: 100,
      },
      {
        tenant_id: tenantId,
        model_id: "model-b",
        model_name: "beta",
        display_name: "Corporate GPT",
        resource_id: "resource-b",
        visibility: "PUBLIC",
        lifecycle: "PUBLISHED",
        capabilities: ["CHAT", "STREAMING"],
        created_at: 100,
      },
    ],
    entitlements: [
      {
        tenant_id: tenantId,
        entitlement_id: "entitlement-a",
        subject_id: "subject-1",
        client_id: "client-1",
        resource_id: "resource-a",
        capability_id: "capability-chat",
        public_model_id: "model-a",
        state: "ACTIVE",
        starts_at: 90,
        expires_at: null,
        created_at: 100,
      },
      {
        tenant_id: tenantId,
        entitlement_id: "entitlement-b",
        subject_id: "subject-1",
        client_id: "client-1",
        resource_id: "resource-b",
        capability_id: "capability-chat",
        public_model_id: "model-b",
        state: "ACTIVE",
        starts_at: 90,
        expires_at: null,
        created_at: 100,
      },
    ],
    resource_owners: [
      {
        tenant_id: tenantId,
        resource_id: "resource-a",
        owner_organization_id: "org-acme",
      },
      {
        tenant_id: tenantId,
        resource_id: "resource-b",
        owner_organization_id: "org-beta",
      },
    ],
    routing_policies: [
      {
        tenant_id: tenantId,
        routing_policy_id: "routing-a",
        owner_organization_id: "org-acme",
        resource_id: "resource-a",
        capability_id: "capability-chat",
        routing_revision: 3,
        mode: "DETERMINISTIC",
        default_public_model_id: "model-a",
        candidate_public_model_ids: ["model-a"],
        session_lease_seconds: null,
        context_requirements: [],
        created_at: 100,
        updated_at: 101,
      },
      {
        tenant_id: tenantId,
        routing_policy_id: "routing-b",
        owner_organization_id: "org-beta",
        resource_id: "resource-b",
        capability_id: "capability-chat",
        routing_revision: 3,
        mode: "DETERMINISTIC",
        default_public_model_id: "model-b",
        candidate_public_model_ids: ["model-b"],
        session_lease_seconds: null,
        context_requirements: [],
        created_at: 100,
        updated_at: 101,
      },
    ],
    model_mappings: [
      {
        tenant_id: tenantId,
        mapping_id: "mapping-a",
        public_model_id: "model-a",
        resource_id: "resource-a",
        connection_id: "connection-a",
        provider_model: "gpt-4.1",
        mapping_revision: 2,
        created_at: 100,
      },
      {
        tenant_id: tenantId,
        mapping_id: "mapping-b",
        public_model_id: "model-b",
        resource_id: "resource-b",
        connection_id: "connection-b",
        provider_model: "claude-sonnet-4",
        mapping_revision: 2,
        created_at: 100,
      },
    ],
    connections: [
      {
        tenant_id: tenantId,
        resource_id: "resource-a",
        connection_id: "connection-a",
        configuration_revision: 1,
        lifecycle: "ENABLED",
        verification_state: "VERIFIED",
        health_state: "HEALTHY",
        health_observed_at: 100,
        health_source_revision: 1,
        certificate_mode: "SYSTEM_CA",
        certificate_not_before: null,
        certificate_not_after: null,
        routing_priority: 0,
        region: null,
        supported_obligations: [],
      },
      {
        tenant_id: tenantId,
        resource_id: "resource-b",
        connection_id: "connection-b",
        configuration_revision: 1,
        lifecycle: "ENABLED",
        verification_state: "VERIFIED",
        health_state: "HEALTHY",
        health_observed_at: 100,
        health_source_revision: 1,
        certificate_mode: "SYSTEM_CA",
        certificate_not_before: null,
        certificate_not_after: null,
        routing_priority: 0,
        region: null,
        supported_obligations: [],
      },
    ],
    subject_aliases: {},
    subject_contexts: [{ subject_id: "subject-1", kind: "PERSON" }],
    agent_delegations: [],
    usage_policies: [],
    usage_contexts: [{
      subject_id: "subject-1",
      consumer_organization_id: "organization-consumer",
      use_case_id: "customer-support",
      risk_level: "HIGH",
    }],
    pricing: [
      {
        mapping_id: "mapping-a",
        currency: "USD",
        input_cost_per_token_micros: 1,
        output_cost_per_token_micros: 2,
        source: "LITELLM",
        version: "f".repeat(64),
      },
      {
        mapping_id: "mapping-b",
        currency: "USD",
        input_cost_per_token_micros: 1,
        output_cost_per_token_micros: 2,
        source: "LITELLM",
        version: "f".repeat(64),
      },
    ],
  })
  assert.equal(transaction.calls.length, 12)

  const resourceCall = transaction.calls[0]!
  assert.match(resourceCall.text, /from genio_one_resources/i)
  assert.match(resourceCall.text, /for update/i)
  assert.deepEqual(resourceCall.parameters, [tenantId, ["resource-a", "resource-b"]])

  const chainCall = transaction.calls[1]!
  assert.match(chainCall.text, /from genio_one_enforcement_chain_revisions/i)
  assert.match(chainCall.text, /one_policy_revision/i)
  assert.deepEqual(chainCall.parameters, [tenantId, ["resource-a", "resource-b"]])

  const modelCall = transaction.calls[2]!
  assert.match(modelCall.text, /order by model_id/i)
  assert.match(modelCall.text, /for update/i)
  assert.deepEqual(modelCall.parameters, [tenantId, ["resource-a", "resource-b"]])

  const mappingCall = transaction.calls[3]!
  assert.match(mappingCall.text, /resource_connection\.lifecycle = 'ENABLED'/i)
  assert.match(mappingCall.text, /resource_connection\.verification_state = 'VERIFIED'/i)
  assert.match(mappingCall.text, /for update of model_mapping, resource_connection/i)
  assert.deepEqual(mappingCall.parameters, [tenantId, ["model-a", "model-b"]])

  const routingPolicyCall = transaction.calls[4]!
  assert.match(routingPolicyCall.text, /from genio_one_model_routing_policies/i)
  assert.match(routingPolicyCall.text, /routing_revision desc/i)
  assert.match(routingPolicyCall.text, /for update/i)
  assert.deepEqual(routingPolicyCall.parameters, [tenantId, ["resource-a", "resource-b"]])

  const entitlementCall = transaction.calls[5]!
  assert.match(entitlementCall.text, /order by entitlement\.entitlement_id/i)
  assert.match(entitlementCall.text, /for update of entitlement/i)
  assert.deepEqual(entitlementCall.parameters, [tenantId, ["resource-a", "resource-b"]])

  const aliasCall = transaction.calls[6]!
  assert.match(aliasCall.text, /from genio_one_external_identity_bindings/i)
  assert.deepEqual(aliasCall.parameters, [tenantId, ["subject-1"]])

  const subjectCall = transaction.calls[7]!
  assert.match(subjectCall.text, /from genio_one_subjects/i)
  assert.deepEqual(subjectCall.parameters, [tenantId, ["subject-1"]])

  const delegationCall = transaction.calls[8]!
  assert.match(delegationCall.text, /from genio_one_agent_delegation_revisions/i)
  assert.deepEqual(delegationCall.parameters, [tenantId, ["resource-a", "resource-b"]])

  const executionGrantCall = transaction.calls[9]!
  assert.match(executionGrantCall.text, /from genio_one_execution_grants/i)
  assert.deepEqual(executionGrantCall.parameters, [tenantId, ["resource-a", "resource-b"]])

  const usagePolicyCall = transaction.calls[10]!
  assert.match(usagePolicyCall.text, /from genio_one_usage_policy_revisions/i)
  assert.deepEqual(usagePolicyCall.parameters, [tenantId])

  const usageContextCall = transaction.calls[11]!
  assert.match(usageContextCall.text, /from genio_one_organization_memberships/i)
  assert.deepEqual(usageContextCall.parameters, [tenantId, ["subject-1"]])
})

test("freezes the A2A target Agent into the signed Subject Context", async () => {
  const transaction = new PolicyInputTransaction(
    [modelRow()],
    [entitlementRow()],
    [resourceRow({
      api_metadata: {
        a2a: {
          protocol_version: "1.0",
          operation: "SEND_MESSAGE",
          target_agent_subject_id: "agent-target",
        },
      },
    })],
    [mappingRow()],
    [routingPolicyRow()],
    undefined,
    [],
    [],
    [],
    [
      { subject_id: "subject-1", kind: "AGENT" },
      { subject_id: "agent-target", kind: "AGENT" },
    ],
  )
  const source = createPostgresGatewayPolicyInputSource()
  const result = await source.loadForGatewayInTransaction({
    transaction,
    tenantId,
    candidateResourceId: "resource-a",
    projections: [projection("resource-a")],
  })
  assert.deepEqual(result.subject_contexts, [
    { subject_id: "subject-1", kind: "AGENT" },
    { subject_id: "agent-target", kind: "AGENT" },
  ])
  const missing = new PolicyInputTransaction(
    [modelRow()],
    [entitlementRow()],
    [resourceRow({ api_metadata: { a2a: { target_agent_subject_id: "agent-target" } } })],
    [mappingRow()],
    [routingPolicyRow()],
  )
  await assert.rejects(source.loadForGatewayInTransaction({
    transaction: missing,
    tenantId,
    candidateResourceId: "resource-a",
    projections: [projection("resource-a")],
  }), assertErrorCode("GATEWAY_POLICY_SUBJECT_CONTEXT_MISSING"))
})

test("returns an empty policy snapshot for an empty Gateway release", async () => {
  const source = createPostgresGatewayPolicyInputSource()
  const transaction: SqlTransaction = {
    async query() {
      throw new Error("an empty release must not query Resource policy rows")
    },
  }

  const result = await source.loadForGatewayInTransaction({
    transaction,
    tenantId,
    projections: [],
  })

  assert.deepEqual(result, {
    enforcement_chains: [],
    public_models: [],
    entitlements: [],
    resource_owners: [],
    routing_policies: [],
    model_mappings: [],
    subject_aliases: {},
    subject_contexts: [],
    agent_delegations: [],
  })
})

test("rejects cross-tenant, non-APPLY and inactive candidate projections", async () => {
  const source = createPostgresGatewayPolicyInputSource()

  const crossTenant = new PolicyInputTransaction()
  await assert.rejects(
    source.loadForGatewayInTransaction({
      transaction: crossTenant,
      tenantId,
      candidateResourceId: "resource-a",
      projections: [projection("resource-a", { tenant_id: "tenant-other" })],
    }),
    assertErrorCode("GATEWAY_POLICY_INPUT_MISMATCH"),
  )
  assert.equal(crossTenant.calls.length, 0)

  const tombstone = new PolicyInputTransaction()
  await assert.rejects(
    source.loadForGatewayInTransaction({
      transaction: tombstone,
      tenantId,
      candidateResourceId: "resource-a",
      projections: [projection("resource-a", { operation: "DELETE" })],
    }),
    assertErrorCode("GATEWAY_POLICY_INPUT_MISMATCH"),
  )
  assert.equal(tombstone.calls.length, 0)

  const inactiveCandidate = new PolicyInputTransaction(
    [],
    [],
    [resourceRow({ lifecycle: "RETIRED" })],
  )
  await assert.rejects(
    source.loadForGatewayInTransaction({
      transaction: inactiveCandidate,
      tenantId,
      candidateResourceId: "resource-a",
      projections: [projection("resource-a")],
    }),
    assertErrorCode("GATEWAY_POLICY_INPUT_MISMATCH"),
  )
  assert.equal(inactiveCandidate.calls.length, 1)
})

test("fails closed when a persisted model or entitlement row is invalid", async () => {
  const source = createPostgresGatewayPolicyInputSource()

  const invalidModel = new PolicyInputTransaction([
    modelRow({ lifecycle: "DRAFT", internal_secret: "must not escape" }),
  ])
  await assert.rejects(
    source.loadForGatewayInTransaction({
      transaction: invalidModel,
      tenantId,
      candidateResourceId: "resource-a",
      projections: [projection("resource-a")],
    }),
    assertErrorCode("GATEWAY_POLICY_INPUT_INVALID"),
  )
  assert.equal(invalidModel.calls.length, 3)

  const invalidEntitlement = new PolicyInputTransaction(
    [modelRow()],
    [entitlementRow({ state: "PENDING" })],
  )
  await assert.rejects(
    source.loadForGatewayInTransaction({
      transaction: invalidEntitlement,
      tenantId,
      candidateResourceId: "resource-a",
      projections: [projection("resource-a")],
    }),
    assertErrorCode("GATEWAY_POLICY_INPUT_INVALID"),
  )
  assert.equal(invalidEntitlement.calls.length, 6)
})

test("selects the latest immutable routing policy and rejects a missing route policy", async () => {
  const source = createPostgresGatewayPolicyInputSource()
  const transaction = new PolicyInputTransaction(
    [modelRow()],
    [entitlementRow()],
    [resourceRow()],
    [mappingRow()],
    [
      routingPolicyRow({ routing_revision: 4n, updated_at: 104n }),
      routingPolicyRow({ routing_revision: 3n, updated_at: 103n }),
      routingPolicyRow({
        routing_policy_id: "routing-other",
        capability_id: "capability-other",
        routing_revision: 8n,
      }),
    ],
  )
  const result = await source.loadForGatewayInTransaction({
    transaction,
    tenantId,
    candidateResourceId: "resource-a",
    projections: [projection("resource-a")],
  })
  assert.equal(result.routing_policies.length, 1)
  assert.equal(result.routing_policies[0]!.routing_revision, 4)

  const missing = new PolicyInputTransaction(
    [modelRow()],
    [entitlementRow()],
    [resourceRow()],
    [mappingRow()],
    [],
  )
  await assert.rejects(
    source.loadForGatewayInTransaction({
      transaction: missing,
      tenantId,
      candidateResourceId: "resource-a",
      projections: [projection("resource-a")],
    }),
    assertErrorCode("GATEWAY_ROUTING_POLICY_MISSING"),
  )
})
