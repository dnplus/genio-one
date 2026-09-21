import assert from "node:assert/strict"
import test from "node:test"

import { isCompiledAuthorizationBundle } from "../../../../runtimes/gateway/services/authorizer/signed-bundle"
import { authorize } from "@genioone/policy/authorize"
import {
  validateProcessorPolicyBundle,
  type ProcessorPolicyBundle,
} from "../../../../runtimes/gateway/services/processor/contract"
import type { ModelEntitlement } from "../src/capabilities/entitlements/contract"
import type {
  CompiledEnforcementChain,
  ProcessAction,
  ProcessStep,
} from "../src/capabilities/enforcement/contract"
import type { PublicModel } from "../src/capabilities/models/contract"
import type { GatewayProjection } from "../src/capabilities/gateway-projection/contract"
import {
  compileGatewayPolicyArtifacts,
  type GatewayPolicyArtifactCompilerInput,
} from "../src/capabilities/gateway-policy-release/compiler"
import { mcpToolCapabilityId } from "../../../../runtimes/gateway/services/shared/mcp-tool-capability"

const TENANT_ID = "tenant-acme"
const ISSUED_AT = 1_000
const EXPIRES_AT = 2_000

const dataProtectionConfig = {
  patterns: [
    {
      name: "EMAIL",
      expression: "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}",
    },
  ],
  token_ttl_seconds: 600,
}

function processAction(
  action: ProcessAction["action"],
  config: Record<string, unknown> = dataProtectionConfig,
): ProcessAction {
  return { action, config }
}

function processStep(
  stepId: string,
  request: ProcessAction,
  response?: ProcessAction,
): ProcessStep {
  return {
    step_id: stepId,
    kind: "PROCESS",
    implementation: "PROCESSOR",
    hooks: {
      request,
      ...(response ? { response } : {}),
    },
  }
}

function chain(
  resourceId: string,
  capabilityId: string,
  steps: CompiledEnforcementChain["steps"],
  tenantId = TENANT_ID,
): CompiledEnforcementChain {
  const orderedSteps: CompiledEnforcementChain["steps"] = [
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
    },
    ...steps,
    {
      step_id: "route",
      kind: "ROUTE",
      phase: "ROUTING",
      implementation: "AIGW_NATIVE",
    },
  ]
  return {
    chain_id: `chain-${resourceId}-${capabilityId}`,
    tenant_id: tenantId,
    resource_id: resourceId,
    capability_id: capabilityId,
    eligible_connection_ids: [`connection-${resourceId}`],
    one_policy_revision: 7,
    steps: orderedSteps,
    request_filter_order: orderedSteps
      .filter((step) => step.kind === "AUTHORIZE" || step.kind === "PROCESS")
      .map((step) => step.step_id),
    response_filter_order: orderedSteps
      .filter((step): step is ProcessStep => step.kind === "PROCESS" && Boolean(step.hooks.response))
      .map((step) => step.step_id)
      .reverse(),
  }
}

function projection(
  resourceId: string,
  capabilityId: string,
  enforcementChain: CompiledEnforcementChain,
  projectionId = `projection-${resourceId}`,
  operation: "APPLY" | "DELETE" = "APPLY",
): GatewayProjection {
  return {
    schema_version: "genio.one.gateway.v1",
    projection_id: projectionId,
    tenant_id: TENANT_ID,
    publication_id: `publication-${resourceId}`,
    resource_id: resourceId,
    capability_id: capabilityId,
    endpoint_revision: 1,
    policy_revision: 7,
    revision: 11,
    digest: "a".repeat(64),
    signature: {
      algorithm: "Ed25519",
      key_id: "projection-key",
      value: "A".repeat(86),
    },
    publication_endpoint: {
      gateway_id: "ai-gateway",
      hostname: `${resourceId}.example.test`,
      base_path: "/",
    },
    policy_bundle: {
      enforcement_chain: enforcementChain,
    },
    operation,
    resources:
      operation === "APPLY"
        ? [
            {
              apiVersion: "gateway.networking.k8s.io/v1",
              kind: "HTTPRoute",
              metadata: { name: `route-${resourceId}` },
              spec: {},
            },
            {
              apiVersion: "gateway.envoyproxy.io/v1alpha1",
              kind: "EnvoyExtensionPolicy",
              metadata: { name: `processor-${resourceId}` },
              spec: { lua: [{ type: "Inline", inline: "-- processor bridge" }] },
            },
          ]
        : [],
  } as GatewayProjection
}

