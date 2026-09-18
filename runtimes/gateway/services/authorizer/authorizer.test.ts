import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

import grpc from "@grpc/grpc-js"
import protoLoader from "@grpc/proto-loader"

import type { AuthorizationDecisionEvent, CompiledAuthorizationBundle } from "../../../../packages/protocol/src/authorization"
import {
  createExternalAuthorizerServer,
  fixedAllowResponseHeaders,
  type McpOAuthRequestHeaderResolver,
  type RoutingRejectionObservation,
  type UsageRejectionObservation,
} from "./grpc"
import { authorize } from "../../../../packages/policy/src/authorize"
import { verifyAuthorizationBundle } from "./signed-bundle"
import type { AuthorizationBundleSnapshot } from "./bundle-store"
import { TRUSTED_RELEASE_HEADERS } from "../shared/release-handoff"
import {
  gatewayRoutingCandidateSetDigest,
  type GatewayRoutingArtifact,
} from "../shared/gateway-routing-artifact"
import type { UsageCounterStore } from "../shared/usage-governance"
import { executionActionDigest, type ExecutionGrantConsumer } from "../shared/execution-grant"

const now = 1_800_000_000
const bundle: CompiledAuthorizationBundle = {
  schema_version: 1,
  tenant_id: "tenant-ai",
  revision: "bundle-7",
  policy_version: "policy-4",
  issued_at: now - 30,
  expires_at: now + 300,
  rules: [
    {
      rule_id: "allow-corporate-gpt",
      disposition: "ALLOW",
      subject_ids: ["person-1"],
      acting_client_ids: ["codex"],
      resource_id: "corporate-gpt",
      capability_id: "chat",
      public_models: ["genio-standard"],
      mcp_tools: ["issues.search"],
    },
  ],
}
const releaseReference = {
  schema_version: "genio.one.gateway-release-ref.v1" as const,
  release_id: "release-7",
  gateway_id: "ai-gateway",
  head_revision: 7,
  package_digest: "a".repeat(64),
  projection_count: 2,
}
const routingArtifact = {
  schema_version: "genio.one.gateway-routing.v1" as const,
  tenant_id: "tenant-ai",
  gateway_id: "ai-gateway",
  revision: "bundle-7",
  policy_version: "policy-4",
  issued_at: now - 30,
  expires_at: now + 300,
  scopes: [],
}
const pricedRoutingArtifact: GatewayRoutingArtifact = {
  ...routingArtifact,
  scopes: [{
    owner_organization_id: "org-resource-owner",
    resource_id: "corporate-gpt",
    capability_id: "chat",
    routing_policy_id: "routing-chat",
    routing_revision: 1,
    one_policy_revision: 1,
    route_mode: "DETERMINISTIC",
    default_public_model_id: "model-standard",
    candidate_set_digest: "b".repeat(64),
    candidates: [{
      order: 1,
      public_model_id: "model-standard",
      public_model_name: "genio-standard",
      mappings: [{
        order: 1,
        mapping_id: "mapping-standard",
        resource_id: "corporate-gpt",
        connection_id: "connection-primary",
        provider_model: "provider-model",
        mapping_revision: 1,
        pricing: {
          currency: "USD",
          input_cost_per_token_micros: 2,
          output_cost_per_token_micros: 8,
          source: "LITELLM",
          version: "f".repeat(64),
        },
      }],
    }],
  }],
}

function bundleSnapshot(): AuthorizationBundleSnapshot {
  return { bundle, releaseReference, routingArtifact }
}

const input = {
  requestProtocol: "LLM" as const,
  tenantId: "tenant-ai",
  subjectId: "person-1",
  actingClientId: "codex",
  resourceId: "corporate-gpt",
  capabilityId: "chat",
  requestedPublicModel: "genio-standard",
  correlationId: "correlation-1",
  now,
}

test("One Policy authorizer never widens the entitled model set", () => {
  assert.equal(authorize(bundle, input).disposition, "ALLOW")
  assert.deepEqual(authorize(bundle, input).allowedPublicModels, ["genio-standard"])
  assert.equal(
    authorize(bundle, { ...input, requestedPublicModel: "provider-secret-model" }).reason,
    "MODEL_NOT_ENTITLED",
  )
})

test("One Policy authorizer combines matching model grants and gives deny precedence", () => {
  const secondGrant: CompiledAuthorizationBundle = {
    ...bundle,
    rules: [
      ...bundle.rules,
      {
        ...bundle.rules[0]!,
        rule_id: "allow-corporate-opus",
        public_models: ["genio-opus"],
      },
    ],
  }
  const allowed = authorize(secondGrant, {
    ...input,
    requestedPublicModel: "genio-opus",
  })
  assert.equal(allowed.disposition, "ALLOW")
  assert.deepEqual(allowed.allowedPublicModels, ["genio-standard", "genio-opus"])

  const denied = authorize({
    ...secondGrant,
    rules: [
      ...secondGrant.rules,
      {
        ...bundle.rules[0]!,
        rule_id: "deny-corporate-models",
        disposition: "DENY",
      },
    ],
  }, input)
  assert.equal(denied.reason, "DENIED_BY_RULE")
  assert.equal(denied.ruleId, "deny-corporate-models")
})

test("MCP tools/call reauthorizes the exact published tool", () => {
  const mcpBundle: CompiledAuthorizationBundle = {
    ...bundle,
    rules: [{
      ...bundle.rules[0]!,
      resource_id: "engineering-mcp",
      capability_id: "mcp.invoke",
      public_models: [],
      mcp_tools: ["issues.search"],
    }],
  }
  const mcpInput = {
    ...input,
    requestProtocol: "MCP" as const,
    resourceId: "engineering-mcp",
    capabilityId: "mcp.invoke",
    requestedPublicModel: undefined,
    mcpMethod: "tools/call",
    mcpTool: "issues.search",
  }
  assert.equal(authorize(mcpBundle, mcpInput).disposition, "ALLOW")
  const listed = authorize(mcpBundle, { ...mcpInput, mcpMethod: "tools/list", mcpTool: undefined })
  assert.deepEqual(listed.allowedMcpTools, ["issues.search"])
  const initialized = authorize(mcpBundle, { ...mcpInput, mcpMethod: "initialize", mcpTool: undefined })
  assert.deepEqual(initialized.allowedMcpTools, ["issues.search"])
  assert.equal(authorize(mcpBundle, { ...mcpInput, mcpTool: "admin.hidden" }).reason, "NO_MATCHING_ENTITLEMENT")
})

