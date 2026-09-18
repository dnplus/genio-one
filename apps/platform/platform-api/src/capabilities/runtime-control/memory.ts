import { createPublicKey } from "node:crypto"

import { PlatformApiError } from "../errors"
import type {
  RegisterGatewayRuntimeInput,
  RuntimeControlStore,
  RuntimeRegistration,
  RuntimeRegistrationKey,
  RuntimeSessionLease,
} from "./contract"

export interface InMemoryRuntimeControlStoreOptions {
  now?: () => number
  registrations?: readonly RegisterGatewayRuntimeInput[]
}

function valueKey(tenantId: string, runtimeId: string): string {
  return `${tenantId}\u0000GATEWAY\u0000${runtimeId}`
}

function requireIdentifier(value: string, code: string): void {
  if (!value.trim() || value.trim() !== value) throw new PlatformApiError(code, 422)
}

function requireKeyMaterial(value: string, code: string): void {
  if (!value.trim()) throw new PlatformApiError(code, 422)
}

function validatePublicKey(publicKeyPem: string): void {
  try {
    const key = createPublicKey(publicKeyPem)
    if (key.asymmetricKeyType !== "ed25519") throw new Error("not Ed25519")
  } catch {
    throw new PlatformApiError(
      "RUNTIME_REPORT_KEY_INVALID",
      422,
      "Runtime report public key must be a valid Ed25519 key",
    )
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function assertTtl(ttlSeconds: number): void {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86_400) {
    throw new PlatformApiError("RUNTIME_SESSION_LEASE_TTL_INVALID", 422)
  }
}

export function createInMemoryRuntimeControlStore(
  options: InMemoryRuntimeControlStoreOptions = {},
): RuntimeControlStore {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const registrations = new Map<string, RuntimeRegistration>()
  const leases = new Map<string, RuntimeSessionLease>()

  const register = (input: RegisterGatewayRuntimeInput): RuntimeRegistration => {
    requireIdentifier(input.tenantId, "TENANT_REQUIRED")
    requireIdentifier(input.runtimeId, "RUNTIME_ID_REQUIRED")
    requireIdentifier(input.targetId, "RUNTIME_TARGET_REQUIRED")
    requireIdentifier(input.oidcClientId, "RUNTIME_OIDC_CLIENT_REQUIRED")
    requireIdentifier(input.reportKeyId, "RUNTIME_REPORT_KEY_ID_REQUIRED")
    requireKeyMaterial(input.reportPublicKeyPem, "RUNTIME_REPORT_KEY_REQUIRED")
    validatePublicKey(input.reportPublicKeyPem)
    const key = valueKey(input.tenantId, input.runtimeId)
    const timestamp = now()
    const current = registrations.get(key)
    if (current) {
      if (
        current.target_id === input.targetId &&
        current.oidc_client_id === input.oidcClientId &&
        current.report_key_id === input.reportKeyId &&
        current.report_public_key_pem === input.reportPublicKeyPem &&
        current.status === (input.status ?? current.status)
      ) return clone(current)
      const updated: RuntimeRegistration = {
        ...current,
        target_id: input.targetId,
        oidc_client_id: input.oidcClientId,
        report_key_id: input.reportKeyId,
        report_public_key_pem: input.reportPublicKeyPem,
        status: input.status ?? current.status,
        row_revision: current.row_revision + 1,
        updated_at: timestamp,
      }
      registrations.set(key, updated)
      return clone(updated)
    }
    const created: RuntimeRegistration = {
      tenant_id: input.tenantId,
      runtime_kind: "GATEWAY",
      runtime_id: input.runtimeId,
      target_id: input.targetId,
      oidc_client_id: input.oidcClientId,
      report_key_id: input.reportKeyId,
      report_public_key_pem: input.reportPublicKeyPem,
      status: input.status ?? "ACTIVE",
      row_revision: 1,
      created_at: timestamp,
      updated_at: timestamp,
    }
    registrations.set(key, created)
    return clone(created)
  }

  for (const registration of options.registrations ?? []) register(registration)

  const getRegistration = (input: RuntimeRegistrationKey): RuntimeRegistration | null =>
    clone(registrations.get(valueKey(input.tenantId, input.runtimeId)) ?? null)

  return {
    async registerGatewayRuntime(input) {
      return register(input)
    },
    async getGatewayRuntime(input) {
      if (input.runtimeKind !== undefined && input.runtimeKind !== "GATEWAY") return null
      return getRegistration(input)
    },
    async listGatewayRuntimes(input) {
      return [...registrations.values()]
        .filter((value) => value.tenant_id === input.tenantId &&
          (input.targetId === undefined || value.target_id === input.targetId))
        .sort((left, right) => left.runtime_id.localeCompare(right.runtime_id))
        .map(clone)
    },
    async claimGatewaySessionLease(input) {
      requireIdentifier(input.tenantId, "TENANT_REQUIRED")
      requireIdentifier(input.runtimeId, "RUNTIME_ID_REQUIRED")
      requireIdentifier(input.ownerId, "RUNTIME_SESSION_OWNER_REQUIRED")
      requireIdentifier(input.leaseId, "RUNTIME_SESSION_LEASE_ID_REQUIRED")
      assertTtl(input.ttlSeconds)
      const key = valueKey(input.tenantId, input.runtimeId)
      const registration = registrations.get(key)
      if (!registration || registration.status !== "ACTIVE") {
        throw new PlatformApiError("RUNTIME_RUNTIME_NOT_ACTIVE", 403)
      }
      const timestamp = now()
      const current = leases.get(key)
      if (current && current.expires_at > timestamp &&
        (current.owner_id !== input.ownerId || current.lease_id !== input.leaseId)) {
        throw new PlatformApiError("RUNTIME_SESSION_LEASE_HELD", 409)
      }
      const lease: RuntimeSessionLease = {
        tenant_id: input.tenantId,
        runtime_kind: "GATEWAY",
        runtime_id: input.runtimeId,
        lease_id: input.leaseId,
        owner_id: input.ownerId,
        claimed_at: current && current.owner_id === input.ownerId && current.lease_id === input.leaseId
          ? current.claimed_at
          : timestamp,
        renewed_at: timestamp,
        expires_at: timestamp + input.ttlSeconds,
      }
      leases.set(key, lease)
      return clone(lease)
    },
    async renewGatewaySessionLease(input) {
      assertTtl(input.ttlSeconds)
      const key = valueKey(input.tenantId, input.runtimeId)
      const registration = registrations.get(key)
      if (!registration || registration.status !== "ACTIVE") {
        throw new PlatformApiError("RUNTIME_RUNTIME_NOT_ACTIVE", 403)
      }
      const current = leases.get(key)
      if (!current) throw new PlatformApiError("RUNTIME_SESSION_LEASE_NOT_FOUND", 404)
      const timestamp = now()
      if (current.expires_at <= timestamp) {
        leases.delete(key)
        throw new PlatformApiError("RUNTIME_SESSION_LEASE_EXPIRED", 409)
      }
      if (current.owner_id !== input.ownerId || current.lease_id !== input.leaseId) {
        throw new PlatformApiError("RUNTIME_SESSION_LEASE_OWNER_MISMATCH", 409)
      }
      const lease = {
        ...current,
        renewed_at: timestamp,
        expires_at: timestamp + input.ttlSeconds,
      }
      leases.set(key, lease)
      return clone(lease)
    },
    async releaseGatewaySessionLease(input) {
      const key = valueKey(input.tenantId, input.runtimeId)
      const current = leases.get(key)
      if (!current) return
      if (current.owner_id !== input.ownerId || current.lease_id !== input.leaseId) {
        throw new PlatformApiError("RUNTIME_SESSION_LEASE_OWNER_MISMATCH", 409)
      }
      leases.delete(key)
    },
    async getGatewaySessionLease(input) {
      const lease = leases.get(valueKey(input.tenantId, input.runtimeId))
      if (!lease || lease.expires_at <= now()) return null
      return clone(lease)
    },
  }
}
