import { Type, type Static } from "typebox"
import * as Value from "typebox/value"

import type { SqlAdapter, SqlTransaction } from "../../persistence/sql-adapter"
import { createKeyedSerialExecutor } from "../../persistence/keyed-serial-executor"
import { PlatformApiError } from "../errors"
import { EnforcementChainMutationBodySchema } from "../enforcement/contract"
import type { GatewayAuthorizationAuditStore } from "../audit-events/module"
import {
  assertExpectedPolicyDraft,
  createPolicyDraftLifecycleFields,
  policyAuthoringSettingsAuditEvent,
  policyChangeAuditEvent,
  policyDraftEvidence,
  policyDraftMutationContext,
  requireReviewedPolicyDraft,
  requireValidatedPolicyDraft,
  type PolicyDraftLifecycle,
  type PolicyDraftMutationContext,
  type ResolvedPolicyDraftMutationContext,
  type PolicyDraftTransitionInput,
} from "./lifecycle"
import { RuntimePolicyDefinitionSchema, type RuntimePolicyDefinition } from "./runtime"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })
const Digest = Type.String({ pattern: "^[a-f0-9]{64}$" })

export const BotRulesSchema = Type.Object({
  allowed_roles: Type.Array(Type.Union([Type.Literal("TENANT_ADMINISTRATOR"), Type.Literal("ORGANIZATION_ADMINISTRATOR"), Type.Literal("USER")]), { uniqueItems: true }),
  allowed_subject_ids: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 1000, uniqueItems: true }),
  computer_use_enabled: Type.Optional(Type.Boolean()),
}, { additionalProperties: false })
export type BotRules = Static<typeof BotRulesSchema>
export const defaultBotRules: BotRules = { allowed_roles: ["TENANT_ADMINISTRATOR"], allowed_subject_ids: [] }

export const PolicyDraftContentSchema = Type.Union([
  Type.Object({ kind: Type.Literal("RESOURCE_CAPABILITY"), definition: EnforcementChainMutationBodySchema }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("BOT_ACCESS"), definition: BotRulesSchema }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("RUNTIME_CAPABILITY"), definition: RuntimePolicyDefinitionSchema }, { additionalProperties: false }),
])

export const PolicyDraftEvidenceSchema = Type.Object({
  actor_subject_id: Type.Union([Identifier, Type.Null()]),
  at: Type.Integer({ minimum: 0 }),
  content_digest: Digest,
  correlation_id: Type.Union([Identifier, Type.Null()]),
}, { additionalProperties: false })

export const PolicyDraftSchema = Type.Object({
  policy_key: Type.String(),
  version: Type.Integer({ minimum: 1 }),
  base_revision: Type.Integer({ minimum: 0 }),
  content: PolicyDraftContentSchema,
  lifecycle: Type.Union([Type.Literal("DRAFT"), Type.Literal("VALIDATED"), Type.Literal("REVIEWED")]),
  content_digest: Digest,
  created_by_subject_id: Type.Union([Identifier, Type.Null()]),
  created_at: Type.Integer({ minimum: 0 }),
  updated_by_subject_id: Type.Union([Identifier, Type.Null()]),
  updated_at: Type.Integer({ minimum: 0 }),
  validation: Type.Union([PolicyDraftEvidenceSchema, Type.Null()]),
  review: Type.Union([PolicyDraftEvidenceSchema, Type.Null()]),
}, { additionalProperties: false })

export const SavePolicyDraftSchema = Type.Object({
  expected_version: Type.Integer({ minimum: 0 }),
  base_revision: Type.Integer({ minimum: 0 }),
  content: PolicyDraftContentSchema,
}, { additionalProperties: false })

export const PolicyDraftTransitionSchema = Type.Object({
  expected_version: Type.Integer({ minimum: 1 }),
  expected_content_digest: Digest,
}, { additionalProperties: false })

export const PublishPolicyDraftSchema = PolicyDraftTransitionSchema
export const DiscardPolicyDraftSchema = Type.Object({ expected_version: Type.Integer({ minimum: 1 }) }, { additionalProperties: false })
export const PolicyAuthoringSettingsSchema = Type.Object({
  tenant_id: Identifier,
  revision: Type.Integer({ minimum: 0 }),
  require_distinct_reviewer: Type.Boolean(),
  updated_at: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })
