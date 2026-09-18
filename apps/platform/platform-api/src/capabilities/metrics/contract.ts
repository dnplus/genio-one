import { Type, type Static } from "typebox"

const Identifier = Type.String({ minLength: 1, maxLength: 512 })

export const GatewayMetricsSummarySchema = Type.Object({
  tenant_id: Identifier,
  enforcement_point_id: Type.Literal("AI_GATEWAY"),
  window_seconds: Type.Integer({ minimum: 60, maximum: 604_800 }),
  sampled_at: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  request_count: Type.Integer({ minimum: 0 }),
  success_count: Type.Integer({ minimum: 0 }),
  error_count: Type.Integer({ minimum: 0 }),
  provider_attempt_count: Type.Integer({ minimum: 0 }),
  average_latency_millis: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  request_bytes: Type.Integer({ minimum: 0 }),
  response_bytes: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

export const GatewayMetricsPathSchema = Type.Object({
  tenant_id: Identifier,
}, { additionalProperties: false })

export const GatewayMetricsQuerySchema = Type.Object({
  window_seconds: Type.Optional(Type.Integer({ minimum: 60, maximum: 604_800 })),
}, { additionalProperties: false })

export type GatewayMetricsSummary = Static<typeof GatewayMetricsSummarySchema>
