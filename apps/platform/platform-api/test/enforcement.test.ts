import assert from "node:assert/strict"
import test from "node:test"
import { Check } from "typebox/value"

import { createEnforcementChainCompiler } from "../src/capabilities/enforcement/compiler"
import {
  CompileEnforcementChainSchema,
  CompiledEnforcementChainSchema,
  type CompileEnforcementChainInput,
} from "../src/capabilities/enforcement/contract"
import { PlatformApiError } from "../src/capabilities/errors"
import type { ConnectionRegistration } from "../src/capabilities/connections/contract"
import type { ResourceConnectionRegistry } from "../src/capabilities/connections/module"
import type { ResourceRegistration } from "../src/capabilities/resources/contract"
import type { ResourceRegistry } from "../src/capabilities/resources/module"
import { createInMemoryEnforcementChainReader } from "../src/capabilities/enforcement/memory"

const resource: ResourceRegistration = {
  tenant_id: "tenant-acme",
  resource_id: "resource-ai",
  display_name: "AI Resource",
  kind: "LLM",
  owner_organization_id: "organization-ai",
  authentication_strategy: "OAUTH",
  environment_id: "local",
  version: "1.0.0",
  lifecycle: "DRAFT",
  operational_state: "HEALTHY",
  capabilities: [{ capability_id: "chat", display_name: "Chat" }],
  enforcement_point_id: "ai-gateway",
  created_at: 1,
}

const connection: ConnectionRegistration = {
  tenant_id: "tenant-acme",
  connection_id: "connection-openai",
  resource_id: "resource-ai",
  display_name: "OpenAI",
  connection_kind: "LLM",
  provider_type: "OPENAI",
  provider_profile_id: "profile-openai",
  endpoint: "https://api.openai.com",
  mcp_selected_tools: [],
  mcp_tool_selection_operation_id: null,
  credential_ref: "secret-openai",
  downstream_identity: { mode: "NONE" },
  request_mapping: null,
  status: "READY",
  configuration_revision: 1,
  lifecycle: "ENABLED",
  verification_state: "VERIFIED",
  health_state: "HEALTHY",
  health_observed_at: 1,
  health_source_revision: 1,
  routing_priority: 0,
  region: null,
  supported_obligations: [],
  created_at: 1,
}

const expiredCertificate: NonNullable<ConnectionRegistration["certificate"]> = {
  mode: "CUSTOM_CA",
  certificate_pem: "-----BEGIN CERTIFICATE-----\nexpired\n-----END CERTIFICATE-----",
  fingerprint_sha256: "a".repeat(64),
  subject: "CN=expired",
  issuer: "CN=expired",
  is_self_signed: true,
  not_before: 1,
  not_after: 2,
  status: "EXPIRED",
}

const nativeJwtConfig = {
  schema_version: "genio.one.auth.jwt.v1" as const,
  provider: "keycloak",
  issuer: "https://identity.example.test/realms/acme",
  audiences: ["genio-one"],
  remote_jwks_uri: "https://identity.example.test/realms/acme/protocol/openid-connect/certs",
  subject_claim: "sub",
  client_claim: "azp",
}

function scopedCompiler(overrides: {
  resource?: ResourceRegistration
  connection?: ConnectionRegistration
  connections?: ConnectionRegistration[]
  resourceError?: unknown
  connectionError?: unknown
} = {}) {
  const resources = {
    async getResource() {
      if (overrides.resourceError) throw overrides.resourceError
      return overrides.resource ?? resource
    },
  } as unknown as ResourceRegistry
  const availableConnections = overrides.connections ?? [overrides.connection ?? connection]
  const connections = {
    async list() {
      return availableConnections
    },
    async get({ connectionId }: { connectionId: string }) {
      if (overrides.connectionError) throw overrides.connectionError
      return (
        availableConnections.find((candidate) => candidate.connection_id === connectionId) ??
        availableConnections[0] ??
        connection
      )
    },
  } as unknown as ResourceConnectionRegistry
  return createEnforcementChainCompiler({ resources, connections })
}

const compiler = scopedCompiler()