export const SavePolicyAuthoringSettingsSchema = Type.Object({
  expected_revision: Type.Integer({ minimum: 0 }),
  require_distinct_reviewer: Type.Boolean(),
}, { additionalProperties: false })

export type PolicyDraft = Static<typeof PolicyDraftSchema>
export type SavePolicyDraft = Static<typeof SavePolicyDraftSchema>
export type RuntimePolicyDraftDefinition = RuntimePolicyDefinition
export type PolicyAuthoringSettings = Static<typeof PolicyAuthoringSettingsSchema>
export type SavePolicyAuthoringSettings = Static<typeof SavePolicyAuthoringSettingsSchema>
export type { PolicyDraftLifecycle, PolicyDraftMutationContext, PolicyDraftTransitionInput, ResolvedPolicyDraftMutationContext }

export interface PolicyDraftStore {
  list(tenantId: string): Promise<PolicyDraft[]>
  get(tenantId: string, key: string): Promise<PolicyDraft | null>
  save(tenantId: string, key: string, value: SavePolicyDraft, context?: PolicyDraftMutationContext): Promise<PolicyDraft>
  validate(tenantId: string, key: string, input: PolicyDraftTransitionInput): Promise<PolicyDraft>
  review(tenantId: string, key: string, input: PolicyDraftTransitionInput): Promise<PolicyDraft>
  remove(tenantId: string, key: string, version: number, context?: PolicyDraftMutationContext): Promise<boolean>
  getAuthoringSettings(tenantId: string): Promise<PolicyAuthoringSettings>
  saveAuthoringSettings(tenantId: string, value: SavePolicyAuthoringSettings, context: ResolvedPolicyDraftMutationContext): Promise<PolicyAuthoringSettings>
}

export interface PolicyDraftStoreOptions {
  sql?: SqlAdapter
  now?: () => number
  requireDistinctReviewer?: boolean
  audit?: GatewayAuthorizationAuditStore
}

export function resourcePolicyKey(resourceId: string, capabilityId: string) {
  return JSON.stringify([resourceId, capabilityId])
}

function conflict(): never {
  throw new PlatformApiError("POLICY_DRAFT_CONFLICT", 409)
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000)
}

function assertDraft(value: unknown): PolicyDraft {
  let parsed = value
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown
    } catch {
      throw new PlatformApiError("POLICY_DRAFT_DATA_INVALID", 500)
    }
  }
  if (Value.Check(PolicyDraftSchema, parsed)) return structuredClone(parsed as PolicyDraft)
  throw new PlatformApiError("POLICY_DRAFT_DATA_INVALID", 500)
}

export function policyDraftFromStoredValue(value: unknown): PolicyDraft | null {
  if (value === null || value === "null") return null
  return assertDraft(value)
}

function createDraft(
  key: string,
  version: number,
  value: SavePolicyDraft,
  context: ResolvedPolicyDraftMutationContext,
): PolicyDraft {
  return {
    policy_key: key,
    version,
    base_revision: value.base_revision,
    content: structuredClone(value.content),
    ...createPolicyDraftLifecycleFields(value.content, context),
  }
}

function validateDraft(
  draft: PolicyDraft,
  input: PolicyDraftTransitionInput,
  context: ResolvedPolicyDraftMutationContext,
): PolicyDraft {
  assertExpectedPolicyDraft(draft, input)
  if (draft.lifecycle !== "DRAFT") return structuredClone(draft)
  return {
    ...draft,
    lifecycle: "VALIDATED",
    validation: policyDraftEvidence(draft.content_digest, context),
    updated_by_subject_id: context.actorSubjectId,
    updated_at: context.at,
  }
}

function reviewDraft(
  draft: PolicyDraft,
  input: PolicyDraftTransitionInput,
  context: ResolvedPolicyDraftMutationContext,
  requireDistinctReviewer: boolean,
): PolicyDraft {
  requireValidatedPolicyDraft(draft, input)
  if (draft.lifecycle === "REVIEWED") {
    if (
      draft.review?.content_digest !== draft.content_digest ||
      draft.review.actor_subject_id !== context.actorSubjectId
    ) {
      throw new PlatformApiError("POLICY_REVIEWER_CONFLICT", 409)
    }
    return structuredClone(draft)
  }
  if (
    requireDistinctReviewer &&
    context.actorSubjectId !== null &&
    context.actorSubjectId === draft.created_by_subject_id
  ) {
    throw new PlatformApiError("POLICY_DISTINCT_REVIEWER_REQUIRED", 409)
  }
  return {
    ...draft,
    lifecycle: "REVIEWED",
    review: policyDraftEvidence(draft.content_digest, context),
    updated_by_subject_id: context.actorSubjectId,
    updated_at: context.at,
  }
}

