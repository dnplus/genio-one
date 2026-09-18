import { Type, type Static } from "typebox"
import type { SqlAdapter } from "../../persistence/sql-adapter"
import { PlatformApiError } from "../errors"
import { EnforcementChainMutationBodySchema } from "../enforcement/contract"
import { RuntimePolicyDefinitionSchema, type RuntimePolicyDefinition } from "./runtime"

export const BotRulesSchema = Type.Object({
  allowed_roles: Type.Array(Type.Union([Type.Literal("TENANT_ADMINISTRATOR"), Type.Literal("ORGANIZATION_ADMINISTRATOR"), Type.Literal("USER")]), { uniqueItems: true }),
  allowed_subject_ids: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 1000, uniqueItems: true }),
}, { additionalProperties: false })
export type BotRules = Static<typeof BotRulesSchema>
export const defaultBotRules: BotRules = { allowed_roles: ["TENANT_ADMINISTRATOR"], allowed_subject_ids: [] }

export const PolicyDraftContentSchema = Type.Union([
  Type.Object({ kind: Type.Literal("RESOURCE_CAPABILITY"), definition: EnforcementChainMutationBodySchema }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("BOT_ACCESS"), definition: BotRulesSchema }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("RUNTIME_CAPABILITY"), definition: RuntimePolicyDefinitionSchema }, { additionalProperties: false }),
])
export const PolicyDraftSchema = Type.Object({
  policy_key: Type.String(),
  version: Type.Integer({ minimum: 1 }),
  base_revision: Type.Integer({ minimum: 0 }),
  content: PolicyDraftContentSchema,
  updated_at: Type.Integer(),
})
export const SavePolicyDraftSchema = Type.Object({
  expected_version: Type.Integer({ minimum: 0 }),
  base_revision: Type.Integer({ minimum: 0 }),
  content: PolicyDraftContentSchema,
}, { additionalProperties: false })
export const PublishPolicyDraftSchema = Type.Object({ expected_version: Type.Integer({ minimum: 1 }) }, { additionalProperties: false })
export type PolicyDraft = Static<typeof PolicyDraftSchema>
export type SavePolicyDraft = Static<typeof SavePolicyDraftSchema>
export type RuntimePolicyDraftDefinition = RuntimePolicyDefinition
export interface PolicyDraftStore {
  list(tenantId: string): Promise<PolicyDraft[]>
  get(tenantId: string, key: string): Promise<PolicyDraft | null>
  save(tenantId: string, key: string, value: SavePolicyDraft): Promise<PolicyDraft>
  remove(tenantId: string, key: string, version: number): Promise<boolean>
}
export function resourcePolicyKey(resourceId: string, capabilityId: string) {
  return JSON.stringify([resourceId, capabilityId])
}
function conflict(): never { throw new PlatformApiError("POLICY_DRAFT_CONFLICT", 409) }

export function runtimePolicyDraftKey(policyId: string) {
  return `runtime-capability:${policyId}`
}

export function requireRuntimePolicyDraft(draft: PolicyDraft | null, version: number) {
  if (!draft || draft.version !== version) conflict()
  if (draft.content.kind !== "RUNTIME_CAPABILITY") throw new PlatformApiError("POLICY_KIND_MISMATCH", 422)
  return { baseRevision: draft.base_revision, definition: draft.content.definition }
}

export function requireBotPolicyDraft(draft: PolicyDraft | null, version: number) {
  if (!draft || draft.version !== version) conflict()
  if (draft.content.kind !== "BOT_ACCESS") throw new PlatformApiError("POLICY_KIND_MISMATCH", 422)
  return { baseRevision: draft.base_revision, rules: draft.content.definition }
}

export interface MemoryPolicyDraftStore extends PolicyDraftStore {
  consume<T>(tenantId: string, key: string, version: number, publish: (draft: PolicyDraft) => T): T
}

