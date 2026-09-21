import { createHash } from "node:crypto"

import { Type, type Static, type TProperties } from "typebox"
import { Check } from "typebox/value"
import { canonicalBytes, compareUtf8 } from "@genioone/protocol/canonical"

/**
 * Runtime-neutral, immutable routing input. The aggregate release wraps this
 * payload in compact JWS; the payload must not carry its own signature or the
 * release ID that is derived from its bytes.
 */
const GATEWAY_ROUTING_ARTIFACT_SCHEMA_VERSION =
  "genio.one.gateway-routing.v1" as const

const Identifier = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^(?!\\s)(?!.*\\s$)[^\\u0000-\\u001f\\u007f]+$",
})
const ProviderModelIdentifier = Type.String({
  minLength: 1,
  maxLength: 512,
  pattern: "^(?!\\s)(?!.*\\s$)[^\\u0000-\\u001f\\u007f]+$",
})
const PositiveRevision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
const AttemptCount = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
const Timestamp = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
const Sha256Digest = Type.String({ pattern: "^[a-f0-9]{64}$" })

const StrictObject = <Properties extends TProperties>(properties: Properties) =>
  Type.Object(properties, { additionalProperties: false })

const GatewayRoutingModeSchema = Type.Union([
  Type.Literal("DETERMINISTIC"),
  Type.Literal("SESSION_LEASE"),
])

const GatewayRoutingSessionLeaseSchema = StrictObject({
  ttl_seconds: Type.Integer({ minimum: 1, maximum: 86_400 }),
  key_scope: Type.Literal("TENANT_SUBJECT_CLIENT_RESOURCE_CAPABILITY_SESSION"),
})

/** One native provider fallback for a Public Model. */
const GatewayRoutingConnectionMappingSchema = StrictObject({
  order: PositiveRevision,
  mapping_id: Identifier,
  resource_id: Identifier,
  connection_id: Identifier,
  provider_model: ProviderModelIdentifier,
  mapping_revision: PositiveRevision,
  connection_configuration_revision: Type.Optional(PositiveRevision),
  provider_credential_profile_id: Type.Optional(Identifier),
  provider_credential_profile_revision: Type.Optional(PositiveRevision),
  provider_credential_strategy_digest: Type.Optional(Sha256Digest),
  priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })),
  region: Type.Optional(Type.Union([Identifier, Type.Null()])),
  supported_obligations: Type.Optional(Type.Array(Identifier, { maxItems: 128 })),
  health_observed_at: Type.Optional(Timestamp),
  health_source_revision: Type.Optional(PositiveRevision),
  pricing: Type.Optional(StrictObject({
    currency: Type.String({ pattern: "^[A-Z]{3}$" }),
    input_cost_per_token_micros: Type.Number({ minimum: 0 }),
    output_cost_per_token_micros: Type.Number({ minimum: 0 }),
    source: Identifier,
    version: Identifier,
  })),
})

const GatewayRoutingRetryPolicySchema = StrictObject({
  per_priority_max_attempts: Type.Literal(1),
  max_attempts: AttemptCount,
  retry_on: Type.Array(Type.Union([
    Type.Literal("CONNECT_FAILURE"),
    Type.Literal("RESET_BEFORE_RESPONSE"),
  ]), { minItems: 2, maxItems: 2 }),
  http_5xx: Type.Literal("IDEMPOTENT_ONLY"),
  streaming: Type.Literal("BEFORE_FIRST_TOKEN_ONLY"),
})

/**
 * PublicModel ID is the internal relationship key. PublicModel name is the
 * stable alias carried by x-ai-eg-model. Provider model is never accepted
 * from a Client and only appears inside a Connection mapping.
 */
const GatewayRoutingPublicModelCandidateSchema = StrictObject({
  order: PositiveRevision,
  public_model_id: Identifier,
  public_model_name: Identifier,
  mappings: Type.Array(GatewayRoutingConnectionMappingSchema, {
    minItems: 0,
    maxItems: 4_096,
  }),
})

