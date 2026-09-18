import { randomUUID } from "node:crypto"

import { PlatformApiError } from "../errors"
import type { SqlAdapter, SqlTransaction } from "../../persistence/sql-adapter"
import type {
  CreateProviderProfileInput,
  ProviderCapability,
  ProviderProfile,
  ProviderType,
} from "./contract"
import type { ProviderProfileCatalog } from "./module"

type DatabaseRow = Record<string, unknown>

export interface PostgresProviderProfileOptions {
  sql: SqlAdapter
  now?: () => number
  idFactory?: (prefix: string) => string
}

const PROVIDER_TYPES = ["GENERIC_OPENAI_COMPATIBLE", "OPENAI", "OMLX", "OLLAMA", "GCP_VERTEX_AI", "ANTHROPIC"] as const
const PROVIDER_PROTOCOLS = ["OPENAI_COMPATIBLE", "OLLAMA_NATIVE", "GCP_VERTEX_AI", "ANTHROPIC"] as const
const MODEL_DISCOVERY = ["STATIC", "PROVIDER_API", "MANUAL"] as const
const PROVIDER_CAPABILITIES = [
  "CHAT",
  "STREAMING",
  "TOOL_CALLING",
  "VISION",
  "REASONING",
  "EMBEDDINGS",
] as const

type ProviderProtocol = "OPENAI_COMPATIBLE" | "OLLAMA_NATIVE" | "GCP_VERTEX_AI" | "ANTHROPIC"

const PROVIDER_COLUMNS = `
  tenant_id,
  profile_id,
  display_name,
  provider_type,
  protocol,
  capabilities,
  model_discovery,
  endpoint_required,
  credential_required,
  built_in`

interface BuiltInProfile {
  profile_id: string
  display_name: string
  provider_type: ProviderType
  protocol: ProviderProtocol
  capabilities: ProviderCapability[]
  model_discovery: "STATIC" | "PROVIDER_API" | "MANUAL"
  endpoint_required: boolean
  credential_required: boolean
}

const BUILT_IN_PROFILES: readonly BuiltInProfile[] = [
  {
    profile_id: "provider-generic-openai-compatible",
    display_name: "Generic OpenAI-compatible API",
    provider_type: "GENERIC_OPENAI_COMPATIBLE",
    protocol: "OPENAI_COMPATIBLE",
    capabilities: ["CHAT", "STREAMING"],
    model_discovery: "MANUAL",
    endpoint_required: true,
    credential_required: false,
  },
  {
    profile_id: "provider-openai",
    display_name: "OpenAI",
    provider_type: "OPENAI",
    protocol: "OPENAI_COMPATIBLE",
    capabilities: ["CHAT", "STREAMING", "TOOL_CALLING", "VISION", "REASONING", "EMBEDDINGS"],
    model_discovery: "PROVIDER_API",
    endpoint_required: true,
    credential_required: true,
  },
  {
    profile_id: "provider-omlx",
    display_name: "OMLX (local)",
    provider_type: "OMLX",
    protocol: "OPENAI_COMPATIBLE",
    capabilities: ["CHAT", "STREAMING", "TOOL_CALLING", "VISION"],
    model_discovery: "MANUAL",
    endpoint_required: true,
    credential_required: false,
  },
  {
    profile_id: "provider-ollama",
    display_name: "Ollama (local)",
    provider_type: "OLLAMA",
    protocol: "OPENAI_COMPATIBLE",
    capabilities: ["CHAT", "STREAMING", "TOOL_CALLING", "VISION", "EMBEDDINGS"],
    model_discovery: "PROVIDER_API",
    endpoint_required: true,
    credential_required: false,
  },
  {
    profile_id: "provider-gcp-vertex-ai",
    display_name: "Google Vertex AI",
    provider_type: "GCP_VERTEX_AI",
    protocol: "GCP_VERTEX_AI",
    capabilities: ["CHAT", "STREAMING", "TOOL_CALLING", "VISION", "REASONING", "EMBEDDINGS"],
    model_discovery: "PROVIDER_API",
    endpoint_required: true,
    credential_required: true,
  },
  {
    profile_id: "provider-anthropic",
    display_name: "Anthropic",
    provider_type: "ANTHROPIC",
    protocol: "ANTHROPIC",
    capabilities: ["CHAT", "STREAMING", "TOOL_CALLING", "VISION", "REASONING"],
    model_discovery: "PROVIDER_API",
    endpoint_required: true,
    credential_required: true,
  },
]

