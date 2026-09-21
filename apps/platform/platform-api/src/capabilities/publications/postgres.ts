import { randomUUID } from "node:crypto"

import { canonicalJson } from "@genioone/protocol/canonical"

import { Check } from "typebox/value"

import type { SqlAdapter, SqlTransaction } from "../../persistence/sql-adapter"
import { PlatformApiError, type PlatformApiViolation } from "../errors"
import {
  canonicalizeApiRequestMapping,
  canonicalizeDownstreamIdentity,
  type ApiUpstreamRequestMapping,
  type DownstreamIdentityProjection,
} from "../connections/contract"
import { connectionCertificateFromStored } from "../connections/certificate"
import {
  GatewayProjectionSchema,
  GatewayProjectionSnapshotSchema,
  type GatewayProjection,
  type GatewayProjectionSnapshot,
} from "../gateway-projection/contract"
import type { ResourcePublicationRequest } from "../resources/publication-types"
import type { ResourceRegistry } from "../resources/module"
import type { GatewayPublicationDelivery } from "../gateway-policy-release/delivery"
import { mapProviderCredentialProfileRow, PROVIDER_CREDENTIAL_PROFILE_COLUMNS } from "../provider-credentials/postgres"
import { canonicalEnforcementChainDigest } from "../enforcement/compiler"
import { snapshotDigestMatches } from "./snapshot-digest"
import { ensurePublicationSuccessorInTransaction } from "./successor"
import { lockGatewayPolicyRelease } from "../gateway-policy-release/transaction-lock"
import type {
  PublicationBuildClaim,
  PublicationReference,
  PublicationWorkflowStore,
} from "./module"

type DatabaseRow = Record<string, unknown>

export interface PostgresPublicationWorkflowStoreOptions {
  sql: SqlAdapter
  resources: ResourceRegistry
  now?: () => number
  idFactory?: (prefix: string) => string
  gatewayPublicationDelivery: GatewayPublicationDelivery
}

const PUBLICATION_COLUMNS = `
  tenant_id,
  publication_id,
  resource_id,
  endpoint_revision,
  resource_revision,
  resource_digest,
  policy_revision,
  gateway_id,
  hostname,
  base_path,
  visibility,
  publication_state,
  dns_management,
  dns_proof_status,
  dns_proof,
  request_snapshot,
  review_snapshot,
  publication_snapshot,
  publication_build_state,
  build_attempt_id,
  last_error_code,
  projection_digest,
  row_revision,
  created_at,
  updated_at`

function jsonValue(value: unknown, code: string): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new PlatformApiError(code, 500)
  }
}

function jsonObject(value: unknown, code: string): Record<string, unknown> {
  const parsed = jsonValue(value, code)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PlatformApiError(code, 500)
  }
  return parsed as Record<string, unknown>
}

function rowString(row: DatabaseRow, key: string, code = "PUBLICATION_DATA_INVALID"): string {
  const value = row[key]
  if (typeof value !== "string" || !value.trim()) throw new PlatformApiError(code, 500)
  return value
}

function optionalRowString(row: DatabaseRow, key: string): string | null {
  const value = row[key]
  if (value === null || value === undefined) return null
  if (typeof value !== "string") throw new PlatformApiError("PUBLICATION_DATA_INVALID", 500)
  return value
}

function rowNumber(row: DatabaseRow, key: string): number {
  const value = row[key]
  const number =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number(value)
          : Number.NaN
  if (!Number.isSafeInteger(number)) throw new PlatformApiError("PUBLICATION_DATA_INVALID", 500)
  return number
}

function rowTimestamp(row: DatabaseRow, key: string): number {
  const value = row[key]
  if (value instanceof Date) return Math.floor(value.getTime() / 1000)
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value)
  if (typeof value === "bigint") return Number(value)
  if (typeof value === "string") {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return Math.floor(numeric)
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000)
  }
  throw new PlatformApiError("PUBLICATION_DATA_INVALID", 500)
}

function parseSnapshot(value: unknown): GatewayProjectionSnapshot {
  const parsed = jsonValue(value, "PUBLICATION_SNAPSHOT_INVALID")
  if (!Check(GatewayProjectionSnapshotSchema, parsed)) {
    throw new PlatformApiError("PUBLICATION_SNAPSHOT_INVALID", 500)
  }
  const snapshot = parsed as GatewayProjectionSnapshot
  if (!snapshotDigestMatches(snapshot, snapshot.snapshot_digest)) {
    throw new PlatformApiError("PUBLICATION_SNAPSHOT_INVALID", 500)
  }
  return snapshot
}

function parseProjection(value: unknown): GatewayProjection {
  const parsed = jsonValue(value, "GATEWAY_PROJECTION_INVALID")
  if (!Check(GatewayProjectionSchema, parsed)) {
    throw new PlatformApiError("GATEWAY_PROJECTION_INVALID", 500)
  }
  return parsed as GatewayProjection
}

