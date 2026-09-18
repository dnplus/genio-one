import { Type, type Static } from "typebox"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })
const Timestamp = Type.Integer({ minimum: 0 })
const Digest = Type.String({ pattern: "^[a-f0-9]{64}$" })

export const ExecutionGrantRequestSchema = Type.Object({
  tenant_id: Identifier,
  request_id: Identifier,
  revision: Type.Integer({ minimum: 1 }),
  subject_id: Identifier,
  acting_client_id: Identifier,
  resource_id: Identifier,
  capability_id: Identifier,
  action_digest: Digest,
  requested_expires_at: Timestamp,
  state: Type.Union([Type.Literal("PENDING"), Type.Literal("APPROVED"), Type.Literal("DENIED")]),
  created_by_subject_id: Identifier,
  created_at: Timestamp,
  decided_by_subject_id: Type.Union([Identifier, Type.Null()]),
  decided_at: Type.Union([Timestamp, Type.Null()]),
  decision_reason: Type.Union([Type.String(), Type.Null()]),
  execution_grant_id: Type.Union([Identifier, Type.Null()]),
}, { additionalProperties: false })

export const ExecutionGrantSchema = Type.Object({
  tenant_id: Identifier,
  execution_grant_id: Identifier,
  request_id: Identifier,
  subject_id: Identifier,
  acting_client_id: Identifier,
  resource_id: Identifier,
  capability_id: Identifier,
  action_digest: Digest,
  issued_at: Timestamp,
  expires_at: Timestamp,
  issued_by_subject_id: Identifier,
}, { additionalProperties: false })

export const CreateExecutionGrantRequestSchema = Type.Object({
  resource_id: Identifier,
  capability_id: Identifier,
  action_digest: Digest,
  requested_expires_at: Timestamp,
}, { additionalProperties: false })

export const DecideExecutionGrantRequestSchema = Type.Object({
  expected_revision: Type.Integer({ minimum: 1 }),
  decision: Type.Union([Type.Literal("APPROVE"), Type.Literal("DENY")]),
  reason: Type.String({ minLength: 1, maxLength: 4096 }),
}, { additionalProperties: false })

export const ExecutionGrantTenantPathSchema = Type.Object({ tenant_id: Identifier }, { additionalProperties: false })
export const ExecutionGrantRequestPathSchema = Type.Object({ tenant_id: Identifier, request_id: Identifier }, { additionalProperties: false })
export const ExecutionGrantRequestListSchema = Type.Array(ExecutionGrantRequestSchema)

export type ExecutionGrantRequest = Static<typeof ExecutionGrantRequestSchema>
export type ExecutionGrant = Static<typeof ExecutionGrantSchema>
export type CreateExecutionGrantRequestInput = Static<typeof CreateExecutionGrantRequestSchema>
export type DecideExecutionGrantRequestInput = Static<typeof DecideExecutionGrantRequestSchema>