function model(
  modelId: string,
  modelName: string,
  resourceId: string,
  overrides: Partial<PublicModel> = {},
): PublicModel {
  return {
    tenant_id: TENANT_ID,
    model_id: modelId,
    model_name: modelName,
    display_name: modelName,
    resource_id: resourceId,
    visibility: "PUBLIC",
    lifecycle: "PUBLISHED",
    capabilities: ["CHAT"],
    created_at: 1,
    ...overrides,
  }
}

function entitlement(
  entitlementId: string,
  publicModelId: string,
  overrides: Partial<ModelEntitlement> = {},
): ModelEntitlement {
  return {
    tenant_id: TENANT_ID,
    entitlement_id: entitlementId,
    subject_id: "subject-1",
    client_id: "client-1",
    resource_id: publicModelId.replace(/^model/, "resource"),
    capability_id: "chat",
    public_model_id: publicModelId,
    state: "ACTIVE",
    starts_at: 0,
    expires_at: null,
    created_at: 1,
    ...overrides,
  }
}

function baseInput(): GatewayPolicyArtifactCompilerInput {
  return {
    tenant_id: TENANT_ID,
    gateway_id: "ai-gateway",
    revision: "gateway-revision-7",
    policy_version: "policy-7",
    issued_at: ISSUED_AT,
    expires_at: EXPIRES_AT,
    projections: [
      projection(
        "resource-z",
        "chat",
        chain("resource-z", "chat", [
          processStep("redact", processAction("REDACT")),
          processStep(
            "tokenize",
            processAction("TOKENIZE"),
            processAction("RESTORE"),
          ),
        ]),
      ),
      projection(
        "resource-a",
        "chat",
        chain("resource-a", "chat", []),
      ),
    ],
    enforcement_chains: [
      chain("resource-z", "chat", [
        processStep("redact", processAction("REDACT")),
        processStep("tokenize", processAction("TOKENIZE"), processAction("RESTORE")),
      ]),
      chain("resource-a", "chat", []),
    ],
    public_models: [
      model("model-z", "public-z", "resource-z"),
      model("model-a", "public-a", "resource-a"),
    ],
    entitlements: [
      entitlement("entitlement-z", "model-z"),
      entitlement("entitlement-a", "model-a"),
    ],
  }
}

function compile(input = baseInput()) {
  const projectionChains = input.projections
    .filter((projection) => projection.operation === "APPLY")
    .map((projection) => projection.policy_bundle.enforcement_chain)
  const projectionKeys = new Set(projectionChains.map((value) =>
    `${value.resource_id}\u0000${value.capability_id}`))
  const inputKeys = new Set(input.enforcement_chains.map((value) =>
    `${value.resource_id}\u0000${value.capability_id}`))
  const aligned = projectionKeys.size === inputKeys.size &&
    [...projectionKeys].every((key) => inputKeys.has(key))
  return compileGatewayPolicyArtifacts({
    ...input,
    // Test cases that narrow projections must narrow their frozen chains too.
    // Preserve caller ordering when the two key sets already match.
    enforcement_chains: aligned ? input.enforcement_chains : projectionChains,
  })
}

test("compiles deterministic artifacts and preserves ordered PROCESS hooks", () => {
  const first = compile({
    ...baseInput(),
    projections: [...baseInput().projections].reverse(),
    enforcement_chains: [...baseInput().enforcement_chains].reverse(),
    public_models: [...baseInput().public_models].reverse(),
    entitlements: [...baseInput().entitlements].reverse(),
  })
  const second = compile()

  assert.deepEqual(first, second)
  assert.ok(isCompiledAuthorizationBundle(first.authorization_bundle))
  assert.deepEqual(
    first.authorization_bundle.rules.map((rule) => rule.rule_id),
    ["entitlement-a", "entitlement-z"],
  )
  assert.deepEqual(
    first.processor_policy.scopes.map((scope) => `${scope.resource_id}:${scope.capability_id}`),
    ["resource-z:chat"],
  )
  assert.deepEqual(
    first.processor_policy.scopes[0]!.steps.map((step) => step.step_id),
    ["redact", "tokenize"],
  )
  assert.equal(first.processor_policy.scopes[0]!.steps[1]!.hooks.response?.action, "RESTORE")
  assert.equal(validateProcessorPolicyBundle(first.processor_policy), first.processor_policy)
})

