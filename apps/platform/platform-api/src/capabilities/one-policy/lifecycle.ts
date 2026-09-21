import { createHash, randomUUID } from "node:crypto"

import { canonicalJson } from "@genioone/protocol/canonical"

import { PlatformApiError } from "../errors"

export const POLICY_DRAFT_LIFECYCLES = ["DRAFT", "VALIDATED", "REVIEWED"] as const
export type PolicyDraftLifecycle = typeof POLICY_DRAFT_LIFECYCLES[number]

export interface PolicyDraftEvidence {
  actor_subject_id: string | null
  at: number
  content_digest: string
  correlation_id: string | null
}

export interface PolicyDraftLifecycleFields {
  lifecycle: PolicyDraftLifecycle
  content_digest: string
  created_by_subject_id: string | null
  created_at: number
  updated_by_subject_id: string | null
  updated_at: number
  validation: PolicyDraftEvidence | null
  review: PolicyDraftEvidence | null
}

export interface PolicyDraftMutationContext {
  actorSubjectId?: string | null
  correlationId?: string | null
  at?: number
}

export interface ResolvedPolicyDraftMutationContext {
  actorSubjectId: string | null
  correlationId: string
  at: number
}

export interface PolicyDraftTransitionInput {
  expectedVersion: number
  expectedContentDigest: string
  context?: PolicyDraftMutationContext
}

export const POLICY_CHANGE_ACTIONS = [
  "DRAFT_SAVED",
  "VALIDATED",
  "REVIEWED",
  "PUBLISHED",
  "DISCARDED",
  "SETTINGS_UPDATED",
  "SYSTEM_PUBLISHED",
  "ENABLED",
  "DISABLED",
] as const
export type PolicyChangeAction = typeof POLICY_CHANGE_ACTIONS[number]

export function policyDraftContentDigest(content: unknown): string {
  return createHash("sha256").update(canonicalJson(content)).digest("hex")
}

export function policyDraftMutationContext(
  input: PolicyDraftMutationContext | undefined,
  now: () => number,
): ResolvedPolicyDraftMutationContext {
  return {
    actorSubjectId: input?.actorSubjectId ?? null,
    correlationId: input?.correlationId ?? `policy-draft-${randomUUID()}`,
    at: input?.at ?? now(),
  }
}

export function createPolicyDraftLifecycleFields(
  content: unknown,
  context: ResolvedPolicyDraftMutationContext,
): PolicyDraftLifecycleFields {
  const digest = policyDraftContentDigest(content)
  return {
    lifecycle: "DRAFT",
    content_digest: digest,
    created_by_subject_id: context.actorSubjectId,
    created_at: context.at,
    updated_by_subject_id: context.actorSubjectId,
    updated_at: context.at,
    validation: null,
    review: null,
  }
}

export function assertExpectedPolicyDraft(
  draft: { version: number; content_digest: string },
  input: Pick<PolicyDraftTransitionInput, "expectedVersion" | "expectedContentDigest">,
): void {
  if (
    draft.version !== input.expectedVersion ||
    draft.content_digest !== input.expectedContentDigest
  ) {
    throw new PlatformApiError("POLICY_DRAFT_CONFLICT", 409)
  }
}

export function policyDraftEvidence(
  contentDigest: string,
  context: ResolvedPolicyDraftMutationContext,
): PolicyDraftEvidence {
  return {
    actor_subject_id: context.actorSubjectId,
    at: context.at,
    content_digest: contentDigest,
    correlation_id: context.correlationId,
  }
}

export function requireValidatedPolicyDraft(
  draft: PolicyDraftLifecycleFields & { version: number },
  input: Pick<PolicyDraftTransitionInput, "expectedVersion" | "expectedContentDigest">,
): void {
  assertExpectedPolicyDraft(draft, input)
  if (draft.lifecycle === "DRAFT") {
    throw new PlatformApiError("POLICY_DRAFT_NOT_VALIDATED", 409)
  }
}

export function requireReviewedPolicyDraft(
  draft: PolicyDraftLifecycleFields & { version: number },
  input: Pick<PolicyDraftTransitionInput, "expectedVersion" | "expectedContentDigest">,
): void {
  assertExpectedPolicyDraft(draft, input)
  if (
    draft.lifecycle !== "REVIEWED" ||
    draft.review?.content_digest !== draft.content_digest
  ) {
    throw new PlatformApiError("POLICY_DRAFT_NOT_REVIEWED", 409)
  }
}

