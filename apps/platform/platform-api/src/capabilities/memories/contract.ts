import { Type, type Static } from "typebox"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })
const Timestamp = Type.Integer({ minimum: 0 })
const Revision = Type.Integer({ minimum: 1 })
const ExpectedRevision = Type.Integer({ minimum: 0 })
const MemoryContent = Type.String({ minLength: 1, maxLength: 12_000 })
const MemoryKey = Type.String({ minLength: 1, maxLength: 256 })
const Query = Type.String({ minLength: 1, maxLength: 512 })
export const SharedMemoryIdempotencyKeySchema = Type.String({
  minLength: 36,
  maxLength: 36,
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
})

export const SharedMemoryScopeSchema = Type.Union([
  Type.Literal("PERSONAL"),
  Type.Literal("TEAM"),
  Type.Literal("ORGANIZATION"),
])

const SharedMemoryTeamScopeSelectorSchema = Type.Object({
  scope: Type.Literal("TEAM"),
  workspace_id: Identifier,
}, { additionalProperties: false })

const SharedMemoryOrganizationScopeSelectorSchema = Type.Object({
  scope: Type.Literal("ORGANIZATION"),
  organization_id: Identifier,
}, { additionalProperties: false })

export const SharedMemoryScopeSelectorSchema = Type.Union([
  SharedMemoryTeamScopeSelectorSchema,
  SharedMemoryOrganizationScopeSelectorSchema,
])

export const MemoryTargetSelectorSchema = Type.Union([
  Type.Object({
    scope: Type.Literal("PERSONAL"),
  }, { additionalProperties: false }),
  SharedMemoryTeamScopeSelectorSchema,
  SharedMemoryOrganizationScopeSelectorSchema,
])

export const MemoryScopeSchema = Type.Object({
  target: MemoryTargetSelectorSchema,
  display_name: Type.String({ minLength: 1, maxLength: 256 }),
  can_read: Type.Boolean(),
  can_contribute: Type.Boolean(),
  can_manage: Type.Boolean(),
}, { additionalProperties: false })

export const SharedMemoryKindSchema = Type.Union([
  Type.Literal("preference"),
  Type.Literal("fact"),
  Type.Literal("decision"),
])

export const SharedMemoryAssertionOriginSchema = Type.Union([
  Type.Literal("USER_EXPLICIT"),
  Type.Literal("AGENT_INFERRED"),
])

export const SharedMemoryContextKindSchema = Type.Union([
  Type.Literal("GLOBAL"),
  Type.Literal("PROJECT"),
  Type.Literal("CONTEXT"),
])

export const SharedMemoryContextSchema = Type.Object({
  kind: SharedMemoryContextKindSchema,
  context_id: Type.Union([Identifier, Type.Null()]),
}, { additionalProperties: false })

export const SharedMemorySourceSchema = Type.Object({
  actor_subject_id: Identifier,
  client_id: Identifier,
  agent_id: Type.Union([Identifier, Type.Null()]),
  agent_grant_id: Type.Union([Identifier, Type.Null()]),
  reference_id: Type.Union([Identifier, Type.Null()]),
}, { additionalProperties: false })

export const SharedMemoryConfirmationSchema = Type.Object({
  confirmed: Type.Literal(true),
  reviewed_at: Timestamp,
}, { additionalProperties: false })

export const SharedMemoryMutationConfirmationSchema = Type.Object({
  reviewer_subject_id: Identifier,
  reviewer_client_id: Identifier,
  reviewed_at: Timestamp,
}, { additionalProperties: false })

const SharedMemoryProperties = {
  memory_id: Identifier,
  tenant_id: Identifier,
  scope: SharedMemoryScopeSchema,
  owner_subject_id: Type.Union([Identifier, Type.Null()]),
  team_id: Type.Union([Identifier, Type.Null()]),
  organization_id: Type.Union([Identifier, Type.Null()]),
  key: MemoryKey,
  kind: SharedMemoryKindSchema,
  context: SharedMemoryContextSchema,
  content: MemoryContent,
  assertion_origin: SharedMemoryAssertionOriginSchema,
  source: SharedMemorySourceSchema,
  revision: Revision,
  created_at: Timestamp,
  updated_at: Timestamp,
}

export const SharedMemorySchema = Type.Object({
  ...SharedMemoryProperties,
  confirmation: Type.Union([SharedMemoryConfirmationSchema, Type.Null()]),
}, { additionalProperties: false })

export const RetrievedSharedMemorySchema = Type.Object({
  ...SharedMemoryProperties,
  confirmed: Type.Boolean(),
  content_truncated: Type.Boolean(),
  conflict: Type.Boolean(),
}, { additionalProperties: false })

export const SharedMemoryContextResultSchema = Type.Object({
  memories: Type.Array(RetrievedSharedMemorySchema, { maxItems: 20 }),
  context: Type.String({ maxLength: 16_000 }),
}, { additionalProperties: false })

export const MemoryTargetContextResultSchema = Type.Object({
  ...SharedMemoryContextResultSchema.properties,
  precedence: Type.Literal("NONE"),
}, { additionalProperties: false })