function parseRequest(row: DatabaseRow): ResourcePublicationRequest | null {
  const request = jsonObject(row.request_snapshot, "PUBLICATION_REQUEST_INVALID")
  if (typeof request.request_id !== "string" || !request.request_id.trim()) return null
  const review = jsonObject(row.review_snapshot, "PUBLICATION_REVIEW_INVALID")
  const state = request.state
  if (!["PENDING", "APPROVED", "REJECTED", "CANCELLED"].includes(String(state))) {
    throw new PlatformApiError("PUBLICATION_REQUEST_INVALID", 500)
  }
  const buildState = rowString(row, "publication_build_state")
  if (!["IDLE", "PENDING_REVIEW", "BUILDING", "FAILED", "READY"].includes(buildState)) {
    throw new PlatformApiError("PUBLICATION_REQUEST_INVALID", 500)
  }
  return {
    request_id: request.request_id,
    state: state as ResourcePublicationRequest["state"],
    requested_by: String(request.requested_by),
    requested_at: Number(request.requested_at),
    reviewed_by: review.reviewed_by === null || review.reviewed_by === undefined
      ? null
      : String(review.reviewed_by),
    reviewed_at: review.reviewed_at === null || review.reviewed_at === undefined
      ? null
      : Number(review.reviewed_at),
    publication_state: buildState as NonNullable<ResourcePublicationRequest["publication_state"]>,
    attempt_id: optionalRowString(row, "build_attempt_id"),
    failure_code: optionalRowString(row, "last_error_code"),
  }
}

async function publicationByResource(
  executor: SqlAdapter | SqlTransaction,
  tenantId: string,
  resourceId: string,
  forUpdate = false,
): Promise<DatabaseRow | null> {
  const result = await executor.query<DatabaseRow>(
    `select ${PUBLICATION_COLUMNS}
       from genio_one_publications
      where tenant_id = $1 and resource_id = $2
      order by endpoint_revision desc
      limit 1${forUpdate ? " for update" : ""}`,
    [tenantId, resourceId],
  )
  return result.rows[0] ?? null
}

async function publicationById(
  executor: SqlAdapter | SqlTransaction,
  tenantId: string,
  publicationId: string,
  forUpdate = false,
): Promise<DatabaseRow | null> {
  const result = await executor.query<DatabaseRow>(
    `select ${PUBLICATION_COLUMNS}
       from genio_one_publications
      where tenant_id = $1 and publication_id = $2${forUpdate ? " for update" : ""}`,
    [tenantId, publicationId],
  )
  return result.rows[0] ?? null
}

function assertRequest(row: DatabaseRow, requestId: string): ResourcePublicationRequest {
  const request = parseRequest(row)
  if (!request || request.request_id !== requestId) {
    throw new PlatformApiError("PUBLICATION_REQUEST_NOT_FOUND", 404)
  }
  return request
}

function assertSnapshotIdentity(
  row: DatabaseRow,
  snapshot: GatewayProjectionSnapshot,
  allowUnboundPolicyRevision = false,
  allowUnboundResourceDigest = false,
): void {
  const persistedPolicyRevision = rowNumber(row, "policy_revision")
  const violations: PlatformApiViolation[] = []
  const requireMatch = (matches: boolean, field: string, code: string, message: string) => {
    if (!matches) violations.push({ code, field, message })
  }
  requireMatch(
    rowString(row, "tenant_id") === snapshot.tenant_id &&
      rowString(row, "publication_id") === snapshot.publication_id &&
      rowString(row, "resource_id") === snapshot.resource_id,
    "publication",
    "PUBLICATION_IDENTITY_CHANGED",
    "The publication identity changed while the review snapshot was prepared",
  )
  requireMatch(
    rowNumber(row, "endpoint_revision") === snapshot.endpoint_revision,
    "publication_endpoint",
    "PUBLICATION_ENDPOINT_REVISION_CHANGED",
    "The publication endpoint changed while the review snapshot was prepared",
  )
  requireMatch(
    rowNumber(row, "resource_revision") === snapshot.resource_revision,
    "resource",
    "RESOURCE_REVISION_CHANGED",
    "The Resource changed while the review snapshot was prepared",
  )
  requireMatch(
    allowUnboundResourceDigest || rowString(row, "resource_digest") === snapshot.resource_digest,
    "resource",
    "RESOURCE_CONTENT_CHANGED",
    "The Resource content changed while the review snapshot was prepared",
  )
  requireMatch(
    persistedPolicyRevision === snapshot.policy_revision ||
      (allowUnboundPolicyRevision && persistedPolicyRevision === 0),
    "enforcement_chain",
    "ENFORCEMENT_CHAIN_REVISION_CHANGED",
    "The Enforcement Chain changed while the review snapshot was prepared",
  )
  requireMatch(
    rowString(row, "gateway_id") === snapshot.publication_endpoint.gateway_id &&
      rowString(row, "hostname") === snapshot.publication_endpoint.hostname &&
      rowString(row, "base_path") === snapshot.publication_endpoint.base_path,
    "publication_endpoint",
    "PUBLICATION_ROUTE_CHANGED",
    "The publication route changed while the review snapshot was prepared",
  )
  if (violations.length > 0) {
    throw new PlatformApiError(
      "PUBLICATION_SNAPSHOT_STALE",
      409,
      "Publication settings changed while the review snapshot was prepared",
      violations,
    )
  }
}

