import { diagnoseConnection } from "./diagnostics"
import { randomUUID } from "node:crypto"

import { PlatformApiError } from "../errors"
import type { SqlAdapter, SqlTransaction } from "../../persistence/sql-adapter"
import type { ResourceLifecycleReleasePublisher, ResourceRegistry } from "../resources/module"
import { isGenioBotHealthy } from "../installed-services/seed"
import type { ProviderProfileCatalog } from "../providers/module"
import {
  resolveProviderCredentialProfileBinding,
  type ProviderCredentialProfileStore,
} from "../provider-credentials/module"
import type { ProviderCredentialProfileReference } from "../provider-credentials/contract"
import { ensurePublicationSuccessorInTransaction } from "../publications/successor"
import {
  assertInstalledConnectorConfiguration,
  canonicalizeApiRequestMapping,
  canonicalizeDownstreamIdentity,
  ApiUpstreamRequestMapping,
  ConnectionKind,
  ConnectionRegistration,
  CreateConnectionInput,
  DownstreamIdentityProjection,
  normalizeMcpToolNamespace,
  UpdateConnectionInput,
} from "./contract"
import { connectionCertificateFromStored, certificateStorageValues, parseConnectionCertificate, sameConnectionCertificate } from "./certificate"
import type { ResourceConnectionRegistry } from "./module"
import {
  providerCredentialProfileForVerification,
  type ConnectionVerifier,
} from "./module"
import {
  canonicalizeConnectionRegistrationInput,
  normalizeConnectionEndpoint,
} from "./registration"

type DatabaseRow = Record<string, unknown>

export interface PostgresConnectionOptions {
  sql: SqlAdapter
  /** Kept in the adapter contract so callers can use one capability graph. */
  resources?: ResourceRegistry
  providers: ProviderProfileCatalog
  providerCredentials?: ProviderCredentialProfileStore
  now?: () => number
  idFactory?: (prefix: string) => string
  verifier?: ConnectionVerifier
  installedBotHealthCheck?: (endpoint: string) => Promise<boolean> | boolean
  releasePublisher?: ResourceLifecycleReleasePublisher
}

async function resolveCredentialProfile(
  options: PostgresConnectionOptions,
  tenantId: string,
  ownerOrganizationId: string,
  reference: ProviderCredentialProfileReference,
) {
  if (!options.providerCredentials) {
    throw new PlatformApiError("PROVIDER_CREDENTIAL_PROFILE_STORE_UNAVAILABLE", 503)
  }
  return resolveProviderCredentialProfileBinding({
    store: options.providerCredentials,
    tenantId,
    ownerOrganizationId,
    reference,
  })
}

const CONNECTION_COLUMNS = `
  tenant_id,
  connection_id,
  resource_id,
  display_name,
  connection_kind,
  provider_type,
  provider_profile_id,
  endpoint,
  mcp_tool_namespace,
  mcp_selected_tools,
  mcp_tool_selection_operation_id,
  credential_ref,
  provider_credential_profile_id,
  provider_credential_profile_revision,
  provider_credential_strategy_digest,
  downstream_identity,
  connector_configuration,
  request_mapping,
  certificate_mode,
  certificate_pem,
  certificate_fingerprint_sha256,
  certificate_subject,
  certificate_issuer,
  certificate_is_self_signed,
  certificate_not_before,
  certificate_not_after,
  status,
  configuration_revision,
  lifecycle,
  revoke_requested_after_release_revision,
  verification_state,
  health_state,
  health_observed_at,
  health_source_revision,
  routing_priority,
  region,
  supported_obligations,
  row_revision,
  created_at`

const CONNECTION_STATUSES = ["DRAFT", "READY", "DEGRADED", "DISABLED"] as const
const CONNECTION_LIFECYCLES = ["DRAFT", "ENABLED", "DISABLED", "REVOKE_PENDING", "REVOKED"] as const
const VERIFICATION_STATES = ["UNVERIFIED", "VERIFIED", "FAILED"] as const
const HEALTH_STATES = ["UNKNOWN", "HEALTHY", "DEGRADED", "UNAVAILABLE"] as const
const CONNECTION_KINDS = ["LLM", "MCP", "API"] as const
const PROVIDER_TYPES = ["GENERIC_OPENAI_COMPATIBLE", "OPENAI", "OMLX", "OLLAMA", "GCP_VERTEX_AI"] as const
const ROUTING_HEALTH_FRESHNESS_SECONDS = 300


function routingHealthEligible(value: { health_state: string; health_observed_at: number | null }, evaluatedAt: number): boolean {
  return value.health_state === "HEALTHY" &&
    value.health_observed_at !== null &&
    value.health_observed_at <= evaluatedAt &&
    evaluatedAt - value.health_observed_at <= ROUTING_HEALTH_FRESHNESS_SECONDS
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
}

function assertTenantId(tenantId: string): void {
  if (!tenantId.trim()) {
    throw new PlatformApiError("TENANT_REQUIRED", 422, "A tenant id is required")
  }
}

function assertIdentifier(value: string, code: string): void {
  if (!value.trim()) throw new PlatformApiError(code, 422)
}

function rowString(row: DatabaseRow, key: string, code = "CONNECTION_DATA_INVALID"): string {
  const value = row[key]
  if (typeof value !== "string" || !value.trim()) {
    throw new PlatformApiError(code, 500, `Persisted ${key} is invalid`)
  }
  return value
}

function optionalRowString(row: DatabaseRow, key: string): string | null {
  const value = row[key]
  if (value === null || value === undefined) return null
  if (typeof value !== "string") {
    throw new PlatformApiError("CONNECTION_DATA_INVALID", 500, `Persisted ${key} is invalid`)
  }
  return value
}

function rowStringArray(row: DatabaseRow, key: string): string[] {
  const value = row[key]
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new PlatformApiError("CONNECTION_DATA_INVALID", 500, `Persisted ${key} is invalid`)
  }
  return value
}

function downstreamIdentity(row: DatabaseRow): DownstreamIdentityProjection {
  let value = row.downstream_identity
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      throw new PlatformApiError("CONNECTION_DATA_INVALID", 500, "Persisted downstream_identity is invalid")
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PlatformApiError("CONNECTION_DATA_INVALID", 500, "Persisted downstream_identity is invalid")
  }
  const identity = canonicalizeDownstreamIdentity(value as DownstreamIdentityProjection)
  if (identity) return identity
  throw new PlatformApiError("CONNECTION_DATA_INVALID", 500, "Persisted downstream_identity is invalid")
}

