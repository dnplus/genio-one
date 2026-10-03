import { Check } from "typebox/value"

import type { SqlAdapter, SqlTransaction } from "../../persistence/sql-adapter"
import {
  canonicalizeDownstreamIdentity,
  canonicalizeMcpToolReviews,
  type DownstreamIdentityProjection,
} from "../connections/contract"
import { PlatformApiError } from "../errors"
import {
  McpDiscoveryObservationSchema,
  McpDiscoveryCandidateSchema,
  McpDiscoveryOperationSchema,
  type McpDiscoveryObservation,
  type McpDiscoveryOperation,
} from "./contract"
import type { McpDiscoveryStore } from "./module"
import { discoveryCandidates } from "./candidates"
import { mcpToolCapabilityId } from "../../../../../../runtimes/gateway/services/shared/mcp-tool-capability"
import { ensurePublicationSuccessorInTransaction } from "../publications/successor"
import { lockGatewayPolicyRelease } from "../gateway-policy-release/transaction-lock"
import { mcpToolReviewForCandidate, pruneMcpToolReviews, replaceMcpToolReview } from "./reviews"

type DatabaseRow = Record<string, unknown>

const COLUMNS = `
  tenant_id,
  operation_id,
  gateway_id,
  resource_id,
  connection_id,
  requested_by_subject_id,
  correlation_id,
  state,
  runtime_id,
  endpoint,
  credential_ref,
  downstream_identity,
  observation,
  candidates,
  error_code,
  error_message,
  extract(epoch from created_at)::bigint as created_at,
  extract(epoch from claimed_at)::bigint as claimed_at,
  extract(epoch from completed_at)::bigint as completed_at,
  extract(epoch from updated_at)::bigint as updated_at`

function value(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function publicationLocksToolSelection(row: DatabaseRow): boolean {
  const request = value(row.request_snapshot)
  return Boolean(
    request &&
    typeof request === "object" &&
    !Array.isArray(request) &&
    (request as Record<string, unknown>).state === "PENDING" &&
    row.publication_build_state !== "FAILED",
  )
}

function string(row: DatabaseRow, key: string): string {
  const result = row[key]
  if (typeof result !== "string" || !result.trim()) {
    throw new PlatformApiError("MCP_DISCOVERY_DATA_INVALID", 500)
  }
  return result
}

function optionalString(row: DatabaseRow, key: string): string | null {
  const result = row[key]
  if (result === null || result === undefined) return null
  return string(row, key)
}

function timestamp(row: DatabaseRow, key: string): number | null {
  const result = row[key]
  if (result === null || result === undefined) return null
  const parsed = typeof result === "bigint" ? Number(result) : Number(result)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new PlatformApiError("MCP_DISCOVERY_DATA_INVALID", 500)
  }
  return parsed
}

function downstreamIdentity(row: DatabaseRow): DownstreamIdentityProjection {
  const parsed = value(row.downstream_identity)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PlatformApiError("MCP_DISCOVERY_DATA_INVALID", 500)
  }
  const normalized = canonicalizeDownstreamIdentity(parsed as DownstreamIdentityProjection)
  if (!normalized) throw new PlatformApiError("MCP_DISCOVERY_DATA_INVALID", 500)
  return normalized
}

function observation(row: DatabaseRow): McpDiscoveryObservation | null {
  if (row.observation === null || row.observation === undefined) return null
  const parsed = value(row.observation)
  if (!Check(McpDiscoveryObservationSchema, parsed)) {
    throw new PlatformApiError("MCP_DISCOVERY_DATA_INVALID", 500)
  }
  return parsed
}

function candidates(row: DatabaseRow): McpDiscoveryOperation["candidates"] {
  const parsed = value(row.candidates)
  if (!Array.isArray(parsed)) {
    throw new PlatformApiError("MCP_DISCOVERY_DATA_INVALID", 500)
  }
  const normalized = parsed.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate
    const record = candidate as Record<string, unknown>
    return record.capability_id === undefined && typeof record.tool_name === "string"
      ? { ...record, capability_id: mcpToolCapabilityId(record.tool_name) }
      : record
  })
  if (normalized.some((candidate) => !Check(McpDiscoveryCandidateSchema, candidate))) {
    throw new PlatformApiError("MCP_DISCOVERY_DATA_INVALID", 500)
  }
  return normalized as McpDiscoveryOperation["candidates"]
}

