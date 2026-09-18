import { validateCredentialMaterial } from "./material"
import { createHash, randomUUID } from "node:crypto"

import { PlatformApiError } from "../errors"
import type {
  ProviderCredentialProfileRevision,
  ProviderCredentialStrategy,
} from "./contract"
import type { ProviderCredentialProfileStore } from "./module"

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function required(value: string, code: string): string {
  const normalized = value.trim()
  if (!normalized) throw new PlatformApiError(code, 422)
  return normalized
}

export function providerCredentialStrategyDigest(strategy: ProviderCredentialStrategy): string {
  return createHash("sha256").update(canonical(strategy)).digest("hex")
}

function normalizeIssuer(value: string): string {
  let issuer: URL
  try {
    issuer = new URL(value)
  } catch {
    throw new PlatformApiError("PROVIDER_CREDENTIAL_ISSUER_INVALID", 422)
  }
  if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search || issuer.hash) {
    throw new PlatformApiError("PROVIDER_CREDENTIAL_ISSUER_INVALID", 422)
  }
  return issuer.toString().replace(/\/$/, "")
}

export function canonicalProviderCredentialStrategy(input: {
  strategy: ProviderCredentialStrategy
}): ProviderCredentialStrategy {
  if (input.strategy.kind === "STATIC_SECRET_REFERENCE") {
    return {
      kind: "STATIC_SECRET_REFERENCE",
      secret_ref: required(input.strategy.secret_ref, "PROVIDER_CREDENTIAL_SECRET_REFERENCE_REQUIRED"),
    }
  }
  if (input.strategy.kind === "RUNTIME_IDENTITY") {
    return {
      kind: "RUNTIME_IDENTITY",
      adapter: "GCP_APPLICATION_DEFAULT",
      parameters: {
        project_name: required(input.strategy.parameters.project_name, "PROVIDER_CREDENTIAL_PROJECT_REQUIRED"),
        region: required(input.strategy.parameters.region, "PROVIDER_CREDENTIAL_REGION_REQUIRED"),
      },
    }
  }
  return {
    kind: "OIDC_FEDERATION",
    source: {
      issuer: normalizeIssuer(input.strategy.source.issuer),
      client_id: required(input.strategy.source.client_id, "PROVIDER_CREDENTIAL_CLIENT_REQUIRED"),
      client_secret_ref: required(input.strategy.source.client_secret_ref, "PROVIDER_CREDENTIAL_SECRET_REFERENCE_REQUIRED"),
      ...(input.strategy.source.audience
        ? { audience: required(input.strategy.source.audience, "PROVIDER_CREDENTIAL_AUDIENCE_INVALID") }
        : {}),
    },
    exchange: {
      adapter: "GCP_STS",
      project_name: required(input.strategy.exchange.project_name, "PROVIDER_CREDENTIAL_PROJECT_REQUIRED"),
      region: required(input.strategy.exchange.region, "PROVIDER_CREDENTIAL_REGION_REQUIRED"),
      project_id: required(input.strategy.exchange.project_id, "PROVIDER_CREDENTIAL_PROJECT_ID_REQUIRED"),
      workload_identity_pool_name: required(input.strategy.exchange.workload_identity_pool_name, "PROVIDER_CREDENTIAL_POOL_REQUIRED"),
      workload_identity_provider_name: required(input.strategy.exchange.workload_identity_provider_name, "PROVIDER_CREDENTIAL_PROVIDER_REQUIRED"),
      ...(input.strategy.exchange.service_account_name
        ? { service_account_name: required(input.strategy.exchange.service_account_name, "PROVIDER_CREDENTIAL_SERVICE_ACCOUNT_INVALID") }
        : {}),
    },
  }
}

