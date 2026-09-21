import assert from "node:assert/strict"
import test from "node:test"

import Fastify from "fastify"

import { gatewayActivityHttp } from "../src/capabilities/activities/http"
import type { GatewayActivityIngest } from "../src/capabilities/activities/contract"
import { createInMemoryGatewayActivityStore } from "../src/capabilities/activities/memory"

test("Activity HTTP ingest preserves false and null Session Lease reused values", async () => {
  const received: GatewayActivityIngest[] = []
  const app = Fastify()
  await app.register(gatewayActivityHttp, {
    authorizeRuntime: async () => {},
    store: {
      async record({ tenantId, event }) {
        received.push(event)
        return {
          ...event,
          tenant_id: tenantId,
          subject_display: null,
          downstream_identity_mode: null,
          cost_estimation_status: "NOT_APPLICABLE",
          estimated_cost_currency: null,
          estimated_cost_micros: null,
          pricing_source: null,
          pricing_version: null,
        }
      },
      async list() {
        return []
      },
      async listSession({ tenantId, sessionId }) {
        return received.filter((event) => event.session_id === sessionId).map((event) => ({
          ...event,
          tenant_id: tenantId,
          subject_display: null,
          downstream_identity_mode: null,
          cost_estimation_status: "NOT_APPLICABLE" as const,
          estimated_cost_currency: null,
          estimated_cost_micros: null,
          pricing_source: null,
          pricing_version: null,
        }))
      },
      async trend() {
        return []
      },
      async summarize({ tenantId, from, to }) {
        return {
          tenant_id: tenantId,
          from,
          to,
          active_user_count: 0,
          ai_resource_count: 0,
          route_distribution: { direct: 0, managed: 0, block: 0 },
          usage: {
            request_count: 0,
            tool_call_count: 0,
            request_bytes: 0,
            response_bytes: 0,
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
          },
          cost_by_currency: [],
          cost_by_resource: [],
          cost_by_subject: [],
          cost_by_department: [],
          cost_trend: [],
          resource_budgets: [],
          priced_record_count: 0,
          unpriced_record_count: 0,
        }
      },
    },
  })

  const payload = {
    correlation_id: "correlation-1",
    resource_id: "resource-1",
    capability_id: "model.invoke",
    application_id: null,
    subject_id: null,
    acting_client_id: null,
    session_id: "session-1",
    entitlement_id: null,
    usage_admission_id: "admission-1",
    usage_admission_disposition: "ADMIT" as const,
    usage_admission_reason: null,
    consumer_organization_id: "organization-consumer",
    resource_owner_organization_id: "organization-owner",
    use_case_id: "use-case-1",
    enforcement_point_id: "AI_GATEWAY" as const,
    route: "MANAGED" as const,
    method: "POST",
    path: "/v1/chat/completions",
    status_code: 200,
    outcome: "COMPLETED" as const,
    error_code: null,
    latency_millis: 10,
    upstream_attempted: true,
    requested_model_id: null,
    effective_model_id: null,
    provider_id: null,
    connection_id: null,
    mcp_method: null,
    mcp_tool: null,
    mcp_backend: null,
    processor_bundle_revision: null,
    processor_request_steps: [],
    processor_response_steps: [],
    data_classifications: [{
      classification: "CUSTOMER_DATA",
      handling_action: "REDACT" as const,
      source: "DLP_DETECTOR" as const,
      source_version: "policy-1",
      trust_level: "RUNTIME_OBSERVED" as const,
      step_id: "protect-customer-data",
    }],
    safety_decisions: [{
      adapter_id: "safety-system-one",
      provider: "JEV" as const,
      model: "jev-latest",
      check_id: "prompt-injection",
      score: 0.92,
      threshold: 0.8,
      decision: "BLOCK" as const,
      direction: "request" as const,
      step_id: "safety-request",
    }],
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    route_mode: "SESSION_LEASE" as const,
    route_lease_id: "route-lease-1",
    route_lease_reused: false,
    provider_credential_profile_id: "provider-credential-1",
    provider_credential_profile_revision: 4,
    provider_credential_strategy_digest: "b".repeat(64),
    routing_policy_id: "routing-policy-1",
    routing_revision: 1,
    candidate_set_digest: "a".repeat(64),
    detail_availability: "NOT_CAPTURED" as const,
    detail_ref: null,
    detail_expires_at: null,
    occurred_at: 1_700_000_000,
  }
  const response = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-1/runtime-control/GATEWAY/runtime-1/activities",
    payload,
  })

  assert.equal(response.statusCode, 201)
  assert.equal(received.length, 1)
  assert.equal(received[0]!.route_lease_reused, false)
  assert.equal(response.json().route_lease_reused, false)
  assert.equal(response.json().session_id, "session-1")
  assert.equal(response.json().provider_credential_profile_id, "provider-credential-1")
  assert.equal(response.json().provider_credential_profile_revision, 4)
  assert.equal(response.json().usage_admission_disposition, "ADMIT")
  assert.equal(response.json().consumer_organization_id, "organization-consumer")
  assert.deepEqual(response.json().data_classifications, payload.data_classifications)
  assert.deepEqual(response.json().safety_decisions, payload.safety_decisions)

  const nullResponse = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-1/runtime-control/GATEWAY/runtime-1/activities",
    payload: {
      ...payload,
      correlation_id: "correlation-2",
      route_mode: null,
      route_lease_id: null,
      route_lease_reused: null,
      routing_policy_id: null,
      routing_revision: null,
      candidate_set_digest: null,
    },
  })
  assert.equal(nullResponse.statusCode, 201)
  assert.equal(received[1]!.route_lease_reused, null)
  assert.equal(nullResponse.json().route_lease_reused, null)

  const legacyPayload = { ...payload, correlation_id: "correlation-legacy", session_id: null }
  delete (legacyPayload as { safety_decisions?: unknown }).safety_decisions
  const legacyResponse = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-1/runtime-control/GATEWAY/runtime-1/activities",
    payload: legacyPayload,
  })
  assert.equal(legacyResponse.statusCode, 201)

  const normalizedStore = createInMemoryGatewayActivityStore()
  await normalizedStore.record({
    tenantId: "tenant-1",
    event: legacyPayload as GatewayActivityIngest,
  })
  assert.deepEqual(
    (await normalizedStore.get!({ tenantId: "tenant-1", correlationId: "correlation-legacy" }))?.safety_decisions,
    [],
  )

  const receiptStore = createInMemoryGatewayActivityStore()
  const requestSafetyDecision = payload.safety_decisions[0]!
  const responseSafetyDecision = {
    ...requestSafetyDecision,
    direction: "response" as const,
    step_id: "safety-response",
    decision: "ALLOW" as const,
    score: 0.1,
  }
  await receiptStore.record({ tenantId: "tenant-1", event: payload })
  await receiptStore.record({
    tenantId: "tenant-1",
    event: { ...payload, safety_decisions: [responseSafetyDecision] },
  })
  await receiptStore.record({
    tenantId: "tenant-1",
    event: { ...payload, safety_decisions: [] },
  })
  assert.deepEqual(
    (await receiptStore.get!({ tenantId: "tenant-1", correlationId: payload.correlation_id }))?.safety_decisions,
    [requestSafetyDecision, responseSafetyDecision],
  )

  const fullReceipts = Array.from({ length: 4096 }, (_, index) => ({
    ...requestSafetyDecision,
    check_id: `bounded-${index}`,
  }))
  const boundedStore = createInMemoryGatewayActivityStore()
  await boundedStore.record({ tenantId: "tenant-1", event: { ...payload, safety_decisions: fullReceipts } })
  await boundedStore.record({ tenantId: "tenant-1", event: { ...payload, safety_decisions: [fullReceipts[0]!, fullReceipts[0]!] } })
  await assert.rejects(
    boundedStore.record({ tenantId: "tenant-1", event: {
      ...payload,
      status_code: 403,
      safety_decisions: [{ ...responseSafetyDecision, check_id: "overflow" }],
    } }),
    /SAFETY_DECISION_RECEIPT_LIMIT_EXCEEDED/,
  )
  const preserved = await boundedStore.get!({ tenantId: "tenant-1", correlationId: payload.correlation_id })
  assert.deepEqual(preserved?.safety_decisions, fullReceipts)
  assert.equal(preserved?.status_code, payload.status_code)

  const timeline = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-1/activity-sessions/session-1",
  })
  assert.equal(timeline.statusCode, 200)
  assert.equal(timeline.json().authority, "READ_MODEL_ONLY")
  assert.equal(timeline.json().summary.total_events, 2)
  assert.equal(timeline.json().steps.length, 2)
  assert.deepEqual(
    timeline.json().events.map((event: { correlation_id: string }) => event.correlation_id),
    ["correlation-1", "correlation-2"],
  )
  await app.close()
})

