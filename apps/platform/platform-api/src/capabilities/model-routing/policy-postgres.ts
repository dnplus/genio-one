import { randomUUID } from "node:crypto"

import type { SqlAdapter, SqlTransaction } from "../../persistence/sql-adapter"
import { PlatformApiError } from "../errors"
import type {
  CreateModelRoutingPolicyInput,
  ModelRoutingPolicy,
} from "./contract"
import {
  routingPolicyMatchesInput,
  validateCreateModelRoutingPolicy,
  validateModelRoutingPolicy,
} from "./policy"
import type {
  ModelRoutingPolicyRevisionKey,
  ModelRoutingPolicyReleasePublisher,
  ModelRoutingPolicyScope,
  ModelRoutingPolicyStore,
} from "./module"

type DatabaseRow = Record<string, unknown>
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

export interface PostgresModelRoutingPolicyOptions {
  sql: SqlAdapter
  idFactory?: (prefix: string) => string
  now?: () => number
  releasePublisher?: ModelRoutingPolicyReleasePublisher
}

const POLICY_COLUMNS = `
  tenant_id,
  routing_policy_id,
  owner_organization_id,
  resource_id,
  capability_id,
  routing_revision,
  mode,
  default_public_model_id,
  candidate_public_model_ids,
  session_lease_seconds,
  context_requirements,
  extract(epoch from created_at)::bigint as created_at,
  extract(epoch from updated_at)::bigint as updated_at`

function assertTenantId(tenantId: string): void {
  if (!tenantId.trim() || tenantId.trim() !== tenantId || CONTROL_CHARACTERS.test(tenantId)) {
    throw new PlatformApiError("MODEL_ROUTING_POLICY_SCOPE_INVALID", 422, "tenantId is invalid")
  }
}

function assertScopeValue(value: string, field: string): void {
  if (!value.trim() || value.trim() !== value || CONTROL_CHARACTERS.test(value)) {
    throw new PlatformApiError("MODEL_ROUTING_POLICY_SCOPE_INVALID", 422, `${field} is invalid`)
  }
}

function assertScope(scope: ModelRoutingPolicyScope): void {
  assertTenantId(scope.tenantId)
  assertScopeValue(scope.ownerOrganizationId, "ownerOrganizationId")
  assertScopeValue(scope.resourceId, "resourceId")
  assertScopeValue(scope.capabilityId, "capabilityId")
}

function assertRevisionKey(key: ModelRoutingPolicyRevisionKey): void {
  assertScope(key)
  if (!Number.isSafeInteger(key.routingRevision) || key.routingRevision < 1) {
    throw new PlatformApiError(
      "MODEL_ROUTING_POLICY_REVISION_INVALID",
      422,
      "routingRevision must be a positive integer",
    )
  }
}

function rowString(row: DatabaseRow, key: string, code = "MODEL_ROUTING_POLICY_DATA_INVALID"): string {
  const value = row[key]
  if (typeof value !== "string" || !value.trim()) throw new PlatformApiError(code, 500)
  return value
}

function rowInteger(row: DatabaseRow, key: string, minimum: number): number {
  const value = row[key]
  const parsed =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number(value)
          : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new PlatformApiError("MODEL_ROUTING_POLICY_DATA_INVALID", 500)
  }
  return parsed
}

function rowNullableInteger(row: DatabaseRow, key: string): number | null {
  if (row[key] === null || row[key] === undefined) return null
  return rowInteger(row, key, 1)
}

function rowTimestamp(row: DatabaseRow, key: string): number {
  const value = row[key]
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return Math.floor(value.getTime() / 1000)
  }
  if (typeof value === "bigint") return Number(value)
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value)
  if (typeof value === "string") {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return Math.floor(numeric)
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000)
  }
  throw new PlatformApiError("MODEL_ROUTING_POLICY_DATA_INVALID", 500)
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new PlatformApiError("MODEL_ROUTING_POLICY_DATA_INVALID", 500)
  }
}

function rowCandidates(row: DatabaseRow): string[] {
  const value = jsonValue(row.candidate_public_model_ids)
  if (!Array.isArray(value) || !value.every((candidate) => typeof candidate === "string")) {
    throw new PlatformApiError("MODEL_ROUTING_POLICY_DATA_INVALID", 500)
  }
  return [...value]
}