test("authorization bundles require a known EdDSA signature", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "key-1" })).toString(
    "base64url",
  )
  const payload = Buffer.from(JSON.stringify(bundle)).toString("base64url")
  const signature = sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString(
    "base64url",
  )
  assert.deepEqual(
    verifyAuthorizationBundle(`${header}.${payload}.${signature}`, {
      schema_version: 1,
      keys: [
        {
          key_id: "key-1",
          public_key_pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
        },
      ],
    }),
    bundle,
  )
  assert.throws(
    () =>
      verifyAuthorizationBundle(`${header}.${payload}.invalid`, {
        schema_version: 1,
        keys: [
          {
            key_id: "key-1",
            public_key_pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
          },
        ],
      }),
    /signature is invalid/,
  )
})

type AuthorizationClient = {
  Check(
    request: Record<string, unknown>,
    callback: (error: grpc.ServiceError | null, response?: Record<string, any>) => void,
  ): void
  close(): void
}

async function startAuthorizationClient(
  bundleSource: { current: () => Promise<AuthorizationBundleSnapshot> },
  resolveMcpOAuthHeaders?: McpOAuthRequestHeaderResolver,
  usageStore?: UsageCounterStore,
  onUsageRejection?: (event: UsageRejectionObservation) => void,
  onRoutingRejection?: (event: RoutingRejectionObservation) => void,
  executionGrantConsumer?: ExecutionGrantConsumer,
  onDecision?: (event: AuthorizationDecisionEvent) => void,
): Promise<{ client: AuthorizationClient; stop: () => Promise<void> }> {
  const server = createExternalAuthorizerServer(
    bundleSource,
    onDecision,
    resolveMcpOAuthHeaders,
    usageStore,
    onUsageRejection,
    onRoutingRejection,
    executionGrantConsumer,
  )
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (error, boundPort) => (error ? reject(error) : resolve(boundPort)),
    )
  })
  const path = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "proto/external_auth_minimal.proto",
  )
  readFileSync(path)
  const definition = protoLoader.loadSync(path, {
    keepCase: true,
    longs: String,
    enums: Number,
    defaults: true,
    oneofs: true,
  })
  const descriptor = grpc.loadPackageDefinition(definition) as Record<string, any>
  const Client = descriptor.envoy.service.auth.v3.Authorization
  const client = new Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure()) as AuthorizationClient
  return {
    client,
    stop: async () => {
      client.close()
      await new Promise<void>((resolve) => server.tryShutdown(() => resolve()))
    },
  }
}

function checkRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attributes: {
      context_extensions: {
        tenant_id: input.tenantId,
        resource_id: input.resourceId,
        capability_id: input.capabilityId,
      },
      request: {
        http: {
          id: "untrusted-proto-id",
          headers: {
            ["x-request-id"]: input.correlationId,
            ["x-genio-correlation-id"]: "caller-correlation",
            ["x-genio-verified-subject"]: input.subjectId,
            ["x-genio-verified-client"]: input.actingClientId,
            ["x-genio-organization-role"]: "TENANT_ADMINISTRATOR",
          },
          body: JSON.stringify({ model: input.requestedPublicModel }),
        },
      },
    },
    ...overrides,
  }
}

function check(
  client: AuthorizationClient,
  request: Record<string, unknown>,
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    client.Check(request, (error, response) => {
      if (error) reject(error)
      else resolve(response ?? {})
    })
  })
}

test("Envoy gRPC ext_authz allows with trusted context and fixed decision headers", async () => {
  const originalNow = Date.now
  Date.now = () => now * 1000
  const { client, stop } = await startAuthorizationClient({
    async current() {
      return bundleSnapshot()
    },
  })
  try {
    const allowed = await check(client, checkRequest())
    assert.equal(allowed.status.code, grpc.status.OK)
    assert.ok(allowed.ok_response.headers.every((entry: any) =>
      fixedAllowResponseHeaders.includes(entry.header.key),
    ))
    assert.equal(
      allowed.ok_response.headers.find(
        (entry: any) => entry.header.key === "x-genio-allowed-public-models",
      ).header.value,
      "genio-standard",
    )
    const responseHeaders = new Map(
      allowed.ok_response.headers.map((entry: any) => [entry.header.key, entry.header.value]),
    )
    assert.equal(responseHeaders.get("x-genio-trusted-tenant-id"), input.tenantId)
    assert.equal(responseHeaders.get("x-genio-trusted-subject-id"), input.subjectId)
    assert.equal(responseHeaders.get("x-genio-trusted-client-id"), input.actingClientId)
    assert.equal(responseHeaders.get("x-genio-trusted-resource-id"), input.resourceId)
    assert.equal(responseHeaders.get("x-genio-trusted-capability-id"), input.capabilityId)
    assert.equal(responseHeaders.get("x-genio-trusted-correlation-id"), input.correlationId)
    assert.equal(responseHeaders.get("x-genio-correlation-id"), input.correlationId)
    assert.equal(responseHeaders.get("x-genio-trusted-release-id"), "release-7")
    assert.equal(responseHeaders.get("x-genio-trusted-release-gateway-id"), "ai-gateway")
    assert.equal(responseHeaders.get("x-genio-trusted-release-head-revision"), "7")
    assert.equal(
      responseHeaders.get("x-genio-trusted-release-package-digest"),
      "a".repeat(64),
    )
    assert.equal(responseHeaders.get("x-genio-trusted-release-projection-count"), "2")
    assert.ok(TRUSTED_RELEASE_HEADERS.every((header) => responseHeaders.has(header)))
    assert.equal(
      allowed.ok_response.headers.find(
        (entry: any) => entry.header.key === "x-genio-trusted-tenant-id",
      ).append_action,
      2,
    )
    assert.ok(
      TRUSTED_RELEASE_HEADERS.every(
        (header) =>
          allowed.ok_response.headers.find(
            (entry: any) => entry.header.key === header,
          )?.append_action === 2,
      ),
    )
    assert.ok(allowed.ok_response.headers_to_remove.includes("x-genio-tenant-id"))
    assert.ok(allowed.ok_response.headers_to_remove.includes("x-genio-verified-subject"))
    assert.ok(allowed.ok_response.headers_to_remove.includes("x-ai-eg-model"))
    assert.ok(allowed.ok_response.headers_to_remove.includes("x-genio-organization-role"))
    assert.ok(!allowed.ok_response.headers_to_remove.includes("x-genio-decision-id"))
    assert.ok(!allowed.ok_response.headers_to_remove.includes("x-genio-bundle-revision"))
    assert.ok(
      TRUSTED_RELEASE_HEADERS.every(
        (header) => !allowed.ok_response.headers_to_remove.includes(header),
      ),
    )
    assert.equal(allowed.denied_response, undefined)
  } finally {
    Date.now = originalNow
    await stop()
  }
})