test("Activity trend passes the requested local time zone and validates the range", async () => {
  const received: Array<{ tenantId: string; from: number; to: number; timeZone: string }> = []
  const app = Fastify()
  await app.register(gatewayActivityHttp, {
    authorizeRuntime: async () => {},
    store: {
      async record() { return {} as never },
      async list() { return [] },
      async trend(input) {
        received.push(input)
        return [{
          day: "2026-08-29",
          enforcement_point_id: "AI_GATEWAY",
          outcome: "COMPLETED",
          count: 42,
        }]
      },
      async summarize({ tenantId, from, to }) {
        return {
          tenant_id: tenantId,
          from,
          to,
          active_user_count: 0,
          ai_resource_count: 0,
          route_distribution: { direct: 0, managed: 0, block: 0 },
          usage: {
            request_count: 0,
            tool_call_count: 0,
            request_bytes: 0,
            response_bytes: 0,
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
          },
          cost_by_currency: [],
          cost_by_resource: [],
          cost_by_subject: [],
          cost_by_department: [],
          cost_trend: [],
          resource_budgets: [],
          priced_record_count: 0,
          unpriced_record_count: 0,
        }
      },
    },
  })

  const response = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-1/transaction-trends?from=100&to=200&time_zone=Asia%2FTaipei",
  })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), {
    points: [{
      day: "2026-08-29",
      enforcement_point_id: "AI_GATEWAY",
      outcome: "COMPLETED",
      count: 42,
    }],
  })
  assert.deepEqual(received, [{ tenantId: "tenant-1", from: 100, to: 200, timeZone: "Asia/Taipei" }])

  const invalid = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-1/transaction-trends?from=201&to=200&time_zone=Asia%2FTaipei",
  })
  assert.equal(invalid.statusCode, 400)
  assert.equal(invalid.json().error, "INVALID_TIME_RANGE")
  await app.close()
})