export const PersonalMemoryAgentGrantSchema = Type.Object({
  tenant_id: Identifier,
  owner_subject_id: Identifier,
  agent_id: Identifier,
  grant_id: Identifier,
  enabled_at: Timestamp,
  revoked_at: Type.Union([Timestamp, Type.Null()]),
}, { additionalProperties: false })

export const PersonalMemoryEnableAgentSchema = Type.Object({
  agent_id: Identifier,
}, { additionalProperties: false })

export const PersonalMemoryRevokeAgentSchema = Type.Object({
  agent_id: Identifier,
}, { additionalProperties: false })

export const PersonalMemoryAgentListSchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
}, { additionalProperties: false })

export const PersonalMemoryAgentListResultSchema = Type.Object({
  agents: Type.Array(PersonalMemoryAgentGrantSchema, { maxItems: 100 }),
  next_cursor: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
}, { additionalProperties: false })

export const PersonalMemoryCommandSchema = Type.Object({
  memory_id: Type.Optional(Identifier),
  expected_revision: ExpectedRevision,
  idempotency_key: SharedMemoryIdempotencyKeySchema,
  key: MemoryKey,
  kind: SharedMemoryKindSchema,
  context: Type.Optional(SharedMemoryContextSchema),
  content: MemoryContent,
  source_reference_id: Type.Optional(Identifier),
}, { additionalProperties: false })

export const PersonalMemoryDeleteSchema = Type.Object({
  memory_id: Identifier,
  expected_revision: Revision,
  idempotency_key: SharedMemoryIdempotencyKeySchema,
}, { additionalProperties: false })

export const PersonalMemoryListSchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  context: Type.Optional(SharedMemoryContextSchema),
}, { additionalProperties: false })

export const PersonalMemoryRetrieveSchema = Type.Object({
  query: Type.Optional(Query),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  max_context_chars: Type.Optional(Type.Integer({ minimum: 1, maximum: 16_000 })),
  context: Type.Optional(SharedMemoryContextSchema),
}, { additionalProperties: false })

export const MemoryTargetRetrieveSchema = Type.Object({
  targets: Type.Optional(Type.Array(MemoryTargetSelectorSchema, { minItems: 1, maxItems: 20 })),
  query: Type.Optional(Query),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  max_context_chars: Type.Optional(Type.Integer({ minimum: 1, maximum: 16_000 })),
  context: Type.Optional(SharedMemoryContextSchema),
}, { additionalProperties: false })

export const SharedMemoryProposalStatusSchema = Type.Union([
  Type.Literal("PENDING"),
  Type.Literal("ACCEPTED"),
  Type.Literal("REJECTED"),
  Type.Literal("STALE"),
])

export const SharedMemoryCorrectionProposalSchema = Type.Object({
  proposal_id: Identifier,
  tenant_id: Identifier,
  memory_id: Identifier,
  scope: SharedMemoryScopeSchema,
  owner_subject_id: Type.Union([Identifier, Type.Null()]),
  team_id: Type.Union([Identifier, Type.Null()]),
  organization_id: Type.Union([Identifier, Type.Null()]),
  base_revision: Revision,
  proposed_kind: SharedMemoryKindSchema,
  proposed_content: Type.Union([MemoryContent, Type.Null()]),
  source: SharedMemorySourceSchema,
  status: SharedMemoryProposalStatusSchema,
  reviewer_subject_id: Type.Union([Identifier, Type.Null()]),
  created_at: Timestamp,
  resolved_at: Type.Union([Timestamp, Type.Null()]),
}, { additionalProperties: false })

export const SharedMemoryCorrectionProposalCommandSchema = Type.Object({
  expected_revision: Revision,
  idempotency_key: SharedMemoryIdempotencyKeySchema,
  content: MemoryContent,
  source_reference_id: Type.Optional(Identifier),
}, { additionalProperties: false })

export const SharedMemoryCorrectionProposalListSchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  status: Type.Optional(SharedMemoryProposalStatusSchema),
}, { additionalProperties: false })

export const SharedMemoryCorrectionProposalListResultSchema = Type.Object({
  proposals: Type.Array(SharedMemoryCorrectionProposalSchema, { maxItems: 100 }),
  next_cursor: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
}, { additionalProperties: false })

export const SharedMemoryCorrectionProposalReviewActionSchema = Type.Union([
  Type.Literal("ACCEPT"),
  Type.Literal("REJECT"),
])

export const SharedMemoryCorrectionProposalReviewSchema = Type.Object({
  action: SharedMemoryCorrectionProposalReviewActionSchema,
}, { additionalProperties: false })

export const SharedMemoryCorrectionProposalReviewResultSchema = Type.Object({
  proposal: SharedMemoryCorrectionProposalSchema,
  memory: Type.Union([SharedMemorySchema, Type.Null()]),
}, { additionalProperties: false })

export const SharedMemoryWriteResultSchema = Type.Union([
  Type.Object({
    result: Type.Literal("MEMORY"),
    memory: SharedMemorySchema,
  }, { additionalProperties: false }),
  Type.Object({
    result: Type.Literal("PROPOSAL"),
    proposal: SharedMemoryCorrectionProposalSchema,
  }, { additionalProperties: false }),
])

