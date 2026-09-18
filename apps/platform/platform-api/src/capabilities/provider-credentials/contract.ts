import { Type, type Static } from "typebox"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })
const Timestamp = Type.Integer({ minimum: 0 })
const Digest = Type.String({ pattern: "^[a-f0-9]{64}$" })

export const StaticSecretCredentialStrategySchema = Type.Object({
  kind: Type.Literal("STATIC_SECRET_REFERENCE"),
  secret_ref: Identifier,
}, { additionalProperties: false })

export const RuntimeIdentityCredentialStrategySchema = Type.Object({
  kind: Type.Literal("RUNTIME_IDENTITY"),
  adapter: Type.Literal("GCP_APPLICATION_DEFAULT"),
  parameters: Type.Object({
    project_name: Identifier,
    region: Identifier,
  }, { additionalProperties: false }),
}, { additionalProperties: false })

export const OidcFederationCredentialStrategySchema = Type.Object({
  kind: Type.Literal("OIDC_FEDERATION"),
  source: Type.Object({
    issuer: Type.String({ minLength: 1, maxLength: 2048 }),
    client_id: Identifier,
    client_secret_ref: Identifier,
    audience: Type.Optional(Identifier),
  }, { additionalProperties: false }),
  exchange: Type.Object({
    adapter: Type.Literal("GCP_STS"),
    project_name: Identifier,
    region: Identifier,
    project_id: Identifier,
    workload_identity_pool_name: Identifier,
    workload_identity_provider_name: Identifier,
    service_account_name: Type.Optional(Identifier),
  }, { additionalProperties: false }),
}, { additionalProperties: false })

export const ProviderCredentialStrategySchema = Type.Union([
  StaticSecretCredentialStrategySchema,
  RuntimeIdentityCredentialStrategySchema,
  OidcFederationCredentialStrategySchema,
])

export const ProviderCredentialProfileRevisionSchema = Type.Object({
  tenant_id: Identifier,
  profile_id: Identifier,
  revision: Type.Integer({ minimum: 1 }),
  owner_organization_id: Identifier,
  display_name: Type.String({ minLength: 1, maxLength: 256 }),
  adapter_family: Type.Union([Type.Literal("GENERIC"), Type.Literal("GCP")]),
  strategy: ProviderCredentialStrategySchema,
  strategy_digest: Digest,
  credential_configured: Type.Optional(Type.Boolean()),
  state: Type.Union([Type.Literal("ACTIVE"), Type.Literal("REVOKED")]),
  created_by_subject_id: Identifier,
  created_at: Timestamp,
}, { additionalProperties: false })

export const ProviderCredentialProfileReferenceSchema = Type.Object({
  profile_id: Identifier,
  revision: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false })

export const ProviderCredentialProfileBindingSchema = Type.Object({
  profile_id: Identifier,
  revision: Type.Integer({ minimum: 1 }),
  strategy_digest: Digest,
}, { additionalProperties: false })

export const CreateProviderCredentialProfileSchema = Type.Object({
  credential_material: Type.Optional(Type.String({ minLength: 2, maxLength: 65536 })),
  profile_id: Type.Optional(Identifier),
  owner_organization_id: Identifier,
  display_name: Type.String({ minLength: 1, maxLength: 256 }),
  strategy: ProviderCredentialStrategySchema,
}, { additionalProperties: false })

export const ReviseProviderCredentialProfileSchema = Type.Object({
  credential_material: Type.Optional(Type.String({ minLength: 2, maxLength: 65536 })),
  expected_revision: Type.Integer({ minimum: 1 }),
  display_name: Type.String({ minLength: 1, maxLength: 256 }),
  strategy: ProviderCredentialStrategySchema,
  state: Type.Union([Type.Literal("ACTIVE"), Type.Literal("REVOKED")]),
}, { additionalProperties: false })

export const ProviderCredentialProfileListSchema = Type.Array(ProviderCredentialProfileRevisionSchema)

export const ProviderCredentialProfileTenantPathSchema = Type.Object({
  tenant_id: Identifier,
}, { additionalProperties: false })

export const ProviderCredentialProfilePathSchema = Type.Object({
  tenant_id: Identifier,
  profile_id: Identifier,
}, { additionalProperties: false })

export type ProviderCredentialStrategy = Static<typeof ProviderCredentialStrategySchema>
export type ProviderCredentialProfileRevision = Static<typeof ProviderCredentialProfileRevisionSchema>
export type ProviderCredentialProfileReference = Static<typeof ProviderCredentialProfileReferenceSchema>
export type ProviderCredentialProfileBinding = Static<typeof ProviderCredentialProfileBindingSchema>
export type CreateProviderCredentialProfileInput = Static<typeof CreateProviderCredentialProfileSchema>
export type ReviseProviderCredentialProfileInput = Static<typeof ReviseProviderCredentialProfileSchema>