function mapPolicy(row: DatabaseRow): ModelRoutingPolicy {
  return validateModelRoutingPolicy({
    tenant_id: rowString(row, "tenant_id"),
    routing_policy_id: rowString(row, "routing_policy_id"),
    owner_organization_id: rowString(row, "owner_organization_id"),
    resource_id: rowString(row, "resource_id"),
    capability_id: rowString(row, "capability_id"),
    routing_revision: rowInteger(row, "routing_revision", 1),
    mode: rowString(row, "mode"),
    default_public_model_id: rowString(row, "default_public_model_id"),
    candidate_public_model_ids: rowCandidates(row),
    session_lease_seconds: rowNullableInteger(row, "session_lease_seconds"),
    context_requirements: jsonValue(row.context_requirements ?? []),
    created_at: rowTimestamp(row, "created_at"),
    updated_at: rowTimestamp(row, "updated_at"),
  })
}

function scopeParameters(key: ModelRoutingPolicyRevisionKey): readonly unknown[] {
  return [
    key.tenantId,
    key.ownerOrganizationId,
    key.resourceId,
    key.capabilityId,
    key.routingRevision,
  ]
}

async function selectPolicy(
  executor: SqlAdapter | SqlTransaction,
  key: ModelRoutingPolicyRevisionKey,
  forUpdate = false,
): Promise<DatabaseRow | null> {
  const result = await executor.query<DatabaseRow>(
    `select ${POLICY_COLUMNS}
       from genio_one_model_routing_policies
      where tenant_id = $1
        and owner_organization_id = $2
        and resource_id = $3
        and capability_id = $4
        and routing_revision = $5${forUpdate ? " for update" : ""}`,
    scopeParameters(key),
  )
  return result.rows[0] ?? null
}

function createKey(tenantId: string, value: CreateModelRoutingPolicyInput): ModelRoutingPolicyRevisionKey {
  return {
    tenantId,
    ownerOrganizationId: value.owner_organization_id,
    resourceId: value.resource_id,
    capabilityId: value.capability_id,
    routingRevision: value.routing_revision,
  }
}

function insertParameters(
  tenantId: string,
  policyId: string,
  value: CreateModelRoutingPolicyInput,
): readonly unknown[] {
  return [
    tenantId,
    policyId,
    value.owner_organization_id,
    value.resource_id,
    value.capability_id,
    value.routing_revision,
    value.mode,
    value.default_public_model_id,
    JSON.stringify(value.candidate_public_model_ids),
    value.session_lease_seconds,
    JSON.stringify(value.context_requirements ?? []),
  ]
}

