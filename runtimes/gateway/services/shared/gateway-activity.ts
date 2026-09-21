import { Type, type Static } from "typebox"
import { DataClassificationReceiptSchema } from "./data-classification"
import { SafetyDecisionReceiptSchema } from "./safety-decision"

export { mergeSafetyDecisionReceipts } from "./safety-decision"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })
const DownstreamIdentityMode = Type.Unsafe<"NONE" | "SERVICE" | "USER_PASSTHROUGH" | "USER_OAUTH" | "USER_PASSWORD" | null>({
  type: ["string", "null"],
  enum: ["NONE", "SERVICE", "USER_PASSTHROUGH", "USER_OAUTH", "USER_PASSWORD", null],
})
const RouteMode = Type.Unsafe<"DETERMINISTIC" | "SESSION_LEASE" | null>({
  type: ["string", "null"],
  enum: ["DETERMINISTIC", "SESSION_LEASE", null],
})
const EstimatedCostCurrency = Type.Unsafe<"USD" | null>({
  type: ["string", "null"],
  enum: ["USD", null],
})
const PricingSource = Type.Unsafe<"LITELLM" | null>({
  type: ["string", "null"],
  enum: ["LITELLM", null],
})
const UsageAdmissionDisposition = Type.Union([
  Type.Literal("ADMIT"),
  Type.Literal("REJECT"),
  Type.Literal("NOT_APPLICABLE"),
])
const UsageAdmissionReason = Type.Unsafe<
  "QUOTA_EXHAUSTED" |
  "CONCURRENCY_EXHAUSTED" |
  "CREDIT_EXHAUSTED" |
  "COST_BUDGET_EXHAUSTED" |
  "UNPRICED_USAGE" |
  "STORE_UNAVAILABLE" |
  null
>({
  type: ["string", "null"],
  enum: [
    "QUOTA_EXHAUSTED",
    "CONCURRENCY_EXHAUSTED",
    "CREDIT_EXHAUSTED",
    "COST_BUDGET_EXHAUSTED",
    "UNPRICED_USAGE",
    "STORE_UNAVAILABLE",
    null,
  ],
})

const ProcessorStepReceiptSchema = Type.Object({
  step_id: Identifier,
  action: Identifier,
}, { additionalProperties: false })

const GatewayActivitySubjectDisplaySchema = Type.Object({
  subject_id: Identifier,
  display_name: Identifier,
  kind: Type.Union([
    Type.Literal("PERSON"),
    Type.Literal("APPLICATION"),
    Type.Literal("AGENT"),
  ]),
}, { additionalProperties: false })

