import { Type } from "typebox"
import type { Static } from "typebox"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })
const Timestamp = Type.Integer({ minimum: 0 })

const ModelVisibilitySchema = Type.Union([
  Type.Literal("PUBLIC"),
  Type.Literal("PRIVATE"),
])

const ModelLifecycleSchema = Type.Union([
  Type.Literal("PUBLISHED"),
  Type.Literal("DEPRECATED"),
])

const ModelCapabilitySchema = Type.Union([
  Type.Literal("CHAT"),
  Type.Literal("STREAMING"),
  Type.Literal("TOOL_CALLING"),
  Type.Literal("VISION"),
  Type.Literal("REASONING"),
  Type.Literal("EMBEDDINGS"),
  Type.Literal("TRANSCRIPTION"),
])

export const PublicModelSchema = Type.Object({
  tenant_id: Identifier,
  model_id: Identifier,
  /** Tenant-scoped stable alias exposed to clients; provider model names never live here. */
  model_name: Type.String({ minLength: 1, maxLength: 256 }),
  display_name: Type.String({ minLength: 1, maxLength: 256 }),
  resource_id: Identifier,
  visibility: ModelVisibilitySchema,
  lifecycle: ModelLifecycleSchema,
  capabilities: Type.Array(ModelCapabilitySchema),
  created_at: Timestamp,
})

export const PublicModelListSchema = Type.Array(PublicModelSchema)

export const ConnectionModelMappingSchema = Type.Object({
  tenant_id: Identifier,
  mapping_id: Identifier,
  public_model_id: Identifier,
  resource_id: Identifier,
  connection_id: Identifier,
  /** The provider-specific model identifier sent to the upstream. */
  provider_model: Type.String({ minLength: 1, maxLength: 256 }),
  mapping_revision: Type.Integer({ minimum: 1 }),
  created_at: Timestamp,
})

export const ConnectionModelMappingListSchema = Type.Array(ConnectionModelMappingSchema)

const CreateConnectionModelMappingSchema = Type.Object({
  connection_id: Identifier,
  provider_model: Type.String({ minLength: 1, maxLength: 256 }),
})

export const AddConnectionModelMappingSchema = Type.Object({
  connection_id: Identifier,
  provider_model: Type.String({ minLength: 1, maxLength: 256 }),
  expected_connection_revision: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false })

export const CreatePublicModelSchema = Type.Object({
  model_name: Type.String({ minLength: 1, maxLength: 256 }),
  display_name: Type.String({ minLength: 1, maxLength: 256 }),
  mappings: Type.Array(CreateConnectionModelMappingSchema, { minItems: 1, uniqueItems: true }),
  capabilities: Type.Optional(Type.Array(ModelCapabilitySchema)),
  visibility: Type.Optional(ModelVisibilitySchema),
})

export const ModelPathSchema = Type.Object({
  tenant_id: Identifier,
})

export const ResourceModelsPathSchema = Type.Object({
  tenant_id: Identifier,
  resource_id: Identifier,
})

export const ResourceModelPathSchema = Type.Object({
  tenant_id: Identifier,
  resource_id: Identifier,
  model_id: Identifier,
})

export type ModelVisibility = Static<typeof ModelVisibilitySchema>
export type ModelLifecycle = Static<typeof ModelLifecycleSchema>
export type ModelCapability = Static<typeof ModelCapabilitySchema>
export type PublicModel = Static<typeof PublicModelSchema>
export type ConnectionModelMapping = Static<typeof ConnectionModelMappingSchema>
export type CreateConnectionModelMappingInput = Static<typeof CreateConnectionModelMappingSchema>
export type AddConnectionModelMappingInput = Static<typeof AddConnectionModelMappingSchema>
export type CreatePublicModelInput = Static<typeof CreatePublicModelSchema>
