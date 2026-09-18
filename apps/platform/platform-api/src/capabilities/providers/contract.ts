import { Type } from "typebox"
import type { Static } from "typebox"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })

export const ProviderTypeSchema = Type.Union([
  Type.Literal("GENERIC_OPENAI_COMPATIBLE"),
  Type.Literal("OPENAI"),
  Type.Literal("OMLX"),
  Type.Literal("OLLAMA"),
  Type.Literal("GCP_VERTEX_AI"),
  Type.Literal("ANTHROPIC"),
])

const ProviderCapabilitySchema = Type.Union([
  Type.Literal("CHAT"),
  Type.Literal("STREAMING"),
  Type.Literal("TOOL_CALLING"),
  Type.Literal("VISION"),
  Type.Literal("REASONING"),
  Type.Literal("EMBEDDINGS"),
])

const ProviderProtocolSchema = Type.Union([
  Type.Literal("OPENAI_COMPATIBLE"),
  Type.Literal("OLLAMA_NATIVE"),
  Type.Literal("GCP_VERTEX_AI"),
  Type.Literal("ANTHROPIC"),
])

export const ProviderProfileSchema = Type.Object({
  tenant_id: Identifier,
  profile_id: Identifier,
  display_name: Type.String({ minLength: 1, maxLength: 256 }),
  provider_type: ProviderTypeSchema,
  protocol: ProviderProtocolSchema,
  capabilities: Type.Array(ProviderCapabilitySchema),
  model_discovery: Type.Union([
    Type.Literal("STATIC"),
    Type.Literal("PROVIDER_API"),
    Type.Literal("MANUAL"),
  ]),
  endpoint_required: Type.Boolean(),
  credential_required: Type.Boolean(),
  built_in: Type.Boolean(),
})

export const ProviderProfileListSchema = Type.Array(ProviderProfileSchema)

export const CreateProviderProfileSchema = Type.Object({
  display_name: Type.String({ minLength: 1, maxLength: 256 }),
  provider_type: ProviderTypeSchema,
  protocol: Type.Optional(ProviderProtocolSchema),
  capabilities: Type.Optional(Type.Array(ProviderCapabilitySchema)),
  model_discovery: Type.Optional(
    Type.Union([
      Type.Literal("STATIC"),
      Type.Literal("PROVIDER_API"),
      Type.Literal("MANUAL"),
    ]),
  ),
})

export const ProviderProfilePathSchema = Type.Object({
  tenant_id: Identifier,
})

export type ProviderType = Static<typeof ProviderTypeSchema>
export type ProviderCapability = Static<typeof ProviderCapabilitySchema>
export type ProviderProfile = Static<typeof ProviderProfileSchema>
export type CreateProviderProfileInput = Static<typeof CreateProviderProfileSchema>