const GatewayRoutingScopeSchema = StrictObject({
  owner_organization_id: Identifier,
  resource_id: Identifier,
  capability_id: Identifier,
  routing_policy_id: Identifier,
  routing_revision: PositiveRevision,
  one_policy_revision: PositiveRevision,
  route_mode: GatewayRoutingModeSchema,
  default_public_model_id: Identifier,
  candidate_set_digest: Sha256Digest,
  required_obligation_kinds: Type.Optional(Type.Array(Identifier, { maxItems: 128 })),
  context_requirements: Type.Optional(Type.Array(StrictObject({
    consumer_organization_id: Identifier,
    use_case_id: Identifier,
    minimum_risk_level: Type.Union([
      Type.Literal("LOW"),
      Type.Literal("MEDIUM"),
      Type.Literal("HIGH"),
      Type.Literal("CRITICAL"),
    ]),
    required_obligation_kinds: Type.Array(Identifier, { minItems: 1, maxItems: 128 }),
  }), { maxItems: 128 })),
  retry_policy: Type.Optional(GatewayRoutingRetryPolicySchema),
  session_lease: Type.Optional(GatewayRoutingSessionLeaseSchema),
  candidates: Type.Array(GatewayRoutingPublicModelCandidateSchema, {
    minItems: 1,
    maxItems: 4_096,
  }),
})

export const GatewayRoutingArtifactSchema = StrictObject({
  schema_version: Type.Literal(GATEWAY_ROUTING_ARTIFACT_SCHEMA_VERSION),
  tenant_id: Identifier,
  gateway_id: Identifier,
  /** Common immutable artifact revision shared with authorization/processor bundles. */
  revision: Identifier,
  policy_version: Identifier,
  issued_at: Timestamp,
  expires_at: Timestamp,
  scopes: Type.Array(GatewayRoutingScopeSchema, { maxItems: 4_096 }),
})

export type GatewayRoutingMode = Static<typeof GatewayRoutingModeSchema>
export type GatewayRoutingSessionLease = Static<typeof GatewayRoutingSessionLeaseSchema>
export type GatewayRoutingConnectionMapping = Static<
  typeof GatewayRoutingConnectionMappingSchema
>
export type GatewayRoutingPublicModelCandidate = Static<
  typeof GatewayRoutingPublicModelCandidateSchema
>
export type GatewayRoutingScope = Static<typeof GatewayRoutingScopeSchema>
export type GatewayRoutingArtifact = Static<typeof GatewayRoutingArtifactSchema>

const RISK_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 } as const

export function narrowGatewayRoutingScopeByObligations(
  scope: GatewayRoutingScope,
  requiredObligations: readonly string[],
): GatewayRoutingScope {
  const obligations = [...new Set([
    ...(scope.required_obligation_kinds ?? []),
    ...requiredObligations,
  ])].sort(compareUtf8)
  const candidates = scope.candidates.map((candidate) => ({
    ...candidate,
    mappings: candidate.mappings.filter((mapping) =>
      obligations.every((obligation) => mapping.supported_obligations?.includes(obligation))
    ).map((mapping, index) => ({ ...mapping, order: index + 1 })),
  }))
  return {
    ...scope,
    required_obligation_kinds: obligations,
    candidate_set_digest: gatewayRoutingCandidateSetDigest(candidates),
    retry_policy: scope.retry_policy
      ? {
          ...scope.retry_policy,
          max_attempts: candidates.reduce((total, candidate) => total + candidate.mappings.length, 0),
        }
      : undefined,
    candidates,
  }
}

