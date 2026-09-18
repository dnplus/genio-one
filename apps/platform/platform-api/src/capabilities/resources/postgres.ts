import { randomUUID } from "node:crypto"

import { PlatformApiError } from "../errors"
import type { SqlAdapter, SqlTransaction } from "../../persistence/sql-adapter"
import type { OrganizationDirectory } from "../organizations/module"
import type {
  ResourceCreateInput,
  ResourceLifecycle,
  ResourcePublicationEndpoint,
  ResourcePublicationEndpointInput,
  ResourceRegistration,
  ResourceUpdateInput,
  InstallationServiceKind,
} from "./contract"
import type { ResourcePublicationRequest } from "./publication-types"
import { resourceContentDigest } from "./resource-content"
import type {
  ListResourcesInput,
  PublicationDnsVerifier,
  ResourceLifecycleReleasePublisher,
  ResourceRegistry,
} from "./module"

type DatabaseRow = Record<string, unknown>

export interface PostgresResourceOptions {
  sql: SqlAdapter
  organizations: OrganizationDirectory
  /**
   * Server-side DNS proof.  A client-provided VERIFIED value is never trusted
   * when this callback is absent; publication remains pending instead.
   */
  verifyDns?: PublicationDnsVerifier["verify"]
  dnsTargetForGateway?: PublicationDnsVerifier["targetForGateway"]
  lifecycleReleasePublisher?: ResourceLifecycleReleasePublisher
  now?: () => number
  idFactory?: (prefix: string) => string
}

const RESOURCE_COLUMNS = `
  tenant_id,
  resource_id,
  display_name,
  documentation,
  kind,
  owner_organization_id,
  authentication_strategy,
  environment_id,
  version,
  lifecycle,
  operational_state,
  capabilities,
  api_metadata,
  extension_metadata,
  builtin_service,
  installation_owned,
  service_kind,
  enforcement_point_id,
  row_revision,
  resource_digest,
  created_at`

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

const RESOURCE_KINDS = ["MCP", "LLM", "SAAS", "API", "EXTENSION"] as const
const RESOURCE_LIFECYCLES = ["DRAFT", "PUBLISHED", "DEPRECATED", "RETIRED"] as const
const RESOURCE_AUTHENTICATION = ["NONE", "EMA", "OAUTH", "API_KEY", "MTLS"] as const
const OPERATIONAL_STATES = ["UNKNOWN", "HEALTHY", "DEGRADED", "UNAVAILABLE"] as const
const REQUEST_STATES = ["PENDING", "APPROVED", "REJECTED", "CANCELLED"] as const
const INSTALLATION_SERVICE_KINDS = ["SERVICENOW_CSM", "MAIL2000", "DISCOVERY", "GENIO_BOT"] as const
// Only routable Frontend Resources have a Gateway publication endpoint.  An
// Extension Package is not a Connection/Frontend Resource, and SAAS is kept
// only as the legacy Access Destination kind.
const RESOURCE_KINDS_WITH_GATEWAY_PUBLICATION = ["MCP", "LLM", "API"] as const

function assertTenantId(tenantId: string): void {
  if (!tenantId.trim()) {
    throw new PlatformApiError("TENANT_REQUIRED", 422, "A tenant id is required")
  }
}

function assertIdentifier(value: string, code: string): void {
  if (!value.trim()) throw new PlatformApiError(code, 422)
}

function rowString(row: DatabaseRow, key: string, code = "RESOURCE_DATA_INVALID"): string {
  const value = row[key]
  if (typeof value !== "string" || !value.trim()) {
    throw new PlatformApiError(code, 500, `Persisted ${key} is invalid`)
  }
  return value
}

function rowNumber(row: DatabaseRow, key: string, fallback: number): number {
  const value = row[key]
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value)
  if (typeof value === "bigint") return Number(value)
  if (typeof value === "string") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.floor(parsed)
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return Math.floor(value.getTime() / 1000)
  }
  return fallback
}

