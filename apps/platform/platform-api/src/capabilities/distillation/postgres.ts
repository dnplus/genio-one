import type { SqlAdapter, SqlTransaction } from "../../persistence/sql-adapter"
import { PlatformApiError } from "../errors"
import { hasSameImmutableDistillationMarkerPayload } from "./contract"
import type {
  CancelDistillationBot,
  ClaimedDistillationMarker,
  CreateDistillationMarker,
  DistillationMarker,
  KnowledgeCandidate,
} from "./contract"
import type { DistillationStore } from "./module"
import {
  LEASE_SECONDS,
  MAX_ATTEMPTS,
  candidateProvenance,
  completionErrors,
  completionTransition,
  decodeDistillationCursor,
  distillationPageLimit,
  normalizeDistillationMarker,
  requireWorkspaceName,
  toDistillationPage,
} from "./policy"

const WORKSPACE_ACL_VERSION = 1

type Row = Record<string, unknown>

const MARKER_COLUMNS = `tenant_id, marker_id, owner_subject_id, bot_id, thread_id, turn_ids,
  source_revision, content_digest, scope_hint, sensitivity, knowledge_type, representation,
  classifier_version, extractor_version, evidence, excerpt_truncated, history_state,
  processing_state, attempts, not_before, workspace_id, last_error, created_at, updated_at,
  lease_owner, lease_token, lease_until`

function text(row: Row, key: string): string {
  const value = row[key]
  return typeof value === "string" ? value : String(value ?? "")
}

function number(value: unknown): number {
  return typeof value === "number" ? value : Number(value)
}

function json<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T
}

function marker(row: Row): DistillationMarker {
  return {
    marker_id: text(row, "marker_id"),
    tenant_id: text(row, "tenant_id"),
    owner_subject_id: text(row, "owner_subject_id"),
    bot_id: text(row, "bot_id"),
    thread_id: text(row, "thread_id"),
    turn_ids: json<string[]>(row.turn_ids),
    source_revision: text(row, "source_revision"),
    content_digest: text(row, "content_digest"),
    scope_hint: text(row, "scope_hint") as DistillationMarker["scope_hint"],
    sensitivity: text(row, "sensitivity") as DistillationMarker["sensitivity"],
    knowledge_type: text(row, "knowledge_type") as DistillationMarker["knowledge_type"],
    representation: text(row, "representation") as DistillationMarker["representation"],
    classifier_version: text(row, "classifier_version") as DistillationMarker["classifier_version"],
    extractor_version: text(row, "extractor_version") as DistillationMarker["extractor_version"],
    evidence: json(row.evidence),
    excerpt_truncated: row.excerpt_truncated === true || row.excerpt_truncated === "true",
    history_state: text(row, "history_state") as DistillationMarker["history_state"],
    processing_state: text(row, "processing_state") as DistillationMarker["processing_state"],
    attempts: number(row.attempts),
    not_before: number(row.not_before),
    workspace_id: row.workspace_id == null ? null : text(row, "workspace_id"),
    last_error: row.last_error == null ? null : text(row, "last_error"),
    created_at: number(row.created_at),
    updated_at: number(row.updated_at),
  }
}

function candidate(row: Row): KnowledgeCandidate {
  return {
    knowledge_id: text(row, "knowledge_id"),
    tenant_id: text(row, "tenant_id"),
    marker_id: text(row, "marker_id"),
    owner_subject_id: text(row, "owner_subject_id"),
    workspace_id: row.workspace_id == null ? null : text(row, "workspace_id"),
    scope: text(row, "scope") as KnowledgeCandidate["scope"],
    knowledge_type: text(row, "knowledge_type") as KnowledgeCandidate["knowledge_type"],
    representation: text(row, "representation") as KnowledgeCandidate["representation"],
    sensitivity: text(row, "sensitivity") as KnowledgeCandidate["sensitivity"],
    review_state: text(row, "review_state") as KnowledgeCandidate["review_state"],
    content_digest: text(row, "content_digest"),
    provenance: json(row.provenance),
    reviewed_by: row.reviewed_by == null ? null : text(row, "reviewed_by"),
    reviewed_at: row.reviewed_at == null ? null : number(row.reviewed_at),
    created_at: number(row.created_at),
    updated_at: number(row.updated_at),
  }
}

