import { Type } from "typebox"
import type { Static } from "typebox"
import { ModelCandidateEffectSchema } from "../../../../../../runtimes/gateway/services/shared/model-candidate-effect"
export type { ModelCandidateEffect as CandidateEffect } from "../../../../../../runtimes/gateway/services/shared/model-candidate-effect"

const Identifier = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^(?!\\s)(?!.*\\s$)[^\\u0000\\r\\n]+$",
})
const ActionConfig = Type.Record(Type.String({ minLength: 1 }), Type.Unknown())

/**
 * Versioned, implementation-neutral input for the native JWT authenticator.
 * The compiler maps this shape to Envoy Gateway's JWTProvider rather than
 * exposing Envoy's CRD vocabulary to One Policy authors.
 */
const NativeJwtAuthenticationConfigSchema = Type.Object(
  {
    schema_version: Type.Literal("genio.one.auth.jwt.v1"),
    provider: Type.String({
      minLength: 1,
      maxLength: 63,
      pattern: "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$",
    }),
    issuer: Type.String({ minLength: 1, maxLength: 2048 }),
    audiences: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
      minItems: 1,
      uniqueItems: true,
    }),
    remote_jwks_uri: Type.String({ minLength: 1, maxLength: 2048 }),
    subject_claim: Type.String({
      minLength: 1,
      maxLength: 256,
      pattern: "^[A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]+)*$",
    }),
    client_claim: Type.String({
      minLength: 1,
      maxLength: 256,
      pattern: "^[A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]+)*$",
    }),
  },
  { additionalProperties: false },
)

const ProcessActionSchema = Type.Object(
  {
    action: Identifier,
    effect: Type.Optional(ModelCandidateEffectSchema),
    config: Type.Optional(ActionConfig),
  },
  { additionalProperties: false },
)

const ObserveActionSchema = Type.Object(
  {
    action: Identifier,
    config: Type.Optional(ActionConfig),
  },
  { additionalProperties: false },
)

const StepDependencies = Type.Optional(Type.Array(Identifier, { uniqueItems: true }))

const AuthenticateStepSchema = Type.Object(
  {
    step_id: Identifier,
    kind: Type.Literal("AUTHENTICATE"),
    phase: Type.Literal("REQUEST"),
    implementation: Type.Literal("NATIVE"),
    depends_on: StepDependencies,
    config: NativeJwtAuthenticationConfigSchema,
  },
  { additionalProperties: false },
)

const AuthorizeStepSchema = Type.Object(
  {
    step_id: Identifier,
    kind: Type.Literal("AUTHORIZE"),
    phase: Type.Literal("REQUEST"),
    implementation: Type.Literal("EXT_AUTH"),
    depends_on: StepDependencies,
    config: Type.Optional(ActionConfig),
  },
  { additionalProperties: false },
)

