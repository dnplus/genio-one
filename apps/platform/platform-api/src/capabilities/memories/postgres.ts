import { createHash, randomUUID } from "node:crypto"

import type { SqlAdapter, SqlQueryResult, SqlTransaction } from "../../persistence/sql-adapter"
import { PlatformApiError } from "../errors"
import type { Principal } from "../tenancy-auth/contract"
import { lockAndAuthorizeSharedScope } from "./postgres-shared-access"
import type {
  MemoryScope,
  PersonalMemoryAgentGrant,
  SharedMemory,
  SharedMemoryCorrectionProposal,
  SharedMemoryCorrectionProposalReviewResult,
  SharedMemoryContext,
  SharedMemoryDeletion,
  SharedMemoryKind,
  SharedMemoryMutationMetadata,
  SharedMemoryScope,
  SharedMemorySource,
} from "./contract"
import {
  normalizeSharedMemoryContext,
  normalizeSharedMemoryTarget,
  sharedMemoryTargetKey,
  type ActivePersonalMemoryAgentRepository,
  type AuthorizedSharedMemoryRepository,
  type AuthorizedSharedMemoryScope,
  type SharedMemoryCorrectionProposalCreateInput,
  type SharedMemoryCorrectionProposalListInput,
  type SharedMemoryCorrectionProposalReviewInput,
  type SharedMemoryDeleteInput,
  type SharedMemoryListInput,
  type SharedMemoryRepository,
  type SharedMemoryScopeTarget,
  type SharedMemoryWriteInput,
} from "./module"
import type {
  SharedMemoryScopePermission,
  SharedMemoryScopeSelector,
} from "./shared-scope-access"

type Row = Record<string, unknown>
type QueryExecutor = Pick<SqlAdapter, "query">

const MEMORY_COLUMNS = `
  memory_id, tenant_id, scope, owner_subject_id, team_id, organization_id,
  memory_key, kind, context_kind, context_id, content, assertion_origin,
  source_actor_subject_id, source_client_id, source_agent_id,
  source_agent_grant_id, source_reference_id, confirmed_at, revision, created_at, updated_at`

const GRANT_COLUMNS = `
  tenant_id, owner_subject_id, agent_id, grant_id, enabled_at, revoked_at`

const PROPOSAL_COLUMNS = `
  proposal_id, tenant_id, memory_id, scope, owner_subject_id, team_id, organization_id,
  base_revision, proposed_kind, proposed_content, source_actor_subject_id,
  source_client_id, source_agent_id, source_agent_grant_id, source_reference_id,
  status, reviewer_subject_id, created_at, resolved_at`

interface BoundSharedScope {
  actor: Principal
  target: SharedMemoryScopeTarget
  canManage: boolean
  permission: SharedMemoryScopePermission
}

function text(row: Row, key: string): string {
  const value = row[key]
  if (typeof value !== "string" || !value.trim()) throw new PlatformApiError("MEMORY_DATA_INVALID", 500)
  return value
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key]
  if (value === null || value === undefined) return null
  if (typeof value !== "string" || !value.trim()) throw new PlatformApiError("MEMORY_DATA_INVALID", 500)
  return value
}

function integer(row: Row, key: string): number {
  const parsed = Number(row[key])
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new PlatformApiError("MEMORY_DATA_INVALID", 500)
  return parsed
}

function scope(value: string): SharedMemoryScope {
  if (value === "PERSONAL" || value === "TEAM" || value === "ORGANIZATION") return value
  throw new PlatformApiError("MEMORY_DATA_INVALID", 500)
}

function kind(value: string): SharedMemoryKind {
  if (value === "preference" || value === "fact" || value === "decision") return value
  throw new PlatformApiError("MEMORY_DATA_INVALID", 500)
}

function assertionOrigin(value: string): SharedMemory["assertion_origin"] {
  if (value === "USER_EXPLICIT" || value === "AGENT_INFERRED") return value
  throw new PlatformApiError("MEMORY_DATA_INVALID", 500)
}

function memory(row: Row): SharedMemory {
  const scopeValue = scope(text(row, "scope"))
  const target = {
    scope: scopeValue,
    ownerSubjectId: nullableText(row, "owner_subject_id"),
    teamId: nullableText(row, "team_id"),
    organizationId: nullableText(row, "organization_id"),
  }
  try {
    normalizeSharedMemoryTarget(target)
  } catch {
    throw new PlatformApiError("MEMORY_DATA_INVALID", 500)
  }
  const context = {
    kind: text(row, "context_kind"),
    context_id: nullableText(row, "context_id"),
  }
  let normalizedContext: SharedMemoryContext
  try {
    normalizedContext = normalizeSharedMemoryContext(context)
  } catch {
    throw new PlatformApiError("MEMORY_DATA_INVALID", 500)
  }
  const source: SharedMemorySource = {
    actor_subject_id: text(row, "source_actor_subject_id"),
    client_id: text(row, "source_client_id"),
    agent_id: nullableText(row, "source_agent_id"),
    agent_grant_id: nullableText(row, "source_agent_grant_id"),
    reference_id: nullableText(row, "source_reference_id"),
  }
  if ((source.agent_id === null) !== (source.agent_grant_id === null)) {
    throw new PlatformApiError("MEMORY_DATA_INVALID", 500)
  }
  const revision = integer(row, "revision")
  if (revision < 1) throw new PlatformApiError("MEMORY_DATA_INVALID", 500)
  const createdAt = integer(row, "created_at")
  const updatedAt = integer(row, "updated_at")
  if (updatedAt < createdAt) throw new PlatformApiError("MEMORY_DATA_INVALID", 500)
  const confirmedAt = row.confirmed_at === null || row.confirmed_at === undefined
    ? null
    : integer(row, "confirmed_at")
  if (confirmedAt !== null && (scopeValue === "PERSONAL" || confirmedAt < createdAt || confirmedAt !== updatedAt)) {
    throw new PlatformApiError("MEMORY_DATA_INVALID", 500)
  }
  return {
    memory_id: text(row, "memory_id"),
    tenant_id: text(row, "tenant_id"),
    scope: scopeValue,
    owner_subject_id: target.ownerSubjectId,
    team_id: target.teamId,
    organization_id: target.organizationId,
    key: text(row, "memory_key"),
    kind: kind(text(row, "kind")),
    context: normalizedContext,
    content: text(row, "content"),
    assertion_origin: assertionOrigin(text(row, "assertion_origin")),
    source,
    confirmation: confirmedAt === null ? null : { confirmed: true, reviewed_at: confirmedAt },
    revision,
    created_at: createdAt,
    updated_at: updatedAt,
  }
}

