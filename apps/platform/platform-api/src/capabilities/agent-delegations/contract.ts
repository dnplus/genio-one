import { Type, type Static } from "typebox"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })
const Timestamp = Type.Integer({ minimum: 0 })

export const AgentDelegationSchema = Type.Object({
  tenant_id: Identifier,
  delegation_id: Identifier,
  revision: Type.Integer({ minimum: 1 }),
  principal_subject_id: Identifier,
  agent_subject_id: Identifier,
  resource_id: Identifier,
  capability_ids: Type.Array(Identifier, { minItems: 1, maxItems: 128, uniqueItems: true }),
  acting_client_ids: Type.Array(Identifier, { minItems: 1, maxItems: 128, uniqueItems: true }),
  starts_at: Timestamp,
  expires_at: Timestamp,
  revocation_generation: Type.Integer({ minimum: 0 }),
  state: Type.Union([Type.Literal("ACTIVE"), Type.Literal("REVOKED")]),
  created_by_subject_id: Identifier,
  created_at: Timestamp,
}, { additionalProperties: false })

export const CreateAgentDelegationSchema = Type.Object({
  delegation_id: Type.Optional(Identifier),
  principal_subject_id: Identifier,
  agent_subject_id: Identifier,
  resource_id: Identifier,
  capability_ids: Type.Array(Identifier, { minItems: 1, maxItems: 128, uniqueItems: true }),
  acting_client_ids: Type.Array(Identifier, { minItems: 1, maxItems: 128, uniqueItems: true }),
  starts_at: Type.Optional(Timestamp),
  expires_at: Timestamp,
}, { additionalProperties: false })

export const RevokeAgentDelegationSchema = Type.Object({
  expected_revision: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false })

export const AgentDelegationTenantPathSchema = Type.Object({ tenant_id: Identifier }, { additionalProperties: false })
export const AgentDelegationPathSchema = Type.Object({ tenant_id: Identifier, delegation_id: Identifier }, { additionalProperties: false })
export const AgentDelegationListSchema = Type.Array(AgentDelegationSchema)

export type AgentDelegation = Static<typeof AgentDelegationSchema>
export type CreateAgentDelegationInput = Static<typeof CreateAgentDelegationSchema>
export type RevokeAgentDelegationInput = Static<typeof RevokeAgentDelegationSchema>