test("an Agent Subject uses its own Entitlement in SELF authority mode", async () => {
  const originalNow = Date.now
  Date.now = () => now * 1000
  const agentBundle: CompiledAuthorizationBundle = {
    ...bundle,
    subject_contexts: [{ subject_id: input.subjectId, kind: "AGENT" }],
  }
  const { client, stop } = await startAuthorizationClient({
    async current() {
      return { bundle: agentBundle, releaseReference, routingArtifact }
    },
  })
  try {
    const allowed = await check(client, checkRequest())
    const headers = new Map(
      allowed.ok_response.headers.map((entry: any) => [entry.header.key, entry.header.value]),
    )
    assert.equal(allowed.status.code, grpc.status.OK)
    assert.equal(headers.get("x-genio-trusted-subject-kind"), "AGENT")
    assert.equal(headers.get("x-genio-trusted-authority-mode"), "SELF")
    assert.equal(agentBundle.rules[0]!.subject_ids.includes(input.subjectId), true)
    assert.equal("delegation" in agentBundle, false)
  } finally {
    Date.now = originalNow
    await stop()
  }
})

test("delegated Agent authority is the intersection of Principal, Agent, Delegation, and policy", async () => {
  const originalNow = Date.now
  Date.now = () => now * 1000
  let delegationState: "ACTIVE" | "REVOKED" = "ACTIVE"
  const decisionEvents: AuthorizationDecisionEvent[] = []
  const delegatedBundle = (): CompiledAuthorizationBundle => ({
    ...bundle,
    rules: [
      bundle.rules[0]!,
      { ...bundle.rules[0]!, rule_id: "principal-entitlement", subject_ids: ["person-principal"] },
    ],
    subject_contexts: [
      { subject_id: input.subjectId, kind: "AGENT" },
      { subject_id: "person-principal", kind: "PERSON" },
    ],
    agent_delegations: [{
      delegation_id: "delegation-1",
      revision: delegationState === "ACTIVE" ? 1 : 2,
      principal_subject_id: "person-principal",
      agent_subject_id: input.subjectId,
      resource_id: input.resourceId,
      capability_ids: [input.capabilityId],
      acting_client_ids: [input.actingClientId],
      starts_at: now - 10,
      expires_at: now + 100,
      revocation_generation: delegationState === "ACTIVE" ? 0 : 1,
      state: delegationState,
    }],
  })
  const { client, stop } = await startAuthorizationClient({
    async current() {
      return { bundle: delegatedBundle(), releaseReference, routingArtifact }
    },
  }, undefined, undefined, undefined, undefined, undefined, (event) => decisionEvents.push(event))
  const request = checkRequest({
    attributes: {
      context_extensions: {
        tenant_id: input.tenantId,
        resource_id: input.resourceId,
        capability_id: input.capabilityId,
      },
      request: {
        http: {
          headers: {
            "x-request-id": input.correlationId,
            "x-genio-verified-subject": input.subjectId,
            "x-genio-verified-client": input.actingClientId,
            "x-genio-on-behalf-of-subject-id": "person-principal",
          },
          body: JSON.stringify({ model: input.requestedPublicModel }),
        },
      },
    },
  })
  try {
    const allowed = await check(client, request)
    const headers = new Map(
      allowed.ok_response.headers.map((entry: any) => [entry.header.key, entry.header.value]),
    )
    assert.equal(allowed.status.code, grpc.status.OK)
    assert.equal(headers.get("x-genio-trusted-authority-mode"), "DELEGATED")
    assert.equal(headers.get("x-genio-trusted-principal-subject-id"), "person-principal")
    assert.equal(headers.get("x-genio-trusted-delegation-id"), "delegation-1")
    assert.equal(headers.get("x-genio-trusted-delegation-generation"), "0")

    delegationState = "REVOKED"
    const denied = await check(client, request)
    assert.equal(denied.denied_response.status.code, 403)
    assert.match(denied.denied_response.body, /DELEGATION_NOT_ALLOWED/)
    const revokedDecision = decisionEvents.find((event) => event.decision.reason === "DELEGATION_NOT_ALLOWED")
    assert.equal(revokedDecision?.input.delegationId, "delegation-1")
    assert.equal(revokedDecision?.input.delegationRevision, 2)
    assert.equal(revokedDecision?.input.delegationRevocationGeneration, 1)
    assert.equal(revokedDecision?.input.authorityMode, "DELEGATED")
  } finally {
    Date.now = originalNow
    await stop()
  }
})

