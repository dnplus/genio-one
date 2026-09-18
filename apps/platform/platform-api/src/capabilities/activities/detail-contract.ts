import { Type, type Static } from "typebox"

const Identifier = Type.String({ minLength: 1, maxLength: 512 })

export const GatewayActivityDetailPathSchema = Type.Object({
  tenant_id: Identifier,
  correlation_id: Identifier,
}, { additionalProperties: false })

const GatewayActivityHttpMessageDetailSchema = Type.Object({
  headers: Type.Array(
    Type.Tuple([
      Identifier,
      Type.String({ maxLength: 16_384 }),
    ]),
    { maxItems: 512 },
  ),
  body: Type.Union([Type.String(), Type.Null()]),
  body_truncated: Type.Boolean(),
  content_type: Type.Union([Type.String({ maxLength: 512 }), Type.Null()]),
}, { additionalProperties: false })

export const GatewayActivityDetailSchema = Type.Object({
  correlation_id: Identifier,
  availability: Type.Union([
    Type.Literal("AVAILABLE"),
    Type.Literal("EXPIRED"),
    Type.Literal("NOT_CAPTURED"),
  ]),
  captured_at: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  expires_at: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  redacted_fields: Type.Array(Identifier, { maxItems: 512 }),
  request: Type.Union([GatewayActivityHttpMessageDetailSchema, Type.Null()]),
  response: Type.Union([GatewayActivityHttpMessageDetailSchema, Type.Null()]),
}, { additionalProperties: false })

export type GatewayActivityDetail = Static<typeof GatewayActivityDetailSchema>
export type GatewayActivityHttpMessageDetail = Static<typeof GatewayActivityHttpMessageDetailSchema>