function requestMapping(row: DatabaseRow, connectionKind: ConnectionKind): ApiUpstreamRequestMapping | null {
  let value = row.request_mapping
  if (value === null || value === undefined) {
    if (connectionKind === "API") {
      throw new PlatformApiError("CONNECTION_DATA_INVALID", 500, "Persisted API request mapping is missing")
    }
    return null
  }
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      throw new PlatformApiError("CONNECTION_DATA_INVALID", 500, "Persisted API request mapping is invalid")
    }
  }
  if (connectionKind !== "API" || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new PlatformApiError("CONNECTION_DATA_INVALID", 500, "Persisted API request mapping is invalid")
  }
  return canonicalizeApiRequestMapping(value as ApiUpstreamRequestMapping)
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

function enumValue<T extends string>(value: unknown, values: readonly T[], key: string): T {
  if (typeof value === "string" && values.includes(value as T)) return value as T
  throw new PlatformApiError("CONNECTION_DATA_INVALID", 500, `Persisted ${key} is invalid`)
}

function mapConnection(row: DatabaseRow, now: () => number): ConnectionRegistration {
  const connectionKind = enumValue(row.connection_kind, CONNECTION_KINDS, "connection_kind")
  const providerType = row.provider_type === null
    ? null
    : enumValue(row.provider_type, PROVIDER_TYPES, "provider_type")
  const providerProfileId = optionalRowString(row, "provider_profile_id")
  const providerCredentialProfileId = optionalRowString(row, "provider_credential_profile_id")
  const providerCredentialProfileRevision = row.provider_credential_profile_revision === null || row.provider_credential_profile_revision === undefined
    ? null
    : rowValueNumber(row.provider_credential_profile_revision, 1)
  const providerCredentialStrategyDigest = optionalRowString(row, "provider_credential_strategy_digest")
  if (
    [providerCredentialProfileId, providerCredentialProfileRevision, providerCredentialStrategyDigest]
      .filter((value) => value !== null).length !== 0 &&
    [providerCredentialProfileId, providerCredentialProfileRevision, providerCredentialStrategyDigest]
      .some((value) => value === null)
  ) {
    throw new PlatformApiError("CONNECTION_DATA_INVALID", 500)
  }
  if (
    (connectionKind === "LLM" && (!providerType || !providerProfileId)) ||
    (connectionKind !== "LLM" && (providerType !== null || providerProfileId !== null))
  ) {
    throw new PlatformApiError("CONNECTION_DATA_INVALID", 500, "Persisted Connection kind does not match its provider fields")
  }
  return {
    tenant_id: rowString(row, "tenant_id"),
    connection_id: rowString(row, "connection_id"),
    resource_id: rowString(row, "resource_id"),
    display_name: rowString(row, "display_name"),
    connection_kind: connectionKind,
    provider_type: providerType,
    provider_profile_id: providerProfileId,
    ...(row.connector_configuration ? { connector_configuration: row.connector_configuration as NonNullable<ConnectionRegistration["connector_configuration"]> } : {}),
    endpoint: rowString(row, "endpoint"),
    mcp_tool_namespace: optionalRowString(row, "mcp_tool_namespace"),
    mcp_selected_tools: rowStringArray(row, "mcp_selected_tools"),
    mcp_tool_selection_operation_id: optionalRowString(row, "mcp_tool_selection_operation_id"),
    credential_ref: optionalRowString(row, "credential_ref"),
    provider_credential_profile: providerCredentialProfileId && providerCredentialProfileRevision && providerCredentialStrategyDigest
      ? {
          profile_id: providerCredentialProfileId,
          revision: providerCredentialProfileRevision,
          strategy_digest: providerCredentialStrategyDigest,
        }
      : null,
    downstream_identity: downstreamIdentity(row),
    request_mapping: requestMapping(row, connectionKind),
    certificate: connectionCertificateFromStored({
      mode: row.certificate_mode ?? "SYSTEM_CA",
      certificate_pem: row.certificate_pem,
      fingerprint_sha256: row.certificate_fingerprint_sha256,
      subject: row.certificate_subject,
      issuer: row.certificate_issuer,
      is_self_signed: row.certificate_is_self_signed,
      not_before: row.certificate_not_before,
      not_after: row.certificate_not_after,
    }, now()),
    status: enumValue(row.status, CONNECTION_STATUSES, "status"),
    configuration_revision: rowValueNumber(row.configuration_revision, 1),
    lifecycle: enumValue(row.lifecycle, CONNECTION_LIFECYCLES, "lifecycle"),
    revoke_requested_after_release_revision: row.revoke_requested_after_release_revision === null
      ? null
      : rowValueNumber(row.revoke_requested_after_release_revision, 0),
    verification_state: enumValue(row.verification_state, VERIFICATION_STATES, "verification_state"),
    health_state: enumValue(row.health_state, HEALTH_STATES, "health_state"),
    health_observed_at: row.health_observed_at === null ? null : rowTimestamp(row, "health_observed_at", now()),
    health_source_revision: row.health_source_revision === null ? null : rowValueNumber(row.health_source_revision, 1),
    routing_priority: rowValueNumber(row.routing_priority, 0),
    region: optionalRowString(row, "region"),
    supported_obligations: rowStringArray(row, "supported_obligations"),
    created_at: rowTimestamp(row, "created_at", now()),
  }
}

async function resourceForUpdate(
  executor: SqlAdapter | SqlTransaction,
  tenantId: string,
  resourceId: string,
): Promise<DatabaseRow> {
  const result = await executor.query<DatabaseRow>(
    `select resource_id, owner_organization_id, kind, lifecycle, row_revision, installation_owned, service_kind
       from genio_one_resources
      where tenant_id = $1 and resource_id = $2
      for update`,
    [tenantId, resourceId],
  )
  const resource = result.rows[0]
  if (!resource) throw new PlatformApiError("RESOURCE_NOT_FOUND", 404)
  return resource
}

async function connectionById(
  executor: SqlAdapter | SqlTransaction,
  tenantId: string,
  resourceId: string,
  connectionId: string,
  forUpdate = false,
): Promise<DatabaseRow | null> {
  const result = await executor.query<DatabaseRow>(
    `select ${CONNECTION_COLUMNS}
       from genio_one_resource_connections
      where tenant_id = $1 and resource_id = $2 and connection_id = $3${
        forUpdate ? " for update" : ""
      }`,
    [tenantId, resourceId, connectionId],
  )
  return result.rows[0] ?? null
}

function isSqlError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}