async function recordPolicyDraftAudit(input: {
  audit: GatewayAuthorizationAuditStore | undefined
  transaction?: SqlTransaction
  tenantId: string
  policyKey: string
  draft: PolicyDraft
  action: "DRAFT_SAVED" | "VALIDATED" | "REVIEWED" | "DISCARDED"
  context: ResolvedPolicyDraftMutationContext
}): Promise<void> {
  if (!input.audit) return
  const event = policyChangeAuditEvent({
    tenantId: input.tenantId,
    policyKey: input.policyKey,
    draft: input.draft,
    action: input.action,
    actorSubjectId: input.context.actorSubjectId,
    correlationId: input.context.correlationId,
    occurredAt: input.context.at,
  })
  if (input.transaction) {
    if (!input.audit.recordInTransaction) {
      throw new PlatformApiError("POLICY_AUDIT_TRANSACTION_UNAVAILABLE", 500)
    }
    await input.audit.recordInTransaction({
      transaction: input.transaction,
      tenantId: input.tenantId,
      event,
    })
    return
  }
  await input.audit.record({ tenantId: input.tenantId, event })
}

export function runtimePolicyDraftKey(policyId: string) {
  return `runtime-capability:${policyId}`
}

export function requireRuntimePolicyDraft(
  draft: PolicyDraft | null,
  expectedVersion: number,
  expectedContentDigest: string,
) {
  if (!draft) conflict()
  requireReviewedPolicyDraft(draft, { expectedVersion, expectedContentDigest })
  if (draft.content.kind !== "RUNTIME_CAPABILITY") throw new PlatformApiError("POLICY_KIND_MISMATCH", 422)
  return { baseRevision: draft.base_revision, definition: draft.content.definition }
}

export function requireBotPolicyDraft(
  draft: PolicyDraft | null,
  expectedVersion: number,
  expectedContentDigest: string,
) {
  if (!draft) conflict()
  requireReviewedPolicyDraft(draft, { expectedVersion, expectedContentDigest })
  if (draft.content.kind !== "BOT_ACCESS") throw new PlatformApiError("POLICY_KIND_MISMATCH", 422)
  return { baseRevision: draft.base_revision, rules: draft.content.definition }
}

export function requireResourcePolicyDraft(
  draft: PolicyDraft | null,
  expectedVersion: number,
  expectedContentDigest: string,
) {
  if (!draft) conflict()
  requireReviewedPolicyDraft(draft, { expectedVersion, expectedContentDigest })
  if (draft.content.kind !== "RESOURCE_CAPABILITY") throw new PlatformApiError("POLICY_KIND_MISMATCH", 422)
  return { baseRevision: draft.base_revision, definition: draft.content.definition }
}

export interface MemoryPolicyDraftStore extends PolicyDraftStore {
  consumeAsync<T>(tenantId: string, key: string, version: number, publish: (draft: PolicyDraft) => Promise<T>): Promise<T>
}

function normalizeOptions(input: SqlAdapter | PolicyDraftStoreOptions | undefined): PolicyDraftStoreOptions {
  if (!input) return {}
  if ("query" in input && "transaction" in input) return { sql: input as SqlAdapter }
  return input as PolicyDraftStoreOptions
}