export const MemoryScopeListResultSchema = Type.Object({
  scopes: Type.Array(MemoryScopeSchema, { maxItems: 1_000 }),
}, { additionalProperties: false })

export const SharedMemoryDeletionSchema = Type.Object({
  memory_id: Identifier,
  scope: SharedMemoryScopeSchema,
  owner_subject_id: Type.Union([Identifier, Type.Null()]),
  deleted_revision: Revision,
  deleted_at: Timestamp,
}, { additionalProperties: false })

export const SharedMemoryMutationMetadataSchema = Type.Object({
  mutation_id: Identifier,
  tenant_id: Identifier,
  memory_id: Identifier,
  scope: SharedMemoryScopeSchema,
  owner_subject_id: Type.Union([Identifier, Type.Null()]),
  actor_subject_id: Identifier,
  client_id: Identifier,
  agent_id: Type.Union([Identifier, Type.Null()]),
  agent_grant_id: Type.Union([Identifier, Type.Null()]),
  operation: Type.Union([
    Type.Literal("CREATED"),
    Type.Literal("REPLACED"),
    Type.Literal("DELETED"),
  ]),
  previous_revision: ExpectedRevision,
  revision: Revision,
  assertion_origin: SharedMemoryAssertionOriginSchema,
  confirmation: Type.Union([SharedMemoryMutationConfirmationSchema, Type.Null()]),
  occurred_at: Timestamp,
}, { additionalProperties: false })

export type SharedMemoryScope = Static<typeof SharedMemoryScopeSchema>
export type SharedMemoryScopeSelector = Static<typeof SharedMemoryScopeSelectorSchema>
export type MemoryTargetSelector = Static<typeof MemoryTargetSelectorSchema>
export type MemoryScope = Static<typeof MemoryScopeSchema>
export type SharedMemoryKind = Static<typeof SharedMemoryKindSchema>
export type SharedMemoryAssertionOrigin = Static<typeof SharedMemoryAssertionOriginSchema>
export type SharedMemoryContextKind = Static<typeof SharedMemoryContextKindSchema>
export type SharedMemoryContext = Static<typeof SharedMemoryContextSchema>
export type SharedMemorySource = Static<typeof SharedMemorySourceSchema>
export type SharedMemoryConfirmation = Static<typeof SharedMemoryConfirmationSchema>
export type SharedMemoryMutationConfirmation = Static<typeof SharedMemoryMutationConfirmationSchema>
export type SharedMemory = Static<typeof SharedMemorySchema>
export type RetrievedSharedMemory = Static<typeof RetrievedSharedMemorySchema>
export type SharedMemoryContextResult = Static<typeof SharedMemoryContextResultSchema>
export type MemoryTargetContextResult = Static<typeof MemoryTargetContextResultSchema>
export type PersonalMemoryAgentGrant = Static<typeof PersonalMemoryAgentGrantSchema>
export type PersonalMemoryEnableAgent = Static<typeof PersonalMemoryEnableAgentSchema>
export type PersonalMemoryRevokeAgent = Static<typeof PersonalMemoryRevokeAgentSchema>
export type PersonalMemoryAgentList = Static<typeof PersonalMemoryAgentListSchema>
export type PersonalMemoryAgentListResult = Static<typeof PersonalMemoryAgentListResultSchema>
export type PersonalMemoryCommand = Static<typeof PersonalMemoryCommandSchema>
export type PersonalMemoryDelete = Static<typeof PersonalMemoryDeleteSchema>
export type PersonalMemoryList = Static<typeof PersonalMemoryListSchema>
export type PersonalMemoryRetrieve = Static<typeof PersonalMemoryRetrieveSchema>
export type MemoryTargetRetrieve = Static<typeof MemoryTargetRetrieveSchema>
export type SharedMemoryProposalStatus = Static<typeof SharedMemoryProposalStatusSchema>
export type SharedMemoryCorrectionProposal = Static<typeof SharedMemoryCorrectionProposalSchema>
export type SharedMemoryCorrectionProposalCommand = Static<typeof SharedMemoryCorrectionProposalCommandSchema>
export type SharedMemoryCorrectionProposalList = Static<typeof SharedMemoryCorrectionProposalListSchema>
export type SharedMemoryCorrectionProposalListResult = Static<typeof SharedMemoryCorrectionProposalListResultSchema>
export type SharedMemoryCorrectionProposalReviewAction = Static<typeof SharedMemoryCorrectionProposalReviewActionSchema>
export type SharedMemoryCorrectionProposalReview = Static<typeof SharedMemoryCorrectionProposalReviewSchema>
export type SharedMemoryCorrectionProposalReviewResult = Static<typeof SharedMemoryCorrectionProposalReviewResultSchema>
export type SharedMemoryWriteResult = Static<typeof SharedMemoryWriteResultSchema>
export type SharedMemoryDeletion = Static<typeof SharedMemoryDeletionSchema>
export type SharedMemoryMutationMetadata = Static<typeof SharedMemoryMutationMetadataSchema>