function mcpToolReviews(row: DatabaseRow) {
  if (row.mcp_tool_reviews === null || row.mcp_tool_reviews === undefined) return []
  const reviews = canonicalizeMcpToolReviews(value(row.mcp_tool_reviews))
  if (!reviews) throw new PlatformApiError("MCP_DISCOVERY_DATA_INVALID", 500)
  return reviews
}

function map(row: DatabaseRow): McpDiscoveryOperation {
  const result: McpDiscoveryOperation = {
    tenant_id: string(row, "tenant_id"),
    operation_id: string(row, "operation_id"),
    gateway_id: string(row, "gateway_id"),
    resource_id: string(row, "resource_id"),
    connection_id: string(row, "connection_id"),
    requested_by_subject_id: string(row, "requested_by_subject_id"),
    correlation_id: string(row, "correlation_id"),
    state: string(row, "state") as McpDiscoveryOperation["state"],
    runtime_id: optionalString(row, "runtime_id"),
    endpoint: string(row, "endpoint"),
    credential_ref: optionalString(row, "credential_ref"),
    downstream_identity: downstreamIdentity(row),
    observation: observation(row),
    candidates: candidates(row),
    error_code: optionalString(row, "error_code"),
    error_message: optionalString(row, "error_message"),
    created_at: timestamp(row, "created_at")!,
    claimed_at: timestamp(row, "claimed_at"),
    completed_at: timestamp(row, "completed_at"),
    updated_at: timestamp(row, "updated_at")!,
  }
  if (!Check(McpDiscoveryOperationSchema, result)) {
    throw new PlatformApiError("MCP_DISCOVERY_DATA_INVALID", 500)
  }
  return result
}

async function active(
  transaction: SqlTransaction,
  tenantId: string,
  resourceId: string,
  connectionId: string,
): Promise<McpDiscoveryOperation | null> {
  const found = await transaction.query<DatabaseRow>(
    `select ${COLUMNS}
       from genio_one_mcp_discovery_operations
      where tenant_id = $1
        and resource_id = $2
        and connection_id = $3
        and state in ('PENDING', 'RUNNING')
      order by created_at desc
      limit 1
      for update`,
    [tenantId, resourceId, connectionId],
  )
  return found.rows[0] ? map(found.rows[0]) : null
}

