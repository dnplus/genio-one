import { Type, type Static } from "typebox"

const Identifier = Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000\\r\\n]+$" })
const Timestamp = Type.Integer({ minimum: 0 })

export const PostHogIngestHostSchema = Type.Union([
  Type.Literal("https://us.i.posthog.com"),
  Type.Literal("https://eu.i.posthog.com"),
])

export const PostHogProjectIdSchema = Type.Integer({
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
})

export const PostHogProjectTokenSchema = Type.String({
  minLength: 5,
  maxLength: 512,
  pattern: "^phc_[A-Za-z0-9_-]+$",
})

const NullablePostHogIngestHostSchema = Type.Union([PostHogIngestHostSchema, Type.Null()])
const NullablePostHogProjectIdSchema = Type.Union([PostHogProjectIdSchema, Type.Null()])
const NullablePostHogProjectTokenSchema = Type.Union([PostHogProjectTokenSchema, Type.Null()])
const NullableIdentifierSchema = Type.Union([Identifier, Type.Null()])
const NullableTimestampSchema = Type.Union([Timestamp, Type.Null()])

export const PostHogTenantPathSchema = Type.Object({
  tenant_id: Identifier,
}, { additionalProperties: false })

export const PostHogIntegrationSchema = Type.Object({
  enabled: Type.Boolean(),
  host: NullablePostHogIngestHostSchema,
  project_id: NullablePostHogProjectIdSchema,
  project_token: NullablePostHogProjectTokenSchema,
  configured_by: NullableIdentifierSchema,
  configured_at: NullableTimestampSchema,
}, { additionalProperties: false })

export const UpdatePostHogIntegrationSchema = Type.Object({
  enabled: Type.Boolean(),
  host: Type.Optional(PostHogIngestHostSchema),
  project_id: Type.Optional(PostHogProjectIdSchema),
  project_token: Type.Optional(PostHogProjectTokenSchema),
}, { additionalProperties: false })

export const PostHogBrowserConfigurationSchema = Type.Object({
  enabled: Type.Literal(true),
  host: PostHogIngestHostSchema,
  project_id: PostHogProjectIdSchema,
  project_token: PostHogProjectTokenSchema,
}, { additionalProperties: false })

export type PostHogIntegration = Static<typeof PostHogIntegrationSchema>
export type UpdatePostHogIntegration = Static<typeof UpdatePostHogIntegrationSchema>
export type PostHogBrowserConfiguration = Static<typeof PostHogBrowserConfigurationSchema>