function rowTimestamp(row: DatabaseRow, key: string, fallback: number): number {
  const value = row[key]
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value)
  if (typeof value === "bigint") return Number(value)
  if (typeof value === "string") {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return Math.floor(numeric)
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000)
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return Math.floor(value.getTime() / 1000)
  }
  return fallback
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  key: string,
): T {
  if (typeof value === "string" && values.includes(value as T)) return value as T
  throw new PlatformApiError("RESOURCE_DATA_INVALID", 500, `Persisted ${key} is invalid`)
}

function jsonValue(value: unknown, fallback: unknown): unknown {
  if (typeof value !== "string") return value ?? fallback
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new PlatformApiError("RESOURCE_DATA_INVALID", 500, "Persisted JSON is invalid")
  }
}

function jsonObject(value: unknown, key: string): Record<string, unknown> {
  const parsed = jsonValue(value, {})
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PlatformApiError("RESOURCE_DATA_INVALID", 500, `Persisted ${key} is invalid`)
  }
  return parsed as Record<string, unknown>
}

function capabilities(value: unknown): Array<{ capability_id: string; display_name: string }> {
  const parsed = jsonValue(value, [])
  if (!Array.isArray(parsed)) {
    throw new PlatformApiError("RESOURCE_DATA_INVALID", 500, "Persisted capabilities are invalid")
  }
  return parsed.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new PlatformApiError("RESOURCE_DATA_INVALID", 500, "Persisted capability is invalid")
    }
    const item = entry as Record<string, unknown>
    if (
      typeof item.capability_id !== "string" ||
      !item.capability_id.trim() ||
      typeof item.display_name !== "string" ||
      !item.display_name.trim()
    ) {
      throw new PlatformApiError("RESOURCE_DATA_INVALID", 500, "Persisted capability is invalid")
    }
    return { capability_id: item.capability_id, display_name: item.display_name }
  })
}

function apiMetadata(value: unknown, kind: ResourceRegistration["kind"]): ResourceRegistration["api"] {
  if (value === null || value === undefined) return null
  if (kind !== "API") throw new PlatformApiError("RESOURCE_DATA_INVALID", 500)
  const parsed = jsonValue(value, null)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PlatformApiError("RESOURCE_DATA_INVALID", 500)
  }
  return parsed as NonNullable<ResourceRegistration["api"]>
}

function extensionMetadata(
  value: unknown,
  kind: ResourceRegistration["kind"],
): ResourceRegistration["extension_metadata"] {
  if (value === null || value === undefined) return null
  if (kind !== "EXTENSION") throw new PlatformApiError("RESOURCE_DATA_INVALID", 500)
  const parsed = jsonValue(value, null)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PlatformApiError("RESOURCE_DATA_INVALID", 500)
  }
  return parsed as NonNullable<ResourceRegistration["extension_metadata"]>
}

function mapEndpoint(row: DatabaseRow): ResourcePublicationEndpoint {
  const proof = jsonObject(row.dns_proof, "dns_proof")
  const dnsTarget = proof.dns_target
  if (dnsTarget !== undefined && dnsTarget !== null && typeof dnsTarget !== "string") {
    throw new PlatformApiError("RESOURCE_DATA_INVALID", 500, "Persisted DNS target is invalid")
  }
  return {
    gateway_id: rowString(row, "gateway_id"),
    hostname: rowString(row, "hostname"),
    base_path: rowString(row, "base_path"),
    visibility: enumValue(
      row.visibility,
      ["PRIVATE", "REQUEST", "PUBLIC"] as const,
      "visibility",
    ),
    dns_management: enumValue(
      row.dns_management,
      ["PLATFORM_MANAGED", "EXTERNAL"] as const,
      "dns_management",
    ),
    dns_verification: enumValue(
      row.dns_proof_status,
      ["PENDING", "VERIFIED", "FAILED"] as const,
      "dns_proof_status",
    ),
    dns_target: dnsTarget === undefined ? null : dnsTarget,
  }
}

