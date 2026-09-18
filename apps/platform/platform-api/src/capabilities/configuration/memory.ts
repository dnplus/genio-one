import { PlatformApiError } from "../errors"
import type { TenantConfigurationRevision } from "./contract"
import { assertTenantConfiguration, transitionConfiguration } from "./lifecycle"
import type { TenantConfigurationStore } from "./module"

export function createInMemoryTenantConfigurationStore(options: {
  now?: () => number
  idFactory?: () => string
} = {}): TenantConfigurationStore {
  const values = new Map<string, TenantConfigurationRevision>()
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000))
  const idFactory = options.idFactory ?? (() => crypto.randomUUID())
  const key = (tenantId: string, revision: string) => `${tenantId}:${revision}`
  const get = (tenantId: string, revision: string) => {
    const value = values.get(key(tenantId, revision))
    if (!value) throw new PlatformApiError("CONFIGURATION_REVISION_NOT_FOUND", 404)
    return value
  }
  return {
    async list({ tenantId }) {
      return [...values.values()]
        .filter((value) => value.tenant_id === tenantId)
        .sort((left, right) => left.created_at - right.created_at || left.revision.localeCompare(right.revision))
        .map((value) => structuredClone(value))
    },
    async published({ tenantId }) {
      const published = [...values.values()]
        .filter((value) => value.tenant_id === tenantId && value.state === "PUBLISHED")
        .sort((left, right) => right.created_at - left.created_at || right.revision.localeCompare(left.revision))[0]
      return published ? structuredClone(published) : null
    },
    async create({ tenantId, createdBySubjectId, value }) {
      assertTenantConfiguration(value.settings)
      const revision = `config-revision-${idFactory()}`
      const at = now()
      const record: TenantConfigurationRevision = {
        tenant_id: tenantId,
        revision,
        state: "DRAFT",
        settings: structuredClone(value.settings),
        created_by: { subject_id: createdBySubjectId, evidence_level: "VERIFIED" },
        created_at: at,
        validated_at: null,
        previewed_at: null,
        reviewed_at: null,
        published_at: null,
        projection: {
          desired_revision: revision,
          observed_revision: null,
          status: "PENDING",
          drift: true,
          last_error: null,
          retry_count: 0,
          last_reconciled_at: null,
        },
        rolled_back_from: null,
      }
      values.set(key(tenantId, revision), record)
      return structuredClone(record)
    },
    async transition({ tenantId, revision, transition, value }) {
      const next = transitionConfiguration(
        get(tenantId, revision), transition, now(), value.projection_failure_reason,
      )
      values.set(key(tenantId, revision), next)
      return structuredClone(next)
    },
    async retry({ tenantId, revision }) {
      const current = get(tenantId, revision)
      if (current.state !== "PUBLISHED" || current.projection.status !== "FAILED") {
        throw new PlatformApiError("CONFIGURATION_PROJECTION_RETRY_INVALID", 409)
      }
      const next = structuredClone(current)
      next.projection = {
        ...next.projection,
        status: "PENDING",
        observed_revision: null,
        drift: true,
        last_error: null,
        retry_count: next.projection.retry_count + 1,
        last_reconciled_at: null,
      }
      values.set(key(tenantId, revision), next)
      return structuredClone(next)
    },
    async observe({ tenantId, revision, value }) {
      const current = get(tenantId, revision)
      if (current.state !== "PUBLISHED") throw new PlatformApiError("CONFIGURATION_OBSERVATION_INVALID", 409)
      const next = structuredClone(current)
      const reason = value.failure_reason?.trim()
      if (value.observed_revision === revision && !reason) {
        next.projection.observed_revision = revision
        next.projection.status = "CONVERGED"
        next.projection.drift = false
        next.projection.last_error = null
      } else if ((value.observed_revision === null || value.observed_revision === undefined) && reason) {
        next.projection.observed_revision = null
        next.projection.status = "FAILED"
        next.projection.drift = true
        next.projection.last_error = reason
      } else {
        throw new PlatformApiError("CONFIGURATION_OBSERVATION_INVALID", 409)
      }
      next.projection.last_reconciled_at = now()
      values.set(key(tenantId, revision), next)
      return structuredClone(next)
    },
    async rollback({ tenantId, createdBySubjectId, value }) {
      const failed = get(tenantId, value.failed_revision)
      const target = get(tenantId, value.target_revision)
      if (
        failed.state !== "PUBLISHED" || target.state !== "PUBLISHED" ||
        target.projection.status !== "CONVERGED"
      ) throw new PlatformApiError("CONFIGURATION_ROLLBACK_INVALID", 409)
      const revision = `config-revision-${idFactory()}`
      const at = now()
      const record: TenantConfigurationRevision = {
        ...structuredClone(target),
        revision,
        created_by: { subject_id: createdBySubjectId, evidence_level: "VERIFIED" },
        created_at: at,
        validated_at: at,
        previewed_at: at,
        reviewed_at: at,
        published_at: at,
        projection: {
          desired_revision: revision,
          observed_revision: revision,
          status: "ROLLED_BACK",
          drift: false,
          last_error: null,
          retry_count: 0,
          last_reconciled_at: at,
        },
        rolled_back_from: value.failed_revision,
      }
      values.set(key(tenantId, revision), record)
      return structuredClone(record)
    },
  }
}
