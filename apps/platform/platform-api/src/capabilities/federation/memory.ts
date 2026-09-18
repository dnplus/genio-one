import { PlatformApiError } from "../errors"
import type { FederationService } from "./module"

export function createInMemoryFederationService(options: {
  now?: () => number
  idFactory?: () => string
  applicationSubject(input: { tenantId: string; applicationId: string }): Promise<string | null>
}): FederationService {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const idFactory = options.idFactory ?? (() => crypto.randomUUID())
  const trusts = new Map<string, Awaited<ReturnType<FederationService["createTrustRevision"]>>>()
  return {
    async listTrusts({ tenantId, applicationId }) {
      return [...trusts.values()]
        .filter((trust) => trust.tenant_id === tenantId && trust.application_id === applicationId)
        .sort((left, right) => left.display_name.localeCompare(right.display_name))
    },
    async createTrustRevision({ tenantId, applicationId, createdBySubjectId, value }) {
      const trustId = value.trust_id ?? `federation-trust-${idFactory()}`
      const key = `${tenantId}:${trustId}`
      const current = trusts.get(key)
      if (current && current.application_id !== applicationId) {
        throw new PlatformApiError("FEDERATION_TRUST_APPLICATION_CONFLICT", 409)
      }
      const applicationSubjectId = await options.applicationSubject({ tenantId, applicationId })
      if (!applicationSubjectId) throw new PlatformApiError("APPLICATION_NOT_FOUND", 404)
      const created = {
        tenant_id: tenantId,
        trust_id: trustId,
        revision: (current?.revision ?? 0) + 1,
        application_id: applicationId,
        application_subject_id: current?.application_subject_id ?? applicationSubjectId,
        display_name: value.display_name.trim(),
        issuer: value.issuer,
        jwks_uri: value.jwks_uri,
        audiences: [...value.audiences].sort(),
        algorithms: [...value.algorithms].sort(),
        external_subject_id: value.external_subject_id,
        required_claims: [...value.required_claims].sort((left, right) => left.name.localeCompare(right.name)),
        max_assertion_ttl_seconds: value.max_assertion_ttl_seconds,
        state: "ACTIVE" as const,
        created_by_subject_id: createdBySubjectId,
        created_at: now(),
      }
      trusts.set(key, created)
      return created
    },
    async exchange() {
      throw new PlatformApiError("FEDERATION_EXCHANGE_UNAVAILABLE", 503)
    },
    async listExchangeEvents() {
      return []
    },
  }
}
