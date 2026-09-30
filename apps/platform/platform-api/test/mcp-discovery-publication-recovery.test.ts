import assert from "node:assert/strict"
import test from "node:test"

import { PlatformApiError } from "../src/capabilities/errors"
import type { ConnectionRegistration } from "../src/capabilities/connections/contract"
import type { ResourceConnectionRegistry } from "../src/capabilities/connections/module"
import { createInMemoryMcpDiscoveryStore } from "../src/capabilities/mcp-discovery/memory"
import { createPostgresMcpDiscoveryStore } from "../src/capabilities/mcp-discovery/postgres"
import { createInMemoryPublicationWorkflowStore } from "../src/capabilities/publications/memory"
import type { ResourceRegistration } from "../src/capabilities/resources/contract"
import type { ResourceRegistry } from "../src/capabilities/resources/module"
import { createResourceMemoryState } from "../src/capabilities/resources/state"
import type { SqlAdapter, SqlQueryResult, SqlTransaction } from "../src/persistence/sql-adapter"

const tenantId = "tenant-keycloak-local"
const resourceId = "resource-mcp-local"
const connectionId = "connection-mcp-local"

function fixture() {
  const state = createResourceMemoryState()
  const resource = {
    tenant_id: tenantId,
    resource_id: resourceId,
    display_name: "Local MCP",
    documentation: "",
    kind: "MCP",
    owner_organization_id: "org-platform",
    authentication_strategy: "API_KEY",
    environment_id: "local",
    version: "1.0.0",
    lifecycle: "DRAFT",
    operational_state: "ACTIVE",
    capabilities: [],
    api: null,
    extension_metadata: null,
    enforcement_point_id: "genio-ai-mcp-gateway",
    builtin_service: null,
    installation_owned: false,
    service_kind: null,
    publication_endpoint: { gateway_id: "genio-ai-mcp-gateway", hostname: "mcp.local.test", base_path: "/mcp", visibility: "PRIVATE", dns_management: "EXTERNAL", dns_verification: "VERIFIED", dns_target: null },
    publication_request: { request_id: "publication-1", state: "PENDING", requested_by: "person-platform-admin", requested_at: 1, reviewed_by: "person-platform-admin", reviewed_at: 2, publication_state: "PENDING_REVIEW", attempt_id: null, failure_code: null },
    created_at: 1,
  } as unknown as ResourceRegistration
  const connection = {
    tenant_id: tenantId,
    resource_id: resourceId,
    connection_id: connectionId,
    connection_kind: "MCP",
    endpoint: "http://127.0.0.1:19003/mcp",
    credential_ref: "mcp-key",
    downstream_identity: { mode: "SERVICE", authentication: "API_KEY" },
    mcp_selected_tools: [],
    mcp_tool_selection_operation_id: null,
    mcp_tool_reviews: [],
    configuration_revision: 1,
  } as unknown as ConnectionRegistration
  state.resources.set(`${tenantId}:${resourceId}`, resource)
  state.connections.set(`${tenantId}:${resourceId}:${connectionId}`, connection)
  const resources = {
    async getResource() { return state.resources.get(`${tenantId}:${resourceId}`)! },
  } as unknown as ResourceRegistry
  const connections = {
    async get() { return state.connections.get(`${tenantId}:${resourceId}:${connectionId}`)! },
  } as unknown as ResourceConnectionRegistry
  return { state, resource, resources, connections }
}