function grant(row: Row): PersonalMemoryAgentGrant {
  const enabledAt = integer(row, "enabled_at")
  const revokedAt = row.revoked_at === null || row.revoked_at === undefined
    ? null
    : integer(row, "revoked_at")
  if (revokedAt !== null && revokedAt < enabledAt) throw new PlatformApiError("MEMORY_DATA_INVALID", 500)
  return {
    tenant_id: text(row, "tenant_id"),
    owner_subject_id: text(row, "owner_subject_id"),
    agent_id: text(row, "agent_id"),
    grant_id: text(row, "grant_id"),
    enabled_at: enabledAt,
    revoked_at: revokedAt,
  }
}

function proposalStatus(value: string): SharedMemoryCorrectionProposal["status"] {
  if (value === "PENDING" || value === "ACCEPTED" || value === "REJECTED" || value === "STALE") return value
  throw new PlatformApiError("MEMORY_DATA_INVALID", 500)
}

function correctionProposal(row: Row): SharedMemoryCorrectionProposal {
  const scopeValue = scope(text(row, "scope"))
  const target = {
    scope: scopeValue,
    ownerSubjectId: nullableText(row, "owner_subject_id"),
    teamId: nullableText(row, "team_id"),
    organizationId: nullableText(row, "organization_id"),
  }
  try {
    normalizeSharedMemoryTarget(target)
  } catch {
    throw new PlatformApiError("MEMORY_DATA_INVALID", 500)
  }
  const source: SharedMemorySource = {
    actor_subject_id: text(row, "source_actor_subject_id"),
    client_id: text(row, "source_client_id"),
    agent_id: nullableText(row, "source_agent_id"),
    agent_grant_id: nullableText(row, "source_agent_grant_id"),
    reference_id: nullableText(row, "source_reference_id"),
  }
  if ((source.agent_id === null) !== (source.agent_grant_id === null)) {
    throw new PlatformApiError("MEMORY_DATA_INVALID", 500)
  }
  const baseRevision = integer(row, "base_revision")
  if (baseRevision < 1) throw new PlatformApiError("MEMORY_DATA_INVALID", 500)
  const status = proposalStatus(text(row, "status"))
  const proposedContent = nullableText(row, "proposed_content")
  const reviewerSubjectId = nullableText(row, "reviewer_subject_id")
  const createdAt = integer(row, "created_at")
  const resolvedAt = row.resolved_at === null || row.resolved_at === undefined
    ? null
    : integer(row, "resolved_at")
  if (
    (status === "PENDING" && (proposedContent === null || reviewerSubjectId !== null || resolvedAt !== null)) ||
    ((status === "ACCEPTED" || status === "REJECTED") &&
      (proposedContent !== null || reviewerSubjectId === null || resolvedAt === null || resolvedAt < createdAt)) ||
    (status === "STALE" &&
      (proposedContent !== null || reviewerSubjectId !== null || resolvedAt === null || resolvedAt < createdAt))
  ) {
    throw new PlatformApiError("MEMORY_DATA_INVALID", 500)
  }
  return {
    proposal_id: text(row, "proposal_id"),
    tenant_id: text(row, "tenant_id"),
    memory_id: text(row, "memory_id"),
    scope: scopeValue,
    owner_subject_id: target.ownerSubjectId,
    team_id: target.teamId,
    organization_id: target.organizationId,
    base_revision: baseRevision,
    proposed_kind: kind(text(row, "proposed_kind")),
    proposed_content: proposedContent,
    source,
    status,
    reviewer_subject_id: reviewerSubjectId,
    created_at: createdAt,
    resolved_at: resolvedAt,
  }
}

function contextKey(context: SharedMemoryContext): string {
  return JSON.stringify([context.kind, context.context_id])
}

function assertPersonalActor(target: SharedMemoryScopeTarget, actorSubjectId: string): void {
  if (target.scope === "PERSONAL" && target.ownerSubjectId !== actorSubjectId) {
    throw new PlatformApiError("MEMORY_OWNER_REQUIRED", 403)
  }
}

function sameTarget(left: SharedMemoryScopeTarget, right: SharedMemoryScopeTarget): boolean {
  return left.scope === right.scope &&
    left.ownerSubjectId === right.ownerSubjectId &&
    left.teamId === right.teamId &&
    left.organizationId === right.organizationId
}

function scopedTarget(input: {
  target: SharedMemoryScopeTarget
  boundScope: BoundSharedScope | null
  actorSubjectId?: string
}): SharedMemoryScopeTarget {
  const target = normalizeSharedMemoryTarget(input.target)
  if (!input.boundScope) {
    if (target.scope !== "PERSONAL") throw new PlatformApiError("SHARED_MEMORY_SCOPE_ACCESS_REQUIRED", 403)
    if (input.actorSubjectId !== undefined) assertPersonalActor(target, input.actorSubjectId)
    return target
  }
  if (!sameTarget(target, input.boundScope.target)) {
    throw new PlatformApiError("SHARED_MEMORY_SCOPE_ACCESS_REQUIRED", 403)
  }
  if (input.actorSubjectId !== undefined && input.actorSubjectId !== input.boundScope.actor.subject_id) {
    throw new PlatformApiError("MEMORY_SOURCE_ACTOR_INVALID", 403)
  }
  return target
}

function requireScopePermission(
  boundScope: BoundSharedScope | null,
  permission: "CONTRIBUTE" | "MANAGE",
): void {
  if (!boundScope) return
  if (permission === "CONTRIBUTE" && boundScope.permission === "READ") {
    throw new PlatformApiError("SHARED_MEMORY_SCOPE_ACCESS_REQUIRED", 403)
  }
  if (permission === "MANAGE" && !boundScope.canManage) {
    throw new PlatformApiError("SHARED_MEMORY_SCOPE_ACCESS_REQUIRED", 403)
  }
}

function proposalMutationDigest(proposalId: string, kind: "idempotency" | "request"): string {
  return createHash("sha256")
    .update(`genio-one-shared-memory-proposal/${kind}/v1`)
    .update("\u0000")
    .update(proposalId)
    .digest("hex")
}

