import { createHash, randomUUID } from "node:crypto"

import type { SqlAdapter } from "../../persistence/sql-adapter"
import { PlatformApiError } from "../errors"
import type { ModelEntitlement, GrantModelEntitlementInput } from "./contract"
import type { ModelEntitlementCatalog } from "./module"
import type { ResourceLifecycleReleasePublisher } from "../resources/module"

type DatabaseRow = Record<string, unknown>

export interface PostgresModelEntitlementOptions {
  sql: SqlAdapter
  now?: () => number
  idFactory?: (prefix: string) => string
  releasePublisher?: ResourceLifecycleReleasePublisher
}

const COLUMNS = `
  tenant_id, entitlement_id, subject_id, client_id, resource_id, capability_id,
  public_model_id,
  state, extract(epoch from starts_at)::bigint as starts_at,
  case when expires_at is null then null else extract(epoch from expires_at)::bigint end as expires_at,
  extract(epoch from created_at)::bigint as created_at`

function text(row: DatabaseRow, key: string): string {
  const value = row[key]
  if (typeof value !== "string" || !value.trim()) throw new PlatformApiError("ENTITLEMENT_DATA_INVALID", 500)
  return value
}

function optionalText(row: DatabaseRow, key: string): string | null {
  const value = row[key]
  if (value === null || value === undefined) return null
  if (typeof value !== "string") throw new PlatformApiError("ENTITLEMENT_DATA_INVALID", 500)
  return value
}

function integer(row: DatabaseRow, key: string): number {
  const value = row[key]
  const parsed = typeof value === "bigint" ? Number(value) : Number(value)
  if (!Number.isSafeInteger(parsed)) throw new PlatformApiError("ENTITLEMENT_DATA_INVALID", 500)
  return parsed
}

function nullableInteger(row: DatabaseRow, key: string): number | null {
  return row[key] === null || row[key] === undefined ? null : integer(row, key)
}

function map(row: DatabaseRow): ModelEntitlement {
  const state = text(row, "state")
  if (state !== "ACTIVE" && state !== "REVOKED") {
    throw new PlatformApiError("ENTITLEMENT_DATA_INVALID", 500)
  }
  return {
    tenant_id: text(row, "tenant_id"),
    entitlement_id: text(row, "entitlement_id"),
    subject_id: optionalText(row, "subject_id"),
    client_id: optionalText(row, "client_id"),
    resource_id: text(row, "resource_id"),
    capability_id: text(row, "capability_id"),
    public_model_id: optionalText(row, "public_model_id"),
    state,
    starts_at: integer(row, "starts_at"),
    expires_at: nullableInteger(row, "expires_at"),
    created_at: integer(row, "created_at"),
  }
}

function validateWindow(value: GrantModelEntitlementInput, now: () => number) {
  if (!value.subject_id && !value.client_id) {
    throw new PlatformApiError("ENTITLEMENT_PRINCIPAL_REQUIRED", 422)
  }
  const startsAt = value.starts_at ?? now()
  const expiresAt = value.expires_at ?? null
  if (expiresAt !== null && expiresAt <= startsAt) {
    throw new PlatformApiError("ENTITLEMENT_WINDOW_INVALID", 422)
  }
  return { startsAt, expiresAt }
}

function normalizedIdempotencyKey(value: string | undefined): string | null {
  if (value === undefined) return null
  const key = value.trim()
  if (!key || key.length > 256) {
    throw new PlatformApiError("ENTITLEMENT_IDEMPOTENCY_KEY_INVALID", 422)
  }
  return key
}

function requestDigest(value: GrantModelEntitlementInput): string {
  return createHash("sha256").update(JSON.stringify([
    value.subject_id ?? null,
    value.client_id ?? null,
    value.resource_id,
    value.capability_id,
    value.public_model_id ?? null,
    value.starts_at ?? null,
    value.expires_at ?? null,
  ])).digest("hex")
}

async function idempotentEntitlement(
  executor: Pick<SqlAdapter, "query">,
  tenantId: string,
  idempotencyKey: string,
): Promise<{ entitlement: ModelEntitlement; requestDigest: string } | null> {
  const result = await executor.query<DatabaseRow>(
    `select ${COLUMNS}, grant_request_digest
       from genio_one_model_entitlements
      where tenant_id = $1
        and grant_idempotency_key = $2
      limit 1`,
    [tenantId, idempotencyKey],
  )
  const row = result.rows[0]
  if (!row) return null
  return { entitlement: map(row), requestDigest: text(row, "grant_request_digest") }
}

