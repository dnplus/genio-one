import { Type } from "typebox"
import type { Static } from "typebox"
import { PlatformApiErrorResponseSchema } from "../errors"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })

/** Public workflow states are intentionally separate from request decisions. */
const PublicationBuildStateSchema = Type.Union([
  Type.Literal("IDLE"),
  Type.Literal("PENDING_REVIEW"),
  Type.Literal("BUILDING"),
  Type.Literal("FAILED"),
  Type.Literal("READY"),
])

const PublicationAttemptStateSchema = Type.Union([
  Type.Literal("BUILDING"),
  Type.Literal("FAILED"),
  Type.Literal("READY"),
])

const PublicationReviewDecisionSchema = Type.Union([
  Type.Literal("APPROVE"),
  Type.Literal("REJECT"),
])

export const PublicationWorkflowRequestSchema = Type.Object({
  publication_id: Identifier,
  request_id: Identifier,
  state: Type.Union([
    Type.Literal("PENDING"),
    Type.Literal("APPROVED"),
    Type.Literal("REJECTED"),
    Type.Literal("CANCELLED"),
  ]),
  publication_state: PublicationBuildStateSchema,
  requested_by: Identifier,
  requested_at: Type.Integer({ minimum: 0 }),
  reviewed_by: Type.Union([Identifier, Type.Null()]),
  reviewed_at: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  attempt_id: Type.Union([Identifier, Type.Null()]),
  failure_code: Type.Union([Identifier, Type.Null()]),
})

export const PublicationWorkflowRequestBodySchema = Type.Object({
  requested_by: Type.Optional(Identifier),
}, { additionalProperties: false })

export const PublicationWorkflowReviewBodySchema = Type.Object({
  decision: PublicationReviewDecisionSchema,
  reviewer_id: Type.Optional(Identifier),
}, { additionalProperties: false })

export const PublicationWorkflowRequestPathSchema = Type.Object({
  tenant_id: Identifier,
  resource_id: Identifier,
})

export const PublicationWorkflowReviewPathSchema = Type.Object({
  tenant_id: Identifier,
  resource_id: Identifier,
  request_id: Identifier,
})

export const PublicationWorkflowErrorSchema = PlatformApiErrorResponseSchema

export type PublicationBuildState = Static<typeof PublicationBuildStateSchema>
export type PublicationAttemptState = Static<typeof PublicationAttemptStateSchema>
export type PublicationReviewDecision = Static<typeof PublicationReviewDecisionSchema>
export type PublicationWorkflowRequest = Static<typeof PublicationWorkflowRequestSchema>
export type PublicationWorkflowRequestBody = Static<typeof PublicationWorkflowRequestBodySchema>
export type PublicationWorkflowReviewBody = Static<typeof PublicationWorkflowReviewBodySchema>