function mapPublicationRequest(row: DatabaseRow): ResourcePublicationRequest | null {
  const snapshot = jsonObject(row.request_snapshot, "request_snapshot")
  if (typeof snapshot.request_id !== "string" || !snapshot.request_id.trim()) return null
  const reviewed = jsonObject(row.review_snapshot, "review_snapshot")
  const requestedAt = snapshot.requested_at
  const reviewedAt = reviewed.reviewed_at
  const publicationState =
    typeof row.publication_build_state === "string"
      ? row.publication_build_state
      : row.publication_state === "PUBLISHED"
        ? "READY"
        : row.publication_state === "PENDING_REVIEW"
          ? "PENDING_REVIEW"
          : "IDLE"
  const allowedPublicationStates = [
    "IDLE",
    "PENDING_REVIEW",
    "BUILDING",
    "FAILED",
    "READY",
  ] as const
  const mappedPublicationState = enumValue(
    publicationState,
    allowedPublicationStates,
    "publication_build_state",
  )
  const attemptId =
    row.build_attempt_id === undefined || row.build_attempt_id === null
      ? snapshot.attempt_id === undefined || snapshot.attempt_id === null
        ? null
        : String(snapshot.attempt_id)
      : String(row.build_attempt_id)
  const failureCode =
    row.last_error_code === undefined || row.last_error_code === null
      ? snapshot.failure_code === undefined || snapshot.failure_code === null
        ? null
        : String(snapshot.failure_code)
      : String(row.last_error_code)
  return {
    request_id: snapshot.request_id,
    state: enumValue(snapshot.state, REQUEST_STATES, "publication request state"),
    requested_by: rowString(snapshot, "requested_by", "RESOURCE_DATA_INVALID"),
    requested_at:
      typeof requestedAt === "number" ? Math.floor(requestedAt) : Number(requestedAt),
    reviewed_by:
      reviewed.reviewed_by === undefined || reviewed.reviewed_by === null
        ? null
        : String(reviewed.reviewed_by),
    reviewed_at:
      reviewedAt === undefined || reviewedAt === null ? null : Number(reviewedAt),
    publication_state: mappedPublicationState,
    attempt_id: attemptId,
    failure_code: failureCode,
  }
}

function mapResource(
  row: DatabaseRow,
  publication: DatabaseRow | null,
  now: () => number,
): ResourceRegistration {
  const installationOwned = row.installation_owned === true || row.installation_owned === "true"
  const serviceKind = row.service_kind === null || row.service_kind === undefined
    ? null
    : enumValue(row.service_kind, INSTALLATION_SERVICE_KINDS, "service_kind") as InstallationServiceKind
  if (installationOwned && serviceKind === null) {
    throw new PlatformApiError("RESOURCE_DATA_INVALID", 500, "Persisted installation service kind is missing")
  }
  const mapped: ResourceRegistration = {
    builtin_service: row.builtin_service === "DISCOVERY" ? "DISCOVERY" : null,
    installation_owned: installationOwned,
    service_kind: serviceKind,
    tenant_id: rowString(row, "tenant_id"),
    resource_id: rowString(row, "resource_id"),
    display_name: rowString(row, "display_name"),
    documentation: typeof row.documentation === "string" ? row.documentation : "",
    kind: enumValue(row.kind, RESOURCE_KINDS, "kind"),
    owner_organization_id: rowString(row, "owner_organization_id"),
    authentication_strategy: enumValue(
      row.authentication_strategy,
      RESOURCE_AUTHENTICATION,
      "authentication_strategy",
    ),
    environment_id: rowString(row, "environment_id"),
    version: rowString(row, "version"),
    lifecycle: enumValue(row.lifecycle, RESOURCE_LIFECYCLES, "lifecycle"),
    operational_state: enumValue(row.operational_state, OPERATIONAL_STATES, "operational_state"),
    capabilities: capabilities(row.capabilities),
    api: apiMetadata(
      row.api_metadata,
      enumValue(row.kind, RESOURCE_KINDS, "kind"),
    ),
    extension_metadata: extensionMetadata(
      row.extension_metadata,
      enumValue(row.kind, RESOURCE_KINDS, "kind"),
    ),
    enforcement_point_id: rowString(row, "enforcement_point_id"),
    created_at: rowTimestamp(row, "created_at", now()),
  }
  if (publication) {
    mapped.publication_endpoint = mapEndpoint(publication)
    mapped.publication_request = mapPublicationRequest(publication)
  } else {
    mapped.publication_endpoint = null
    mapped.publication_request = null
  }
  return mapped
}

