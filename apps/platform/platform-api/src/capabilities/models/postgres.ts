import { randomUUID } from "node:crypto"

import { PlatformApiError } from "../errors"
import type { SqlAdapter, SqlTransaction } from "../../persistence/sql-adapter"
import type { ResourceConnectionRegistry } from "../connections/module"
import type { ProviderProfileCatalog } from "../providers/module"
import type { ResourceRegistry } from "../resources/module"
import { ensurePublicationSuccessorInTransaction } from "../publications/successor"
import type {
  ConnectionModelMapping,
  CreatePublicModelInput,
  ModelCapability,
  PublicModel,
} from "./contract"
import type { PublicModelCatalog } from "./module"

type DatabaseRow = Record<string, unknown>

export interface PostgresPublicModelOptions {
  sql: SqlAdapter
  resources: ResourceRegistry
  connections: ResourceConnectionRegistry
  providers: ProviderProfileCatalog
  now?: () => number
  idFactory?: (prefix: string) => string
  mappingIdFactory?: (prefix: string) => string
}

const MODEL_COLUMNS = `
  m.tenant_id,
  m.model_id,
  m.model_name,
  m.display_name,
  m.resource_id,
  m.visibility,
  m.lifecycle,
  m.capabilities,
  m.created_at`

const MODEL_RETURNING_COLUMNS = `
  tenant_id,
  model_id,
  model_name,
  display_name,
  resource_id,
  visibility,
  lifecycle,
  capabilities,
  created_at`

const MAPPING_COLUMNS = `
  mm.tenant_id,
  mm.mapping_id,
  mm.public_model_id,
  mm.resource_id,
  mm.connection_id,
  mm.provider_model,
  mm.mapping_revision,
  mm.created_at`

const MODEL_VISIBILITY = ["PUBLIC", "PRIVATE"] as const
const MODEL_LIFECYCLE = ["PUBLISHED", "DEPRECATED"] as const
const CONNECTION_STATUS = "READY"
const MODEL_CAPABILITIES = [
  "CHAT",
  "STREAMING",
  "TOOL_CALLING",
  "VISION",
  "REASONING",
  "EMBEDDINGS",
  "TRANSCRIPTION",
] as const

function assertTenantId(tenantId: string): void {
  if (!tenantId.trim()) {
    throw new PlatformApiError("TENANT_REQUIRED", 422, "A tenant id is required")
  }
}

function assertIdentifier(value: string, code: string): void {
  if (!value.trim()) throw new PlatformApiError(code, 422)
}

function rowString(row: DatabaseRow, key: string): string {
  const value = row[key]
  if (typeof value !== "string" || !value.trim()) {
    throw new PlatformApiError("MODEL_DATA_INVALID", 500, `Persisted ${key} is invalid`)
  }
  return value
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
  throw new PlatformApiError("MODEL_DATA_INVALID", 500, `Persisted ${key} is invalid`)
}

function jsonArray(value: unknown): unknown[] {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      throw new PlatformApiError("MODEL_DATA_INVALID", 500, "Persisted capabilities are invalid")
    }
  }
  if (!Array.isArray(value)) {
    throw new PlatformApiError("MODEL_DATA_INVALID", 500, "Persisted capabilities are invalid")
  }
  return value
}

function mapModel(row: DatabaseRow, now: () => number): PublicModel {
  const capabilityValues = jsonArray(row.capabilities).map((value) => {
    if (typeof value !== "string" || !MODEL_CAPABILITIES.includes(value as ModelCapability)) {
      throw new PlatformApiError("MODEL_DATA_INVALID", 500, "Persisted capability is invalid")
    }
    return value as ModelCapability
  })
  return {
    tenant_id: rowString(row, "tenant_id"),
    model_id: rowString(row, "model_id"),
    model_name: rowString(row, "model_name"),
    display_name: rowString(row, "display_name"),
    resource_id: rowString(row, "resource_id"),
    visibility: enumValue(row.visibility, MODEL_VISIBILITY, "visibility"),
    lifecycle: enumValue(row.lifecycle, MODEL_LIFECYCLE, "lifecycle"),
    capabilities: capabilityValues,
    created_at: rowTimestamp(row, "created_at", now()),
  }
}

function mapMapping(row: DatabaseRow, now: () => number): ConnectionModelMapping {
  return {
    tenant_id: rowString(row, "tenant_id"),
    mapping_id: rowString(row, "mapping_id"),
    public_model_id: rowString(row, "public_model_id"),
    resource_id: rowString(row, "resource_id"),
    connection_id: rowString(row, "connection_id"),
    provider_model: rowString(row, "provider_model"),
    mapping_revision: rowNumber(row, "mapping_revision", "mapping_revision"),
    created_at: rowTimestamp(row, "created_at", now()),
  }
}

