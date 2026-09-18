import assert from "node:assert/strict"
import test from "node:test"

import type { ConnectionRegistration } from "../src/capabilities/connections/contract"
import { prepareDemoLlm, type DemoLlmProvisioningModules } from "../src/capabilities/demo-project/llm-provisioning"
import type { ResourceRegistration } from "../src/capabilities/resources/contract"

const tenantId = "tenant-demo"
const resourceId = "genio.demo.gemini"
const connectionId = "genio.demo.gemini"

function resource(overrides: Partial<ResourceRegistration> = {}): ResourceRegistration {
  return {
    tenant_id: tenantId,
    resource_id: resourceId,
    display_name: "Google Gemini",
    kind: "LLM",
    owner_organization_id: "organization-demo",
    authentication_strategy: "NONE",
    environment_id: "ce-starter",
    version: "1.0.0",
    lifecycle: "DRAFT",
    publication_endpoint: null,
    publication_request: null,
    operational_state: "UNKNOWN",
    capabilities: [{ capability_id: "model.invoke", display_name: "Gemini 3.8 Flash" }],
    mcp_authorization: null,
    api: null,
    extension_metadata: null,
    enforcement_point_id: "gateway-demo",
    created_at: 1,
    ...overrides,
  } as ResourceRegistration
}

function connection(overrides: Partial<ConnectionRegistration> = {}): ConnectionRegistration {
  return {
    tenant_id: tenantId,
    resource_id: resourceId,
    connection_id: connectionId,
    display_name: "Google Gemini OpenAI-compatible",
    connection_kind: "LLM",
    provider_type: "GENERIC_OPENAI_COMPATIBLE",
    provider_profile_id: "provider-generic-openai-compatible",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai",
    mcp_tool_namespace: null,
    mcp_selected_tools: [],
    mcp_tool_selection_operation_id: null,
    credential_ref: null,
    downstream_identity: { mode: "SERVICE", authentication: "PROVIDER_CREDENTIAL_PROFILE" },
    request_mapping: null,
    status: "READY",
    configuration_revision: 1,
    lifecycle: "DRAFT",
    revoke_requested_after_release_revision: null,
    verification_state: "VERIFIED",
    health_state: "HEALTHY",
    health_observed_at: 1,
    health_source_revision: 1,
    routing_priority: 0,
    region: null,
    supported_obligations: [],
    created_at: 1,
    ...overrides,
  } as ConnectionRegistration
}

function fixture(options: { connection?: ConnectionRegistration; resource?: ResourceRegistration } = {}) {
  let currentResource = options.resource ?? resource()
  let currentConnection = options.connection ?? connection()
  let model: { model_id: string; model_name: string; resource_id: string; visibility: "PUBLIC" } | null = null
  let mapping: { connection_id: string; provider_model: string } | null = null
  let routing: { mode: string; candidate_public_model_ids: string[]; default_public_model_id: string; session_lease_seconds: number | null } | null = null
  let hasChain = false
  const granted = new Set<string>()
  const calls = { enable: 0, model: 0, routing: 0, endpoint: 0, compile: 0, save: 0, review: 0, grant: 0 }
  const modules = {
    resources: {
      async getResource() { return currentResource },
      async setPublicationEndpoint(input: { value: ResourceRegistration["publication_endpoint"] }) {
        calls.endpoint += 1
        currentResource = { ...currentResource, publication_endpoint: input.value }
        return currentResource
      },
    },
    connections: {
      async get() { return currentConnection },
      async verify() { return currentConnection },
      async transitionLifecycle() {
        calls.enable += 1
        currentConnection = { ...currentConnection, lifecycle: "ENABLED", configuration_revision: currentConnection.configuration_revision + 1 }
        return currentConnection
      },
    },
    models: {
      async list() { return model ? [model] : [] },
      async listMappings() { return mapping ? [{ ...mapping }] : [] },
      async create() {
        calls.model += 1
        model = { model_id: "model-gemini", model_name: "gemini-3.8-flash", resource_id: resourceId, visibility: "PUBLIC" }
        mapping = { connection_id: connectionId, provider_model: "gemini-3.8-flash" }
        return model
      },
      async addMapping() { throw new Error("unexpected mapping") },
    },
    modelRoutingPolicies: {
      async getLatest() { return routing },
      async save(input: { value: { candidate_public_model_ids: string[]; default_public_model_id: string; mode: string; session_lease_seconds: number | null } }) {
        calls.routing += 1
        routing = input.value
        return input.value
      },
    },
    enforcementCompiler: {
      async compile() {
        calls.compile += 1
        return { tenant_id: tenantId, resource_id: resourceId, capability_id: "model.invoke", one_policy_revision: 7, chain_id: "chain", eligible_connection_ids: [connectionId], steps: [], request_filter_order: [], response_filter_order: [] }
      },
    },
    enforcementRevisions: {
      async getLatest() { return hasChain ? { one_policy_revision: 7 } : null },
      async save() { calls.save += 1; hasChain = true; return {} },
    },
    publicationWorkflow: {
      async requestReview() { return { request_id: "request-1" } },
      async review() { calls.review += 1; currentResource = { ...currentResource, lifecycle: "PUBLISHED" }; return currentResource },
    },
    entitlements: {
      async list() {
        return [...granted].map((capability_id) => ({ state: "ACTIVE", subject_id: "actor-demo", resource_id: resourceId, capability_id }))
      },
      async grant(input: { value: { capability_id: string } }) { calls.grant += 1; granted.add(input.value.capability_id); return {} },
    },
    gatewayRegistrations: { async list() { return [{ gateway_id: "gateway-demo", state: "ACTIVE" }] } },
    runtimeControl: { async listGatewayRuntimes() { return [{ target_id: "gateway-demo", status: "ACTIVE" }] } },
  } as unknown as DemoLlmProvisioningModules
  return { modules, calls, getResource: () => currentResource }
}

