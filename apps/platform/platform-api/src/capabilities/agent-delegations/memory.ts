import { PlatformApiError } from "../errors"
import type { AgentDelegationRepository } from "./module"

export function createInMemoryAgentDelegationRepository(): AgentDelegationRepository {
  const values = new Map<string, import("./contract").AgentDelegation[]>()
  const key = (tenantId: string, delegationId: string) => `${tenantId}\u0000${delegationId}`
  return {
    async create(value) {
      const id = key(value.tenant_id, value.delegation_id)
      if (values.has(id)) throw new PlatformApiError("AGENT_DELEGATION_EXISTS", 409)
      values.set(id, [structuredClone(value)])
      return structuredClone(value)
    },
    async latest(input) {
      const value = values.get(key(input.tenantId, input.delegationId))?.at(-1)
      return value ? structuredClone(value) : null
    },
    async listLatest(input) {
      return [...values.entries()]
        .filter(([id]) => id.startsWith(`${input.tenantId}\u0000`))
        .flatMap(([, revisions]) => revisions.at(-1) ?? [])
        .sort((left, right) => left.delegation_id.localeCompare(right.delegation_id))
        .map((value) => structuredClone(value))
    },
    async appendRevoked(input) {
      const id = key(input.current.tenant_id, input.current.delegation_id)
      const revisions = values.get(id)
      if (!revisions || revisions.at(-1)?.revision !== input.current.revision) {
        throw new PlatformApiError("AGENT_DELEGATION_REVISION_CONFLICT", 409)
      }
      const value = {
        ...structuredClone(input.current),
        revision: input.current.revision + 1,
        revocation_generation: input.current.revocation_generation + 1,
        state: "REVOKED" as const,
        created_by_subject_id: input.actorSubjectId,
        created_at: input.createdAt,
      }
      revisions.push(value)
      return structuredClone(value)
    },
  }
}