function rowNumber(row: DatabaseRow, key: string, label: string): number {
  const value = row[key]
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value
  if (typeof value === "bigint") {
    const numeric = Number(value)
    if (Number.isSafeInteger(numeric) && numeric > 0) return numeric
  }
  if (typeof value === "string") {
    const numeric = Number(value)
    if (Number.isSafeInteger(numeric) && numeric > 0) return numeric
  }
  throw new PlatformApiError("MODEL_DATA_INVALID", 500, `Persisted ${label} is invalid`)
}

function isSqlError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}

async function resourceRow(
  executor: SqlAdapter | SqlTransaction,
  tenantId: string,
  resourceId: string,
  forUpdate = false,
): Promise<DatabaseRow | null> {
  const result = await executor.query<DatabaseRow>(
    `select resource_id, kind, lifecycle
       from genio_one_resources
      where tenant_id = $1 and resource_id = $2${forUpdate ? " for update" : ""}`,
    [tenantId, resourceId],
  )
  return result.rows[0] ?? null
}

async function connectionRow(
  executor: SqlAdapter | SqlTransaction,
  tenantId: string,
  resourceId: string,
  connectionId: string,
  forUpdate = false,
): Promise<DatabaseRow | null> {
  const result = await executor.query<DatabaseRow>(
    `select connection_id, provider_type, provider_profile_id, status,
            lifecycle, verification_state, configuration_revision
       from genio_one_resource_connections
      where tenant_id = $1 and resource_id = $2 and connection_id = $3${forUpdate ? " for update" : ""}`,
    [tenantId, resourceId, connectionId],
  )
  return result.rows[0] ?? null
}