async function selectResource(
  executor: SqlAdapter | SqlTransaction,
  tenantId: string,
  resourceId: string,
  forUpdate = false,
): Promise<DatabaseRow | null> {
  const result = await executor.query<DatabaseRow>(
    `select ${RESOURCE_COLUMNS}
       from genio_one_resources
      where tenant_id = $1 and resource_id = $2${forUpdate ? " for update" : ""}`,
    [tenantId, resourceId],
  )
  return result.rows[0] ?? null
}

async function latestPublication(
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

function supportsGatewayPublication(kind: unknown): boolean {
  return typeof kind === "string" && RESOURCE_KINDS_WITH_GATEWAY_PUBLICATION.includes(
    kind as (typeof RESOURCE_KINDS_WITH_GATEWAY_PUBLICATION)[number],
  )
}

async function mapCurrentResource(
  executor: SqlAdapter | SqlTransaction,
  tenantId: string,
  resourceId: string,
  now: () => number,
): Promise<ResourceRegistration> {
  const resource = await selectResource(executor, tenantId, resourceId)
  if (!resource) throw new PlatformApiError("RESOURCE_NOT_FOUND", 404)
  return mapResource(resource, await latestPublication(executor, tenantId, resourceId), now)
}

async function assertOrganizationExists(
  executor: SqlAdapter | SqlTransaction,
  tenantId: string,
  organizationId: string,
): Promise<void> {
  const result = await executor.query(
    `select organization_id
       from genio_one_organizations
      where tenant_id = $1 and organization_id = $2`,
    [tenantId, organizationId],
  )
  if (result.rowCount === 0) throw new PlatformApiError("ORGANIZATION_NOT_FOUND", 404)
}

function isSqlError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}

function canTransition(from: ResourceLifecycle, to: ResourceLifecycle, kind?: ResourceRegistration["kind"]): boolean {
  return (
    from === to ||
    (kind === "EXTENSION" && from === "DRAFT" && to === "PUBLISHED") ||
    (kind === "EXTENSION" && from === "PUBLISHED" && to === "DRAFT") ||
    (from === "PUBLISHED" && to === "DEPRECATED") ||
    (from === "DEPRECATED" && to === "RETIRED")
  )
}

function isInstallationOwned(row: DatabaseRow): boolean {
  return row.installation_owned === true || row.installation_owned === "true"
}

function assertInstallationResourceIdentity(
  current: DatabaseRow,
  value: ResourceUpdateInput,
): void {
  if (!isInstallationOwned(current)) return
  if (value.owner_organization_id !== undefined && value.owner_organization_id !== current.owner_organization_id) {
    throw new PlatformApiError("INSTALLATION_OWNED_RESOURCE_IDENTITY", 409)
  }
  const forbiddenField = [
    "kind",
    "resource_id",
    "service_kind",
    "installation_owned",
    "enforcement_point_id",
    "environment_id",
    "authentication_strategy",
  ].find((field) => Object.prototype.hasOwnProperty.call(value, field))
  if (forbiddenField) throw new PlatformApiError("INSTALLATION_OWNED_RESOURCE_IDENTITY", 409)
}

