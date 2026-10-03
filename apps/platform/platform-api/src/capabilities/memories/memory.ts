import { createHash, randomUUID } from "node:crypto"

import { createKeyedSerialExecutor } from "../../persistence/keyed-serial-executor"
import { PlatformApiError } from "../errors"
import type { DistillationStore } from "../distillation/module"
import type { OrganizationDirectory } from "../organizations/module"
import type { Principal } from "../tenancy-auth/contract"
import type {
  MemoryScope,
  PersonalMemoryAgentGrant,
  SharedMemory,
  SharedMemoryCorrectionProposal,
  SharedMemoryDeletion,
  SharedMemoryMutationMetadata,
} from "./contract"
import {
  normalizeSharedMemoryTarget,
  sharedMemoryTargetKey,
  type ActivePersonalMemoryAgentRepository,
  type AuthorizedSharedMemoryRepository,
  type AuthorizedSharedMemoryScope,
  type SharedMemoryDeleteInput,
  type SharedMemoryListInput,
  type SharedMemoryRepository,
  type SharedMemoryScopeAuthorizationInput,
  type SharedMemoryScopeTarget,
  type SharedMemoryWriteInput,
} from "./module"
import type { SharedMemoryScopeResolver } from "./shared-scope-access"

interface MutationRecord {
  metadata: SharedMemoryMutationMetadata
  requestDigest: string
  deletion: SharedMemoryDeletion | null
}

interface CorrectionProposalRecord {
  proposal: SharedMemoryCorrectionProposal
  requestDigest: string
}

export interface InMemorySharedMemoryScopeAuthorizer {
  authorize(input: SharedMemoryScopeAuthorizationInput): Promise<AuthorizedSharedMemoryScope>
  listMemoryScopes(input: { actor: Principal }): Promise<MemoryScope[]>
}

function scopeAccessDenied(error: unknown): boolean {
  return error instanceof PlatformApiError && (
    error.code === "SHARED_MEMORY_SCOPE_ACCESS_REQUIRED" ||
    error.code === "SHARED_MEMORY_SCOPE_NOT_FOUND"
  )
}

export function createInMemorySharedMemoryScopeAuthorizer(options: {
  resolver: SharedMemoryScopeResolver
  organizations: Pick<OrganizationDirectory, "list">
  workspaces: Pick<DistillationStore, "listWorkspaces">
}): InMemorySharedMemoryScopeAuthorizer {
  async function authorize(input: SharedMemoryScopeAuthorizationInput): Promise<AuthorizedSharedMemoryScope> {
    const target = await options.resolver.resolve(input.actor, input.selector, input.permission)
    let canManage = input.permission === "MANAGE"
    if (!canManage) {
      try {
        await options.resolver.resolve(input.actor, input.selector, "MANAGE")
        canManage = true
      } catch (error) {
        if (!scopeAccessDenied(error)) throw error
      }
    }
    return { target, canManage }
  }

  async function permitted(actor: Principal, selector: SharedMemoryScopeAuthorizationInput["selector"], permission: SharedMemoryScopeAuthorizationInput["permission"]): Promise<boolean> {
    try {
      await options.resolver.resolve(actor, selector, permission)
      return true
    } catch (error) {
      if (scopeAccessDenied(error)) return false
      throw error
    }
  }

  return {
    authorize,
    async listMemoryScopes(input) {
      const [organizations, workspaces] = await Promise.all([
        options.organizations.list({ tenantId: input.actor.tenant_id }),
        options.workspaces.listWorkspaces(input.actor.tenant_id),
      ])
      const scopes: MemoryScope[] = []
      for (const organization of organizations) {
        const selector = { scope: "ORGANIZATION" as const, organization_id: organization.organization_id }
        let access: AuthorizedSharedMemoryScope
        try {
          access = await authorize({ actor: input.actor, selector, permission: "READ" })
        } catch (error) {
          if (scopeAccessDenied(error)) continue
          throw error
        }
        scopes.push({
          target: selector,
          display_name: organization.display_name,
          can_read: true,
          can_contribute: await permitted(input.actor, selector, "CONTRIBUTE"),
          can_manage: access.canManage,
        })
      }
      for (const workspace of workspaces) {
        const selector = { scope: "TEAM" as const, workspace_id: workspace.workspace_id }
        let access: AuthorizedSharedMemoryScope
        try {
          access = await authorize({ actor: input.actor, selector, permission: "READ" })
        } catch (error) {
          if (scopeAccessDenied(error)) continue
          throw error
        }
        scopes.push({
          target: selector,
          display_name: workspace.display_name,
          can_read: true,
          can_contribute: await permitted(input.actor, selector, "CONTRIBUTE"),
          can_manage: access.canManage,
        })
      }
      return scopes
    },
  }
}

