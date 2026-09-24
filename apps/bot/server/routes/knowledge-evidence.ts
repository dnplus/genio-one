import type { FastifyInstance } from "fastify"

import {
  DISTILLATION_EXTRACTOR_VERSIONS,
  LEGACY_DISTILLATION_EXTRACTOR_VERSION,
  type DistillationExtractorVersion,
} from "@genioone/protocol/distillation-triage"

import { requestAccessToken, verifyGenioOneAccessToken } from "../auth"
import type { BotServerContext } from "../context"
import { excerptFromTurn, legacyExcerptFromTurn } from "../distillation/excerpt"
import { markerContentDigest, turnReady } from "../distillation/history"
import { platformOrigin } from "../platform-origin"

type ReviewContextCandidate = {
  knowledge_id: string
  tenant_id: string
  owner_subject_id: string
  workspace_id: string | null
  content_digest: string
  provenance: {
    bot_id: string
    thread_id: string
    turn_ids: string[]
    extractor_version: DistillationExtractorVersion
  }
}

const REVIEW_CONTEXT_BUDGET_MS = 8_000

class KnowledgeEvidenceError extends Error {
  constructor(readonly code: string, readonly statusCode: number) {
    super(code)
  }
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256
}

function extractorVersion(value: unknown): value is DistillationExtractorVersion {
  return (DISTILLATION_EXTRACTOR_VERSIONS as readonly unknown[]).includes(value)
}

function isReviewContextCandidate(value: unknown): value is ReviewContextCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  if (
    !identifier(candidate.knowledge_id) ||
    !identifier(candidate.tenant_id) ||
    !identifier(candidate.owner_subject_id) ||
    !(candidate.workspace_id === null || identifier(candidate.workspace_id)) ||
    typeof candidate.content_digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(candidate.content_digest) ||
    !candidate.provenance ||
    typeof candidate.provenance !== "object" ||
    Array.isArray(candidate.provenance)
  ) return false
  const provenance = candidate.provenance as Record<string, unknown>
  return identifier(provenance.bot_id) &&
    identifier(provenance.thread_id) &&
    extractorVersion(provenance.extractor_version) &&
    Array.isArray(provenance.turn_ids) &&
    provenance.turn_ids.length > 0 &&
    provenance.turn_ids.length <= 32 &&
    provenance.turn_ids.every(identifier) &&
    new Set(provenance.turn_ids).size === provenance.turn_ids.length
}

function sameReviewContext(left: ReviewContextCandidate, right: ReviewContextCandidate): boolean {
  return left.knowledge_id === right.knowledge_id &&
    left.tenant_id === right.tenant_id &&
    left.owner_subject_id === right.owner_subject_id &&
    left.workspace_id === right.workspace_id &&
    left.content_digest === right.content_digest &&
    left.provenance.bot_id === right.provenance.bot_id &&
    left.provenance.thread_id === right.provenance.thread_id &&
    left.provenance.extractor_version === right.provenance.extractor_version &&
    left.provenance.turn_ids.length === right.provenance.turn_ids.length &&
    left.provenance.turn_ids.every((turnId, index) => turnId === right.provenance.turn_ids[index])
}

async function readReviewContext(accessToken: string, tenantId: string, knowledgeId: string, signal: AbortSignal): Promise<ReviewContextCandidate> {
  if (signal.aborted) throw new KnowledgeEvidenceError("KNOWLEDGE_EVIDENCE_PLATFORM_UNAVAILABLE", 503)
  let response: Response
  try {
    response = await fetch(new URL(`/v1/tenants/${encodeURIComponent(tenantId)}/knowledge-candidates/${encodeURIComponent(knowledgeId)}/review-context`, platformOrigin()), {
      headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
      signal,
    })
  } catch {
    throw new KnowledgeEvidenceError("KNOWLEDGE_EVIDENCE_PLATFORM_UNAVAILABLE", 503)
  }
  if (!response.ok) {
    if (response.status === 401) throw new KnowledgeEvidenceError("KNOWLEDGE_EVIDENCE_AUTH_REQUIRED", 401)
    if (response.status === 403) throw new KnowledgeEvidenceError("KNOWLEDGE_EVIDENCE_FORBIDDEN", 403)
    if (response.status === 404) throw new KnowledgeEvidenceError("KNOWLEDGE_CANDIDATE_NOT_FOUND", 404)
    throw new KnowledgeEvidenceError("KNOWLEDGE_EVIDENCE_PLATFORM_UNAVAILABLE", 503)
  }
  const candidate = await response.json().catch(() => null)
  if (signal.aborted) throw new KnowledgeEvidenceError("KNOWLEDGE_EVIDENCE_PLATFORM_UNAVAILABLE", 503)
  if (!isReviewContextCandidate(candidate)) throw new KnowledgeEvidenceError("KNOWLEDGE_EVIDENCE_PLATFORM_INVALID", 503)
  return candidate
}