export function createPolicyDraftStore(): MemoryPolicyDraftStore
export function createPolicyDraftStore(sql: SqlAdapter | undefined): PolicyDraftStore
export function createPolicyDraftStore(options: Omit<PolicyDraftStoreOptions, "sql"> & { sql?: undefined }): MemoryPolicyDraftStore
export function createPolicyDraftStore(options: PolicyDraftStoreOptions): PolicyDraftStore
export function createPolicyDraftStore(input?: SqlAdapter | PolicyDraftStoreOptions): PolicyDraftStore {
  const options = normalizeOptions(input)
  if (options.sql) return createPostgresPolicyDraftStore(options.sql, options)
  const now = options.now ?? nowSeconds
  const values = new Map<string, PolicyDraft>()
  const versions = new Map<string, number>()
  const byTenant = new Map<string, Map<string, PolicyDraft>>()
  const authoringSettings = new Map<string, PolicyAuthoringSettings>()
  const requireDistinctReviewer = options.requireDistinctReviewer ?? false
  const executor = createKeyedSerialExecutor()
  const authoringSettingsKey = (tenantId: string) => JSON.stringify(["policy-authoring-settings", tenantId])
  const currentAuthoringSettings = (tenantId: string): PolicyAuthoringSettings => structuredClone(authoringSettings.get(tenantId) ?? {
    tenant_id: tenantId,
    revision: 0,
    require_distinct_reviewer: requireDistinctReviewer,
    updated_at: now(),
  })
  const removeMemoryDraft = (tenantId: string, key: string, id: string) => {
    values.delete(id)
    const tenantMap = byTenant.get(tenantId)
    if (!tenantMap) return
    tenantMap.delete(key)
    if (tenantMap.size === 0) byTenant.delete(tenantId)
  }

  const store: MemoryPolicyDraftStore = {
    async list(tenantId) {
      const tenantDrafts = byTenant.get(tenantId)
      if (!tenantDrafts) return []
      return [...tenantDrafts.values()].map((value) => structuredClone(value))
    },
    async get(tenantId, key) {
      return structuredClone(values.get(JSON.stringify([tenantId, key])) ?? null)
    },
    async save(tenantId, key, value, context) {
      const id = JSON.stringify([tenantId, key])
      return executor.run(id, async () => {
        if ((values.get(id)?.version ?? 0) !== value.expected_version) conflict()
        const mutation = policyDraftMutationContext(context, now)
        const next = createDraft(
          key,
          (versions.get(id) ?? 0) + 1,
          value,
          mutation,
        )
        await recordPolicyDraftAudit({
          audit: options.audit,
          tenantId,
          policyKey: key,
          draft: next,
          action: "DRAFT_SAVED",
          context: mutation,
        })
        versions.set(id, next.version)
        values.set(id, next)
        let tenantMap = byTenant.get(tenantId)
        if (!tenantMap) {
          tenantMap = new Map()
          byTenant.set(tenantId, tenantMap)
        }
        tenantMap.set(key, next)
        return structuredClone(next)
      })
    },
    async validate(tenantId, key, input) {
      const id = JSON.stringify([tenantId, key])
      return executor.run(id, async () => {
        const current = values.get(id)
        if (!current) conflict()
        const mutation = policyDraftMutationContext(input.context, now)
        const next = validateDraft(current, input, mutation)
        if (current.lifecycle === "DRAFT") {
          await recordPolicyDraftAudit({
            audit: options.audit,
            tenantId,
            policyKey: key,
            draft: next,
            action: "VALIDATED",
            context: mutation,
          })
          values.set(id, next)
          byTenant.get(tenantId)?.set(key, next)
        }
        return structuredClone(next)
      })
    },
    async review(tenantId, key, input) {
      const id = JSON.stringify([tenantId, key])
      return executor.run(authoringSettingsKey(tenantId), () => executor.run(id, async () => {
        const current = values.get(id)
        if (!current) conflict()
        const mutation = policyDraftMutationContext(input.context, now)
        const next = reviewDraft(
          current,
          input,
          mutation,
          currentAuthoringSettings(tenantId).require_distinct_reviewer,
        )
        if (current.lifecycle === "VALIDATED") {
          await recordPolicyDraftAudit({
            audit: options.audit,
            tenantId,
            policyKey: key,
            draft: next,
            action: "REVIEWED",
            context: mutation,
          })
          values.set(id, next)
          byTenant.get(tenantId)?.set(key, next)
        }
        return structuredClone(next)
      }))
    },
    async remove(tenantId, key, version, context) {
      const id = JSON.stringify([tenantId, key])
      return executor.run(id, async () => {
        const current = values.get(id)
        if (!current || current.version !== version) return false
        const mutation = policyDraftMutationContext(context, now)
        await recordPolicyDraftAudit({
          audit: options.audit,
          tenantId,
          policyKey: key,
          draft: current,
          action: "DISCARDED",
          context: mutation,
        })
        removeMemoryDraft(tenantId, key, id)
        return true
      })
    },
    async getAuthoringSettings(tenantId) {
      return currentAuthoringSettings(tenantId)
    },
    async saveAuthoringSettings(tenantId, value, context) {
      return executor.run(authoringSettingsKey(tenantId), async () => {
        const current = currentAuthoringSettings(tenantId)
        if (current.revision !== value.expected_revision) {
          throw new PlatformApiError("POLICY_AUTHORING_SETTINGS_CONFLICT", 409)
        }
        const next: PolicyAuthoringSettings = {
          tenant_id: tenantId,
          revision: current.revision + 1,
          require_distinct_reviewer: value.require_distinct_reviewer,
          updated_at: context.at,
        }
        if (options.audit) {
          await options.audit.record({
            tenantId,
            event: policyAuthoringSettingsAuditEvent({
              tenantId,
              revision: next.revision,
              previousRevision: current.revision,
              requireDistinctReviewer: next.require_distinct_reviewer,
              actorSubjectId: context.actorSubjectId ?? "system",
              correlationId: context.correlationId,
              occurredAt: context.at,
            }),
          })
        }
        authoringSettings.set(tenantId, structuredClone(next))
        return structuredClone(next)
      })
    },
    async consumeAsync(tenantId, key, version, publish) {
      const id = JSON.stringify([tenantId, key])
      return executor.run(id, async () => {
        const draft = values.get(id)
        if (!draft || draft.version !== version) conflict()
        const result = await publish(structuredClone(draft))
        removeMemoryDraft(tenantId, key, id)
        return result
      })
    },
  }
  return store
}