test("A2A admission derives the acting chain from signed identity and ignores task authority claims", async () => {
  const originalNow = Date.now
  Date.now = () => now * 1000
  const a2aBundle: CompiledAuthorizationBundle = {
    ...bundle,
    subject_contexts: [
      { subject_id: input.subjectId, kind: "AGENT" },
      { subject_id: "agent-target", kind: "AGENT" },
    ],
  }
  const { client, stop } = await startAuthorizationClient({
    async current() {
      return { bundle: a2aBundle, releaseReference, routingArtifact }
    },
  })
  const request = checkRequest({
    attributes: {
      context_extensions: {
        tenant_id: input.tenantId,
        resource_id: input.resourceId,
        capability_id: input.capabilityId,
        request_protocol: "A2A",
        a2a_operation: "SEND_MESSAGE",
        target_agent_subject_id: "agent-target",
      },
      request: {
        http: {
          headers: {
            "x-request-id": input.correlationId,
            "x-genio-verified-subject": input.subjectId,
            "x-genio-verified-client": input.actingClientId,
          },
          body: JSON.stringify({
            message: { messageId: "message-1", role: "ROLE_USER", parts: [] },
            metadata: {
              authority_mode: "DELEGATED",
              principal_subject_id: "person-attacker",
              acting_chain: ["person-attacker", "agent-target"],
            },
          }),
        },
      },
    },
  })
  try {
    const allowed = await check(client, request)
    const headers = new Map(
      allowed.ok_response.headers.map((entry: any) => [entry.header.key, entry.header.value]),
    )
    assert.equal(allowed.status.code, grpc.status.OK)
    assert.equal(headers.get("x-genio-trusted-authority-mode"), "SELF")
    assert.equal(headers.has("x-genio-trusted-principal-subject-id"), false)
    assert.deepEqual(JSON.parse(String(headers.get("x-genio-trusted-agent-acting-chain"))), {
      authority_mode: "SELF",
      calling_agent_subject_id: input.subjectId,
      target_agent_subject_id: "agent-target",
    })

    const missingTarget: any = structuredClone(request)
    missingTarget.attributes.context_extensions.target_agent_subject_id = "agent-unknown"
    const denied = await check(client, missingTarget)
    assert.equal(denied.denied_response.status.code, 403)
    assert.match(denied.denied_response.body, /NO_MATCHING_ENTITLEMENT/)
  } finally {
    Date.now = originalNow
    await stop()
  }
})

test("a required Execution Grant is bound to one action digest and consumed once", async () => {
  const originalNow = Date.now
  Date.now = () => now * 1000
  const body = JSON.stringify({ model: input.requestedPublicModel })
  const actionDigest = executionActionDigest({ method: "POST", path: "/v1/chat/completions", body })
  const canonicalAgentSubjectId = "agent-canonical"
  const grantBundle: CompiledAuthorizationBundle = {
    ...bundle,
    rules: bundle.rules.map((rule) => ({
      ...rule,
      subject_ids: [canonicalAgentSubjectId, input.subjectId],
    })),
    execution_grants: [{
      execution_grant_id: "execution-grant-1",
      subject_id: canonicalAgentSubjectId,
      acting_client_id: input.actingClientId,
      resource_id: input.resourceId,
      capability_id: input.capabilityId,
      action_digest: actionDigest,
      issued_at: now - 5,
      expires_at: now + 60,
      issued_by_subject_id: "person-approver",
    }],
  }
  const guardedRouting: GatewayRoutingArtifact = {
    ...pricedRoutingArtifact,
    scopes: pricedRoutingArtifact.scopes.map((scope) => ({
      ...scope,
      required_obligation_kinds: ["execution.confirmation"],
      candidates: scope.candidates.map((candidate) => ({
        ...candidate,
        mappings: candidate.mappings.map((mapping) => ({ ...mapping, supported_obligations: ["execution.confirmation"], health_observed_at: now, health_source_revision: 1 })),
      })),
    })),
  }
  const consumed = new Map<string, string>()
  const consumer: ExecutionGrantConsumer = {
    async consume(value) {
      const previous = consumed.get(value.execution_grant_id)
      if (previous && previous !== value.correlation_id) return "ALREADY_CONSUMED"
      consumed.set(value.execution_grant_id, value.correlation_id)
      return "CONSUMED"
    },
  }
  const request = (correlationId: string, grantId?: string, requestBody = body) => checkRequest({
    attributes: {
      context_extensions: { tenant_id: input.tenantId, resource_id: input.resourceId, capability_id: input.capabilityId },
      request: { http: { method: "POST", path: "/v1/chat/completions", headers: { "x-request-id": correlationId, "x-genio-verified-subject": input.subjectId, "x-genio-verified-client": input.actingClientId, ...(grantId ? { "x-genio-execution-grant-id": grantId } : {}) }, body: requestBody } },
    },
  })
  const unavailableRouting: GatewayRoutingArtifact = {
    ...guardedRouting,
    scopes: guardedRouting.scopes.map((scope) => ({
      ...scope,
      candidates: scope.candidates.map((candidate) => ({ ...candidate, mappings: [] })),
    })),
  }
  const unavailable = await startAuthorizationClient({
    async current() { return { bundle: grantBundle, releaseReference, routingArtifact: unavailableRouting } },
  }, undefined, undefined, undefined, undefined, consumer)
  try {
    const rejected = await check(unavailable.client, request("correlation-no-route", "execution-grant-1"))
    assert.equal(rejected.denied_response.status.code, 503)
    assert.match(rejected.denied_response.body, /NO_HEALTHY_CONNECTION/)
    assert.equal(consumed.size, 0)
  } finally {
    await unavailable.stop()
  }
  const { client, stop } = await startAuthorizationClient({
    async current() { return { bundle: grantBundle, releaseReference, routingArtifact: guardedRouting } },
  }, undefined, undefined, undefined, undefined, consumer)
  try {
    const missing = await check(client, request("correlation-missing"))
    assert.equal(missing.denied_response.status.code, 403)
    assert.match(missing.denied_response.body, /EXECUTION_GRANT_REQUIRED/)
    const wrongAction = await check(client, request("correlation-wrong", "execution-grant-1", JSON.stringify({ model: input.requestedPublicModel, amount: 2 })))
    assert.match(wrongAction.denied_response.body, /EXECUTION_GRANT_INVALID/)
    const admitted = await check(client, request("correlation-admitted", "execution-grant-1"))
    assert.equal(admitted.status.code, grpc.status.OK, JSON.stringify(admitted))
    assert.equal(admitted.ok_response.headers.find((entry: any) => entry.header.key === "x-genio-trusted-execution-grant-id")?.header.value, "execution-grant-1")
    const reused = await check(client, request("correlation-reused", "execution-grant-1"))
    assert.match(reused.denied_response.body, /EXECUTION_GRANT_INVALID/)
  } finally {
    Date.now = originalNow
    await stop()
  }
})