function transactionAdapter(transaction: SqlTransaction): SqlAdapter {
  return {
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
      statement: string,
      parameters?: readonly unknown[],
    ): Promise<SqlQueryResult<Row>> {
      return transaction.query<Row>(statement, parameters)
    },
    async transaction<T>(work: (nestedTransaction: SqlTransaction) => Promise<T>): Promise<T> {
      return work(transaction)
    },
  }
}

function assertTarget(memoryValue: SharedMemory, target: SharedMemoryScopeTarget): void {
  if (
    memoryValue.scope !== target.scope ||
    memoryValue.owner_subject_id !== target.ownerSubjectId ||
    memoryValue.team_id !== target.teamId ||
    memoryValue.organization_id !== target.organizationId
  ) {
    throw new PlatformApiError("MEMORY_DATA_INVALID", 500)
  }
}

interface StoredMutation {
  memoryId: string
  scope: SharedMemoryScope
  ownerSubjectId: string | null
  operation: SharedMemoryMutationMetadata["operation"]
  revision: number
  occurredAt: number
  requestDigest: string
}

function storedMutation(row: Row): StoredMutation {
  const operation = text(row, "operation")
  if (operation !== "CREATED" && operation !== "REPLACED" && operation !== "DELETED") {
    throw new PlatformApiError("MEMORY_DATA_INVALID", 500)
  }
  return {
    memoryId: text(row, "memory_id"),
    scope: scope(text(row, "scope")),
    ownerSubjectId: nullableText(row, "owner_subject_id"),
    operation,
    revision: integer(row, "revision"),
    occurredAt: integer(row, "occurred_at"),
    requestDigest: text(row, "request_digest"),
  }
}

async function lock(executor: QueryExecutor, key: string): Promise<void> {
  await executor.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [key])
}

async function findMutation(input: {
  executor: QueryExecutor
  tenantId: string
  target: SharedMemoryScopeTarget
  idempotencyKeyDigest: string
}): Promise<StoredMutation | null> {
  const result = await input.executor.query<Row>(
    `select memory_id, scope, owner_subject_id, operation, revision, occurred_at, request_digest
       from genio_one_shared_memory_mutations
      where tenant_id = $1 and scope_target_key = $2 and idempotency_key_digest = $3`,
    [input.tenantId, sharedMemoryTargetKey(input.target), input.idempotencyKeyDigest],
  )
  return result.rows[0] ? storedMutation(result.rows[0]) : null
}

async function findCorrectionProposalByIdempotency(input: {
  executor: QueryExecutor
  tenantId: string
  target: SharedMemoryScopeTarget
  idempotencyKeyDigest: string
}): Promise<{ proposal: SharedMemoryCorrectionProposal; requestDigest: string } | null> {
  const result = await input.executor.query<Row>(
    `select ${PROPOSAL_COLUMNS}, request_digest
       from genio_one_shared_memory_correction_proposals
      where tenant_id = $1 and scope_target_key = $2 and idempotency_key_digest = $3`,
    [input.tenantId, sharedMemoryTargetKey(input.target), input.idempotencyKeyDigest],
  )
  const row = result.rows[0]
  if (!row) return null
  return {
    proposal: correctionProposal(row),
    requestDigest: text(row, "request_digest"),
  }
}

async function findCorrectionProposal(input: {
  executor: QueryExecutor
  tenantId: string
  target: SharedMemoryScopeTarget
  memoryId: string
  proposalId: string
  forUpdate?: boolean
}): Promise<SharedMemoryCorrectionProposal | null> {
  const result = await input.executor.query<Row>(
    `select ${PROPOSAL_COLUMNS}
       from genio_one_shared_memory_correction_proposals
      where tenant_id = $1 and scope_target_key = $2 and memory_id = $3 and proposal_id = $4${input.forUpdate ? " for update" : ""}`,
    [
      input.tenantId,
      sharedMemoryTargetKey(input.target),
      input.memoryId,
      input.proposalId,
    ],
  )
  const row = result.rows[0]
  if (!row) return null
  const value = correctionProposal(row)
  if (!sameTarget({
    scope: value.scope,
    ownerSubjectId: value.owner_subject_id,
    teamId: value.team_id,
    organizationId: value.organization_id,
  }, input.target)) {
    throw new PlatformApiError("MEMORY_DATA_INVALID", 500)
  }
  return value
}

async function findMemory(input: {
  executor: QueryExecutor
  tenantId: string
  target: SharedMemoryScopeTarget
  memoryId: string
  forUpdate?: boolean
}): Promise<SharedMemory | null> {
  const result = await input.executor.query<Row>(
    `select ${MEMORY_COLUMNS}
       from genio_one_shared_memories
      where tenant_id = $1 and scope_target_key = $2 and memory_id = $3${input.forUpdate ? " for update" : ""}`,
    [input.tenantId, sharedMemoryTargetKey(input.target), input.memoryId],
  )
  if (!result.rows[0]) return null
  const value = memory(result.rows[0])
  assertTarget(value, input.target)
  return value
}

