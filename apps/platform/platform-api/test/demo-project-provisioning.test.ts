import assert from "node:assert/strict"
import test from "node:test"

import type { ConnectionRegistration } from "../src/capabilities/connections/contract"
import type { McpDiscoveryOperation } from "../src/capabilities/mcp-discovery/contract"
import type { ResourceRegistration } from "../src/capabilities/resources/contract"
import { prepareDemoMcp, type DemoMcpProvisioningModules } from "../src/capabilities/demo-project/provisioning"

const tenantId = "tenant-demo"
const resourceId = "genio.demo.archify"
const connectionId = "genio.demo.archify"

function resource(overrides: Partial<ResourceRegistration> = {}): ResourceRegistration {
  return {
    tenant_id: tenantId,
    resource_id: resourceId,
    display_name: "Archify",
    kind: "MCP",
    owner_organization_id: "organization-demo",
    authentication_strategy: "NONE",
    environment_id: "ce-starter",
    version: "1",
    lifecycle: "DRAFT",
    publication_endpoint: null,
    publication_request: null,
    operational_state: "UNKNOWN",
    capabilities: [{ capability_id: "archify", display_name: "Archify" }],
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
    display_name: "Archify",
    connection_kind: "MCP",
    provider_type: null,
    provider_profile_id: null,
    endpoint: "http://127.0.0.1:5193/mcp",
    mcp_tool_namespace: "archify",
    mcp_selected_tools: [],
    mcp_tool_selection_operation_id: null,
    credential_ref: "archify-token",
    downstream_identity: { mode: "SERVICE", authentication: "API_KEY" },
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

function discovery(state: McpDiscoveryOperation["state"], tools: readonly string[] = []): McpDiscoveryOperation {
  return {
    tenant_id: tenantId,
    operation_id: "discovery-1",
    gateway_id: "gateway-demo",
    resource_id: resourceId,
    connection_id: connectionId,
    requested_by_subject_id: "actor-demo",
    correlation_id: "demo",
    state,
    runtime_id: state === "SUCCEEDED" ? "runtime-demo" : null,
    endpoint: "http://127.0.0.1:5193/mcp",
    credential_ref: "archify-token",
    downstream_identity: { mode: "SERVICE", authentication: "API_KEY" },
    observation: state === "SUCCEEDED" ? { protocol_version: "2025-11-25", server_name: "archify", server_version: "1", tools: tools.map((name) => ({ name, title: null, description: null })) } : null,
    candidates: tools.map((tool) => ({ candidate_id: `candidate-${tool}`, capability_id: `mcp-tool-${tool}`, tool_name: tool, revision_digest: "a".repeat(64), state: "NEW" })),
    error_code: null,
    error_message: null,
    created_at: 1,
    claimed_at: null,
    completed_at: state === "SUCCEEDED" ? 2 : null,
    updated_at: 2,
  }
}

function fixture(options: { discovery?: McpDiscoveryOperation | null; connection?: ConnectionRegistration; resource?: ResourceRegistration; domain?: boolean } = {}) {
  let currentResource = options.resource ?? resource()
  let currentConnection = options.connection ?? connection()
  let currentDiscovery = options.discovery ?? null
  const granted = new Set<string>()
  const calls = { verify: 0, request: 0, decide: 0, enable: 0, endpoint: 0, compile: 0, save: 0, review: 0, grant: 0 }
  const domains = resource({
    resource_id: "existing-publication",
    lifecycle: "PUBLISHED",
    publication_endpoint: {
      gateway_id: "gateway-demo",
      hostname: "gateway.demo.test",
      base_path: "/existing",
      visibility: "REQUEST",
      dns_management: "EXTERNAL",
      dns_verification: "VERIFIED",
      dns_target: null,
    },
  })
  const modules = {
    resources: {
      async getResource() { return currentResource },
      async listResources() { return options.domain === false ? [currentResource] : [currentResource, domains] },
      async setPublicationEndpoint(input: { value: ResourceRegistration["publication_endpoint"] }) {
        calls.endpoint += 1
        currentResource = { ...currentResource, publication_endpoint: input.value }
        return currentResource
      },
    },
    connections: {
      async get() { return currentConnection },
      async verify() { calls.verify += 1; return currentConnection },
      async transitionLifecycle() {
        calls.enable += 1
        currentConnection = { ...currentConnection, lifecycle: "ENABLED", configuration_revision: currentConnection.configuration_revision + 1 }
        return currentConnection
      },
    },
    mcpDiscovery: {
      async latest() { return currentDiscovery },
      async request() { calls.request += 1; currentDiscovery = discovery("PENDING"); return currentDiscovery },
      async decideCandidate(input: { candidateId: string }) {
        calls.decide += 1
        if (currentDiscovery) currentDiscovery = { ...currentDiscovery, candidates: currentDiscovery.candidates.map((candidate) => candidate.candidate_id === input.candidateId ? { ...candidate, state: "PUBLISHED" } : candidate) }
        return currentDiscovery!
      },
    },
    enforcementCompiler: {
      async compile() { calls.compile += 1; return { tenant_id: tenantId, resource_id: resourceId, capability_id: "archify", one_policy_revision: 1, chain_id: "chain", eligible_connection_ids: [connectionId], steps: [], request_filter_order: [], response_filter_order: [] } },
    },
    enforcementRevisions: {
      async getLatest() { return null },
      async save() { calls.save += 1; return {} },
    },
    publicationWorkflow: {
      async requestReview() { return { request_id: "request-1" } },
      async review() { calls.review += 1; currentResource = { ...currentResource, lifecycle: "PUBLISHED" }; return currentResource },
    },
    entitlements: {
      async list() {
        return [...granted].map((capability_id) => ({
          state: "ACTIVE",
          subject_id: "actor-demo",
          resource_id: resourceId,
          capability_id,
        }))
      },
      async grant(input: { value: { capability_id: string } }) { calls.grant += 1; granted.add(input.value.capability_id); return {} },
    },
    gatewayRegistrations: {
      async list() { return [{ gateway_id: "gateway-demo", state: "ACTIVE" }] },
    },
    runtimeControl: {
      async listGatewayRuntimes() { return [{ target_id: "gateway-demo", status: "ACTIVE" }] },
    },
  } as unknown as DemoMcpProvisioningModules
  return { modules, calls, getResource: () => currentResource, getConnection: () => currentConnection }
}

function input(modules: DemoMcpProvisioningModules, options: { target?: boolean; policyRevision?: number; basePath?: string } = {}) {
  return {
    tenantId,
    organizationId: "organization-demo",
    actorSubjectId: "actor-demo",
    resourceId,
    connectionId,
    requiredToolNames: ["archify_schema", "archify_render"],
    modules,
    gatewayIdentity: { issuer: "https://identity.demo.test", audience: "genio-one", jwksUri: "https://identity.demo.test/jwks" },
    ...(options.target === false ? {} : { publicationTarget: { gatewayId: "gateway-demo", origin: "http://localhost:1975", basePath: options.basePath ?? "/mcp/genio.demo.archify", dnsManagement: "EXTERNAL" as const, dnsTarget: null } }),
    initialOnePolicyRevision: options.policyRevision ?? 7,
  }
}

test("demo MCP requests real discovery and leaves publication untouched until the runtime returns tools", async () => {
  const state = fixture()
  const prepared = await prepareDemoMcp(input(state.modules))
  assert.equal(prepared.stage, "DISCOVERY_PENDING")
  assert.equal(state.calls.request, 1)
  assert.equal(state.calls.endpoint, 0)
  assert.equal(state.calls.review, 0)
})

test("demo MCP requires a verified Gateway domain when no deployment origin is configured", async () => {
  const state = fixture({ domain: false })
  const prepared = await prepareDemoMcp(input(state.modules, { target: false }))
  assert.equal(prepared.stage, "GATEWAY_PREREQUISITE")
  assert.equal(state.calls.request, 0)
  assert.equal(state.calls.endpoint, 0)
})

test("demo MCP requires a real policy revision before it changes a connection or endpoint", async () => {
  const state = fixture({ discovery: discovery("SUCCEEDED", ["archify_schema", "archify_render"]) })
  const prepared = await prepareDemoMcp(input(state.modules, { policyRevision: 0 }))
  assert.equal(prepared.stage, "POLICY_PREREQUISITE")
  assert.equal(state.calls.decide, 0)
  assert.equal(state.calls.enable, 0)
  assert.equal(state.calls.endpoint, 0)
})

test("configured Gateway origin lets the first demo MCP select observed tools, publish through review, and grant exact capabilities", async () => {
  const state = fixture({ discovery: discovery("SUCCEEDED", ["archify_schema", "archify_render"]), domain: false })
  const prepared = await prepareDemoMcp(input(state.modules))
  assert.equal(prepared.stage, "READY")
  assert.equal(state.calls.decide, 2)
  assert.equal(state.calls.enable, 1)
  assert.equal(state.calls.endpoint, 1)
  assert.equal(state.calls.compile, 1)
  assert.equal(state.calls.save, 1)
  assert.equal(state.calls.review, 1)
  assert.equal(state.calls.grant, 2)
  assert.equal(state.getResource().lifecycle, "PUBLISHED")
  assert.equal(state.getResource().publication_endpoint?.base_path, "/mcp/genio.demo.archify")
  assert.equal(state.getConnection().lifecycle, "ENABLED")

  const retried = await prepareDemoMcp(input(state.modules))
  assert.equal(retried.stage, "READY")
  assert.equal(state.calls.enable, 1)
  assert.equal(state.calls.endpoint, 1)
  assert.equal(state.calls.review, 1)
  assert.equal(state.calls.grant, 2)
})

test("demo MCP uses its configured Streamable HTTP path", async () => {
  const state = fixture({ discovery: discovery("SUCCEEDED", ["archify_schema", "archify_render"]), domain: false })
  const prepared = await prepareDemoMcp(input(state.modules, { basePath: "/native" }))
  assert.equal(prepared.stage, "READY")
  assert.equal(state.getResource().publication_endpoint?.base_path, "/native")
})

test("demo MCP replaces only its legacy generated base path before publication", async () => {
  const state = fixture({
    discovery: discovery("SUCCEEDED", ["archify_schema", "archify_render"]),
    domain: false,
    resource: resource({
      publication_endpoint: {
        gateway_id: "gateway-demo",
        hostname: "localhost",
        base_path: "/mcp/genio.demo.archify",
        visibility: "REQUEST",
        dns_management: "EXTERNAL",
        dns_verification: "VERIFIED",
        dns_target: null,
      },
    }),
  })
  const prepared = await prepareDemoMcp(input(state.modules))
  assert.equal(prepared.stage, "READY")
  assert.equal(state.getResource().publication_endpoint?.base_path, "/mcp/genio.demo.archify")
})

test("demo MCP preserves a different draft publication endpoint", async () => {
  const state = fixture({
    discovery: discovery("SUCCEEDED", ["archify_schema", "archify_render"]),
    domain: false,
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
  const prepared = await prepareDemoMcp(input(state.modules))
  assert.equal(prepared.stage, "PUBLICATION_PREREQUISITE")
  assert.equal(state.calls.endpoint, 0)
  assert.equal(state.getResource().publication_endpoint?.base_path, "/managed-by-user")
})

test("demo MCP keeps an explicitly disabled connection disabled", async () => {
  const state = fixture({ connection: connection({ lifecycle: "DISABLED" }) })
  const prepared = await prepareDemoMcp(input(state.modules))
  assert.equal(prepared.stage, "CONNECTION_DISABLED")
  assert.equal(state.calls.verify, 0)
  assert.equal(state.calls.request, 0)
  assert.equal(state.calls.enable, 0)
})
