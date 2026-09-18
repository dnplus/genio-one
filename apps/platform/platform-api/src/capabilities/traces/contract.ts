import { Type, type Static } from "typebox"

const Identifier = Type.String({ minLength: 1, maxLength: 512 })
const TraceId = Type.String({ pattern: "^[a-f0-9]{32}$" })
const SpanId = Type.String({ pattern: "^[a-f0-9]{16}$" })

const TraceSpanSchema = Type.Object({
  trace_id: TraceId,
  span_id: SpanId,
  parent_span_id: Type.Union([SpanId, Type.Null()]),
  name: Identifier,
  service: Identifier,
  started_at: Type.Integer({ minimum: 0 }),
  duration_millis: Type.Number({ minimum: 0 }),
  status: Type.Union([Type.Literal("OK"), Type.Literal("ERROR"), Type.Literal("UNSET")]),
  correlation_id: Type.Union([Identifier, Type.Null()]),
  attributes: Type.Optional(Type.Record(Type.String(), Type.String())),
  resource_attributes: Type.Optional(Type.Record(Type.String(), Type.String())),
}, { additionalProperties: false })

const TraceSummarySchema = Type.Object({
  trace_id: TraceId,
  correlation_id: Type.Union([Identifier, Type.Null()]),
  started_at: Type.Integer({ minimum: 0 }),
  duration_millis: Type.Number({ minimum: 0 }),
  status: Type.Union([Type.Literal("OK"), Type.Literal("ERROR"), Type.Literal("UNSET")]),
  root_service: Identifier,
  span_count: Type.Integer({ minimum: 1 }),
  spans_truncated: Type.Optional(Type.Boolean()),
  spans: Type.Array(TraceSpanSchema, { minItems: 1, maxItems: 2_000 }),
}, { additionalProperties: false })

export const TraceInventorySchema = Type.Object({
  traces: Type.Array(TraceSummarySchema, { maxItems: 100 }),
}, { additionalProperties: false })

export const TraceListPathSchema = Type.Object({
  tenant_id: Identifier,
}, { additionalProperties: false })

export const TraceListQuerySchema = Type.Object({
  before_trace_id: Type.Optional(TraceId),
  before: Type.Optional(Type.Integer({ minimum: 0 })),
  from: Type.Optional(Type.Integer({ minimum: 0 })),
  until: Type.Optional(Type.Integer({ minimum: 0 })),
  search: Type.Optional(Type.String({ maxLength: 512 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false })

export type TraceSummary = Static<typeof TraceSummarySchema>

export const TelemetryLogSchema = Type.Object({
  record_id: Type.String(),
  details_loaded: Type.Boolean(),
  timestamp_nanos: Type.String(),
  timestamp_millis: Type.Number(),
  service: Type.String(),
  severity: Type.String(),
  body: Type.String(),
  trace_id: Type.String(),
  span_id: Type.String(),
  correlation_id: Type.String(),
  attributes: Type.Union([Type.Record(Type.String(), Type.String()), Type.Null()]),
  resource_attributes: Type.Union([Type.Record(Type.String(), Type.String()), Type.Null()]),
})
export const LogListQuerySchema = Type.Object({
  event: Type.Optional(Type.String({ maxLength: 128 })),
  record_id: Type.Optional(Type.String({ pattern: "^[A-F0-9]{32}$" })),
  timestamp_nanos: Type.Optional(Type.String({ pattern: "^[0-9]{1,20}$" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  from: Type.Optional(Type.Integer({ minimum: 0 })),
  until: Type.Optional(Type.Integer({ minimum: 0 })),
  search: Type.Optional(Type.String({ maxLength: 512 })),
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
})
export const LogInventorySchema = Type.Object({
  records: Type.Array(TelemetryLogSchema, { maxItems: 100 }),
  next_cursor: Type.Union([Type.String(), Type.Null()]),
})
export type TelemetryLog = Static<typeof TelemetryLogSchema>
export type LogInventory = Static<typeof LogInventorySchema>
export type LogQuery = Static<typeof LogListQuerySchema> & { tenantId: string }

export const TraceSpansPathSchema = Type.Object({ tenant_id: Identifier, trace_id: TraceId })
export const TraceSpansQuerySchema = Type.Object({ after: Type.Optional(SpanId), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) })
export const TraceSpansPageSchema = Type.Object({ spans: Type.Array(TraceSpanSchema, { maxItems: 500 }), next_cursor: Type.Union([SpanId, Type.Null()]) })
export type TraceSpansPage = Static<typeof TraceSpansPageSchema>