test("Routing Reconstruction returns ordered immutable attempts without upstream work", async () => {
  const store = createInMemoryGatewayActivityStore()
  await store.record({
    tenantId: "tenant-1",
    event: {
      correlation_id: "correlation-route",
      resource_id: "resource-1",
      capability_id: "chat",
      application_id: null,
      subject_id: "person-1",
      acting_client_id: "codex",
      entitlement_id: "entitlement-1",
      usage_admission_id: "admission-1",
      usage_admission_disposition: "ADMIT",
      usage_admission_reason: null,
      consumer_organization_id: "organization-consumer",
      resource_owner_organization_id: "organization-owner",
      use_case_id: "use-case-1",
      enforcement_point_id: "AI_GATEWAY",
      route: "MANAGED",
      method: "POST",
      path: "/v1/chat/completions",
      status_code: 200,
      outcome: "COMPLETED",
      error_code: null,
      latency_millis: 20,
      upstream_attempted: true,
      requested_model_id: "genio-standard",
      effective_model_id: "provider-model",
      provider_id: "provider-1",
      connection_id: "connection-secondary",
      mcp_method: null,
      mcp_tool: null,
      mcp_backend: null,
      processor_bundle_revision: "release-7",
      processor_request_steps: [],
      processor_response_steps: [],
      data_classifications: [],
      safety_decisions: [],
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      route_mode: "SESSION_LEASE",
      route_lease_id: "lease-1",
      route_lease_reused: false,
      routing_policy_id: "routing-1",
      routing_revision: 7,
      candidate_set_digest: "a".repeat(64),
      detail_availability: "NOT_CAPTURED",
      detail_ref: null,
      detail_expires_at: null,
      occurred_at: 1_700_000_000,
    },
  })
  await store.recordAttempt!({ tenantId: "tenant-1", event: {
    correlation_id: "correlation-route",
    attempt_id: "attempt-1",
    order: 1,
    connection_id: "connection-primary",
    connection_configuration_revision: 3,
    priority: 0,
    outcome: "CONNECT_FAILURE",
    response_started: false,
    occurred_at: 1_700_000_000,
  } })
  await store.recordAttempt!({ tenantId: "tenant-1", event: {
    correlation_id: "correlation-route",
    attempt_id: "attempt-2",
    order: 2,
    connection_id: "connection-secondary",
    connection_configuration_revision: 4,
    priority: 10,
    outcome: "SELECTED",
    response_started: true,
    occurred_at: 1_700_000_001,
  } })
  const app = Fastify()
  app.addHook("preHandler", async (request) => {
    request.principal = {
      tenant_id: "tenant-1",
      subject_id: "person-admin",
      role: "TENANT_ADMINISTRATOR",
      organization_ids: [],
      client_id: "console",
    }
  })
  await app.register(gatewayActivityHttp, { store, authorizeRuntime: async () => {} })
  const response = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-1/activities/correlation-route/routing-reconstruction",
  })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json().ordered_attempts.map((value: { connection_id: string }) => value.connection_id), [
    "connection-primary",
    "connection-secondary",
  ])
  assert.equal(response.json().query_upstream_invoked, false)

  const beforeOutcome = await store.get!({ tenantId: "tenant-1", correlationId: "correlation-route" })
  const outcome = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-1/activities/correlation-route/outcomes",
    payload: {
      attribution_id: "outcome-ticket-1",
      source: "TICKET_SYSTEM",
      outcome_reference: "ticket://support/123",
      value: "RESOLVED",
      observed_at: 1_700_000_100,
    },
  })
  assert.equal(outcome.statusCode, 201)
  assert.equal(outcome.json().recorded_by_subject_id, "person-admin")
  const outcomes = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-1/activities/correlation-route/outcomes",
  })
  assert.equal(outcomes.statusCode, 200)
  assert.deepEqual(outcomes.json().map((value: { value: string }) => value.value), ["RESOLVED"])
  assert.deepEqual(
    await store.get!({ tenantId: "tenant-1", correlationId: "correlation-route" }),
    beforeOutcome,
  )
  await app.close()
})