test("broad allow cannot remove mandatory CUSTOMER_DATA handling", () => {
  const dlp = processStep("customer-data-dlp", processAction("REDACT", {
    patterns: [{ name: "CUSTOMER_DATA", expression: "customer-[0-9]+" }],
    token_ttl_seconds: 600,
  }))
  const dlpChain = chain("resource-z", "chat", [dlp])
  const dlpProjection = projection("resource-z", "chat", dlpChain)
  const result = compileGatewayPolicyArtifacts({
    tenant_id: TENANT_ID,
    gateway_id: "ai-gateway",
    revision: "gateway-revision-customer-data",
    policy_version: "policy-customer-data",
    issued_at: ISSUED_AT,
    expires_at: EXPIRES_AT,
    projections: [dlpProjection],
    enforcement_chains: [dlpChain],
    public_models: [model("model-z", "public-z", "resource-z")],
    entitlements: [entitlement("broad-engineering-allow", "model-z", {
      subject_id: null,
      client_id: "engineering-client",
    })],
  })
  const decision = authorize(result.authorization_bundle, {
    requestProtocol: "LLM",
    tenantId: TENANT_ID,
    subjectId: "person-engineer",
    actingClientId: "engineering-client",
    resourceId: "resource-z",
    capabilityId: "chat",
    requestedPublicModel: "public-z",
    correlationId: "correlation-customer-data",
    now: ISSUED_AT,
  })
  assert.equal(decision.disposition, "ALLOW")
  assert.equal(decision.ruleId, "broad-engineering-allow")
  assert.deepEqual(result.processor_policy.scopes, [{
    resource_id: "resource-z",
    capability_id: "chat",
    steps: [{
      step_id: "customer-data-dlp",
      hooks: {
        request: {
          action: "REDACT",
          config: {
            patterns: [{ name: "CUSTOMER_DATA", expression: "customer-[0-9]+" }],
            token_ttl_seconds: 600,
          },
        },
      },
    }],
  }])
  assert.throws(() => compileGatewayPolicyArtifacts({
    tenant_id: TENANT_ID,
    gateway_id: "ai-gateway",
    revision: "gateway-revision-customer-data",
    policy_version: "policy-customer-data",
    issued_at: ISSUED_AT,
    expires_at: EXPIRES_AT,
    projections: [{
      ...dlpProjection,
      resources: dlpProjection.resources.filter((resource) =>
        resource.kind !== "EnvoyExtensionPolicy"
      ),
    }],
    enforcement_chains: [dlpChain],
    public_models: [model("model-z", "public-z", "resource-z")],
    entitlements: [entitlement("broad-engineering-allow", "model-z", {
      subject_id: null,
      client_id: "engineering-client",
    })],
  }), /cannot execute PROCESS steps without a processor seam/)
})

test("freezes One Policy authorization obligations into every matching entitlement rule", () => {
  const guardedChain = chain("resource-z", "chat", [])
  guardedChain.steps = guardedChain.steps.map((step) => step.kind === "AUTHORIZE"
    ? { ...step, config: { required_obligations: ["execution.confirmation"] } }
    : step)
  const guardedProjection = projection("resource-z", "chat", guardedChain)
  const result = compileGatewayPolicyArtifacts({
    tenant_id: TENANT_ID,
    gateway_id: "ai-gateway",
    revision: "gateway-revision-confirmation",
    policy_version: "policy-confirmation",
    issued_at: ISSUED_AT,
    expires_at: EXPIRES_AT,
    projections: [guardedProjection],
    enforcement_chains: [guardedChain],
    public_models: [model("model-z", "public-z", "resource-z")],
    entitlements: [entitlement("entitlement-confirmed", "model-z")],
  })
  assert.deepEqual(result.authorization_bundle.rules[0]?.required_obligations, ["execution.confirmation"])
  assert.deepEqual(authorize(result.authorization_bundle, {
    requestProtocol: "LLM",
    tenantId: TENANT_ID,
    subjectId: "subject-1",
    actingClientId: "client-1",
    resourceId: "resource-z",
    capabilityId: "chat",
    requestedPublicModel: "public-z",
    correlationId: "correlation-confirmation",
    now: ISSUED_AT,
  }).requiredObligations, ["execution.confirmation"])
})

