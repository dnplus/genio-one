import type { McpOAuthSecretCodec } from "../mcp-oauth/crypto"
import { validateCredentialMaterial } from "./material"
import { randomUUID } from "node:crypto"

import { Check } from "typebox/value"

import type { SqlAdapter, SqlTransaction } from "../../persistence/sql-adapter"
import { PlatformApiError } from "../errors"
import { ProviderCredentialStrategySchema } from "./contract"
import type {
  ProviderCredentialProfileRevision,
  ProviderCredentialStrategy,
} from "./contract"
import {
  canonicalProviderCredentialStrategy,
  providerCredentialAdapterFamily,
  providerCredentialStrategyDigest,
} from "./memory"
import type { ProviderCredentialProfileStore } from "./module"

type Row = Record<string, unknown>

function sqlCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : null
}

export const PROVIDER_CREDENTIAL_PROFILE_COLUMNS = `
  tenant_id,
  profile_id,
  revision,
  owner_organization_id,
  display_name,
  adapter_family,
  strategy,
  strategy_digest,
  state,
  created_by_subject_id,
  (credential_ciphertext is not null) as credential_configured,
  extract(epoch from created_at)::bigint as created_at`

function text(row: Row, field: string): string {
  const value = row[field]
  if (typeof value !== "string" || !value.trim()) {
    throw new PlatformApiError("PROVIDER_CREDENTIAL_PROFILE_DATA_INVALID", 500)
  }
  return value
}

function integer(row: Row, field: string): number {
  const value = Number(row[field])
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new PlatformApiError("PROVIDER_CREDENTIAL_PROFILE_DATA_INVALID", 500)
  }
  return value
}

function json(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new PlatformApiError("PROVIDER_CREDENTIAL_PROFILE_DATA_INVALID", 500)
  }
}

export function mapProviderCredentialProfileRow(row: Row): ProviderCredentialProfileRevision {
  const strategy = json(row.strategy)
  if (!Check(ProviderCredentialStrategySchema, strategy)) {
    throw new PlatformApiError("PROVIDER_CREDENTIAL_PROFILE_DATA_INVALID", 500)
  }
  const adapterFamily = text(row, "adapter_family")
  if (adapterFamily !== "GENERIC" && adapterFamily !== "GCP") {
    throw new PlatformApiError("PROVIDER_CREDENTIAL_PROFILE_DATA_INVALID", 500)
  }
  const state = text(row, "state")
  if (state !== "ACTIVE" && state !== "REVOKED") {
    throw new PlatformApiError("PROVIDER_CREDENTIAL_PROFILE_DATA_INVALID", 500)
  }
  return {
    ...(row.credential_configured === true ? { credential_configured: true } : {}),
    tenant_id: text(row, "tenant_id"),
    profile_id: text(row, "profile_id"),
    revision: integer(row, "revision"),
    owner_organization_id: text(row, "owner_organization_id"),
    display_name: text(row, "display_name"),
    adapter_family: adapterFamily,
    strategy,
    strategy_digest: text(row, "strategy_digest"),
    state,
    created_by_subject_id: text(row, "created_by_subject_id"),
    created_at: Number(row.created_at),
  }
}

async function latest(
  executor: SqlAdapter | SqlTransaction,
  tenantId: string,
  profileId: string,
  forUpdate = false,
): Promise<ProviderCredentialProfileRevision | null> {
  const result = await executor.query<Row>(
    `select ${PROVIDER_CREDENTIAL_PROFILE_COLUMNS}
       from genio_one_provider_credential_profile_revisions
      where tenant_id = $1 and profile_id = $2
      order by revision desc
      limit 1${forUpdate ? " for update" : ""}`,
    [tenantId, profileId],
  )
  return result.rows[0] ? mapProviderCredentialProfileRow(result.rows[0]) : null
}

async function insert(input: {
  transaction: SqlTransaction
  tenantId: string
  profileId: string
  revision: number
  ownerOrganizationId: string
  displayName: string
  strategy: ProviderCredentialStrategy
  state: ProviderCredentialProfileRevision["state"]
  createdBySubjectId: string
  material?: string
  codec?: McpOAuthSecretCodec
}): Promise<ProviderCredentialProfileRevision> {
  const strategy = canonicalProviderCredentialStrategy({
    strategy: input.strategy,
  })
  const material = input.material ? validateCredentialMaterial(input.material, strategy) : null
  if (material && !input.codec) throw new PlatformApiError("PROVIDER_CREDENTIAL_STORAGE_UNAVAILABLE", 503)
  const sealed = material ? input.codec!.seal({ tenantId: input.tenantId, profileId: input.profileId, revision: input.revision, material }) : null
  const result = await input.transaction.query<Row>(
    `insert into genio_one_provider_credential_profile_revisions
       (tenant_id, profile_id, revision, owner_organization_id, display_name,
        adapter_family, strategy, strategy_digest, state, created_by_subject_id, credential_ciphertext)
     values ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8, $9, $10, $11)
     returning ${PROVIDER_CREDENTIAL_PROFILE_COLUMNS}`,
    [
      input.tenantId,
      input.profileId,
      input.revision,
      input.ownerOrganizationId,
      input.displayName.trim(),
      providerCredentialAdapterFamily(strategy),
      JSON.stringify(strategy),
      providerCredentialStrategyDigest(strategy),
      input.state,
      input.createdBySubjectId,
      sealed,
    ],
  )
  if (!result.rows[0]) throw new PlatformApiError("PROVIDER_CREDENTIAL_PROFILE_WRITE_FAILED", 500)
  return mapProviderCredentialProfileRow(result.rows[0])
}

