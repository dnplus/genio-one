import type { ResourceConnectionRegistry } from "../connections/module"
import { PlatformApiError } from "../errors"
import type { ResourceRegistry } from "../resources/module"
import type { McpDiscoveryOperation } from "./contract"
import type { McpDiscoveryStore } from "./module"
import type { ResourceMemoryState } from "../resources/state"
import { mcpToolCapabilityId } from "../../../../../../runtimes/gateway/services/shared/mcp-tool-capability"
import { discoveryCandidates } from "./candidates"

function connectionKey(tenantId: string, connectionId: string): string {
  return `${tenantId}\u0000${connectionId}`
}

export function createInMemoryMcpDiscoveryStore(options: {
  state: ResourceMemoryState
  resources: ResourceRegistry
  connections: ResourceConnectionRegistry
  now?: () => number
  idFactory?: () => string
}): McpDiscoveryStore {
  const operations = new Map<string, McpDiscoveryOperation>()
  const correlations = new Map<string, string>()
  const activeConnections = new Map<string, string>()
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const idFactory = options.idFactory ?? (() => `mcp-discovery-${crypto.randomUUID()}`)

  function clone(operation: McpDiscoveryOperation): McpDiscoveryOperation {
    return structuredClone(operation)
  }

  return {
    async request(input) {
      const correlationKey = `${input.tenantId}\u0000${input.correlationId}`
      const existingId = correlations.get(correlationKey)
      if (existingId) return clone(operations.get(existingId)!)
      const activeId = activeConnections.get(connectionKey(input.tenantId, input.connectionId))
      if (activeId) return clone(operations.get(activeId)!)
      const [resource, connection] = await Promise.all([
        options.resources.getResource({ tenantId: input.tenantId, resourceId: input.resourceId }),
        options.connections.get({
          tenantId: input.tenantId,
          resourceId: input.resourceId,
          connectionId: input.connectionId,
        }),
      ])
      if (resource.kind !== "MCP" || connection.connection_kind !== "MCP") {
        throw new PlatformApiError("MCP_CONNECTION_NOT_FOUND", 404)
      }
      const timestamp = now()
      const operation: McpDiscoveryOperation = {
        tenant_id: input.tenantId,
        operation_id: idFactory(),
        gateway_id: resource.enforcement_point_id,
        resource_id: input.resourceId,
        connection_id: input.connectionId,
        requested_by_subject_id: input.requestedBySubjectId,
        correlation_id: input.correlationId,
        state: "PENDING",
        runtime_id: null,
        endpoint: connection.endpoint,
        credential_ref: connection.credential_ref ?? null,
        downstream_identity: connection.downstream_identity,
        observation: null,
        candidates: [],
        error_code: null,
        error_message: null,
        created_at: timestamp,
        claimed_at: null,
        completed_at: null,
        updated_at: timestamp,
      }
      operations.set(operation.operation_id, operation)
      correlations.set(correlationKey, operation.operation_id)
      activeConnections.set(connectionKey(input.tenantId, input.connectionId), operation.operation_id)
      return clone(operation)
    },

    async latest(input) {
      const matches = [...operations.values()]
        .filter((operation) =>
          operation.tenant_id === input.tenantId &&
          operation.resource_id === input.resourceId &&
          operation.connection_id === input.connectionId)
        .sort((left, right) => right.created_at - left.created_at)
      return matches[0] ? clone(matches[0]) : null
    },

    async get(input) {
      const operation = operations.get(input.operationId)
      return operation?.tenant_id === input.tenantId ? clone(operation) : null
    },

    async claimNext(input) {
      const operation = [...operations.values()]
        .filter((candidate) =>
          candidate.tenant_id === input.tenantId &&
          candidate.gateway_id === input.gatewayId &&
          candidate.state === "PENDING")
        .sort((left, right) => left.created_at - right.created_at || left.operation_id.localeCompare(right.operation_id))[0]
      if (!operation) return null
      const timestamp = now()
      const claimed: McpDiscoveryOperation = {
        ...operation,
        state: "RUNNING",
        runtime_id: input.runtimeId,
        claimed_at: timestamp,
        updated_at: timestamp,
      }
      operations.set(claimed.operation_id, claimed)
      return clone(claimed)
    },

    async complete(input) {
      const operation = operations.get(input.operationId)
      if (
        !operation ||
        operation.tenant_id !== input.tenantId ||
        operation.runtime_id !== input.runtimeId ||
        operation.state !== "RUNNING"
      ) {
        throw new PlatformApiError("MCP_DISCOVERY_OPERATION_NOT_RUNNING", 409)
      }
      const timestamp = now()
      const connection = await options.connections.get({
        tenantId: input.tenantId,
        resourceId: operation.resource_id,
        connectionId: operation.connection_id,
      })
      const previous = [...operations.values()]
        .filter((candidate) =>
          candidate.tenant_id === input.tenantId &&
          candidate.connection_id === operation.connection_id &&
          candidate.operation_id !== operation.operation_id &&
          candidate.state === "SUCCEEDED")
        .sort((left, right) => right.completed_at! - left.completed_at!)[0]
      const completed: McpDiscoveryOperation = input.result.state === "SUCCEEDED"
        ? {
            ...operation,
            state: "SUCCEEDED",
            observation: input.result.observation,
            candidates: discoveryCandidates(
              operation.connection_id,
              input.result.observation,
              connection.mcp_selected_tools,
              previous?.candidates,
            ),
            completed_at: timestamp,
            updated_at: timestamp,
          }
        : {
            ...operation,
            state: "FAILED",
            error_code: input.result.error_code,
            error_message: input.result.error_message,
            completed_at: timestamp,
            updated_at: timestamp,
          }
      operations.set(completed.operation_id, completed)
      activeConnections.delete(connectionKey(completed.tenant_id, completed.connection_id))
      return clone(completed)
    },

    async decideCandidate(input) {
      const operation = [...operations.values()]
        .filter((candidate) =>
          candidate.tenant_id === input.tenantId &&
          candidate.resource_id === input.resourceId &&
          candidate.connection_id === input.connectionId &&
          candidate.state === "SUCCEEDED")
        .sort((left, right) => right.completed_at! - left.completed_at!)[0]
      if (!operation) throw new PlatformApiError("MCP_DISCOVERY_NOT_FOUND", 404)
      const candidate = operation.candidates.find((value) => value.candidate_id === input.candidateId)
      if (!candidate) throw new PlatformApiError("MCP_DISCOVERY_CANDIDATE_NOT_FOUND", 404)
      if (candidate.revision_digest !== input.expectedRevisionDigest) {
        throw new PlatformApiError("MCP_DISCOVERY_CANDIDATE_REVISION_CONFLICT", 409)
      }
      const updated = {
        ...operation,
        candidates: operation.candidates.map((value) => value.candidate_id === input.candidateId
          ? { ...value, state: input.state }
          : value),
        updated_at: now(),
      }
      const resourceKey = `${input.tenantId}:${input.resourceId}`
      const ownedConnectionKey = `${resourceKey}:${input.connectionId}`
      const connection = options.state.connections.get(ownedConnectionKey)
      const resource = options.state.resources.get(resourceKey)
      if (!connection || !resource) throw new PlatformApiError("MCP_CONNECTION_NOT_FOUND", 404)
      if (
        resource.publication_request?.state === "PENDING" &&
        resource.publication_request.publication_state !== "FAILED"
      ) {
        throw new PlatformApiError("MCP_TOOL_SELECTION_LOCKED", 409)
      }
      const selected = (input.state === "PUBLISHED"
        ? [...new Set([...connection.mcp_selected_tools, candidate.tool_name])]
        : connection.mcp_selected_tools.filter((name) => name !== candidate.tool_name)).sort()
      if (JSON.stringify(selected) !== JSON.stringify(connection.mcp_selected_tools)) {
        options.state.connections.set(ownedConnectionKey, {
          ...connection, mcp_selected_tools: selected, mcp_tool_selection_operation_id: operation.operation_id,
          configuration_revision: connection.configuration_revision + 1,
        })
        const existing = new Set(resource.capabilities.map((capability) => capability.capability_id))
        const added = input.state === "PUBLISHED" ? selected.filter((name) => !existing.has(mcpToolCapabilityId(name))).map((name) => ({ capability_id: mcpToolCapabilityId(name), display_name: name })) : []
        options.state.resources.set(resourceKey, { ...resource, capabilities: [...resource.capabilities, ...added] })
        options.state.resourceRevisions.set(resourceKey, (options.state.resourceRevisions.get(resourceKey) ?? 1) + 1)
      }
      operations.set(updated.operation_id, updated)
      return clone(updated)
    },
  }
}
