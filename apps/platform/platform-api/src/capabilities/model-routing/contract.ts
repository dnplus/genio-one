import { Type } from "typebox"
import type { Static } from "typebox"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })
const Timestamp = Type.Integer({ minimum: 0 })

const ModelRouteModeSchema = Type.Union([
  Type.Literal("DETERMINISTIC"),
  Type.Literal("SESSION_LEASE"),
])

const ClassifierResultSchema = Type.Object({
  mode: Type.Union([Type.Literal("FILTER"), Type.Literal("ORDER")]),
  /** Candidate IDs are PublicModel IDs, never provider model IDs. */
  public_model_ids: Type.Array(Identifier, { minItems: 1 }),
})

export const ResolveModelRouteSchema = Type.Object({
  subject_id: Identifier,
  client_id: Identifier,
  public_model_id: Identifier,
  /** Optional on purpose: stateless requests must not create a lease. */
  session_id: Type.Optional(Identifier),
  requested_public_model_id: Type.Optional(Identifier),
  entitled_public_model_ids: Type.Array(Identifier, { minItems: 1 }),
  lease_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400 })),
  classifier_result: Type.Optional(ClassifierResultSchema),
}, { additionalProperties: false })

export const ModelRouteLeaseSchema = Type.Object({
  tenant_id: Identifier,
  /** Absent for a deterministic, stateless resolution. */
  lease_id: Type.Optional(Identifier),
  subject_id: Identifier,
  client_id: Identifier,
  public_model_id: Identifier,
  /** The alias selected from the entitled candidate set. */
  selected_public_model_id: Identifier,
  session_id: Type.Optional(Identifier),
  mapping_id: Identifier,
  provider_model: Identifier,
  mapping_revision: Type.Integer({ minimum: 1 }),
  resource_id: Identifier,
  connection_id: Identifier,
  issued_at: Timestamp,
  /** Absent when no session lease was requested. */
  expires_at: Type.Optional(Timestamp),
  reused: Type.Boolean(),
  route_mode: ModelRouteModeSchema,
})

export const ModelRoutingPathSchema = Type.Object({
  tenant_id: Identifier,
})

/**
 * A routing policy is a versioned, Resource-owned decision about which
 * stable Public Models may be selected for one capability. Provider
 * model names and credentials deliberately do not belong in this contract;
 * they are resolved later through the Public Model connection mappings.
 */
const RoutingPolicyLeaseSecondsSchema = Type.Union([
  Type.Integer({ minimum: 1, maximum: 86_400 }),
  Type.Null(),
])

const ContextRouteRequirementSchema = Type.Object({
  consumer_organization_id: Identifier,
  use_case_id: Identifier,
  minimum_risk_level: Type.Union([
    Type.Literal("LOW"),
    Type.Literal("MEDIUM"),
    Type.Literal("HIGH"),
    Type.Literal("CRITICAL"),
  ]),
  required_obligation_kinds: Type.Array(Identifier, {
    minItems: 1,
    maxItems: 128,
    uniqueItems: true,
  }),
}, { additionalProperties: false })

export const ModelRoutingPolicySchema = Type.Object({
  tenant_id: Identifier,
  routing_policy_id: Identifier,
  /** Product ownership boundary; tenant_id remains the physical partition. */
  owner_organization_id: Identifier,
  resource_id: Identifier,
  capability_id: Identifier,
  routing_revision: Type.Integer({ minimum: 1 }),
  mode: ModelRouteModeSchema,
  /** Ordered internal PublicModel IDs. The order is part of the policy. */
  candidate_public_model_ids: Type.Array(Identifier, { minItems: 1, uniqueItems: true }),
  default_public_model_id: Identifier,
  /** Required for SESSION_LEASE and null for DETERMINISTIC. */
  session_lease_seconds: RoutingPolicyLeaseSecondsSchema,
  context_requirements: Type.Optional(Type.Array(ContextRouteRequirementSchema, { maxItems: 128 })),
  created_at: Timestamp,
  updated_at: Timestamp,
}, { additionalProperties: false })

/** Input for an immutable routing-policy revision. The system creates the ID. */
export const CreateModelRoutingPolicySchema = Type.Object({
  owner_organization_id: Identifier,
  resource_id: Identifier,
  capability_id: Identifier,
  routing_revision: Type.Integer({ minimum: 1 }),
  mode: ModelRouteModeSchema,
  candidate_public_model_ids: Type.Array(Identifier, { minItems: 1, uniqueItems: true }),
  default_public_model_id: Identifier,
  session_lease_seconds: RoutingPolicyLeaseSecondsSchema,
  context_requirements: Type.Optional(Type.Array(ContextRouteRequirementSchema, { maxItems: 128 })),
}, { additionalProperties: false })

export const ModelRoutingPolicyPathSchema = Type.Object({
  tenant_id: Identifier,
  resource_id: Identifier,
  capability_id: Identifier,
})

/** Resource, capability and owner are resolved from the tenant-scoped route. */
export const ModelRoutingPolicyMutationSchema = Type.Object({
  routing_revision: Type.Integer({ minimum: 1 }),
  mode: ModelRouteModeSchema,
  candidate_public_model_ids: Type.Array(Identifier, { minItems: 1, uniqueItems: true }),
  default_public_model_id: Identifier,
  session_lease_seconds: RoutingPolicyLeaseSecondsSchema,
  context_requirements: Type.Optional(Type.Array(ContextRouteRequirementSchema, { maxItems: 128 })),
}, { additionalProperties: false })

export type ResolveModelRouteInput = Static<typeof ResolveModelRouteSchema>
export type ModelRouteLease = Static<typeof ModelRouteLeaseSchema>
export type ClassifierResult = Static<typeof ClassifierResultSchema>
export type ModelRoutingPolicyMode = Static<typeof ModelRouteModeSchema>
export type ModelRoutingPolicy = Static<typeof ModelRoutingPolicySchema>
export type CreateModelRoutingPolicyInput = Static<typeof CreateModelRoutingPolicySchema>
export type ModelRoutingPolicyMutationInput = Static<typeof ModelRoutingPolicyMutationSchema>
export type ContextRouteRequirement = Static<typeof ContextRouteRequirementSchema>