function recordKey(tenantId: string, memoryId: string): string {
  return `${tenantId}\u0000${memoryId}`
}

function targetRecordKey(tenantId: string, target: SharedMemoryScopeTarget): string {
  return `${tenantId}\u0000${sharedMemoryTargetKey(target)}`
}

function agentRecordKey(tenantId: string, ownerSubjectId: string, agentId: string): string {
  return `${tenantId}\u0000${ownerSubjectId}\u0000${agentId}`
}

function identityKey(input: {
  target: SharedMemoryScopeTarget
  key: string
  kind: SharedMemory["kind"]
  context: SharedMemory["context"]
}): string {
  return JSON.stringify([
    sharedMemoryTargetKey(input.target),
    input.key,
    input.kind,
    input.context.kind,
    input.context.context_id,
  ])
}

function mutationKey(input: {
  tenantId: string
  target: SharedMemoryScopeTarget
  idempotencyKeyDigest: string
}): string {
  return `${targetRecordKey(input.tenantId, input.target)}\u0000${input.idempotencyKeyDigest}`
}

function proposalRecordKey(tenantId: string, proposalId: string): string {
  return `${tenantId}\u0000${proposalId}`
}

function proposalIdempotencyKey(input: {
  tenantId: string
  target: SharedMemoryScopeTarget
  idempotencyKeyDigest: string
}): string {
  return `${targetRecordKey(input.tenantId, input.target)}\u0000${input.idempotencyKeyDigest}`
}