function mapConnectionRow(row: DatabaseRow): GatewayProjectionSnapshot["connections"][number] {
  const downstream = jsonObject(row.downstream_identity, "CONNECTION_DATA_INVALID")
  const identity = canonicalizeDownstreamIdentity(downstream as DownstreamIdentityProjection)
  if (!identity) {
    throw new PlatformApiError("CONNECTION_DATA_INVALID", 500)
  }
  const connectionKind = rowString(row, "connection_kind") as GatewayProjectionSnapshot["connections"][number]["connection_kind"]
  const requestMapping = connectionKind === "API"
    ? canonicalizeApiRequestMapping(
        jsonObject(row.request_mapping, "CONNECTION_DATA_INVALID") as ApiUpstreamRequestMapping,
      )
    : null
  const providerCredentialProfileId = optionalRowString(row, "provider_credential_profile_id")
  const providerCredentialProfileRevision = row.provider_credential_profile_revision === null || row.provider_credential_profile_revision === undefined
    ? null
    : rowNumber(row, "provider_credential_profile_revision")
  const providerCredentialStrategyDigest = optionalRowString(row, "provider_credential_strategy_digest")
  return {
    ...(row.connector_configuration !== null && row.connector_configuration !== undefined
      ? { connector_configuration: jsonObject(row.connector_configuration, "CONNECTION_DATA_INVALID") as NonNullable<GatewayProjectionSnapshot["connections"][number]["connector_configuration"]> }
      : {}),
    tenant_id: rowString(row, "tenant_id"),
    connection_id: rowString(row, "connection_id"),
    resource_id: rowString(row, "resource_id"),
    display_name: rowString(row, "display_name"),
    connection_kind: connectionKind,
    provider_type: optionalRowString(row, "provider_type") as GatewayProjectionSnapshot["connections"][number]["provider_type"],
    provider_profile_id: optionalRowString(row, "provider_profile_id"),
    endpoint: rowString(row, "endpoint"),
    mcp_tool_namespace: optionalRowString(row, "mcp_tool_namespace"),
    mcp_selected_tools: stringArray(row.mcp_selected_tools, "CONNECTION_DATA_INVALID"),
    mcp_tool_selection_operation_id: optionalRowString(row, "mcp_tool_selection_operation_id"),
    credential_ref: optionalRowString(row, "credential_ref"),
    provider_credential_profile: providerCredentialProfileId && providerCredentialProfileRevision && providerCredentialStrategyDigest
      ? {
          profile_id: providerCredentialProfileId,
          revision: providerCredentialProfileRevision,
          strategy_digest: providerCredentialStrategyDigest,
        }
      : null,
    downstream_identity: identity,
    request_mapping: requestMapping,
    certificate: connectionCertificateFromStored({
      mode: row.certificate_mode ?? "SYSTEM_CA",
      certificate_pem: row.certificate_pem,
      fingerprint_sha256: row.certificate_fingerprint_sha256,
      subject: row.certificate_subject,
      issuer: row.certificate_issuer,
      is_self_signed: row.certificate_is_self_signed,
      not_before: row.certificate_not_before,
      not_after: row.certificate_not_after,
    }),
    status: rowString(row, "status") as GatewayProjectionSnapshot["connections"][number]["status"],
    configuration_revision: rowNumber(row, "configuration_revision"),
    lifecycle: rowString(row, "lifecycle") as GatewayProjectionSnapshot["connections"][number]["lifecycle"],
    revoke_requested_after_release_revision: row.revoke_requested_after_release_revision === null
      ? null
      : rowNumber(row, "revoke_requested_after_release_revision"),
    verification_state: rowString(row, "verification_state") as GatewayProjectionSnapshot["connections"][number]["verification_state"],
    health_state: rowString(row, "health_state") as GatewayProjectionSnapshot["connections"][number]["health_state"],
    health_observed_at: row.health_observed_at === null ? null : rowTimestamp(row, "health_observed_at"),
    health_source_revision: row.health_source_revision === null ? null : rowNumber(row, "health_source_revision"),
    routing_priority: rowNumber(row, "routing_priority"),
    region: optionalRowString(row, "region"),
    supported_obligations: stringArray(row.supported_obligations, "CONNECTION_DATA_INVALID"),
    created_at: rowTimestamp(row, "created_at"),
  }
}


function stringArray(value: unknown, code: string): string[] {
  const parsed = jsonValue(value, code)
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new PlatformApiError(code, 500)
  }
  return parsed as string[]
}

function mapModelRow(row: DatabaseRow): GatewayProjectionSnapshot["models"][number] {
  return {
    tenant_id: rowString(row, "tenant_id"),
    model_id: rowString(row, "model_id"),
    model_name: rowString(row, "model_name"),
    display_name: rowString(row, "display_name"),
    resource_id: rowString(row, "resource_id"),
    visibility: rowString(row, "visibility") as GatewayProjectionSnapshot["models"][number]["visibility"],
    lifecycle: rowString(row, "lifecycle") as GatewayProjectionSnapshot["models"][number]["lifecycle"],
    capabilities: stringArray(row.capabilities, "PUBLIC_MODEL_DATA_INVALID") as GatewayProjectionSnapshot["models"][number]["capabilities"],
    created_at: rowTimestamp(row, "created_at"),
  }
}