test("Envoy gRPC ext_authz validates Usage Context and separates usage rejection from entitlement", async () => {
  const originalNow = Date.now
  Date.now = () => now * 1000
  let reject = false
  let currentRoutingArtifact = pricedRoutingArtifact
  let admittedPolicies: Parameters<UsageCounterStore["admitBatch"]>[0]["policies"] = []
  const usageRejections: UsageRejectionObservation[] = []
  const usageStore: UsageCounterStore = {
    async admitBatch(value) {
      admittedPolicies = value.policies
      return reject
        ? { admitted: false, policy_index: 0, reason: "QUOTA_EXHAUSTED" }
        : { admitted: true, concurrency_lease_ids: [] }
    },
    async releaseConcurrency() {},
    async settleCurrency() {},
  }
  const governedBundle: CompiledAuthorizationBundle = {
    ...bundle,
    usage_policies: [{
      usage_policy_id: "usage-policy-1",
      revision: 3,
      accounting_key_id: "accounting-shared",
      selectors: { resource_id: input.resourceId, capability_id: input.capabilityId },
      limits: {
        request_quota: { limit: 10, window_seconds: 60 },
        currency_budget: {
          allocation_id: "currency-september",
          window_seconds: 2_592_000,
          currency: "USD",
          limit_micros: 1_000_000,
        },
      },
    }],
    usage_contexts: [{
      subject_id: input.subjectId,
      consumer_organization_id: "org-consumer",
      use_case_id: "use-case-support",
      risk_level: "HIGH",
    }],
    resource_owners: [{
      resource_id: input.resourceId,
      organization_id: "org-resource-owner",
    }],
  }
  const { client, stop } = await startAuthorizationClient({
    async current() {
      return { bundle: governedBundle, releaseReference, routingArtifact: currentRoutingArtifact }
    },
  }, undefined, usageStore, (event) => usageRejections.push(event))
  const request = checkRequest({
    attributes: {
      context_extensions: {
        tenant_id: input.tenantId,
        resource_id: input.resourceId,
        capability_id: input.capabilityId,
      },
      request: {
        http: {
          headers: {
            "x-request-id": input.correlationId,
            "x-genio-verified-subject": input.subjectId,
            "x-genio-verified-client": input.actingClientId,
            "x-genio-organization-id": "org-consumer",
            "x-genio-use-case-id": "use-case-support",
          },
          body: JSON.stringify({ model: input.requestedPublicModel }),
        },
      },
    },
  })
  try {
    const allowed = await check(client, request)
    assert.equal(allowed.status.code, grpc.status.OK)
    const allowedHeaders = new Map(
      allowed.ok_response.headers.map((entry: any) => [entry.header.key, entry.header.value]),
    )
    assert.equal(allowedHeaders.get("x-genio-trusted-consumer-organization-id"), "org-consumer")
    assert.equal(allowedHeaders.get("x-genio-trusted-use-case-id"), "use-case-support")
    assert.equal(allowedHeaders.get("x-genio-trusted-risk-level"), "HIGH")
    assert.ok(allowedHeaders.has("x-genio-usage-admission-id"))
    assert.equal(allowedHeaders.get("x-genio-usage-accounting-keys"), '["accounting-shared"]')
    assert.equal(admittedPolicies[0]?.currency_budget?.reserve_micros, 0)
    assert.match(String(allowedHeaders.get("x-genio-usage-currency-allocations")), /currency-september/)

    currentRoutingArtifact = routingArtifact
    const unpriced = await check(client, request)
    assert.equal(unpriced.status.code, grpc.status.RESOURCE_EXHAUSTED)
    assert.equal(unpriced.denied_response.status.code, 429)
    assert.match(unpriced.denied_response.body, /UNPRICED_USAGE/)

    currentRoutingArtifact = pricedRoutingArtifact
    reject = true
    const denied = await check(client, request)
    assert.equal(denied.status.code, grpc.status.RESOURCE_EXHAUSTED)
    assert.equal(denied.denied_response.status.code, 429)
    assert.deepEqual(JSON.parse(denied.denied_response.body), { code: "QUOTA_EXHAUSTED" })
    assert.equal(usageRejections.at(-1)?.reason, "QUOTA_EXHAUSTED")
    assert.equal(usageRejections.at(-1)?.authorizationDecision.disposition, "ALLOW")
    assert.equal(usageRejections.at(-1)?.statusCode, 429)

    const missingContext = await check(client, checkRequest())
    assert.equal(missingContext.denied_response.status.code, 403)
    assert.match(missingContext.denied_response.body, /USAGE_CONTEXT_REQUIRED/)
  } finally {
    Date.now = originalNow
    await stop()
  }
})