export function createPostgresPublicModelCatalog(
  options: PostgresPublicModelOptions,
): PublicModelCatalog {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const idFactory = options.idFactory ?? ((prefix: string) => `${prefix}-${randomUUID()}`)
  const mappingIdFactory =
    options.mappingIdFactory ?? ((prefix: string) => `${prefix}-${randomUUID()}`)

  return {
    async list(input) {
      assertTenantId(input.tenantId)
      const clauses = ["m.tenant_id = $1"]
      const parameters: unknown[] = [input.tenantId]
      parameters.push(input.visibility ?? "PUBLIC")
      clauses.push(`m.visibility = $${parameters.length}`)
      if (input.resourceId !== undefined) {
        assertIdentifier(input.resourceId, "RESOURCE_REQUIRED")
        parameters.push(input.resourceId)
        clauses.push(`m.resource_id = $${parameters.length}`)
      }
      clauses.push(`exists (
        select 1
          from genio_one_connection_model_mappings mm
          join genio_one_resource_connections c
            on c.tenant_id = mm.tenant_id
           and c.resource_id = mm.resource_id
           and c.connection_id = mm.connection_id
         where mm.tenant_id = m.tenant_id
           and mm.public_model_id = m.model_id
           and c.status = '${CONNECTION_STATUS}'
      )`)
      if (!input.includeUnpublishedResources) clauses.push("r.lifecycle = 'PUBLISHED'")
      const result = await options.sql.query<DatabaseRow>(
        `select ${MODEL_COLUMNS}
           from genio_one_public_models m
           join genio_one_resources r
             on r.tenant_id = m.tenant_id and r.resource_id = m.resource_id
          where ${clauses.join(" and ")}
          order by m.display_name asc, m.model_id asc`,
        parameters,
      )
      return result.rows.map((row) => mapModel(row, now))
    },

    async get(input) {
      assertTenantId(input.tenantId)
      assertIdentifier(input.modelId, "MODEL_REQUIRED")
      const result = await options.sql.query<DatabaseRow>(
        `select ${MODEL_COLUMNS}
           from genio_one_public_models m
          where m.tenant_id = $1 and m.model_id = $2`,
        [input.tenantId, input.modelId],
      )
      const row = result.rows[0]
      if (!row) throw new PlatformApiError("MODEL_NOT_FOUND", 404)
      return mapModel(row, now)
    },

    async listMappings(input) {
      assertTenantId(input.tenantId)
      const clauses = ["mm.tenant_id = $1"]
      const parameters: unknown[] = [input.tenantId]
      if (input.resourceId !== undefined) {
        assertIdentifier(input.resourceId, "RESOURCE_REQUIRED")
        parameters.push(input.resourceId)
        clauses.push(`mm.resource_id = $${parameters.length}`)
      }
      if (input.publicModelId !== undefined) {
        assertIdentifier(input.publicModelId, "MODEL_REQUIRED")
        parameters.push(input.publicModelId)
        clauses.push(`mm.public_model_id = $${parameters.length}`)
      }
      const connectionJoin = input.readyOnly
        ? `join genio_one_resource_connections c
             on c.tenant_id = mm.tenant_id
            and c.resource_id = mm.resource_id
            and c.connection_id = mm.connection_id
            and c.status = '${CONNECTION_STATUS}'`
        : ""
      const result = await options.sql.query<DatabaseRow>(
        `select ${MAPPING_COLUMNS}
           from genio_one_connection_model_mappings mm
           ${connectionJoin}
          where ${clauses.join(" and ")}
          order by mm.mapping_id asc`,
        parameters,
      )
      return result.rows.map((row) => mapMapping(row, now))
    },

    async create(input: {
      tenantId: string
      resourceId: string
      value: CreatePublicModelInput
    }) {
      assertTenantId(input.tenantId)
      assertIdentifier(input.resourceId, "RESOURCE_REQUIRED")
      const modelName = input.value.model_name.trim()
      const displayName = input.value.display_name.trim()
      if (!modelName) throw new PlatformApiError("INVALID_MODEL_NAME", 422)
      if (!displayName) throw new PlatformApiError("INVALID_MODEL_DISPLAY_NAME", 422)
      if (input.value.mappings.length === 0) {
        throw new PlatformApiError("MODEL_MAPPING_REQUIRED", 422)
      }
      const connectionIds = input.value.mappings.map((mapping) => mapping.connection_id)
      if (new Set(connectionIds).size !== connectionIds.length) {
        throw new PlatformApiError("MODEL_MAPPING_DUPLICATE_CONNECTION", 409)
      }

      const resource = await resourceRow(options.sql, input.tenantId, input.resourceId)
      if (!resource) throw new PlatformApiError("RESOURCE_NOT_FOUND", 404)
      if (resource.kind !== "LLM") {
        throw new PlatformApiError(
          "AI_MODEL_REQUIRES_LLM_RESOURCE",
          422,
          "Only an AI/LLM Resource can own a Public Model",
        )
      }
      if (resource.lifecycle !== "DRAFT") {
        throw new PlatformApiError(
          "PUBLISHED_RESOURCE_IMMUTABLE",
          409,
          "Public Models can only be configured while the Resource is a draft",
        )
      }

      const references = await Promise.all(
        input.value.mappings.map(async (mapping) => {
          const providerModel = mapping.provider_model.trim()
          if (!providerModel) throw new PlatformApiError("PROVIDER_MODEL_REQUIRED", 422)
          const connection = await connectionRow(
            options.sql,
            input.tenantId,
            input.resourceId,
            mapping.connection_id,
          )
          if (!connection) throw new PlatformApiError("CONNECTION_NOT_FOUND", 404)
          if (connection.status !== "READY") {
            throw new PlatformApiError(
              "CONNECTION_NOT_READY",
              409,
              "A Public Model mapping requires a ready Connection",
            )
          }
          const providerProfileId = rowString(connection, "provider_profile_id")
          const providerType = rowString(connection, "provider_type")
          const profile = await options.providers.get({
            tenantId: input.tenantId,
            profileId: providerProfileId,
          })
          if (profile.provider_type !== providerType) {
            throw new PlatformApiError("PROVIDER_PROFILE_TYPE_MISMATCH", 422)
          }
          return { mapping, providerModel, connection, profile }
        }),
      )

      const modelId = idFactory("model")
      try {
        return await options.sql.transaction(async (transaction) => {
          const lockedResource = await resourceRow(
            transaction,
            input.tenantId,
            input.resourceId,
            true,
          )
          if (!lockedResource) throw new PlatformApiError("RESOURCE_NOT_FOUND", 404)
          if (lockedResource.lifecycle !== "DRAFT") {
            throw new PlatformApiError("PUBLISHED_RESOURCE_IMMUTABLE", 409)
          }

          for (const reference of references) {
            const lockedConnection = await connectionRow(
              transaction,
              input.tenantId,
              input.resourceId,
              reference.mapping.connection_id,
              true,
            )
            if (!lockedConnection) throw new PlatformApiError("CONNECTION_NOT_FOUND", 404)
            if (lockedConnection.status !== "READY") {
              throw new PlatformApiError("CONNECTION_NOT_READY", 409)
            }
            if (
              rowString(lockedConnection, "provider_profile_id") !==
              rowString(reference.connection, "provider_profile_id")
            ) {
              throw new PlatformApiError("CONNECTION_REVISION_CONFLICT", 409)
            }
          }

          const modelResult = await transaction.query<DatabaseRow>(
            `insert into genio_one_public_models
              (tenant_id, model_id, model_name, display_name, resource_id,
               visibility, lifecycle, capabilities)
             values ($1, $2, $3, $4, $5, $6, 'PUBLISHED', $7::text::jsonb)
             returning ${MODEL_RETURNING_COLUMNS}`,
            [
              input.tenantId,
              modelId,
              modelName,
              displayName,
              input.resourceId,
              input.value.visibility ?? "PUBLIC",
              JSON.stringify(input.value.capabilities ?? [...references[0]!.profile.capabilities]),
            ],
          )
          const modelRow = modelResult.rows[0]
          if (!modelRow) throw new PlatformApiError("MODEL_CREATE_FAILED", 500)

          for (const reference of references) {
            const mappingId = mappingIdFactory("mapping")
            await transaction.query(
              `insert into genio_one_connection_model_mappings
                (tenant_id, mapping_id, public_model_id, resource_id,
                 connection_id, provider_model, mapping_revision)
               values ($1, $2, $3, $4, $5, $6, 1)`,
              [
                input.tenantId,
                mappingId,
                modelId,
                input.resourceId,
                reference.mapping.connection_id,
                reference.providerModel,
              ],
            )
          }
          return mapModel(modelRow, now)
        })
      } catch (error) {
        if (isSqlError(error, "23505")) {
          throw new PlatformApiError("MODEL_NAME_EXISTS", 409)
        }
        throw error
      }
    },

    async addMapping(input) {
      assertTenantId(input.tenantId)
      assertIdentifier(input.resourceId, "RESOURCE_REQUIRED")
      assertIdentifier(input.modelId, "MODEL_REQUIRED")
      assertIdentifier(input.value.connection_id, "CONNECTION_REQUIRED")
      const providerModel = input.value.provider_model.trim()
      if (!providerModel) throw new PlatformApiError("PROVIDER_MODEL_REQUIRED", 422)
      const mappingId = mappingIdFactory("mapping")
      try {
        return await options.sql.transaction(async (transaction) => {
          const resource = await resourceRow(transaction, input.tenantId, input.resourceId, true)
          if (!resource) throw new PlatformApiError("RESOURCE_NOT_FOUND", 404)
          if (resource.kind !== "LLM") throw new PlatformApiError("AI_MODEL_REQUIRES_LLM_RESOURCE", 422)
          const model = await transaction.query<DatabaseRow>(
            `select model_id
               from genio_one_public_models
              where tenant_id = $1 and resource_id = $2 and model_id = $3
              for update`,
            [input.tenantId, input.resourceId, input.modelId],
          )
          if (!model.rows[0]) throw new PlatformApiError("MODEL_NOT_FOUND", 404)
          const connection = await connectionRow(
            transaction,
            input.tenantId,
            input.resourceId,
            input.value.connection_id,
            true,
          )
          if (!connection) throw new PlatformApiError("CONNECTION_NOT_FOUND", 404)
          if (rowNumber(connection, "configuration_revision", "configuration_revision") !== input.value.expected_connection_revision) {
            throw new PlatformApiError("CONNECTION_REVISION_CONFLICT", 409)
          }
          if (
            connection.status !== "READY" ||
            connection.lifecycle !== "ENABLED" ||
            connection.verification_state !== "VERIFIED"
          ) {
            throw new PlatformApiError("CONNECTION_NOT_READY", 409)
          }
          const result = await transaction.query<DatabaseRow>(
            `insert into genio_one_connection_model_mappings
              (tenant_id, mapping_id, public_model_id, resource_id,
               connection_id, provider_model, mapping_revision)
             values ($1, $2, $3, $4, $5, $6, 1)
             returning tenant_id, mapping_id, public_model_id, resource_id,
                       connection_id, provider_model, mapping_revision, created_at`,
            [input.tenantId, mappingId, input.modelId, input.resourceId, input.value.connection_id, providerModel],
          )
          const row = result.rows[0]
          if (!row) throw new PlatformApiError("MODEL_MAPPING_CREATE_FAILED", 500)
          if (resource.lifecycle === "PUBLISHED") {
            await ensurePublicationSuccessorInTransaction({
              transaction,
              tenantId: input.tenantId,
              resourceId: input.resourceId,
              idFactory,
            })
          }
          return mapMapping(row, now)
        })
      } catch (error) {
        if (isSqlError(error, "23505")) throw new PlatformApiError("MODEL_MAPPING_DUPLICATE_CONNECTION", 409)
        throw error
      }
    },
  }
}