function input(modules: DemoLlmProvisioningModules) {
  return {
    tenantId,
    organizationId: "organization-demo",
    actorSubjectId: "actor-demo",
    resourceId,
    connectionId,
    modelName: "gemini-3.8-flash",
    modules,
    gatewayIdentity: { issuer: "https://identity.demo.test", audience: "genio-one", jwksUri: "https://identity.demo.test/jwks" },
    publicationTarget: { gatewayId: "gateway-demo", origin: "http://localhost:1975", dnsManagement: "EXTERNAL" as const, dnsTarget: null },
    initialOnePolicyRevision: 7,
  }
}

test("demo Gemini creates the Public Model, routing policy, enforcement chain, publication, and exact entitlement", async () => {
  const state = fixture()
  const prepared = await prepareDemoLlm(input(state.modules))
  assert.equal(prepared.stage, "READY")
  assert.equal(state.calls.enable, 1)
  assert.equal(state.calls.model, 1)
  assert.equal(state.calls.routing, 1)
  assert.equal(state.calls.endpoint, 1)
  assert.equal(state.calls.compile, 1)
  assert.equal(state.calls.save, 1)
  assert.equal(state.calls.review, 1)
  assert.equal(state.calls.grant, 1)
  assert.equal(state.getResource().publication_endpoint?.base_path, "/")

  const retried = await prepareDemoLlm(input(state.modules))
  assert.equal(retried.stage, "READY")
  assert.equal(state.calls.model, 1)
  assert.equal(state.calls.routing, 1)
  assert.equal(state.calls.endpoint, 1)
  assert.equal(state.calls.compile, 1)
  assert.equal(state.calls.review, 1)
  assert.equal(state.calls.grant, 1)
})

test("demo Gemini never re-enables a disabled connection", async () => {
  const state = fixture({ connection: connection({ lifecycle: "DISABLED" }) })
  const prepared = await prepareDemoLlm(input(state.modules))
  assert.equal(prepared.stage, "CONNECTION_DISABLED")
  assert.equal(state.calls.enable, 0)
  assert.equal(state.calls.model, 0)
})

test("demo Gemini requires a real base policy before changing the model route", async () => {
  const state = fixture()
  const prepared = await prepareDemoLlm({ ...input(state.modules), initialOnePolicyRevision: 0 })
  assert.equal(prepared.stage, "POLICY_PREREQUISITE")
  assert.equal(state.calls.enable, 0)
  assert.equal(state.calls.model, 0)
  assert.equal(state.calls.routing, 0)
  assert.equal(state.calls.endpoint, 0)
})

test("demo Gemini replaces only its legacy generated base path before publication", async () => {
  const state = fixture({
    resource: resource({
      publication_endpoint: {
        gateway_id: "gateway-demo",
        hostname: "localhost",
        base_path: "/models/genio.demo.gemini",
        visibility: "REQUEST",
        dns_management: "EXTERNAL",
        dns_verification: "VERIFIED",
        dns_target: null,
      },
    }),
  })
  const prepared = await prepareDemoLlm(input(state.modules))
  assert.equal(prepared.stage, "READY")
  assert.equal(state.getResource().publication_endpoint?.base_path, "/")
})

test("demo Gemini preserves a different draft publication endpoint", async () => {
  const state = fixture({
    resource: resource({
      publication_endpoint: {
        gateway_id: "gateway-demo",
        hostname: "localhost",
        base_path: "/managed-by-user",
        visibility: "REQUEST",
        dns_management: "EXTERNAL",
        dns_verification: "VERIFIED",
        dns_target: null,
      },
    }),
  })
  const prepared = await prepareDemoLlm(input(state.modules))
  assert.equal(prepared.stage, "PUBLICATION_PREREQUISITE")
  assert.equal(state.calls.endpoint, 0)
  assert.equal(state.getResource().publication_endpoint?.base_path, "/managed-by-user")
})