function mapMappingRow(row: DatabaseRow): GatewayProjectionSnapshot["model_mappings"][number] {
  return {
    tenant_id: rowString(row, "tenant_id"),
    mapping_id: rowString(row, "mapping_id"),
    public_model_id: rowString(row, "public_model_id"),
    resource_id: rowString(row, "resource_id"),
    connection_id: rowString(row, "connection_id"),
    provider_model: rowString(row, "provider_model"),
    mapping_revision: rowNumber(row, "mapping_revision"),
    created_at: rowTimestamp(row, "created_at"),
  }
}

function sameSet<T>(current: T[], frozen: T[], identity: (value: T) => string): boolean {
  if (current.length !== frozen.length) return false
  const byId = new Map(frozen.map((value) => [identity(value), value]))
  return current.every((value) => {
    const other = byId.get(identity(value))
    return other !== undefined && canonicalJson(value) === canonicalJson(other)
  })
}

async function assertFrozenInputs(
  transaction: SqlTransaction,
  row: DatabaseRow,
  snapshot: GatewayProjectionSnapshot,
): Promise<void> {
  const stale = (field: string, code: string, message: string): never => {
    throw new PlatformApiError("PUBLICATION_SNAPSHOT_STALE", 409, message, [{ field, code, message }])
  }
  assertSnapshotIdentity(row, snapshot)
  const resourceResult = await transaction.query<DatabaseRow>(
    `select tenant_id, resource_id, lifecycle, row_revision
       from genio_one_resources
      where tenant_id = $1 and resource_id = $2
      for update`,
    [snapshot.tenant_id, snapshot.resource_id],
  )
  const resource = resourceResult.rows[0]
  if (
    !resource ||
    (resource.lifecycle !== "DRAFT" && resource.lifecycle !== "PUBLISHED") ||
    rowNumber(resource, "row_revision") !== snapshot.resource_revision
  ) {
    stale("resource", "RESOURCE_REVISION_CHANGED", "The Resource changed after the publication snapshot was prepared")
  }

  const connectionResult = await transaction.query<DatabaseRow>(
    `select tenant_id, connection_id, resource_id, display_name, connection_kind,
            provider_type, provider_profile_id, endpoint, mcp_tool_namespace,
            mcp_selected_tools, mcp_tool_selection_operation_id, credential_ref,
            provider_credential_profile_id, provider_credential_profile_revision,
            provider_credential_strategy_digest,
            downstream_identity, request_mapping, connector_configuration,
            certificate_mode, certificate_pem,
            certificate_fingerprint_sha256, certificate_subject, certificate_issuer,
            certificate_is_self_signed, certificate_not_before, certificate_not_after,
            status, configuration_revision,
            lifecycle, revoke_requested_after_release_revision,
            verification_state, health_state, health_observed_at,
            health_source_revision, routing_priority, region, supported_obligations, created_at
       from genio_one_resource_connections
      where tenant_id = $1 and resource_id = $2
        and connection_id = any($3::text[])
      order by connection_id
      for update`,
    [snapshot.tenant_id, snapshot.resource_id, snapshot.connections.map((value) => value.connection_id)],
  )
  const currentConnections = connectionResult.rows.map(mapConnectionRow)
  if (!sameSet(currentConnections, snapshot.connections, (value) => value.connection_id)) {
    stale("connections", "CONNECTION_SET_CHANGED", "The Connection set changed after the publication snapshot was prepared")
  }

  const profileSnapshots = snapshot.provider_credential_profiles ?? []
  const profileResult = profileSnapshots.length === 0
    ? { rows: [] as DatabaseRow[] }
    : await transaction.query<DatabaseRow>(
        `select ${PROVIDER_CREDENTIAL_PROFILE_COLUMNS}
           from genio_one_provider_credential_profile_revisions
          where tenant_id = $1
            and (profile_id, revision) in (
              select * from unnest($2::text[], $3::bigint[])
            )
          order by profile_id, revision
          for update`,
        [
          snapshot.tenant_id,
          profileSnapshots.map((profile) => profile.profile_id),
          profileSnapshots.map((profile) => profile.revision),
        ],
      )
  const currentProfiles = profileResult.rows.map(mapProviderCredentialProfileRow)
  if (!sameSet(currentProfiles, profileSnapshots, (value) => `${value.profile_id}:${value.revision}`)) {
    const frozenById = new Map(profileSnapshots.map((value) => [`${value.profile_id}:${value.revision}`, value]))
    const changed = currentProfiles.find((value) => {
      const frozen = frozenById.get(`${value.profile_id}:${value.revision}`)
      return frozen === undefined || canonicalJson(value) !== canonicalJson(frozen)
    })
    const frozen = changed ? frozenById.get(`${changed.profile_id}:${changed.revision}`) : undefined
    const fields = changed && frozen
      ? Object.keys(changed).filter((key) => canonicalJson(changed[key as keyof typeof changed]) !== canonicalJson(frozen[key as keyof typeof frozen]))
      : []
    const subject = changed
      ? `${changed.profile_id}:${changed.revision}${fields.length ? ` fields=${fields.join(",")}` : ""}`
      : `${currentProfiles.length}/${profileSnapshots.length}`
    stale("provider_credential_profiles", "PROVIDER_CREDENTIAL_PROFILE_SET_CHANGED", `Provider Credential Profile ${subject} changed after the publication snapshot was prepared`)
  }
  if (profileSnapshots.length > 0) {
    const latestResult = await transaction.query<DatabaseRow>(
      `select profile_id, revision, state
         from genio_one_provider_credential_profile_revisions
        where tenant_id = $1 and profile_id = any($2::text[])
        order by profile_id, revision desc
        for update`,
      [snapshot.tenant_id, profileSnapshots.map((profile) => profile.profile_id)],
    )
    const latestByProfile = new Map<string, DatabaseRow>()
    for (const profile of latestResult.rows) {
      const profileId = rowString(profile, "profile_id")
      if (!latestByProfile.has(profileId)) latestByProfile.set(profileId, profile)
    }
    if (profileSnapshots.some((profile) => latestByProfile.get(profile.profile_id)?.state !== "ACTIVE")) {
      stale("provider_credential_profiles", "PROVIDER_CREDENTIAL_PROFILE_REVOKED", "A Provider Credential Profile became inactive after the publication snapshot was prepared")
    }
  }

  const modelResult = await transaction.query<DatabaseRow>(
    `select tenant_id, model_id, model_name, display_name, resource_id,
            visibility, lifecycle, capabilities, created_at
       from genio_one_public_models
      where tenant_id = $1 and resource_id = $2
        and visibility = 'PUBLIC' and lifecycle = 'PUBLISHED'
      order by model_id
      for update`,
    [snapshot.tenant_id, snapshot.resource_id],
  )
  const currentModels = modelResult.rows.map(mapModelRow)
  if (!sameSet(currentModels, snapshot.models, (value) => value.model_id)) {
    stale("models", "PUBLIC_MODEL_SET_CHANGED", "The Public Model set changed after the publication snapshot was prepared")
  }

  const mappingResult = await transaction.query<DatabaseRow>(
    `select tenant_id, mapping_id, public_model_id, resource_id, connection_id,
            provider_model, mapping_revision, created_at
       from genio_one_connection_model_mappings
      where tenant_id = $1 and resource_id = $2
        and public_model_id = any($3::text[])
        and connection_id = any($4::text[])
      order by mapping_id
      for update`,
    [
      snapshot.tenant_id,
      snapshot.resource_id,
      snapshot.models.map((value) => value.model_id),
      snapshot.connections.map((value) => value.connection_id),
    ],
  )
  const currentMappings = mappingResult.rows.map(mapMappingRow)
  if (!sameSet(currentMappings, snapshot.model_mappings, (value) => value.mapping_id)) {
    stale("model_mappings", "MODEL_MAPPING_SET_CHANGED", "The model mapping set changed after the publication snapshot was prepared")
  }

  const chainResult = await transaction.query<DatabaseRow>(
    `select one_policy_revision, chain, chain_digest
       from genio_one_enforcement_chain_revisions
      where tenant_id = $1 and resource_id = $2 and capability_id = $3
      order by one_policy_revision desc
      limit 1
      for update`,
    [snapshot.tenant_id, snapshot.resource_id, snapshot.capability_id],
  )
  const chain = chainResult.rows[0]
  if (
    !chain ||
    rowNumber(chain, "one_policy_revision") !== snapshot.policy_revision ||
    rowString(chain, "chain_digest") !== canonicalEnforcementChainDigest(snapshot.one_policy_chain) ||
    canonicalJson(jsonValue(chain.chain, "ENFORCEMENT_CHAIN_DATA_INVALID")) !==
      canonicalJson(snapshot.one_policy_chain)
  ) {
    stale("enforcement_chain", "ENFORCEMENT_CHAIN_CHANGED", "The Enforcement Chain changed after the publication snapshot was prepared")
  }
}