test("MCP tool decisions stay locked during review but recover after a failed build", async () => {
  const { state, resource, resources, connections } = fixture()
  const discovery = createInMemoryMcpDiscoveryStore({ state, resources, connections, now: () => 3, idFactory: () => "discovery-1" })
  const requested = await discovery.request({ tenantId, resourceId, connectionId, requestedBySubjectId: "person-platform-admin", correlationId: "discovery" })
  await discovery.claimNext({ tenantId, gatewayId: "genio-ai-mcp-gateway", runtimeId: "runtime-local" })
  const completed = await discovery.complete({
    tenantId,
    runtimeId: "runtime-local",
    operationId: requested.operation_id,
    result: { state: "SUCCEEDED", observation: { protocol_version: "2025-11-25", server_name: "local", server_version: null, tools: [{ name: "search", title: null, description: null }] } },
  })
  const candidate = completed.candidates[0]!

  await assert.rejects(
    discovery.decideCandidate({ tenantId, resourceId, connectionId, candidateId: candidate.candidate_id, expectedRevisionDigest: candidate.revision_digest, state: "PUBLISHED" }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "MCP_TOOL_SELECTION_LOCKED",
  )

  resource.publication_request = {
    ...resource.publication_request!,
    publication_state: "FAILED",
    failure_code: "MCP_TOOL_SELECTION_REQUIRED",
  }
  const updated = await discovery.decideCandidate({ tenantId, resourceId, connectionId, candidateId: candidate.candidate_id, expectedRevisionDigest: candidate.revision_digest, state: "PUBLISHED" })
  assert.equal(updated.candidates[0]?.state, "PUBLISHED")
  assert.deepEqual(state.connections.get(`${tenantId}:${resourceId}:${connectionId}`)?.mcp_selected_tools, ["search"])

  const publicationStore = createInMemoryPublicationWorkflowStore({
    state,
    resources,
    connections,
    models: {} as never,
    chains: {} as never,
  })
  const successor = await publicationStore.preparePublicationReference({ tenantId, resourceId })
  assert.equal(successor?.endpointRevision, 2)
  assert.equal(successor?.publicationId, `publication-${resourceId}-2`)
})

test("MCP read-only approval is explicit, revision-bound, and revoked by discovery metadata changes", async () => {
  const { state, resource, resources, connections } = fixture()
  resource.publication_request = null
  let timestamp = 10
  let operationNumber = 0
  const discovery = createInMemoryMcpDiscoveryStore({
    state,
    resources,
    connections,
    now: () => timestamp++,
    idFactory: () => `discovery-${++operationNumber}`,
  })

  async function discover(correlationId: string, description: string) {
    const requested = await discovery.request({
      tenantId,
      resourceId,
      connectionId,
      requestedBySubjectId: "person-platform-admin",
      correlationId,
    })
    const claimed = await discovery.claimNext({
      tenantId,
      gatewayId: "genio-ai-mcp-gateway",
      runtimeId: "runtime-local",
    })
    assert.equal(claimed?.operation_id, requested.operation_id)
    return discovery.complete({
      tenantId,
      runtimeId: "runtime-local",
      operationId: requested.operation_id,
      result: {
        state: "SUCCEEDED",
        observation: {
          protocol_version: "2025-11-25",
          server_name: "local",
          server_version: null,
          tools: [{
            name: "search",
            title: "Search",
            description,
            input_schema: { type: "object", properties: { text: { type: "string" } } },
            read_only_hint: true,
          }],
        },
      },
    })
  }

  const initial = await discover("discovery-initial", "Search current messages")
  const initialCandidate = initial.candidates[0]!
  await discovery.decideCandidate({
    tenantId,
    resourceId,
    connectionId,
    candidateId: initialCandidate.candidate_id,
    expectedRevisionDigest: initialCandidate.revision_digest,
    state: "PUBLISHED",
  })

  await assert.rejects(
    discovery.decideReadOnlyApproval({
      tenantId,
      resourceId,
      connectionId,
      candidateId: initialCandidate.candidate_id,
      expectedRevisionDigest: "f".repeat(64),
      executionMode: "AUTO_READ_ONLY",
      approvedBySubjectId: "person-platform-admin",
    }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "MCP_DISCOVERY_CANDIDATE_REVISION_CONFLICT",
  )

  await discovery.decideReadOnlyApproval({
    tenantId,
    resourceId,
    connectionId,
    candidateId: initialCandidate.candidate_id,
    expectedRevisionDigest: initialCandidate.revision_digest,
    executionMode: "AUTO_READ_ONLY",
    approvedBySubjectId: "person-platform-admin",
  })
  assert.deepEqual(state.connections.get(`${tenantId}:${resourceId}:${connectionId}`)?.mcp_tool_reviews, [{
    tool_name: "search",
    source_revision_digest: initialCandidate.revision_digest,
    execution_mode: "AUTO_READ_ONLY",
    source_read_only_hint: true,
    title: "Search",
    description: "Search current messages",
    input_schema: { type: "object", properties: { text: { type: "string" } } },
    approved_by_subject_id: "person-platform-admin",
    approved_at: 14,
  }])

  const changed = await discover("discovery-changed", "Search current messages with query syntax")
  assert.notEqual(changed.candidates[0]?.revision_digest, initialCandidate.revision_digest)
  const connection = state.connections.get(`${tenantId}:${resourceId}:${connectionId}`)
  assert.deepEqual(connection?.mcp_selected_tools, ["search"])
  assert.deepEqual(connection?.mcp_tool_reviews, [])
})

class LockedPublicationSql implements SqlAdapter, SqlTransaction {
  readonly calls: Array<{ text: string; parameters: readonly unknown[] }> = []

  async query<Result extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Result>> {
    this.calls.push({ text, parameters })
    if (text.includes("pg_advisory_xact_lock")) {
      return { rows: [], rowCount: 1 }
    }
    if (text.includes("from genio_one_mcp_discovery_operations")) {
      return {
        rows: [{
          tenant_id: tenantId,
          operation_id: "discovery-1",
          gateway_id: "genio-ai-mcp-gateway",
          resource_id: resourceId,
          connection_id: connectionId,
          requested_by_subject_id: "person-platform-admin",
          correlation_id: "discovery",
          state: "SUCCEEDED",
          runtime_id: "runtime-local",
          endpoint: "http://127.0.0.1:19003/mcp",
          credential_ref: "mcp-key",
          downstream_identity: { mode: "SERVICE", authentication: "API_KEY" },
          observation: null,
          candidates: [{ candidate_id: "candidate-search", capability_id: "mcp.tool.search", tool_name: "search", revision_digest: "a".repeat(64), state: "NEW" }],
          error_code: null,
          error_message: null,
          created_at: 1,
          claimed_at: 2,
          completed_at: 3,
          updated_at: 3,
        } as unknown as Result],
        rowCount: 1,
      }
    }
    if (text.includes("from genio_one_resources")) {
      return { rows: [{ resource_id: resourceId, enforcement_point_id: "genio-ai-mcp-gateway" } as unknown as Result], rowCount: 1 }
    }
    if (text.includes("from genio_one_publications")) {
      return { rows: [{ request_snapshot: { state: "PENDING" }, publication_build_state: "PENDING" } as unknown as Result], rowCount: 1 }
    }
    throw new Error(`Unexpected query: ${text}`)
  }

  async transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
    return work(this)
  }
}

test("PostgreSQL candidate decisions take the Gateway lock before the Resource and publication", async () => {
  const sql = new LockedPublicationSql()
  const discovery = createPostgresMcpDiscoveryStore({ sql })

  await assert.rejects(
    discovery.decideCandidate({ tenantId, resourceId, connectionId, candidateId: "candidate-search", expectedRevisionDigest: "a".repeat(64), state: "PUBLISHED" }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "MCP_TOOL_SELECTION_LOCKED",
  )

  const gatewayLockIndex = sql.calls.findIndex((call) => call.text.includes("pg_advisory_xact_lock"))
  const resourceLockIndex = sql.calls.findIndex((call) =>
    call.text.includes("from genio_one_resources") && call.text.includes("for update"))
  const publicationLockIndex = sql.calls.findIndex((call) =>
    call.text.includes("from genio_one_publications") && call.text.includes("for update"))
  assert.ok(gatewayLockIndex >= 0)
  assert.ok(resourceLockIndex > gatewayLockIndex)
  assert.ok(publicationLockIndex > resourceLockIndex)
})

class ReadOnlyApprovalSql implements SqlAdapter, SqlTransaction {
  readonly calls: Array<{ text: string; parameters: readonly unknown[] }> = []
  reviews: unknown = []

  async query<Result extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Result>> {
    this.calls.push({ text, parameters })
    if (text.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 }
    if (text.includes("select enforcement_point_id") && text.includes("from genio_one_resources")) {
      return { rows: [{ enforcement_point_id: "genio-ai-mcp-gateway" } as unknown as Result], rowCount: 1 }
    }
    if (text.includes("from genio_one_mcp_discovery_operations")) {
      return {
        rows: [{
          tenant_id: tenantId,
          operation_id: "discovery-1",
          gateway_id: "genio-ai-mcp-gateway",
          resource_id: resourceId,
          connection_id: connectionId,
          requested_by_subject_id: "person-platform-admin",
          correlation_id: "discovery",
          state: "SUCCEEDED",
          runtime_id: "runtime-local",
          endpoint: "http://127.0.0.1:19003/mcp",
          credential_ref: "mcp-key",
          downstream_identity: { mode: "SERVICE", authentication: "API_KEY" },
          observation: {
            protocol_version: "2025-11-25",
            server_name: "local",
            server_version: null,
            tools: [{
              name: "search",
              title: "Search",
              description: "Search messages",
              input_schema: { type: "object", properties: { text: { type: "string" } } },
              read_only_hint: true,
            }],
          },
          candidates: [{
            candidate_id: "candidate-search",
            capability_id: "mcp.tool.search",
            tool_name: "search",
            revision_digest: "a".repeat(64),
            state: "PUBLISHED",
          }],
          error_code: null,
          error_message: null,
          created_at: 1,
          claimed_at: 2,
          completed_at: 3,
          updated_at: 3,
        } as unknown as Result],
        rowCount: 1,
      }
    }
    if (text.includes("select resource_id, enforcement_point_id")) {
      return { rows: [{ resource_id: resourceId, enforcement_point_id: "genio-ai-mcp-gateway" } as unknown as Result], rowCount: 1 }
    }
    if (text.includes("select request_snapshot, publication_build_state")) {
      return { rows: [], rowCount: 0 }
    }
    if (text.includes("select mcp_selected_tools, mcp_tool_reviews")) {
      return { rows: [{ mcp_selected_tools: ["search"], mcp_tool_reviews: [] } as unknown as Result], rowCount: 1 }
    }
    if (text.includes("update genio_one_resource_connections")) {
      this.reviews = JSON.parse(String(parameters[3]))
      return { rows: [], rowCount: 1 }
    }
    if (text.includes("select lifecycle, row_revision")) {
      return { rows: [{ lifecycle: "DRAFT", row_revision: 2 } as unknown as Result], rowCount: 1 }
    }
    if (text.includes("select publication_id, endpoint_revision")) {
      return {
        rows: [{
          publication_id: "publication-1",
          endpoint_revision: 1,
          resource_revision: 1,
          resource_digest: "resource-digest",
          gateway_id: "genio-ai-mcp-gateway",
          hostname: "mcp.local.test",
          base_path: "/mcp",
          visibility: "PRIVATE",
          publication_state: "DRAFT",
          publication_build_state: "IDLE",
          dns_management: "EXTERNAL",
          dns_proof_status: "VERIFIED",
          dns_proof: {},
        } as unknown as Result],
        rowCount: 1,
      }
    }
    if (text.includes("set resource_revision =")) return { rows: [], rowCount: 1 }
    throw new Error(`Unexpected query: ${text}`)
  }

  async transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
    return work(this)
  }
}

test("PostgreSQL read-only approval freezes the reviewed schema and stages a successor", async () => {
  const sql = new ReadOnlyApprovalSql()
  const discovery = createPostgresMcpDiscoveryStore({ sql, now: () => 77 })

  await discovery.decideReadOnlyApproval({
    tenantId,
    resourceId,
    connectionId,
    candidateId: "candidate-search",
    expectedRevisionDigest: "a".repeat(64),
    executionMode: "AUTO_READ_ONLY",
    approvedBySubjectId: "person-platform-admin",
  })

  assert.deepEqual(sql.reviews, [{
    tool_name: "search",
    source_revision_digest: "a".repeat(64),
    execution_mode: "AUTO_READ_ONLY",
    source_read_only_hint: true,
    title: "Search",
    description: "Search messages",
    input_schema: { type: "object", properties: { text: { type: "string" } } },
    approved_by_subject_id: "person-platform-admin",
    approved_at: 77,
  }])
  assert.ok(sql.calls.some((call) => call.text.includes("set resource_revision =")))
})