export function providerCredentialAdapterFamily(
  strategy: ProviderCredentialStrategy,
): ProviderCredentialProfileRevision["adapter_family"] {
  return strategy.kind === "STATIC_SECRET_REFERENCE" ? "GENERIC" : "GCP"
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

export function createInMemoryProviderCredentialProfileStore(options: {
  now?: () => number
  idFactory?: () => string
} = {}): ProviderCredentialProfileStore {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const idFactory = options.idFactory ?? (() => `provider-credential-profile-${randomUUID()}`)
  const materials = new Map<string, string>()
  const revisions = new Map<string, ProviderCredentialProfileRevision[]>()
  const key = (tenantId: string, profileId: string) => `${tenantId}\u0000${profileId}`

  function latest(tenantId: string, profileId: string): ProviderCredentialProfileRevision | null {
    return revisions.get(key(tenantId, profileId))?.at(-1) ?? null
  }

  function record(input: {
    tenantId: string
    profileId: string
    revision: number
    ownerOrganizationId: string
    displayName: string
    strategy: ProviderCredentialStrategy
    state: ProviderCredentialProfileRevision["state"]
    createdBySubjectId: string
    material?: string
  }): ProviderCredentialProfileRevision {
    const strategy = canonicalProviderCredentialStrategy({
      strategy: input.strategy,
    })
    const material = input.material ? validateCredentialMaterial(input.material, strategy) : undefined
    const value: ProviderCredentialProfileRevision = {
      ...(material ? { credential_configured: true } : {}),
      tenant_id: input.tenantId,
      profile_id: input.profileId,
      revision: input.revision,
      owner_organization_id: input.ownerOrganizationId,
      display_name: input.displayName.trim(),
      adapter_family: providerCredentialAdapterFamily(strategy),
      strategy,
      strategy_digest: providerCredentialStrategyDigest(strategy),
      state: input.state,
      created_by_subject_id: input.createdBySubjectId,
      created_at: now(),
    }
    const values = revisions.get(key(input.tenantId, input.profileId)) ?? []
    if (material) materials.set(`${key(input.tenantId, input.profileId)}:${input.revision}`, material)
    values.push(value)
    revisions.set(key(input.tenantId, input.profileId), values)
    return clone(value)
  }

  return {
    async readMaterial(input) {
      if (latest(input.tenantId, input.profileId)?.state !== "ACTIVE") return null
      return materials.get(`${key(input.tenantId, input.profileId)}:${input.revision}`) ?? null
    },
    async listLatest(input) {
      return [...revisions.entries()]
        .filter(([storedKey]) => storedKey.startsWith(`${input.tenantId}\u0000`))
        .flatMap(([, values]) => values.at(-1) ?? [])
        .sort((left, right) => left.display_name.localeCompare(right.display_name) || left.profile_id.localeCompare(right.profile_id))
        .map(clone)
    },
    async getLatest(input) {
      return clone(latest(input.tenantId, input.profileId))
    },
    async getRevision(input) {
      return clone(revisions.get(key(input.tenantId, input.profileId))
        ?.find((value) => value.revision === input.revision) ?? null)
    },
    async create(input) {
      const profileId = input.value.profile_id?.trim() || idFactory()
      if (latest(input.tenantId, profileId)) {
        throw new PlatformApiError("PROVIDER_CREDENTIAL_PROFILE_EXISTS", 409)
      }
      return record({
        tenantId: input.tenantId,
        profileId,
        revision: 1,
        material: input.value.credential_material,
        ownerOrganizationId: input.value.owner_organization_id,
        displayName: input.value.display_name,
        strategy: input.value.strategy,
        state: "ACTIVE",
        createdBySubjectId: input.createdBySubjectId,
      })
    },
    async revise(input) {
      const current = latest(input.tenantId, input.profileId)
      if (!current) throw new PlatformApiError("PROVIDER_CREDENTIAL_PROFILE_NOT_FOUND", 404)
      if (current.state === "REVOKED") {
        throw new PlatformApiError("PROVIDER_CREDENTIAL_PROFILE_REVOKED", 409)
      }
      if (current.revision !== input.value.expected_revision) {
        throw new PlatformApiError("PROVIDER_CREDENTIAL_PROFILE_REVISION_CONFLICT", 409)
      }
      return record({
        tenantId: input.tenantId,
        profileId: input.profileId,
        revision: current.revision + 1,
        material: input.value.credential_material ?? materials.get(`${key(input.tenantId, input.profileId)}:${current.revision}`),
        ownerOrganizationId: current.owner_organization_id,
        displayName: input.value.display_name,
        strategy: input.value.strategy,
        state: input.value.state,
        createdBySubjectId: input.createdBySubjectId,
      })
    },
  }
}