test("managed Use Case risk emits only the obligations required by the narrowed route", async () => {
  const originalNow = Date.now
  Date.now = () => now * 1000
  const candidates: GatewayRoutingArtifact["scopes"][number]["candidates"] = [{
    order: 1,
    public_model_id: "model-standard",
    public_model_name: "genio-standard",
    mappings: [{
      order: 1,
      mapping_id: "mapping-primary",
      resource_id: "corporate-gpt",
      connection_id: "connection-primary",
      provider_model: "model-primary",
      mapping_revision: 1,
      supported_obligations: ["audit"],
    }, {
      order: 2,
      mapping_id: "mapping-controlled",
      resource_id: "corporate-gpt",
      connection_id: "connection-controlled",
      provider_model: "model-controlled",
      mapping_revision: 1,
      supported_obligations: ["audit", "dlp"],
    }],
  }]
  const contextualArtifact: GatewayRoutingArtifact = {
    ...routingArtifact,
    scopes: [{
      owner_organization_id: "org-resource-owner",
      resource_id: "corporate-gpt",
      capability_id: "chat",
      routing_policy_id: "routing-chat",
      routing_revision: 2,
      one_policy_revision: 1,
      route_mode: "DETERMINISTIC",
      default_public_model_id: "model-standard",
      candidate_set_digest: gatewayRoutingCandidateSetDigest(candidates),
      context_requirements: [{
        consumer_organization_id: "org-consumer",
        use_case_id: "use-case-support",
        minimum_risk_level: "HIGH",
        required_obligation_kinds: ["dlp"],
      }],
      candidates,
    }],
  }
  const contextualBundle: CompiledAuthorizationBundle = {
    ...bundle,
    usage_contexts: [{
      subject_id: input.subjectId,
      consumer_organization_id: "org-consumer",
      use_case_id: "use-case-support",
      risk_level: "HIGH",
    }, {
      subject_id: input.subjectId,
      consumer_organization_id: "org-consumer",
      use_case_id: "use-case-internal",
      risk_level: "LOW",
    }],
  }
  const { client, stop } = await startAuthorizationClient({
    async current() {
      return { bundle: contextualBundle, releaseReference, routingArtifact: contextualArtifact }
    },
  })
  const requestFor = (useCaseId: string) => checkRequest({
    attributes: {
      context_extensions: {
        tenant_id: input.tenantId,
        resource_id: input.resourceId,
        capability_id: input.capabilityId,
      },
      request: {
        http: {
          headers: {
            "x-request-id": input.correlationId,
            "x-genio-verified-subject": input.subjectId,
            "x-genio-verified-client": input.actingClientId,
            "x-genio-organization-id": "org-consumer",
            "x-genio-use-case-id": useCaseId,
          },
          body: JSON.stringify({ model: input.requestedPublicModel }),
        },
      },
    },
  })
  try {
    const highRisk = await check(client, requestFor("use-case-support"))
    const highRiskHeaders = new Map(
      highRisk.ok_response.headers.map((entry: any) => [entry.header.key, entry.header.value]),
    )
    assert.equal(highRiskHeaders.get("x-genio-trusted-risk-level"), "HIGH")
    assert.equal(highRiskHeaders.get("x-genio-trusted-required-obligations"), '["dlp"]')

    const lowRisk = await check(client, requestFor("use-case-internal"))
    const lowRiskHeaders = new Map(
      lowRisk.ok_response.headers.map((entry: any) => [entry.header.key, entry.header.value]),
    )
    assert.equal(lowRiskHeaders.get("x-genio-trusted-risk-level"), "LOW")
    assert.equal(lowRiskHeaders.has("x-genio-trusted-required-obligations"), false)
  } finally {
    Date.now = originalNow
    await stop()
  }
})

test("Envoy gRPC ext_authz denies an unentitled model", async () => {
  const originalNow = Date.now
  Date.now = () => now * 1000
  const { client, stop } = await startAuthorizationClient({
    async current() {
      return bundleSnapshot()
    },
  })
  try {
    const denied = await check(
      client,
      checkRequest({
        attributes: {
          context_extensions: {
            tenant_id: input.tenantId,
            resource_id: input.resourceId,
            capability_id: input.capabilityId,
          },
          request: {
            http: {
              headers: {
                "x-request-id": input.correlationId,
                "x-genio-verified-subject": input.subjectId,
                "x-genio-verified-client": input.actingClientId,
              },
              body: JSON.stringify({ model: "provider-secret-model" }),
            },
          },
        },
      }),
    )
    assert.equal(denied.status.code, grpc.status.PERMISSION_DENIED)
    assert.equal(denied.denied_response.status.code, 403)
    assert.match(denied.denied_response.body, /MODEL_NOT_ENTITLED/)
    assert.equal(denied.ok_response, undefined)
  } finally {
    Date.now = originalNow
    await stop()
  }
})

