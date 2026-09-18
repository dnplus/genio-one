import { Type } from "typebox"
import type { Static } from "typebox"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })
const Timestamp = Type.Integer({ minimum: 0 })

const OrganizationMembershipSourceSchema = Type.Object({
  kind: Type.Union([
    Type.Literal("MANUAL"),
    Type.Literal("SCIM_GROUP"),
    Type.Literal("OIDC_GROUP"),
  ]),
  reference: Identifier,
  status: Type.Union([
    Type.Literal("PENDING"),
    Type.Literal("SYNCED"),
    Type.Literal("ERROR"),
  ]),
}, { additionalProperties: false })

export const OrganizationSchema = Type.Object({
  tenant_id: Identifier,
  organization_id: Identifier,
  display_name: Type.String({ minLength: 1, maxLength: 256 }),
  slug: Type.String({ minLength: 1, maxLength: 128 }),
  member_subject_ids: Type.Array(Identifier, { maxItems: 100_000 }),
  organization_administrator_subject_ids: Type.Array(Identifier, { maxItems: 10_000 }),
  membership_sources: Type.Array(OrganizationMembershipSourceSchema, { maxItems: 100 }),
  created_at: Timestamp,
}, { additionalProperties: false })

export const OrganizationListSchema = Type.Array(OrganizationSchema)

export const CreateOrganizationSchema = Type.Object({
  display_name: Type.String({ minLength: 1, maxLength: 256 }),
  slug: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  member_subject_ids: Type.Optional(Type.Array(Identifier, { maxItems: 100_000 })),
}, { additionalProperties: false })

export const UpdateOrganizationSchema = Type.Object({
  display_name: Type.String({ minLength: 1, maxLength: 256 }),
  member_subject_ids: Type.Array(Identifier, { maxItems: 100_000 }),
  organization_administrator_subject_ids: Type.Array(Identifier, { maxItems: 10_000 }),
  membership_sources: Type.Array(OrganizationMembershipSourceSchema, { maxItems: 100 }),
}, { additionalProperties: false })

export const OrganizationPathSchema = Type.Object({
  tenant_id: Identifier,
})

export type Organization = Static<typeof OrganizationSchema>
export type CreateOrganizationInput = Static<typeof CreateOrganizationSchema>
export type UpdateOrganizationInput = Static<typeof UpdateOrganizationSchema>
export type OrganizationMembershipSource = Static<typeof OrganizationMembershipSourceSchema>