function baseSteps(): CompileEnforcementChainInput["steps"] {
  return [
    {
      step_id: "authenticate",
      kind: "AUTHENTICATE",
      phase: "REQUEST",
      implementation: "NATIVE",
      config: nativeJwtConfig,
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
  ]
}

function input(steps: CompileEnforcementChainInput["steps"]): CompileEnforcementChainInput {
  return {
    resource_id: "resource-ai",
    capability_id: "chat",
    eligible_connection_ids: ["connection-openai"],
    one_policy_revision: 1,
    steps,
  }
}

test("compiler resolves a tenant-owned Resource and Connection before compiling", async () => {
  const crossTenantResource = { ...resource, tenant_id: "tenant-other" }
  await assert.rejects(
    scopedCompiler({ resource: crossTenantResource }).compile({
      tenantId: "tenant-acme",
      value: input(baseSteps()),
    }),
    (error: unknown) =>
      error instanceof PlatformApiError && error.code === "ENFORCEMENT_TENANT_MISMATCH",
  )

  const mismatchedConnection = { ...connection, resource_id: "resource-other" }
  await assert.rejects(
    scopedCompiler({ connection: mismatchedConnection }).compile({
      tenantId: "tenant-acme",
      value: input(baseSteps()),
    }),
    (error: unknown) =>
      error instanceof PlatformApiError && error.code === "ENFORCEMENT_CONNECTION_MISMATCH",
  )

  const crossTenantConnection = { ...connection, tenant_id: "tenant-other" }
  await assert.rejects(
    scopedCompiler({ connection: crossTenantConnection }).compile({
      tenantId: "tenant-acme",
      value: input(baseSteps()),
    }),
    (error: unknown) =>
      error instanceof PlatformApiError && error.code === "ENFORCEMENT_TENANT_MISMATCH",
  )
})

test("compiler does not turn an out-of-tenant lookup into a compiled chain", async () => {
  await assert.rejects(
    scopedCompiler({
      resourceError: new PlatformApiError("RESOURCE_NOT_FOUND", 404),
    }).compile({
      tenantId: "tenant-other",
      value: input(baseSteps()),
    }),
    (error: unknown) =>
      error instanceof PlatformApiError && error.code === "RESOURCE_NOT_FOUND",
  )
})

test("compiler validates the Resource Capability and every frozen Connection candidate", async () => {
  await assert.rejects(
    scopedCompiler().compile({
      tenantId: "tenant-acme",
      value: { ...input(baseSteps()), capability_id: "missing" },
    }),
    (error: unknown) =>
      error instanceof PlatformApiError && error.code === "ENFORCEMENT_CAPABILITY_NOT_FOUND",
  )

  const failover: ConnectionRegistration = {
    ...connection,
    connection_id: "connection-omlx",
    display_name: "OMLX",
  }
  const result = await scopedCompiler({ connections: [connection, failover] }).compile({
    tenantId: "tenant-acme",
    value: {
      ...input(baseSteps()),
      eligible_connection_ids: [connection.connection_id, failover.connection_id],
    },
  })
  assert.deepEqual(result.eligible_connection_ids, ["connection-openai", "connection-omlx"])

  await assert.rejects(
    scopedCompiler().compile({
      tenantId: "tenant-acme",
      value: { ...input(baseSteps()), eligible_connection_ids: ["connection-openai", "connection-openai"] },
    }),
    (error: unknown) =>
      error instanceof PlatformApiError &&
      error.code === "DUPLICATE_ENFORCEMENT_CONNECTION_CANDIDATE",
  )

  await assert.rejects(
    scopedCompiler({ connection: { ...connection, status: "DRAFT" } }).compile({
      tenantId: "tenant-acme",
      value: input(baseSteps()),
    }),
    (error: unknown) =>
      error instanceof PlatformApiError &&
      error.code === "ENFORCEMENT_CONNECTION_NOT_READY",
  )

  await assert.rejects(
    scopedCompiler({ connection: { ...connection, certificate: expiredCertificate } }).compile({
      tenantId: "tenant-acme",
      value: input(baseSteps()),
    }),
    (error: unknown) =>
      error instanceof PlatformApiError &&
      error.code === "ENFORCEMENT_CONNECTION_NOT_READY",
  )
})

test("formal candidate discovery freezes only READY Connections", async () => {
  const readyFailover: ConnectionRegistration = {
    ...connection,
    connection_id: "connection-omlx",
    display_name: "OMLX",
  }
  const result = await scopedCompiler({
    connections: [
      connection,
      readyFailover,
      { ...connection, connection_id: "connection-draft", status: "DRAFT" },
      { ...connection, connection_id: "connection-disabled", status: "DISABLED" },
      { ...connection, connection_id: "connection-expired", certificate: expiredCertificate },
    ],
  }).listEligibleConnectionIds({
    tenantId: "tenant-acme",
    resourceId: "resource-ai",
  })
  assert.deepEqual(result, ["connection-omlx", "connection-openai"])

  await assert.rejects(
    scopedCompiler({
      connections: [{ ...connection, status: "DEGRADED" }],
    }).listEligibleConnectionIds({
      tenantId: "tenant-acme",
      resourceId: "resource-ai",
    }),
    (error: unknown) =>
      error instanceof PlatformApiError &&
      error.code === "ENFORCEMENT_CONNECTION_CANDIDATES_REQUIRED",
  )
})

test("native authentication requires a strict versioned JWT configuration", async () => {
  const [authenticate, authorize, route] = baseSteps()
  const missingConfig = { ...authenticate, config: undefined } as unknown as typeof authenticate
  await rejectsWith(
    [missingConfig, authorize, route],
    "NATIVE_JWT_CONFIG_REQUIRED",
  )

  const invalidConfig = {
    ...authenticate,
    config: {
      ...nativeJwtConfig,
      remote_jwks_uri: "http://identity.example.test/jwks",
    },
  } as unknown as typeof authenticate
  await rejectsWith(
    [invalidConfig, authorize, route],
    "NATIVE_JWT_CONFIG_INVALID",
  )

  const unknownConfig = {
    ...authenticate,
    config: { ...nativeJwtConfig, unsupported: true },
  } as unknown as typeof authenticate
  await rejectsWith(
    [unknownConfig, authorize, route],
    "NATIVE_JWT_CONFIG_INVALID",
  )

  const emailIssuer = {
    ...authenticate,
    config: { ...nativeJwtConfig, issuer: "identity@example.test" },
  } as unknown as typeof authenticate
  await rejectsWith(
    [emailIssuer, authorize, route],
    "NATIVE_JWT_CONFIG_INVALID",
  )
})

async function rejectsWith(
  steps: CompileEnforcementChainInput["steps"],
  code: string,
): Promise<void> {
  await assert.rejects(
    compiler.compile({ tenantId: "tenant-acme", value: input(steps) }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === code,
  )
}

test("compiler keeps policy actions extensible while enforcing hook and filter order", async () => {
  const [authenticate, authorize, route] = baseSteps()
  const result = await compiler.compile({
    tenantId: "tenant-acme",
    value: input([
      authenticate,
      authorize,
      {
        step_id: "request-dlp",
        kind: "PROCESS",
        implementation: "PROCESSOR",
        depends_on: ["authorize"],
        hooks: {
          request: { action: "CUSTOM_ENTERPRISE_DLP" },
          response: { action: "CUSTOM_ENTERPRISE_DLP" },
        },
      },
      {
        step_id: "token-vault",
        kind: "PROCESS",
        implementation: "PROCESSOR",
        depends_on: ["request-dlp"],
        hooks: {
          request: { action: "TOKENIZE" },
          response: { action: "RESTORE" },
        },
      },
      {
        step_id: "classifier",
        kind: "PROCESS",
        implementation: "PROCESSOR",
        depends_on: ["token-vault"],
        hooks: {
          request: {
            action: "SEMANTIC_CLASSIFIER",
            effect: "SORT_ENTITLEMENT_CANDIDATES",
          },
        },
      },
      {
        step_id: "route-lease",
        kind: "PROCESS",
        implementation: "PROCESSOR",
        depends_on: ["classifier"],
        hooks: { request: { action: "SESSION_ROUTE_LEASE" } },
      },
      { ...route, depends_on: ["route-lease"] },
      {
        step_id: "usage",
        kind: "OBSERVE",
        implementation: "NATIVE_OTEL",
        depends_on: ["route"],
        hooks: { attempt: { action: "USAGE_EXTRACTION" } },
      },
      {
        step_id: "accounting",
        kind: "OBSERVE",
        implementation: "NATIVE_OTEL",
        depends_on: ["usage"],
        hooks: { response: { action: "ACCOUNTING" } },
      },
    ]),
  })

  assert.equal(result.tenant_id, "tenant-acme")
  assert.equal(result.capability_id, "chat")
  assert.deepEqual(result.eligible_connection_ids, ["connection-openai"])
  assert.match(result.chain_id, /^chain-[a-f0-9]{32}$/)
  assert.deepEqual(result.request_filter_order, [
    "authorize",
    "request-dlp",
    "token-vault",
    "classifier",
    "route-lease",
  ])
  assert.deepEqual(result.response_filter_order, ["token-vault", "request-dlp"])
})

test("compiled enforcement transport rejects unknown fields and padded identifiers", async () => {
  assert.equal(
    Check(CompileEnforcementChainSchema, {
      ...input(baseSteps()),
      unexpected: true,
    }),
    false,
  )
  const compiled = await compiler.compile({
    tenantId: "tenant-acme",
    value: input(baseSteps()),
  })
  assert.equal(Check(CompiledEnforcementChainSchema, compiled), true)
  assert.equal(Check(CompiledEnforcementChainSchema, { ...compiled, unexpected: true }), false)
  assert.equal(Check(CompiledEnforcementChainSchema, {
    ...compiled,
    steps: [{ ...compiled.steps[0], unexpected: true }, ...compiled.steps.slice(1)],
  }), false)
  assert.equal(Check(CompiledEnforcementChainSchema, {
    ...compiled,
    request_filter_order: [" authorize"],
  }), false)
})

test("reversible tokenization must remain one bidirectional PROCESS step", async () => {
  const [authenticate, authorize, route] = baseSteps()
  await rejectsWith(
    [
      authenticate,
      authorize,
      {
        step_id: "tokenize",
        kind: "PROCESS",
        implementation: "PROCESSOR",
        hooks: { request: { action: "TOKENIZE" } },
      },
      route,
    ],
    "TOKEN_VAULT_HOOK_PAIR_REQUIRED",
  )
  await rejectsWith(
    [
      authenticate,
      authorize,
      {
        step_id: "backwards-token-vault",
        kind: "PROCESS",
        implementation: "PROCESSOR",
        hooks: {
          request: { action: "RESTORE" },
          response: { action: "TOKENIZE" },
        },
      },
      route,
    ],
    "TOKEN_VAULT_HOOK_DIRECTION_INVALID",
  )
})

test("data protection semantic types fail before publication", async () => {
  const [authenticate, authorize, route] = baseSteps()
  await rejectsWith(
    [
      authenticate,
      authorize,
      {
        step_id: "tokenize",
        kind: "PROCESS",
        implementation: "PROCESSOR",
        hooks: {
          request: {
            action: "TOKENIZE",
            config: {
              patterns: [{ name: "secret-code", expression: "secret", flags: "i" }],
              token_ttl_seconds: 600,
            },
          },
          response: {
            action: "RESTORE",
            config: {
              patterns: [{ name: "secret-code", expression: "secret", flags: "i" }],
              token_ttl_seconds: 600,
            },
          },
        },
      },
      route,
    ],
    "DATA_PROTECTION_SEMANTIC_TYPE_INVALID",
  )
})

test("candidate mutation and route lease cannot cross the fixed routing anchor", async () => {
  const [authenticate, authorize, route] = baseSteps()
  await rejectsWith(
    [
      authenticate,
      authorize,
      route,
      {
        step_id: "late-classifier",
        kind: "PROCESS",
        implementation: "PROCESSOR",
        hooks: {
          request: {
            action: "SEMANTIC_CLASSIFIER",
            effect: "NARROW_ENTITLEMENT_CANDIDATES",
          },
        },
      },
    ],
    "PROCESS_MUST_PRECEDE_ROUTE_FILTER",
  )
  await rejectsWith(
    [
      authenticate,
      authorize,
      {
        step_id: "response-classifier",
        kind: "PROCESS",
        implementation: "PROCESSOR",
        hooks: { response: { action: "SEMANTIC_CLASSIFIER" } },
      },
      route,
    ],
    "CLASSIFIER_REQUEST_HOOK_REQUIRED",
  )
})

test("accounting cannot run before native AI usage extraction", async () => {
  const [authenticate, authorize, route] = baseSteps()
  await rejectsWith(
    [
      authenticate,
      authorize,
      route,
      {
        step_id: "accounting",
        kind: "OBSERVE",
        implementation: "NATIVE_OTEL",
        hooks: { response: { action: "ACCOUNTING" } },
      },
    ],
    "USAGE_EXTRACTION_MUST_PRECEDE_ACCOUNTING",
  )
})

test("in-memory revision store admits semantic chains and protects immutable values", async () => {
  const compiled = await compiler.compile({
    tenantId: "tenant-acme",
    value: input(baseSteps()),
  })
  const store = createInMemoryEnforcementChainReader()
  const saved = await store.save({ tenantId: "tenant-acme", chain: compiled })

  saved.chain.request_filter_order.push("caller-mutation")
  const loaded = await store.get({
    tenantId: "tenant-acme",
    resourceId: "resource-ai",
    capabilityId: "chat",
    onePolicyRevision: 1,
  })
  assert.deepEqual(loaded?.chain.request_filter_order, ["authorize"])

  await assert.rejects(
    store.save({
      tenantId: "tenant-acme",
      chain: { ...compiled, request_filter_order: [] },
    }),
    (error: unknown) =>
      error instanceof PlatformApiError &&
      error.code === "ENFORCEMENT_REQUEST_FILTER_ORDER_INVALID",
  )
  await assert.rejects(
    store.save({
      tenantId: "tenant-acme",
      chain: { ...compiled, unexpected: true } as typeof compiled,
    }),
    (error: unknown) =>
      error instanceof PlatformApiError &&
      error.code === "ENFORCEMENT_CHAIN_CONTRACT_INVALID",
  )
})