export const GatewayActivityEventSchema = Type.Object({
  correlation_id: Identifier,
  tenant_id: Identifier,
  resource_id: Identifier,
  capability_id: Type.Union([Identifier, Type.Null()]),
  application_id: Type.Union([Identifier, Type.Null()]),
  subject_id: Type.Union([Identifier, Type.Null()]),
  subject_display: Type.Union([GatewayActivitySubjectDisplaySchema, Type.Null()]),
  acting_client_id: Type.Union([Identifier, Type.Null()]),
  session_id: Type.Optional(Type.Union([Identifier, Type.Null()])),
  entitlement_id: Type.Union([Identifier, Type.Null()]),
  usage_admission_id: Type.Union([Identifier, Type.Null()]),
  usage_admission_disposition: UsageAdmissionDisposition,
  usage_admission_reason: UsageAdmissionReason,
  consumer_organization_id: Type.Union([Identifier, Type.Null()]),
  resource_owner_organization_id: Type.Union([Identifier, Type.Null()]),
  use_case_id: Type.Union([Identifier, Type.Null()]),
  enforcement_point_id: Identifier,
  route: Type.Literal("MANAGED"),
  method: Type.String({ minLength: 1, maxLength: 32 }),
  path: Type.String({ minLength: 1, maxLength: 4096 }),
  status_code: Type.Integer({ minimum: 100, maximum: 599 }),
  outcome: Type.Union([
    Type.Literal("COMPLETED"),
    Type.Literal("RATE_LIMITED"),
    Type.Literal("UNAUTHENTICATED"),
    Type.Literal("DENIED"),
    Type.Literal("BLOCKED"),
    Type.Literal("FAILED"),
  ]),
  error_code: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
  latency_millis: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  upstream_attempted: Type.Boolean(),
  requested_model_id: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
  effective_model_id: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
  provider_id: Type.Union([Identifier, Type.Null()]),
  connection_id: Type.Union([Identifier, Type.Null()]),
  downstream_identity_mode: DownstreamIdentityMode,
  mcp_method: Type.Union([Identifier, Type.Null()]),
  mcp_tool: Type.Union([Identifier, Type.Null()]),
  mcp_backend: Type.Union([Identifier, Type.Null()]),
  processor_bundle_revision: Type.Union([Identifier, Type.Null()]),
  processor_request_steps: Type.Array(ProcessorStepReceiptSchema, { maxItems: 4_096 }),
  processor_response_steps: Type.Array(ProcessorStepReceiptSchema, { maxItems: 4_096 }),
  data_classifications: Type.Array(DataClassificationReceiptSchema, { maxItems: 4_096 }),
  safety_decisions: Type.Optional(Type.Array(SafetyDecisionReceiptSchema, { maxItems: 4_096 })),
  input_tokens: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  output_tokens: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  total_tokens: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  route_mode: RouteMode,
  route_lease_id: Type.Union([Identifier, Type.Null()]),
  // Emit one multi-type schema rather than an anyOf union. With Fastify/AJV
  // coercion, an anyOf can turn false into null (null first) or null into false
  // (boolean first), corrupting the distinction between a new lease and absent
  // routing evidence.
  route_lease_reused: Type.Unsafe<boolean | null>({ type: ["boolean", "null"] }),
  provider_credential_profile_id: Type.Optional(Type.Union([Identifier, Type.Null()])),
  provider_credential_profile_revision: Type.Optional(Type.Union([
    Type.Integer({ minimum: 1 }),
    Type.Null(),
  ])),
  provider_credential_strategy_digest: Type.Optional(Type.Union([
    Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }),
    Type.Null(),
  ])),
  routing_policy_id: Type.Union([Identifier, Type.Null()]),
  routing_revision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  candidate_set_digest: Type.Union([
    Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }),
    Type.Null(),
  ]),
  candidate_connection_ids: Type.Optional(Type.Array(Identifier, { maxItems: 4096 })),
  release_id: Type.Optional(Type.Union([Identifier, Type.Null()])),
  release_head_revision: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
  cost_estimation_status: Type.Union([
    Type.Literal("ESTIMATED"),
    Type.Literal("UNPRICED"),
    Type.Literal("NOT_APPLICABLE"),
  ]),
  estimated_cost_currency: EstimatedCostCurrency,
  estimated_cost_micros: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  pricing_source: PricingSource,
  pricing_version: Type.Union([
    Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }),
    Type.Null(),
  ]),
  detail_availability: Type.Union([
    Type.Literal("AVAILABLE"),
    Type.Literal("EXPIRED"),
    Type.Literal("NOT_CAPTURED"),
  ]),
  detail_ref: Type.Union([Identifier, Type.Null()]),
  detail_expires_at: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  occurred_at: Type.Integer({ minimum: 0 }),
})

