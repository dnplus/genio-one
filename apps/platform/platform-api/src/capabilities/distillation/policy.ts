import { PlatformApiError } from "../errors"
import type {
  CompleteDistillationMarker,
  CreateDistillationMarker,
  DistillationMarker,
  KnowledgeCandidate,
} from "./contract"

const DEFAULT_PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 100
export const MAX_ATTEMPTS = 5
export const LEASE_SECONDS = 60
export const WAITING_DELAY_SECONDS = 60

export interface DistillationPageCursor {
  created_at: number
  id: string
}

export function distillationPageLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_PAGE_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new PlatformApiError("DISTILLATION_PAGE_LIMIT_INVALID", 400)
  }
  return limit
}

export function decodeDistillationCursor(cursor: string | undefined): DistillationPageCursor | null {
  if (!cursor) return null
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { created_at?: unknown; id?: unknown }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Number.isSafeInteger(parsed.created_at) ||
      (parsed.created_at as number) < 0 ||
      typeof parsed.id !== "string" ||
      !parsed.id ||
      parsed.id.length > 256
    ) throw new Error("invalid")
    return { created_at: parsed.created_at as number, id: parsed.id }
  } catch (error) {
    if (error instanceof PlatformApiError) throw error
    throw new PlatformApiError("DISTILLATION_PAGE_CURSOR_INVALID", 400)
  }
}

export function encodeDistillationCursor(createdAt: number, id: string): string {
  return Buffer.from(JSON.stringify({ created_at: createdAt, id })).toString("base64url")
}

export function toDistillationPage<T extends { created_at: number }>(
  rows: T[],
  pageLimit: number,
  idOf: (row: T) => string,
): { items: T[]; next_cursor: string | null } {
  const items = rows.slice(0, pageLimit)
  const last = items.at(-1)
  return {
    items,
    next_cursor: rows.length > pageLimit && last ? encodeDistillationCursor(last.created_at, idOf(last)) : null,
  }
}

export function completionErrors(value: CompleteDistillationMarker): { waitingError: string; failedError: string } {
  return {
    waitingError: value.error ?? "DISTILLATION_HISTORY_INCOMPLETE",
    failedError: value.error ?? "DISTILLATION_FAILED",
  }
}

export function completionTransition(
  marker: DistillationMarker,
  value: CompleteDistillationMarker,
  at: number,
): Pick<DistillationMarker, "processing_state" | "history_state" | "not_before" | "last_error"> {
  const { waitingError, failedError } = completionErrors(value)
  if (value.outcome === "WAITING_FOR_HISTORY") {
    return {
      processing_state: "WAITING_FOR_HISTORY",
      history_state: "WAITING_FOR_HISTORY",
      not_before: at + WAITING_DELAY_SECONDS,
      last_error: waitingError,
    }
  }
  return {
    processing_state: value.outcome === "CANDIDATE_CREATED" ? "CANDIDATE_CREATED" : "FAILED",
    history_state: "READY",
    not_before: marker.not_before,
    last_error: value.outcome === "CANDIDATE_CREATED" ? null : failedError,
  }
}

export function candidateProvenance(marker: DistillationMarker): KnowledgeCandidate["provenance"] {
  return {
    bot_id: marker.bot_id,
    thread_id: marker.thread_id,
    turn_ids: [...marker.turn_ids],
    source_revision: marker.source_revision,
    classifier_version: marker.classifier_version,
    extractor_version: marker.extractor_version,
    evidence: marker.evidence.map((item) => ({ ...item })),
    excerpt_truncated: marker.excerpt_truncated,
  }
}

export function requireWorkspaceName(value: string): string {
  const name = value.trim()
  if (!name) throw new PlatformApiError("TEAM_WORKSPACE_NAME_REQUIRED", 422, "Workspace name is required")
  return name
}

export function normalizeDistillationMarker(value: CreateDistillationMarker): Pick<
  DistillationMarker,
  "scope_hint" | "sensitivity" | "knowledge_type" | "representation"
> {
  const restricted = value.scope_hint === "customer_project" || value.sensitivity === "restricted" || value.excerpt_truncated
  return {
    scope_hint: value.scope_hint,
    sensitivity: restricted ? "restricted" : "standard",
    knowledge_type: value.knowledge_type,
    representation: restricted ? "EVIDENCE_ONLY" : value.representation,
  }
}