export function createPostgresProviderCredentialProfileStore(options: {
  sql: SqlAdapter
  idFactory?: () => string
  codec?: McpOAuthSecretCodec
}): ProviderCredentialProfileStore {
  const idFactory = options.idFactory ?? (() => `provider-credential-profile-${randomUUID()}`)
  async function readStored(executor: SqlAdapter | SqlTransaction, input: { tenantId: string; profileId: string; revision: number }) {
    const result = await executor.query<Row>("select credential_ciphertext from genio_one_provider_credential_profile_revisions where tenant_id = $1 and profile_id = $2 and revision = $3", [input.tenantId, input.profileId, input.revision])
    const sealed = result.rows[0]?.credential_ciphertext
    if (typeof sealed !== "string") return null
    if (!options.codec) throw new PlatformApiError("PROVIDER_CREDENTIAL_STORAGE_UNAVAILABLE", 503)
    const decoded = options.codec.open<{ tenantId: string; profileId: string; revision: number; material: string }>(sealed)
    if (decoded.tenantId !== input.tenantId || decoded.profileId !== input.profileId || decoded.revision !== input.revision) throw new PlatformApiError("PROVIDER_CREDENTIAL_STORAGE_INVALID", 500)
    return decoded.material
  }
  return {
    async readMaterial(input) {
      if ((await latest(options.sql, input.tenantId, input.profileId))?.state !== "ACTIVE") return null
      return readStored(options.sql, input)
    },
    async listLatest(input) {
      const result = await options.sql.query<Row>(
        `select distinct on (profile_id) ${PROVIDER_CREDENTIAL_PROFILE_COLUMNS}
           from genio_one_provider_credential_profile_revisions
          where tenant_id = $1
          order by profile_id, revision desc`,
        [input.tenantId],
      )
      return result.rows.map(mapProviderCredentialProfileRow)
        .sort((left, right) => left.display_name.localeCompare(right.display_name) || left.profile_id.localeCompare(right.profile_id))
    },
    getLatest(input) {
      return latest(options.sql, input.tenantId, input.profileId)
    },
    async getRevision(input) {
      const result = await options.sql.query<Row>(
        `select ${PROVIDER_CREDENTIAL_PROFILE_COLUMNS}
           from genio_one_provider_credential_profile_revisions
          where tenant_id = $1 and profile_id = $2 and revision = $3`,
        [input.tenantId, input.profileId, input.revision],
      )
      return result.rows[0] ? mapProviderCredentialProfileRow(result.rows[0]) : null
    },
    create(input) {
      return options.sql.transaction(async (transaction) => {
        const profileId = input.value.profile_id?.trim() || idFactory()
        if (await latest(transaction, input.tenantId, profileId, true)) {
          throw new PlatformApiError("PROVIDER_CREDENTIAL_PROFILE_EXISTS", 409)
        }
        return insert({
          transaction,
          tenantId: input.tenantId,
          profileId,
          revision: 1,
          material: input.value.credential_material,
          codec: options.codec,
          ownerOrganizationId: input.value.owner_organization_id,
          displayName: input.value.display_name,
          strategy: input.value.strategy,
          state: "ACTIVE",
          createdBySubjectId: input.createdBySubjectId,
        })
      }).catch((error: unknown) => {
        if (sqlCode(error) === "23505") {
          throw new PlatformApiError("PROVIDER_CREDENTIAL_PROFILE_EXISTS", 409)
        }
        throw error
      })
    },
    revise(input) {
      return options.sql.transaction(async (transaction) => {
        const current = await latest(transaction, input.tenantId, input.profileId, true)
        if (!current) throw new PlatformApiError("PROVIDER_CREDENTIAL_PROFILE_NOT_FOUND", 404)
        if (current.state === "REVOKED") {
          throw new PlatformApiError("PROVIDER_CREDENTIAL_PROFILE_REVOKED", 409)
        }
        if (current.revision !== input.value.expected_revision) {
          throw new PlatformApiError("PROVIDER_CREDENTIAL_PROFILE_REVISION_CONFLICT", 409)
        }
        return insert({
          transaction,
          tenantId: input.tenantId,
          profileId: input.profileId,
          revision: current.revision + 1,
          material: input.value.credential_material ?? (await readStored(transaction, { tenantId: input.tenantId, profileId: input.profileId, revision: current.revision })) ?? undefined,
          codec: options.codec,
          ownerOrganizationId: current.owner_organization_id,
          displayName: input.value.display_name,
          strategy: input.value.strategy,
          state: input.value.state,
          createdBySubjectId: input.createdBySubjectId,
        })
      })
    },
  }
}
