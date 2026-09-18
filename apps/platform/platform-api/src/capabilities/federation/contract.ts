import { Type, type Static } from "typebox"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })
const Timestamp = Type.Integer({ minimum: 0 })
const OAuthScope = Type.String({ minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9._:-]+$" })

export const FederationRequiredClaimSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_.-]+$" }),
  value: Type.String({ minLength: 1, maxLength: 512 }),
}, { additionalProperties: false })

export const FederationTrustRevisionSchema = Type.Object({
  tenant_id: Identifier,
  trust_id: Identifier,
  revision: Type.Integer({ minimum: 1 }),
  application_id: Identifier,
  application_subject_id: Identifier,
  display_name: Type.String({ minLength: 1, maxLength: 256 }),
  issuer: Type.String({ minLength: 1, maxLength: 2048 }),
  jwks_uri: Type.String({ minLength: 1, maxLength: 2048 }),
  audiences: Type.Array(Identifier, { minItems: 1, maxItems: 32 }),
  algorithms: Type.Array(Type.Union([
    Type.Literal("RS256"),
    Type.Literal("ES256"),
    Type.Literal("EdDSA"),
  ]), { minItems: 1, maxItems: 3 }),
  external_subject_id: Identifier,
  required_claims: Type.Array(FederationRequiredClaimSchema, { maxItems: 32 }),
  max_assertion_ttl_seconds: Type.Integer({ minimum: 1, maximum: 3600 }),
  state: Type.Union([Type.Literal("ACTIVE"), Type.Literal("REVOKED")]),
  created_by_subject_id: Identifier,
  created_at: Timestamp,
}, { additionalProperties: false })

export const FederationTrustRevisionListSchema = Type.Array(FederationTrustRevisionSchema)

export const CreateFederationTrustRevisionSchema = Type.Object({
  trust_id: Type.Optional(Identifier),
  display_name: Type.String({ minLength: 1, maxLength: 256 }),
  issuer: Type.String({ minLength: 1, maxLength: 2048 }),
  jwks_uri: Type.String({ minLength: 1, maxLength: 2048 }),
  audiences: Type.Array(Identifier, { minItems: 1, maxItems: 32 }),
  algorithms: Type.Array(Type.Union([
    Type.Literal("RS256"),
    Type.Literal("ES256"),
    Type.Literal("EdDSA"),
  ]), { minItems: 1, maxItems: 3 }),
  external_subject_id: Identifier,
  required_claims: Type.Array(FederationRequiredClaimSchema, { maxItems: 32 }),
  max_assertion_ttl_seconds: Type.Integer({ minimum: 1, maximum: 3600 }),
}, { additionalProperties: false })

export const FederationTokenExchangeSchema = Type.Object({
  correlation_id: Identifier,
  trust_id: Identifier,
  grant_type: Type.Literal("urn:ietf:params:oauth:grant-type:token-exchange"),
  subject_token_type: Type.Literal("urn:ietf:params:oauth:token-type:jwt"),
  requested_token_type: Type.Literal("urn:ietf:params:oauth:token-type:access_token"),
  subject_token: Type.String({ minLength: 1, maxLength: 16384 }),
  resource_id: Identifier,
  capability_id: Identifier,
  audience: Identifier,
  scope: OAuthScope,
}, { additionalProperties: false })

export const FederationTokenExchangeResponseSchema = Type.Object({
  access_token: Type.String({ minLength: 1 }),
  issued_token_type: Type.Literal("urn:ietf:params:oauth:token-type:access_token"),
  token_type: Type.Literal("Bearer"),
  expires_in: Type.Integer({ minimum: 1, maximum: 3600 }),
  scope: OAuthScope,
  application_subject_id: Identifier,
  credential_generation: Type.Integer({ minimum: 1 }),
  exchange_correlation_id: Identifier,
}, { additionalProperties: false })

export const FederationExchangeEventSchema = Type.Object({
  tenant_id: Identifier,
  exchange_id: Identifier,
  correlation_id: Identifier,
  trust_id: Identifier,
  trust_revision: Type.Integer({ minimum: 1 }),
  external_issuer: Type.String({ minLength: 1, maxLength: 2048 }),
  external_subject_id: Type.Union([Identifier, Type.Null()]),
  application_id: Identifier,
  application_subject_id: Identifier,
  credential_id: Type.Union([Identifier, Type.Null()]),
  credential_generation: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  resource_id: Identifier,
  capability_id: Identifier,
  audience: Identifier,
  scope: OAuthScope,
  outcome: Type.Union([Type.Literal("ISSUED"), Type.Literal("REJECTED")]),
  rejection_reason: Type.Union([Identifier, Type.Null()]),
  upstream_attempted: Type.Literal(false),
  occurred_at: Timestamp,
}, { additionalProperties: false })

export const FederationExchangeEventListSchema = Type.Array(FederationExchangeEventSchema)

export const FederationApplicationPathSchema = Type.Object({
  tenant_id: Identifier,
  application_id: Identifier,
}, { additionalProperties: false })

export const FederationTenantPathSchema = Type.Object({ tenant_id: Identifier }, { additionalProperties: false })

export type FederationTrustRevision = Static<typeof FederationTrustRevisionSchema>
export type CreateFederationTrustRevisionInput = Static<typeof CreateFederationTrustRevisionSchema>
export type FederationTokenExchangeInput = Static<typeof FederationTokenExchangeSchema>
export type FederationTokenExchangeResponse = Static<typeof FederationTokenExchangeResponseSchema>
export type FederationExchangeEvent = Static<typeof FederationExchangeEventSchema>