test("compiles Subject-specific MCP tool Capabilities on one MCP route", () => {
  const routeCapability = "mcp.invoke"
  const resourceId = "resource-mcp"
  const mcpChain = chain(resourceId, routeCapability, [])
  const mcpProjection = projection(resourceId, routeCapability, mcpChain)
  mcpProjection.resources = [{
    apiVersion: "aigateway.envoyproxy.io/v1beta1",
    kind: "MCPRoute",
    metadata: { name: "resource-mcp" },
    spec: {
      backendRefs: [{ name: "engineering", toolSelector: { include: ["issues.search", "issues.delete"] } }],
    },
  }]
  const result = compileGatewayPolicyArtifacts({
    tenant_id: TENANT_ID,
    gateway_id: "ai-gateway",
    revision: "gateway-revision-mcp",
    policy_version: "policy-mcp",
    issued_at: ISSUED_AT,
    expires_at: EXPIRES_AT,
    projections: [mcpProjection],
    enforcement_chains: [mcpChain],
    public_models: [],
    entitlements: [
      {
        tenant_id: TENANT_ID,
        entitlement_id: "entitlement-search",
        subject_id: "subject-search",
        client_id: "codex",
        resource_id: resourceId,
        capability_id: mcpToolCapabilityId("issues.search"),
        public_model_id: null,
        state: "ACTIVE",
        starts_at: 0,
        expires_at: null,
        created_at: 1,
      },
      {
        tenant_id: TENANT_ID,
        entitlement_id: "entitlement-delete",
        subject_id: "subject-delete",
        client_id: "codex",
        resource_id: resourceId,
        capability_id: mcpToolCapabilityId("issues.delete"),
        public_model_id: null,
        state: "ACTIVE",
        starts_at: 0,
        expires_at: null,
        created_at: 1,
      },
    ],
  })
  assert.deepEqual(result.authorization_bundle.rules.map((rule) => ({
    subject: rule.subject_ids[0],
    capability: rule.capability_id,
    tools: rule.mcp_tools,
  })), [
    {
      subject: "subject-delete",
      capability: mcpToolCapabilityId("issues.delete"),
      tools: ["engineering__issues.delete"],
    },
    {
      subject: "subject-search",
      capability: mcpToolCapabilityId("issues.search"),
      tools: ["engineering__issues.search"],
    },
  ])
})

test("turns null principals into wildcard entries and exposes only the stable model name", () => {
  const result = compile({
    ...baseInput(),
    projections: [baseInput().projections[0]!],
    public_models: [baseInput().public_models[0]!],
    entitlements: [
      entitlement("entitlement-wildcard", "model-z", {
        subject_id: null,
        client_id: "client-explicit",
      }),
    ],
  })
  const [rule] = result.authorization_bundle.rules
  assert.deepEqual(rule, {
    rule_id: "entitlement-wildcard",
    disposition: "ALLOW",
    subject_ids: ["*"],
    acting_client_ids: ["client-explicit"],
    resource_id: "resource-z",
    capability_id: "chat",
    public_models: ["public-z"],
  })
  assert.equal(rule?.public_models.includes("model-z"), false)
})

test("expands Usage Context membership to the same verified Subject aliases as Entitlement", () => {
  const result = compile({
    ...baseInput(),
    subject_aliases: { "subject-1": ["external-subject-1"] },
    subject_contexts: [{ subject_id: "subject-1", kind: "AGENT" }],
    usage_contexts: [{
      subject_id: "subject-1",
      consumer_organization_id: "organization-consumer",
      use_case_id: "use-case-support",
      risk_level: "HIGH",
    }],
  })
  assert.deepEqual(result.authorization_bundle.usage_contexts, [
    {
      subject_id: "external-subject-1",
      consumer_organization_id: "organization-consumer",
      use_case_id: "use-case-support",
      risk_level: "HIGH",
    },
    {
      subject_id: "subject-1",
      consumer_organization_id: "organization-consumer",
      use_case_id: "use-case-support",
      risk_level: "HIGH",
    },
  ])
  assert.deepEqual(result.authorization_bundle.subject_contexts, [
    { subject_id: "external-subject-1", kind: "AGENT" },
    { subject_id: "subject-1", kind: "AGENT" },
  ])
})

