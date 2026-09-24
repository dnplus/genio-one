import { Type, type Static, type TLiteral, type TUnion } from "typebox"

import {
  DISTILLATION_CLASSIFIER_VERSION,
  DISTILLATION_EXTRACTOR_VERSIONS,
  DISTILLATION_REPRESENTATIONS,
  DISTILLATION_SCOPES,
  DISTILLATION_SENSITIVITIES,
  DISTILLATION_TYPES,
} from "@genioone/protocol/distillation-triage"

type Without<T extends readonly string[], Excluded extends string> = T extends readonly [
  infer Head extends string,
  ...infer Rest extends readonly string[],
]
  ? Head extends Excluded ? Without<Rest, Excluded> : [Head, ...Without<Rest, Excluded>]
  : []

type Literals<T extends readonly string[]> = T extends readonly [
  infer Head extends string,
  ...infer Rest extends readonly string[],
]
  ? [TLiteral<Head>, ...Literals<Rest>]
  : []

function literalUnion<const T extends readonly string[]>(values: T): TUnion<Literals<T>> {
  return Type.Union(values.map((value) => Type.Literal(value))) as TUnion<Literals<T>>
}

const Identifier = Type.String({ minLength: 1, maxLength: 256 })
const Digest = Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" })
const Timestamp = Type.Integer({ minimum: 0 })
const SupportedExtractorVersionSchema = literalUnion(DISTILLATION_EXTRACTOR_VERSIONS)

const ScopeSchema = literalUnion(
  DISTILLATION_SCOPES.filter((scope) => scope !== "unrelated") as Without<typeof DISTILLATION_SCOPES, "unrelated">,
)
const SensitivitySchema = literalUnion(DISTILLATION_SENSITIVITIES)
const TypeSchema = literalUnion(DISTILLATION_TYPES)
const RepresentationSchema = literalUnion(DISTILLATION_REPRESENTATIONS)
const ProcessingSchema = Type.Union([
  Type.Literal("PENDING"),
  Type.Literal("WAITING_FOR_HISTORY"),
  Type.Literal("PROCESSING"),
  Type.Literal("CANDIDATE_CREATED"),
  Type.Literal("FILTERED_OUT"),
  Type.Literal("FAILED"),
])
const HistorySchema = Type.Union([
  Type.Literal("READY"),
  Type.Literal("WAITING_FOR_HISTORY"),
])

export const DistillationEvidenceSchema = Type.Object({
  check_id: Identifier,
  score: Type.Number({ minimum: 0, maximum: 1 }),
  threshold: Type.Number({ minimum: 0, maximum: 1 }),
  matched: Type.Boolean(),
}, { additionalProperties: false })

export const CreateDistillationMarkerSchema = Type.Object({
  bot_id: Identifier,
  thread_id: Identifier,
  turn_ids: Type.Array(Identifier, { minItems: 1, maxItems: 32 }),
  source_revision: Digest,
  content_digest: Digest,
  scope_hint: ScopeSchema,
  sensitivity: SensitivitySchema,
  knowledge_type: TypeSchema,
  representation: RepresentationSchema,
  classifier_version: Type.Literal(DISTILLATION_CLASSIFIER_VERSION),
  extractor_version: SupportedExtractorVersionSchema,
  evidence: Type.Array(DistillationEvidenceSchema, { maxItems: 16 }),
  excerpt_truncated: Type.Boolean(),
  workspace_id: Type.Optional(Type.Union([Identifier, Type.Null()])),
}, { additionalProperties: false })

export const DistillationMarkerSchema = Type.Object({
  marker_id: Identifier,
  tenant_id: Identifier,
  owner_subject_id: Identifier,
  bot_id: Identifier,
  thread_id: Identifier,
  turn_ids: Type.Array(Identifier, { minItems: 1, maxItems: 32 }),
  source_revision: Digest,
  content_digest: Digest,
  scope_hint: ScopeSchema,
  sensitivity: SensitivitySchema,
  knowledge_type: TypeSchema,
  representation: RepresentationSchema,
  classifier_version: Type.Literal(DISTILLATION_CLASSIFIER_VERSION),
  extractor_version: SupportedExtractorVersionSchema,
  evidence: Type.Array(DistillationEvidenceSchema, { maxItems: 16 }),
  excerpt_truncated: Type.Boolean(),
  history_state: HistorySchema,
  processing_state: ProcessingSchema,
  attempts: Type.Integer({ minimum: 0, maximum: 100 }),
  not_before: Timestamp,
  workspace_id: Type.Union([Identifier, Type.Null()]),
  last_error: Type.Union([Type.String({ maxLength: 256 }), Type.Null()]),
  created_at: Timestamp,
  updated_at: Timestamp,
}, { additionalProperties: false })

