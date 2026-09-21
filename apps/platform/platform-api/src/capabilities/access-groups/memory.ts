import { PlatformApiError } from "../errors"
import type { AccessGroupAuditEvent, AccessGroupAuditWriter } from "./audit"
import type { AccessGroup } from "./contract"
import type { AccessGroupRepository } from "./module"
import { createKeyedSerialExecutor } from "../../persistence/keyed-serial-executor"

export function createInMemoryAccessGroupRepository(options: { audit: AccessGroupAuditWriter }): AccessGroupRepository {
  const revisions = new Map<string, AccessGroup[]>()
  const mutations = createKeyedSerialExecutor()
  const key = (tenantId: string, accessGroupId: string) => JSON.stringify([tenantId, accessGroupId])
  const latest = () => [...revisions.values()].map((values) => values.at(-1)!).filter((value): value is AccessGroup => Boolean(value))
  return {
    async list(tenantId) {
      return structuredClone(latest()
        .filter((group) => group.tenant_id === tenantId)
        .sort((left, right) => left.display_name.localeCompare(right.display_name) || left.access_group_id.localeCompare(right.access_group_id)))
    },
    async forSubject(tenantId, subjectId) {
      return structuredClone(latest().filter((group) =>
        group.tenant_id === tenantId && group.membership_sources.some((source) => source.subject_ids.includes(subjectId))))
    },
    async get(tenantId, accessGroupId) {
      return structuredClone(revisions.get(key(tenantId, accessGroupId))?.at(-1) ?? null)
    },
    async save(value, expectedRevision, audit: AccessGroupAuditEvent) {
      const id = key(value.tenant_id, value.access_group_id)
      return mutations.run(id, async () => {
        const values = revisions.get(id) ?? []
        if ((values.at(-1)?.revision ?? 0) !== expectedRevision) {
          throw new PlatformApiError("ACCESS_GROUP_REVISION_CONFLICT", 409)
        }
        await options.audit.record({ tenantId: value.tenant_id, event: audit })
        values.push(structuredClone(value))
        revisions.set(id, values)
        return structuredClone(value)
      })
    },
    async history(tenantId, accessGroupId) {
      return structuredClone(revisions.get(key(tenantId, accessGroupId)) ?? [])
    },
  }
}