function assertTenantId(tenantId: string): void {
  if (!tenantId.trim()) {
    throw new PlatformApiError("TENANT_REQUIRED", 422, "A tenant id is required")
  }
}

function rowString(row: DatabaseRow, key: string): string {
  const value = row[key]
  if (typeof value !== "string" || !value.trim()) {
    throw new PlatformApiError("PROVIDER_PROFILE_DATA_INVALID", 500, `Persisted ${key} is invalid`)
  }
  return value
}

function rowBoolean(row: DatabaseRow, key: string): boolean {
  const value = row[key]
  if (typeof value === "boolean") return value
  if (value === "t" || value === "true" || value === 1 || value === "1") return true
  if (value === "f" || value === "false" || value === 0 || value === "0") return false
  throw new PlatformApiError("PROVIDER_PROFILE_DATA_INVALID", 500, `Persisted ${key} is invalid`)
}

function enumValue<T extends string>(value: unknown, values: readonly T[], key: string): T {
  if (typeof value === "string" && values.includes(value as T)) return value as T
  throw new PlatformApiError("PROVIDER_PROFILE_DATA_INVALID", 500, `Persisted ${key} is invalid`)
}

function jsonArray(value: unknown): unknown[] {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      throw new PlatformApiError("PROVIDER_PROFILE_DATA_INVALID", 500, "Persisted capabilities are invalid")
    }
  }
  if (!Array.isArray(value)) {
    throw new PlatformApiError("PROVIDER_PROFILE_DATA_INVALID", 500, "Persisted capabilities are invalid")
  }
  return value
}

function mapProfile(row: DatabaseRow): ProviderProfile {
  const capabilities = jsonArray(row.capabilities).map((value) => {
    if (typeof value !== "string" || !PROVIDER_CAPABILITIES.includes(value as ProviderCapability)) {
      throw new PlatformApiError("PROVIDER_PROFILE_DATA_INVALID", 500, "Persisted capability is invalid")
    }
    return value as ProviderCapability
  })
  return {
    tenant_id: rowString(row, "tenant_id"),
    profile_id: rowString(row, "profile_id"),
    display_name: rowString(row, "display_name"),
    provider_type: enumValue(row.provider_type, PROVIDER_TYPES, "provider_type"),
    protocol: enumValue(row.protocol, PROVIDER_PROTOCOLS, "protocol"),
    capabilities,
    model_discovery: enumValue(row.model_discovery, MODEL_DISCOVERY, "model_discovery"),
    endpoint_required: rowBoolean(row, "endpoint_required"),
    credential_required: rowBoolean(row, "credential_required"),
    built_in: rowBoolean(row, "built_in"),
  }
}

function isSqlError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}

async function ensureBuiltIns(
  sql: SqlAdapter,
  tenantId: string,
): Promise<void> {
  await sql.transaction(async (transaction) => {
    for (const profile of BUILT_IN_PROFILES) {
      await transaction.query(
        `insert into genio_one_provider_profiles
          (tenant_id, profile_id, display_name, provider_type, protocol,
           capabilities, model_discovery, endpoint_required, credential_required, built_in)
         values ($1, $2, $3, $4, $5, $6::text::jsonb, $7, $8, $9, true)
         on conflict (tenant_id, profile_id) do nothing`,
        [
          tenantId,
          profile.profile_id,
          profile.display_name,
          profile.provider_type,
          profile.protocol,
          JSON.stringify(profile.capabilities),
          profile.model_discovery,
          profile.endpoint_required,
          profile.credential_required,
        ],
      )
    }
  })
}

async function findProfile(
  executor: SqlAdapter | SqlTransaction,
  tenantId: string,
  profileId: string,
): Promise<DatabaseRow | null> {
  const result = await executor.query<DatabaseRow>(
    `select ${PROVIDER_COLUMNS}
       from genio_one_provider_profiles
      where tenant_id = $1 and profile_id = $2`,
    [tenantId, profileId],
  )
  return result.rows[0] ?? null
}