test("Session timeline aggregates execution stream into structured steps and summary", async () => {
  const store = createInMemoryGatewayActivityStore()
  await store.record({
    tenantId: "tenant-session",
    event: {
      correlation_id: "corr-1",
      application_id: null,
      occurred_at: 1_000,
      session_id: "session-trace-1",
      subject_id: "user-1",
      acting_client_id: null,
      resource_id: "res-model",
      capability_id: "model.chat",
      entitlement_id: "ent-1",
      usage_admission_id: "adm-1",
      usage_admission_disposition: "ADMIT",
      usage_admission_reason: null,
      consumer_organization_id: "org-1",
      resource_owner_organization_id: "org-1",
      use_case_id: "support",
      enforcement_point_id: "gw-1",
      route: "MANAGED",
      method: "POST",
      path: "/v1/chat/completions",
      status_code: 200,
      outcome: "COMPLETED",
      error_code: null,
      latency_millis: 100,
      upstream_attempted: true,
      requested_model_id: "gpt-4o",
      effective_model_id: "gpt-4o",
      provider_id: "openai",
      connection_id: "conn-1",
      mcp_method: null,
      mcp_tool: null,
      mcp_backend: null,
      processor_bundle_revision: null,
      processor_request_steps: [],
      processor_response_steps: [],
      data_classifications: [],
      safety_decisions: [],
      input_tokens: 150,
      output_tokens: 50,
      total_tokens: 200,
      route_mode: null,
      route_lease_id: null,
      route_lease_reused: null,
      routing_policy_id: null,
      routing_revision: null,
      candidate_set_digest: null,
      detail_availability: "NOT_CAPTURED",
      detail_ref: null,
      detail_expires_at: null,
    },
  })

  await store.record({
    tenantId: "tenant-session",
    event: {
      correlation_id: "corr-2",
      application_id: null,
      occurred_at: 1_100,
      session_id: "session-trace-1",
      subject_id: "user-1",
      acting_client_id: null,
      resource_id: "res-mcp",
      capability_id: "mcp.tool",
      entitlement_id: "ent-2",
      usage_admission_id: "adm-2",
      usage_admission_disposition: "ADMIT",
      usage_admission_reason: null,
      consumer_organization_id: "org-1",
      resource_owner_organization_id: "org-1",
      use_case_id: "support",
      enforcement_point_id: "gw-1",
      route: "MANAGED",
      method: "POST",
      path: "/mcp/tools/call",
      status_code: 200,
      outcome: "COMPLETED",
      error_code: null,
      latency_millis: 25,
      upstream_attempted: true,
      requested_model_id: null,
      effective_model_id: null,
      provider_id: null,
      connection_id: "conn-2",
      mcp_method: "tools/call",
      mcp_tool: "query_database",
      mcp_backend: "db-service",
      processor_bundle_revision: null,
      processor_request_steps: [],
      processor_response_steps: [],
      data_classifications: [{
        classification: "FINANCIAL_DATA",
        handling_action: "REDACT",
        source: "DLP_DETECTOR",
        source_version: "v1",
        trust_level: "RUNTIME_OBSERVED",
        step_id: "scan",
      }],
      safety_decisions: [],
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      route_mode: null,
      route_lease_id: null,
      route_lease_reused: null,
      routing_policy_id: null,
      routing_revision: null,
      candidate_set_digest: null,
      detail_availability: "NOT_CAPTURED",
      detail_ref: null,
      detail_expires_at: null,
    },
  })

  await store.record({
    tenantId: "tenant-session",
    event: {
      correlation_id: "corr-3",
      application_id: null,
      occurred_at: 1_200,
      session_id: "session-trace-1",
      subject_id: "user-1",
      acting_client_id: null,
      resource_id: "res-model",
      capability_id: "model.chat",
      entitlement_id: "ent-1",
      usage_admission_id: "adm-3",
      usage_admission_disposition: "REJECT",
      usage_admission_reason: "QUOTA_EXHAUSTED",
      consumer_organization_id: "org-1",
      resource_owner_organization_id: "org-1",
      use_case_id: "support",
      enforcement_point_id: "gw-1",
      route: "MANAGED",
      method: "POST",
      path: "/v1/chat/completions",
      status_code: 403,
      outcome: "BLOCKED",
      error_code: "CONTENT_SAFETY_TRIGGERED",
      latency_millis: 15,
      upstream_attempted: false,
      requested_model_id: "gpt-4o",
      effective_model_id: null,
      provider_id: null,
      connection_id: null,
      mcp_method: null,
      mcp_tool: null,
      mcp_backend: null,
      processor_bundle_revision: null,
      processor_request_steps: [],
      processor_response_steps: [],
      data_classifications: [],
      safety_decisions: [],
      input_tokens: 30,
      output_tokens: 0,
      total_tokens: 30,
      route_mode: null,
      route_lease_id: null,
      route_lease_reused: null,
      routing_policy_id: null,
      routing_revision: null,
      candidate_set_digest: null,
      detail_availability: "NOT_CAPTURED",
      detail_ref: null,
      detail_expires_at: null,
    },
  })

  const app = Fastify()
  await app.register(gatewayActivityHttp, {
    authorizeRuntime: async () => {},
    store,
  })

  const response = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-session/activity-sessions/session-trace-1",
  })

  assert.equal(response.statusCode, 200)
  const body = response.json()
  assert.equal(body.session_id, "session-trace-1")
  assert.equal(body.authority, "READ_MODEL_ONLY")
  assert.equal(body.summary.total_events, 3)
  assert.equal(body.summary.total_input_tokens, 180)
  assert.equal(body.summary.total_output_tokens, 50)
  assert.equal(body.summary.total_tokens, 230)
  assert.equal(body.summary.total_latency_millis, 140)
  assert.equal(body.summary.first_occurred_at, 1000)
  assert.equal(body.summary.last_occurred_at, 1200)
  assert.deepEqual(body.summary.distinct_models, ["gpt-4o"])
  assert.deepEqual(body.summary.distinct_tools, ["query_database"])
  assert.deepEqual(body.summary.outcome_counts, { COMPLETED: 2, BLOCKED: 1 })

  assert.equal(body.steps.length, 3)
  assert.equal(body.steps[0].step_index, 1)
  assert.equal(body.steps[0].step_type, "MODEL_INVOCATION")
  assert.equal(body.steps[0].correlation_id, "corr-1")
  assert.equal(body.steps[0].model_id, "gpt-4o")

  assert.equal(body.steps[1].step_index, 2)
  assert.equal(body.steps[1].step_type, "TOOL_EXECUTION")
  assert.equal(body.steps[1].correlation_id, "corr-2")
  assert.equal(body.steps[1].tool_name, "query_database")
  assert.deepEqual(body.steps[1].data_classifications, ["FINANCIAL_DATA"])

  assert.equal(body.steps[2].step_index, 3)
  assert.equal(body.steps[2].step_type, "POLICY_INTERCEPTION")
  assert.equal(body.steps[2].correlation_id, "corr-3")
  assert.equal(body.steps[2].outcome, "BLOCKED")

  assert.equal(body.events.length, 3)
  await app.close()
})
