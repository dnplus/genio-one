import { PlatformApiError } from "../errors"
import { canonicalEnforcementChainDigest, validateCompiledEnforcementChainSemantics } from "./compiler"
import type { EnforcementChainCompiler, EnforcementChainRevision, EnforcementChainRevisionReader, EnforcementChainRevisionStore } from "./module"
import { requireResourcePolicyDraft, resourcePolicyKey, type MemoryPolicyDraftStore } from "../one-policy/drafts"
import type { GatewayAuthorizationAuditStore } from "../audit-events/module"
import type { PolicyChangeAuditEvent } from "../audit-events/contract"
import { policyChangeAuditEvent, policySystemPublishAuditEvent } from "../one-policy/lifecycle"
import { createKeyedSerialExecutor } from "../../persistence/keyed-serial-executor"

type SaveRevisionInput = Parameters<EnforcementChainRevisionStore["save"]>[0]

export function createInMemoryEnforcementChainReader(options: {
  drafts?: MemoryPolicyDraftStore
  compiler?: EnforcementChainCompiler
  audit?: GatewayAuthorizationAuditStore
  now?: () => number
} = {}): EnforcementChainRevisionReader {
  const revisions = new Map<string, EnforcementChainRevision>()
  const mutations = createKeyedSerialExecutor()
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000))
  const policyKey = (tenantId: string, resourceId: string, capabilityId: string) => JSON.stringify([tenantId, resourceId, capabilityId])
  const revisionKey = (tenantId: string, resourceId: string, capabilityId: string, revision: number) => JSON.stringify([tenantId, resourceId, capabilityId, revision])

  function getLatest({ tenantId, resourceId, capabilityId }: { tenantId: string; resourceId: string; capabilityId: string }) {
    return [...revisions.values()]
      .filter((revision) => revision.tenant_id === tenantId && revision.resource_id === resourceId && revision.capability_id === capabilityId)
      .sort((left, right) => right.one_policy_revision - left.one_policy_revision)[0] ?? null
  }

  async function commitRevision({ tenantId, chain, provenance }: SaveRevisionInput, event: PolicyChangeAuditEvent): Promise<EnforcementChainRevision> {
    if (chain.tenant_id !== tenantId) throw new PlatformApiError("ENFORCEMENT_TENANT_MISMATCH", 422)
    validateCompiledEnforcementChainSemantics(chain)
    const key = revisionKey(tenantId, chain.resource_id, chain.capability_id, chain.one_policy_revision)
    const digest = canonicalEnforcementChainDigest(chain)
    const existing = revisions.get(key)
    if (existing) {
      if (existing.chain_digest !== digest) throw new PlatformApiError("ENFORCEMENT_CHAIN_REVISION_IMMUTABLE", 409)
      return structuredClone(existing)
    }
    const revision: EnforcementChainRevision = {
      tenant_id: tenantId,
      resource_id: chain.resource_id,
      capability_id: chain.capability_id,
      one_policy_revision: chain.one_policy_revision,
      chain: structuredClone(chain),
      chain_digest: digest,
      published_by_subject_id: provenance?.publishedBySubjectId ?? "system",
      reviewed_by_subject_id: provenance?.reviewedBySubjectId ?? null,
      rollback_source_one_policy_revision: provenance?.rollbackSourceOnePolicyRevision ?? null,
      created_at: event.occurred_at,
      updated_at: event.occurred_at,
    }
    if (options.audit) await options.audit.record({ tenantId, event })
    revisions.set(key, revision)
    return structuredClone(revision)
  }

  return {
    async listInventory({ tenantId }) {
      const latest = new Map<string, EnforcementChainRevision>()
      for (const revision of revisions.values()) {
        if (revision.tenant_id !== tenantId) continue
        const key = policyKey(tenantId, revision.resource_id, revision.capability_id)
        const current = latest.get(key)
        if (!current || revision.one_policy_revision > current.one_policy_revision) latest.set(key, revision)
      }
      return [...latest.values()]
        .sort((left, right) => left.resource_id.localeCompare(right.resource_id) || left.capability_id.localeCompare(right.capability_id))
        .map((revision) => ({
          tenant_id: tenantId,
          resource_id: revision.resource_id,
          capability_id: revision.capability_id,
          one_policy_revision: revision.one_policy_revision,
          status: "READY" as const,
          revision: structuredClone(revision),
          issue_code: null,
        }))
    },
    async save(input) {
      const { tenantId, chain, provenance } = input
      return mutations.run(policyKey(tenantId, chain.resource_id, chain.capability_id), () => commitRevision(input, policySystemPublishAuditEvent({
        tenantId,
        policyKey: resourcePolicyKey(chain.resource_id, chain.capability_id),
        publishedRevision: chain.one_policy_revision,
        content: chain,
        actorSubjectId: provenance?.publishedBySubjectId ?? "system",
        correlationId: provenance?.correlationId ?? `policy-system-${chain.resource_id}-${chain.capability_id}-${chain.one_policy_revision}`,
        occurredAt: now(),
      })))
    },
    async publishDraft({ tenantId, resourceId, capabilityId, expectedVersion, expectedContentDigest, publishedBySubjectId, correlationId }) {
      const { drafts, compiler, audit } = options
      if (!drafts || !compiler || !audit) throw new PlatformApiError("ENFORCEMENT_DRAFT_PUBLISHER_UNAVAILABLE", 503)
      const key = resourcePolicyKey(resourceId, capabilityId)
      return drafts.consumeAsync(tenantId, key, expectedVersion, (draft) => mutations.run(policyKey(tenantId, resourceId, capabilityId), async () => {
        const { baseRevision, definition } = requireResourcePolicyDraft(draft, expectedVersion, expectedContentDigest)
        const latest = getLatest({ tenantId, resourceId, capabilityId })
        if ((latest?.one_policy_revision ?? 0) !== baseRevision || definition.one_policy_revision !== baseRevision + 1) {
          throw new PlatformApiError("POLICY_REVISION_CONFLICT", 409)
        }
        const chain = await compiler.compile({
          tenantId,
          value: {
            ...definition,
            resource_id: resourceId,
            capability_id: capabilityId,
            eligible_connection_ids: definition.eligible_connection_ids ?? await compiler.listEligibleConnectionIds({ tenantId, resourceId }),
          },
        })
        return commitRevision({
          tenantId,
          chain,
          provenance: {
            publishedBySubjectId,
            reviewedBySubjectId: draft.review?.actor_subject_id ?? null,
            rollbackSourceOnePolicyRevision: null,
          },
        }, policyChangeAuditEvent({
          tenantId,
          policyKey: key,
          draft,
          action: "PUBLISHED",
          actorSubjectId: publishedBySubjectId,
          correlationId,
          occurredAt: now(),
          publishedRevision: chain.one_policy_revision,
        }))
      }))
    },
    async getLatest(input) {
      return structuredClone(getLatest(input))
    },
    async get({ tenantId, resourceId, capabilityId, onePolicyRevision }) {
      return structuredClone(revisions.get(revisionKey(tenantId, resourceId, capabilityId, onePolicyRevision)) ?? null)
    },
  }
}