export function createPostgresProviderProfileCatalog(
  options: PostgresProviderProfileOptions,
): ProviderProfileCatalog {
  const idFactory = options.idFactory ?? ((prefix: string) => `${prefix}-${randomUUID()}`)

  return {
    async list(input) {
      assertTenantId(input.tenantId)
      await ensureBuiltIns(options.sql, input.tenantId)
      const result = await options.sql.query<DatabaseRow>(
        `select ${PROVIDER_COLUMNS}
           from genio_one_provider_profiles
          where tenant_id = $1
          order by display_name asc, profile_id asc`,
        [input.tenantId],
      )
      return result.rows.map(mapProfile)
    },

    async get(input) {
      assertTenantId(input.tenantId)
      if (!input.profileId?.trim()) throw new PlatformApiError("PROVIDER_PROFILE_REQUIRED", 422)
      await ensureBuiltIns(options.sql, input.tenantId)
      const row = await findProfile(options.sql, input.tenantId, input.profileId)
      if (!row) throw new PlatformApiError("PROVIDER_PROFILE_NOT_FOUND", 404)
      return mapProfile(row)
    },

    async findDefault(input) {
      assertTenantId(input.tenantId)
      await ensureBuiltIns(options.sql, input.tenantId)
      if (!PROVIDER_TYPES.includes(input.providerType)) {
        throw new PlatformApiError("UNSUPPORTED_PROVIDER_TYPE", 422)
      }
      const result = await options.sql.query<DatabaseRow>(
        `select ${PROVIDER_COLUMNS}
           from genio_one_provider_profiles
          where tenant_id = $1 and provider_type = $2 and built_in = true
          order by profile_id asc
          limit 1`,
        [input.tenantId, input.providerType],
      )
      const row = result.rows[0]
      if (!row) throw new PlatformApiError("PROVIDER_PROFILE_NOT_FOUND", 404)
      return mapProfile(row)
    },

    async create(input: { tenantId: string; value: CreateProviderProfileInput }) {
      assertTenantId(input.tenantId)
      const defaults = BUILT_IN_PROFILES.find(
        (profile) => profile.provider_type === input.value.provider_type,
      )
      if (!defaults) throw new PlatformApiError("UNSUPPORTED_PROVIDER_TYPE", 422)
      const protocol = input.value.protocol ?? defaults.protocol
      if (protocol === "OLLAMA_NATIVE" && input.value.provider_type !== "OLLAMA") {
        throw new PlatformApiError(
          "PROVIDER_PROTOCOL_NOT_SUPPORTED",
          422,
          "OLLAMA_NATIVE is only valid for an Ollama provider profile",
        )
      }
      if (protocol === "GCP_VERTEX_AI" && input.value.provider_type !== "GCP_VERTEX_AI") {
        throw new PlatformApiError(
          "PROVIDER_PROTOCOL_NOT_SUPPORTED",
          422,
          "GCP_VERTEX_AI is only valid for a Google Vertex AI provider profile",
        )
      }
      if (protocol === "ANTHROPIC" && input.value.provider_type !== "ANTHROPIC") {
        throw new PlatformApiError(
          "PROVIDER_PROTOCOL_NOT_SUPPORTED",
          422,
          "ANTHROPIC is only valid for an Anthropic provider profile",
        )
      }
      const capabilities = input.value.capabilities ?? [...defaults.capabilities]
      if (capabilities.length === 0) {
        throw new PlatformApiError("PROVIDER_CAPABILITIES_REQUIRED", 422)
      }
      const displayName = input.value.display_name.trim()
      if (!displayName) throw new PlatformApiError("INVALID_PROVIDER_PROFILE_NAME", 422)
      const profileId = idFactory("provider-profile")
      try {
        const result = await options.sql.query<DatabaseRow>(
          `insert into genio_one_provider_profiles
            (tenant_id, profile_id, display_name, provider_type, protocol,
             capabilities, model_discovery, endpoint_required, credential_required, built_in)
           values ($1, $2, $3, $4, $5, $6::text::jsonb, $7, $8, $9, false)
           returning ${PROVIDER_COLUMNS}`,
          [
            input.tenantId,
            profileId,
            displayName,
            input.value.provider_type,
            protocol,
            JSON.stringify(capabilities),
            input.value.model_discovery ?? defaults.model_discovery,
            defaults.endpoint_required,
            defaults.credential_required,
          ],
        )
        const row = result.rows[0]
        if (!row) throw new PlatformApiError("PROVIDER_PROFILE_CREATE_FAILED", 500)
        return mapProfile(row)
      } catch (error) {
        if (isSqlError(error, "23505")) {
          throw new PlatformApiError("PROVIDER_PROFILE_ID_EXISTS", 409)
        }
        throw error
      }
    },
  }
}