const CANDIDATE_COLUMNS = `tenant_id, knowledge_id, marker_id, owner_subject_id, workspace_id,
  scope, knowledge_type, representation, sensitivity, review_state, content_digest, provenance,
  reviewed_by, reviewed_at, created_at, updated_at`

const WORKSPACE_COLUMNS = `tenant_id, workspace_id, organization_id, display_name, reader_access_group_id,
  contributor_access_group_id, maintainer_access_group_id, created_at, created_by`

function distillationBotLockKey(tenantId: string, ownerSubjectId: string, botId: string): string {
  return JSON.stringify(["distillation-bot", tenantId, ownerSubjectId, botId])
}

async function existingIdempotentMarker(
  transaction: SqlTransaction,
  tenantId: string,
  ownerSubjectId: string,
  value: CreateDistillationMarker,
  normalized: ReturnType<typeof normalizeDistillationMarker>,
): Promise<DistillationMarker | null> {
  const existing = await transaction.query<Row>(
    `select ${MARKER_COLUMNS} from genio_one_distillation_markers
      where tenant_id = $1 and owner_subject_id = $2 and bot_id = $3 and thread_id = $4
      and source_revision = $5
      for update`,
    [tenantId, ownerSubjectId, value.bot_id, value.thread_id, value.source_revision],
  )
  if (!existing.rows[0]) return null
  const existingMarker = marker(existing.rows[0])
  if (!hasSameImmutableDistillationMarkerPayload(existingMarker, value, normalized)) {
    throw new PlatformApiError("DISTILLATION_MARKER_CONFLICT", 409)
  }
  return existingMarker
}

async function lockDistillationBot(
  transaction: SqlTransaction,
  tenantId: string,
  ownerSubjectId: string,
  botId: string,
): Promise<void> {
  await transaction.query(
    "select pg_advisory_xact_lock(hashtext($1))",
    [distillationBotLockKey(tenantId, ownerSubjectId, botId)],
  )
}

