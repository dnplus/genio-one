import { createKeyedSerialExecutor } from "../../persistence/keyed-serial-executor"
import { PlatformApiError } from "../errors"
import { hasSameImmutableDistillationMarkerPayload } from "./contract"
import type {
  CancelDistillationBot,
  CreateDistillationMarker,
  DistillationMarker,
  KnowledgeCandidate,
  TeamWorkspace,
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

interface MarkerRecord extends DistillationMarker {
  lease_owner: string | null
  lease_token: string | null
  lease_until: number | null
}

function publicMarker(record: MarkerRecord): DistillationMarker {
  const { lease_owner: _owner, lease_token: _token, lease_until: _until, ...marker } = record
  return structuredClone(marker)
}

function idempotencyKey(tenantId: string, ownerSubjectId: string, value: CreateDistillationMarker): string {
  return [tenantId, ownerSubjectId, value.bot_id, value.thread_id, value.source_revision].join("\u0000")
}

function recordKey(tenantId: string, id: string): string {
  return `${tenantId}\u0000${id}`
}

function botKey(tenantId: string, ownerSubjectId: string, botId: string): string {
  return [tenantId, ownerSubjectId, botId].join("\u0000")
}

export function createInMemoryDistillationStore(options: {
  now?: () => number
  idFactory?: () => string
} = {}): DistillationStore {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const idFactory = options.idFactory ?? (() => crypto.randomUUID())
  const markers = new Map<string, MarkerRecord>()
  const byIdempotency = new Map<string, string>()
  const candidates = new Map<string, KnowledgeCandidate>()
  const workspaces = new Map<string, TeamWorkspace>()
  const botTombstones = new Set<string>()
  const botLocks = createKeyedSerialExecutor()

  function requireOwn(tenantId: string, ownerSubjectId: string, markerId: string): MarkerRecord {
    const record = markers.get(recordKey(tenantId, markerId))
    if (!record || record.owner_subject_id !== ownerSubjectId) {
      throw new PlatformApiError("DISTILLATION_MARKER_NOT_FOUND", 404)
    }
    return record
  }

  return {
    async createMarker({ tenantId, ownerSubjectId, value, contributorWorkspaceIds }) {
      if (new Set(value.turn_ids).size !== value.turn_ids.length) {
        throw new PlatformApiError("DISTILLATION_TURN_RANGE_INVALID", 422)
      }
      const key = botKey(tenantId, ownerSubjectId, value.bot_id)
      return botLocks.run(key, async () => {
        if (botTombstones.has(key)) {
          throw new PlatformApiError("DISTILLATION_BOT_DELETED", 409)
        }
        const normalized = normalizeDistillationMarker(value)
        const markerKey = idempotencyKey(tenantId, ownerSubjectId, value)
        const existingId = byIdempotency.get(markerKey)
        if (existingId) {
          const existing = markers.get(recordKey(tenantId, existingId))!
          if (!hasSameImmutableDistillationMarkerPayload(existing, value, normalized)) {
            throw new PlatformApiError("DISTILLATION_MARKER_CONFLICT", 409)
          }
          return publicMarker(existing)
        }
        if (value.workspace_id && !workspaces.has(recordKey(tenantId, value.workspace_id))) {
          throw new PlatformApiError("TEAM_WORKSPACE_NOT_FOUND", 422)
        }
        if (value.workspace_id && !contributorWorkspaceIds.includes(value.workspace_id)) {
          throw new PlatformApiError("TEAM_WORKSPACE_CONTRIBUTOR_REQUIRED", 403)
        }
        const at = now()
        const record: MarkerRecord = {
          marker_id: `marker-${idFactory()}`,
          tenant_id: tenantId,
          owner_subject_id: ownerSubjectId,
          bot_id: value.bot_id,
          thread_id: value.thread_id,
          turn_ids: [...value.turn_ids],
          source_revision: value.source_revision,
          content_digest: value.content_digest,
          ...normalized,
          classifier_version: value.classifier_version,
          extractor_version: value.extractor_version,
          evidence: value.evidence.map((item) => ({ ...item })),
          excerpt_truncated: value.excerpt_truncated,
          history_state: "READY",
          processing_state: "PENDING",
          attempts: 0,
          not_before: at,
          workspace_id: value.workspace_id ?? null,
          last_error: null,
          created_at: at,
          updated_at: at,
          lease_owner: null,
          lease_token: null,
          lease_until: null,
        }
        markers.set(recordKey(tenantId, record.marker_id), record)
        byIdempotency.set(markerKey, record.marker_id)
        return publicMarker(record)
      })
    },
    async cancelBot({ tenantId, ownerSubjectId, botId }) {
      const key = botKey(tenantId, ownerSubjectId, botId)
      return botLocks.run(key, async (): Promise<CancelDistillationBot> => {
        botTombstones.add(key)
        const at = now()
        let cancelledCount = 0
        for (const record of markers.values()) {
          if (
            record.tenant_id !== tenantId ||
            record.owner_subject_id !== ownerSubjectId ||
            record.bot_id !== botId ||
            !["PENDING", "WAITING_FOR_HISTORY", "PROCESSING"].includes(record.processing_state)
          ) continue
          record.processing_state = "FAILED"
          record.last_error = "BOT_DELETED"
          record.lease_owner = null
          record.lease_token = null
          record.lease_until = null
          record.updated_at = at
          cancelledCount += 1
        }
        return { bot_id: botId, cancelled_count: cancelledCount }
      })
    },
    async claim({ tenantId, ownerSubjectId, botId, leaseOwner }) {
      const at = now()
      const eligible = [...markers.values()]
        .filter((record) =>
          record.tenant_id === tenantId &&
          record.owner_subject_id === ownerSubjectId &&
          record.bot_id === botId &&
          (
            record.processing_state === "PENDING" ||
            record.processing_state === "WAITING_FOR_HISTORY" ||
            (record.processing_state === "PROCESSING" && record.lease_until !== null && record.lease_until < at)
          ) &&
          (record.processing_state === "PROCESSING" || record.not_before <= at) &&
          (record.lease_until === null || record.lease_until < at))
        .sort((left, right) => left.not_before - right.not_before || left.created_at - right.created_at)
      for (const record of eligible) {
        const consumesAttempt = record.history_state !== "WAITING_FOR_HISTORY"
        if (consumesAttempt && record.attempts >= MAX_ATTEMPTS) {
          record.processing_state = "FAILED"
          record.last_error = "DISTILLATION_ATTEMPTS_EXHAUSTED"
          record.updated_at = at
          continue
        }
        if (consumesAttempt) record.attempts += 1
        record.processing_state = "PROCESSING"
        record.lease_owner = leaseOwner
        record.lease_token = `lease-${idFactory()}`
        record.lease_until = at + LEASE_SECONDS
        record.updated_at = at
        return { ...publicMarker(record), lease_token: record.lease_token }
      }
      return null
    },
    async complete({ tenantId, ownerSubjectId, markerId, value }) {
      const initial = requireOwn(tenantId, ownerSubjectId, markerId)
      return botLocks.run(botKey(tenantId, ownerSubjectId, initial.bot_id), async () => {
        const record = requireOwn(tenantId, ownerSubjectId, markerId)
        const at = now()
        const { waitingError, failedError } = completionErrors(value)
        if (
          record.processing_state === "CANDIDATE_CREATED" &&
          value.outcome === "CANDIDATE_CREATED" &&
          record.lease_token === value.lease_token
        ) {
          const candidate = [...candidates.values()].find((item) => item.tenant_id === tenantId && item.marker_id === markerId)
          if (candidate && value.content_digest === record.content_digest) {
            return { marker: publicMarker(record), candidate: structuredClone(candidate) }
          }
        }
        if (
          record.processing_state === "WAITING_FOR_HISTORY" &&
          value.outcome === "WAITING_FOR_HISTORY" &&
          record.lease_token === value.lease_token &&
          record.last_error === waitingError
        ) {
          return { marker: publicMarker(record), candidate: null }
        }
        if (
          record.processing_state === "FAILED" &&
          value.outcome === "FAILED" &&
          record.lease_token === value.lease_token &&
          record.last_error === failedError
        ) {
          return { marker: publicMarker(record), candidate: null }
        }
        if (record.processing_state !== "PROCESSING" || record.lease_token !== value.lease_token || record.lease_until === null || record.lease_until < at) {
          throw new PlatformApiError("DISTILLATION_LEASE_CONFLICT", 409)
        }
        if (value.outcome === "CANDIDATE_CREATED" && value.content_digest !== record.content_digest) {
          throw new PlatformApiError("DISTILLATION_DIGEST_MISMATCH", 409)
        }
        record.updated_at = at
        record.lease_owner = null
        record.lease_until = null
        Object.assign(record, completionTransition(record, value, at))
        if (value.outcome !== "CANDIDATE_CREATED") return { marker: publicMarker(record), candidate: null }
        const candidate: KnowledgeCandidate = {
          knowledge_id: `knowledge-${idFactory()}`,
          tenant_id: tenantId,
          marker_id: record.marker_id,
          owner_subject_id: ownerSubjectId,
          workspace_id: record.workspace_id,
          scope: record.scope_hint,
          knowledge_type: record.knowledge_type,
          representation: record.representation,
          sensitivity: record.sensitivity,
          review_state: "PENDING_REVIEW",
          content_digest: record.content_digest,
          provenance: candidateProvenance(record),
          reviewed_by: null,
          reviewed_at: null,
          created_at: at,
          updated_at: at,
        }
        candidates.set(recordKey(tenantId, candidate.knowledge_id), candidate)
        return { marker: publicMarker(record), candidate: structuredClone(candidate) }
      })
    },
    async getMarker({ tenantId, ownerSubjectId, markerId }) {
      return publicMarker(requireOwn(tenantId, ownerSubjectId, markerId))
    },
    async listMarkers({ tenantId, ownerSubjectId, limit, cursor }) {
      const pageLimit = distillationPageLimit(limit)
      const position = decodeDistillationCursor(cursor)
      const rows = [...markers.values()]
        .filter((record) => record.tenant_id === tenantId && record.owner_subject_id === ownerSubjectId)
        .map(publicMarker)
        .sort((left, right) => right.created_at - left.created_at || left.marker_id.localeCompare(right.marker_id))
        .filter((record) => !position || record.created_at < position.created_at || (record.created_at === position.created_at && record.marker_id > position.id))
      const { items, next_cursor } = toDistillationPage(rows, pageLimit, (record) => record.marker_id)
      return { markers: items, next_cursor }
    },
    async listCandidates({ tenantId, ownerSubjectId, workspaceIds, limit, cursor }) {
      const pageLimit = distillationPageLimit(limit)
      const position = decodeDistillationCursor(cursor)
      const visible = new Set(workspaceIds)
      const rows = [...candidates.values()]
        .filter((candidate) => candidate.tenant_id === tenantId && (
          candidate.owner_subject_id === ownerSubjectId ||
          (candidate.workspace_id !== null && visible.has(candidate.workspace_id))
        ))
        .map((candidate) => structuredClone(candidate))
        .sort((left, right) => right.created_at - left.created_at || left.knowledge_id.localeCompare(right.knowledge_id))
        .filter((candidate) => !position || candidate.created_at < position.created_at || (candidate.created_at === position.created_at && candidate.knowledge_id > position.id))
      const { items, next_cursor } = toDistillationPage(rows, pageLimit, (candidate) => candidate.knowledge_id)
      return { candidates: items, next_cursor }
    },
    async getCandidate({ tenantId, knowledgeId }) {
      const candidate = candidates.get(recordKey(tenantId, knowledgeId))
      return candidate ? structuredClone(candidate) : null
    },
    async createWorkspace({ tenantId, createdBy, value }) {
      const displayName = requireWorkspaceName(value.display_name)
      if ([...workspaces.values()].some((workspace) => workspace.tenant_id === tenantId && workspace.display_name === displayName)) {
        throw new PlatformApiError("TEAM_WORKSPACE_EXISTS", 409)
      }
      const workspace = {
        workspace_id: `workspace-${idFactory()}`,
        tenant_id: tenantId,
        organization_id: value.organization_id,
        display_name: displayName,
        reader_access_group_id: value.reader_access_group_id,
        contributor_access_group_id: value.contributor_access_group_id,
        maintainer_access_group_id: value.maintainer_access_group_id,
        created_at: now(),
        created_by: createdBy,
      }
      workspaces.set(recordKey(tenantId, workspace.workspace_id), workspace)
      return structuredClone(workspace)
    },
    async listWorkspaces(tenantId) {
      return [...workspaces.values()]
        .filter((workspace) => workspace.tenant_id === tenantId)
        .sort((left, right) => left.display_name.localeCompare(right.display_name))
        .map((workspace) => structuredClone(workspace))
    },
    async assignWorkspace({ tenantId, actorSubjectId, knowledgeId, workspaceId, maintainerWorkspaceIds }) {
      if (!workspaces.has(recordKey(tenantId, workspaceId))) {
        throw new PlatformApiError("TEAM_WORKSPACE_NOT_FOUND", 422)
      }
      if (!maintainerWorkspaceIds.includes(workspaceId)) {
        throw new PlatformApiError("TEAM_WORKSPACE_MAINTAINER_REQUIRED", 403)
      }
      const candidate = candidates.get(recordKey(tenantId, knowledgeId))
      if (!candidate || candidate.tenant_id !== tenantId) throw new PlatformApiError("KNOWLEDGE_CANDIDATE_NOT_FOUND", 404)
      if (candidate.workspace_id) {
        if (!maintainerWorkspaceIds.includes(candidate.workspace_id)) {
          throw new PlatformApiError("TEAM_WORKSPACE_MAINTAINER_REQUIRED", 403)
        }
      } else if (candidate.owner_subject_id !== actorSubjectId) {
        throw new PlatformApiError("KNOWLEDGE_CANDIDATE_OWNER_REQUIRED", 403)
      }
      if (candidate.review_state !== "PENDING_REVIEW") throw new PlatformApiError("KNOWLEDGE_REVIEW_CLOSED", 409)
      candidate.workspace_id = workspaceId
      candidate.updated_at = now()
      const marker = markers.get(recordKey(tenantId, candidate.marker_id))
      if (marker) {
        marker.workspace_id = workspaceId
        marker.updated_at = candidate.updated_at
      }
      return structuredClone(candidate)
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
      const candidate = candidates.get(recordKey(tenantId, knowledgeId))
      if (!candidate || candidate.tenant_id !== tenantId) throw new PlatformApiError("KNOWLEDGE_CANDIDATE_NOT_FOUND", 404)
      if (!candidate.workspace_id || !maintainerWorkspaceIds.includes(candidate.workspace_id)) {
        throw new PlatformApiError("TEAM_WORKSPACE_MAINTAINER_REQUIRED", 403)
      }
      if (candidate.review_state !== "PENDING_REVIEW") throw new PlatformApiError("KNOWLEDGE_REVIEW_CLOSED", 409)
      if (candidate.workspace_id !== expectedWorkspaceId || candidate.updated_at !== expectedUpdatedAt) {
        throw new PlatformApiError("KNOWLEDGE_EVIDENCE_CHANGED", 409)
      }
      candidate.review_state = decision === "APPROVE" ? "APPROVED" : "REJECTED"
      candidate.reviewed_by = reviewerId
      candidate.reviewed_at = now()
      candidate.updated_at = candidate.reviewed_at
      return structuredClone(candidate)
    },
  }
}
