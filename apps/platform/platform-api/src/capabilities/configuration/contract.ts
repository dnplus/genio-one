import { Type, type Static } from "typebox"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })
const Timestamp = Type.Integer({ minimum: 0 })
const NullableTimestamp = Type.Union([Timestamp, Type.Null()])
const NullableIdentifier = Type.Union([Identifier, Type.Null()])
const NullableText = Type.Union([Type.String(), Type.Null()])

const LoginBrandingSettingsSchema = Type.Object({
  tagline: Type.String({ maxLength: 256 }),
  logo_url: Type.String({ maxLength: 2048 }),
  primary_color: Type.String({ pattern: "^[#][0-9A-Fa-f]{6}$" }),
  page_color: Type.String({ pattern: "^[#][0-9A-Fa-f]{6}$" }),
  custom_css: Type.String({ maxLength: 16_384 }),
}, { additionalProperties: false })

export const PublicLoginBrandingSchema = Type.Object({
  brand_name: Type.String({ minLength: 1, maxLength: 256 }),
  ...LoginBrandingSettingsSchema.properties,
}, { additionalProperties: false })

const TenantConfigurationSchema = Type.Object({
  brand_name: Type.String({ minLength: 1, maxLength: 256 }),
  language: Type.String({ minLength: 1, maxLength: 64 }),
  catalog_visibility: Type.String({ minLength: 1, maxLength: 128 }),
  request_form: Type.Object({
    enabled: Type.Boolean(),
    required_fields: Type.Array(Type.Union([
      Type.Literal("justification"),
      Type.Literal("requested_ttl"),
    ]), { maxItems: 2 }),
    default_ttl_seconds: Type.Integer({ minimum: 1 }),
  }, { additionalProperties: false }),
  ttl_options_seconds: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, maxItems: 32 }),
  approval_workflow_version: Identifier,
  notification_channels: Type.Array(Type.Literal("IN_APP"), { minItems: 1, maxItems: 1 }),
  login_branding: Type.Optional(LoginBrandingSettingsSchema),
}, { additionalProperties: false })

const ConfigurationRevisionStateSchema = Type.Union([
  Type.Literal("DRAFT"), Type.Literal("VALIDATED"),
  Type.Literal("REVIEWED"), Type.Literal("PUBLISHED"),
])
const ConfigurationProjectionStatusSchema = Type.Union([
  Type.Literal("PENDING"), Type.Literal("CONVERGED"),
  Type.Literal("FAILED"), Type.Literal("ROLLED_BACK"),
])

export const TenantConfigurationRevisionSchema = Type.Object({
  tenant_id: Identifier,
  revision: Identifier,
  state: ConfigurationRevisionStateSchema,
  settings: TenantConfigurationSchema,
  created_by: Type.Object({
    subject_id: Identifier,
    evidence_level: Type.Literal("VERIFIED"),
  }, { additionalProperties: false }),
  created_at: Timestamp,
  validated_at: NullableTimestamp,
  previewed_at: NullableTimestamp,
  reviewed_at: NullableTimestamp,
  published_at: NullableTimestamp,
  projection: Type.Object({
    desired_revision: Identifier,
    observed_revision: NullableIdentifier,
    status: ConfigurationProjectionStatusSchema,
    drift: Type.Boolean(),
    last_error: NullableText,
    retry_count: Type.Integer({ minimum: 0 }),
    last_reconciled_at: NullableTimestamp,
  }, { additionalProperties: false }),
  rolled_back_from: NullableIdentifier,
}, { additionalProperties: false })

export const TenantConfigurationRevisionListSchema = Type.Array(TenantConfigurationRevisionSchema)
export const ConfigurationTenantPathSchema = Type.Object({ tenant_id: Identifier }, { additionalProperties: false })
export const ConfigurationRevisionPathSchema = Type.Object({
  tenant_id: Identifier,
  revision: Identifier,
}, { additionalProperties: false })

export const CreateConfigurationRevisionSchema = Type.Object({
  correlation_id: Identifier,
  settings: TenantConfigurationSchema,
}, { additionalProperties: false })
export const TransitionConfigurationRevisionSchema = Type.Object({
  correlation_id: Identifier,
  projection_failure_reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
}, { additionalProperties: false })
export const ObserveConfigurationProjectionSchema = Type.Object({
  correlation_id: Identifier,
  observed_revision: Type.Optional(NullableIdentifier),
  failure_reason: Type.Optional(NullableText),
}, { additionalProperties: false })
export const RollbackConfigurationRevisionSchema = Type.Object({
  correlation_id: Identifier,
  failed_revision: Identifier,
  target_revision: Identifier,
}, { additionalProperties: false })

export type TenantConfiguration = Static<typeof TenantConfigurationSchema>
export type LoginBrandingSettings = Static<typeof LoginBrandingSettingsSchema>
export type PublicLoginBranding = Static<typeof PublicLoginBrandingSchema>
export type TenantConfigurationRevision = Static<typeof TenantConfigurationRevisionSchema>
export type ConfigurationRevisionState = Static<typeof ConfigurationRevisionStateSchema>
export type ConfigurationProjectionStatus = Static<typeof ConfigurationProjectionStatusSchema>
export type CreateConfigurationRevisionInput = Static<typeof CreateConfigurationRevisionSchema>
export type TransitionConfigurationRevisionInput = Static<typeof TransitionConfigurationRevisionSchema>
export type ObserveConfigurationProjectionInput = Static<typeof ObserveConfigurationProjectionSchema>
export type RollbackConfigurationRevisionInput = Static<typeof RollbackConfigurationRevisionSchema>