export function createPostgresDistillationStore(options: {
  sql: SqlAdapter
  now?: () => number
  idFactory?: () => string
}): DistillationStore {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const idFactory = options.idFactory ?? (() => crypto.randomUUID())
  return {
    async createMarker({ tenantId, ownerSubjectId, value, contributorWorkspaceIds }) {
      if (new Set(value.turn_ids).size !== value.turn_ids.length) {
        throw new PlatformApiError("DISTILLATION_TURN_RANGE_INVALID", 422)
      }
      const normalized = normalizeDistillationMarker(value)
      const at = now()
      const markerId = `marker-${idFactory()}`
      return options.sql.transaction(async (transaction) => {
        await lockDistillationBot(transaction, tenantId, ownerSubjectId, value.bot_id)
        const deleted = await transaction.query<Row>(
          `select 1 from genio_one_distillation_bot_tombstones
            where tenant_id = $1 and owner_subject_id = $2 and bot_id = $3`,
          [tenantId, ownerSubjectId, value.bot_id],
        )
        if (deleted.rows[0]) throw new PlatformApiError("DISTILLATION_BOT_DELETED", 409)
        const existing = await existingIdempotentMarker(transaction, tenantId, ownerSubjectId, value, normalized)
        if (existing) return existing
        if (value.workspace_id) {
          const workspace = await transaction.query(
            `select workspace_id from genio_one_team_workspaces where tenant_id = $1 and workspace_id = $2`,
            [tenantId, value.workspace_id],
          )
          if (!workspace.rows[0]) throw new PlatformApiError("TEAM_WORKSPACE_NOT_FOUND", 422)
          if (!contributorWorkspaceIds.includes(value.workspace_id)) {
            throw new PlatformApiError("TEAM_WORKSPACE_CONTRIBUTOR_REQUIRED", 403)
          }
        }
        const inserted = await transaction.query<Row>(
          `insert into genio_one_distillation_markers
           (tenant_id, marker_id, owner_subject_id, bot_id, thread_id, turn_ids, source_revision,
            content_digest, scope_hint, sensitivity, knowledge_type, representation,
            classifier_version, extractor_version, evidence, excerpt_truncated, history_state,
            processing_state, attempts, not_before, workspace_id, workspace_acl_version, last_error, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6::text::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15::text::jsonb,$16,'READY','PENDING',0,$17,$18,$19,null,$17,$17)
         on conflict do nothing
         returning ${MARKER_COLUMNS}`,
          [
            tenantId, markerId, ownerSubjectId, value.bot_id, value.thread_id, JSON.stringify(value.turn_ids),
            value.source_revision, value.content_digest, normalized.scope_hint, normalized.sensitivity,
            normalized.knowledge_type, normalized.representation, value.classifier_version, value.extractor_version,
            JSON.stringify(value.evidence), value.excerpt_truncated, at, value.workspace_id ?? null,
            value.workspace_id == null ? 0 : WORKSPACE_ACL_VERSION,
          ],
        )
        if (inserted.rows[0]) return marker(inserted.rows[0])
        const conflicted = await existingIdempotentMarker(transaction, tenantId, ownerSubjectId, value, normalized)
        if (!conflicted) throw new PlatformApiError("DISTILLATION_MARKER_CONFLICT", 409)
        return conflicted
      })
    },
    async cancelBot({ tenantId, ownerSubjectId, botId }) {
      const at = now()
      return options.sql.transaction(async (transaction): Promise<CancelDistillationBot> => {
        await lockDistillationBot(transaction, tenantId, ownerSubjectId, botId)
        await transaction.query(
          `insert into genio_one_distillation_bot_tombstones
             (tenant_id, owner_subject_id, bot_id, deleted_at)
           values ($1, $2, $3, $4)
           on conflict (tenant_id, owner_subject_id, bot_id) do nothing`,
          [tenantId, ownerSubjectId, botId, at],
        )
        const cancelled = await transaction.query(
          `update genio_one_distillation_markers
              set processing_state = 'FAILED', last_error = 'BOT_DELETED', lease_owner = null,
                  lease_token = null, lease_until = null, updated_at = $4
            where tenant_id = $1 and owner_subject_id = $2 and bot_id = $3
              and processing_state in ('PENDING', 'WAITING_FOR_HISTORY', 'PROCESSING')`,
          [tenantId, ownerSubjectId, botId, at],
        )
        return { bot_id: botId, cancelled_count: cancelled.rowCount }
      })
    },
    async claim({ tenantId, ownerSubjectId, botId, leaseOwner }) {
      const at = now()
      return options.sql.transaction(async (transaction) => {
        await transaction.query(
          `update genio_one_distillation_markers
              set processing_state = 'FAILED', last_error = 'DISTILLATION_ATTEMPTS_EXHAUSTED', updated_at = $4
            where tenant_id = $1 and owner_subject_id = $2 and bot_id = $3
              and attempts >= $5
              and history_state = 'READY'
              and (
                processing_state = 'PENDING'
                or (processing_state = 'PROCESSING' and lease_until is not null and lease_until < $4)
              )`,
          [tenantId, ownerSubjectId, botId, at, MAX_ATTEMPTS],
        )
        const picked = await transaction.query<Row>(
          `select marker_id from genio_one_distillation_markers
            where tenant_id = $1 and owner_subject_id = $2 and bot_id = $3
              and (lease_until is null or lease_until < $4)
              and (
                (
                  processing_state in ('PENDING', 'WAITING_FOR_HISTORY')
                  and not_before <= $4
                )
                or (processing_state = 'PROCESSING' and lease_until is not null and lease_until < $4)
              )
            order by not_before asc, created_at asc
            for update skip locked
            limit 1`,
          [tenantId, ownerSubjectId, botId, at],
        )
        const markerId = picked.rows[0] ? text(picked.rows[0], "marker_id") : ""
        if (!markerId) return null
        const leaseToken = `lease-${idFactory()}`
        const updated = await transaction.query<Row>(
          `update genio_one_distillation_markers
              set processing_state = 'PROCESSING',
                  attempts = attempts + case when history_state = 'WAITING_FOR_HISTORY' then 0 else 1 end,
                  lease_owner = $4,
                  lease_token = $5, lease_until = $6, updated_at = $7
            where tenant_id = $1 and marker_id = $2 and owner_subject_id = $3
            returning ${MARKER_COLUMNS}`,
          [tenantId, markerId, ownerSubjectId, leaseOwner, leaseToken, at + LEASE_SECONDS, at],
        )
        const row = updated.rows[0]
        if (!row) return null
        return { ...marker(row), lease_token: text(row, "lease_token") } satisfies ClaimedDistillationMarker
      })
    },
    async complete({ tenantId, ownerSubjectId, markerId, value }) {
      return options.sql.transaction(async (transaction) => {
        const target = await transaction.query<Row>(
          `select bot_id from genio_one_distillation_markers
            where tenant_id = $1 and marker_id = $2 and owner_subject_id = $3`,
          [tenantId, markerId, ownerSubjectId],
        )
        const targetRow = target.rows[0]
        if (!targetRow) throw new PlatformApiError("DISTILLATION_MARKER_NOT_FOUND", 404)
        await lockDistillationBot(transaction, tenantId, ownerSubjectId, text(targetRow, "bot_id"))
        const at = now()
        const current = await transaction.query<Row>(
          `select ${MARKER_COLUMNS} from genio_one_distillation_markers
            where tenant_id = $1 and marker_id = $2 and owner_subject_id = $3
            for update`,
          [tenantId, markerId, ownerSubjectId],
        )
        const row = current.rows[0]
        if (!row) throw new PlatformApiError("DISTILLATION_MARKER_NOT_FOUND", 404)
        const currentMarker = marker(row)
        if (
          currentMarker.processing_state === "CANDIDATE_CREATED" &&
          value.outcome === "CANDIDATE_CREATED" &&
          text(row, "lease_token") === value.lease_token &&
          value.content_digest === currentMarker.content_digest
        ) {
          const existing = await transaction.query<Row>(
            `select ${CANDIDATE_COLUMNS} from genio_one_knowledge_candidates
              where tenant_id = $1 and marker_id = $2`,
            [tenantId, markerId],
          )
          return { marker: currentMarker, candidate: existing.rows[0] ? candidate(existing.rows[0]) : null }
        }
        const { waitingError, failedError } = completionErrors(value)
        if (
          currentMarker.processing_state === "WAITING_FOR_HISTORY" &&
          value.outcome === "WAITING_FOR_HISTORY" &&
          text(row, "lease_token") === value.lease_token &&
          currentMarker.last_error === waitingError
        ) {
          return { marker: currentMarker, candidate: null }
        }
        if (
          currentMarker.processing_state === "FAILED" &&
          value.outcome === "FAILED" &&
          text(row, "lease_token") === value.lease_token &&
          currentMarker.last_error === failedError
        ) {
          return { marker: currentMarker, candidate: null }
        }
        const leaseUntil = row.lease_until == null ? null : number(row.lease_until)
        if (currentMarker.processing_state !== "PROCESSING" || text(row, "lease_token") !== value.lease_token || leaseUntil === null || leaseUntil < at) {
          throw new PlatformApiError("DISTILLATION_LEASE_CONFLICT", 409)
        }
        if (value.outcome === "CANDIDATE_CREATED" && value.content_digest !== currentMarker.content_digest) {
          throw new PlatformApiError("DISTILLATION_DIGEST_MISMATCH", 409)
        }
        const next = completionTransition(currentMarker, value, at)
        const updated = await transaction.query<Row>(
          `update genio_one_distillation_markers
              set processing_state = $4, history_state = $5, not_before = $6, last_error = $7,
                  lease_owner = null, lease_until = null, updated_at = $8
            where tenant_id = $1 and marker_id = $2 and owner_subject_id = $3
            returning ${MARKER_COLUMNS}`,
          [tenantId, markerId, ownerSubjectId, next.processing_state, next.history_state, next.not_before, next.last_error, at],
        )
        const saved = marker(updated.rows[0]!)
        if (value.outcome !== "CANDIDATE_CREATED") return { marker: saved, candidate: null }
        const knowledgeId = `knowledge-${idFactory()}`
        const provenance = candidateProvenance(saved)
        const inserted = await transaction.query<Row>(
          `insert into genio_one_knowledge_candidates
             (tenant_id, knowledge_id, marker_id, owner_subject_id, workspace_id, scope, knowledge_type,
              representation, sensitivity, review_state, content_digest, provenance, reviewed_by,
              reviewed_at, created_at, updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING_REVIEW',$10,$11::text::jsonb,null,null,$12,$12)
           on conflict (tenant_id, marker_id) do update set updated_at = genio_one_knowledge_candidates.updated_at
           returning ${CANDIDATE_COLUMNS}`,
          [
            tenantId, knowledgeId, markerId, ownerSubjectId, saved.workspace_id, saved.scope_hint,
            saved.knowledge_type, saved.representation, saved.sensitivity, saved.content_digest,
            JSON.stringify(provenance), at,
          ],
        )
        return { marker: saved, candidate: candidate(inserted.rows[0]!) }
      })
    },
    async getMarker({ tenantId, ownerSubjectId, markerId }) {
      const result = await options.sql.query<Row>(
        `select ${MARKER_COLUMNS} from genio_one_distillation_markers
          where tenant_id = $1 and marker_id = $2 and owner_subject_id = $3`,
        [tenantId, markerId, ownerSubjectId],
      )
      const row = result.rows[0]
      if (!row) throw new PlatformApiError("DISTILLATION_MARKER_NOT_FOUND", 404)
      return marker(row)
    },
    async listMarkers({ tenantId, ownerSubjectId, limit, cursor }) {
      const pageLimit = distillationPageLimit(limit)
      const position = decodeDistillationCursor(cursor)
      const result = await options.sql.query<Row>(
        `select ${MARKER_COLUMNS} from genio_one_distillation_markers
          where tenant_id = $1 and owner_subject_id = $2
            and ($3::bigint is null or created_at < $3 or (created_at = $3 and marker_id > $4))
          order by created_at desc, marker_id asc
          limit $5`,
        [tenantId, ownerSubjectId, position?.created_at ?? null, position?.id ?? "", pageLimit + 1],
      )
      const { items, next_cursor } = toDistillationPage(result.rows.map(marker), pageLimit, (row) => row.marker_id)
      return { markers: items, next_cursor }
    },
    async listCandidates({ tenantId, ownerSubjectId, workspaceIds, limit, cursor }) {
      const pageLimit = distillationPageLimit(limit)
      const position = decodeDistillationCursor(cursor)
      const result = await options.sql.query<Row>(
        `select ${CANDIDATE_COLUMNS} from genio_one_knowledge_candidates
          where tenant_id = $1 and (owner_subject_id = $2 or workspace_id = any($3::text[]))
            and ($4::bigint is null or created_at < $4 or (created_at = $4 and knowledge_id > $5))
          order by created_at desc, knowledge_id asc
          limit $6`,
        [tenantId, ownerSubjectId, workspaceIds, position?.created_at ?? null, position?.id ?? "", pageLimit + 1],
      )
      const { items, next_cursor } = toDistillationPage(result.rows.map(candidate), pageLimit, (row) => row.knowledge_id)
      return { candidates: items, next_cursor }
    },
    async getCandidate({ tenantId, knowledgeId }) {
      const result = await options.sql.query<Row>(
        `select ${CANDIDATE_COLUMNS} from genio_one_knowledge_candidates
          where tenant_id = $1 and knowledge_id = $2`,
        [tenantId, knowledgeId],
      )
      return result.rows[0] ? candidate(result.rows[0]) : null
    },
    async createWorkspace({ tenantId, createdBy, value }) {
      const displayName = requireWorkspaceName(value.display_name)
      const workspaceId = `workspace-${idFactory()}`
      try {
        const inserted = await options.sql.query<Row>(
          `insert into genio_one_team_workspaces
             (tenant_id, workspace_id, organization_id, display_name, reader_access_group_id,
              contributor_access_group_id, maintainer_access_group_id, created_at, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           returning ${WORKSPACE_COLUMNS}`,
          [
            tenantId, workspaceId, value.organization_id, displayName, value.reader_access_group_id,
            value.contributor_access_group_id, value.maintainer_access_group_id, now(), createdBy,
          ],
        )
        return workspaceRow(inserted.rows[0]!)
      } catch (error) {
        const code = typeof error === "object" && error && "code" in error ? String(error.code) : ""
        if (code === "23505") throw new PlatformApiError("TEAM_WORKSPACE_EXISTS", 409)
        if (code === "23503") throw new PlatformApiError("ORGANIZATION_NOT_FOUND", 422)
        throw error
      }
    },
    async listWorkspaces(tenantId) {
      const result = await options.sql.query<Row>(
        `select ${WORKSPACE_COLUMNS}
           from genio_one_team_workspaces
          where tenant_id = $1
          order by display_name asc, workspace_id asc`,
        [tenantId],
      )
      return result.rows.map(workspaceRow)
    },
    async assignWorkspace({ tenantId, actorSubjectId, knowledgeId, workspaceId, maintainerWorkspaceIds }) {
      return options.sql.transaction(async (transaction) => {
        const workspace = await transaction.query(
          `select workspace_id from genio_one_team_workspaces where tenant_id = $1 and workspace_id = $2`,
          [tenantId, workspaceId],
        )
        if (!workspace.rows[0]) throw new PlatformApiError("TEAM_WORKSPACE_NOT_FOUND", 422)
        if (!maintainerWorkspaceIds.includes(workspaceId)) {
          throw new PlatformApiError("TEAM_WORKSPACE_MAINTAINER_REQUIRED", 403)
        }
        const current = await transaction.query<Row>(
          `select ${CANDIDATE_COLUMNS} from genio_one_knowledge_candidates
            where tenant_id = $1 and knowledge_id = $2 for update`,
          [tenantId, knowledgeId],
        )
        const row = current.rows[0]
        if (!row) throw new PlatformApiError("KNOWLEDGE_CANDIDATE_NOT_FOUND", 404)
        const currentCandidate = candidate(row)
        if (currentCandidate.workspace_id) {
          if (!maintainerWorkspaceIds.includes(currentCandidate.workspace_id)) {
            throw new PlatformApiError("TEAM_WORKSPACE_MAINTAINER_REQUIRED", 403)
          }
        } else if (currentCandidate.owner_subject_id !== actorSubjectId) {
          throw new PlatformApiError("KNOWLEDGE_CANDIDATE_OWNER_REQUIRED", 403)
        }
        if (currentCandidate.review_state !== "PENDING_REVIEW") throw new PlatformApiError("KNOWLEDGE_REVIEW_CLOSED", 409)
        const at = now()
        const updated = await transaction.query<Row>(
          `update genio_one_knowledge_candidates
              set workspace_id = $3, updated_at = $4
            where tenant_id = $1 and knowledge_id = $2
            returning ${CANDIDATE_COLUMNS}`,
          [tenantId, knowledgeId, workspaceId, at],
        )
        await transaction.query(
          `update genio_one_distillation_markers set workspace_id = $3, workspace_acl_version = $4, updated_at = $5
            where tenant_id = $1 and marker_id = $2`,
          [tenantId, currentCandidate.marker_id, workspaceId, WORKSPACE_ACL_VERSION, at],
        )
        return candidate(updated.rows[0]!)
      })
    },
    async reviewCandidate({
      tenantId,
      reviewerId,
      knowledgeId,
      decision,
      maintainerWorkspaceIds,
      expectedWorkspaceId,
      expectedUpdatedAt,
    }) {
      const at = now()
      const updated = await options.sql.query<Row>(
        `update genio_one_knowledge_candidates
            set review_state = $6, reviewed_by = $7, reviewed_at = $8, updated_at = $8
          where tenant_id = $1 and knowledge_id = $2
            and review_state = 'PENDING_REVIEW'
            and workspace_id = $3
            and updated_at = $4
            and workspace_id = any($5::text[])
          returning ${CANDIDATE_COLUMNS}`,
        [
          tenantId,
          knowledgeId,
          expectedWorkspaceId,
          expectedUpdatedAt,
          maintainerWorkspaceIds,
          decision === "APPROVE" ? "APPROVED" : "REJECTED",
          reviewerId,
          at,
        ],
      )
      if (updated.rows[0]) return candidate(updated.rows[0])
      const current = await options.sql.query<Row>(
        `select workspace_id, review_state, updated_at from genio_one_knowledge_candidates
          where tenant_id = $1 and knowledge_id = $2`,
        [tenantId, knowledgeId],
      )
      if (!current.rows[0]) throw new PlatformApiError("KNOWLEDGE_CANDIDATE_NOT_FOUND", 404)
      const workspaceId = current.rows[0].workspace_id == null ? null : text(current.rows[0], "workspace_id")
      if (!workspaceId || !maintainerWorkspaceIds.includes(workspaceId)) {
        throw new PlatformApiError("TEAM_WORKSPACE_MAINTAINER_REQUIRED", 403)
      }
      if (text(current.rows[0], "review_state") !== "PENDING_REVIEW") throw new PlatformApiError("KNOWLEDGE_REVIEW_CLOSED", 409)
      throw new PlatformApiError("KNOWLEDGE_EVIDENCE_CHANGED", 409)
    },
  }
}

function workspaceRow(row: Row) {
  return {
    workspace_id: text(row, "workspace_id"),
    tenant_id: text(row, "tenant_id"),
    organization_id: text(row, "organization_id"),
    display_name: text(row, "display_name"),
    reader_access_group_id: text(row, "reader_access_group_id"),
    contributor_access_group_id: text(row, "contributor_access_group_id"),
    maintainer_access_group_id: text(row, "maintainer_access_group_id"),
    created_at: number(row.created_at),
    created_by: text(row, "created_by"),
  }
}