function reviewJson(reviewerId: string, reviewedAt: number): string {
  return JSON.stringify({ reviewed_by: reviewerId, reviewed_at: reviewedAt })
}

/** PostgreSQL implementation of the two-transaction publication build. */
export function createPostgresPublicationWorkflowStore(
  options: PostgresPublicationWorkflowStoreOptions,
): PublicationWorkflowStore {
  if (!options.gatewayPublicationDelivery) {
    throw new PlatformApiError(
      "PUBLICATION_DELIVERY_REQUIRED",
      500,
      "PostgreSQL Publication commits require runtime delivery",
    )
  }
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const idFactory = options.idFactory ?? ((prefix: string) => `${prefix}-${randomUUID()}`)

  return {
    async preparePublicationReference(input): Promise<PublicationReference | null> {
      return options.sql.transaction(async (transaction) => {
        const successor = await ensurePublicationSuccessorInTransaction({
          transaction,
          tenantId: input.tenantId,
          resourceId: input.resourceId,
          idFactory,
        })
        if (successor) return successor
        const row = await publicationByResource(transaction, input.tenantId, input.resourceId, true)
        if (!row) return null
        return {
          publicationId: rowString(row, "publication_id"),
          endpointRevision: rowNumber(row, "endpoint_revision"),
          resourceRevision: rowNumber(row, "resource_revision"),
          resourceDigest: rowString(row, "resource_digest"),
        }
      })
    },

    async getSnapshot(input) {
      const row = await publicationById(options.sql, input.tenantId, input.publicationId)
      if (!row) return null
      return parseSnapshot(row.publication_snapshot)
    },

    async getProjection(input) {
      const result = await options.sql.query<DatabaseRow>(
        `select payload
           from genio_one_gateway_projections
          where tenant_id = $1 and projection_id = $2`,
        [input.tenantId, input.projectionId],
      )
      const row = result.rows[0]
      if (!row) return null
      const projection = parseProjection(row.payload)
      if (
        projection.tenant_id !== input.tenantId ||
        projection.projection_id !== input.projectionId
      ) {
        throw new PlatformApiError("GATEWAY_PROJECTION_INVALID", 500)
      }
      return projection
    },

    async getRequest(input) {
      const row = await publicationByResource(options.sql, input.tenantId, input.resourceId)
      if (!row) return null
      const request = parseRequest(row)
      return request?.request_id === input.requestId ? request : null
    },

    async saveReviewSnapshot(input) {
      return options.sql.transaction(async (transaction) => {
        const row = await publicationById(
          transaction,
          input.tenantId,
          input.snapshot.publication_id,
          true,
        )
        if (!row || rowString(row, "resource_id") !== input.resourceId) {
          throw new PlatformApiError("PUBLICATION_NOT_FOUND", 404)
        }
        // A newly configured endpoint is not bound to a policy revision until
        // its first immutable review snapshot is saved.
        const existingSnapshot = jsonObject(row.publication_snapshot, "PUBLICATION_SNAPSHOT_INVALID")
        assertSnapshotIdentity(row, input.snapshot, true, Object.keys(existingSnapshot).length === 0)
        if (Object.keys(existingSnapshot).length > 0) {
          const existing = parseSnapshot(existingSnapshot)
          if (existing.snapshot_digest !== input.snapshot.snapshot_digest) {
            throw new PlatformApiError("PUBLICATION_SNAPSHOT_IMMUTABLE", 409)
          }
          const existingRequest = parseRequest(row)
          if (!existingRequest) throw new PlatformApiError("PUBLICATION_REQUEST_INVALID", 500)
          return existingRequest
        }
        const request = {
          ...input.request,
          state: "PENDING" as const,
          publication_state: "PENDING_REVIEW" as const,
          reviewed_by: null,
          reviewed_at: null,
          attempt_id: null,
          failure_code: null,
        }
        const result = await transaction.query<DatabaseRow>(
          `update genio_one_publications
              set policy_revision = $3,
                  resource_digest = $4,
                  request_snapshot = $5::text::jsonb,
                  review_snapshot = '{}'::jsonb,
                  publication_snapshot = $6::text::jsonb,
                  publication_state = 'PENDING_REVIEW',
                  publication_build_state = 'PENDING_REVIEW',
                  build_attempt_id = null,
                  last_error_code = null,
                  projection_digest = null,
                  row_revision = row_revision + 1,
                  updated_at = now()
            where tenant_id = $1 and publication_id = $2
              and publication_state = 'DRAFT'
            returning ${PUBLICATION_COLUMNS}`,
          [
            input.tenantId,
            input.snapshot.publication_id,
            input.snapshot.policy_revision,
            input.snapshot.resource_digest,
            JSON.stringify(request),
            JSON.stringify(input.snapshot),
          ],
        )
        const updated = result.rows[0]
        if (!updated) throw new PlatformApiError("PUBLICATION_REVIEW_CONFLICT", 409)
        return parseRequest(updated) ?? request
      })
    },

    async claimBuild(input): Promise<PublicationBuildClaim> {
      return options.sql.transaction(async (transaction) => {
        const row = await publicationByResource(transaction, input.tenantId, input.resourceId, true)
        if (!row) throw new PlatformApiError("PUBLICATION_NOT_FOUND", 404)
        const request = assertRequest(row, input.requestId)
        const snapshot = parseSnapshot(row.publication_snapshot)
        if (request.publication_state === "READY") {
          return { attemptId: request.attempt_id ?? "", snapshot, state: "READY" }
        }
        if (request.publication_state === "BUILDING") {
          throw new PlatformApiError("PUBLICATION_BUILD_IN_PROGRESS", 409)
        }
        if (request.state !== "PENDING") {
          throw new PlatformApiError("PUBLICATION_REQUEST_NOT_PENDING", 409)
        }
        const attemptId = idFactory("publication-attempt")
        await transaction.query(
          `insert into genio_one_publication_build_attempts
             (tenant_id, publication_id, attempt_id, request_id, snapshot_digest,
              state, claimed_by, claimed_at)
           values ($1, $2, $3, $4, $5, 'BUILDING', $6, to_timestamp($7))`,
          [
            input.tenantId,
            snapshot.publication_id,
            attemptId,
            input.requestId,
            snapshot.snapshot_digest,
            input.reviewerId,
            input.reviewedAt,
          ],
        )
        const updated = await transaction.query(
          `update genio_one_publications
              set publication_build_state = 'BUILDING',
                  build_attempt_id = $3,
                  last_error_code = null,
                  review_snapshot = $4::text::jsonb,
                  row_revision = row_revision + 1,
                  updated_at = now()
            where tenant_id = $1 and publication_id = $2
              and publication_build_state in ('PENDING_REVIEW', 'FAILED')`,
          [input.tenantId, snapshot.publication_id, attemptId, reviewJson(input.reviewerId, input.reviewedAt)],
        )
        if (updated.rowCount !== 1) throw new PlatformApiError("PUBLICATION_BUILD_CONFLICT", 409)
        return { attemptId, snapshot, state: "BUILDING" }
      })
    },

    async markBuildFailed(input) {
      await options.sql.transaction(async (transaction) => {
        const row = await publicationByResource(transaction, input.tenantId, input.resourceId, true)
        if (!row || rowString(row, "build_attempt_id") !== input.attemptId) return
        const request = assertRequest(row, input.requestId)
        if (request.publication_state !== "BUILDING") return
        await transaction.query(
          `update genio_one_publication_build_attempts
              set state = 'FAILED', failure_code = $4, completed_at = to_timestamp($5)
            where tenant_id = $1 and publication_id = $2 and attempt_id = $3
              and state = 'BUILDING'`,
          [input.tenantId, rowString(row, "publication_id"), input.attemptId, input.failureCode, now()],
        )
        await transaction.query(
          `update genio_one_publications
              set publication_build_state = 'FAILED', last_error_code = $3,
                  row_revision = row_revision + 1, updated_at = now()
            where tenant_id = $1 and publication_id = $2
              and build_attempt_id = $4 and publication_build_state = 'BUILDING'`,
          [input.tenantId, rowString(row, "publication_id"), input.failureCode, input.attemptId],
        )
      })
    },

    async reject(input) {
      await options.sql.transaction(async (transaction) => {
        const row = await publicationByResource(transaction, input.tenantId, input.resourceId, true)
        if (!row) throw new PlatformApiError("PUBLICATION_NOT_FOUND", 404)
        const request = assertRequest(row, input.requestId)
        if (request.state !== "PENDING" || request.publication_state === "BUILDING") {
          throw new PlatformApiError("PUBLICATION_REQUEST_NOT_PENDING", 409)
        }
        const rejected = { ...request, state: "REJECTED", publication_state: "IDLE" }
        const updated = await transaction.query(
          `update genio_one_publications
              set request_snapshot = $3::text::jsonb,
                  review_snapshot = $4::text::jsonb,
                  publication_snapshot = '{}'::jsonb,
                  policy_revision = 0,
                  publication_state = 'DRAFT',
                  publication_build_state = 'IDLE',
                  build_attempt_id = null,
                  last_error_code = null,
                  row_revision = row_revision + 1,
                  updated_at = now()
            where tenant_id = $1 and publication_id = $2
              and publication_build_state in ('PENDING_REVIEW', 'FAILED')`,
          [
            input.tenantId,
            rowString(row, "publication_id"),
            JSON.stringify(rejected),
            reviewJson(input.reviewerId, input.reviewedAt),
          ],
        )
        if (updated.rowCount !== 1) throw new PlatformApiError("PUBLICATION_REVIEW_CONFLICT", 409)
      })
      return options.resources.getResource(input)
    },

    async commitBuild(input) {
      if (!Check(GatewayProjectionSchema, input.projection)) {
        throw new PlatformApiError("GATEWAY_PROJECTION_INVALID", 500)
      }
      await options.sql.transaction(async (transaction) => {
        const identity = await publicationByResource(transaction, input.tenantId, input.resourceId)
        if (!identity) throw new PlatformApiError("PUBLICATION_NOT_FOUND", 404)
        const gatewayId = rowString(identity, "gateway_id")
        await lockGatewayPolicyRelease({ transaction, tenantId: input.tenantId, gatewayId })
        const resourceLock = await transaction.query<DatabaseRow>(
          `select resource_id
             from genio_one_resources
            where tenant_id = $1 and resource_id = $2
            for update`,
          [input.tenantId, input.resourceId],
        )
        if (!resourceLock.rows[0]) throw new PlatformApiError("PUBLICATION_NOT_FOUND", 404)
        const row = await publicationByResource(transaction, input.tenantId, input.resourceId, true)
        if (!row) throw new PlatformApiError("PUBLICATION_NOT_FOUND", 404)
        const request = assertRequest(row, input.requestId)
        if (
          request.state !== "PENDING" ||
          request.publication_state !== "BUILDING" ||
          request.attempt_id !== input.attemptId
        ) {
          throw new PlatformApiError("PUBLICATION_BUILD_NOT_ACTIVE", 409)
        }
        const snapshot = parseSnapshot(row.publication_snapshot)
        if (
          input.projection.tenant_id !== input.tenantId ||
          input.projection.publication_id !== snapshot.publication_id ||
          input.projection.resource_id !== snapshot.resource_id ||
          input.projection.capability_id !== snapshot.capability_id ||
          input.projection.endpoint_revision !== snapshot.endpoint_revision ||
          input.projection.policy_revision !== snapshot.policy_revision ||
          input.projection.publication_endpoint.gateway_id !== snapshot.publication_endpoint.gateway_id ||
          input.projection.publication_endpoint.hostname !== snapshot.publication_endpoint.hostname ||
          input.projection.publication_endpoint.base_path !== snapshot.publication_endpoint.base_path
        ) {
          throw new PlatformApiError("PROJECTION_SNAPSHOT_MISMATCH", 409)
        }
        if (snapshot.publication_endpoint.gateway_id !== gatewayId) {
          throw new PlatformApiError("PROJECTION_SNAPSHOT_MISMATCH", 409)
        }
        await assertFrozenInputs(transaction, row, snapshot)

        const existingProjection = await transaction.query<DatabaseRow>(
          `select digest
             from genio_one_gateway_projections
            where tenant_id = $1 and projection_id = $2
            for update`,
          [input.tenantId, input.projection.projection_id],
        )
        const existing = existingProjection.rows[0]
        if (existing && rowString(existing, "digest") !== input.projection.digest) {
          throw new PlatformApiError("GATEWAY_PROJECTION_IMMUTABLE", 409)
        }
        if (!existing) {
          await transaction.query(
            `insert into genio_one_gateway_projections
               (tenant_id, projection_id, resource_id, capability_id, revision,
                resource_revision, policy_revision, digest, signature, payload,
                publication_id, endpoint_revision)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9::text::jsonb, $10::text::jsonb, $11, $12)`,
            [
              input.tenantId,
              input.projection.projection_id,
              input.resourceId,
              input.projection.capability_id,
              input.projection.revision,
              snapshot.resource_revision,
              input.projection.policy_revision,
              input.projection.digest,
              JSON.stringify(input.projection.signature),
              JSON.stringify(input.projection),
              input.projection.publication_id,
              input.projection.endpoint_revision,
            ],
          )
        }

        await options.gatewayPublicationDelivery.deliverInTransaction({
          transaction,
          tenantId: input.tenantId,
          gatewayId: snapshot.publication_endpoint.gateway_id,
          projection: input.projection,
          issuedAt: input.reviewedAt,
        })

        const approved = {
          ...request,
          state: "APPROVED",
          publication_state: "READY",
          reviewed_by: input.reviewerId,
          reviewed_at: input.reviewedAt,
          failure_code: null,
        }
        if (snapshot.resource.lifecycle === "DRAFT") {
          const resourceUpdate = await transaction.query(
            `update genio_one_resources
                set lifecycle = 'PUBLISHED', row_revision = row_revision + 1, updated_at = now()
              where tenant_id = $1 and resource_id = $2
                and lifecycle = 'DRAFT' and row_revision = $3`,
            [input.tenantId, input.resourceId, snapshot.resource_revision],
          )
          if (resourceUpdate.rowCount !== 1) {
            throw new PlatformApiError("PUBLICATION_SNAPSHOT_STALE", 409)
          }
        } else {
          const resourceCheck = await transaction.query(
            `select 1
               from genio_one_resources
              where tenant_id = $1 and resource_id = $2
                and lifecycle = 'PUBLISHED' and row_revision = $3
              for update`,
            [input.tenantId, input.resourceId, snapshot.resource_revision],
          )
          if (resourceCheck.rowCount !== 1) {
            throw new PlatformApiError("PUBLICATION_SNAPSHOT_STALE", 409)
          }
          await transaction.query(
            `update genio_one_publications
                set publication_state = 'RETIRED', row_revision = row_revision + 1, updated_at = now()
              where tenant_id = $1 and resource_id = $2
                and publication_id <> $3 and publication_state = 'PUBLISHED'`,
            [input.tenantId, input.resourceId, snapshot.publication_id],
          )
        }
        const publicationUpdate = await transaction.query(
          `update genio_one_publications
              set request_snapshot = $3::text::jsonb,
                  review_snapshot = $4::text::jsonb,
                  publication_state = 'PUBLISHED',
                  publication_build_state = 'READY',
                  projection_digest = $5,
                  last_error_code = null,
                  row_revision = row_revision + 1,
                  updated_at = now()
            where tenant_id = $1 and publication_id = $2
              and publication_build_state = 'BUILDING'
              and build_attempt_id = $6`,
          [
            input.tenantId,
            snapshot.publication_id,
            JSON.stringify(approved),
            reviewJson(input.reviewerId, input.reviewedAt),
            input.projection.digest,
            input.attemptId,
          ],
        )
        if (publicationUpdate.rowCount !== 1) {
          throw new PlatformApiError("PUBLICATION_BUILD_NOT_ACTIVE", 409)
        }
        const attemptUpdate = await transaction.query(
          `update genio_one_publication_build_attempts
              set state = 'READY', projection_digest = $4,
                  completed_at = to_timestamp($5)
            where tenant_id = $1 and publication_id = $2 and attempt_id = $3
              and state = 'BUILDING'`,
          [
            input.tenantId,
            snapshot.publication_id,
            input.attemptId,
            input.projection.digest,
            input.reviewedAt,
          ],
        )
        if (attemptUpdate.rowCount !== 1) {
          throw new PlatformApiError("PUBLICATION_BUILD_NOT_ACTIVE", 409)
        }
      })
      return options.resources.getResource(input)
    },
  }
}
