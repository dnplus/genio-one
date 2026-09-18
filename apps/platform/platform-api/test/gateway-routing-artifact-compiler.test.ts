import assert from "node:assert/strict"
import test from "node:test"

import {
  compileGatewayRoutingArtifact,
  type GatewayRoutingApplyProjection,
  type GatewayRoutingArtifactCompilerInput,
  type GatewayRoutingResourceOwnerRef,
  type GatewayRoutingConnectionFact,
} from "../src/capabilities/gateway-policy-release/routing-compiler"
import type { ModelRoutingPolicy } from "../src/capabilities/model-routing/contract"
import type {
  ConnectionModelMapping,
  PublicModel,
} from "../src/capabilities/models/contract"
import { contextualGatewayRoutingScope } from "../../../../runtimes/gateway/services/shared/gateway-routing-artifact"

const tenantId = "tenant-acme"
const gatewayId = "gateway-ai-primary"

function projection(
  resourceId = "resource-chat",
  capabilityId = "capability-chat",
  onePolicyRevision = 9,
): GatewayRoutingApplyProjection {
  return {
    operation: "APPLY",
    tenant_id: tenantId,
    resource_id: resourceId,
    capability_id: capabilityId,
    one_policy_revision: onePolicyRevision,
    required_obligation_kinds: [],
  }
}

function owner(resourceId = "resource-chat", organizationId = "org-acme"): GatewayRoutingResourceOwnerRef {
  return {
    tenant_id: tenantId,
    resource_id: resourceId,
    owner_organization_id: organizationId,
  }
}

function model(
  modelId: string,
  modelName: string,
  resourceId = "resource-chat",
  overrides: Partial<PublicModel> = {},
): PublicModel {
  return {
    tenant_id: tenantId,
    model_id: modelId,
    model_name: modelName,
    display_name: modelName,
    resource_id: resourceId,
    visibility: "PUBLIC",
    lifecycle: "PUBLISHED",
    capabilities: ["CHAT", "STREAMING"],
    created_at: 100,
    ...overrides,
  }
}

function mapping(
  mappingId: string,
  publicModelId: string,
  connectionId: string,
  providerModel: string,
  resourceId = "resource-chat",
  overrides: Partial<ConnectionModelMapping> = {},
): ConnectionModelMapping {
  return {
    tenant_id: tenantId,
    mapping_id: mappingId,
    public_model_id: publicModelId,
    resource_id: resourceId,
    connection_id: connectionId,
    provider_model: providerModel,
    mapping_revision: 3,
    created_at: 100,
    ...overrides,
  }
}

function routingPolicy(
  overrides: Partial<ModelRoutingPolicy> = {},
): ModelRoutingPolicy {
  return {
    tenant_id: tenantId,
    routing_policy_id: "routing-chat",
    owner_organization_id: "org-acme",
    resource_id: "resource-chat",
    capability_id: "capability-chat",
    routing_revision: 4,
    mode: "SESSION_LEASE",
    candidate_public_model_ids: ["pm_01", "pm_02"],
    default_public_model_id: "pm_01",
    session_lease_seconds: 900,
    created_at: 100,
    updated_at: 100,
    ...overrides,
  }
}

function connection(
  connectionId: string,
  priority: number,
  overrides: Partial<GatewayRoutingConnectionFact> = {},
): GatewayRoutingConnectionFact {
  return {
    tenant_id: tenantId,
    resource_id: "resource-chat",
    connection_id: connectionId,
    configuration_revision: 3,
    lifecycle: "ENABLED",
    verification_state: "VERIFIED",
    health_state: "HEALTHY",
    health_observed_at: 100,
    health_source_revision: 2,
    routing_priority: priority,
    region: "tw-north",
    supported_obligations: ["audit"],
    ...overrides,
  }
}

function baseInput(): GatewayRoutingArtifactCompilerInput {
  return {
    tenant_id: tenantId,
    gateway_id: gatewayId,
    revision: "gateway-revision-11",
    policy_version: "policy-v9",
    issued_at: 100,
    expires_at: 1_000,
    projections: [projection()],
    resource_owners: [owner()],
    routing_policies: [routingPolicy()],
    public_models: [
      model("pm_01", "genio-standard"),
      model("pm_02", "genio-reasoning"),
    ],
    model_mappings: [
      mapping("mapping-z", "pm_01", "connection-openai", "gpt-4.1"),
      mapping("mapping-a", "pm_02", "connection-omlx", "LFM2.5-1.2B"),
    ],
  }
}

function compile(input = baseInput()) {
  return compileGatewayRoutingArtifact(input)
}