test("signs only bounded Agent Delegations with canonical subjects and active projection capabilities", () => {
  const delegation = {
    delegation_id: "delegation-support",
    revision: 1,
    principal_subject_id: "subject-1",
    agent_subject_id: "agent-worker",
    resource_id: "resource-z",
    capability_ids: ["chat"],
    acting_client_ids: ["agent-runtime"],
    starts_at: 900,
    expires_at: 1_500,
    revocation_generation: 0,
    state: "ACTIVE" as const,
  }
  const result = compile({
    ...baseInput(),
    subject_contexts: [
      { subject_id: "subject-1", kind: "PERSON" },
      { subject_id: "agent-worker", kind: "AGENT" },
    ],
    agent_delegations: [delegation],
  })
  assert.deepEqual(result.authorization_bundle.agent_delegations, [delegation])
  assert.throws(() => compile({
    ...baseInput(),
    subject_contexts: [{ subject_id: "subject-1", kind: "PERSON" }],
    agent_delegations: [delegation],
  }), /subjects are not present/)
  assert.throws(() => compile({
    ...baseInput(),
    subject_contexts: [
      { subject_id: "subject-1", kind: "PERSON" },
      { subject_id: "agent-worker", kind: "AGENT" },
    ],
    agent_delegations: [{ ...delegation, capability_ids: ["ticket.delete"] }],
  }), /Capability does not map/)
})

test("excludes revoked, expired, and not-yet-active entitlements", () => {
  const result = compile({
    ...baseInput(),
    projections: [baseInput().projections[0]!],
    public_models: [baseInput().public_models[0]!],
    entitlements: [
      entitlement("active", "model-z"),
      entitlement("revoked", "model-z", { state: "REVOKED" }),
      entitlement("expired", "model-z", { expires_at: ISSUED_AT }),
      entitlement("future", "model-z", { starts_at: ISSUED_AT + 1 }),
    ],
  })
  assert.deepEqual(result.authorization_bundle.rules.map((rule) => rule.rule_id), ["active"])
  assert.deepEqual(result.authorization_bundle.revoked_entitlement_ids, ["revoked"])
})

test("never keeps an authorization grant alive beyond its entitlement expiry", () => {
  const result = compile({
    ...baseInput(),
    entitlements: [entitlement("short-lived", "model-z", { expires_at: 1_200 })],
  })
  assert.equal(result.authorization_bundle.expires_at, 1_200)
  assert.equal(result.processor_policy.expires_at, 1_200)
})

test("fails closed for invalid publication, lifecycle, tenant, and mapping state", () => {
  assert.throws(
    () => compile({ ...baseInput(), projections: [baseInput().projections[0]!, projection("resource-z", "chat", chain("resource-z", "chat", []), "projection-delete", "DELETE")] }),
    /APPLY projection/,
  )
  assert.throws(
    () => compile({
      ...baseInput(),
      public_models: [model("model-z", "public-z", "resource-z", { lifecycle: "DEPRECATED" })],
      projections: [baseInput().projections[0]!],
      entitlements: [entitlement("active", "model-z")],
    }),
    /not published/,
  )
  assert.throws(
    () => compile({
      ...baseInput(),
      public_models: [model("model-other", "public-other", "resource-other")],
      projections: [baseInput().projections[0]!],
      entitlements: [entitlement("active", "model-other")],
    }),
    /does not map to an active Gateway projection/,
  )
  assert.throws(
    () => compile({ ...baseInput(), public_models: [{ ...baseInput().public_models[0]!, tenant_id: "tenant-other" }] }),
    /tenant does not match/,
  )
  assert.throws(
    () => compile({ ...baseInput(), entitlements: [entitlement("active", "missing-model")] }),
    /unknown public model/,
  )
  assert.throws(
    () => compile({
      ...baseInput(),
      projections: [{
        ...baseInput().projections[0]!,
        publication_endpoint: {
          ...baseInput().projections[0]!.publication_endpoint,
          gateway_id: "other-gateway",
        },
      }],
      public_models: [baseInput().public_models[0]!],
      entitlements: [entitlement("active", "model-z")],
    }),
    /Gateway does not match/,
  )
  assert.throws(
    () => compile({
      ...baseInput(),
      projections: [baseInput().projections[0]!, baseInput().projections[0]!],
      enforcement_chains: [baseInput().enforcement_chains[0]!],
    }),
    /current enforcement chain/,
  )
})

