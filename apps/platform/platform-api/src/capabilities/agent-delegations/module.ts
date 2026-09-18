import { randomUUID } from "node:crypto"

import { PlatformApiError } from "../errors"
import type { ModelEntitlement } from "../entitlements/contract"
import type { IdentityDirectory } from "../identity/module"
import type { ModelEntitlementCatalog } from "../entitlements/module"
import type { AgentDelegation, CreateAgentDelegationInput } from "./contract"

export interface AgentDelegationRepository {
  create(value: AgentDelegation): Promise<AgentDelegation>
  latest(input: { tenantId: string; delegationId: string }): Promise<AgentDelegation | null>
  listLatest(input: { tenantId: string }): Promise<AgentDelegation[]>
  appendRevoked(input: { current: AgentDelegation; actorSubjectId: string; createdAt: number }): Promise<AgentDelegation>
}

export interface AgentDelegationDirectory {
  create(input: { tenantId: string; actor: { subjectId: string; tenantAdministrator: boolean }; value: CreateAgentDelegationInput }): Promise<AgentDelegation>
  revoke(input: { tenantId: string; delegationId: string; expectedRevision: number; actor: { subjectId: string; tenantAdministrator: boolean } }): Promise<AgentDelegation>
  list(input: { tenantId: string }): Promise<AgentDelegation[]>
}

function activeEntitlement(
  values: readonly ModelEntitlement[],
  subjectId: string,
  resourceId: string,
  capabilityId: string,
  startsAt: number,
  expiresAt: number,
): boolean {
  return values.some((value) =>
    value.subject_id === subjectId &&
    value.resource_id === resourceId &&
    value.capability_id === capabilityId &&
    value.state === "ACTIVE" &&
    value.starts_at <= startsAt &&
    (value.expires_at === null || value.expires_at >= expiresAt)
  )
}

export function createAgentDelegationDirectory(options: {
  repository: AgentDelegationRepository
  identity: IdentityDirectory
  entitlements: ModelEntitlementCatalog
  now?: () => number
  idFactory?: () => string
}): AgentDelegationDirectory {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const idFactory = options.idFactory ?? (() => `agent-delegation-${randomUUID()}`)
  return {
    async create(input) {
      if (!input.actor.tenantAdministrator && input.actor.subjectId !== input.value.principal_subject_id) {
        throw new PlatformApiError("AGENT_DELEGATION_ACTOR_DENIED", 403)
      }
      if (input.value.principal_subject_id === input.value.agent_subject_id) {
        throw new PlatformApiError("AGENT_DELEGATION_SUBJECTS_INVALID", 422)
      }
      if (
        new Set(input.value.capability_ids).size !== input.value.capability_ids.length ||
        new Set(input.value.acting_client_ids).size !== input.value.acting_client_ids.length
      ) {
        throw new PlatformApiError("AGENT_DELEGATION_BOUNDS_INVALID", 422)
      }
      const startsAt = input.value.starts_at ?? now()
      if (input.value.expires_at <= startsAt) {
        throw new PlatformApiError("AGENT_DELEGATION_WINDOW_INVALID", 422)
      }
      const inventory = await options.identity.inventory({ tenantId: input.tenantId })
      const principal = inventory.subjects.find((value) => value.subject_id === input.value.principal_subject_id)
      const agent = inventory.subjects.find((value) => value.subject_id === input.value.agent_subject_id)
      if (!principal || agent?.kind !== "AGENT") {
        throw new PlatformApiError("AGENT_DELEGATION_SUBJECTS_INVALID", 422)
      }
      const entitlements = await options.entitlements.list({ tenantId: input.tenantId })
      for (const capabilityId of input.value.capability_ids) {
        if (!activeEntitlement(entitlements, principal.subject_id, input.value.resource_id, capabilityId, startsAt, input.value.expires_at) ||
            !activeEntitlement(entitlements, agent.subject_id, input.value.resource_id, capabilityId, startsAt, input.value.expires_at)) {
          throw new PlatformApiError("AGENT_DELEGATION_AUTHORITY_EXCEEDS_ENTITLEMENT", 409)
        }
      }
      return options.repository.create({
        tenant_id: input.tenantId,
        delegation_id: input.value.delegation_id ?? idFactory(),
        revision: 1,
        principal_subject_id: principal.subject_id,
        agent_subject_id: agent.subject_id,
        resource_id: input.value.resource_id,
        capability_ids: [...input.value.capability_ids].sort(),
        acting_client_ids: [...input.value.acting_client_ids].sort(),
        starts_at: startsAt,
        expires_at: input.value.expires_at,
        revocation_generation: 0,
        state: "ACTIVE",
        created_by_subject_id: input.actor.subjectId,
        created_at: now(),
      })
    },
    async revoke(input) {
      const current = await options.repository.latest(input)
      if (!current) throw new PlatformApiError("AGENT_DELEGATION_NOT_FOUND", 404)
      if (current.revision !== input.expectedRevision) throw new PlatformApiError("AGENT_DELEGATION_REVISION_CONFLICT", 409)
      if (current.state === "REVOKED") return current
      if (!input.actor.tenantAdministrator && input.actor.subjectId !== current.principal_subject_id) {
        throw new PlatformApiError("AGENT_DELEGATION_ACTOR_DENIED", 403)
      }
      return options.repository.appendRevoked({ current, actorSubjectId: input.actor.subjectId, createdAt: now() })
    },
    list(input) {
      return options.repository.listLatest(input)
    },
  }
}