test("compiles asymmetric Public Model, alias, provider model, and ordered mappings", () => {
  const result = compile()
  const scope = result.scopes[0]!
  assert.equal(scope.owner_organization_id, "org-acme")
  assert.equal(scope.routing_policy_id, "routing-chat")
  assert.equal(scope.routing_revision, 4)
  assert.equal(scope.one_policy_revision, 9)
  assert.equal(scope.default_public_model_id, "pm_01")
  assert.deepEqual(
    scope.candidates.map((candidate) => [candidate.order, candidate.public_model_id, candidate.public_model_name]),
    [
      [1, "pm_01", "genio-standard"],
      [2, "pm_02", "genio-reasoning"],
    ],
  )
  assert.deepEqual(scope.candidates[0]!.mappings[0], {
    order: 1,
    mapping_id: "mapping-z",
    resource_id: "resource-chat",
    connection_id: "connection-openai",
    provider_model: "gpt-4.1",
    mapping_revision: 3,
    connection_configuration_revision: 1,
    priority: 0,
    region: null,
    supported_obligations: [],
    health_observed_at: 100,
    health_source_revision: 1,
  })
  assert.equal(scope.candidates[0]!.public_model_id, "pm_01")
  assert.equal(scope.candidates[0]!.public_model_name, "genio-standard")
  assert.equal(scope.candidates[0]!.mappings[0]!.provider_model, "gpt-4.1")
  assert.equal(scope.session_lease?.ttl_seconds, 900)
  assert.match(scope.candidate_set_digest, /^[a-f0-9]{64}$/)
})

test("freezes provider-neutral PriceBook provenance on the exact Connection mapping", () => {
  const input = baseInput()
  input.pricing = [{
    mapping_id: "mapping-z",
    currency: "USD",
    input_cost_per_token_micros: 2.5,
    output_cost_per_token_micros: 10,
    source: "LITELLM",
    version: "f".repeat(64),
  }]
  const result = compile(input)
  assert.deepEqual(result.scopes[0]!.candidates[0]!.mappings[0]!.pricing, {
    currency: "USD",
    input_cost_per_token_micros: 2.5,
    output_cost_per_token_micros: 10,
    source: "LITELLM",
    version: "f".repeat(64),
  })
  assert.equal(result.scopes[0]!.candidates[1]!.mappings[0]!.pricing, undefined)
})

test("freezes the exact Provider Credential Profile binding on a Connection mapping", () => {
  const input = baseInput()
  input.connections = [
    connection("connection-openai", 0, {
      provider_credential_profile_id: "provider-credential-openai",
      provider_credential_profile_revision: 7,
      provider_credential_strategy_digest: "a".repeat(64),
    }),
    connection("connection-omlx", 1),
  ]
  const mappingValue = compile(input).scopes[0]!.candidates[0]!.mappings[0]!
  assert.equal(mappingValue.provider_credential_profile_id, "provider-credential-openai")
  assert.equal(mappingValue.provider_credential_profile_revision, 7)
  assert.equal(mappingValue.provider_credential_strategy_digest, "a".repeat(64))

  input.connections = [
    connection("connection-openai", 0, {
      provider_credential_profile_id: "provider-credential-openai",
    }),
    connection("connection-omlx", 1),
  ]
  assert.throws(
    () => compile(input),
    /provider credential binding must be all-or-none/,
  )
})

test("preserves policy candidate order while canonicalizing mapping order and scope order", () => {
  const input = baseInput()
  input.projections = [projection("resource-z", "cap-z"), projection()]
  input.resource_owners = [owner(), owner("resource-z", "org-z")]
  input.routing_policies = [
    routingPolicy({
      routing_policy_id: "routing-z",
      resource_id: "resource-z",
      capability_id: "cap-z",
      owner_organization_id: "org-z",
      candidate_public_model_ids: ["pm_z", "pm_z2"],
      default_public_model_id: "pm_z",
    }),
    routingPolicy({
      candidate_public_model_ids: ["pm_01"],
      default_public_model_id: "pm_01",
    }),
  ]
  input.public_models = [
    model("pm_01", "genio-standard"),
    model("pm_z", "genio-z", "resource-z"),
    model("pm_z2", "genio-z-fallback", "resource-z"),
  ]
  input.model_mappings = [
    mapping("mapping-z2", "pm_z", "connection-z2", "z-model", "resource-z"),
    mapping("mapping-z1", "pm_z", "connection-z1", "z-model-fallback", "resource-z"),
    mapping("mapping-z3", "pm_z2", "connection-z3", "z-model-2", "resource-z"),
    mapping("mapping-a", "pm_01", "connection-openai", "gpt-4.1"),
  ]

  const result = compile(input)
  assert.deepEqual(result.scopes.map((scope) => scope.resource_id), ["resource-chat", "resource-z"])
  const zScope = result.scopes[1]!
  assert.deepEqual(zScope.candidates.map((candidate) => candidate.public_model_id), ["pm_z", "pm_z2"])
  assert.deepEqual(
    zScope.candidates[0]!.mappings.map((mappingValue) => mappingValue.mapping_id),
    ["mapping-z1", "mapping-z2"],
  )
})

