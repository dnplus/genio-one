import { Type, type Static } from "typebox"

const Identifier = Type.String({ minLength: 1, maxLength: 256, pattern: "^(?!\\s)(?!.*\\s$)[^\\u0000\\r\\n]+$" })
const OrganizationIdentifier = Type.Union([Identifier, Type.Null()])
const Timestamp = Type.Integer({ minimum: 0 })

export const AccessGroupMembershipSourceKindSchema = Type.Literal("MANUAL")

export const AccessGroupMembershipSourceSchema = Type.Object({
  source_id: Type.Literal("manual"),
  kind: AccessGroupMembershipSourceKindSchema,
  revision: Type.Integer({ minimum: 1 }),
  subject_ids: Type.Array(Identifier, { maxItems: 10_000, uniqueItems: true }),
  created_at: Timestamp,
  created_by: Identifier,
  updated_at: Timestamp,
  updated_by: Identifier,
}, { additionalProperties: false })

export const AccessGroupSchema = Type.Object({
  tenant_id: Identifier,
  organization_id: OrganizationIdentifier,
  access_group_id: Identifier,
  display_name: Type.String({ minLength: 1, maxLength: 256 }),
  description: Type.String({ maxLength: 2_000 }),
  enabled: Type.Boolean(),
  revision: Type.Integer({ minimum: 1 }),
  membership_sources: Type.Array(AccessGroupMembershipSourceSchema, { maxItems: 1 }),
  created_at: Timestamp,
  created_by: Identifier,
  updated_at: Timestamp,
  updated_by: Identifier,
}, { additionalProperties: false })

export const SaveAccessGroupSchema = Type.Object({
  expected_revision: Type.Integer({ minimum: 0 }),
  organization_id: Type.Optional(OrganizationIdentifier),
  display_name: Type.String({ minLength: 1, maxLength: 256 }),
  description: Type.String({ maxLength: 2_000 }),
  enabled: Type.Boolean(),
}, { additionalProperties: false })

export const ReplaceAccessGroupMembersSchema = Type.Object({
  expected_group_revision: Type.Integer({ minimum: 1 }),
  expected_source_revision: Type.Integer({ minimum: 0 }),
  subject_ids: Type.Array(Identifier, { maxItems: 10_000, uniqueItems: true }),
}, { additionalProperties: false })

export type AccessGroupMembershipSourceKind = Static<typeof AccessGroupMembershipSourceKindSchema>
export type AccessGroupMembershipSource = Static<typeof AccessGroupMembershipSourceSchema>
export type AccessGroup = Static<typeof AccessGroupSchema>
export type SaveAccessGroup = Static<typeof SaveAccessGroupSchema>
export type ReplaceAccessGroupMembers = Static<typeof ReplaceAccessGroupMembersSchema>

export function accessGroupSubjectIds(group: AccessGroup): string[] {
  if (!group.enabled) return []
  return [...new Set(group.membership_sources.flatMap((source) => source.subject_ids))].sort()
}