const ProcessStepSchema = Type.Object(
  {
    step_id: Identifier,
    kind: Type.Literal("PROCESS"),
    /** Product-owned processing seam. The projection compiler chooses the
     * concrete Envoy integration and One Policy remains CRD-neutral. */
    implementation: Type.Literal("PROCESSOR"),
    depends_on: StepDependencies,
    hooks: Type.Object(
      {
        request: Type.Optional(ProcessActionSchema),
        response: Type.Optional(ProcessActionSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)

const RouteStepSchema = Type.Object(
  {
    step_id: Identifier,
    kind: Type.Literal("ROUTE"),
    phase: Type.Literal("ROUTING"),
    implementation: Type.Literal("AIGW_NATIVE"),
    depends_on: StepDependencies,
    config: Type.Optional(ActionConfig),
  },
  { additionalProperties: false },
)

const ObserveStepSchema = Type.Object(
  {
    step_id: Identifier,
    kind: Type.Literal("OBSERVE"),
    implementation: Type.Literal("NATIVE_OTEL"),
    depends_on: StepDependencies,
    hooks: Type.Object(
      {
        request: Type.Optional(ObserveActionSchema),
        attempt: Type.Optional(ObserveActionSchema),
        response: Type.Optional(ObserveActionSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)

const EnforcementStepSchema = Type.Union([
  AuthenticateStepSchema,
  AuthorizeStepSchema,
  ProcessStepSchema,
  RouteStepSchema,
  ObserveStepSchema,
])

export const CompileEnforcementChainSchema = Type.Object(
  {
    resource_id: Identifier,
    capability_id: Identifier,
    /**
     * The candidate set is frozen with the chain revision.  A Connection is a
     * provider endpoint selected by Route; it is not the owner of this chain.
     */
    eligible_connection_ids: Type.Array(Identifier, { minItems: 1, uniqueItems: true }),
    one_policy_revision: Type.Integer({ minimum: 1 }),
    steps: Type.Array(EnforcementStepSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
)

export const CompiledEnforcementChainSchema = Type.Object(
  {
    chain_id: Identifier,
    tenant_id: Identifier,
    resource_id: Identifier,
    capability_id: Identifier,
    eligible_connection_ids: Type.Array(Identifier, { minItems: 1, uniqueItems: true }),
    one_policy_revision: Type.Integer({ minimum: 1 }),
    steps: Type.Array(EnforcementStepSchema),
    request_filter_order: Type.Array(Identifier),
    response_filter_order: Type.Array(Identifier),
  },
  { additionalProperties: false },
)

export const EnforcementChainMutationBodySchema = Type.Object({
  one_policy_revision: Type.Integer({ minimum: 1 }),
  eligible_connection_ids: Type.Optional(Type.Array(Identifier, { uniqueItems: true })),
  steps: Type.Array(EnforcementStepSchema, { minItems: 1 }),
}, { additionalProperties: false })

export const EnforcementChainPathSchema = Type.Object({
  tenant_id: Identifier,
  resource_id: Identifier,
  capability_id: Identifier,
})

export const EnforcementChainRevisionSchema = Type.Object({
  tenant_id: Identifier,
  resource_id: Identifier,
  capability_id: Identifier,
  one_policy_revision: Type.Integer({ minimum: 1 }),
  chain: CompiledEnforcementChainSchema,
  chain_digest: Type.String({ minLength: 64, maxLength: 64 }),
  created_at: Type.Integer({ minimum: 0 }),
  updated_at: Type.Integer({ minimum: 0 }),
})
const EnforcementChainInventoryItemSchema = Type.Object({
  tenant_id: Identifier,
  resource_id: Identifier,
  capability_id: Identifier,
  one_policy_revision: Type.Integer({ minimum: 1 }),
  status: Type.Union([Type.Literal("READY"), Type.Literal("MIGRATION_REQUIRED")]),
  revision: Type.Union([EnforcementChainRevisionSchema, Type.Null()]),
  issue_code: Type.Union([Identifier, Type.Null()]),
}, { additionalProperties: false })
export const EnforcementChainInventorySchema = Type.Array(EnforcementChainInventoryItemSchema)

export type NativeJwtAuthenticationConfig = Static<typeof NativeJwtAuthenticationConfigSchema>
export type ProcessAction = Static<typeof ProcessActionSchema>
export type ObserveAction = Static<typeof ObserveActionSchema>
export type EnforcementStep = Static<typeof EnforcementStepSchema>
export type ProcessStep = Static<typeof ProcessStepSchema>
export type ObserveStep = Static<typeof ObserveStepSchema>
export type CompileEnforcementChainInput = Static<typeof CompileEnforcementChainSchema>
export type CompiledEnforcementChain = Static<typeof CompiledEnforcementChainSchema>
export type EnforcementChainMutationBody = Static<typeof EnforcementChainMutationBodySchema>
export type EnforcementChainRevision = Static<typeof EnforcementChainRevisionSchema>
export type EnforcementChainInventoryItem = Static<typeof EnforcementChainInventoryItemSchema>
export type EnforcementChainRevisionKey = {
  tenantId: string
  resourceId: string
  capabilityId: string
  onePolicyRevision: number
}
