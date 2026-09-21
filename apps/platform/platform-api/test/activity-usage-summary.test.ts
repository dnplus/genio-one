import assert from "node:assert/strict"
import test from "node:test"

import type { GatewayActivityEvent } from "../src/capabilities/activities/contract"
import { summarizeGatewayActivities } from "../src/capabilities/activities/usage-summary"

function event(overrides: Partial<GatewayActivityEvent>): GatewayActivityEvent {
  return {
    correlation_id: "correlation-1",
    tenant_id: "tenant-1",
    resource_id: "resource-1",
    capability_id: "model.invoke",
    application_id: null,
    subject_id: "subject-1",
    subject_display: null,
    acting_client_id: "client-1",
    entitlement_id: null,
    usage_admission_id: null,
    usage_admission_disposition: "NOT_APPLICABLE",
    usage_admission_reason: null,
    consumer_organization_id: null,
    resource_owner_organization_id: null,
    use_case_id: null,
    enforcement_point_id: "AI_GATEWAY",
    route: "MANAGED",
    method: "POST",
    path: "/v1/chat/completions",
    status_code: 200,
    outcome: "COMPLETED",
    error_code: null,
    latency_millis: 10,
    upstream_attempted: true,
    requested_model_id: "public-chat",
    effective_model_id: "llama3",
    provider_id: "OLLAMA",
    connection_id: "connection-1",
    downstream_identity_mode: null,
    mcp_method: null,
    mcp_tool: null,
    mcp_backend: null,
    processor_bundle_revision: null,
    processor_request_steps: [],
    processor_response_steps: [],
    data_classifications: [],
    safety_decisions: [],
    input_tokens: 22,
    output_tokens: 98,
    total_tokens: 120,
    route_mode: "DETERMINISTIC",
    route_lease_id: null,
    route_lease_reused: null,
    routing_policy_id: null,
    routing_revision: null,
    candidate_set_digest: null,
    cost_estimation_status: "ESTIMATED",
    estimated_cost_currency: "USD",
    estimated_cost_micros: 0,
    pricing_source: "LITELLM",
    pricing_version: "a".repeat(64),
    detail_availability: "AVAILABLE",
    detail_ref: "detail-1",
    detail_expires_at: 1_800_000_000,
    occurred_at: 1_700_000_000,
    ...overrides,
  }
}

test("AI usage keeps explicitly priced zero-cost usage visible", () => {
  const summary = summarizeGatewayActivities({
    tenantId: "tenant-1",
    from: 1_699_999_999,
    to: 1_700_000_001,
    events: [{ event: event({}), resourceDisplayName: "Estimated Cost Walking Skeleton" }],
  })

  assert.equal(summary.usage.request_count, 1)
  assert.equal(summary.usage.total_tokens, 120)
  assert.equal(summary.priced_record_count, 1)
  assert.deepEqual(summary.cost_by_currency, [{
    currency: "USD",
    total_cost_micros: 0,
    priced_record_count: 1,
  }])
  assert.deepEqual(summary.cost_by_resource, [{
    resource_id: "resource-1",
    display_name: "Estimated Cost Walking Skeleton",
    currency: "USD",
    total_cost_micros: 0,
  }])
})