export function policyChangeAuditEvent(input: {
  tenantId: string
  policyKey: string
  draft: PolicyDraftLifecycleFields & { version: number; base_revision: number }
  action: PolicyChangeAction
  actorSubjectId: string | null
  correlationId: string
  occurredAt: number
  publishedRevision?: number | null
}) {
  const actorSubjectId = input.actorSubjectId ?? "system"
  const identity = canonicalJson([
    input.tenantId,
    input.policyKey,
    input.draft.version,
    input.draft.content_digest,
    input.action,
    input.correlationId,
  ])
  const auditEventId = `policy-change-${createHash("sha256").update(identity).digest("hex")}`
  return {
    tenant_id: input.tenantId,
    audit_event_id: auditEventId,
    correlation_id: input.correlationId,
    kind: "POLICY_CHANGE" as const,
    outcome: "SUCCESS" as const,
    subject: { subject_id: actorSubjectId, evidence_level: "VERIFIED" as const },
    actor_subject: { subject_id: actorSubjectId, evidence_level: "VERIFIED" as const },
    policy_key: input.policyKey,
    action: input.action,
    policy_draft_version: input.draft.version,
    base_revision: input.draft.base_revision,
    published_revision: input.publishedRevision ?? null,
    lifecycle: input.draft.lifecycle,
    content_digest: input.draft.content_digest,
    occurred_at: input.occurredAt,
  }
}

export function policyAuthoringSettingsAuditEvent(input: {
  tenantId: string
  revision: number
  previousRevision: number
  requireDistinctReviewer: boolean
  actorSubjectId: string
  correlationId: string
  occurredAt: number
}) {
  const contentDigest = policyDraftContentDigest({
    require_distinct_reviewer: input.requireDistinctReviewer,
  })
  const identity = canonicalJson([
    input.tenantId,
    "one-policy.authoring-settings",
    input.revision,
    contentDigest,
    "SETTINGS_UPDATED",
    input.correlationId,
  ])
  return {
    tenant_id: input.tenantId,
    audit_event_id: `policy-change-${createHash("sha256").update(identity).digest("hex")}`,
    correlation_id: input.correlationId,
    kind: "POLICY_CHANGE" as const,
    outcome: "SUCCESS" as const,
    subject: { subject_id: input.actorSubjectId, evidence_level: "VERIFIED" as const },
    actor_subject: { subject_id: input.actorSubjectId, evidence_level: "VERIFIED" as const },
    policy_key: "one-policy.authoring-settings",
    action: "SETTINGS_UPDATED" as const,
    policy_draft_version: null,
    base_revision: input.previousRevision,
    published_revision: input.revision,
    lifecycle: null,
    content_digest: contentDigest,
    occurred_at: input.occurredAt,
  }
}

export function policySystemPublishAuditEvent(input: {
  tenantId: string
  policyKey: string
  publishedRevision: number
  content: unknown
  actorSubjectId: string
  correlationId: string
  occurredAt: number
}) {
  const contentDigest = policyDraftContentDigest(input.content)
  const identity = canonicalJson([
    input.tenantId,
    input.policyKey,
    input.publishedRevision,
    contentDigest,
    "SYSTEM_PUBLISHED",
    input.correlationId,
  ])
  return {
    tenant_id: input.tenantId,
    audit_event_id: `policy-change-${createHash("sha256").update(identity).digest("hex")}`,
    correlation_id: input.correlationId,
    kind: "POLICY_CHANGE" as const,
    outcome: "SUCCESS" as const,
    subject: { subject_id: input.actorSubjectId, evidence_level: "VERIFIED" as const },
    actor_subject: { subject_id: input.actorSubjectId, evidence_level: "VERIFIED" as const },
    policy_key: input.policyKey,
    action: "SYSTEM_PUBLISHED" as const,
    policy_draft_version: null,
    base_revision: null,
    published_revision: input.publishedRevision,
    lifecycle: null,
    content_digest: contentDigest,
    occurred_at: input.occurredAt,
  }
}

export function policyEnabledAuditEvent(input: {
  tenantId: string
  policyKey: string
  previousRevision: number
  publishedRevision: number
  enabled: boolean
  content: unknown
  actorSubjectId: string
  correlationId: string
  occurredAt: number
}) {
  const action = input.enabled ? "ENABLED" as const : "DISABLED" as const
  const contentDigest = policyDraftContentDigest(input.content)
  const identity = canonicalJson([
    input.tenantId,
    input.policyKey,
    input.previousRevision,
    input.publishedRevision,
    input.enabled,
    contentDigest,
    action,
    input.correlationId,
  ])
  return {
    tenant_id: input.tenantId,
    audit_event_id: `policy-change-${createHash("sha256").update(identity).digest("hex")}`,
    correlation_id: input.correlationId,
    kind: "POLICY_CHANGE" as const,
    outcome: "SUCCESS" as const,
    subject: { subject_id: input.actorSubjectId, evidence_level: "VERIFIED" as const },
    actor_subject: { subject_id: input.actorSubjectId, evidence_level: "VERIFIED" as const },
    policy_key: input.policyKey,
    action,
    policy_draft_version: null,
    base_revision: input.previousRevision,
    published_revision: input.publishedRevision,
    lifecycle: null,
    content_digest: contentDigest,
    enabled: input.enabled,
    occurred_at: input.occurredAt,
  }
}
