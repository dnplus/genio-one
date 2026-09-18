import { Type } from "typebox"
import type { Static } from "typebox"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })
const Timestamp = Type.Integer({ minimum: 0 })

const ModelEntitlementStateSchema = Type.Union([
  Type.Literal("ACTIVE"),
  Type.Literal("REVOKED"),
])

export const ModelEntitlementSchema = Type.Object({
  tenant_id: Identifier,
  entitlement_id: Identifier,
  subject_id: Type.Union([Identifier, Type.Null()]),
  client_id: Type.Union([Identifier, Type.Null()]),
  resource_id: Identifier,
  capability_id: Identifier,
  /** Optional LLM-specific constraint; non-LLM Capabilities leave it null. */
  public_model_id: Type.Union([Identifier, Type.Null()]),
  state: ModelEntitlementStateSchema,
  starts_at: Timestamp,
  expires_at: Type.Union([Timestamp, Type.Null()]),
  created_at: Timestamp,
})

export const ModelEntitlementListSchema = Type.Array(ModelEntitlementSchema)

export const GrantModelEntitlementSchema = Type.Object({
  subject_id: Type.Optional(Identifier),
  client_id: Type.Optional(Identifier),
  resource_id: Identifier,
  capability_id: Identifier,
  public_model_id: Type.Optional(Type.Union([Identifier, Type.Null()])),
  starts_at: Type.Optional(Timestamp),
  expires_at: Type.Optional(Type.Union([Timestamp, Type.Null()])),
}, { additionalProperties: false })

export const EntitlementTenantPathSchema = Type.Object({ tenant_id: Identifier })
export type ModelEntitlement = Static<typeof ModelEntitlementSchema>
export type GrantModelEntitlementInput = Static<typeof GrantModelEntitlementSchema>