test("fails closed for duplicate models, ambiguous resources, and invalid process config", () => {
  assert.throws(
    () => compile({
      ...baseInput(),
      public_models: [
        model("duplicate", "public-z", "resource-z"),
        model("duplicate", "public-other", "resource-z"),
      ],
      projections: [baseInput().projections[0]!],
      entitlements: [],
    }),
    /duplicate model_id/,
  )
  assert.throws(
    () => compile({
      ...baseInput(),
      public_models: [
        model("model-1", "same-name", "resource-z"),
        model("model-2", "same-name", "resource-z"),
      ],
      projections: [baseInput().projections[0]!],
      entitlements: [],
    }),
    /duplicate model_name/,
  )
  assert.throws(
    () => compile({
      ...baseInput(),
      projections: [
        baseInput().projections[0]!,
        projection(
          "resource-z",
          "embeddings",
          chain("resource-z", "embeddings", []),
          "projection-resource-z-embeddings",
        ),
      ],
      public_models: [model("model-z", "public-z", "resource-z")],
      entitlements: [entitlement("active", "model-z")],
    }),
    /ambiguous resource mapping/,
  )
  const invalidProcess = projection(
    "resource-z",
    "chat",
    chain("resource-z", "chat", [
      processStep("unsupported", processAction("CUSTOM_ACTION" as ProcessAction["action"])),
    ]),
  )
  assert.throws(
    () => compile({
      ...baseInput(),
      projections: [invalidProcess],
      public_models: [baseInput().public_models[0]!],
      entitlements: [],
    }),
    /unsupported/,
  )
  const malformedProcess = projection(
    "resource-z",
    "chat",
    chain("resource-z", "chat", [
      processStep("malformed", processAction("REDACT", { patterns: [], token_ttl_seconds: "600" })),
    ]),
  )
  assert.throws(
    () => compile({
      ...baseInput(),
      projections: [malformedProcess],
      public_models: [baseInput().public_models[0]!],
      entitlements: [],
    }),
    /config is invalid/,
  )
})

test("validates compiler metadata and rejects a global wildcard grant", () => {
  assert.throws(() => compile({ ...baseInput(), revision: " revision" }), /revision is invalid/)
  assert.throws(() => compile({ ...baseInput(), expires_at: ISSUED_AT }), /after issued_at/)
  assert.throws(
    () => compile({
      ...baseInput(),
      projections: [baseInput().projections[0]!],
      public_models: [baseInput().public_models[0]!],
      entitlements: [entitlement("global", "model-z", { subject_id: null, client_id: null })],
    }),
    /subject or client/,
  )
  assert.throws(
    () => compile({
      ...baseInput(),
      entitlements: [entitlement("explicit-wildcard", "model-z", { subject_id: "*" })],
    }),
    /reserved wildcard/,
  )
})

test("revalidates persisted chain semantics and its projection revision", () => {
  const valid = baseInput().projections[0]!
  assert.throws(
    () => compile({
      ...baseInput(),
      projections: [{
        ...valid,
        policy_bundle: {
          enforcement_chain: {
            ...valid.policy_bundle.enforcement_chain,
            request_filter_order: ["tokenize", "redact"],
          },
        },
      }],
      public_models: [baseInput().public_models[0]!],
      entitlements: [entitlement("active", "model-z")],
    }),
    /REQUEST_FILTER_ORDER_INVALID/,
  )
  assert.throws(
    () => compile({
      ...baseInput(),
      projections: [{ ...valid, policy_revision: 8 }],
      public_models: [baseInput().public_models[0]!],
      entitlements: [entitlement("active", "model-z")],
    }),
    /revision does not match projection/,
  )
})

test("keeps the emitted bundles on the caller's single release window", () => {
  const result: { authorization_bundle: ProcessorPolicyBundle | unknown; processor_policy: ProcessorPolicyBundle } = {
    authorization_bundle: compile().authorization_bundle,
    processor_policy: compile().processor_policy,
  }
  assert.equal((result.authorization_bundle as { revision: string }).revision, "gateway-revision-7")
  assert.equal(result.processor_policy.revision, "gateway-revision-7")
  assert.equal(result.processor_policy.issued_at, ISSUED_AT)
  assert.equal(result.processor_policy.expires_at, EXPIRES_AT)
})
