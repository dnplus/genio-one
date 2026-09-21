import { createPolicyDraftStore, requireRuntimePolicyDraft, runtimePolicyDraftKey, type MemoryPolicyDraftStore } from "./drafts"
import { PlatformApiError } from "../errors"
import type { RuntimePolicyRevision } from "./runtime"
import { RUNTIME_POLICY_ID } from "./runtime"
import type { RuntimePolicyStore } from "./module"
import { validateRuntimePolicyForPublication } from "./runtime-policy-validator"
import type { GatewayAuthorizationAuditStore } from "../audit-events/module"
import { policyChangeAuditEvent, policyEnabledAuditEvent, policySystemPublishAuditEvent } from "./lifecycle"
import { createKeyedSerialExecutor } from "../../persistence/keyed-serial-executor"

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000)
}

export function createInMemoryRuntimePolicyStore(options: {
  drafts?: MemoryPolicyDraftStore
  now?: () => number
  defaultPolicy?: (tenantId: string, now: number) => RuntimePolicyRevision
  audit?: GatewayAuthorizationAuditStore
} = {}): RuntimePolicyStore {
  const revisions = new Map<string, RuntimePolicyRevision[]>()
  const mutations = createKeyedSerialExecutor()
  const now = options.now ?? nowSeconds
  const key = (tenantId: string, policyId: string) => `${tenantId}\0${policyId}`
  const defaultPolicy = options.defaultPolicy ?? ((tenantId: string, at: number): RuntimePolicyRevision => ({
    tenant_id: tenantId,
    policy_id: RUNTIME_POLICY_ID,
    revision: 1,
    display_name: "Agent Runtime Capabilities",
    provenance: "SYSTEM_SEED",
    enabled: true,
    scope: {
      subject_ids: [],
      organization_ids: [],
      roles: [],
      client_ids: [],
      bot_ids: [],
      runtime_ids: [],
    },
    rules: [],
    published_by_subject_id: null,
    created_at: at,
    published_at: at,
  }))

  const drafts = options.drafts ?? createPolicyDraftStore()
  function prepareRevision({ tenantId, policyId, baseRevision, definition, publishedBy, displayName }: Parameters<RuntimePolicyStore["publish"]>[0]): RuntimePolicyRevision {
    validateRuntimePolicyForPublication(definition)
    const values = revisions.get(key(tenantId, policyId)) ?? []
    const current = values[values.length - 1]
    if (!current && baseRevision !== 0) throw new PlatformApiError("POLICY_REVISION_CONFLICT", 409)
    if (current && current.revision !== baseRevision) throw new PlatformApiError("POLICY_REVISION_CONFLICT", 409)
    const at = now()
    const next: RuntimePolicyRevision = {
      tenant_id: tenantId,
      policy_id: policyId,
      revision: (current?.revision ?? 0) + 1,
      display_name: displayName ?? definition.display_name ?? current?.display_name ?? policyId,
      provenance: current?.provenance === "SYSTEM_SEED" ? "SYSTEM_SEED" : "TENANT_AUTHORED",
      enabled: current?.enabled ?? true,
      scope: structuredClone(definition.scope),
      rules: structuredClone(definition.rules),
      published_by_subject_id: publishedBy,
      created_at: at,
      published_at: at,
    }
    return next
  }

  function commitRevision(next: RuntimePolicyRevision): RuntimePolicyRevision {
    const revisionKey = key(next.tenant_id, next.policy_id)
    revisions.set(revisionKey, [...(revisions.get(revisionKey) ?? []), structuredClone(next)])
    return structuredClone(next)
  }

  return {
    async list(tenantId) {
      return [...revisions.entries()]
        .filter(([entryKey]) => entryKey.startsWith(`${tenantId}\0`))
        .flatMap(([, values]) => values)
        .sort((left, right) => left.policy_id.localeCompare(right.policy_id) || right.revision - left.revision)
        .map((value) => structuredClone(value))
    },
    async listLatest(tenantId) {
      return [...revisions.entries()]
        .filter(([entryKey]) => entryKey.startsWith(`${tenantId}\0`))
        .map(([, values]) => values[values.length - 1]!)
        .filter((value): value is RuntimePolicyRevision => value !== undefined)
        .sort((left, right) => left.policy_id.localeCompare(right.policy_id))
        .map((value) => structuredClone(value))
    },
    async getLatest({ tenantId, policyId }) {
      if (!policyId) {
        const latest = await this.listLatest(tenantId)
        return latest[0] ?? null
      }
      const values = revisions.get(key(tenantId, policyId)) ?? []
      return values.length > 0 ? structuredClone(values[values.length - 1]!) : null
    },
    async getRevision({ tenantId, policyId, revision }) {
      const value = (revisions.get(key(tenantId, policyId)) ?? []).find((candidate) => candidate.revision === revision)
      return value ? structuredClone(value) : null
    },
    async ensureDefault({ tenantId }) {
      return mutations.run(key(tenantId, RUNTIME_POLICY_ID), async () => {
        const existing = await this.getLatest({ tenantId, policyId: RUNTIME_POLICY_ID })
        if (existing) return existing
        return commitRevision(defaultPolicy(tenantId, now()))
      })
    },
    async publish(input) {
      const revisionKey = key(input.tenantId, input.policyId)
      return mutations.run(revisionKey, async () => {
        const published = prepareRevision(input)
        if (options.audit) {
          await options.audit.record({
            tenantId: input.tenantId,
            event: policySystemPublishAuditEvent({
              tenantId: input.tenantId,
              policyKey: runtimePolicyDraftKey(input.policyId),
              publishedRevision: published.revision,
              content: input.definition,
              actorSubjectId: input.publishedBy,
              correlationId: input.correlationId ?? `policy-system-${input.policyId}-${published.revision}`,
              occurredAt: now(),
            }),
          })
        }
        return commitRevision(published)
      })
    },
    async publishDraft({ tenantId, policyId, expectedVersion, expectedContentDigest, publishedBy, correlationId }) {
      const revisionKey = key(tenantId, policyId)
      return drafts.consumeAsync(tenantId, runtimePolicyDraftKey(policyId), expectedVersion, (draft) => mutations.run(revisionKey, async () => {
        const published = prepareRevision({ tenantId, policyId, publishedBy, ...requireRuntimePolicyDraft(draft, expectedVersion, expectedContentDigest) })
        if (options.audit) {
          await options.audit.record({
            tenantId,
            event: policyChangeAuditEvent({
              tenantId,
              policyKey: runtimePolicyDraftKey(policyId),
              draft,
              action: "PUBLISHED",
              actorSubjectId: publishedBy,
              correlationId: correlationId ?? `policy-publish-${policyId}-${expectedVersion}`,
              occurredAt: now(),
              publishedRevision: published.revision,
            }),
          })
        }
        return commitRevision(published)
      }))
    },
    async setEnabled({ tenantId, policyId, expectedRevision, enabled, publishedBy, correlationId }) {
      return mutations.run(key(tenantId, policyId), async () => {
        const values = revisions.get(key(tenantId, policyId)) ?? []
        const current = values[values.length - 1]
        if (!current || current.revision !== expectedRevision) throw new PlatformApiError("POLICY_REVISION_CONFLICT", 409)
        const at = now()
        const next: RuntimePolicyRevision = {
          ...structuredClone(current),
          revision: current.revision + 1,
          enabled,
          published_by_subject_id: publishedBy,
          created_at: at,
          published_at: at,
        }
        if (!options.audit) throw new PlatformApiError("POLICY_AUDIT_UNAVAILABLE", 503)
        await options.audit.record({
          tenantId,
          event: policyEnabledAuditEvent({
            tenantId,
            policyKey: runtimePolicyDraftKey(policyId),
            previousRevision: current.revision,
            publishedRevision: next.revision,
            enabled,
            content: {
              display_name: next.display_name,
              enabled: next.enabled,
              scope: next.scope,
              rules: next.rules,
            },
            actorSubjectId: publishedBy,
            correlationId,
            occurredAt: at,
          }),
        })
        return commitRevision(next)
      })
    },
  }
}