export const RoutingAttemptEventSchema = Type.Object({
  tenant_id: Identifier,
  correlation_id: Identifier,
  attempt_id: Identifier,
  order: Type.Integer({ minimum: 1 }),
  connection_id: Identifier,
  connection_configuration_revision: Type.Integer({ minimum: 1 }),
  priority: Type.Integer({ minimum: 0, maximum: 1000 }),
  outcome: Type.Union([
    Type.Literal("SELECTED"),
    Type.Literal("CONNECT_FAILURE"),
    Type.Literal("RESET_BEFORE_RESPONSE"),
    Type.Literal("RETRIED_BEFORE_RESPONSE"),
    Type.Literal("HTTP_5XX"),
    Type.Literal("MID_STREAM_FAILURE"),
  ]),
  response_started: Type.Boolean(),
  occurred_at: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

export const RoutingAttemptIngestSchema = Type.Omit(RoutingAttemptEventSchema, ["tenant_id"])
export type RoutingAttemptEvent = Static<typeof RoutingAttemptEventSchema>
export type RoutingAttemptIngest = Static<typeof RoutingAttemptIngestSchema>

export const GatewayActivityIngestSchema = Type.Omit(GatewayActivityEventSchema, [
  "tenant_id",
  "subject_display",
  "cost_estimation_status",
  "estimated_cost_currency",
  "estimated_cost_micros",
  "pricing_source",
  "pricing_version",
  "downstream_identity_mode",
])

export const GatewayActivityInventorySchema = Type.Object({
  events: Type.Array(GatewayActivityEventSchema),
})

export const GatewayActivitySessionPathSchema = Type.Object({
  tenant_id: Identifier,
  session_id: Identifier,
}, { additionalProperties: false })

export const SessionTimelineSummarySchema = Type.Object({
  total_events: Type.Integer({ minimum: 0 }),
  total_input_tokens: Type.Integer({ minimum: 0 }),
  total_output_tokens: Type.Integer({ minimum: 0 }),
  total_tokens: Type.Integer({ minimum: 0 }),
  total_latency_millis: Type.Integer({ minimum: 0 }),
  first_occurred_at: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  last_occurred_at: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  distinct_models: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 128 }),
  distinct_tools: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 128 }),
  outcome_counts: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
}, { additionalProperties: false })

export const SessionExecutionStepSchema = Type.Object({
  step_index: Type.Integer({ minimum: 1 }),
  step_type: Type.Union([
    Type.Literal("MODEL_INVOCATION"),
    Type.Literal("TOOL_EXECUTION"),
    Type.Literal("POLICY_INTERCEPTION"),
    Type.Literal("GENERIC_REQUEST"),
  ]),
  correlation_id: Identifier,
  occurred_at: Type.Integer({ minimum: 0 }),
  latency_millis: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  status_code: Type.Integer({ minimum: 100, maximum: 599 }),
  outcome: Type.Union([
    Type.Literal("COMPLETED"),
    Type.Literal("RATE_LIMITED"),
    Type.Literal("UNAUTHENTICATED"),
    Type.Literal("DENIED"),
    Type.Literal("BLOCKED"),
    Type.Literal("FAILED"),
  ]),
  model_id: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
  tool_name: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
  data_classifications: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 64 }),
  input_tokens: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  output_tokens: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  total_tokens: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
}, { additionalProperties: false })

export const GatewayActivitySessionTimelineSchema = Type.Object({
  session_id: Identifier,
  authority: Type.Literal("READ_MODEL_ONLY"),
  summary: SessionTimelineSummarySchema,
  steps: Type.Array(SessionExecutionStepSchema),
  events: Type.Array(GatewayActivityEventSchema),
}, { additionalProperties: false })

export type SessionTimelineSummary = Static<typeof SessionTimelineSummarySchema>
export type SessionExecutionStep = Static<typeof SessionExecutionStepSchema>
export type GatewayActivitySessionTimeline = Static<typeof GatewayActivitySessionTimelineSchema>