test("Envoy gRPC ext_authz fails closed when context is missing or spoofed", async () => {
  const originalNow = Date.now
  Date.now = () => now * 1000
  const { client, stop } = await startAuthorizationClient({
    async current() {
      return bundleSnapshot()
    },
  })
  try {
    const spoofed = await check(client, {
      attributes: {
        context_extensions: {},
        request: {
          http: {
            headers: {
              "x-request-id": input.correlationId,
              "x-genio-tenant-id": input.tenantId,
              "x-genio-subject-id": input.subjectId,
              "x-genio-acting-client-id": input.actingClientId,
              "x-genio-resource-id": input.resourceId,
              "x-genio-capability-id": input.capabilityId,
            },
          },
        },
      },
    })
    assert.equal(spoofed.status.code, grpc.status.UNAUTHENTICATED)
    assert.equal(spoofed.denied_response.status.code, 401)
    assert.match(spoofed.denied_response.body, /UNVERIFIED_IDENTITY_CONTEXT/)

    const reservedNamespace = await check(
      client,
      checkRequest({
        attributes: {
          context_extensions: {
            tenant_id: input.tenantId,
            resource_id: input.resourceId,
            capability_id: input.capabilityId,
          },
          request: {
            http: {
              headers: {
                "x-request-id": input.correlationId,
                "x-genio-verified-subject": input.subjectId,
                "x-genio-verified-client": input.actingClientId,
                "x-genio-trusted-subject-id": "attacker-subject",
              },
            },
          },
        },
      }),
    )
    assert.equal(reservedNamespace.status.code, grpc.status.UNAUTHENTICATED)
    assert.deepEqual(JSON.parse(reservedNamespace.denied_response.body), {
      code: "UNVERIFIED_IDENTITY_CONTEXT",
    })

    const wrongCallerHeader = await check(
      client,
      checkRequest({
        attributes: {
          context_extensions: {
            tenant_id: input.tenantId,
            resource_id: input.resourceId,
            capability_id: input.capabilityId,
          },
          request: {
            http: {
              headers: {
                "x-request-id": input.correlationId,
                "x-genio-subject-id": input.subjectId,
                "x-genio-acting-client-id": input.actingClientId,
                "x-genio-verified-subject": "different-subject",
                "x-genio-verified-client": input.actingClientId,
              },
              body: JSON.stringify({ model: input.requestedPublicModel }),
            },
          },
        },
      }),
    )
    assert.equal(wrongCallerHeader.status.code, grpc.status.PERMISSION_DENIED)
    assert.match(wrongCallerHeader.denied_response.body, /NO_MATCHING_ENTITLEMENT/)

    const spoofedModelHeader = await check(client, {
      attributes: {
        context_extensions: {
          tenant_id: input.tenantId,
          resource_id: input.resourceId,
          capability_id: input.capabilityId,
        },
        request: {
          http: {
            headers: {
              "x-request-id": input.correlationId,
              "x-genio-verified-subject": input.subjectId,
              "x-genio-verified-client": input.actingClientId,
              "x-ai-eg-model": input.requestedPublicModel,
            },
            body: JSON.stringify({ model: "provider-secret-model" }),
          },
        },
      },
    })
    assert.equal(spoofedModelHeader.status.code, grpc.status.UNAUTHENTICATED)

    const spoofedOAuthHeader = await check(client, {
      attributes: {
        context_extensions: {
          tenant_id: input.tenantId,
          resource_id: input.resourceId,
          capability_id: input.capabilityId,
          request_protocol: "MCP",
        },
        request: {
          http: {
            headers: {
              "x-request-id": input.correlationId,
              "x-genio-verified-subject": input.subjectId,
              "x-genio-verified-client": input.actingClientId,
              "x-genio-mcp-oauth-attacker": "Bearer attacker",
            },
            body: JSON.stringify({ method: "tools/list" }),
          },
        },
      },
    })
    assert.equal(spoofedOAuthHeader.status.code, grpc.status.UNAUTHENTICATED)
  } finally {
    Date.now = originalNow
    await stop()
  }
})