async function appendMutation(input: {
  transaction: SqlTransaction
  tenantId: string
  target: SharedMemoryScopeTarget
  memoryId: string
  mutationId: string
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
  occurredAt: number
}): Promise<void> {
  await input.transaction.query(
    `insert into genio_one_shared_memory_mutations
      (tenant_id, mutation_id, scope_target_key, memory_id, scope, owner_subject_id,
       team_id, organization_id, actor_subject_id, client_id, agent_id, agent_grant_id,
       operation, previous_revision, revision, assertion_origin, occurred_at,
       idempotency_key_digest, request_digest, reviewer_subject_id, reviewer_client_id,
       reviewed_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
    [
      input.tenantId,
      input.mutationId,
      sharedMemoryTargetKey(input.target),
      input.memoryId,
      input.target.scope,
      input.target.ownerSubjectId,
      input.target.teamId,
      input.target.organizationId,
      input.actorSubjectId,
      input.clientId,
      input.agentId,
      input.agentGrantId,
      input.operation,
      input.previousRevision,
      input.revision,
      input.assertionOrigin,
      input.occurredAt,
      input.idempotencyKeyDigest,
      input.requestDigest,
      input.confirmation?.reviewer_subject_id ?? null,
      input.confirmation?.reviewer_client_id ?? null,
      input.confirmation?.reviewed_at ?? null,
    ],
  )
}

async function stalePendingCorrectionProposals(input: {
  transaction: SqlTransaction
  tenantId: string
  target: SharedMemoryScopeTarget
  memoryId: string
  resolvedAt: number
  exceptProposalId?: string
}): Promise<void> {
  await input.transaction.query(
    `update genio_one_shared_memory_correction_proposals
        set status = 'STALE', proposed_content = null, resolved_at = $4
      where tenant_id = $1 and scope_target_key = $2 and memory_id = $3
        and status = 'PENDING'
        and ($5::text is null or proposal_id <> $5)`,
    [
      input.tenantId,
      sharedMemoryTargetKey(input.target),
      input.memoryId,
      input.resolvedAt,
      input.exceptProposalId ?? null,
    ],
  )
}

function deletion(value: StoredMutation): SharedMemoryDeletion {
  return {
    memory_id: value.memoryId,
    scope: value.scope,
    owner_subject_id: value.ownerSubjectId,
    deleted_revision: value.revision,
    deleted_at: value.occurredAt,
  }
}

interface PostgresSharedMemoryRepositoryOptions {
  sql: SqlAdapter
  now?: () => number
  idFactory?: (prefix: string) => string
}

function createPostgresSharedMemoryRepositoryForScope(
  options: PostgresSharedMemoryRepositoryOptions,
  boundScope: BoundSharedScope | null,
): SharedMemoryRepository {
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000))
  const idFactory = options.idFactory ?? ((prefix: string) => `${prefix}-${randomUUID()}`)

  return {
    async enablePersonalAgent(input) {
      const lockKey = JSON.stringify([input.tenantId, input.ownerSubjectId, "personal-memory-agent", input.agentId])
      return options.sql.transaction(async (transaction) => {
        await lock(transaction, lockKey)
        const current = await transaction.query<Row>(
          `select ${GRANT_COLUMNS}
             from genio_one_personal_memory_agent_grants
            where tenant_id = $1 and owner_subject_id = $2 and agent_id = $3
            for update`,
          [input.tenantId, input.ownerSubjectId, input.agentId],
        )
        const existing = current.rows[0] ? grant(current.rows[0]) : null
        if (existing && existing.revoked_at === null) return existing
        const at = now()
        const result = await transaction.query<Row>(
          `insert into genio_one_personal_memory_agent_grants
             (tenant_id, owner_subject_id, agent_id, grant_id, enabled_at, revoked_at)
           values ($1,$2,$3,$4,$5,null)
           on conflict (tenant_id, owner_subject_id, agent_id)
           do update set grant_id = excluded.grant_id, enabled_at = excluded.enabled_at,
                         revoked_at = null
           returning ${GRANT_COLUMNS}`,
          [input.tenantId, input.ownerSubjectId, input.agentId, idFactory("memory-agent-grant"), at],
        )
        return grant(result.rows[0]!)
      })
    },
    async getPersonalAgent(input) {
      const result = await options.sql.query<Row>(
        `select ${GRANT_COLUMNS}
           from genio_one_personal_memory_agent_grants
          where tenant_id = $1 and owner_subject_id = $2 and agent_id = $3`,
        [input.tenantId, input.ownerSubjectId, input.agentId],
      )
      return result.rows[0] ? grant(result.rows[0]) : null
    },
    async listPersonalAgents(input) {
      const result = await options.sql.query<Row>(
        `select ${GRANT_COLUMNS}
           from genio_one_personal_memory_agent_grants
          where tenant_id = $1 and owner_subject_id = $2
            and ($3::bigint is null or enabled_at < $3
                 or (enabled_at = $3 and agent_id > $4))
          order by enabled_at desc, agent_id asc
          limit $5`,
        [
          input.tenantId,
          input.ownerSubjectId,
          input.position?.enabledAt ?? null,
          input.position?.agentId ?? null,
          input.limit,
        ],
      )
      return result.rows.map(grant)
    },
    async revokePersonalAgent(input) {
      const lockKey = JSON.stringify([input.tenantId, input.ownerSubjectId, "personal-memory-agent", input.agentId])
      return options.sql.transaction(async (transaction) => {
        await lock(transaction, lockKey)
        const current = await transaction.query<Row>(
          `select ${GRANT_COLUMNS}
             from genio_one_personal_memory_agent_grants
            where tenant_id = $1 and owner_subject_id = $2 and agent_id = $3
            for update`,
          [input.tenantId, input.ownerSubjectId, input.agentId],
        )
        const existing = current.rows[0] ? grant(current.rows[0]) : null
        if (!existing) throw new PlatformApiError("MEMORY_AGENT_GRANT_NOT_FOUND", 404)
        if (existing.revoked_at !== null) return existing
        const result = await transaction.query<Row>(
          `update genio_one_personal_memory_agent_grants
              set revoked_at = $4
            where tenant_id = $1 and owner_subject_id = $2 and agent_id = $3
            returning ${GRANT_COLUMNS}`,
          [input.tenantId, input.ownerSubjectId, input.agentId, now()],
        )
        return grant(result.rows[0]!)
      })
    },
    async activePersonalAgent(input) {
      const result = await options.sql.query<Row>(
        `select ${GRANT_COLUMNS}
           from genio_one_personal_memory_agent_grants
          where tenant_id = $1 and owner_subject_id = $2 and agent_id = $3
            and revoked_at is null`,
        [input.tenantId, input.ownerSubjectId, input.agentId],
      )
      return result.rows[0] ? grant(result.rows[0]) : null
    },
    async withActivePersonalAgent<T>(
      input: { tenantId: string; ownerSubjectId: string; agentId: string },
      operation: (grant: PersonalMemoryAgentGrant, activeRepository: ActivePersonalMemoryAgentRepository) => Promise<T>,
    ): Promise<T> {
      const lockKey = JSON.stringify([input.tenantId, input.ownerSubjectId, "personal-memory-agent", input.agentId])
      return options.sql.transaction(async (transaction) => {
        await lock(transaction, lockKey)
        const current = await transaction.query<Row>(
          `select ${GRANT_COLUMNS}
             from genio_one_personal_memory_agent_grants
            where tenant_id = $1 and owner_subject_id = $2 and agent_id = $3
              and revoked_at is null
            for update`,
          [input.tenantId, input.ownerSubjectId, input.agentId],
        )
        const existing = current.rows[0] ? grant(current.rows[0]) : null
        if (!existing) throw new PlatformApiError("MEMORY_AGENT_GRANT_INVALID", 403)
        const activeRepository: ActivePersonalMemoryAgentRepository = createPostgresSharedMemoryRepositoryForScope({
          sql: transactionAdapter(transaction),
          now,
          idFactory,
        }, boundScope) as ActivePersonalMemoryAgentRepository
        return operation(existing, activeRepository)
      })
    },
    async withAuthorizedSharedScope<T>(
      input: {
        actor: Principal
        selector: SharedMemoryScopeSelector
        permission: SharedMemoryScopePermission
      },
      operation: (
        scope: AuthorizedSharedMemoryScope,
        repository: AuthorizedSharedMemoryRepository,
      ) => Promise<T>,
    ): Promise<T> {
      return options.sql.transaction(async (transaction) => {
        const authorization = await lockAndAuthorizeSharedScope(
          transaction,
          input.actor,
          input.selector,
          input.permission,
        )
        const scope: AuthorizedSharedMemoryScope = {
          target: normalizeSharedMemoryTarget(authorization.target),
          canManage: authorization.canManage,
        }
        const repository = createPostgresSharedMemoryRepositoryForScope({
          sql: transactionAdapter(transaction),
          now,
          idFactory,
        }, {
          actor: input.actor,
          target: scope.target,
          canManage: scope.canManage,
          permission: input.permission,
        })
        return operation(scope, repository)
      })
    },
    async createCorrectionProposal(input: SharedMemoryCorrectionProposalCreateInput) {
      const target = scopedTarget({
        target: input.target,
        boundScope,
        actorSubjectId: input.source.actor_subject_id,
      })
      requireScopePermission(boundScope, "CONTRIBUTE")
      const targetKey = sharedMemoryTargetKey(target)
      return options.sql.transaction(async (transaction) => {
        await lock(transaction, targetKey)
        const prior = await findCorrectionProposalByIdempotency({
          executor: transaction,
          tenantId: input.tenantId,
          target,
          idempotencyKeyDigest: input.idempotencyKeyDigest,
        })
        if (prior) {
          if (prior.requestDigest !== input.requestDigest) {
            throw new PlatformApiError("MEMORY_IDEMPOTENCY_KEY_REUSED", 409)
          }
          return prior.proposal
        }
        const current = await findMemory({
          executor: transaction,
          tenantId: input.tenantId,
          target,
          memoryId: input.memoryId,
          forUpdate: true,
        })
        if (!current) throw new PlatformApiError("MEMORY_NOT_FOUND", 404)
        if (current.revision !== input.baseRevision) {
          throw new PlatformApiError("MEMORY_REVISION_CONFLICT", 409)
        }
        if (current.kind !== input.proposedKind) {
          throw new PlatformApiError("MEMORY_IDENTITY_IMMUTABLE", 409)
        }
        const at = now()
        const result = await transaction.query<Row>(
          `insert into genio_one_shared_memory_correction_proposals
            (tenant_id, proposal_id, memory_id, scope_target_key, scope, owner_subject_id,
             team_id, organization_id, base_revision, proposed_kind, proposed_content,
             source_actor_subject_id, source_client_id, source_agent_id,
             source_agent_grant_id, source_reference_id, idempotency_key_digest,
             request_digest, status, reviewer_subject_id, created_at, resolved_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
                   'PENDING',null,$19,null)
           returning ${PROPOSAL_COLUMNS}`,
          [
            input.tenantId,
            idFactory("memory-correction-proposal"),
            input.memoryId,
            targetKey,
            target.scope,
            target.ownerSubjectId,
            target.teamId,
            target.organizationId,
            input.baseRevision,
            input.proposedKind,
            input.proposedContent,
            input.source.actor_subject_id,
            input.source.client_id,
            input.source.agent_id,
            input.source.agent_grant_id,
            input.source.reference_id,
            input.idempotencyKeyDigest,
            input.requestDigest,
            at,
          ],
        )
        const row = result.rows[0]
        if (!row) throw new PlatformApiError("MEMORY_CORRECTION_PROPOSAL_CREATE_FAILED", 500)
        return correctionProposal(row)
      })
    },
    async listCorrectionProposals(input: SharedMemoryCorrectionProposalListInput) {
      const target = scopedTarget({ target: input.target, boundScope })
      const result = await options.sql.query<Row>(
        `select ${PROPOSAL_COLUMNS}
           from genio_one_shared_memory_correction_proposals
          where tenant_id = $1 and scope_target_key = $2 and memory_id = $3
            and ($4::text is null or status = $4)
            and ($5::bigint is null or created_at < $5
                 or (created_at = $5 and proposal_id > $6))
          order by created_at desc, proposal_id asc
          limit $7`,
        [
          input.tenantId,
          sharedMemoryTargetKey(target),
          input.memoryId,
          input.status,
          input.position?.createdAt ?? null,
          input.position?.proposalId ?? null,
          input.limit,
        ],
      )
      return result.rows.map((row) => {
        const value = correctionProposal(row)
        if (!sameTarget({
          scope: value.scope,
          ownerSubjectId: value.owner_subject_id,
          teamId: value.team_id,
          organizationId: value.organization_id,
        }, target)) {
          throw new PlatformApiError("MEMORY_DATA_INVALID", 500)
        }
        return value
      })
    },
    async reviewCorrectionProposal(input: SharedMemoryCorrectionProposalReviewInput): Promise<SharedMemoryCorrectionProposalReviewResult> {
      const target = scopedTarget({
        target: input.target,
        boundScope,
        actorSubjectId: input.reviewerSubjectId,
      })
      requireScopePermission(boundScope, "MANAGE")
      const targetKey = sharedMemoryTargetKey(target)
      return options.sql.transaction(async (transaction) => {
        await lock(transaction, targetKey)
        const proposal = await findCorrectionProposal({
          executor: transaction,
          tenantId: input.tenantId,
          target,
          memoryId: input.memoryId,
          proposalId: input.proposalId,
          forUpdate: true,
        })
        if (!proposal) throw new PlatformApiError("MEMORY_CORRECTION_PROPOSAL_NOT_FOUND", 404)
        if (proposal.status !== "PENDING") {
          throw new PlatformApiError("MEMORY_CORRECTION_PROPOSAL_NOT_PENDING", 409)
        }
        const current = await findMemory({
          executor: transaction,
          tenantId: input.tenantId,
          target,
          memoryId: input.memoryId,
          forUpdate: true,
        })
        if (!current) throw new PlatformApiError("MEMORY_NOT_FOUND", 404)
        const at = now()
        if (current.revision !== proposal.base_revision) {
          const stale = await transaction.query<Row>(
            `update genio_one_shared_memory_correction_proposals
                set status = 'STALE', proposed_content = null, resolved_at = $5
              where tenant_id = $1 and scope_target_key = $2 and memory_id = $3
                and proposal_id = $4 and status = 'PENDING'
              returning ${PROPOSAL_COLUMNS}`,
            [input.tenantId, targetKey, input.memoryId, input.proposalId, at],
          )
          const staleRow = stale.rows[0]
          if (!staleRow) throw new PlatformApiError("MEMORY_CORRECTION_PROPOSAL_NOT_PENDING", 409)
          await stalePendingCorrectionProposals({
            transaction,
            tenantId: input.tenantId,
            target,
            memoryId: input.memoryId,
            resolvedAt: at,
            exceptProposalId: input.proposalId,
          })
          return { proposal: correctionProposal(staleRow), memory: current }
        }
        if (input.action === "REJECT") {
          const rejected = await transaction.query<Row>(
            `update genio_one_shared_memory_correction_proposals
                set status = 'REJECTED', proposed_content = null, reviewer_subject_id = $5,
                    resolved_at = $6
              where tenant_id = $1 and scope_target_key = $2 and memory_id = $3
                and proposal_id = $4 and status = 'PENDING'
              returning ${PROPOSAL_COLUMNS}`,
            [input.tenantId, targetKey, input.memoryId, input.proposalId, input.reviewerSubjectId, at],
          )
          const rejectedRow = rejected.rows[0]
          if (!rejectedRow) throw new PlatformApiError("MEMORY_CORRECTION_PROPOSAL_NOT_PENDING", 409)
          return { proposal: correctionProposal(rejectedRow), memory: null }
        }
        if (input.action !== "ACCEPT") {
          throw new PlatformApiError("MEMORY_CORRECTION_PROPOSAL_ACTION_INVALID", 422)
        }
        if (proposal.proposed_content === null || proposal.proposed_kind !== current.kind) {
          throw new PlatformApiError("MEMORY_DATA_INVALID", 500)
        }
        const assertionOrigin = proposal.source.agent_id === null ? "USER_EXPLICIT" : "AGENT_INFERRED"
        const updated = await transaction.query<Row>(
          `update genio_one_shared_memories
              set content = $4, assertion_origin = $5,
                  source_actor_subject_id = $6, source_client_id = $7,
                  source_agent_id = $8, source_agent_grant_id = $9,
                  source_reference_id = $10, revision = revision + 1,
                  updated_at = $11, confirmed_at = $11
            where tenant_id = $1 and scope_target_key = $2 and memory_id = $3
              and revision = $12
            returning ${MEMORY_COLUMNS}`,
          [
            input.tenantId,
            targetKey,
            input.memoryId,
            proposal.proposed_content,
            assertionOrigin,
            proposal.source.actor_subject_id,
            proposal.source.client_id,
            proposal.source.agent_id,
            proposal.source.agent_grant_id,
            proposal.source.reference_id,
            at,
            proposal.base_revision,
          ],
        )
        const updatedRow = updated.rows[0]
        if (!updatedRow) throw new PlatformApiError("MEMORY_REVISION_CONFLICT", 409)
        const accepted = await transaction.query<Row>(
          `update genio_one_shared_memory_correction_proposals
              set status = 'ACCEPTED', proposed_content = null, reviewer_subject_id = $5,
                  resolved_at = $6
            where tenant_id = $1 and scope_target_key = $2 and memory_id = $3
              and proposal_id = $4 and status = 'PENDING'
            returning ${PROPOSAL_COLUMNS}`,
          [input.tenantId, targetKey, input.memoryId, input.proposalId, input.reviewerSubjectId, at],
        )
        const acceptedRow = accepted.rows[0]
        if (!acceptedRow) throw new PlatformApiError("MEMORY_CORRECTION_PROPOSAL_NOT_PENDING", 409)
        const updatedMemory = memory(updatedRow)
        await stalePendingCorrectionProposals({
          transaction,
          tenantId: input.tenantId,
          target,
          memoryId: input.memoryId,
          resolvedAt: at,
          exceptProposalId: input.proposalId,
        })
        await appendMutation({
          transaction,
          tenantId: input.tenantId,
          target,
          memoryId: updatedMemory.memory_id,
          mutationId: idFactory("memory-mutation"),
          idempotencyKeyDigest: proposalMutationDigest(input.proposalId, "idempotency"),
          requestDigest: proposalMutationDigest(input.proposalId, "request"),
          actorSubjectId: proposal.source.actor_subject_id,
          clientId: proposal.source.client_id,
          agentId: proposal.source.agent_id,
          agentGrantId: proposal.source.agent_grant_id,
          operation: "REPLACED",
          previousRevision: current.revision,
          revision: updatedMemory.revision,
          assertionOrigin,
          confirmation: {
            reviewer_subject_id: input.reviewerSubjectId,
            reviewer_client_id: input.reviewerClientId,
            reviewed_at: at,
          },
          occurredAt: at,
        })
        return { proposal: correctionProposal(acceptedRow), memory: updatedMemory }
      })
    },
    async listMemoryScopes(input: { actor: Principal }): Promise<MemoryScope[]> {
      return options.sql.transaction(async (transaction) => {
        const result: MemoryScope[] = [{
          target: { scope: "PERSONAL" },
          display_name: "Personal",
          can_read: true,
          can_contribute: true,
          can_manage: true,
        }]
        const organizationRows = await transaction.query<Row>(
          `select organization_id, display_name
             from genio_one_organizations
            where tenant_id = $1
            order by display_name asc, organization_id asc`,
          [input.actor.tenant_id],
        )
        for (const organization of organizationRows.rows) {
          const organizationId = text(organization, "organization_id")
          let access: Awaited<ReturnType<typeof lockAndAuthorizeSharedScope>>
          try {
            access = await lockAndAuthorizeSharedScope(transaction, input.actor, {
              scope: "ORGANIZATION",
              organization_id: organizationId,
            }, "READ")
          } catch (error) {
            if (error instanceof PlatformApiError && (
              error.code === "SHARED_MEMORY_SCOPE_ACCESS_REQUIRED" ||
              error.code === "SHARED_MEMORY_SCOPE_NOT_FOUND"
            )) continue
            throw error
          }
          let canContribute = true
          try {
            await lockAndAuthorizeSharedScope(transaction, input.actor, {
              scope: "ORGANIZATION",
              organization_id: organizationId,
            }, "CONTRIBUTE")
          } catch (error) {
            if (error instanceof PlatformApiError && error.code === "SHARED_MEMORY_SCOPE_ACCESS_REQUIRED") {
              canContribute = false
            } else {
              throw error
            }
          }
          result.push({
            target: { scope: "ORGANIZATION", organization_id: organizationId },
            display_name: text(organization, "display_name"),
            can_read: true,
            can_contribute: canContribute,
            can_manage: access.canManage,
          })
        }
        const workspaceRows = await transaction.query<Row>(
          `select workspace_id, display_name
             from genio_one_team_workspaces
            where tenant_id = $1
            order by display_name asc, workspace_id asc`,
          [input.actor.tenant_id],
        )
        for (const workspace of workspaceRows.rows) {
          const workspaceId = text(workspace, "workspace_id")
          let access: Awaited<ReturnType<typeof lockAndAuthorizeSharedScope>>
          try {
            access = await lockAndAuthorizeSharedScope(transaction, input.actor, {
              scope: "TEAM",
              workspace_id: workspaceId,
            }, "READ")
          } catch (error) {
            if (error instanceof PlatformApiError && (
              error.code === "SHARED_MEMORY_SCOPE_ACCESS_REQUIRED" ||
              error.code === "SHARED_MEMORY_SCOPE_NOT_FOUND"
            )) continue
            throw error
          }
          let canContribute = true
          try {
            await lockAndAuthorizeSharedScope(transaction, input.actor, {
              scope: "TEAM",
              workspace_id: workspaceId,
            }, "CONTRIBUTE")
          } catch (error) {
            if (error instanceof PlatformApiError && error.code === "SHARED_MEMORY_SCOPE_ACCESS_REQUIRED") {
              canContribute = false
            } else {
              throw error
            }
          }
          result.push({
            target: { scope: "TEAM", workspace_id: workspaceId },
            display_name: text(workspace, "display_name"),
            can_read: true,
            can_contribute: canContribute,
            can_manage: access.canManage,
          })
        }
        return result
      })
    },
    async remember(input: SharedMemoryWriteInput) {
      const target = scopedTarget({
        target: input.target,
        boundScope,
        actorSubjectId: input.source.actor_subject_id,
      })
      requireScopePermission(boundScope, input.memoryId === null ? "CONTRIBUTE" : "MANAGE")
      const targetKey = sharedMemoryTargetKey(target)
      return options.sql.transaction(async (transaction) => {
        await lock(transaction, targetKey)
        const prior = await findMutation({
          executor: transaction,
          tenantId: input.tenantId,
          target,
          idempotencyKeyDigest: input.idempotencyKeyDigest,
        })
        if (prior) {
          if (prior.requestDigest !== input.requestDigest) {
            throw new PlatformApiError("MEMORY_IDEMPOTENCY_KEY_REUSED", 409)
          }
          if (prior.operation === "DELETED") {
            throw new PlatformApiError("MEMORY_IDEMPOTENCY_OPERATION_MISMATCH", 409)
          }
          const existing = await findMemory({
            executor: transaction,
            tenantId: input.tenantId,
            target,
            memoryId: prior.memoryId,
          })
          if (!existing) throw new PlatformApiError("MEMORY_IDEMPOTENCY_TARGET_DELETED", 409)
          if (existing.revision !== prior.revision) {
            throw new PlatformApiError("MEMORY_IDEMPOTENCY_STATE_SUPERSEDED", 409)
          }
          return existing
        }
        const identityContextKey = contextKey(input.context)
        if (input.memoryId !== null) {
          const current = await findMemory({
            executor: transaction,
            tenantId: input.tenantId,
            target,
            memoryId: input.memoryId,
            forUpdate: true,
          })
          if (!current) throw new PlatformApiError("MEMORY_NOT_FOUND", 404)
          if (current.revision !== input.expectedRevision) throw new PlatformApiError("MEMORY_REVISION_CONFLICT", 409)
          if (
            current.key !== input.key ||
            current.kind !== input.kind ||
            current.context.kind !== input.context.kind ||
            current.context.context_id !== input.context.context_id
          ) {
            throw new PlatformApiError("MEMORY_IDENTITY_IMMUTABLE", 409)
          }
          if (input.assertionOrigin === "AGENT_INFERRED") {
            if (current.content !== input.content) throw new PlatformApiError("MEMORY_AGENT_INFERENCE_CONFLICT", 409)
            return current
          }
          const at = now()
          const result = await transaction.query<Row>(
            `update genio_one_shared_memories
                set content = $4, assertion_origin = $5,
                    source_actor_subject_id = $6, source_client_id = $7,
                    source_agent_id = $8, source_agent_grant_id = $9,
                    source_reference_id = $10, revision = revision + 1,
                    updated_at = $11, confirmed_at = null
              where tenant_id = $1 and scope_target_key = $2 and memory_id = $3
                and revision = $12
              returning ${MEMORY_COLUMNS}`,
            [
              input.tenantId,
              targetKey,
              input.memoryId,
              input.content,
              input.assertionOrigin,
              input.source.actor_subject_id,
              input.source.client_id,
              input.source.agent_id,
              input.source.agent_grant_id,
              input.source.reference_id,
              at,
              input.expectedRevision,
            ],
          )
          const updatedRow = result.rows[0]
          if (!updatedRow) throw new PlatformApiError("MEMORY_REVISION_CONFLICT", 409)
          const updated = memory(updatedRow)
          await stalePendingCorrectionProposals({
            transaction,
            tenantId: input.tenantId,
            target,
            memoryId: updated.memory_id,
            resolvedAt: at,
          })
          await appendMutation({
            transaction,
            tenantId: input.tenantId,
            target,
            memoryId: updated.memory_id,
            mutationId: idFactory("memory-mutation"),
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
            occurredAt: at,
          })
          return updated
        }
        if (input.expectedRevision !== 0) throw new PlatformApiError("MEMORY_EXPECTED_REVISION_INVALID", 422)
        if (input.assertionOrigin === "AGENT_INFERRED") {
          const logicalMatch = await transaction.query<Row>(
            `select memory_id
               from genio_one_shared_memories
              where tenant_id = $1 and scope_target_key = $2 and memory_key = $3
                and ($4 = 'PERSONAL' or kind = $5) and context_key = $6
              limit 1
              for update`,
            [input.tenantId, targetKey, input.key, target.scope, input.kind, identityContextKey],
          )
          if (logicalMatch.rows[0]) {
            throw new PlatformApiError("MEMORY_AGENT_INFERENCE_CONFLICT", 409)
          }
        }
        const existing = await transaction.query<Row>(
          `select ${MEMORY_COLUMNS}
             from genio_one_shared_memories
            where tenant_id = $1 and scope_target_key = $2 and memory_key = $3
              and kind = $4 and context_key = $5
            for update`,
          [input.tenantId, targetKey, input.key, input.kind, identityContextKey],
        )
        if (existing.rows[0]) {
          if (input.assertionOrigin === "AGENT_INFERRED") {
            throw new PlatformApiError("MEMORY_AGENT_INFERENCE_CONFLICT", 409)
          }
          throw new PlatformApiError("MEMORY_KEY_CONFLICT", 409)
        }
        const at = now()
        const result = await transaction.query<Row>(
          `insert into genio_one_shared_memories
            (tenant_id, memory_id, scope, scope_target_key, owner_subject_id, team_id,
             organization_id, memory_key, kind, context_kind, context_id, context_key,
             content, assertion_origin, source_actor_subject_id, source_client_id,
             source_agent_id, source_agent_grant_id, source_reference_id, revision,
             created_at, updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,1,$20,$20)
           returning ${MEMORY_COLUMNS}`,
          [
            input.tenantId,
            idFactory("memory"),
            target.scope,
            targetKey,
            target.ownerSubjectId,
            target.teamId,
            target.organizationId,
            input.key,
            input.kind,
            input.context.kind,
            input.context.context_id,
            identityContextKey,
            input.content,
            input.assertionOrigin,
            input.source.actor_subject_id,
            input.source.client_id,
            input.source.agent_id,
            input.source.agent_grant_id,
            input.source.reference_id,
            at,
          ],
        )
        const createdRow = result.rows[0]
        if (!createdRow) throw new PlatformApiError("MEMORY_CREATE_FAILED", 500)
        const created = memory(createdRow)
        await appendMutation({
          transaction,
          tenantId: input.tenantId,
          target,
          memoryId: created.memory_id,
          mutationId: idFactory("memory-mutation"),
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
          occurredAt: at,
        })
        return created
      })
    },
    async get(input) {
      const target = scopedTarget({ target: input.target, boundScope })
      return findMemory({
        executor: options.sql,
        tenantId: input.tenantId,
        target,
        memoryId: input.memoryId,
      })
    },
    async list(input: SharedMemoryListInput) {
      const target = scopedTarget({ target: input.target, boundScope })
      const contexts = input.contexts?.map(contextKey) ?? null
      const keys = input.keys ?? null
      const result = await options.sql.query<Row>(
        `select ${MEMORY_COLUMNS}
           from genio_one_shared_memories
          where tenant_id = $1 and scope_target_key = $2
            and ($3::text[] is null or context_key = any($3::text[]))
            and ($4::text[] is null or memory_key = any($4::text[]))
            and ($5::text is null or position(lower($5) in lower(memory_key)) > 0
                 or position(lower($5) in lower(content)) > 0)
            and ($6::bigint is null or updated_at < $6
                 or (updated_at = $6 and memory_id > $7))
          order by updated_at desc, memory_id asc
          limit $8`,
        [
          input.tenantId,
          sharedMemoryTargetKey(target),
          contexts,
          keys,
          input.query,
          input.position?.updatedAt ?? null,
          input.position?.memoryId ?? null,
          input.limit,
        ],
      )
      return result.rows.map((row) => {
        const value = memory(row)
        assertTarget(value, target)
        return value
      })
    },
    async delete(input: SharedMemoryDeleteInput) {
      const target = scopedTarget({
        target: input.target,
        boundScope,
        actorSubjectId: input.actorSubjectId,
      })
      requireScopePermission(boundScope, "MANAGE")
      const targetKey = sharedMemoryTargetKey(target)
      return options.sql.transaction(async (transaction) => {
        await lock(transaction, targetKey)
        const prior = await findMutation({
          executor: transaction,
          tenantId: input.tenantId,
          target,
          idempotencyKeyDigest: input.idempotencyKeyDigest,
        })
        if (prior) {
          if (prior.requestDigest !== input.requestDigest) {
            throw new PlatformApiError("MEMORY_IDEMPOTENCY_KEY_REUSED", 409)
          }
          if (prior.operation !== "DELETED") {
            throw new PlatformApiError("MEMORY_IDEMPOTENCY_OPERATION_MISMATCH", 409)
          }
          return deletion(prior)
        }
        const current = await findMemory({
          executor: transaction,
          tenantId: input.tenantId,
          target,
          memoryId: input.memoryId,
          forUpdate: true,
        })
        if (!current) throw new PlatformApiError("MEMORY_NOT_FOUND", 404)
        if (current.revision !== input.expectedRevision) throw new PlatformApiError("MEMORY_REVISION_CONFLICT", 409)
        const at = now()
        await stalePendingCorrectionProposals({
          transaction,
          tenantId: input.tenantId,
          target,
          memoryId: current.memory_id,
          resolvedAt: at,
        })
        const removed = await transaction.query<Row>(
          `delete from genio_one_shared_memories
            where tenant_id = $1 and scope_target_key = $2 and memory_id = $3
              and revision = $4
            returning memory_id`,
          [input.tenantId, targetKey, input.memoryId, input.expectedRevision],
        )
        if (!removed.rows[0]) throw new PlatformApiError("MEMORY_REVISION_CONFLICT", 409)
        await appendMutation({
          transaction,
          tenantId: input.tenantId,
          target,
          memoryId: current.memory_id,
          mutationId: idFactory("memory-mutation"),
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
          occurredAt: at,
        })
        return {
          memory_id: current.memory_id,
          scope: current.scope,
          owner_subject_id: current.owner_subject_id,
          deleted_revision: current.revision,
          deleted_at: at,
        }
      })
    },
  }
}

export function createPostgresSharedMemoryRepository(
  options: PostgresSharedMemoryRepositoryOptions,
): SharedMemoryRepository {
  return createPostgresSharedMemoryRepositoryForScope(options, null)
}