type DraftRow = { value: unknown; last_version: number | string }

async function selectDraft(
  transaction: SqlTransaction,
  tenantId: string,
  key: string,
): Promise<{ draft: PolicyDraft | null; lastVersion: number; exists: boolean }> {
  const result = await transaction.query<DraftRow>(
    "select value, last_version from genio_one_policy_drafts where tenant_id = $1 and policy_key = $2 for update",
    [tenantId, key],
  )
  const row = result.rows[0]
  if (!row) return { draft: null, lastVersion: 0, exists: false }
  const lastVersion = Number(row.last_version)
  if (!Number.isSafeInteger(lastVersion) || lastVersion < 0) {
    throw new PlatformApiError("POLICY_DRAFT_DATA_INVALID", 500)
  }
  return { draft: policyDraftFromStoredValue(row.value), lastVersion, exists: true }
}

async function lockDraft(
  transaction: SqlTransaction,
  tenantId: string,
  key: string,
): Promise<void> {
  await transaction.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify(["policy-draft", tenantId, key])])
}

function createPostgresPolicyDraftStore(sql: SqlAdapter, options: PolicyDraftStoreOptions): PolicyDraftStore {
  const now = options.now ?? nowSeconds
  const defaultRequireDistinctReviewer = options.requireDistinctReviewer ?? false
  async function requireDistinctReviewer(transaction: SqlTransaction, tenantId: string): Promise<boolean> {
    await transaction.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify(["policy-authoring-settings", tenantId])])
    const result = await transaction.query<{ require_distinct_reviewer: boolean | string }>(
      "select require_distinct_reviewer from genio_one_policy_authoring_settings where tenant_id = $1",
      [tenantId],
    )
    const value = result.rows[0]?.require_distinct_reviewer
    if (value === undefined) return defaultRequireDistinctReviewer
    return value === true || value === "true"
  }
  function mapAuthoringSettings(row: { tenant_id: unknown; revision: unknown; require_distinct_reviewer: unknown; updated_at: unknown }): PolicyAuthoringSettings {
    const revision = Number(row.revision)
    const epoch = Number(row.updated_at)
    const updatedAt = Number.isSafeInteger(epoch)
      ? epoch
      : Math.floor(Date.parse(String(row.updated_at)) / 1_000)
    if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isSafeInteger(updatedAt)) {
      throw new PlatformApiError("POLICY_AUTHORING_SETTINGS_DATA_INVALID", 500)
    }
    return {
      tenant_id: String(row.tenant_id),
      revision,
      require_distinct_reviewer: row.require_distinct_reviewer === true || row.require_distinct_reviewer === "true",
      updated_at: updatedAt,
    }
  }
  return {
    async list(tenantId) {
      const result = await sql.query<{ value: unknown }>("select value from genio_one_policy_drafts where tenant_id = $1 and value <> 'null'::jsonb", [tenantId])
      return result.rows.map((row) => policyDraftFromStoredValue(row.value)).filter((value): value is PolicyDraft => value !== null)
    },
    async get(tenantId, key) {
      const result = await sql.query<{ value: unknown }>("select value from genio_one_policy_drafts where tenant_id = $1 and policy_key = $2", [tenantId, key])
      const row = result.rows[0]
      return row ? policyDraftFromStoredValue(row.value) : null
    },
    async save(tenantId, key, value, context) {
      return sql.transaction(async (transaction) => {
        await lockDraft(transaction, tenantId, key)
        const current = await selectDraft(transaction, tenantId, key)
        if ((current.draft?.version ?? 0) !== value.expected_version) conflict()
        const mutation = policyDraftMutationContext(context, now)
        const next = createDraft(
          key,
          Math.max(current.lastVersion, current.draft?.version ?? 0) + 1,
          value,
          mutation,
        )
        const stored = current.exists
          ? await transaction.query(
            "update genio_one_policy_drafts set value = $3::text::jsonb, last_version = $4 where tenant_id = $1 and policy_key = $2",
            [tenantId, key, JSON.stringify(next), next.version],
          )
          : await transaction.query(
            "insert into genio_one_policy_drafts (tenant_id, policy_key, value, last_version) values ($1, $2, $3::text::jsonb, $4)",
            [tenantId, key, JSON.stringify(next), next.version],
          )
        if (stored.rowCount !== 1) conflict()
        await recordPolicyDraftAudit({
          audit: options.audit,
          transaction,
          tenantId,
          policyKey: key,
          draft: next,
          action: "DRAFT_SAVED",
          context: mutation,
        })
        return next
      })
    },
    async validate(tenantId, key, input) {
      return sql.transaction(async (transaction) => {
        await lockDraft(transaction, tenantId, key)
        const current = await selectDraft(transaction, tenantId, key)
        if (!current.draft) conflict()
        const mutation = policyDraftMutationContext(input.context, now)
        const next = validateDraft(current.draft, input, mutation)
        if (current.draft.lifecycle === "DRAFT") {
          const stored = await transaction.query(
            "update genio_one_policy_drafts set value = $3::text::jsonb where tenant_id = $1 and policy_key = $2 and (value->>'version')::int = $4",
            [tenantId, key, JSON.stringify(next), input.expectedVersion],
          )
          if (stored.rowCount !== 1) conflict()
          await recordPolicyDraftAudit({
            audit: options.audit,
            transaction,
            tenantId,
            policyKey: key,
            draft: next,
            action: "VALIDATED",
            context: mutation,
          })
        }
        return next
      })
    },
    async review(tenantId, key, input) {
      return sql.transaction(async (transaction) => {
        await lockDraft(transaction, tenantId, key)
        const current = await selectDraft(transaction, tenantId, key)
        if (!current.draft) conflict()
        const mutation = policyDraftMutationContext(input.context, now)
        const distinctReviewer = current.draft.lifecycle === "VALIDATED"
          ? await requireDistinctReviewer(transaction, tenantId)
          : false
        const next = reviewDraft(
          current.draft,
          input,
          mutation,
          distinctReviewer,
        )
        if (current.draft.lifecycle === "VALIDATED") {
          const stored = await transaction.query(
            "update genio_one_policy_drafts set value = $3::text::jsonb where tenant_id = $1 and policy_key = $2 and (value->>'version')::int = $4",
            [tenantId, key, JSON.stringify(next), input.expectedVersion],
          )
          if (stored.rowCount !== 1) conflict()
          await recordPolicyDraftAudit({
            audit: options.audit,
            transaction,
            tenantId,
            policyKey: key,
            draft: next,
            action: "REVIEWED",
            context: mutation,
          })
        }
        return next
      })
    },
    async remove(tenantId, key, version, context) {
      return sql.transaction(async (transaction) => {
        await lockDraft(transaction, tenantId, key)
        const current = await selectDraft(transaction, tenantId, key)
        if (!current.draft || current.draft.version !== version) return false
        const mutation = policyDraftMutationContext(context, now)
        const removed = await transaction.query(
          "update genio_one_policy_drafts set value = 'null'::jsonb where tenant_id = $1 and policy_key = $2 and (value->>'version')::int = $3 returning policy_key",
          [tenantId, key, version],
        )
        if (removed.rowCount !== 1) conflict()
        await recordPolicyDraftAudit({
          audit: options.audit,
          transaction,
          tenantId,
          policyKey: key,
          draft: current.draft,
          action: "DISCARDED",
          context: mutation,
        })
        return true
      })
    },
    async getAuthoringSettings(tenantId) {
      const result = await sql.query<{ tenant_id: unknown; revision: unknown; require_distinct_reviewer: unknown; updated_at: unknown }>(
        `select tenant_id, revision, require_distinct_reviewer,
                extract(epoch from updated_at)::bigint as updated_at
           from genio_one_policy_authoring_settings
          where tenant_id = $1`,
        [tenantId],
      )
      if (!result.rows[0]) {
        return {
          tenant_id: tenantId,
          revision: 0,
          require_distinct_reviewer: defaultRequireDistinctReviewer,
          updated_at: now(),
        }
      }
      return mapAuthoringSettings(result.rows[0])
    },
    async saveAuthoringSettings(tenantId, value, context) {
      return sql.transaction(async (transaction) => {
        await transaction.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify(["policy-authoring-settings", tenantId])])
        const currentResult = await transaction.query<{ tenant_id: unknown; revision: unknown; require_distinct_reviewer: unknown; updated_at: unknown }>(
          `select tenant_id, revision, require_distinct_reviewer,
                  extract(epoch from updated_at)::bigint as updated_at
             from genio_one_policy_authoring_settings
            where tenant_id = $1
            for update`,
          [tenantId],
        )
        const current = currentResult.rows[0]
          ? mapAuthoringSettings(currentResult.rows[0])
          : {
              tenant_id: tenantId,
              revision: 0,
              require_distinct_reviewer: defaultRequireDistinctReviewer,
              updated_at: now(),
            }
        if (current.revision !== value.expected_revision) {
          throw new PlatformApiError("POLICY_AUTHORING_SETTINGS_CONFLICT", 409)
        }
        const nextResult = current.revision === 0
          ? await transaction.query<{ tenant_id: unknown; revision: unknown; require_distinct_reviewer: unknown; updated_at: unknown }>(
            `insert into genio_one_policy_authoring_settings
               (tenant_id, revision, require_distinct_reviewer, updated_at)
             values ($1, 1, $2, to_timestamp($3))
             returning tenant_id, revision, require_distinct_reviewer,
                       extract(epoch from updated_at)::bigint as updated_at`,
            [tenantId, value.require_distinct_reviewer, context.at],
          )
          : await transaction.query<{ tenant_id: unknown; revision: unknown; require_distinct_reviewer: unknown; updated_at: unknown }>(
            `update genio_one_policy_authoring_settings
                set revision = revision + 1,
                    require_distinct_reviewer = $3,
                    updated_at = to_timestamp($4)
              where tenant_id = $1 and revision = $2
              returning tenant_id, revision, require_distinct_reviewer,
                        extract(epoch from updated_at)::bigint as updated_at`,
            [tenantId, current.revision, value.require_distinct_reviewer, context.at],
          )
        const nextRow = nextResult.rows[0]
        if (!nextRow) throw new PlatformApiError("POLICY_AUTHORING_SETTINGS_CONFLICT", 409)
        const next = mapAuthoringSettings(nextRow)
        if (options.audit) {
          if (!options.audit.recordInTransaction) throw new PlatformApiError("POLICY_AUDIT_TRANSACTION_UNAVAILABLE", 500)
          await options.audit.recordInTransaction({
            transaction,
            tenantId,
            event: policyAuthoringSettingsAuditEvent({
              tenantId,
              revision: next.revision,
              previousRevision: current.revision,
              requireDistinctReviewer: next.require_distinct_reviewer,
              actorSubjectId: context.actorSubjectId ?? "system",
              correlationId: context.correlationId,
              occurredAt: context.at,
            }),
          })
        }
        return next
      })
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
