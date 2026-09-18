import { Type } from "typebox"
import type { Static } from "typebox"

const Identifier = Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000\\r\\n]+$" })

export const McpOAuthConnectionPathSchema = Type.Object({
  tenant_id: Identifier,
  resource_id: Identifier,
  connection_id: Identifier,
}, { additionalProperties: false })

export const McpOAuthCallbackQuerySchema = Type.Object({
  state: Identifier,
  code: Type.Optional(Identifier),
  iss: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  error: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  error_description: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
}, { additionalProperties: false })

export const McpOAuthAuthorizationSchema = Type.Object({
  authorization_url: Type.String({ minLength: 1, maxLength: 8192 }),
  expires_at: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

export const McpOAuthBindingSchema = Type.Object({
  tenant_id: Identifier,
  resource_id: Identifier,
  connection_id: Identifier,
  subject_id: Identifier,
  state: Type.Literal("CONNECTED"),
  issuer: Type.String({ minLength: 1, maxLength: 2048 }),
  resource_url: Type.String({ minLength: 1, maxLength: 2048 }),
  scopes: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 64 }),
  expires_at: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  updated_at: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

export type McpOAuthAuthorization = Static<typeof McpOAuthAuthorizationSchema>
export type McpOAuthBinding = Static<typeof McpOAuthBindingSchema>