export function contextualGatewayRoutingScope(
  scope: GatewayRoutingScope,
  consumerOrganizationId: string | undefined,
  useCaseId: string | undefined,
  riskLevel: keyof typeof RISK_RANK | undefined,
): GatewayRoutingScope {
  if (!consumerOrganizationId || !useCaseId || !riskLevel) {
    return narrowGatewayRoutingScopeByObligations(scope, [])
  }
  const required = (scope.context_requirements ?? [])
    .filter((requirement) =>
      requirement.consumer_organization_id === consumerOrganizationId &&
      requirement.use_case_id === useCaseId &&
      RISK_RANK[riskLevel] >= RISK_RANK[requirement.minimum_risk_level]
    )
    .flatMap((requirement) => requirement.required_obligation_kinds)
  return narrowGatewayRoutingScopeByObligations(scope, required)
}

export type GatewayRoutingArtifactValidationCode =
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "INVALID_ARTIFACT"
  | "INVALID_SEMANTICS"
  | "CANDIDATE_SET_DIGEST_MISMATCH"

export class GatewayRoutingArtifactValidationError extends Error {
  constructor(
    readonly code: GatewayRoutingArtifactValidationCode,
    message: string,
  ) {
    super(message)
    this.name = "GatewayRoutingArtifactValidationError"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

const canonicalGatewayRoutingArtifactBytes = canonicalBytes

export function gatewayRoutingCandidateSetDigest(
  candidates: readonly GatewayRoutingPublicModelCandidate[],
): string {
  return createHash("sha256")
    .update(canonicalGatewayRoutingArtifactBytes(candidates))
    .digest("hex")
}

function invalidSemantics(message: string): never {
  throw new GatewayRoutingArtifactValidationError("INVALID_SEMANTICS", message)
}

function assertContiguousOrder(
  entries: readonly { order: number }[],
  label: string,
): void {
  entries.forEach((entry, index) => {
    if (entry.order !== index + 1) {
      invalidSemantics(`${label} order must be contiguous and match array order`)
    }
  })
}

export function validateGatewayRoutingArtifact(input: unknown): GatewayRoutingArtifact {
  if (
    isRecord(input) &&
    input.schema_version !== undefined &&
    input.schema_version !== GATEWAY_ROUTING_ARTIFACT_SCHEMA_VERSION
  ) {
    throw new GatewayRoutingArtifactValidationError(
      "UNSUPPORTED_SCHEMA_VERSION",
      `Unsupported Gateway Routing Artifact schema version: ${String(input.schema_version)}`,
    )
  }
  if (!Check(GatewayRoutingArtifactSchema, input)) {
    throw new GatewayRoutingArtifactValidationError(
      "INVALID_ARTIFACT",
      "Gateway Routing Artifact is invalid",
    )
  }

  const artifact = input as GatewayRoutingArtifact
  if (artifact.expires_at <= artifact.issued_at) {
    invalidSemantics("Gateway Routing Artifact expiry must be after issue time")
  }

  const scopeKeys = new Set<string>()
  const policyKeys = new Set<string>()
  const mappingIds = new Set<string>()
  for (const scope of artifact.scopes) {
    const scopeKey = `${scope.resource_id}\u0000${scope.capability_id}`
    if (scopeKeys.has(scopeKey)) invalidSemantics(`Duplicate route scope: ${scopeKey}`)
    scopeKeys.add(scopeKey)

    const policyKey = `${scope.routing_policy_id}\u0000${scope.routing_revision}`
    if (policyKeys.has(policyKey)) invalidSemantics(`Duplicate routing policy revision: ${policyKey}`)
    policyKeys.add(policyKey)

    if (scope.route_mode === "DETERMINISTIC" && scope.session_lease !== undefined) {
      invalidSemantics("Deterministic route scopes cannot carry session lease settings")
    }
    if (scope.route_mode === "SESSION_LEASE" && scope.session_lease === undefined) {
      invalidSemantics("Session-lease route scopes require session lease settings")
    }
    const baseObligations = scope.required_obligation_kinds ?? []
    if (
      new Set(baseObligations).size !== baseObligations.length ||
      baseObligations.some((value, index) => index > 0 && compareUtf8(baseObligations[index - 1]!, value) >= 0)
    ) {
      invalidSemantics("Route scope obligations must be unique and sorted")
    }
    const contextRequirementKeys = new Set<string>()
    for (const requirement of scope.context_requirements ?? []) {
      const key = `${requirement.consumer_organization_id}\u0000${requirement.use_case_id}\u0000${requirement.minimum_risk_level}`
      if (contextRequirementKeys.has(key)) {
        invalidSemantics("Context route requirements must be unique")
      }
      contextRequirementKeys.add(key)
      if (
        new Set(requirement.required_obligation_kinds).size !== requirement.required_obligation_kinds.length ||
        requirement.required_obligation_kinds.some((value, index) =>
          index > 0 && compareUtf8(requirement.required_obligation_kinds[index - 1]!, value) >= 0
        )
      ) {
        invalidSemantics("Context route requirement obligations must be unique and sorted")
      }
    }

    assertContiguousOrder(scope.candidates, "Public Model candidate")
    if (scope.candidates[0]?.public_model_id !== scope.default_public_model_id) {
      invalidSemantics("default_public_model_id must identify the first candidate")
    }
    const expectedCandidateDigest = gatewayRoutingCandidateSetDigest(scope.candidates)
    if (scope.candidate_set_digest !== expectedCandidateDigest) {
      throw new GatewayRoutingArtifactValidationError(
        "CANDIDATE_SET_DIGEST_MISMATCH",
        `Candidate set digest does not match route scope ${scopeKey}`,
      )
    }
    const mappingCount = scope.candidates.reduce((total, candidate) => total + candidate.mappings.length, 0)
    if (scope.retry_policy && scope.retry_policy.max_attempts > mappingCount) {
      invalidSemantics("retry max_attempts cannot exceed the frozen Connection count")
    }

    const candidateIds = new Set<string>()
    const candidateNames = new Set<string>()
    for (const candidate of scope.candidates) {
      if (candidateIds.has(candidate.public_model_id)) {
        invalidSemantics(`Duplicate Public Model ID: ${candidate.public_model_id}`)
      }
      if (candidateNames.has(candidate.public_model_name)) {
        invalidSemantics(`Duplicate Public Model name: ${candidate.public_model_name}`)
      }
      candidateIds.add(candidate.public_model_id)
      candidateNames.add(candidate.public_model_name)
      assertContiguousOrder(candidate.mappings, "Connection mapping")

      const connectionIds = new Set<string>()
      let previousPriority = -1
      for (const mapping of candidate.mappings) {
        const profileFields = [
          mapping.provider_credential_profile_id,
          mapping.provider_credential_profile_revision,
          mapping.provider_credential_strategy_digest,
        ]
        if (profileFields.some((value) => value !== undefined) && profileFields.some((value) => value === undefined)) {
          invalidSemantics("Provider credential binding must be all-or-none")
        }
        if (mapping.resource_id !== scope.resource_id) {
          invalidSemantics(
            `Connection ${mapping.connection_id} is not owned by Resource ${scope.resource_id}`,
          )
        }
        if (mappingIds.has(mapping.mapping_id)) {
          invalidSemantics(`Duplicate Connection mapping: ${mapping.mapping_id}`)
        }
        if (connectionIds.has(mapping.connection_id)) {
          invalidSemantics(
            `Connection ${mapping.connection_id} is repeated for ${candidate.public_model_id}`,
          )
        }
        mappingIds.add(mapping.mapping_id)
        connectionIds.add(mapping.connection_id)
        if (mapping.priority !== undefined && mapping.priority < previousPriority) {
          invalidSemantics("Connection mappings must be ordered by routing priority")
        }
        previousPriority = mapping.priority ?? previousPriority
      }
    }
  }
  return artifact
}

export function isGatewayRoutingArtifact(input: unknown): input is GatewayRoutingArtifact {
  try {
    validateGatewayRoutingArtifact(input)
    return true
  } catch {
    return false
  }
}
