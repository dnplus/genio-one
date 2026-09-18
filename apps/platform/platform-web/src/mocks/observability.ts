import type { AiUsageDashboard, GatewayMetricsSummary, TraceSummary } from "@/domain/contracts"

export function createMockGatewayMetrics(tenantId: string): GatewayMetricsSummary {
  return {
    tenant_id: tenantId,
    enforcement_point_id: "AI_GATEWAY",
    window_seconds: 7 * 86_400,
    sampled_at: Math.floor(Date.now() / 1_000),
    request_count: 2_172,
    success_count: 2_126,
    error_count: 46,
    provider_attempt_count: 2_041,
    average_latency_millis: 142,
    request_bytes: 18_400_000,
    response_bytes: 42_900_000,
  }
}

export function createMockTraces(): TraceSummary[] {
  const startedAt = Date.now() - 60_000
  return [
    {
      trace_id: "0123456789abcdef0123456789abcdef",
      correlation_id: "corr-ai-chat-001",
      started_at: startedAt,
      duration_millis: 428,
      status: "OK",
      root_service: "genio-one-ai-gateway",
      span_count: 3,
      spans: [
        { trace_id: "0123456789abcdef0123456789abcdef", span_id: "0000000000000001", parent_span_id: null, name: "POST /v1/chat/completions", service: "genio-one-ai-gateway", started_at: startedAt, duration_millis: 428, status: "OK", correlation_id: "corr-ai-chat-001" },
        { trace_id: "0123456789abcdef0123456789abcdef", span_id: "0000000000000002", parent_span_id: "0000000000000001", name: "One Policy authorization", service: "genio-one-authorizer", started_at: startedAt + 18, duration_millis: 12, status: "OK", correlation_id: "corr-ai-chat-001" },
        { trace_id: "0123456789abcdef0123456789abcdef", span_id: "0000000000000003", parent_span_id: "0000000000000001", name: "Ollama chat", service: "ollama-provider", started_at: startedAt + 42, duration_millis: 366, status: "OK", correlation_id: "corr-ai-chat-001" },
      ],
    },
    {
      trace_id: "1123456789abcdef0123456789abcdef",
      correlation_id: "corr-api-orders-002",
      started_at: startedAt - 30_000,
      duration_millis: 86,
      status: "OK",
      root_service: "api-management",
      span_count: 2,
      spans: [
        { trace_id: "1123456789abcdef0123456789abcdef", span_id: "1000000000000001", parent_span_id: null, name: "GET /orders", service: "api-management", started_at: startedAt - 30_000, duration_millis: 86, status: "OK", correlation_id: "corr-api-orders-002" },
        { trace_id: "1123456789abcdef0123456789abcdef", span_id: "1000000000000002", parent_span_id: "1000000000000001", name: "Orders upstream", service: "orders-api", started_at: startedAt - 29_972, duration_millis: 49, status: "OK", correlation_id: "corr-api-orders-002" },
      ],
    },
    {
      trace_id: "2123456789abcdef0123456789abcdef",
      correlation_id: "corr-endpoint-block-003",
      started_at: startedAt - 90_000,
      duration_millis: 19,
      status: "ERROR",
      root_service: "genio-endpoint",
      span_count: 2,
      spans: [
        { trace_id: "2123456789abcdef0123456789abcdef", span_id: "2000000000000001", parent_span_id: null, name: "Destination policy", service: "genio-endpoint", started_at: startedAt - 90_000, duration_millis: 19, status: "ERROR", correlation_id: "corr-endpoint-block-003" },
        { trace_id: "2123456789abcdef0123456789abcdef", span_id: "2000000000000002", parent_span_id: "2000000000000001", name: "Block decision", service: "one-policy", started_at: startedAt - 89_994, duration_millis: 7, status: "ERROR", correlation_id: "corr-endpoint-block-003" },
      ],
    },
  ]
}

export function createMockAiUsageDashboard(tenantId: string, from: number, to: number): AiUsageDashboard {
  const day = 86_400
  const trend = Array.from({ length: 7 }, (_, index) => ({
    day_start: Math.max(from, to - (6 - index) * day),
    currency: "USD",
    total_cost_micros: [1_820_000, 2_140_000, 1_960_000, 2_760_000, 3_120_000, 2_880_000, 3_540_000][index],
  }))
  return {
    tenant_id: tenantId,
    from,
    to,
    active_user_count: 18,
    ai_resource_count: 11,
    route_distribution: { direct: 284, managed: 1_842, block: 46 },
    usage: {
      request_count: 2_172,
      tool_call_count: 684,
      request_bytes: 18_400_000,
      response_bytes: 42_900_000,
      input_tokens: 1_840_000,
      output_tokens: 612_000,
      total_tokens: 2_452_000,
    },
    cost_by_currency: [{ currency: "USD", total_cost_micros: 18_220_000, priced_record_count: 2_041 }],
    cost_by_resource: [
      { resource_id: "customer-support-agent", display_name: "Customer Support Agent", currency: "USD", total_cost_micros: 8_420_000 },
      { resource_id: "knowledge-search", display_name: "Knowledge Search", currency: "USD", total_cost_micros: 5_760_000 },
      { resource_id: "incident-assistant", display_name: "Incident Assistant", currency: "USD", total_cost_micros: 4_040_000 },
    ],
    cost_by_subject: [
      { subject_id: "platform-admin", display_name: "Platform Admin", department: "Platform", currency: "USD", total_cost_micros: 7_100_000 },
      { subject_id: "ai-owner", display_name: "AI Platform Owner", department: "AI Platform", currency: "USD", total_cost_micros: 6_840_000 },
      { subject_id: "api-owner", display_name: "API Platform Owner", department: "API Platform", currency: "USD", total_cost_micros: 4_280_000 },
    ],
    cost_by_department: [
      { department: "AI Platform", currency: "USD", total_cost_micros: 8_120_000 },
      { department: "Platform", currency: "USD", total_cost_micros: 6_020_000 },
      { department: "API Platform", currency: "USD", total_cost_micros: 4_080_000 },
    ],
    cost_trend: trend,
    resource_budgets: [
      {
        resource_id: "customer-support-agent",
        display_name: "Customer Support Agent",
        allocation_id: "monthly-ai-budget",
        currency: "USD",
        limit_cost_micros: 50_000_000,
        consumed_cost_micros: 31_600_000,
        consumption_basis_points: 6_320,
        priced_record_count: 1_284,
        unpriced_record_count: 18,
        starts_at: from,
        ends_at: to,
        status: "WITHIN_BUDGET",
      },
    ],
    priced_record_count: 2_041,
    unpriced_record_count: 131,
  }
}
