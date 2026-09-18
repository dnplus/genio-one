import { Type, type Static } from "typebox"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })

export const ApplicationSchema = Type.Object({
  tenant_id: Identifier,
  application_id: Identifier,
  subject_id: Identifier,
  display_name: Type.String({ minLength: 1, maxLength: 256 }),
  owner_organization_id: Identifier,
  registered_by: Type.Object({
    subject_id: Identifier,
    evidence_level: Type.Literal("VERIFIED"),
  }, { additionalProperties: false }),
  created_at: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

export const ApplicationListSchema = Type.Array(ApplicationSchema)

export const RegisterApplicationSchema = Type.Object({
  display_name: Type.String({ minLength: 1, maxLength: 256 }),
  owner_organization_id: Identifier,
}, { additionalProperties: false })

export const ApplicationTenantPathSchema = Type.Object({
  tenant_id: Identifier,
}, { additionalProperties: false })

export const ApplicationCredentialPathSchema = Type.Object({
  tenant_id: Identifier,
  application_id: Identifier,
}, { additionalProperties: false })

export const ApplicationCredentialItemPathSchema = Type.Object({
  tenant_id: Identifier,
  application_id: Identifier,
  credential_id: Identifier,
}, { additionalProperties: false })

export const ApplicationApiCredentialSchema = Type.Object({
  credential_id: Identifier,
  application_id: Identifier,
  application_subject_id: Identifier,
  resource_id: Identifier,
  capability_id: Identifier,
  generation: Type.Integer({ minimum: 1 }),
  kind: Type.Literal("OAUTH2"),
  oauth_client_id: Identifier,
  oauth_issuer: Type.String({ minLength: 1, maxLength: 2048 }),
  oauth_audience: Identifier,
  oauth_scope: Identifier,
  state: Type.Union([
    Type.Literal("PROVISIONING"),
    Type.Literal("ACTIVE"),
    Type.Literal("RETIRED"),
    Type.Literal("REVOKED"),
  ]),
  created_at: Type.Integer({ minimum: 0 }),
  activated_at: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  valid_until: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  revoked_at: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
}, { additionalProperties: false })

export const ApplicationApiCredentialListSchema = Type.Array(ApplicationApiCredentialSchema)

export const IssueApplicationOAuthCredentialSchema = Type.Object({
  correlation_id: Identifier,
  resource_id: Identifier,
  capability_id: Identifier,
  client_certificate_pem: Type.Optional(Type.Null()),
  jwt_client_id: Type.Optional(Type.Null()),
}, { additionalProperties: false })

export const RotateApplicationCredentialSchema = Type.Object({
  correlation_id: Identifier,
  grace_period_seconds: Type.Integer({ minimum: 0, maximum: 86400 }),
}, { additionalProperties: false })

export const RevokeApplicationCredentialSchema = Type.Object({
  correlation_id: Identifier,
}, { additionalProperties: false })

export const ApplicationApiCredentialCreationSchema = Type.Object({
  credential: ApplicationApiCredentialSchema,
  api_key: Type.Null(),
  oauth_client_secret: Type.String({ minLength: 1 }),
  oauth_token_endpoint: Type.String({ minLength: 1, maxLength: 2048 }),
  credential_delivery: Type.Literal("ONE_TIME"),
}, { additionalProperties: false })

export type Application = Static<typeof ApplicationSchema>
export type RegisterApplicationInput = Static<typeof RegisterApplicationSchema>
export type ApplicationApiCredential = Static<typeof ApplicationApiCredentialSchema>
export type ApplicationApiCredentialCreation = Static<typeof ApplicationApiCredentialCreationSchema>
export type IssueApplicationOAuthCredentialInput = Static<typeof IssueApplicationOAuthCredentialSchema>
export type RotateApplicationCredentialInput = Static<typeof RotateApplicationCredentialSchema>