test("limits routing to the Connection IDs frozen by the One Policy revision", () => {
  const input = baseInput()
  input.projections = [{ ...projection(), eligible_connection_ids: ["connection-openai"] }]
  input.connections = [
    connection("connection-openai", 0),
    connection("connection-omlx", 10),
  ]
  const scope = compile(input).scopes[0]!
  assert.deepEqual(scope.candidates[0]!.mappings.map((value) => value.connection_id), ["connection-openai"])
  assert.deepEqual(scope.candidates[1]!.mappings, [])
})

test("excludes a custom trust certificate after its frozen validity window", () => {
  const input = baseInput()
  input.connections = [
    connection("connection-openai", 0, {
      certificate_mode: "CUSTOM_CA",
      certificate_not_before: 1,
      certificate_not_after: 99,
    }),
    connection("connection-omlx", 10),
  ]
  const scope = compile(input).scopes[0]!
  assert.deepEqual(scope.candidates[0]!.mappings, [])
  assert.deepEqual(scope.candidates[1]!.mappings.map((value) => value.connection_id), ["connection-omlx"])
})

test("orders healthy Connections by explicit priority and excludes stale health", () => {
  const input = baseInput()
  input.issued_at = 500
  input.model_mappings = [
    mapping("mapping-a", "pm_01", "connection-a", "model-a"),
    mapping("mapping-b", "pm_01", "connection-b", "model-b"),
    mapping("mapping-c", "pm_01", "connection-c", "model-c"),
    mapping("mapping-d", "pm_02", "connection-d", "model-d"),
  ]
  input.connections = [
    connection("connection-a", 20, { health_observed_at: 500 }),
    connection("connection-b", 5, { health_observed_at: 500 }),
    connection("connection-c", 1),
    connection("connection-d", 0, { health_observed_at: 500 }),
  ]
  const scope = compile(input).scopes[0]!
  assert.deepEqual(scope.candidates[0]!.mappings.map((value) => value.connection_id), ["connection-b", "connection-a"])
  assert.equal(scope.retry_policy?.max_attempts, 3)
})

test("freezes an empty candidate set when every Connection is unavailable", () => {
  const input = baseInput()
  input.connections = [
    connection("connection-openai", 0, { health_state: "UNAVAILABLE" }),
    connection("connection-omlx", 10, { health_state: "UNKNOWN" }),
  ]
  const scope = compile(input).scopes[0]!
  assert.deepEqual(scope.candidates.flatMap((candidate) => candidate.mappings), [])
  assert.equal(scope.retry_policy?.max_attempts, 0)
})

test("mandatory obligations freeze an empty candidate set instead of silently downgrading", () => {
  const input = baseInput()
  input.projections = [{ ...projection(), required_obligation_kinds: ["redaction"] }]
  input.connections = [
    connection("connection-openai", 0, { supported_obligations: ["audit"] }),
    connection("connection-omlx", 10, { supported_obligations: ["audit"] }),
  ]
  const scope = compile(input).scopes[0]!
  assert.deepEqual(scope.candidates.flatMap((candidate) => candidate.mappings), [])
  assert.equal(scope.retry_policy?.max_attempts, 0)
})

test("managed Use Case risk narrows the frozen candidate set to obligation-compatible Connections", () => {
  const input = baseInput()
  input.routing_policies = [routingPolicy({
    context_requirements: [{
      consumer_organization_id: "org-consumer",
      use_case_id: "use-case-support",
      minimum_risk_level: "HIGH",
      required_obligation_kinds: ["dlp"],
    }],
  })]
  input.model_mappings = [
    mapping("mapping-primary", "pm_01", "connection-primary", "model-primary"),
    mapping("mapping-controlled", "pm_01", "connection-controlled", "model-controlled"),
    mapping("mapping-reasoning", "pm_02", "connection-reasoning", "model-reasoning"),
  ]
  input.connections = [
    connection("connection-primary", 0, { supported_obligations: ["audit"] }),
    connection("connection-controlled", 10, { supported_obligations: ["audit", "dlp"] }),
    connection("connection-reasoning", 20, { supported_obligations: ["audit"] }),
  ]
  const scope = compile(input).scopes[0]!
  const lowRisk = contextualGatewayRoutingScope(scope, "org-consumer", "use-case-support", "LOW")
  const highRisk = contextualGatewayRoutingScope(scope, "org-consumer", "use-case-support", "HIGH")

  assert.deepEqual(lowRisk.candidates[0]!.mappings.map((value) => value.connection_id), [
    "connection-primary",
    "connection-controlled",
  ])
  assert.deepEqual(highRisk.required_obligation_kinds, ["dlp"])
  assert.deepEqual(highRisk.candidates[0]!.mappings.map((value) => value.connection_id), [
    "connection-controlled",
  ])
  assert.equal(highRisk.candidates[1]!.mappings.length, 0)
  assert.notEqual(highRisk.candidate_set_digest, scope.candidate_set_digest)
  assert.equal(highRisk.retry_policy?.max_attempts, 1)

  input.connections = input.connections.map((value) => ({
    ...value,
    supported_obligations: ["audit"],
  }))
  const unavailable = contextualGatewayRoutingScope(
    compile(input).scopes[0]!,
    "org-consumer",
    "use-case-support",
    "HIGH",
  )
  assert.equal(unavailable.candidates.every((candidate) => candidate.mappings.length === 0), true)
  assert.equal(unavailable.retry_policy?.max_attempts, 0)
})