function targetMatches(memory: SharedMemory, target: SharedMemoryScopeTarget): boolean {
  return memory.scope === target.scope &&
    memory.owner_subject_id === target.ownerSubjectId &&
    memory.team_id === target.teamId &&
    memory.organization_id === target.organizationId
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

export function createInMemorySharedMemoryRepository(options: {
  now?: () => number
  idFactory?: (prefix: string) => string
  sharedScopeAuthorizer?: InMemorySharedMemoryScopeAuthorizer
} = {}): SharedMemoryRepository {
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000))
  const idFactory = options.idFactory ?? ((prefix: string) => `${prefix}-${randomUUID()}`)
  const memories = new Map<string, SharedMemory>()
  const byIdentity = new Map<string, string>()
  const mutations = new Map<string, MutationRecord>()
  const proposals = new Map<string, CorrectionProposalRecord>()
  const proposalIdempotency = new Map<string, string>()
  const grantsByAgent = new Map<string, PersonalMemoryAgentGrant>()
  const serial = createKeyedSerialExecutor()
  const sharedScopeAuthorizer = options.sharedScopeAuthorizer ?? {
    async authorize(): Promise<AuthorizedSharedMemoryScope> {
      throw new PlatformApiError("SHARED_MEMORY_SCOPE_ACCESS_REQUIRED", 403)
    },
    async listMemoryScopes(): Promise<MemoryScope[]> {
      return []
    },
  }

  function saveGrant(value: PersonalMemoryAgentGrant): PersonalMemoryAgentGrant {
    const agentKey = agentRecordKey(value.tenant_id, value.owner_subject_id, value.agent_id)
    const saved = clone(value)
    grantsByAgent.set(agentKey, saved)
    return clone(saved)
  }

  function existingMutation(input: {
    tenantId: string
    target: SharedMemoryScopeTarget
    idempotencyKeyDigest: string
    requestDigest: string
  }): SharedMemory | SharedMemoryDeletion | null {
    const mutation = mutations.get(mutationKey(input))
    if (!mutation) return null
    if (mutation.requestDigest !== input.requestDigest) {
      throw new PlatformApiError("MEMORY_IDEMPOTENCY_KEY_REUSED", 409)
    }
    if (mutation.deletion) return clone(mutation.deletion)
    const memory = memories.get(recordKey(input.tenantId, mutation.metadata.memory_id))
    if (!memory) throw new PlatformApiError("MEMORY_IDEMPOTENCY_TARGET_DELETED", 409)
    if (memory.revision !== mutation.metadata.revision) {
      throw new PlatformApiError("MEMORY_IDEMPOTENCY_STATE_SUPERSEDED", 409)
    }
    return clone(memory)
  }

  function appendMutation(input: {
    tenantId: string
    target: SharedMemoryScopeTarget
    memoryId: string
    idempotencyKeyDigest: string
    requestDigest: string
    actorSubjectId: string
    clientId: string
    agentId: string | null
    agentGrantId: string | null
    operation: SharedMemoryMutationMetadata["operation"]
    previousRevision: number
    revision: number
    assertionOrigin: SharedMemoryMutationMetadata["assertion_origin"]
    confirmation: SharedMemoryMutationMetadata["confirmation"]
    deletion?: SharedMemoryDeletion
  }): void {
    mutations.set(mutationKey(input), {
      requestDigest: input.requestDigest,
      deletion: input.deletion ? clone(input.deletion) : null,
      metadata: {
        mutation_id: idFactory("memory-mutation"),
        tenant_id: input.tenantId,
        memory_id: input.memoryId,
        scope: input.target.scope,
        owner_subject_id: input.target.ownerSubjectId,
        actor_subject_id: input.actorSubjectId,
        client_id: input.clientId,
        agent_id: input.agentId,
        agent_grant_id: input.agentGrantId,
        operation: input.operation,
        previous_revision: input.previousRevision,
        revision: input.revision,
        assertion_origin: input.assertionOrigin,
        confirmation: clone(input.confirmation),
        occurred_at: now(),
      },
    })
  }

  function proposalMatchesTarget(proposal: SharedMemoryCorrectionProposal, target: SharedMemoryScopeTarget): boolean {
    return proposal.scope === target.scope &&
      proposal.owner_subject_id === target.ownerSubjectId &&
      proposal.team_id === target.teamId &&
      proposal.organization_id === target.organizationId
  }

  function selectorMatchesTarget(
    selector: SharedMemoryScopeAuthorizationInput["selector"],
    target: SharedMemoryScopeTarget,
  ): boolean {
    if (selector.scope === "TEAM") {
      return target.scope === "TEAM" && target.teamId === selector.workspace_id
    }
    return target.scope === "ORGANIZATION" && target.organizationId === selector.organization_id
  }

  function stalePendingProposals(input: {
    tenantId: string
    target: SharedMemoryScopeTarget
    memoryId: string
    at: number
    exceptProposalId?: string
  }): void {
    for (const [key, record] of proposals) {
      const proposal = record.proposal
      if (
        proposal.tenant_id !== input.tenantId ||
        proposal.memory_id !== input.memoryId ||
        !proposalMatchesTarget(proposal, input.target) ||
        proposal.proposal_id === input.exceptProposalId ||
        proposal.status !== "PENDING"
      ) continue
      proposals.set(key, {
        ...record,
        proposal: {
          ...proposal,
          proposed_content: null,
          status: "STALE",
          resolved_at: input.at,
        },
      })
    }
  }

  function cascadeProposals(input: {
    tenantId: string
    target: SharedMemoryScopeTarget
    memoryId: string
  }): void {
    for (const [key, record] of proposals) {
      const proposal = record.proposal
      if (
        proposal.tenant_id !== input.tenantId ||
        proposal.memory_id !== input.memoryId ||
        !proposalMatchesTarget(proposal, input.target)
      ) continue
      proposals.delete(key)
      for (const [idempotencyKey, proposalKey] of proposalIdempotency) {
        if (proposalKey === key) proposalIdempotency.delete(idempotencyKey)
      }
    }
  }

  const repository: SharedMemoryRepository = {
    async enablePersonalAgent(input) {
      const key = agentRecordKey(input.tenantId, input.ownerSubjectId, input.agentId)
      return serial.run(key, async () => {
        const current = grantsByAgent.get(key)
        if (current && current.revoked_at === null) return clone(current)
        return saveGrant({
          tenant_id: input.tenantId,
          owner_subject_id: input.ownerSubjectId,
          agent_id: input.agentId,
          grant_id: idFactory("memory-agent-grant"),
          enabled_at: now(),
          revoked_at: null,
        })
      })
    },
    async getPersonalAgent(input) {
      return clone(grantsByAgent.get(agentRecordKey(input.tenantId, input.ownerSubjectId, input.agentId)) ?? null)
    },
    async listPersonalAgents(input) {
      return [...grantsByAgent.values()]
        .filter((grant) => grant.tenant_id === input.tenantId && grant.owner_subject_id === input.ownerSubjectId)
        .sort((left, right) => right.enabled_at - left.enabled_at || left.agent_id.localeCompare(right.agent_id))
        .filter((grant) => input.position === null ||
          grant.enabled_at < input.position.enabledAt ||
          (grant.enabled_at === input.position.enabledAt && grant.agent_id > input.position.agentId))
        .slice(0, input.limit)
        .map(clone)
    },
    async revokePersonalAgent(input) {
      const key = agentRecordKey(input.tenantId, input.ownerSubjectId, input.agentId)
      return serial.run(key, async () => {
        const current = grantsByAgent.get(key)
        if (!current) throw new PlatformApiError("MEMORY_AGENT_GRANT_NOT_FOUND", 404)
        if (current.revoked_at !== null) return clone(current)
        return saveGrant({ ...current, revoked_at: now() })
      })
    },
    async activePersonalAgent(input) {
      const key = agentRecordKey(input.tenantId, input.ownerSubjectId, input.agentId)
      return serial.run(key, async () => {
        const grant = grantsByAgent.get(key)
        return grant && grant.revoked_at === null ? clone(grant) : null
      })
    },
    async withActivePersonalAgent<T>(
      input: { tenantId: string; ownerSubjectId: string; agentId: string },
      operation: (grant: PersonalMemoryAgentGrant, activeRepository: ActivePersonalMemoryAgentRepository) => Promise<T>,
    ): Promise<T> {
      const key = agentRecordKey(input.tenantId, input.ownerSubjectId, input.agentId)
      return serial.run(key, async () => {
        const grant = grantsByAgent.get(key)
        if (!grant || grant.revoked_at !== null) {
          throw new PlatformApiError("MEMORY_AGENT_GRANT_INVALID", 403)
        }
        return operation(clone(grant), repository)
      })
    },
    async withAuthorizedSharedScope<T>(
      input: SharedMemoryScopeAuthorizationInput,
      operation: (
        scope: AuthorizedSharedMemoryScope,
        authorizedRepository: AuthorizedSharedMemoryRepository,
      ) => Promise<T>,
    ): Promise<T> {
      const authorization = await sharedScopeAuthorizer.authorize(input)
      const target = normalizeSharedMemoryTarget(authorization.target)
      if (
        !selectorMatchesTarget(input.selector, target) ||
        typeof authorization.canManage !== "boolean" ||
        (input.permission === "MANAGE" && !authorization.canManage)
      ) {
        throw new PlatformApiError("SHARED_MEMORY_SCOPE_ACCESS_REQUIRED", 403)
      }
      return operation({ target, canManage: authorization.canManage }, repository)
    },
    async listMemoryScopes(input) {
      return (await sharedScopeAuthorizer.listMemoryScopes(input)).map(clone)
    },
    async createCorrectionProposal(input) {
      const target = normalizeSharedMemoryTarget(input.target)
      const key = targetRecordKey(input.tenantId, target)
      return serial.run(key, async () => {
        const idempotency = proposalIdempotencyKey({
          tenantId: input.tenantId,
          target,
          idempotencyKeyDigest: input.idempotencyKeyDigest,
        })
        const priorKey = proposalIdempotency.get(idempotency)
        if (priorKey) {
          const prior = proposals.get(priorKey)
          if (!prior) throw new PlatformApiError("MEMORY_DATA_INVALID", 500)
          if (prior.requestDigest !== input.requestDigest) {
            throw new PlatformApiError("MEMORY_IDEMPOTENCY_KEY_REUSED", 409)
          }
          return clone(prior.proposal)
        }
        const current = memories.get(recordKey(input.tenantId, input.memoryId))
        if (!current || !targetMatches(current, target)) throw new PlatformApiError("MEMORY_NOT_FOUND", 404)
        if (current.revision !== input.baseRevision) throw new PlatformApiError("MEMORY_REVISION_CONFLICT", 409)
        if (current.kind !== input.proposedKind) throw new PlatformApiError("MEMORY_IDENTITY_IMMUTABLE", 409)
        const at = now()
        const proposal: SharedMemoryCorrectionProposal = {
          proposal_id: idFactory("memory-correction-proposal"),
          tenant_id: input.tenantId,
          memory_id: input.memoryId,
          scope: target.scope,
          owner_subject_id: target.ownerSubjectId,
          team_id: target.teamId,
          organization_id: target.organizationId,
          base_revision: input.baseRevision,
          proposed_kind: input.proposedKind,
          proposed_content: input.proposedContent,
          source: clone(input.source),
          status: "PENDING",
          reviewer_subject_id: null,
          created_at: at,
          resolved_at: null,
        }
        const proposalKey = proposalRecordKey(input.tenantId, proposal.proposal_id)
        proposals.set(proposalKey, { proposal, requestDigest: input.requestDigest })
        proposalIdempotency.set(idempotency, proposalKey)
        return clone(proposal)
      })
    },
    async listCorrectionProposals(input) {
      const target = normalizeSharedMemoryTarget(input.target)
      return [...proposals.values()]
        .map((record) => record.proposal)
        .filter((proposal) => (
          proposal.tenant_id === input.tenantId &&
          proposal.memory_id === input.memoryId &&
          proposalMatchesTarget(proposal, target) &&
          (input.status === null || proposal.status === input.status)
        ))
        .sort((left, right) => right.created_at - left.created_at || left.proposal_id.localeCompare(right.proposal_id))
        .filter((proposal) => input.position === null || (
          proposal.created_at < input.position.createdAt ||
          (proposal.created_at === input.position.createdAt && proposal.proposal_id > input.position.proposalId)
        ))
        .slice(0, input.limit)
        .map(clone)
    },
    async reviewCorrectionProposal(input) {
      const target = normalizeSharedMemoryTarget(input.target)
      const key = targetRecordKey(input.tenantId, target)
      return serial.run(key, async () => {
        const proposalKey = proposalRecordKey(input.tenantId, input.proposalId)
        const record = proposals.get(proposalKey)
        const proposal = record?.proposal
        if (!proposal || proposal.memory_id !== input.memoryId || !proposalMatchesTarget(proposal, target)) {
          throw new PlatformApiError("MEMORY_CORRECTION_PROPOSAL_NOT_FOUND", 404)
        }
        if (proposal.status !== "PENDING") {
          throw new PlatformApiError("MEMORY_CORRECTION_PROPOSAL_NOT_PENDING", 409)
        }
        const current = memories.get(recordKey(input.tenantId, input.memoryId))
        if (!current || !targetMatches(current, target)) throw new PlatformApiError("MEMORY_NOT_FOUND", 404)
        const at = now()
        if (current.revision !== proposal.base_revision) {
          const stale: SharedMemoryCorrectionProposal = {
            ...proposal,
            proposed_content: null,
            status: "STALE",
            resolved_at: at,
          }
          proposals.set(proposalKey, { ...record!, proposal: stale })
          stalePendingProposals({
            tenantId: input.tenantId,
            target,
            memoryId: input.memoryId,
            at,
            exceptProposalId: input.proposalId,
          })
          return { proposal: clone(stale), memory: clone(current) }
        }
        if (input.action === "REJECT") {
          const rejected: SharedMemoryCorrectionProposal = {
            ...proposal,
            proposed_content: null,
            status: "REJECTED",
            reviewer_subject_id: input.reviewerSubjectId,
            resolved_at: at,
          }
          proposals.set(proposalKey, { ...record!, proposal: rejected })
          return { proposal: clone(rejected), memory: null }
        }
        if (input.action !== "ACCEPT") {
          throw new PlatformApiError("MEMORY_CORRECTION_PROPOSAL_ACTION_INVALID", 422)
        }
        if (proposal.proposed_content === null || proposal.proposed_kind !== current.kind) {
          throw new PlatformApiError("MEMORY_DATA_INVALID", 500)
        }
        const assertionOrigin = proposal.source.agent_id === null ? "USER_EXPLICIT" : "AGENT_INFERRED"
        const confirmation = {
          reviewer_subject_id: input.reviewerSubjectId,
          reviewer_client_id: input.reviewerClientId,
          reviewed_at: at,
        }
        const updated: SharedMemory = {
          ...current,
          content: proposal.proposed_content,
          assertion_origin: assertionOrigin,
          source: clone(proposal.source),
          confirmation: {
            confirmed: true,
            reviewed_at: at,
          },
          revision: current.revision + 1,
          updated_at: at,
        }
        memories.set(recordKey(input.tenantId, updated.memory_id), updated)
        const accepted: SharedMemoryCorrectionProposal = {
          ...proposal,
          proposed_content: null,
          status: "ACCEPTED",
          reviewer_subject_id: input.reviewerSubjectId,
          resolved_at: at,
        }
        proposals.set(proposalKey, { ...record!, proposal: accepted })
        stalePendingProposals({
          tenantId: input.tenantId,
          target,
          memoryId: input.memoryId,
          at,
          exceptProposalId: input.proposalId,
        })
        appendMutation({
          tenantId: input.tenantId,
          target,
          memoryId: updated.memory_id,
          idempotencyKeyDigest: createHash("sha256").update(`${input.proposalId}\u0000idempotency`).digest("hex"),
          requestDigest: createHash("sha256").update(`${input.proposalId}\u0000request`).digest("hex"),
          actorSubjectId: proposal.source.actor_subject_id,
          clientId: proposal.source.client_id,
          agentId: proposal.source.agent_id,
          agentGrantId: proposal.source.agent_grant_id,
          operation: "REPLACED",
          previousRevision: current.revision,
          revision: updated.revision,
          assertionOrigin,
          confirmation,
        })
        return { proposal: clone(accepted), memory: clone(updated) }
      })
    },
    async remember(input: SharedMemoryWriteInput) {
      const target = normalizeSharedMemoryTarget(input.target)
      const key = targetRecordKey(input.tenantId, target)
      return serial.run(key, async () => {
        const idempotent = existingMutation({
          tenantId: input.tenantId,
          target,
          idempotencyKeyDigest: input.idempotencyKeyDigest,
          requestDigest: input.requestDigest,
        })
        if (idempotent) {
          if ("deleted_revision" in idempotent) throw new PlatformApiError("MEMORY_IDEMPOTENCY_OPERATION_MISMATCH", 409)
          return idempotent
        }
        const identity = identityKey({ target, key: input.key, kind: input.kind, context: input.context })
        if (input.memoryId !== null) {
          const current = memories.get(recordKey(input.tenantId, input.memoryId))
          if (!current || !targetMatches(current, target)) throw new PlatformApiError("MEMORY_NOT_FOUND", 404)
          if (current.revision !== input.expectedRevision) throw new PlatformApiError("MEMORY_REVISION_CONFLICT", 409)
          if (identityKey({
            target,
            key: current.key,
            kind: current.kind,
            context: current.context,
          }) !== identity) {
            throw new PlatformApiError("MEMORY_IDENTITY_IMMUTABLE", 409)
          }
          if (input.assertionOrigin === "AGENT_INFERRED") {
            if (current.content !== input.content) throw new PlatformApiError("MEMORY_AGENT_INFERENCE_CONFLICT", 409)
            return clone(current)
          }
          const updated: SharedMemory = {
            ...current,
            content: input.content,
            assertion_origin: input.assertionOrigin,
            source: clone(input.source),
            confirmation: null,
            revision: current.revision + 1,
            updated_at: now(),
          }
          memories.set(recordKey(input.tenantId, updated.memory_id), updated)
          stalePendingProposals({
            tenantId: input.tenantId,
            target,
            memoryId: updated.memory_id,
            at: updated.updated_at,
          })
          appendMutation({
            tenantId: input.tenantId,
            target,
            memoryId: updated.memory_id,
            idempotencyKeyDigest: input.idempotencyKeyDigest,
            requestDigest: input.requestDigest,
            actorSubjectId: input.source.actor_subject_id,
            clientId: input.source.client_id,
            agentId: input.source.agent_id,
            agentGrantId: input.source.agent_grant_id,
            operation: "REPLACED",
            previousRevision: current.revision,
            revision: updated.revision,
            assertionOrigin: input.assertionOrigin,
            confirmation: null,
          })
          return clone(updated)
        }
        if (input.expectedRevision !== 0) throw new PlatformApiError("MEMORY_EXPECTED_REVISION_INVALID", 422)
        if (input.assertionOrigin === "AGENT_INFERRED" && [...memories.values()].some((memory) => (
          memory.tenant_id === input.tenantId &&
          targetMatches(memory, target) &&
          memory.key === input.key &&
          (target.scope === "PERSONAL" || memory.kind === input.kind) &&
          memory.context.kind === input.context.kind &&
          memory.context.context_id === input.context.context_id
        ))) {
          throw new PlatformApiError("MEMORY_AGENT_INFERENCE_CONFLICT", 409)
        }
        const existingId = byIdentity.get(`${input.tenantId}\u0000${identity}`)
        if (existingId) {
          if (input.assertionOrigin === "AGENT_INFERRED") {
            throw new PlatformApiError("MEMORY_AGENT_INFERENCE_CONFLICT", 409)
          }
          throw new PlatformApiError("MEMORY_KEY_CONFLICT", 409)
        }
        const at = now()
        const created: SharedMemory = {
          memory_id: idFactory("memory"),
          tenant_id: input.tenantId,
          scope: target.scope,
          owner_subject_id: target.ownerSubjectId,
          team_id: target.teamId,
          organization_id: target.organizationId,
          key: input.key,
          kind: input.kind,
          context: clone(input.context),
          content: input.content,
          assertion_origin: input.assertionOrigin,
          source: clone(input.source),
          confirmation: null,
          revision: 1,
          created_at: at,
          updated_at: at,
        }
        memories.set(recordKey(input.tenantId, created.memory_id), created)
        byIdentity.set(`${input.tenantId}\u0000${identity}`, created.memory_id)
        appendMutation({
          tenantId: input.tenantId,
          target,
          memoryId: created.memory_id,
          idempotencyKeyDigest: input.idempotencyKeyDigest,
          requestDigest: input.requestDigest,
          actorSubjectId: input.source.actor_subject_id,
          clientId: input.source.client_id,
          agentId: input.source.agent_id,
          agentGrantId: input.source.agent_grant_id,
          operation: "CREATED",
          previousRevision: 0,
          revision: created.revision,
          assertionOrigin: input.assertionOrigin,
          confirmation: null,
        })
        return clone(created)
      })
    },
    async get(input) {
      const target = normalizeSharedMemoryTarget(input.target)
      const memory = memories.get(recordKey(input.tenantId, input.memoryId))
      return memory && targetMatches(memory, target) ? clone(memory) : null
    },
    async list(input: SharedMemoryListInput) {
      const target = normalizeSharedMemoryTarget(input.target)
      const normalizedQuery = input.query?.toLocaleLowerCase() ?? null
      return [...memories.values()]
        .filter((memory) => memory.tenant_id === input.tenantId && targetMatches(memory, target))
        .filter((memory) => input.contexts === null || input.contexts.some((context) => (
          memory.context.kind === context.kind && memory.context.context_id === context.context_id
        )))
        .filter((memory) => input.keys === undefined || input.keys === null || input.keys.includes(memory.key))
        .filter((memory) => !normalizedQuery || (
          memory.key.toLocaleLowerCase().includes(normalizedQuery) ||
          memory.content.toLocaleLowerCase().includes(normalizedQuery)
        ))
        .sort((left, right) => right.updated_at - left.updated_at || left.memory_id.localeCompare(right.memory_id))
        .filter((memory) => !input.position || (
          memory.updated_at < input.position.updatedAt ||
          (memory.updated_at === input.position.updatedAt && memory.memory_id > input.position.memoryId)
        ))
        .slice(0, input.limit)
        .map(clone)
    },
    async delete(input: SharedMemoryDeleteInput) {
      const target = normalizeSharedMemoryTarget(input.target)
      const key = targetRecordKey(input.tenantId, target)
      return serial.run(key, async () => {
        const idempotent = existingMutation({
          tenantId: input.tenantId,
          target,
          idempotencyKeyDigest: input.idempotencyKeyDigest,
          requestDigest: input.requestDigest,
        })
        if (idempotent) {
          if ("deleted_revision" in idempotent) return idempotent
          throw new PlatformApiError("MEMORY_IDEMPOTENCY_OPERATION_MISMATCH", 409)
        }
        const current = memories.get(recordKey(input.tenantId, input.memoryId))
        if (!current || !targetMatches(current, target)) throw new PlatformApiError("MEMORY_NOT_FOUND", 404)
        if (current.revision !== input.expectedRevision) throw new PlatformApiError("MEMORY_REVISION_CONFLICT", 409)
        const deletion: SharedMemoryDeletion = {
          memory_id: current.memory_id,
          scope: current.scope,
          owner_subject_id: current.owner_subject_id,
          deleted_revision: current.revision,
          deleted_at: now(),
        }
        memories.delete(recordKey(input.tenantId, current.memory_id))
        cascadeProposals({
          tenantId: input.tenantId,
          target,
          memoryId: current.memory_id,
        })
        byIdentity.delete(`${input.tenantId}\u0000${identityKey({
          target,
          key: current.key,
          kind: current.kind,
          context: current.context,
        })}`)
        appendMutation({
          tenantId: input.tenantId,
          target,
          memoryId: current.memory_id,
          idempotencyKeyDigest: input.idempotencyKeyDigest,
          requestDigest: input.requestDigest,
          actorSubjectId: input.actorSubjectId,
          clientId: input.clientId,
          agentId: input.agentId,
          agentGrantId: input.agentGrantId,
          operation: "DELETED",
          previousRevision: current.revision,
          revision: current.revision,
          assertionOrigin: input.assertionOrigin,
          confirmation: null,
          deletion,
        })
        return clone(deletion)
      })
    },
  }
  return repository
}