function authenticationFailure(error: unknown) {
  // Only an actual token/scope rejection (401/403, or a local token check without a status) should log the
  // user out; any other session-service status (5xx, 408, 429, ...) is a retryable outage.
  const upstreamStatus = (error as { status?: unknown } | null)?.status
  const sessionOutage = typeof upstreamStatus === "number" && upstreamStatus !== 401 && upstreamStatus !== 403
  return error instanceof Error && error.message.startsWith("GENIO_ONE_SESSION") && !sessionOutage
    ? new KnowledgeEvidenceError("KNOWLEDGE_EVIDENCE_AUTH_REQUIRED", 401)
    : new KnowledgeEvidenceError("KNOWLEDGE_EVIDENCE_PLATFORM_UNAVAILABLE", 503)
}

export async function knowledgeEvidenceRoutes(app: FastifyInstance, context: BotServerContext) {
  app.get("/api/knowledge-candidates/:knowledgeId/evidence", { config: { sensitiveResponse: true } }, async (request, reply) => {
    reply.header("cache-control", "private, no-store").header("vary", "authorization")
    try {
      const accessToken = requestAccessToken(request)
      const evidenceDeadline = AbortSignal.timeout(REVIEW_CONTEXT_BUDGET_MS)
      let principal
      try {
        principal = await verifyGenioOneAccessToken(accessToken, evidenceDeadline)
      } catch (error) {
        throw authenticationFailure(error)
      }
      const knowledgeId = (request.params as { knowledgeId: string }).knowledgeId
      const candidate = await readReviewContext(accessToken, principal.tenant_id, knowledgeId, evidenceDeadline)
      if (candidate.knowledge_id !== knowledgeId || candidate.tenant_id !== principal.tenant_id) {
        throw new KnowledgeEvidenceError("KNOWLEDGE_CANDIDATE_NOT_FOUND", 404)
      }
      const source = context.botRegistry.findEvidenceSource(candidate.tenant_id, candidate.owner_subject_id, candidate.provenance.bot_id)
      if (!source) throw new KnowledgeEvidenceError("KNOWLEDGE_CANDIDATE_NOT_FOUND", 404)
      const storedTurns = candidate.provenance.turn_ids.map((turnId) => context.botRegistry.timeline.storedTurn(source.botId, candidate.provenance.thread_id, turnId))
      if (storedTurns.some((turn) => turn === null)) throw new KnowledgeEvidenceError("KNOWLEDGE_EVIDENCE_TURN_NOT_FOUND", 404)
      if (!storedTurns.every((turn) => turnReady(turn!.turn))) throw new KnowledgeEvidenceError("KNOWLEDGE_EVIDENCE_HISTORY_INCOMPLETE", 503)
      const turns = storedTurns.map((turn) => turn!)
      if (markerContentDigest(turns.map((turn) => turn.bodyJson)) !== candidate.content_digest) {
        throw new KnowledgeEvidenceError("KNOWLEDGE_EVIDENCE_DIGEST_CHANGED", 409)
      }
      const excerpts = turns.map((turn) => excerptFromTurn(turn.turn))
      const legacyEvidenceChanged = candidate.provenance.extractor_version === LEGACY_DISTILLATION_EXTRACTOR_VERSION &&
        turns.some((turn, index) => legacyExcerptFromTurn(turn.turn).text !== excerpts[index]!.text)
      if (legacyEvidenceChanged) {
        throw new KnowledgeEvidenceError("KNOWLEDGE_EVIDENCE_EXCERPT_CHANGED", 409)
      }
      const refreshedCandidate = await readReviewContext(accessToken, principal.tenant_id, knowledgeId, evidenceDeadline)
      if (!sameReviewContext(candidate, refreshedCandidate)) {
        throw new KnowledgeEvidenceError("KNOWLEDGE_EVIDENCE_CHANGED", 409)
      }
      const evidence = {
        knowledge_id: candidate.knowledge_id,
        tenant_id: candidate.tenant_id,
        workspace_id: candidate.workspace_id,
        content_digest: candidate.content_digest,
        turns: candidate.provenance.turn_ids.map((turnId, index) => {
          const excerpt = excerpts[index]!
          return { turn_id: turnId, text: excerpt.text, truncated: excerpt.truncated }
        }),
      }
      request.log.info({
        event: "bot.knowledge_evidence.read",
        tenant_id: candidate.tenant_id,
        subject_id: principal.subject_id,
        knowledge_id: candidate.knowledge_id,
        workspace_id: candidate.workspace_id,
        bot_id: source.botId,
        turn_count: turns.length,
      })
      return reply.send(evidence)
    } catch (error) {
      const failure = error instanceof KnowledgeEvidenceError
        ? error
        : error instanceof Error && error.message === "GENIO_ONE_SESSION_TOKEN_REQUIRED"
          ? new KnowledgeEvidenceError("KNOWLEDGE_EVIDENCE_AUTH_REQUIRED", 401)
          : new KnowledgeEvidenceError("KNOWLEDGE_EVIDENCE_PLATFORM_UNAVAILABLE", 503)
      return reply.code(failure.statusCode).send({ error: failure.code })
    }
  })
}