/** PostgreSQL adapter for immutable, organization-scoped routing policies. */
export function createPostgresModelRoutingPolicyStore(
  options: PostgresModelRoutingPolicyOptions,
): ModelRoutingPolicyStore {
  const idFactory = options.idFactory ?? ((prefix: string) => `${prefix}-${randomUUID()}`)
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000))

  return {
    async save(input: { tenantId: string; value: CreateModelRoutingPolicyInput }) {
      assertTenantId(input.tenantId)
      const value = validateCreateModelRoutingPolicy(input.value)
      const key = createKey(input.tenantId, value)

      return options.sql.transaction(async (transaction) => {
        const resourceResult = await transaction.query<DatabaseRow>(
          `select owner_organization_id
             from genio_one_resources
            where tenant_id = $1 and resource_id = $2
            for update`,
          [input.tenantId, value.resource_id],
        )
        const ownerOrganizationId = resourceResult.rows[0]?.owner_organization_id
        if (typeof ownerOrganizationId !== "string" || !ownerOrganizationId.trim()) {
          throw new PlatformApiError("MODEL_ROUTING_POLICY_RESOURCE_NOT_FOUND", 404)
        }
        if (ownerOrganizationId !== value.owner_organization_id) {
          throw new PlatformApiError(
            "MODEL_ROUTING_POLICY_OWNER_MISMATCH",
            403,
            "The routing policy owner must own the Resource",
          )
        }

        const existing = await selectPolicy(transaction, key, true)
        if (existing) {
          const policy = mapPolicy(existing)
          if (!routingPolicyMatchesInput(policy, value)) {
            throw new PlatformApiError(
              "MODEL_ROUTING_POLICY_REVISION_CONFLICT",
              409,
              "An immutable routing-policy revision already has different content",
            )
          }
          return policy
        }

        const previousRevision = await transaction.query<DatabaseRow>(
          `select routing_policy_id
             from genio_one_model_routing_policies
            where tenant_id = $1
              and owner_organization_id = $2
              and resource_id = $3
              and capability_id = $4
            order by routing_revision desc
            limit 1
            for update`,
          [
            input.tenantId,
            value.owner_organization_id,
            value.resource_id,
            value.capability_id,
          ],
        )
        const routingPolicyId = previousRevision.rows[0]
          ? rowString(previousRevision.rows[0], "routing_policy_id")
          : idFactory("routing-policy")

        const inserted = await transaction.query<DatabaseRow>(
          `insert into genio_one_model_routing_policies
             (tenant_id, routing_policy_id, owner_organization_id, resource_id,
              capability_id, routing_revision, mode, default_public_model_id,
              candidate_public_model_ids, session_lease_seconds, context_requirements)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9::text::jsonb, $10, $11::text::jsonb)
           on conflict (tenant_id, resource_id, capability_id, routing_revision)
           do nothing
           returning ${POLICY_COLUMNS}`,
          insertParameters(input.tenantId, routingPolicyId, value),
        )
        const row = inserted.rows[0]
        if (row) {
          const policy = mapPolicy(row)
          const publication = await transaction.query<DatabaseRow>(
            `select gateway_id
               from genio_one_publications
              where tenant_id = $1 and resource_id = $2
                and publication_state in ('PUBLISHED', 'DEPRECATED')
              order by endpoint_revision desc
              limit 1`,
            [input.tenantId, value.resource_id],
          )
          const gatewayId = publication.rows[0]?.gateway_id
          if (typeof gatewayId === "string" && gatewayId.trim()) {
            if (!options.releasePublisher) {
              throw new PlatformApiError("GATEWAY_RELEASE_PUBLISHER_REQUIRED", 500)
            }
            await options.releasePublisher.reconcileInTransaction({
              transaction,
              tenantId: input.tenantId,
              gatewayId,
              issuedAt: now(),
            })
          }
          return policy
        }

        const raced = await selectPolicy(transaction, key)
        if (!raced) {
          throw new PlatformApiError("MODEL_ROUTING_POLICY_CREATE_FAILED", 500)
        }
        const policy = mapPolicy(raced)
        if (!routingPolicyMatchesInput(policy, value)) {
          throw new PlatformApiError(
            "MODEL_ROUTING_POLICY_REVISION_CONFLICT",
            409,
            "An immutable routing-policy revision already has different content",
          )
        }
        return policy
      })
    },

    async get(key: ModelRoutingPolicyRevisionKey) {
      assertRevisionKey(key)
      const row = await selectPolicy(options.sql, key)
      return row ? mapPolicy(row) : null
    },

    async getLatest(scope: ModelRoutingPolicyScope) {
      assertScope(scope)
      const result = await options.sql.query<DatabaseRow>(
        `select ${POLICY_COLUMNS}
           from genio_one_model_routing_policies
          where tenant_id = $1
            and owner_organization_id = $2
            and resource_id = $3
            and capability_id = $4
          order by routing_revision desc
          limit 1`,
        [scope.tenantId, scope.ownerOrganizationId, scope.resourceId, scope.capabilityId],
      )
      const row = result.rows[0]
      return row ? mapPolicy(row) : null
    },

    async list(input: {
      tenantId: string
      ownerOrganizationId: string
      resourceId?: string
      capabilityId?: string
    }) {
      assertTenantId(input.tenantId)
      assertScopeValue(input.ownerOrganizationId, "ownerOrganizationId")
      const clauses = ["tenant_id = $1", "owner_organization_id = $2"]
      const parameters: unknown[] = [input.tenantId, input.ownerOrganizationId]
      if (input.resourceId !== undefined) {
        assertScopeValue(input.resourceId, "resourceId")
        parameters.push(input.resourceId)
        clauses.push(`resource_id = $${parameters.length}`)
      }
      if (input.capabilityId !== undefined) {
        assertScopeValue(input.capabilityId, "capabilityId")
        parameters.push(input.capabilityId)
        clauses.push(`capability_id = $${parameters.length}`)
      }
      const result = await options.sql.query<DatabaseRow>(
        `select ${POLICY_COLUMNS}
           from genio_one_model_routing_policies
          where ${clauses.join(" and ")}
          order by resource_id, capability_id, routing_revision desc, routing_policy_id`,
        parameters,
      )
      return result.rows.map(mapPolicy)
    },
  }
}