export const ClaimDistillationMarkerSchema = Type.Object({
  bot_id: Identifier,
  lease_owner: Identifier,
}, { additionalProperties: false })

export const ClaimedDistillationMarkerSchema = Type.Object({
  ...DistillationMarkerSchema.properties,
  lease_token: Identifier,
}, { additionalProperties: false })

export const CompleteDistillationMarkerSchema = Type.Object({
  lease_token: Identifier,
  outcome: Type.Union([
    Type.Literal("CANDIDATE_CREATED"),
    Type.Literal("WAITING_FOR_HISTORY"),
    Type.Literal("FAILED"),
  ]),
  content_digest: Type.Optional(Digest),
  error: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
}, { additionalProperties: false })

export const KnowledgeProvenanceSchema = Type.Object({
  bot_id: Identifier,
  thread_id: Identifier,
  turn_ids: Type.Array(Identifier, { minItems: 1, maxItems: 32 }),
  source_revision: Digest,
  classifier_version: Type.Literal(DISTILLATION_CLASSIFIER_VERSION),
  extractor_version: SupportedExtractorVersionSchema,
  evidence: Type.Array(DistillationEvidenceSchema, { maxItems: 16 }),
  excerpt_truncated: Type.Boolean(),
}, { additionalProperties: false })

export const KnowledgeCandidateSchema = Type.Object({
  knowledge_id: Identifier,
  tenant_id: Identifier,
  marker_id: Identifier,
  owner_subject_id: Identifier,
  workspace_id: Type.Union([Identifier, Type.Null()]),
  scope: ScopeSchema,
  knowledge_type: TypeSchema,
  representation: RepresentationSchema,
  sensitivity: SensitivitySchema,
  review_state: Type.Union([
    Type.Literal("PENDING_REVIEW"),
    Type.Literal("APPROVED"),
    Type.Literal("REJECTED"),
  ]),
  content_digest: Digest,
  provenance: KnowledgeProvenanceSchema,
  reviewed_by: Type.Union([Identifier, Type.Null()]),
  reviewed_at: Type.Union([Timestamp, Type.Null()]),
  created_at: Timestamp,
  updated_at: Timestamp,
}, { additionalProperties: false })

export const KnowledgeEvidenceTurnSchema = Type.Object({
  turn_id: Identifier,
  text: Type.String({ maxLength: 96_000 }),
  truncated: Type.Boolean(),
}, { additionalProperties: false })

export const KnowledgeEvidenceSchema = Type.Object({
  knowledge_id: Identifier,
  tenant_id: Identifier,
  workspace_id: Type.Union([Identifier, Type.Null()]),
  content_digest: Digest,
  turns: Type.Array(KnowledgeEvidenceTurnSchema, { minItems: 1, maxItems: 32 }),
}, { additionalProperties: false })

export const DistillationPageQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
}, { additionalProperties: false })

export const DistillationMarkerPageSchema = Type.Object({
  markers: Type.Array(DistillationMarkerSchema, { maxItems: 100 }),
  next_cursor: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false })

export const KnowledgeCandidatePageSchema = Type.Object({
  candidates: Type.Array(KnowledgeCandidateSchema, { maxItems: 100 }),
  next_cursor: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false })

export const DistillationTenantPathSchema = Type.Object({
  tenant_id: Identifier,
}, { additionalProperties: false })

export const DistillationMarkerPathSchema = Type.Object({
  tenant_id: Identifier,
  marker_id: Identifier,
}, { additionalProperties: false })

export const KnowledgeCandidatePathSchema = Type.Object({
  tenant_id: Identifier,
  knowledge_id: Identifier,
}, { additionalProperties: false })

