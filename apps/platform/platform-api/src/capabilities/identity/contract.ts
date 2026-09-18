import { Type, type Static } from "typebox"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })
const NullableText = Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()])

const SubjectKindSchema = Type.Union([
  Type.Literal("PERSON"),
  Type.Literal("APPLICATION"),
  Type.Literal("AGENT"),
])

export const SubjectSchema = Type.Object({
  subject_id: Identifier,
  kind: SubjectKindSchema,
  profile: Type.Object({
    display_name: NullableText,
    email: NullableText,
    department: NullableText,
  }, { additionalProperties: false }),
  /** A suspended Subject keeps its records and history but cannot authenticate. */
  suspended: Type.Boolean(),
  suspended_at: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  suspended_by: NullableText,
  suspension_reason: NullableText,
}, { additionalProperties: false })

export const SuspendSubjectSchema = Type.Object({
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
}, { additionalProperties: false })

export const SubjectPathSchema = Type.Object({
  tenant_id: Identifier,
  subject_id: Identifier,
}, { additionalProperties: false })

const ExternalIdentityBindingSchema = Type.Object({
  provider_id: Identifier,
  external_subject_id: Identifier,
  subject_id: Identifier,
}, { additionalProperties: false })

export const TenantIdentityInventorySchema = Type.Object({
  tenant_id: Identifier,
  subjects: Type.Array(SubjectSchema, { maxItems: 100_000 }),
  external_identity_bindings: Type.Array(ExternalIdentityBindingSchema, { maxItems: 100_000 }),
  tenant_administrators: Type.Array(Identifier, { maxItems: 10_000 }),
}, { additionalProperties: false })

export const IdentityPathSchema = Type.Object({ tenant_id: Identifier }, { additionalProperties: false })

export const CreateSubjectSchema = Type.Object({
  subject_id: Type.Optional(Identifier),
  kind: Type.Literal("AGENT"),
  display_name: Type.String({ minLength: 1, maxLength: 256 }),
  email: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()])),
  department: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()])),
}, { additionalProperties: false })

export const CreateSelfServiceAgentSchema = Type.Object({
  display_name: Type.String({ minLength: 1, maxLength: 256 }),
}, { additionalProperties: false })

export type Subject = Static<typeof SubjectSchema>
export type SuspendSubjectInput = Static<typeof SuspendSubjectSchema>
export type TenantIdentityInventory = Static<typeof TenantIdentityInventorySchema>
export type CreateSubjectInput = Static<typeof CreateSubjectSchema>
export type CreateSelfServiceAgentInput = Static<typeof CreateSelfServiceAgentSchema>

export interface BootstrapSubjectInput {
  subject_id: string
  kind: "PERSON" | "APPLICATION" | "AGENT"
  display_name?: string | null
  email?: string | null
  department?: string | null
  role?: "USER" | "TENANT_ADMINISTRATOR"
  external_identities?: Array<{ provider_id: string; external_subject_id: string }>
}