export function buildSessionTimeline(sessionId: string, events: GatewayActivityEvent[]): GatewayActivitySessionTimeline {
  const sorted = [...events].sort((left, right) => left.occurred_at - right.occurred_at || left.correlation_id.localeCompare(right.correlation_id))
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalTokens = 0
  let totalLatency = 0
  const distinctModels = new Set<string>()
  const distinctTools = new Set<string>()
  const outcomeCounts: Record<string, number> = {}

  const steps: SessionExecutionStep[] = sorted.map((event, idx) => {
    totalInputTokens += event.input_tokens ?? 0
    totalOutputTokens += event.output_tokens ?? 0
    totalTokens += event.total_tokens ?? 0
    totalLatency += event.latency_millis ?? 0
    const model = event.effective_model_id ?? event.requested_model_id
    if (model) distinctModels.add(model)
    if (event.mcp_tool) distinctTools.add(event.mcp_tool)
    outcomeCounts[event.outcome] = (outcomeCounts[event.outcome] ?? 0) + 1

    let stepType: SessionExecutionStep["step_type"] = "GENERIC_REQUEST"
    if (event.mcp_tool || event.mcp_method) {
      stepType = "TOOL_EXECUTION"
    } else if (event.outcome === "BLOCKED" || event.outcome === "DENIED" || event.outcome === "RATE_LIMITED") {
      stepType = "POLICY_INTERCEPTION"
    } else if (model) {
      stepType = "MODEL_INVOCATION"
    }

    return {
      step_index: idx + 1,
      step_type: stepType,
      correlation_id: event.correlation_id,
      occurred_at: event.occurred_at,
      latency_millis: event.latency_millis,
      status_code: event.status_code,
      outcome: event.outcome,
      model_id: model,
      tool_name: event.mcp_tool,
      data_classifications: event.data_classifications.map((item) => item.classification),
      input_tokens: event.input_tokens,
      output_tokens: event.output_tokens,
      total_tokens: event.total_tokens,
    }
  })

  return {
    session_id: sessionId,
    authority: "READ_MODEL_ONLY",
    summary: {
      total_events: sorted.length,
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
      total_tokens: totalTokens,
      total_latency_millis: totalLatency,
      first_occurred_at: sorted.length > 0 ? sorted[0]!.occurred_at : null,
      last_occurred_at: sorted.length > 0 ? sorted[sorted.length - 1]!.occurred_at : null,
      distinct_models: [...distinctModels],
      distinct_tools: [...distinctTools],
      outcome_counts: outcomeCounts,
    },
    steps,
    events: sorted,
  }
}

export const OutcomeAttributionSchema = Type.Object({
  tenant_id: Identifier,
  attribution_id: Identifier,
  correlation_id: Identifier,
  source: Identifier,
  outcome_reference: Type.String({ minLength: 1, maxLength: 2048 }),
  value: Type.String({ minLength: 1, maxLength: 4096 }),
  observed_at: Type.Integer({ minimum: 0 }),
  recorded_by_subject_id: Identifier,
  recorded_at: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

export const OutcomeAttributionInputSchema = Type.Omit(OutcomeAttributionSchema, [
  "tenant_id",
  "correlation_id",
  "recorded_by_subject_id",
  "recorded_at",
])

export const OutcomeAttributionListSchema = Type.Array(OutcomeAttributionSchema)
export type OutcomeAttribution = Static<typeof OutcomeAttributionSchema>
export type OutcomeAttributionInput = Static<typeof OutcomeAttributionInputSchema>

export const RoutingReconstructionSchema = Type.Object({
  correlation_id: Identifier,
  resource_id: Identifier,
  capability_id: Type.Union([Identifier, Type.Null()]),
  routing_policy_id: Type.Union([Identifier, Type.Null()]),
  routing_revision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  release_revision: Type.Union([Identifier, Type.Null()]),
  release_head_revision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  candidate_set_digest: Type.Union([
    Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }),
    Type.Null(),
  ]),
  candidate_connection_ids: Type.Array(Identifier, { maxItems: 4096 }),
  selected_connection_id: Type.Union([Identifier, Type.Null()]),
  ordered_attempts: Type.Array(Type.Object({
    order: Type.Integer({ minimum: 1 }),
    connection_id: Identifier,
    outcome: RoutingAttemptEventSchema.properties.outcome,
  }, { additionalProperties: false })),
  original_upstream_attempted: Type.Boolean(),
  query_upstream_invoked: Type.Literal(false),
  reconstructed_at: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

export type RoutingReconstruction = Static<typeof RoutingReconstructionSchema>

export const GatewayActivityPathSchema = Type.Object({
  tenant_id: Identifier,
  runtime_id: Identifier,
})

export const GatewayActivityListPathSchema = Type.Object({ tenant_id: Identifier })
export const GatewayActivityListQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 100 })),
})

const ConsoleTimeZoneSchema = Type.Union([
  Type.Literal("Asia/Taipei"),
  Type.Literal("Asia/Tokyo"),
  Type.Literal("America/Los_Angeles"),
  Type.Literal("Europe/London"),
])