export function createPostgresModelEntitlementCatalog(
  options: PostgresModelEntitlementOptions,
): ModelEntitlementCatalog {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const idFactory = options.idFactory ?? ((prefix: string) => `${prefix}-${randomUUID()}`)
  return {
    async list({ tenantId }) {
      const result = await options.sql.query<DatabaseRow>(
        `select ${COLUMNS}
           from genio_one_model_entitlements
          where tenant_id = $1
          order by created_at desc, entitlement_id`,
        [tenantId],
      )
      return result.rows.map(map)
    },

    async grant({ tenantId, value, idempotencyKey }) {
      const key = normalizedIdempotencyKey(idempotencyKey)
      const digest = key ? requestDigest(value) : null
      return options.sql.transaction(async (transaction) => {
        if (key && digest) {
          const existing = await idempotentEntitlement(transaction, tenantId, key)
          if (existing) {
            if (existing.requestDigest !== digest) {
              throw new PlatformApiError("ENTITLEMENT_IDEMPOTENCY_KEY_REUSED", 409)
            }
            return existing.entitlement
          }
        }
        const { startsAt, expiresAt } = validateWindow(value, now)
        const result = await transaction.query<DatabaseRow>(
          `insert into genio_one_model_entitlements
           (tenant_id, entitlement_id, subject_id, client_id, resource_id,
            capability_id, public_model_id, state, starts_at, expires_at,
            grant_idempotency_key, grant_request_digest)
         select $1, $2, $3, $4, resource.resource_id, $6,
                model.model_id, 'ACTIVE', to_timestamp($8),
                case when $9::bigint is null then null else to_timestamp($9) end,
                $10, $11
           from genio_one_resources resource
           left join genio_one_public_models model
             on model.tenant_id = resource.tenant_id
            and model.resource_id = resource.resource_id
            and model.model_id = $7
          where resource.tenant_id = $1 and resource.resource_id = $5
            and resource.capabilities @> jsonb_build_array(
              jsonb_build_object('capability_id', $6::text)
            )
            and ($7::text is null or (
              model.model_id is not null and model.lifecycle = 'PUBLISHED'
            ))
         on conflict (tenant_id, grant_idempotency_key)
           where grant_idempotency_key is not null do nothing
         returning ${COLUMNS}`,
          [
            tenantId,
            idFactory("entitlement"),
            value.subject_id ?? null,
            value.client_id ?? null,
            value.resource_id,
            value.capability_id,
            value.public_model_id ?? null,
            startsAt,
            expiresAt,
            key,
            digest,
          ],
        )
        const row = result.rows[0]
        if (!row) {
          if (key && digest) {
            const concurrent = await idempotentEntitlement(transaction, tenantId, key)
            if (concurrent) {
              if (concurrent.requestDigest !== digest) {
                throw new PlatformApiError("ENTITLEMENT_IDEMPOTENCY_KEY_REUSED", 409)
              }
              return concurrent.entitlement
            }
          }
          throw new PlatformApiError("ENTITLEMENT_TARGET_NOT_FOUND", 404)
        }
        const publication = await transaction.query<{ gateway_id: string }>(
          `select gateway_id from genio_one_publications
            where tenant_id = $1 and resource_id = $2 and publication_state = 'PUBLISHED'
            order by endpoint_revision desc limit 1 for update`,
          [tenantId, value.resource_id],
        )
        if (publication.rows[0]) {
          if (!options.releasePublisher) {
            throw new PlatformApiError("GATEWAY_RELEASE_PUBLISHER_REQUIRED", 500)
          }
          await options.releasePublisher.reconcileInTransaction({
            transaction,
            tenantId,
            gatewayId: publication.rows[0].gateway_id,
            issuedAt: now(),
          })
        }
        return map(row)
      })
    },

    async revoke({ tenantId, entitlementId }) {
      return options.sql.transaction(async (transaction) => {
        const current = await transaction.query<{ resource_id: string; gateway_id: string | null }>(
          `select entitlement.resource_id, publication.gateway_id
             from genio_one_model_entitlements entitlement
             left join lateral (
               select gateway_id from genio_one_publications publication
                where publication.tenant_id = entitlement.tenant_id
                  and publication.resource_id = entitlement.resource_id
                  and publication.publication_state = 'PUBLISHED'
                order by publication.endpoint_revision desc limit 1
             ) publication on true
            where entitlement.tenant_id = $1 and entitlement.entitlement_id = $2
            for update of entitlement`,
          [tenantId, entitlementId],
        )
        const result = await transaction.query<DatabaseRow>(
          `update genio_one_model_entitlements
            set state = 'REVOKED', row_revision = row_revision + 1, updated_at = now()
          where tenant_id = $1 and entitlement_id = $2
          returning ${COLUMNS}`,
          [tenantId, entitlementId],
        )
        const row = result.rows[0]
        if (!row) throw new PlatformApiError("ENTITLEMENT_NOT_FOUND", 404)
        const gatewayId = current.rows[0]?.gateway_id
        if (gatewayId) {
          if (!options.releasePublisher) {
            throw new PlatformApiError("GATEWAY_RELEASE_PUBLISHER_REQUIRED", 500)
          }
          await options.releasePublisher.reconcileInTransaction({
            transaction,
            tenantId,
            gatewayId,
            issuedAt: now(),
          })
        }
        return map(row)
      })
    },

    async resolve(input) {
      const result = await options.sql.query<{ public_model_id: string }>(
        `select distinct model.model_id as public_model_id
           from genio_one_model_entitlements entitlement
           join genio_one_resources resource
             on resource.tenant_id = entitlement.tenant_id
            and resource.resource_id = entitlement.resource_id
           join genio_one_public_models model
             on model.tenant_id = resource.tenant_id
            and model.resource_id = resource.resource_id
            and (entitlement.public_model_id is null or model.model_id = entitlement.public_model_id)
          where entitlement.tenant_id = $1
            and entitlement.state = 'ACTIVE'
            and entitlement.starts_at <= now()
            and (entitlement.expires_at is null or entitlement.expires_at > now())
            and (entitlement.subject_id is null or entitlement.subject_id = $2)
            and (entitlement.client_id is null or entitlement.client_id = $3)
            and ($4::text is null or model.model_id = $4)
            and ($5::text is null or model.model_id = $5)
            and model.lifecycle = 'PUBLISHED'
            and resource.lifecycle = 'PUBLISHED'
          order by model.model_id`,
        [
          input.tenantId,
          input.subjectId,
          input.clientId,
          input.publicModelId ?? null,
          input.requestedModelId ?? null,
        ],
      )
      return result.rows.map((row) => row.public_model_id)
    },
  }
}