test("Envoy gRPC ext_authz returns the Subject MCP tool surface without an upstream discovery call", async () => {
  const originalNow = Date.now
  Date.now = () => now * 1000
  const { client, stop } = await startAuthorizationClient({ async current() { return bundleSnapshot() } })
  try {
    const response = await check(client, checkRequest({
      attributes: {
        context_extensions: {
          tenant_id: input.tenantId,
          resource_id: input.resourceId,
          capability_id: input.capabilityId,
          request_protocol: "MCP",
        },
        request: {
          http: {
            headers: {
              "x-request-id": input.correlationId,
              "x-genio-verified-subject": input.subjectId,
              "x-genio-verified-client": input.actingClientId,
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/list", params: {} }),
          },
        },
      },
    }))
    assert.equal(response.status.code, grpc.status.PERMISSION_DENIED)
    assert.equal(response.denied_response.status.code, 200)
    assert.deepEqual(JSON.parse(response.denied_response.body), {
      jsonrpc: "2.0",
      id: 42,
      result: {
        tools: [{
          name: "issues.search",
          description: "Published MCP tool",
          inputSchema: { type: "object", additionalProperties: true },
        }],
      },
    })
  } finally {
    Date.now = originalNow
    await stop()
  }
})

test("Envoy gRPC ext_authz authorizes authenticated MCP GET and DELETE transport lifecycle requests", async () => {
  const originalNow = Date.now
  Date.now = () => now * 1000
  const decisions: AuthorizationDecisionEvent[] = []
  const { client, stop } = await startAuthorizationClient(
    { async current() { return bundleSnapshot() } },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (event) => { decisions.push(event) },
  )
  try {
    for (const [method, expectedMcpMethod] of [["GET", "transport/get"], ["DELETE", "transport/delete"]] as const) {
      const response = await check(client, checkRequest({
        attributes: {
          context_extensions: {
            tenant_id: input.tenantId,
            resource_id: input.resourceId,
            capability_id: input.capabilityId,
            request_protocol: "MCP",
          },
          request: {
            http: {
              method,
              headers: {
                "x-request-id": `${input.correlationId}-${method.toLowerCase()}`,
                "x-genio-verified-subject": input.subjectId,
                "x-genio-verified-client": input.actingClientId,
              },
            },
          },
        },
      }))
      assert.equal(response.status.code, grpc.status.OK)
      assert.equal(decisions.at(-1)?.input.mcpMethod, expectedMcpMethod)
      assert.equal(decisions.at(-1)?.decision.reason, "ALLOWED_BY_RULE")
    }
  } finally {
    Date.now = originalNow
    await stop()
  }
})

test("Envoy gRPC ext_authz injects MCP OAuth headers and fails closed when resolution fails", async () => {
  const originalNow = Date.now
  Date.now = () => now * 1000
  const request = checkRequest({
    attributes: {
      context_extensions: {
        tenant_id: input.tenantId,
        resource_id: input.resourceId,
        capability_id: input.capabilityId,
        request_protocol: "MCP",
      },
      request: {
        http: {
          headers: {
            "x-request-id": input.correlationId,
            "x-genio-verified-subject": input.subjectId,
            "x-genio-verified-client": input.actingClientId,
          },
          body: JSON.stringify({ method: "tools/call", params: { name: "issues.search", arguments: {} } }),
        },
      },
    },
  })
  const successful = await startAuthorizationClient(
    { async current() { return bundleSnapshot() } },
    async (authorization) => {
      assert.equal(authorization.subjectId, input.subjectId)
      assert.equal(authorization.resourceId, input.resourceId)
      return [{ name: "x-genio-mcp-oauth-connection", value: "Bearer bound-token" }]
    },
  )
  try {
    const allowed = await check(successful.client, request)
    assert.equal(allowed.status.code, grpc.status.OK)
    const injected = allowed.ok_response.headers.find(
      (entry: any) => entry.header.key === "x-genio-mcp-oauth-connection",
    )
    assert.equal(injected.header.value, "Bearer bound-token")
    assert.equal(injected.append_action, 2)
  } finally {
    await successful.stop()
  }

  const unavailable = await startAuthorizationClient(
    { async current() { return bundleSnapshot() } },
    async () => { throw new Error("binding unavailable") },
  )
  try {
    const denied = await check(unavailable.client, request)
    assert.equal(denied.status.code, grpc.status.UNAVAILABLE)
    assert.equal(denied.denied_response.status.code, 503)
    assert.match(denied.denied_response.body, /MCP_OAUTH_CREDENTIAL_UNAVAILABLE/)
  } finally {
    Date.now = originalNow
    await unavailable.stop()
  }
})

test("Envoy gRPC ext_authz rejects an admitted route with zero healthy Connections before upstream", async () => {
  const originalNow = Date.now
  Date.now = () => now * 1000
  const candidates: GatewayRoutingArtifact["scopes"][number]["candidates"] = [{
    order: 1,
    public_model_id: "model-standard",
    public_model_name: "genio-standard",
    mappings: [],
  }]
  const unavailableArtifact: GatewayRoutingArtifact = {
    ...routingArtifact,
    scopes: [{
      owner_organization_id: "org-resource-owner",
      resource_id: "corporate-gpt",
      capability_id: "chat",
      routing_policy_id: "routing-chat",
      routing_revision: 8,
      one_policy_revision: 4,
      route_mode: "DETERMINISTIC",
      default_public_model_id: "model-standard",
      candidate_set_digest: gatewayRoutingCandidateSetDigest(candidates),
      retry_policy: {
        per_priority_max_attempts: 1,
        max_attempts: 0,
        retry_on: ["CONNECT_FAILURE", "RESET_BEFORE_RESPONSE"],
        http_5xx: "IDEMPOTENT_ONLY",
        streaming: "BEFORE_FIRST_TOKEN_ONLY",
      },
      candidates,
    }],
  }
  let observation: RoutingRejectionObservation | undefined
  const { client, stop } = await startAuthorizationClient(
    { async current() {
      return { bundle, releaseReference, routingArtifact: unavailableArtifact }
    } },
    undefined,
    undefined,
    undefined,
    (event) => { observation = event },
  )
  try {
    const denied = await check(client, checkRequest())
    assert.equal(denied.status.code, grpc.status.UNAVAILABLE)
    assert.equal(denied.denied_response.status.code, 503)
    assert.match(denied.denied_response.body, /NO_HEALTHY_CONNECTION/)
    assert.equal(observation?.authorizationDecision.disposition, "ALLOW")
    assert.equal(observation?.routing.routing_revision, 8)
    assert.deepEqual(observation?.routing.candidate_connection_ids, [])
  } finally {
    Date.now = originalNow
    await stop()
  }
})

test("Envoy gRPC ext_authz fails closed when the signed bundle is unavailable", async () => {
  const originalNow = Date.now
  Date.now = () => now * 1000
  const { client, stop } = await startAuthorizationClient({
    async current() {
      throw new Error("offline")
    },
  })
  try {
    const failed = await check(client, checkRequest())
    assert.equal(failed.status.code, grpc.status.UNAVAILABLE)
    assert.equal(failed.denied_response.status.code, 503)
    assert.match(failed.denied_response.body, /POLICY_BUNDLE_UNAVAILABLE/)
  } finally {
    Date.now = originalNow
    await stop()
  }
})


test("audio transcription authorization checks multipart model and rejects conflicting model fields", async () => {
  const originalNow = Date.now
  Date.now = () => now * 1000
  const { client, stop } = await startAuthorizationClient({ async current() { return bundleSnapshot() } })
  try {
    for (const [models, expected] of [[['genio-standard'], grpc.status.OK], [['unentitled'], grpc.status.PERMISSION_DENIED], [['genio-standard', 'unentitled'], grpc.status.PERMISSION_DENIED]] as const) {
      const form = new FormData()
      for (const model of models) form.append("model", model)
      form.append("file", new Blob([new Uint8Array([0, 255, 128])]), "recording.webm")
      const multipart = new Response(form)
      const request = checkRequest() as any
      request.attributes.request.http.headers["content-type"] = multipart.headers.get("content-type")
      request.attributes.request.http.path = "/v1/audio/transcriptions"
      request.attributes.request.http.body = ""
      request.attributes.request.http.raw_body = Buffer.from(await multipart.arrayBuffer())
      const response = await check(client, request)
      assert.equal(response.status.code === grpc.status.OK, expected === grpc.status.OK)
      request.attributes.request.http.body = Buffer.from(request.attributes.request.http.raw_body).toString("utf8")
      request.attributes.request.http.raw_body = Buffer.alloc(0)
      const stringBodyResponse = await check(client, request)
      assert.equal(stringBodyResponse.status.code === grpc.status.OK, expected === grpc.status.OK)
    }
  } finally { Date.now = originalNow; await stop() }
})