export function createPolicyDraftStore(): MemoryPolicyDraftStore
export function createPolicyDraftStore(sql: SqlAdapter | undefined): PolicyDraftStore
export function createPolicyDraftStore(sql?: SqlAdapter): PolicyDraftStore {
  if (sql) return createPostgresPolicyDraftStore(sql)
  const values = new Map<string, PolicyDraft>()
  const versions = new Map<string, number>()
  const store: MemoryPolicyDraftStore = {
    async list(tenantId) {
      return [...values.entries()].filter(([key]) => JSON.parse(key)[0] === tenantId).map(([, value]) => structuredClone(value))
    },
    async get(tenantId, key) {
      return structuredClone(values.get(JSON.stringify([tenantId, key])) ?? null)
    },
    async save(tenantId, key, value) {
      const id = JSON.stringify([tenantId, key])
      if ((values.get(id)?.version ?? 0) !== value.expected_version) conflict()
      const next: PolicyDraft = { policy_key: key, version: (versions.get(id) ?? 0) + 1, base_revision: value.base_revision, content: structuredClone(value.content), updated_at: Math.floor(Date.now() / 1000) }
      versions.set(id, next.version)
      values.set(id, next)
      return structuredClone(next)
    },
    async remove(tenantId, key, version) {
      const id = JSON.stringify([tenantId, key])
      if (values.get(id)?.version === version) return values.delete(id)
      return false
    },
    consume(tenantId, key, version, publish) {
      const id = JSON.stringify([tenantId, key])
      const draft = values.get(id)
      if (!draft || draft.version !== version) conflict()
      const result = publish(structuredClone(draft))
      values.delete(id)
      return result
    },
  }
  return store
}

function createPostgresPolicyDraftStore(sql: SqlAdapter): PolicyDraftStore {
  return {
    async list(tenantId) {
      return (await sql.query<{ value: PolicyDraft }>("select value from genio_one_policy_drafts where tenant_id = $1 and value <> 'null'::jsonb", [tenantId])).rows.map((row) => row.value)
    },
    async get(tenantId, key) {
      const result = await sql.query<{ value: PolicyDraft }>("select value from genio_one_policy_drafts where tenant_id = $1 and policy_key = $2", [tenantId, key])
      return result.rows[0]?.value ?? null
    },
    async save(tenantId, key, value) {
      const next: PolicyDraft = { policy_key: key, version: value.expected_version + 1, base_revision: value.base_revision, content: value.content, updated_at: Math.floor(Date.now() / 1000) }
      const result = value.expected_version === 0
        ? await sql.query<{ value: PolicyDraft }>("insert into genio_one_policy_drafts (tenant_id, policy_key, value, last_version) values ($1, $2, $3::text::jsonb, 1) on conflict (tenant_id, policy_key) do update set last_version = genio_one_policy_drafts.last_version + 1, value = jsonb_set(excluded.value, '{version}', to_jsonb(genio_one_policy_drafts.last_version + 1)) where genio_one_policy_drafts.value = 'null'::jsonb returning value", [tenantId, key, JSON.stringify(next)])
        : await sql.query<{ value: PolicyDraft }>("update genio_one_policy_drafts set value = $3::text::jsonb, last_version = last_version + 1 where tenant_id = $1 and policy_key = $2 and (value->>'version')::int = $4 returning value", [tenantId, key, JSON.stringify(next), value.expected_version])
      if (!result.rowCount) conflict()
      return result.rows[0]!.value
    },
    async remove(tenantId, key, version) {
      return (await sql.query("update genio_one_policy_drafts set value = 'null'::jsonb where tenant_id = $1 and policy_key = $2 and (value->>'version')::int = $3 returning policy_key", [tenantId, key, version])).rowCount > 0
    },
  }
}

export const BotPolicyRevisionSchema = Type.Object({
  policy_revision: Type.Integer({ minimum: 1 }),
  rules: BotRulesSchema,
  published_by: Type.Union([Type.String(), Type.Null()]),
  published_at: Type.Integer(),
})
export type BotPolicyRevision = Static<typeof BotPolicyRevisionSchema>