export function createPostgresMcpDiscoveryStore(options: {
  sql: SqlAdapter
  idFactory?: () => string
  publicationIdFactory?: (prefix: string) => string
  now?: () => number
}): McpDiscoveryStore {
  const idFactory = options.idFactory ?? (() => `mcp-discovery-${crypto.randomUUID()}`)
  const publicationIdFactory = options.publicationIdFactory ?? ((prefix) => `${prefix}-${crypto.randomUUID()}`)
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  return {
    async request(input) {
      return options.sql.transaction(async (transaction) => {
        const same = await transaction.query<DatabaseRow>(
          `select ${COLUMNS}
             from genio_one_mcp_discovery_operations
            where tenant_id = $1 and resource_id = $2 and correlation_id = $3
            limit 1
            for update`,
          [input.tenantId, input.resourceId, input.correlationId],
        )
        if (same.rows[0]) return map(same.rows[0])
        const current = await active(transaction, input.tenantId, input.resourceId, input.connectionId)
        if (current) return current
        const source = await transaction.query<DatabaseRow>(
          `select resource.enforcement_point_id as gateway_id,
                  connection.endpoint,
                  connection.credential_ref,
                  connection.downstream_identity
             from genio_one_resources resource
             join genio_one_resource_connections connection
               on connection.tenant_id = resource.tenant_id
              and connection.resource_id = resource.resource_id
            where resource.tenant_id = $1
              and resource.resource_id = $2
              and connection.connection_id = $3
              and resource.kind = 'MCP'
              and connection.connection_kind = 'MCP'
            limit 1
            for update of resource, connection`,
          [input.tenantId, input.resourceId, input.connectionId],
        )
        const row = source.rows[0]
        if (!row) throw new PlatformApiError("MCP_CONNECTION_NOT_FOUND", 404)
        const inserted = await transaction.query<DatabaseRow>(
          `insert into genio_one_mcp_discovery_operations
             (tenant_id, operation_id, gateway_id, resource_id, connection_id,
              requested_by_subject_id, correlation_id, endpoint, credential_ref, downstream_identity)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text::jsonb)
           returning ${COLUMNS}`,
          [
            input.tenantId,
            idFactory(),
            string(row, "gateway_id"),
            input.resourceId,
            input.connectionId,
            input.requestedBySubjectId,
            input.correlationId,
            string(row, "endpoint"),
            optionalString(row, "credential_ref"),
            JSON.stringify(downstreamIdentity(row)),
          ],
        )
        return map(inserted.rows[0]!)
      })
    },

    async latest(input) {
      const found = await options.sql.query<DatabaseRow>(
        `select ${COLUMNS}
           from genio_one_mcp_discovery_operations
          where tenant_id = $1 and resource_id = $2 and connection_id = $3
          order by created_at desc
          limit 1`,
        [input.tenantId, input.resourceId, input.connectionId],
      )
      return found.rows[0] ? map(found.rows[0]) : null
    },

    async get(input) {
      const found = await options.sql.query<DatabaseRow>(
        `select ${COLUMNS}
           from genio_one_mcp_discovery_operations
          where tenant_id = $1 and operation_id = $2`,
        [input.tenantId, input.operationId],
      )
      return found.rows[0] ? map(found.rows[0]) : null
    },

    async claimNext(input) {
      return options.sql.transaction(async (transaction) => {
        const found = await transaction.query<DatabaseRow>(
          `select operation_id
             from genio_one_mcp_discovery_operations
            where tenant_id = $1 and gateway_id = $2 and state = 'PENDING'
            order by created_at, operation_id
            limit 1
            for update skip locked`,
          [input.tenantId, input.gatewayId],
        )
        const operationId = found.rows[0]?.operation_id
        if (typeof operationId !== "string") return null
        const claimed = await transaction.query<DatabaseRow>(
          `update genio_one_mcp_discovery_operations
              set state = 'RUNNING', runtime_id = $3, claimed_at = now(), updated_at = now()
            where tenant_id = $1 and operation_id = $2 and state = 'PENDING'
            returning ${COLUMNS}`,
          [input.tenantId, operationId, input.runtimeId],
        )
        return claimed.rows[0] ? map(claimed.rows[0]) : null
      })
    },

    async complete(input) {
      return options.sql.transaction(async (transaction) => {
        const identityResult = await transaction.query<DatabaseRow>(
          `select enforcement_point_id
             from genio_one_resources resource
             join genio_one_mcp_discovery_operations operation
               on operation.tenant_id = resource.tenant_id
              and operation.resource_id = resource.resource_id
            where operation.tenant_id = $1 and operation.operation_id = $2`,
          [input.tenantId, input.operationId],
        )
        const gatewayId = identityResult.rows[0]
          ? string(identityResult.rows[0], "enforcement_point_id")
          : null
        if (!gatewayId) throw new PlatformApiError("MCP_DISCOVERY_OPERATION_NOT_RUNNING", 409)
        await lockGatewayPolicyRelease({ transaction, tenantId: input.tenantId, gatewayId })
        const source = await transaction.query<DatabaseRow>(
          `select operation.resource_id, operation.connection_id,
                  resource.enforcement_point_id as gateway_id,
                  connection.mcp_selected_tools, connection.mcp_tool_reviews,
                  coalesce(previous.candidates, '[]'::jsonb) as previous_candidates
             from genio_one_mcp_discovery_operations operation
             join genio_one_resources resource
               on resource.tenant_id = operation.tenant_id
              and resource.resource_id = operation.resource_id
             join genio_one_resource_connections connection
               on connection.tenant_id = operation.tenant_id
              and connection.resource_id = operation.resource_id
              and connection.connection_id = operation.connection_id
             left join lateral (
               select candidates from genio_one_mcp_discovery_operations
                where tenant_id = operation.tenant_id
                  and resource_id = operation.resource_id
                  and connection_id = operation.connection_id
                  and operation_id <> operation.operation_id
                  and state = 'SUCCEEDED'
                order by completed_at desc limit 1
             ) previous on true
            where operation.tenant_id = $1
              and operation.runtime_id = $2
              and operation.operation_id = $3
              and operation.state = 'RUNNING'
            for update of operation, resource, connection`,
          [input.tenantId, input.runtimeId, input.operationId],
        )
        const sourceRow = source.rows[0]
        if (!sourceRow || string(sourceRow, "gateway_id") !== gatewayId) {
          throw new PlatformApiError("MCP_DISCOVERY_OPERATION_NOT_RUNNING", 409)
        }
        const selectedTools = sourceRow.mcp_selected_tools
        if (!Array.isArray(selectedTools) || selectedTools.some((tool) => typeof tool !== "string")) {
          throw new PlatformApiError("MCP_DISCOVERY_DATA_INVALID", 500)
        }
        const candidateValue = input.result.state === "SUCCEEDED"
          ? discoveryCandidates(
              string(sourceRow, "connection_id"),
              input.result.observation,
              selectedTools,
              candidates({ candidates: sourceRow.previous_candidates }),
            )
          : []
        const nextReviews = input.result.state === "SUCCEEDED"
          ? pruneMcpToolReviews(mcpToolReviews(sourceRow), candidateValue)
          : mcpToolReviews(sourceRow)
        const reviewsChanged = JSON.stringify(nextReviews) !== JSON.stringify(mcpToolReviews(sourceRow))
        if (reviewsChanged) {
          await transaction.query(
            `update genio_one_resource_connections
                set mcp_tool_reviews = $4::text::jsonb,
                    configuration_revision = configuration_revision + 1,
                    row_revision = row_revision + 1,
                    updated_at = now()
              where tenant_id = $1 and resource_id = $2 and connection_id = $3`,
            [input.tenantId, string(sourceRow, "resource_id"), string(sourceRow, "connection_id"), JSON.stringify(nextReviews)],
          )
        }
        const observationValue = input.result.state === "SUCCEEDED"
          ? JSON.stringify(input.result.observation)
          : null
        const errorCode = input.result.state === "FAILED" ? input.result.error_code : null
        const errorMessage = input.result.state === "FAILED" ? input.result.error_message : null
        const completed = await transaction.query<DatabaseRow>(
          `update genio_one_mcp_discovery_operations
              set state = $4,
                  observation = $5::text::jsonb,
                  error_code = $6,
                  error_message = $7,
                  candidates = $8::text::jsonb,
                  completed_at = now(),
                  updated_at = now()
            where tenant_id = $1
              and runtime_id = $2
              and operation_id = $3
              and state = 'RUNNING'
            returning ${COLUMNS}`,
          [
            input.tenantId,
            input.runtimeId,
            input.operationId,
            input.result.state,
            observationValue,
            errorCode,
            errorMessage,
            JSON.stringify(candidateValue),
          ],
        )
        if (!completed.rows[0]) throw new PlatformApiError("MCP_DISCOVERY_OPERATION_NOT_RUNNING", 409)
        if (reviewsChanged) {
          await ensurePublicationSuccessorInTransaction({
            transaction,
            tenantId: input.tenantId,
            resourceId: string(sourceRow, "resource_id"),
            idFactory: publicationIdFactory,
          })
        }
        return map(completed.rows[0])
      })
    },

    async decideCandidate(input) {
      return options.sql.transaction(async (transaction) => {
        const identityResult = await transaction.query<DatabaseRow>(
          `select enforcement_point_id
             from genio_one_resources
            where tenant_id = $1 and resource_id = $2`,
          [input.tenantId, input.resourceId],
        )
        const gatewayId = identityResult.rows[0]
          ? string(identityResult.rows[0], "enforcement_point_id")
          : null
        if (!gatewayId) throw new PlatformApiError("MCP_CONNECTION_NOT_FOUND", 404)
        await lockGatewayPolicyRelease({ transaction, tenantId: input.tenantId, gatewayId })
        const found = await transaction.query<DatabaseRow>(
          `select ${COLUMNS}
             from genio_one_mcp_discovery_operations
            where tenant_id = $1 and resource_id = $2 and connection_id = $3 and state = 'SUCCEEDED'
            order by completed_at desc limit 1 for update`,
          [input.tenantId, input.resourceId, input.connectionId],
        )
        const operation = found.rows[0] ? map(found.rows[0]) : null
        if (!operation) throw new PlatformApiError("MCP_DISCOVERY_NOT_FOUND", 404)
        const candidate = operation.candidates.find((value) => value.candidate_id === input.candidateId)
        if (!candidate) throw new PlatformApiError("MCP_DISCOVERY_CANDIDATE_NOT_FOUND", 404)
        if (candidate.revision_digest !== input.expectedRevisionDigest) {
          throw new PlatformApiError("MCP_DISCOVERY_CANDIDATE_REVISION_CONFLICT", 409)
        }
        const nextCandidates = operation.candidates.map((value) => value.candidate_id === input.candidateId
          ? { ...value, state: input.state }
          : value)
        // Match the Resource → publication ordering used by publication successor creation
        // before evaluating the current request state.
        const resourceResult = await transaction.query<DatabaseRow>(
          `select resource_id, enforcement_point_id
             from genio_one_resources
            where tenant_id = $1 and resource_id = $2
            for update`,
          [input.tenantId, input.resourceId],
        )
        if (!resourceResult.rows[0]) throw new PlatformApiError("MCP_CONNECTION_NOT_FOUND", 404)
        if (string(resourceResult.rows[0], "enforcement_point_id") !== gatewayId) {
          throw new PlatformApiError("MCP_CONNECTION_NOT_FOUND", 409)
        }
        const publicationResult = await transaction.query<DatabaseRow>(
          `select request_snapshot, publication_build_state
             from genio_one_publications
            where tenant_id = $1 and resource_id = $2
            order by endpoint_revision desc
            limit 1
            for update`,
          [input.tenantId, input.resourceId],
        )
        if (publicationResult.rows[0] && publicationLocksToolSelection(publicationResult.rows[0])) {
          throw new PlatformApiError("MCP_TOOL_SELECTION_LOCKED", 409)
        }
        const connectionResult = await transaction.query<DatabaseRow>(
          `select mcp_selected_tools, mcp_tool_reviews
             from genio_one_resource_connections
            where tenant_id = $1 and resource_id = $2 and connection_id = $3
            for update`,
          [input.tenantId, input.resourceId, input.connectionId],
        )
        const selectedTools = connectionResult.rows[0]?.mcp_selected_tools
        if (!Array.isArray(selectedTools) || selectedTools.some((tool) => typeof tool !== "string")) {
          throw new PlatformApiError("MCP_DISCOVERY_DATA_INVALID", 500)
        }
        const nextSelectedTools = (input.state === "PUBLISHED"
          ? [...new Set([...selectedTools, candidate.tool_name])]
          : selectedTools.filter((tool) => tool !== candidate.tool_name))
          .sort((left, right) => left.localeCompare(right))
        const currentReviews = mcpToolReviews(connectionResult.rows[0]!)
        const nextReviews = input.state === "PUBLISHED"
          ? currentReviews
          : replaceMcpToolReview(currentReviews, null, candidate.tool_name)
        const surfaceChanged = JSON.stringify(selectedTools) !== JSON.stringify(nextSelectedTools)
        const reviewsChanged = JSON.stringify(currentReviews) !== JSON.stringify(nextReviews)
        if (input.state === "PUBLISHED") {
          for (const toolName of nextSelectedTools) {
            await transaction.query(
              `update genio_one_resources
                  set capabilities = capabilities || jsonb_build_array(jsonb_build_object(
                        'capability_id', $3::text,
                        'display_name', $4::text
                      )),
                      row_revision = row_revision + 1,
                      updated_at = now()
                where tenant_id = $1 and resource_id = $2
                  and not capabilities @> jsonb_build_array(jsonb_build_object('capability_id', $3::text))`,
              [input.tenantId, input.resourceId, mcpToolCapabilityId(toolName), toolName],
            )
          }
        }
        if (surfaceChanged || reviewsChanged) {
          await transaction.query(
            `update genio_one_resource_connections
                set mcp_selected_tools = $4::text[],
                    mcp_tool_selection_operation_id = $5,
                    mcp_tool_reviews = $6::text::jsonb,
                    configuration_revision = configuration_revision + 1,
                    row_revision = row_revision + 1,
                    updated_at = now()
              where tenant_id = $1 and resource_id = $2 and connection_id = $3`,
            [input.tenantId, input.resourceId, input.connectionId, nextSelectedTools, operation.operation_id, JSON.stringify(nextReviews)],
          )
          await ensurePublicationSuccessorInTransaction({
            transaction,
            tenantId: input.tenantId,
            resourceId: input.resourceId,
            idFactory: publicationIdFactory,
          })
        }
        const updated = await transaction.query<DatabaseRow>(
          `update genio_one_mcp_discovery_operations
              set candidates = $3::text::jsonb, updated_at = now()
            where tenant_id = $1 and operation_id = $2
            returning ${COLUMNS}`,
          [input.tenantId, operation.operation_id, JSON.stringify(nextCandidates)],
        )
        return map(updated.rows[0]!)
      })
    },

    async decideReadOnlyApproval(input) {
      return options.sql.transaction(async (transaction) => {
        const identityResult = await transaction.query<DatabaseRow>(
          `select enforcement_point_id
             from genio_one_resources
            where tenant_id = $1 and resource_id = $2`,
          [input.tenantId, input.resourceId],
        )
        const gatewayId = identityResult.rows[0]
          ? string(identityResult.rows[0], "enforcement_point_id")
          : null
        if (!gatewayId) throw new PlatformApiError("MCP_CONNECTION_NOT_FOUND", 404)
        await lockGatewayPolicyRelease({ transaction, tenantId: input.tenantId, gatewayId })
        const found = await transaction.query<DatabaseRow>(
          `select ${COLUMNS}
             from genio_one_mcp_discovery_operations
            where tenant_id = $1 and resource_id = $2 and connection_id = $3 and state = 'SUCCEEDED'
            order by completed_at desc limit 1 for update`,
          [input.tenantId, input.resourceId, input.connectionId],
        )
        const operation = found.rows[0] ? map(found.rows[0]) : null
        if (!operation) throw new PlatformApiError("MCP_DISCOVERY_NOT_FOUND", 404)
        const candidate = operation.candidates.find((value) => value.candidate_id === input.candidateId)
        if (!candidate) throw new PlatformApiError("MCP_DISCOVERY_CANDIDATE_NOT_FOUND", 404)
        if (candidate.revision_digest !== input.expectedRevisionDigest) {
          throw new PlatformApiError("MCP_DISCOVERY_CANDIDATE_REVISION_CONFLICT", 409)
        }
        const resourceResult = await transaction.query<DatabaseRow>(
          `select resource_id, enforcement_point_id
             from genio_one_resources
            where tenant_id = $1 and resource_id = $2
            for update`,
          [input.tenantId, input.resourceId],
        )
        if (!resourceResult.rows[0] || string(resourceResult.rows[0], "enforcement_point_id") !== gatewayId) {
          throw new PlatformApiError("MCP_CONNECTION_NOT_FOUND", 409)
        }
        const publicationResult = await transaction.query<DatabaseRow>(
          `select request_snapshot, publication_build_state
             from genio_one_publications
            where tenant_id = $1 and resource_id = $2
            order by endpoint_revision desc
            limit 1
            for update`,
          [input.tenantId, input.resourceId],
        )
        if (publicationResult.rows[0] && publicationLocksToolSelection(publicationResult.rows[0])) {
          throw new PlatformApiError("MCP_TOOL_REVIEW_LOCKED", 409)
        }
        const connectionResult = await transaction.query<DatabaseRow>(
          `select mcp_selected_tools, mcp_tool_reviews
             from genio_one_resource_connections
            where tenant_id = $1 and resource_id = $2 and connection_id = $3
            for update`,
          [input.tenantId, input.resourceId, input.connectionId],
        )
        const connection = connectionResult.rows[0]
        const selectedTools = connection?.mcp_selected_tools
        if (!connection || !Array.isArray(selectedTools) || selectedTools.some((tool) => typeof tool !== "string")) {
          throw new PlatformApiError("MCP_DISCOVERY_DATA_INVALID", 500)
        }
        if (candidate.state !== "PUBLISHED" || !selectedTools.includes(candidate.tool_name)) {
          throw new PlatformApiError("MCP_TOOL_REVIEW_TOOL_NOT_PUBLISHED", 409)
        }
        if (input.executionMode === "AUTO_READ_ONLY" && !operation.observation) {
          throw new PlatformApiError("MCP_TOOL_REVIEW_METADATA_REQUIRED", 409)
        }
        const review = input.executionMode === "AUTO_READ_ONLY"
          ? mcpToolReviewForCandidate({
              observation: operation.observation!,
              candidate,
              approvedBySubjectId: input.approvedBySubjectId,
              approvedAt: now(),
            })
          : null
        const currentReviews = mcpToolReviews(connection)
        const nextReviews = replaceMcpToolReview(currentReviews, review, candidate.tool_name)
        if (JSON.stringify(currentReviews) !== JSON.stringify(nextReviews)) {
          await transaction.query(
            `update genio_one_resource_connections
                set mcp_tool_reviews = $4::text::jsonb,
                    configuration_revision = configuration_revision + 1,
                    row_revision = row_revision + 1,
                    updated_at = now()
              where tenant_id = $1 and resource_id = $2 and connection_id = $3`,
            [input.tenantId, input.resourceId, input.connectionId, JSON.stringify(nextReviews)],
          )
          await ensurePublicationSuccessorInTransaction({
            transaction,
            tenantId: input.tenantId,
            resourceId: input.resourceId,
            idFactory: publicationIdFactory,
          })
        }
        return operation
      })
    },
  }
}