export function createPostgresResourceConnectionRegistry(
  options: PostgresConnectionOptions,
): ResourceConnectionRegistry {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const idFactory = options.idFactory ?? ((prefix: string) => `${prefix}-${randomUUID()}`)

  return {
    async listHealthTargets(input) {
      assertTenantId(input.tenantId)
      assertIdentifier(input.gatewayId, "GATEWAY_ID_REQUIRED")
      const result = await options.sql.query<DatabaseRow>(
        `select distinct on (connection.connection_id)
                connection.resource_id, connection.connection_id, connection.endpoint,
                connection.credential_ref, connection.configuration_revision,
                connection.health_state, connection.health_observed_at,
                connection.health_source_revision, connection.certificate_mode,
                connection.certificate_pem, connection.certificate_fingerprint_sha256,
                connection.certificate_subject, connection.certificate_issuer,
                connection.certificate_is_self_signed, connection.certificate_not_before,
                connection.certificate_not_after
           from genio_one_resource_connections connection
           join genio_one_publications publication
             on publication.tenant_id = connection.tenant_id
            and publication.resource_id = connection.resource_id
          where connection.tenant_id = $1
            and publication.gateway_id = $2
            and publication.publication_state in ('PUBLISHED', 'DEPRECATED')
            and connection.lifecycle = 'ENABLED'
            and connection.verification_state = 'VERIFIED'
          order by connection.connection_id, publication.endpoint_revision desc`,
        [input.tenantId, input.gatewayId],
      )
      return result.rows.map((row) => ({
        resource_id: String(row.resource_id),
        connection_id: String(row.connection_id),
        endpoint: String(row.endpoint),
        credential_ref: row.credential_ref === null ? null : String(row.credential_ref),
        configuration_revision: rowValueNumber(row.configuration_revision, 1),
        health_state: enumValue(row.health_state, HEALTH_STATES, "health_state"),
        health_observed_at: row.health_observed_at === null ? null : rowTimestamp(row, "health_observed_at", now()),
        health_source_revision: row.health_source_revision === null ? null : rowValueNumber(row.health_source_revision, 1),
        certificate: connectionCertificateFromStored({
          mode: row.certificate_mode ?? "SYSTEM_CA",
          certificate_pem: row.certificate_pem,
          fingerprint_sha256: row.certificate_fingerprint_sha256,
          subject: row.certificate_subject,
          issuer: row.certificate_issuer,
          is_self_signed: row.certificate_is_self_signed,
          not_before: row.certificate_not_before,
          not_after: row.certificate_not_after,
        }, now()),
      }))
    },

    async list(input) {
      assertTenantId(input.tenantId)
      assertIdentifier(input.resourceId, "RESOURCE_REQUIRED")
      const resource = await resourceForUpdateRead(options.sql, input.tenantId, input.resourceId)
      if (!resource) throw new PlatformApiError("RESOURCE_NOT_FOUND", 404)
      const result = await options.sql.query<DatabaseRow>(
        `select ${CONNECTION_COLUMNS}
           from genio_one_resource_connections
          where tenant_id = $1 and resource_id = $2
          order by display_name asc, connection_id asc`,
        [input.tenantId, input.resourceId],
      )
      return result.rows.map((row) => mapConnection(row, now))
    },

    async get(input) {
      assertTenantId(input.tenantId)
      assertIdentifier(input.resourceId, "RESOURCE_REQUIRED")
      assertIdentifier(input.connectionId, "CONNECTION_REQUIRED")
      const connection = await connectionById(
        options.sql,
        input.tenantId,
        input.resourceId,
        input.connectionId,
      )
      if (!connection) throw new PlatformApiError("CONNECTION_NOT_FOUND", 404)
      return mapConnection(connection, now)
    },

    async create(input: {
      tenantId: string
      resourceId: string
      value: CreateConnectionInput
      connectionId?: string
    }) {
      assertTenantId(input.tenantId)
      assertIdentifier(input.resourceId, "RESOURCE_REQUIRED")
      const displayName = input.value.display_name.trim()
      if (!displayName) throw new PlatformApiError("INVALID_CONNECTION_NAME", 422)
      const canonical = canonicalizeConnectionRegistrationInput(input.value)
      const {
        connectionKind,
        providerType,
        downstreamIdentity,
        endpoint,
        requestMapping,
      } = canonical
      const certificate = parseConnectionCertificate({
        mode: input.value.certificate_mode ?? (input.value.certificate_pem ? "CUSTOM_CA" : "SYSTEM_CA"),
        certificate_pem: input.value.certificate_pem,
      }, now())
      const certificateValues = certificateStorageValues(certificate)
      const profile = connectionKind === "LLM"
        ? input.value.provider_profile_id
          ? await options.providers.get({
              tenantId: input.tenantId,
              profileId: input.value.provider_profile_id,
            })
          : await options.providers.findDefault({
              tenantId: input.tenantId,
              providerType: providerType!,
            })
        : null
      if (profile && profile.provider_type !== providerType) {
        throw new PlatformApiError("PROVIDER_PROFILE_TYPE_MISMATCH", 422)
      }
      const connectionId = input.connectionId?.trim() || idFactory("connection")
      assertIdentifier(connectionId, "CONNECTION_REQUIRED")
      try {
        return await options.sql.transaction(async (transaction) => {
          const resource = await resourceForUpdate(transaction, input.tenantId, input.resourceId)
          if (resource.installation_owned === true) {
            throw new PlatformApiError("INSTALLATION_OWNED_CONNECTION_SINGLETON", 409)
          }
          if (resource.kind !== connectionKind) {
            throw new PlatformApiError(
              "CONNECTION_RESOURCE_KIND_MISMATCH",
              422,
              "Connection kind must match its owning Resource",
            )
          }
          const providerCredentialProfile = input.value.provider_credential_profile
            ? await resolveCredentialProfile(
                options,
                input.tenantId,
                rowString(resource, "owner_organization_id"),
                input.value.provider_credential_profile,
              )
            : null
          const result = await transaction.query<DatabaseRow>(
            `insert into genio_one_resource_connections
              (tenant_id, resource_id, connection_id, display_name, connection_kind,
               provider_type, provider_profile_id, endpoint, mcp_tool_namespace, credential_ref,
               provider_credential_profile_id, provider_credential_profile_revision,
               provider_credential_strategy_digest, downstream_identity, request_mapping,
               certificate_mode, certificate_pem, certificate_fingerprint_sha256,
               certificate_subject, certificate_issuer, certificate_is_self_signed,
               certificate_not_before, certificate_not_after,
               status, lifecycle, verification_state,
               health_state, routing_priority, region, supported_obligations, connector_configuration)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               $14::text::jsonb, $15::text::jsonb, $16, $17, $18, $19, $20, $21,
               case when $22::bigint is null then null else to_timestamp($22::double precision) end,
               case when $23::bigint is null then null else to_timestamp($23::double precision) end,
               'DRAFT', 'DRAFT', 'UNVERIFIED', 'UNKNOWN', $24, $25, $26::text[], $27::text::jsonb)
             returning ${CONNECTION_COLUMNS}`,
            [
              input.tenantId,
              input.resourceId,
              connectionId,
              displayName,
              connectionKind,
              providerType,
              profile?.profile_id ?? null,
              endpoint,
              connectionKind === "MCP"
                ? normalizeMcpToolNamespace(input.value.mcp_tool_namespace)
                : null,
              input.value.credential_ref ?? null,
              providerCredentialProfile?.profile_id ?? null,
              providerCredentialProfile?.revision ?? null,
              providerCredentialProfile?.strategy_digest ?? null,
              JSON.stringify(downstreamIdentity),
              requestMapping === null ? null : JSON.stringify(requestMapping),
              certificateValues.mode,
              certificateValues.pem,
              certificateValues.fingerprint,
              certificateValues.subject,
              certificateValues.issuer,
              certificateValues.isSelfSigned,
              certificateValues.notBefore,
              certificateValues.notAfter,
              input.value.routing_priority ?? 0,
              input.value.region?.trim() || null,
              [...new Set(input.value.supported_obligations ?? [])].sort(),
              input.value.connector_configuration ? JSON.stringify(input.value.connector_configuration) : null,
            ],
          )
          const row = result.rows[0]
          if (!row) throw new PlatformApiError("CONNECTION_CREATE_FAILED", 500)
          await ensurePublicationSuccessorInTransaction({
            transaction,
            tenantId: input.tenantId,
            resourceId: input.resourceId,
            idFactory,
          })
          return mapConnection(row, now)
        })
      } catch (error) {
        if (isSqlError(error, "23505")) {
          if (input.value.mcp_tool_namespace) {
            throw new PlatformApiError("MCP_TOOL_NAMESPACE_EXISTS", 409)
          }
          throw new PlatformApiError("CONNECTION_ID_EXISTS", 409)
        }
        throw error
      }
    },

    async update(input: {
      tenantId: string
      resourceId: string
      connectionId: string
      value: UpdateConnectionInput
    }) {
      assertTenantId(input.tenantId)
      assertIdentifier(input.resourceId, "RESOURCE_REQUIRED")
      assertIdentifier(input.connectionId, "CONNECTION_REQUIRED")
      return options.sql.transaction(async (transaction) => {
        const resource = await resourceForUpdate(transaction, input.tenantId, input.resourceId)
        const current = await connectionById(
          transaction,
          input.tenantId,
          input.resourceId,
          input.connectionId,
          true,
        )
        if (!current) throw new PlatformApiError("CONNECTION_NOT_FOUND", 404)
        if (rowValueNumber(current.configuration_revision, 1) !== input.value.expected_revision) {
          throw new PlatformApiError("CONNECTION_REVISION_CONFLICT", 409)
        }
        if (current.lifecycle === "REVOKED") {
          throw new PlatformApiError("CONNECTION_REVOKED", 409)
        }
        if (current.lifecycle === "REVOKE_PENDING") {
          throw new PlatformApiError("CONNECTION_LIFECYCLE_CONFLICT", 409)
        }
        if (resource.installation_owned === true && input.value.endpoint !== undefined && input.value.connector_configuration === undefined) {
          throw new PlatformApiError("INSTALLATION_OWNED_ENDPOINT", 409)
        }
        const currentConnection = mapConnection(current, now)
        if (currentConnection.connector_configuration && input.value.connector_configuration && input.value.endpoint !== currentConnection.endpoint && resource.lifecycle !== "DRAFT") throw new PlatformApiError("CONNECTOR_SITE_CHANGE_REQUIRES_NEW_CONNECTION", 409)
        const providerCredentialProfile = input.value.provider_credential_profile === undefined
          ? undefined
          : input.value.provider_credential_profile === null
            ? null
            : await resolveCredentialProfile(
                options,
                input.tenantId,
                rowString(resource, "owner_organization_id"),
                input.value.provider_credential_profile,
              )
        const effectiveProviderCredentialProfile = providerCredentialProfile === undefined
          ? currentConnection.provider_credential_profile
          : providerCredentialProfile
        const effectiveDownstreamIdentity = providerCredentialProfile === undefined
          ? input.value.downstream_identity ?? currentConnection.downstream_identity
          : providerCredentialProfile
            ? { mode: "SERVICE" as const, authentication: "PROVIDER_CREDENTIAL_PROFILE" as const }
            : currentConnection.downstream_identity.authentication === "PROVIDER_CREDENTIAL_PROFILE"
              ? { mode: "NONE" as const }
              : currentConnection.downstream_identity
        const canonical = canonicalizeConnectionRegistrationInput({
          display_name: input.value.display_name ?? currentConnection.display_name,
          connection_kind: currentConnection.connection_kind,
          ...(currentConnection.provider_type ? { provider_type: currentConnection.provider_type } : {}),
          ...(currentConnection.provider_profile_id ? { provider_profile_id: currentConnection.provider_profile_id } : {}),
          endpoint: input.value.endpoint ?? currentConnection.endpoint,
          ...(input.value.credential_ref === undefined
            ? currentConnection.credential_ref ? { credential_ref: currentConnection.credential_ref } : {}
            : input.value.credential_ref ? { credential_ref: input.value.credential_ref } : {}),
          ...(effectiveProviderCredentialProfile
            ? { provider_credential_profile: {
                profile_id: effectiveProviderCredentialProfile.profile_id,
                revision: effectiveProviderCredentialProfile.revision,
              } }
            : {}),
          downstream_identity: effectiveDownstreamIdentity,
          ...(input.value.request_mapping ?? currentConnection.request_mapping
            ? { request_mapping: input.value.request_mapping ?? currentConnection.request_mapping ?? undefined }
            : {}),
        })
        const assignmentValues = new Map<string, { value: unknown; cast: string }>()
        const add = (column: string, value: unknown, cast = "") => {
          assignmentValues.set(column, { value, cast })
        }
        if (input.value.display_name !== undefined) {
          const displayName = input.value.display_name.trim()
          if (!displayName) throw new PlatformApiError("INVALID_CONNECTION_NAME", 422)
          add("display_name", displayName)
        }
        if (input.value.connector_configuration) add("connector_configuration", JSON.stringify(input.value.connector_configuration), "::text::jsonb")
        if (input.value.downstream_identity) {
          add("downstream_identity", JSON.stringify(canonical.downstreamIdentity), "::text::jsonb")
          add("verification_state", "UNVERIFIED")
          add("health_state", "UNKNOWN")
          add("health_observed_at", null)
          add("health_source_revision", null)
        }
        if (input.value.endpoint !== undefined) {
          add("endpoint", normalizeConnectionEndpoint(input.value.endpoint))
          add("verification_state", "UNVERIFIED")
          add("health_state", "UNKNOWN")
          add("health_observed_at", null)
          add("health_source_revision", null)
        }
        if (input.value.mcp_tool_namespace !== undefined) {
          add("mcp_tool_namespace", normalizeMcpToolNamespace(input.value.mcp_tool_namespace))
        }
        if (input.value.credential_ref !== undefined) {
          add("credential_ref", input.value.credential_ref)
        }
        if (input.value.provider_credential_profile !== undefined) {
          const binding = providerCredentialProfile
          add("provider_credential_profile_id", binding?.profile_id ?? null)
          add("provider_credential_profile_revision", binding?.revision ?? null)
          add("provider_credential_strategy_digest", binding?.strategy_digest ?? null)
          add("downstream_identity", JSON.stringify(canonical.downstreamIdentity), "::text::jsonb")
          add("verification_state", "UNVERIFIED")
          add("health_state", "UNKNOWN")
          add("health_observed_at", null)
          add("health_source_revision", null)
        }
        if (input.value.request_mapping !== undefined) {
          if (currentConnection.connection_kind !== "API") {
            throw new PlatformApiError("API_REQUEST_MAPPING_UNSUPPORTED", 422)
          }
          add(
            "request_mapping",
            JSON.stringify(canonicalizeApiRequestMapping(input.value.request_mapping)),
            "::text::jsonb",
          )
        }
        if (input.value.routing_priority !== undefined) add("routing_priority", input.value.routing_priority)
        if (input.value.region !== undefined) add("region", input.value.region?.trim() || null)
        if (input.value.supported_obligations !== undefined) {
          add("supported_obligations", [...new Set(input.value.supported_obligations)].sort(), "::text[]")
        }
        if (assignmentValues.size === 0) return mapConnection(current, now)
        const parameters: unknown[] = [input.tenantId, input.resourceId, input.connectionId]
        const assignments = [...assignmentValues.entries()].map(([column, assignment]) => {
          parameters.push(assignment.value)
          return `${column} = $${parameters.length}${assignment.cast}`
        })
        assignments.push("configuration_revision = configuration_revision + 1", "row_revision = row_revision + 1", "updated_at = now()")
        const revision = rowValueNumber(current.row_revision, 1)
        parameters.push(revision)
        const result = await transaction.query<DatabaseRow>(
          `update genio_one_resource_connections
              set ${assignments.join(", ")}
            where tenant_id = $1 and resource_id = $2 and connection_id = $3
              and row_revision = $${parameters.length}
            returning ${CONNECTION_COLUMNS}`,
          parameters,
        )
        const row = result.rows[0]
        if (!row) throw new PlatformApiError("CONNECTION_REVISION_CONFLICT", 409)
        await ensurePublicationSuccessorInTransaction({
          transaction,
          tenantId: input.tenantId,
          resourceId: input.resourceId,
          idFactory,
        })
        return mapConnection(row, now)
      })
    },

    async updateCertificate(input) {
      assertTenantId(input.tenantId)
      assertIdentifier(input.resourceId, "RESOURCE_REQUIRED")
      assertIdentifier(input.connectionId, "CONNECTION_REQUIRED")
      const certificate = parseConnectionCertificate(input.value, now())
      const certificateValues = certificateStorageValues(certificate)
      return options.sql.transaction(async (transaction) => {
        await resourceForUpdate(transaction, input.tenantId, input.resourceId)
        const current = await connectionById(
          transaction,
          input.tenantId,
          input.resourceId,
          input.connectionId,
          true,
        )
        if (!current) throw new PlatformApiError("CONNECTION_NOT_FOUND", 404)
        if (rowValueNumber(current.configuration_revision, 1) !== input.value.expected_revision) {
          throw new PlatformApiError("CONNECTION_REVISION_CONFLICT", 409)
        }
        const lifecycle = enumValue(current.lifecycle, CONNECTION_LIFECYCLES, "lifecycle")
        if (lifecycle === "REVOKED" || lifecycle === "REVOKE_PENDING") {
          throw new PlatformApiError("CONNECTION_LIFECYCLE_CONFLICT", 409)
        }
        if (sameConnectionCertificate(connectionCertificateFromStored({
          mode: current.certificate_mode ?? "SYSTEM_CA",
          certificate_pem: current.certificate_pem,
          fingerprint_sha256: current.certificate_fingerprint_sha256,
          subject: current.certificate_subject,
          issuer: current.certificate_issuer,
          is_self_signed: current.certificate_is_self_signed,
          not_before: current.certificate_not_before,
          not_after: current.certificate_not_after,
        }, now()), certificate)) return mapConnection(current, now)
        const result = await transaction.query<DatabaseRow>(
          `update genio_one_resource_connections
              set certificate_mode = $4,
                  certificate_pem = $5,
                  certificate_fingerprint_sha256 = $6,
                  certificate_subject = $7,
                  certificate_issuer = $8,
                  certificate_is_self_signed = $9,
                  certificate_not_before = case when $10::bigint is null then null else to_timestamp($10::double precision) end,
                  certificate_not_after = case when $11::bigint is null then null else to_timestamp($11::double precision) end,
                  verification_state = 'UNVERIFIED', health_state = 'UNKNOWN',
                  health_observed_at = null, health_source_revision = null,
                  configuration_revision = configuration_revision + 1,
                  row_revision = row_revision + 1, updated_at = now()
            where tenant_id = $1 and resource_id = $2 and connection_id = $3
              and configuration_revision = $12
            returning ${CONNECTION_COLUMNS}`,
          [
            input.tenantId,
            input.resourceId,
            input.connectionId,
            certificateValues.mode,
            certificateValues.pem,
            certificateValues.fingerprint,
            certificateValues.subject,
            certificateValues.issuer,
            certificateValues.isSelfSigned,
            certificateValues.notBefore,
            certificateValues.notAfter,
            input.value.expected_revision,
          ],
        )
        const row = result.rows[0]
        if (!row) throw new PlatformApiError("CONNECTION_REVISION_CONFLICT", 409)
        await ensurePublicationSuccessorInTransaction({
          transaction,
          tenantId: input.tenantId,
          resourceId: input.resourceId,
          idFactory,
        })
        return mapConnection(row, now)
      })
    },

    async test(input) {
      const current = await this.get(input)
      const resource = await options.resources?.getResource(input)
      const providerCredentialProfile = await providerCredentialProfileForVerification({
        store: options.providerCredentials,
        tenantId: input.tenantId,
        ownerOrganizationId: resource?.owner_organization_id ?? "",
        reference: current.provider_credential_profile,
      })
      return diagnoseConnection({ connection: current, verifier: options.verifier, providerCredentialProfile })
    },

    async verify(input) {
      assertTenantId(input.tenantId)
      assertIdentifier(input.resourceId, "RESOURCE_REQUIRED")
      assertIdentifier(input.connectionId, "CONNECTION_REQUIRED")
      const currentRow = await connectionById(
        options.sql,
        input.tenantId,
        input.resourceId,
        input.connectionId,
      )
      if (!currentRow) throw new PlatformApiError("CONNECTION_NOT_FOUND", 404)
      const current = mapConnection(currentRow, now)
      const resource = options.resources
        ? await options.resources.getResource({
            tenantId: input.tenantId,
            resourceId: input.resourceId,
          })
        : undefined
      const serviceKind = input.serviceKind ?? resource?.service_kind
      assertInstalledConnectorConfiguration(serviceKind, currentRow.connector_configuration)
      if (serviceKind === "GENIO_BOT") {
        const healthy = await (options.installedBotHealthCheck ?? isGenioBotHealthy)(current.endpoint)
        if (!healthy) throw new PlatformApiError("CONNECTION_HEALTH_CHECK_FAILED", 422)
      } else if (!options.verifier) {
        throw new PlatformApiError("CONNECTION_VERIFIER_UNAVAILABLE", 503)
      }
      if (["EXPIRED", "NOT_YET_VALID", "INVALID"].includes(current.certificate?.status ?? "")) {
        throw new PlatformApiError("CONNECTION_CERTIFICATE_NOT_USABLE", 422)
      }
      const providerCredentialProfile = await providerCredentialProfileForVerification({
        store: options.providerCredentials,
        tenantId: input.tenantId,
        ownerOrganizationId: resource?.owner_organization_id ?? "",
        reference: current.provider_credential_profile,
      })
      if (serviceKind !== "GENIO_BOT" && !await options.verifier!.verify({
          connection: current,
          ...(providerCredentialProfile ? { providerCredentialProfile } : {}),
        })) throw new PlatformApiError("CONNECTION_VERIFICATION_FAILED", 422)
      return options.sql.transaction(async (transaction) => {
        await resourceForUpdate(transaction, input.tenantId, input.resourceId)
        const locked = await connectionById(
          transaction,
          input.tenantId,
          input.resourceId,
          input.connectionId,
          true,
        )
        if (!locked || rowValueNumber(locked.row_revision, 1) !== rowValueNumber(currentRow.row_revision, 1)) {
          throw new PlatformApiError("CONNECTION_REVISION_CONFLICT", 409)
        }
        const result = await transaction.query<DatabaseRow>(
          `update genio_one_resource_connections
              set status = 'READY', lifecycle = 'ENABLED', verification_state = 'VERIFIED',
                  health_state = 'HEALTHY', health_observed_at = now(),
                  health_source_revision = coalesce(health_source_revision, 0) + 1,
                  configuration_revision = configuration_revision + 1,
                  row_revision = row_revision + 1, updated_at = now()
            where tenant_id = $1 and resource_id = $2 and connection_id = $3
              and row_revision = $4
            returning ${CONNECTION_COLUMNS}`,
          [input.tenantId, input.resourceId, input.connectionId, rowValueNumber(locked.row_revision, 1)],
        )
        const row = result.rows[0]
        if (!row) throw new PlatformApiError("CONNECTION_REVISION_CONFLICT", 409)
        await ensurePublicationSuccessorInTransaction({
          transaction,
          tenantId: input.tenantId,
          resourceId: input.resourceId,
          idFactory,
        })
        return mapConnection(row, now)
      })
    },

    async updateMcpRouting(input) {
      assertTenantId(input.tenantId)
      assertIdentifier(input.resourceId, "RESOURCE_REQUIRED")
      assertIdentifier(input.connectionId, "CONNECTION_REQUIRED")
      return options.sql.transaction(async (transaction) => {
        await resourceForUpdate(transaction, input.tenantId, input.resourceId)
        const current = await connectionById(transaction, input.tenantId, input.resourceId, input.connectionId, true)
        if (!current) throw new PlatformApiError("CONNECTION_NOT_FOUND", 404)
        if (rowValueNumber(current.configuration_revision, 1) !== input.expectedRevision) {
          throw new PlatformApiError("CONNECTION_REVISION_CONFLICT", 409)
        }
        const connection = mapConnection(current, now)
        if (connection.connection_kind !== "MCP") {
          throw new PlatformApiError("CONNECTION_NOT_MCP", 422)
        }
        const assignments: string[] = []
        const parameters: unknown[] = [input.tenantId, input.resourceId, input.connectionId]
        const add = (column: string, value: unknown, cast = "") => {
          parameters.push(value)
          assignments.push(`${column} = $${parameters.length}${cast}`)
        }
        if (input.mcpToolNamespace !== undefined) {
          add("mcp_tool_namespace", normalizeMcpToolNamespace(input.mcpToolNamespace))
        }
        if (!assignments.length) return connection
        assignments.push("configuration_revision = configuration_revision + 1", "row_revision = row_revision + 1", "updated_at = now()")
        parameters.push(rowValueNumber(current.row_revision, 1))
        try {
          const updated = await transaction.query<DatabaseRow>(
            `update genio_one_resource_connections
                set ${assignments.join(", ")}
              where tenant_id = $1 and resource_id = $2 and connection_id = $3
                and row_revision = $${parameters.length}
              returning ${CONNECTION_COLUMNS}`,
            parameters,
          )
          const row = updated.rows[0]
          if (!row) throw new PlatformApiError("CONNECTION_REVISION_CONFLICT", 409)
          await ensurePublicationSuccessorInTransaction({
            transaction,
            tenantId: input.tenantId,
            resourceId: input.resourceId,
            idFactory,
          })
          return mapConnection(row, now)
        } catch (error) {
          if (isSqlError(error, "23505")) {
            throw new PlatformApiError("MCP_TOOL_NAMESPACE_EXISTS", 409)
          }
          throw error
        }
      })
    },

    async transitionLifecycle(input) {
      assertTenantId(input.tenantId)
      assertIdentifier(input.resourceId, "RESOURCE_REQUIRED")
      assertIdentifier(input.connectionId, "CONNECTION_REQUIRED")
      return options.sql.transaction(async (transaction) => {
        const resource = await resourceForUpdate(transaction, input.tenantId, input.resourceId)
        const current = await connectionById(transaction, input.tenantId, input.resourceId, input.connectionId, true)
        if (!current) throw new PlatformApiError("CONNECTION_NOT_FOUND", 404)
        if (rowValueNumber(current.configuration_revision, 1) !== input.value.expected_revision) {
          throw new PlatformApiError("CONNECTION_REVISION_CONFLICT", 409)
        }
        const lifecycle = enumValue(current.lifecycle, CONNECTION_LIFECYCLES, "lifecycle")
        if (resource.installation_owned === true && ["REQUEST_REVOKE", "CONFIRM_REVOKED"].includes(input.value.command)) {
          throw new PlatformApiError("INSTALLATION_OWNED_CONNECTION_CANNOT_REVOKE", 409)
        }
        let next: typeof CONNECTION_LIFECYCLES[number]
        if (input.value.command === "ENABLE") {
          if (!['DRAFT', 'DISABLED'].includes(lifecycle)) throw new PlatformApiError("CONNECTION_LIFECYCLE_CONFLICT", 409)
          assertInstalledConnectorConfiguration(resource.service_kind, current.connector_configuration)
          if (current.verification_state !== "VERIFIED") throw new PlatformApiError("CONNECTION_NOT_VERIFIED", 409)
          if (resource.service_kind === "GENIO_BOT" && !await (options.installedBotHealthCheck ?? isGenioBotHealthy)(rowString(current, "endpoint"))) throw new PlatformApiError("CONNECTION_HEALTH_CHECK_FAILED", 422)
          next = "ENABLED"
        } else if (input.value.command === "DISABLE") {
          if (!['DRAFT', 'ENABLED', 'DISABLED'].includes(lifecycle)) throw new PlatformApiError("CONNECTION_LIFECYCLE_CONFLICT", 409)
          next = "DISABLED"
        } else if (input.value.command === "REQUEST_REVOKE") {
          if (lifecycle === "REVOKED") throw new PlatformApiError("CONNECTION_REVOKED", 409)
          if (lifecycle === "REVOKE_PENDING") return mapConnection(current, now)
          next = "REVOKE_PENDING"
        } else {
          const revokeWatermark = rowValueNumber(current.revoke_requested_after_release_revision, 0)
          if (
            lifecycle !== "REVOKE_PENDING" ||
            input.value.applied_release_revision === undefined ||
            input.value.applied_release_revision <= revokeWatermark
          ) {
            throw new PlatformApiError("CONNECTION_RELEASE_ACK_REQUIRED", 409)
          }
          const unacknowledged = await transaction.query<DatabaseRow>(
            `select registration.runtime_id
               from genio_one_platform_runtime_registrations registration
               join genio_one_platform_runtime_capabilities capability
                 on capability.tenant_id = registration.tenant_id
                and capability.runtime_kind = registration.runtime_kind
                and capability.runtime_id = registration.runtime_id
              where registration.tenant_id = $1
                and registration.runtime_kind = 'GATEWAY'
                and registration.status = 'ACTIVE'
                and capability.protocol_versions @> '["genio.one.runtime.v1"]'::jsonb
                and capability.preferred_protocol_version = 'genio.one.runtime.v1'
                and capability.delivery_mode = 'AGGREGATE_RELEASE'
                and registration.target_id = (
                  select publication.gateway_id
                    from genio_one_publications publication
                   where publication.tenant_id = registration.tenant_id
                     and publication.resource_id = $3
                     and publication.publication_state = 'PUBLISHED'
                   order by publication.endpoint_revision desc
                   limit 1
                )
                and not exists (
                  select 1
                    from genio_one_platform_runtime_aggregate_commands command
                   where command.tenant_id = registration.tenant_id
                     and command.runtime_kind = 'GATEWAY'
                     and command.runtime_id = registration.runtime_id
                     and command.state = 'ACKNOWLEDGED'
                     and command.head_revision >= $2
                )
              limit 1`,
            [input.tenantId, input.value.applied_release_revision, input.resourceId],
          )
          if (unacknowledged.rowCount > 0) {
            throw new PlatformApiError("CONNECTION_RELEASE_ACK_REQUIRED", 409)
          }
          next = "REVOKED"
        }
        const revokeWatermark = input.value.command === "REQUEST_REVOKE"
          ? await transaction.query<DatabaseRow>(
              `select coalesce(max(command.head_revision), 0) as head_revision
                 from genio_one_platform_runtime_aggregate_commands command
                 join genio_one_platform_runtime_registrations registration
                   on registration.tenant_id = command.tenant_id
                  and registration.runtime_kind = command.runtime_kind
                  and registration.runtime_id = command.runtime_id
                  and registration.status = 'ACTIVE'
                 join genio_one_platform_runtime_capabilities capability
                   on capability.tenant_id = registration.tenant_id
                  and capability.runtime_kind = registration.runtime_kind
                  and capability.runtime_id = registration.runtime_id
                where command.tenant_id = $1
                  and command.runtime_kind = 'GATEWAY'
                  and capability.protocol_versions @> '["genio.one.runtime.v1"]'::jsonb
                  and capability.preferred_protocol_version = 'genio.one.runtime.v1'
                  and capability.delivery_mode = 'AGGREGATE_RELEASE'
                  and registration.target_id = (
                    select publication.gateway_id
                      from genio_one_publications publication
                     where publication.tenant_id = command.tenant_id
                       and publication.resource_id = $2
                       and publication.publication_state = 'PUBLISHED'
                     order by publication.endpoint_revision desc
                     limit 1
                  )`,
              [input.tenantId, input.resourceId],
            ).then((result) => rowValueNumber(result.rows[0]?.head_revision, 0))
          : null
        const status = next === "ENABLED" ? "READY" : "DISABLED"
        const result = await transaction.query<DatabaseRow>(
          `update genio_one_resource_connections
              set lifecycle = $4, status = $5,
                  revoke_requested_after_release_revision = coalesce($7, revoke_requested_after_release_revision),
                  configuration_revision = configuration_revision + 1,
                  row_revision = row_revision + 1, updated_at = now()
            where tenant_id = $1 and resource_id = $2 and connection_id = $3
              and configuration_revision = $6
            returning ${CONNECTION_COLUMNS}`,
          [input.tenantId, input.resourceId, input.connectionId, next, status, input.value.expected_revision, revokeWatermark],
        )
        const row = result.rows[0]
        if (!row) throw new PlatformApiError("CONNECTION_REVISION_CONFLICT", 409)
        await ensurePublicationSuccessorInTransaction({
          transaction,
          tenantId: input.tenantId,
          resourceId: input.resourceId,
          idFactory,
        })
        return mapConnection(row, now)
      })
    },

    async observeHealth(input) {
      assertTenantId(input.tenantId)
      assertIdentifier(input.resourceId, "RESOURCE_REQUIRED")
      assertIdentifier(input.connectionId, "CONNECTION_REQUIRED")
      return options.sql.transaction(async (transaction) => {
        await resourceForUpdate(transaction, input.tenantId, input.resourceId)
        const current = await connectionById(transaction, input.tenantId, input.resourceId, input.connectionId, true)
        if (!current) throw new PlatformApiError("CONNECTION_NOT_FOUND", 404)
        const currentSourceRevision = current.health_source_revision === null
          ? 0
          : rowValueNumber(current.health_source_revision, 0)
        if (input.value.source_revision <= currentSourceRevision) {
          throw new PlatformApiError("CONNECTION_HEALTH_REVISION_CONFLICT", 409)
        }
        const result = await transaction.query<DatabaseRow>(
          `update genio_one_resource_connections
              set health_state = $4, health_observed_at = to_timestamp($5),
                  health_source_revision = $6, row_revision = row_revision + 1,
                  updated_at = now()
            where tenant_id = $1 and resource_id = $2 and connection_id = $3
              and (health_source_revision is null or health_source_revision < $6)
            returning ${CONNECTION_COLUMNS}`,
          [input.tenantId, input.resourceId, input.connectionId, input.value.state, input.value.observed_at, input.value.source_revision],
        )
        const row = result.rows[0]
        if (!row) throw new PlatformApiError("CONNECTION_HEALTH_REVISION_CONFLICT", 409)
        const evaluatedAt = now()
        const currentConnection = mapConnection(current, now)
        if (routingHealthEligible(currentConnection, evaluatedAt) !== routingHealthEligible({
          health_state: input.value.state,
          health_observed_at: input.value.observed_at,
        }, evaluatedAt)) {
          await options.releasePublisher?.reconcileInTransaction({
            transaction,
            tenantId: input.tenantId,
            gatewayId: input.gatewayId,
            issuedAt: evaluatedAt,
          })
        }
        return mapConnection(row, now)
      })
    },

    async observeHealthBatch(input) {
      assertTenantId(input.tenantId)
      return options.sql.transaction(async (transaction) => {
        const observed: ConnectionRegistration[] = []
        const keys = new Set<string>()
        let eligibilityChanged = false
        const values = [...input.value.observations].sort((left, right) =>
          compareUtf8(left.resource_id, right.resource_id) ||
          compareUtf8(left.connection_id, right.connection_id)
        )
        for (const value of values) {
          assertIdentifier(value.resource_id, "RESOURCE_REQUIRED")
          assertIdentifier(value.connection_id, "CONNECTION_REQUIRED")
          const key = `${value.resource_id}\u0000${value.connection_id}`
          if (keys.has(key)) throw new PlatformApiError("CONNECTION_HEALTH_BATCH_DUPLICATE", 422)
          keys.add(key)
          await resourceForUpdate(transaction, input.tenantId, value.resource_id)
          const current = await connectionById(
            transaction,
            input.tenantId,
            value.resource_id,
            value.connection_id,
            true,
          )
          if (!current) throw new PlatformApiError("CONNECTION_NOT_FOUND", 404)
          const evaluatedAt = now()
          const currentConnection = mapConnection(current, now)
          const currentSourceRevision = current.health_source_revision === null
            ? 0
            : rowValueNumber(current.health_source_revision, 0)
          if (value.source_revision <= currentSourceRevision) {
            observed.push(mapConnection(current, now))
            continue
          }
          const result = await transaction.query<DatabaseRow>(
            `update genio_one_resource_connections
                set health_state = $4, health_observed_at = to_timestamp($5),
                    health_source_revision = $6, row_revision = row_revision + 1,
                    updated_at = now()
              where tenant_id = $1 and resource_id = $2 and connection_id = $3
                and (health_source_revision is null or health_source_revision < $6)
              returning ${CONNECTION_COLUMNS}`,
            [input.tenantId, value.resource_id, value.connection_id, value.state, value.observed_at, value.source_revision],
          )
          const row = result.rows[0]
          if (!row) throw new PlatformApiError("CONNECTION_HEALTH_REVISION_CONFLICT", 409)
          eligibilityChanged ||= routingHealthEligible(currentConnection, evaluatedAt) !== routingHealthEligible({
            health_state: value.state,
            health_observed_at: value.observed_at,
          }, evaluatedAt)
          observed.push(mapConnection(row, now))
        }
        if (eligibilityChanged) {
          await options.releasePublisher?.reconcileInTransaction({
            transaction,
            tenantId: input.tenantId,
            gatewayId: input.gatewayId,
            issuedAt: now(),
          })
        }
        return observed
      })
    },

    async remove(input) {
      assertTenantId(input.tenantId)
      assertIdentifier(input.resourceId, "RESOURCE_REQUIRED")
      assertIdentifier(input.connectionId, "CONNECTION_REQUIRED")
      await options.sql.transaction(async (transaction) => {
        const resource = await resourceForUpdate(transaction, input.tenantId, input.resourceId)
        if (resource.installation_owned === true) {
          throw new PlatformApiError("INSTALLATION_OWNED_CONNECTION_CANNOT_DELETE", 409)
        }
        if (resource.lifecycle !== "DRAFT") {
          throw new PlatformApiError(
            "PUBLISHED_RESOURCE_IMMUTABLE",
            409,
            "Connections cannot be deleted after Resource publication",
          )
        }
        const connection = await connectionById(
          transaction,
          input.tenantId,
          input.resourceId,
          input.connectionId,
          true,
        )
        if (!connection) throw new PlatformApiError("CONNECTION_NOT_FOUND", 404)
        const models = await transaction.query(
          `select mapping_id
             from genio_one_connection_model_mappings
            where tenant_id = $1 and resource_id = $2 and connection_id = $3
            limit 1`,
          [input.tenantId, input.resourceId, input.connectionId],
        )
        if (models.rowCount > 0) {
          throw new PlatformApiError(
            "CONNECTION_IN_USE",
            409,
            "A Connection referenced by a Public Model cannot be deleted",
          )
        }
        const deleted = await transaction.query(
          `delete from genio_one_resource_connections
            where tenant_id = $1 and resource_id = $2 and connection_id = $3
              and row_revision = $4`,
          [
            input.tenantId,
            input.resourceId,
            input.connectionId,
            rowValueNumber(connection.row_revision, 1),
          ],
        )
        if (deleted.rowCount !== 1) {
          throw new PlatformApiError("CONNECTION_REVISION_CONFLICT", 409)
        }
      })
    },
  }
}

function rowValueNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value)
  if (typeof value === "bigint") return Number(value)
  if (typeof value === "string") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.floor(parsed)
  }
  return fallback
}

async function resourceForUpdateRead(
  executor: SqlAdapter | SqlTransaction,
  tenantId: string,
  resourceId: string,
): Promise<DatabaseRow | null> {
  const result = await executor.query<DatabaseRow>(
    `select resource_id
       from genio_one_resources
      where tenant_id = $1 and resource_id = $2`,
    [tenantId, resourceId],
  )
  return result.rows[0] ?? null
}