export const TeamWorkspaceSchema = Type.Object({
  workspace_id: Identifier,
  tenant_id: Identifier,
  organization_id: Identifier,
  display_name: Type.String({ minLength: 1, maxLength: 256 }),
  reader_access_group_id: Identifier,
  contributor_access_group_id: Identifier,
  maintainer_access_group_id: Identifier,
  created_at: Timestamp,
  created_by: Identifier,
}, { additionalProperties: false })

export const CreateTeamWorkspaceSchema = Type.Object({
  organization_id: Identifier,
  display_name: Type.String({ minLength: 1, maxLength: 256 }),
  reader_access_group_id: Identifier,
  contributor_access_group_id: Identifier,
  maintainer_access_group_id: Identifier,
}, { additionalProperties: false })

export const TeamWorkspacePathSchema = Type.Object({
  tenant_id: Identifier,
  workspace_id: Identifier,
}, { additionalProperties: false })

export const TeamWorkspaceAccessQuerySchema = Type.Object({
  access: Type.Optional(Type.Literal("contributor")),
}, { additionalProperties: false })

export const AssignKnowledgeWorkspaceSchema = Type.Object({
  workspace_id: Identifier,
}, { additionalProperties: false })

export const ReviewKnowledgeCandidateSchema = Type.Object({
  decision: Type.Union([Type.Literal("APPROVE"), Type.Literal("REJECT")]),
}, { additionalProperties: false })

export const DistillationBotPathSchema = Type.Object({
  tenant_id: Identifier,
  bot_id: Identifier,
}, { additionalProperties: false })

export const CancelDistillationBotSchema = Type.Object({
  bot_id: Identifier,
  cancelled_count: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

export type CancelDistillationBot = Static<typeof CancelDistillationBotSchema>
export type CreateDistillationMarker = Static<typeof CreateDistillationMarkerSchema>
export type DistillationMarker = Static<typeof DistillationMarkerSchema>
export type ClaimedDistillationMarker = Static<typeof ClaimedDistillationMarkerSchema>
export type CompleteDistillationMarker = Static<typeof CompleteDistillationMarkerSchema>
export type KnowledgeCandidate = Static<typeof KnowledgeCandidateSchema>
export type KnowledgeEvidence = Static<typeof KnowledgeEvidenceSchema>
export type TeamWorkspace = Static<typeof TeamWorkspaceSchema>
export type CreateTeamWorkspace = Static<typeof CreateTeamWorkspaceSchema>
export type ReviewKnowledgeCandidate = Static<typeof ReviewKnowledgeCandidateSchema>
export type DistillationProcessingState = Static<typeof ProcessingSchema>
export type DistillationHistoryState = Static<typeof HistorySchema>

export function hasSameImmutableDistillationMarkerPayload(
  marker: DistillationMarker,
  value: CreateDistillationMarker,
  normalized: Pick<DistillationMarker, "scope_hint" | "sensitivity" | "knowledge_type" | "representation">,
): boolean {
  const hasSameRawPayload = marker.bot_id === value.bot_id &&
    marker.thread_id === value.thread_id &&
    marker.source_revision === value.source_revision &&
    marker.content_digest === value.content_digest &&
    hasSameStringItems(marker.turn_ids, value.turn_ids)
  if (!hasSameRawPayload) return false
  const hasSameClassification = marker.scope_hint === normalized.scope_hint &&
    marker.sensitivity === normalized.sensitivity &&
    marker.knowledge_type === normalized.knowledge_type &&
    marker.representation === normalized.representation &&
    marker.excerpt_truncated === value.excerpt_truncated
  if (!hasSameClassification) return false
  if (marker.extractor_version !== value.extractor_version) return true
  return marker.classifier_version === value.classifier_version &&
    hasSameEvidence(marker.evidence, value.evidence)
}

function hasSameStringItems(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function hasSameEvidence(
  left: readonly DistillationMarker["evidence"][number][],
  right: readonly CreateDistillationMarker["evidence"][number][],
): boolean {
  return left.length === right.length && left.every((value, index) => {
    const other = right[index]
    return other !== undefined &&
      value.check_id === other.check_id &&
      value.score === other.score &&
      value.threshold === other.threshold &&
      value.matched === other.matched
  })
}