test("fails closed for cross-tenant, owner, Resource, capability, and publication mismatches", () => {
  assert.throws(
    () => compile({ ...baseInput(), projections: [{ ...projection(), tenant_id: "tenant-other" }] }),
    /tenant does not match/,
  )
  assert.throws(
    () => compile({ ...baseInput(), resource_owners: [owner("resource-chat", "org-other")] }),
    /owner does not match Resource/,
  )
  assert.throws(
    () => compile({ ...baseInput(), routing_policies: [routingPolicy({ capability_id: "cap-other" })] }),
    /exactly one routing policy/,
  )
  assert.throws(
    () => compile({
      ...baseInput(),
      public_models: [
        model("pm_01", "genio-standard", "resource-other"),
        model("pm_02", "genio-reasoning"),
      ],
      model_mappings: [
        mapping("mapping-z", "pm_01", "connection-other", "gpt-4.1", "resource-other"),
        baseInput().model_mappings[1]!,
      ],
    }),
    /owned by Resource resource-other/,
  )
  assert.throws(
    () => compile({ ...baseInput(), public_models: [model("pm_01", "genio-standard", "resource-chat", { lifecycle: "DEPRECATED" }), model("pm_02", "genio-reasoning")] }),
    /must be PUBLISHED/,
  )
})

test("fails closed for missing policy, duplicate revisions, model membership, mapping membership, and duplicates", () => {
  assert.throws(
    () => compile({ ...baseInput(), routing_policies: [] }),
    /exactly one routing policy/,
  )
  assert.throws(
    () => compile({ ...baseInput(), routing_policies: [routingPolicy(), routingPolicy({ routing_policy_id: "routing-chat-2" })] }),
    /duplicate revision|exactly one routing policy/,
  )
  assert.throws(
    () => compile({ ...baseInput(), routing_policies: [routingPolicy({ candidate_public_model_ids: ["pm_unknown"], default_public_model_id: "pm_unknown" })] }),
    /unknown Public Model/,
  )
  assert.throws(
    () => compile({ ...baseInput(), model_mappings: [mapping("mapping-z", "pm_unknown", "connection-openai", "gpt-4.1"), mapping("mapping-a", "pm_02", "connection-omlx", "LFM2.5-1.2B")] }),
    /unknown Public Model pm_unknown/,
  )
  assert.throws(
    () => compile({ ...baseInput(), model_mappings: [mapping("mapping-z", "pm_01", "connection-openai", "gpt-4.1"), mapping("mapping-z", "pm_02", "connection-omlx", "LFM2.5-1.2B")] }),
    /duplicate mapping_id/,
  )
  assert.throws(
    () => compile({ ...baseInput(), projections: [projection(), projection()] }),
    /duplicate Resource\/Capability/,
  )
})

test("rejects provider/model confusion, non-first defaults, and secret/open projection fields", () => {
  assert.throws(
    () => compile({
      ...baseInput(),
      model_mappings: [
        mapping("mapping-z", "gpt-4.1", "connection-openai", "gpt-4.1"),
        baseInput().model_mappings[1]!,
      ],
    }),
    /unknown Public Model gpt-4.1/,
  )
  assert.throws(
    () => compile({ ...baseInput(), routing_policies: [routingPolicy({ default_public_model_id: "pm_02" })] }),
    /default must be the first ordered candidate/,
  )
  assert.throws(
    () => compile({
      ...baseInput(),
      model_mappings: [
        mapping("mapping-z", "pm_01", "connection-openai", "gpt-4.1", "resource-chat", {
          api_key: "secret",
        } as unknown as Partial<ConnectionModelMapping>),
        baseInput().model_mappings[1]!,
      ],
    }),
    /unexpected fields/,
  )
  assert.throws(
    () => compile({
      ...baseInput(),
      projections: [{ ...projection(), native: { spec: { secret: "value" } } } as unknown as GatewayRoutingApplyProjection],
    }),
    /closed APPLY projection/,
  )
})
