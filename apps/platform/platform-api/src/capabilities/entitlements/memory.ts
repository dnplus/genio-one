import { PlatformApiError } from "../errors"
import type { ModelEntitlementCatalog } from "./module"
import type { GrantModelEntitlementInput, ModelEntitlement } from "./contract"
import type { PublicModelCatalog } from "../models/module"

export interface InMemoryModelEntitlementOptions {
  now?: () => number
  idFactory?: (sequence: number) => string
  models?: PublicModelCatalog
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
  return JSON.stringify([
    value.subject_id ?? null,
    value.client_id ?? null,
    value.resource_id,
    value.capability_id,
    value.public_model_id ?? null,
    value.starts_at ?? null,
    value.expires_at ?? null,
  ])
}

export function createInMemoryModelEntitlementCatalog(
  options: InMemoryModelEntitlementOptions = {},
): ModelEntitlementCatalog {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const idFactory = options.idFactory ?? ((sequence) => `entitlement-${sequence}`)
  const values = new Map<string, ModelEntitlement>()
  const idempotentGrants = new Map<string, { requestDigest: string; entitlementId: string }>()
  let sequence = 0

  return {
    async list({ tenantId }) {
      return [...values.values()]
        .filter((value) => value.tenant_id === tenantId)
        .sort((left, right) => left.entitlement_id.localeCompare(right.entitlement_id))
    },

    async grant({ tenantId, value, idempotencyKey }) {
      const key = normalizedIdempotencyKey(idempotencyKey)
      const digest = key ? requestDigest(value) : null
      if (key && digest) {
        const existing = idempotentGrants.get(`${tenantId}\u0000${key}`)
        if (existing) {
          if (existing.requestDigest !== digest) {
            throw new PlatformApiError("ENTITLEMENT_IDEMPOTENCY_KEY_REUSED", 409)
          }
          const entitlement = values.get(`${tenantId}:${existing.entitlementId}`)
          if (!entitlement) throw new PlatformApiError("ENTITLEMENT_DATA_INVALID", 500)
          return entitlement
        }
      }
      if (!value.subject_id && !value.client_id) {
        throw new PlatformApiError("ENTITLEMENT_PRINCIPAL_REQUIRED", 422)
      }
      const startsAt = value.starts_at ?? now()
      const expiresAt = value.expires_at ?? null
      if (expiresAt !== null && expiresAt <= startsAt) {
        throw new PlatformApiError("ENTITLEMENT_WINDOW_INVALID", 422)
      }
      sequence += 1
      const entitlement: ModelEntitlement = {
        tenant_id: tenantId,
        entitlement_id: idFactory(sequence),
        subject_id: value.subject_id ?? null,
        client_id: value.client_id ?? null,
        resource_id: value.resource_id,
        capability_id: value.capability_id,
        public_model_id: value.public_model_id ?? null,
        state: "ACTIVE",
        starts_at: startsAt,
        expires_at: expiresAt,
        created_at: now(),
      }
      values.set(`${tenantId}:${entitlement.entitlement_id}`, entitlement)
      if (key && digest) {
        idempotentGrants.set(`${tenantId}\u0000${key}`, {
          requestDigest: digest,
          entitlementId: entitlement.entitlement_id,
        })
      }
      return entitlement
    },

    async revoke({ tenantId, entitlementId }) {
      const key = `${tenantId}:${entitlementId}`
      const current = values.get(key)
      if (!current) throw new PlatformApiError("ENTITLEMENT_NOT_FOUND", 404)
      const revoked = { ...current, state: "REVOKED" as const }
      values.set(key, revoked)
      return revoked
    },

    async resolve(input) {
      const currentTime = now()
      const grants = [...values.values()]
        .filter(
          (value) =>
            value.tenant_id === input.tenantId &&
            value.state === "ACTIVE" &&
            value.starts_at <= currentTime &&
            (value.expires_at === null || value.expires_at > currentTime) &&
            (value.subject_id === null || value.subject_id === input.subjectId) &&
            (value.client_id === null || value.client_id === input.clientId) &&
            (!input.publicModelId || value.public_model_id === null || value.public_model_id === input.publicModelId) &&
            (!input.requestedModelId || value.public_model_id === null || value.public_model_id === input.requestedModelId),
        )
      const resolved = (await Promise.all(grants.map(async (value) => {
        if (value.public_model_id !== null) return [value.public_model_id]
        if (!options.models) return []
        return (await options.models.list({ tenantId: input.tenantId, resourceId: value.resource_id }))
          .filter((model) => model.lifecycle === "PUBLISHED")
          .map((model) => model.model_id)
      }))).flat()
      return resolved
        .filter((value) => !input.publicModelId || value === input.publicModelId)
        .filter((value) => !input.requestedModelId || value === input.requestedModelId)
        .filter((value, index, all) => all.indexOf(value) === index)
        .sort()
    },
  }
}
