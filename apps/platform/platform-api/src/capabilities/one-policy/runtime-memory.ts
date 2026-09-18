import { createPolicyDraftStore, requireRuntimePolicyDraft, runtimePolicyDraftKey, type MemoryPolicyDraftStore } from "./drafts"
import { PlatformApiError } from "../errors"
import type { RuntimePolicyRevision } from "./runtime"
import { RUNTIME_POLICY_ID } from "./runtime"
import type { RuntimePolicyStore } from "./module"

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000)
}

export function createInMemoryRuntimePolicyStore(options: {
  drafts?: MemoryPolicyDraftStore
  now?: () => number
  defaultPolicy?: (tenantId: string, now: number) => RuntimePolicyRevision
} = {}): RuntimePolicyStore {
  const revisions = new Map<string, RuntimePolicyRevision[]>()
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
  function publish({ tenantId, policyId, baseRevision, definition, publishedBy, displayName }: Parameters<RuntimePolicyStore["publish"]>[0]): RuntimePolicyRevision {
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
    values.push(structuredClone(next))
    revisions.set(key(tenantId, policyId), values)
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
      const existing = await this.getLatest({ tenantId, policyId: RUNTIME_POLICY_ID })
      if (existing) return existing
      const value = defaultPolicy(tenantId, now())
      revisions.set(key(tenantId, value.policy_id), [structuredClone(value)])
      return structuredClone(value)
    },
    async publish(input) { return publish(input) },
    async publishDraft({ tenantId, policyId, expectedVersion, publishedBy }) {
      return drafts.consume(tenantId, runtimePolicyDraftKey(policyId), expectedVersion, (draft) =>
        publish({ tenantId, policyId, publishedBy, ...requireRuntimePolicyDraft(draft, expectedVersion) }))
    },
    async setEnabled({ tenantId, policyId, expectedRevision, enabled, publishedBy }) {
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
      values.push(structuredClone(next))
      revisions.set(key(tenantId, policyId), values)
      return structuredClone(next)
    },
  }
}