export const GatewayActivityTrendQuerySchema = Type.Object({
  from: Type.Integer({ minimum: 0 }),
  to: Type.Integer({ minimum: 0 }),
  time_zone: ConsoleTimeZoneSchema,
}, { additionalProperties: false })

const GatewayActivityTrendPointSchema = Type.Object({
  day: Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" }),
  enforcement_point_id: Identifier,
  outcome: GatewayActivityEventSchema.properties.outcome,
  count: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false })

export const GatewayActivityTrendSchema = Type.Object({
  points: Type.Array(GatewayActivityTrendPointSchema),
}, { additionalProperties: false })

export const AiUsageDashboardQuerySchema = Type.Object({
  from: Type.Integer({ minimum: 0 }),
  to: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

const CostByCurrencySchema = Type.Object({
  currency: Identifier,
  total_cost_micros: Type.Integer({ minimum: 0 }),
  priced_record_count: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

export const AiUsageDashboardSchema = Type.Object({
  tenant_id: Identifier,
  from: Type.Integer({ minimum: 0 }),
  to: Type.Integer({ minimum: 0 }),
  active_user_count: Type.Integer({ minimum: 0 }),
  ai_resource_count: Type.Integer({ minimum: 0 }),
  route_distribution: Type.Object({
    direct: Type.Integer({ minimum: 0 }),
    managed: Type.Integer({ minimum: 0 }),
    block: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false }),
  usage: Type.Object({
    request_count: Type.Integer({ minimum: 0 }),
    tool_call_count: Type.Integer({ minimum: 0 }),
    request_bytes: Type.Integer({ minimum: 0 }),
    response_bytes: Type.Integer({ minimum: 0 }),
    input_tokens: Type.Integer({ minimum: 0 }),
    output_tokens: Type.Integer({ minimum: 0 }),
    total_tokens: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false }),
  cost_by_currency: Type.Array(CostByCurrencySchema),
  cost_by_resource: Type.Array(Type.Object({
    resource_id: Identifier,
    display_name: Identifier,
    currency: Identifier,
    total_cost_micros: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false })),
  cost_by_subject: Type.Array(Type.Object({
    subject_id: Identifier,
    display_name: Type.Union([Identifier, Type.Null()]),
    department: Type.Union([Identifier, Type.Null()]),
    currency: Identifier,
    total_cost_micros: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false })),
  cost_by_department: Type.Array(Type.Object({
    department: Type.Union([Identifier, Type.Null()]),
    currency: Identifier,
    total_cost_micros: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false })),
  cost_trend: Type.Array(Type.Object({
    day_start: Type.Integer({ minimum: 0 }),
    currency: Identifier,
    total_cost_micros: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false })),
  resource_budgets: Type.Array(Type.Object({
    resource_id: Identifier,
    display_name: Identifier,
    allocation_id: Identifier,
    currency: Identifier,
    limit_cost_micros: Type.Integer({ minimum: 0 }),
    consumed_cost_micros: Type.Integer({ minimum: 0 }),
    consumption_basis_points: Type.Integer({ minimum: 0 }),
    priced_record_count: Type.Integer({ minimum: 0 }),
    unpriced_record_count: Type.Integer({ minimum: 0 }),
    starts_at: Type.Integer({ minimum: 0 }),
    ends_at: Type.Integer({ minimum: 0 }),
    status: Type.Union([
      Type.Literal("WITHIN_BUDGET"),
      Type.Literal("OVER_BUDGET"),
      Type.Literal("INCOMPLETE_PRICING"),
    ]),
  }, { additionalProperties: false })),
  priced_record_count: Type.Integer({ minimum: 0 }),
  unpriced_record_count: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

export type GatewayActivityEvent = Static<typeof GatewayActivityEventSchema>
export type GatewayActivityIngest = Static<typeof GatewayActivityIngestSchema>
export type ConsoleTimeZone = Static<typeof ConsoleTimeZoneSchema>
export type GatewayActivityTrendPoint = Static<typeof GatewayActivityTrendPointSchema>
export type AiUsageDashboard = Static<typeof AiUsageDashboardSchema>