export function createPostgresResourceRegistry(options: PostgresResourceOptions): ResourceRegistry {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const idFactory = options.idFactory ?? ((prefix: string) => `${prefix}-${randomUUID()}`)

  const getResource = async (input: { tenantId: string; resourceId: string }) => {
    assertTenantId(input.tenantId)
    assertIdentifier(input.resourceId, "RESOURCE_REQUIRED")
    return mapCurrentResource(options.sql, input.tenantId, input.resourceId, now)
  }

  return {
    async listResources(input: ListResourcesInput) {
      assertTenantId(input.tenantId)
      const result = await options.sql.query<DatabaseRow>(
        `select ${RESOURCE_COLUMNS}
           from genio_one_resources
          where tenant_id = $1
          order by display_name asc, resource_id asc`,
        [input.tenantId],
      )
      return Promise.all(
        result.rows.map(async (row) =>
          mapResource(
            row,
            await latestPublication(options.sql, input.tenantId, rowString(row, "resource_id")),
            now,
          ),
        ),
      )
    },

    getResource,

    async createResource(input: { tenantId: string; value: ResourceCreateInput; resourceId?: string }) {
      assertTenantId(input.tenantId)
      const value = input.value
      const displayName = value.display_name.trim()
      if (!displayName) throw new PlatformApiError("INVALID_RESOURCE_NAME", 422)
      if ((value.kind === "API") !== (value.api !== undefined)) {
        throw new PlatformApiError("API_RESOURCE_METADATA_INVALID", 422)
      }
      if (value.extension_metadata !== undefined && value.extension_metadata !== null && value.kind !== "EXTENSION") {
        throw new PlatformApiError("EXTENSION_METADATA_NOT_ALLOWED", 422, "Extension metadata is only allowed for EXTENSION resources")
      }
      await options.organizations.get({
        tenantId: input.tenantId,
        organizationId: value.owner_organization_id,
      })
      const resourceId = input.resourceId?.trim() || idFactory("resource")
      assertIdentifier(resourceId, "RESOURCE_REQUIRED")
      const extensionMetadata = value.extension_metadata
        ? {
            ...value.extension_metadata,
            ...(value.extension_metadata.package_type === "BOT" && !value.extension_metadata.resource_id
              ? { resource_id: resourceId }
              : {}),
          }
        : null
      try {
        return await options.sql.transaction(async (transaction) => {
          await assertOrganizationExists(transaction, input.tenantId, value.owner_organization_id)
          const result = await transaction.query<DatabaseRow>(
            `insert into genio_one_resources
              (tenant_id, resource_id, display_name, kind, owner_organization_id,
               authentication_strategy, environment_id, version, lifecycle,
              operational_state, capabilities, api_metadata, enforcement_point_id, extension_metadata)
             values ($1, $2, $3, $4, $5, $6, $7, $8, 'DRAFT', 'UNKNOWN', $9::text::jsonb, $10::text::jsonb, $11, $12::text::jsonb)
             returning ${RESOURCE_COLUMNS}`,
            [
              input.tenantId,
              resourceId,
              displayName,
              value.kind,
              value.owner_organization_id,
              value.authentication_strategy,
              value.environment_id,
              value.version,
              JSON.stringify(value.capabilities ?? []),
              value.api === undefined ? null : JSON.stringify(value.api),
              value.enforcement_point_id,
              extensionMetadata === null ? null : JSON.stringify(extensionMetadata),
            ],
          )
          const row = result.rows[0]
          if (!row) throw new PlatformApiError("RESOURCE_CREATE_FAILED", 500)
          return mapResource(row, null, now)
        })
      } catch (error) {
        if (isSqlError(error, "23505")) {
          throw new PlatformApiError("RESOURCE_ID_EXISTS", 409)
        }
        throw error
      }
    },

    async updateResource(input: {
      tenantId: string
      resourceId: string
      value: ResourceUpdateInput
    }) {
      assertTenantId(input.tenantId)
      assertIdentifier(input.resourceId, "RESOURCE_REQUIRED")
      return options.sql.transaction(async (transaction) => {
        const current = await selectResource(transaction, input.tenantId, input.resourceId, true)
        if (!current) throw new PlatformApiError("RESOURCE_NOT_FOUND", 404)
        assertInstallationResourceIdentity(current, input.value)
        const lifecycle = enumValue(current.lifecycle, RESOURCE_LIFECYCLES, "lifecycle")
        if (Object.keys(input.value).length === 1 && input.value.documentation !== undefined) {
          await transaction.query("update genio_one_resources set documentation = $3 where tenant_id = $1 and resource_id = $2", [input.tenantId, input.resourceId, input.value.documentation])
          return mapResource({ ...current, documentation: input.value.documentation }, await latestPublication(transaction, input.tenantId, input.resourceId), now)
        }
        if (lifecycle !== "DRAFT") {
          throw new PlatformApiError(
            "PUBLISHED_RESOURCE_IMMUTABLE",
            409,
            "Only draft Resources can change governed content",
          )
        }
        const value = input.value
        if (value.owner_organization_id !== undefined) {
          await assertOrganizationExists(
            transaction,
            input.tenantId,
            value.owner_organization_id,
          )
        }
        const assignments: string[] = []
        const parameters: unknown[] = [input.tenantId, input.resourceId]
        const add = (column: string, valueToStore: unknown, cast = "") => {
          parameters.push(valueToStore)
          assignments.push(`${column} = $${parameters.length}${cast}`)
        }
        if (value.display_name !== undefined) {
          const displayName = value.display_name.trim()
          if (!displayName) throw new PlatformApiError("INVALID_RESOURCE_NAME", 422)
          add("display_name", displayName)
        }
        if (value.owner_organization_id !== undefined) {
          add("owner_organization_id", value.owner_organization_id)
        }
        if (value.documentation !== undefined) add("documentation", value.documentation)
        if (value.version !== undefined) add("version", value.version)
        if (value.capabilities !== undefined) {
          add("capabilities", JSON.stringify(value.capabilities), "::text::jsonb")
        }
        if (value.extension_metadata !== undefined) {
          if (value.extension_metadata !== null && current.kind !== "EXTENSION") {
            throw new PlatformApiError("EXTENSION_METADATA_NOT_ALLOWED", 422, "Extension metadata is only allowed for EXTENSION resources")
          }
          add("extension_metadata", value.extension_metadata === null ? null : JSON.stringify(value.extension_metadata), "::text::jsonb")
        }
        if (assignments.length === 0) {
          return mapResource(
            current,
            await latestPublication(transaction, input.tenantId, input.resourceId),
            now,
          )
        }
        assignments.push("row_revision = row_revision + 1", "updated_at = now()")
        parameters.push(rowNumber(current, "row_revision", 1))
        const result = await transaction.query<DatabaseRow>(
          `update genio_one_resources
              set ${assignments.join(", ")}
            where tenant_id = $1 and resource_id = $2
              and row_revision = $${parameters.length}
              and lifecycle = 'DRAFT'
            returning ${RESOURCE_COLUMNS}`,
          parameters,
        )
        const row = result.rows[0]
        if (!row) throw new PlatformApiError("RESOURCE_REVISION_CONFLICT", 409)

        // A configured endpoint is reusable while the Resource remains a
        // Draft. Before review begins, advance its Resource reference in the
        // same transaction so editing governed content does not force the
        // operator to re-enter unchanged DNS/vhost settings. Once a review
        // snapshot exists, leave it immutable: the build path must detect the
        // changed Resource and fail stale rather than silently reviewing new
        // content under an old request.
        await transaction.query(
          `update genio_one_publications
              set resource_revision = $3,
                  resource_digest = $4,
                  row_revision = row_revision + 1,
                  updated_at = now()
            where tenant_id = $1 and resource_id = $2
              and publication_state = 'DRAFT'
              and publication_build_state = 'IDLE'
              and request_snapshot = '{}'::jsonb
              and publication_snapshot = '{}'::jsonb`,
          [
            input.tenantId,
            input.resourceId,
            rowNumber(row, "row_revision", 1),
            resourceContentDigest(mapResource(row, null, now)),
          ],
        )
        return mapResource(
          row,
          await latestPublication(transaction, input.tenantId, input.resourceId),
          now,
        )
      })
    },

    async setLifecycle(input: {
      tenantId: string
      resourceId: string
      lifecycle: ResourceLifecycle
    }) {
      assertTenantId(input.tenantId)
      return options.sql.transaction(async (transaction) => {
        const current = await selectResource(transaction, input.tenantId, input.resourceId, true)
        if (!current) throw new PlatformApiError("RESOURCE_NOT_FOUND", 404)
        const from = enumValue(current.lifecycle, RESOURCE_LIFECYCLES, "lifecycle")
        const currentKind = enumValue(current.kind, RESOURCE_KINDS, "kind")
        if (isInstallationOwned(current) && input.lifecycle !== from && ["DEPRECATED", "RETIRED"].includes(input.lifecycle)) {
          throw new PlatformApiError("INSTALLATION_OWNED_RESOURCE_CANNOT_RETIRE", 409)
        }
        if (input.lifecycle === "PUBLISHED" && currentKind !== "EXTENSION") {
          throw new PlatformApiError(
            "PUBLICATION_REQUIRES_APPROVAL",
            409,
            "Use a publication request and reviewer decision to publish a Resource",
          )
        }
        if (!canTransition(from, input.lifecycle, currentKind)) {
          throw new PlatformApiError(
            "INVALID_RESOURCE_LIFECYCLE_TRANSITION",
            409,
            `Cannot transition Resource from ${from} to ${input.lifecycle}`,
          )
        }
        if (from === input.lifecycle) {
          return mapResource(
            current,
            await latestPublication(transaction, input.tenantId, input.resourceId),
            now,
          )
        }
        const revision = rowNumber(current, "row_revision", 1)
        const changesPublishedRoute =
          input.lifecycle === "DEPRECATED" || input.lifecycle === "RETIRED"
        const activePublication = changesPublishedRoute
          ? await transaction.query<DatabaseRow>(
              `select gateway_id
                 from genio_one_publications
                where tenant_id = $1 and resource_id = $2
                  and publication_state in ('PUBLISHED', 'DEPRECATED')
                order by endpoint_revision desc
                limit 1
                for update`,
              [input.tenantId, input.resourceId],
            )
          : { rows: [] as DatabaseRow[] }
        const result = await transaction.query<DatabaseRow>(
          `update genio_one_resources
              set lifecycle = $3, row_revision = row_revision + 1, updated_at = now()
            where tenant_id = $1 and resource_id = $2 and row_revision = $4
            returning ${RESOURCE_COLUMNS}`,
          [input.tenantId, input.resourceId, input.lifecycle, revision],
        )
        const row = result.rows[0]
        if (!row) throw new PlatformApiError("RESOURCE_REVISION_CONFLICT", 409)
        if (input.lifecycle === "DEPRECATED" || input.lifecycle === "RETIRED") {
          await transaction.query(
            `update genio_one_publications
                set publication_state = $3, row_revision = row_revision + 1, updated_at = now()
              where tenant_id = $1 and resource_id = $2
                and publication_state in ('PUBLISHED', 'DEPRECATED')`,
            [input.tenantId, input.resourceId, input.lifecycle],
          )
        }
        const gatewayId = activePublication.rows[0]?.gateway_id
        if (changesPublishedRoute && typeof gatewayId === "string") {
          if (!options.lifecycleReleasePublisher) {
            throw new PlatformApiError("GATEWAY_RELEASE_PUBLISHER_REQUIRED", 500)
          }
          await options.lifecycleReleasePublisher.reconcileInTransaction({
            transaction,
            tenantId: input.tenantId,
            gatewayId,
            issuedAt: now(),
          })
        }
        return mapResource(
          row,
          await latestPublication(transaction, input.tenantId, input.resourceId),
          now,
        )
      })
    },

    async setPublicationEndpoint(input: {
      tenantId: string
      resourceId: string
      value: ResourcePublicationEndpointInput
    }) {
      assertTenantId(input.tenantId)
      return options.sql.transaction(async (transaction) => {
        const resource = await selectResource(transaction, input.tenantId, input.resourceId, true)
        if (!resource) throw new PlatformApiError("RESOURCE_NOT_FOUND", 404)
        if (!supportsGatewayPublication(resource.kind)) {
          throw new PlatformApiError(
            "RESOURCE_KIND_NOT_FRONTEND",
            422,
            "Only MCP, LLM, and API Resources can have a Gateway publication endpoint; Extension Packages and Access Destinations are not Frontend Resources",
          )
        }
        const lifecycle = enumValue(resource.lifecycle, RESOURCE_LIFECYCLES, "lifecycle")
        if (lifecycle !== "DRAFT") {
          throw new PlatformApiError(
            "PUBLISHED_RESOURCE_IMMUTABLE",
            409,
            "A published Resource cannot change its publication endpoint",
          )
        }
        const revisionResult = await transaction.query<{ next_revision: number | string }>(
          `select coalesce(max(endpoint_revision), 0) + 1 as next_revision
             from genio_one_publications
            where tenant_id = $1 and resource_id = $2`,
          [input.tenantId, input.resourceId],
        )
        const endpointRevision = rowNumber(revisionResult.rows[0] ?? {}, "next_revision", 1)
        const publicationId = idFactory("publication")
        const value = input.value
        const dnsTarget = options.dnsTargetForGateway ? options.dnsTargetForGateway(value.gateway_id) : value.dns_target?.trim() || null
        if (value.dns_verification === "VERIFIED") {
          if (!options.verifyDns) {
            throw new PlatformApiError(
              "PUBLICATION_DNS_PROOF_REQUIRED",
              422,
              "DNS VERIFIED must come from a server-side DNS proof",
            )
          }
          const verified = await options.verifyDns({
            tenantId: input.tenantId,
            resourceId: input.resourceId,
            hostname: value.hostname,
            dnsTarget,
            gatewayId: value.gateway_id,
          })
          if (!verified) {
            throw new PlatformApiError(
              "PUBLICATION_DNS_NOT_VERIFIED",
              422,
              "The publication endpoint DNS could not be verified by the server",
            )
          }
        }
        const proof = JSON.stringify({
          dns_target: dnsTarget,
          ...(value.dns_verification === "VERIFIED" ? { verified_at: now() } : {}),
        })
        const resourceDigest = resourceContentDigest(mapResource(resource, null, now))
        const inserted = await transaction.query<DatabaseRow>(
          `insert into genio_one_publications
            (tenant_id, publication_id, resource_id, endpoint_revision,
             resource_revision, resource_digest, policy_revision, gateway_id,
             hostname, base_path, visibility, publication_state, dns_management,
             dns_proof_status, dns_proof, request_snapshot, review_snapshot)
           values ($1, $2, $3, $4, $5, $6, 0, $7, $8, $9, $10, 'DRAFT',
                   $11, $12, $13::text::jsonb, '{}'::jsonb, '{}'::jsonb)
           returning ${PUBLICATION_COLUMNS}`,
          [
            input.tenantId,
            publicationId,
            input.resourceId,
            endpointRevision,
            rowNumber(resource, "row_revision", 1),
            resourceDigest,
            value.gateway_id,
            value.hostname,
            value.base_path,
            value.visibility ?? "PRIVATE",
            value.dns_management,
            value.dns_verification,
            proof,
          ],
        )
        const publication = inserted.rows[0]
        if (!publication) throw new PlatformApiError("PUBLICATION_CREATE_FAILED", 500)
        return mapResource(resource, publication, now)
      })
    },

    async requestPublication() {
      throw new PlatformApiError(
        "PUBLICATION_WORKFLOW_REQUIRED",
        409,
        "Resource publication must go through the snapshot/build/review workflow",
      )
    },

    async reviewPublication() {
      throw new PlatformApiError(
        "PUBLICATION_WORKFLOW_REQUIRED",
        409,
        "Resource publication must go through the snapshot/build/review workflow",
      )
    },
  }
}
