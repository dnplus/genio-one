import assert from "node:assert/strict"
import test from "node:test"

import type { GatewayActivityEvent, GatewayActivityIngest, RoutingAttemptIngest } from "../src/capabilities/activities/contract"
import { createClickHouseGatewayActivityMaterializer } from "../src/capabilities/activities/otel-clickhouse"

function persistedActivity(tenantId: string, event: GatewayActivityIngest): GatewayActivityEvent {
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
}

test("OTel MCP public and provider access logs materialize one correlated Activity", async () => {
  const recorded: GatewayActivityIngest[] = []
  const correlationId = "mcp-correlation-1"
  const rows = [{
    observed_at_millis: 1_000,
    attributes: {
      "genio.event.kind": "ai_gateway_activity",
      "x-request-id": correlationId,
      authority: "mcp.example.test",
      method: "POST",
      path: "/mcp",
      response_code: "200",
      duration: "18",
    },
  }, {
    observed_at_millis: 1_001,
    attributes: {
      "genio.event.kind": "ai_gateway_activity",
      "x-request-id": correlationId,
      authority: "mcp.example.internal",
      method: "POST",
      path: "/",
      response_code: "200",
      "mcp.method.name": "initialize",
      "mcp.provider.name": "notion",
      upstream_host: "mcp.example.internal:443",
    },
  }, {
    observed_at_millis: 1_002,
    attributes: {
      "genio.event.kind": "ai_gateway_activity",
      "x-request-id": correlationId,
      authority: "host.docker.internal",
      method: "POST",
      path: "/",
      response_code: "200",
      "mcp.method.name": "tools/call",
      "mcp.tool.name": "echo",
      "mcp.provider.name": "notion",
      upstream_host: "127.0.0.1:19003",
    },
  }]
  const materializer = createClickHouseGatewayActivityMaterializer({
    origin: "http://clickhouse.test",
    database: "analytics",
    username: "user",
    password: "secret",
    fetch: async () => new Response(rows.map((row) => JSON.stringify(row)).join("\n")),
    activities: {
      async record({ event }) {
        recorded.push(event)
        return {} as never
      },
    },
    audits: {
      async query() {
        return {
          events: [{
            kind: "ONE_POLICY_DECISION",
            resource_id: "resource-1",
            capability_id: "mcp.invoke",
            entitlement_id: "entitlement-1",
            subject: { subject_id: "person-1" },
            acting_client: { acting_client_id: "client-1" },
            enforcement_point_id: "AI_GATEWAY",
            decision: { input_receipt: { mcp_tool: "backend__echo" } },
          }] as never,
          hasMore: false,
          sourceRevision: 1,
        }
      },
    },
    connections: {
      async list() {
        return [{
          connection_id: "connection-123e4567-e89b-12d3-a456-426614174000",
          connection_kind: "MCP",
          mcp_tool_namespace: "notion",
        }] as never
      },
    },
  })

  await materializer.refresh({ tenantId: "tenant-1" })

  assert.equal(recorded.length, 1)
  assert.deepEqual(recorded[0], {
    correlation_id: correlationId,
    resource_id: "resource-1",
    capability_id: "mcp.invoke",
    application_id: "client-1",
    subject_id: "person-1",
    acting_client_id: "client-1",
    entitlement_id: "entitlement-1",
    usage_admission_id: null,
    usage_admission_disposition: "NOT_APPLICABLE",
    usage_admission_reason: null,
    consumer_organization_id: null,
    resource_owner_organization_id: null,
    use_case_id: null,
    enforcement_point_id: "AI_GATEWAY",
    route: "MANAGED",
    method: "POST",
    path: "/mcp",
    status_code: 200,
    outcome: "COMPLETED",
    error_code: null,
    latency_millis: 18,
    upstream_attempted: true,
    requested_model_id: null,
    effective_model_id: null,
    provider_id: null,
    connection_id: "connection-123e4567-e89b-12d3-a456-426614174000",
    mcp_method: "tools/call",
    mcp_tool: "backend__echo",
    mcp_backend: "notion",
    processor_bundle_revision: null,
    processor_request_steps: [],
    processor_response_steps: [],
    data_classifications: [],
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
    occurred_at: 1,
  })
})

test("OTel API access log materializes one API Gateway Activity", async () => {
  const recorded: GatewayActivityIngest[] = []
  const correlationId = "api-correlation-1"
  const rows = [{
    observed_at_millis: 2_000,
    attributes: {
      "genio.event.kind": "ai_gateway_activity",
      "x-request-id": correlationId,
      authority: "api.example.test",
      method: "GET",
      path: "/incidents?client=keep&locale=zh-TW",
      response_code: "200",
      duration: "12",
      upstream_host: "192.0.2.1:443",
      "gen_ai.request.model": "genio-chat",
    },
  }, {
    observed_at_millis: 2_001,
    attributes: {
      "genio.event.kind": "ai_gateway_activity",
      "x-request-id": correlationId,
      authority: "api.example.internal",
      method: "GET",
      path: "/",
      response_code: "200",
      "gen_ai.response.model": "gpt-4.1",
      "gen_ai.provider.name": "openai",
      "gen_ai.usage.input_tokens": "12",
      "gen_ai.usage.output_tokens": "7",
      "gen_ai.usage.total_tokens": "19",
    },
  }]
  const materializer = createClickHouseGatewayActivityMaterializer({
    origin: "http://clickhouse.test",
    database: "analytics",
    username: "user",
    password: "secret",
    fetch: async () => new Response(rows.map((row) => JSON.stringify(row)).join("\n")),
    activities: {
      async record({ event }) {
        recorded.push(event)
        return {} as never
      },
    },
    audits: {
      async query() {
        return {
          events: [{
            kind: "ONE_POLICY_DECISION",
            resource_id: "resource-api",
            capability_id: "incident.list",
            entitlement_id: "entitlement-api",
            subject: { subject_id: "person-1" },
            acting_client: { acting_client_id: "client-1" },
            enforcement_point_id: "API_GATEWAY",
            decision: { input_receipt: {} },
          }] as never,
          hasMore: false,
          sourceRevision: 1,
        }
      },
    },
    connections: {
      async list() {
        return []
      },
    },
  })

  await materializer.refresh({ tenantId: "tenant-1" })

  assert.equal(recorded.length, 1)
  assert.equal(recorded[0]?.enforcement_point_id, "API_GATEWAY")
  assert.equal(recorded[0]?.method, "GET")
  assert.equal(recorded[0]?.path, "/incidents?client=keep&locale=zh-TW")
  assert.equal(recorded[0]?.status_code, 200)
  assert.equal(recorded[0]?.mcp_method, null)
  assert.equal(recorded[0]?.requested_model_id, "genio-chat")
  assert.equal(recorded[0]?.effective_model_id, "gpt-4.1")
  assert.equal(recorded[0]?.provider_id, "openai")
  assert.equal(recorded[0]?.input_tokens, 12)
  assert.equal(recorded[0]?.output_tokens, 7)
  assert.equal(recorded[0]?.total_tokens, 19)
})

test("OTel materializer selects a One Policy audit when other audit kinds sort first", async () => {
  const recorded: GatewayActivityIngest[] = []
  const correlationId = "mixed-audit-correlation"
  const auditEvents: Array<{ kind: string } & Record<string, unknown>> = [{
    kind: "RUNTIME_POLICY_DECISION",
  }, {
    kind: "ACCESS_GOVERNANCE_CHANGE",
  }, {
    kind: "ONE_POLICY_DECISION",
    resource_id: "resource-mixed-audit",
    capability_id: "mail.read",
    enforcement_point_id: "AI_GATEWAY",
    decision: { input_receipt: {} },
  }]
  const materializer = createClickHouseGatewayActivityMaterializer({
    origin: "http://clickhouse.test",
    database: "analytics",
    username: "user",
    password: "secret",
    fetch: async () => new Response(JSON.stringify({
      observed_at_millis: 2_500,
      attributes: {
        "genio.event.kind": "ai_gateway_activity",
        "x-request-id": correlationId,
        authority: "mail.example.test",
        method: "GET",
        path: "/messages",
        response_code: "200",
      },
    })),
    activities: {
      async record({ event }) {
        recorded.push(event)
        return {} as never
      },
    },
    audits: {
      async query(input) {
        const matching = auditEvents
          .filter((event) => !input.kind || event.kind === input.kind)
          .slice(input.offset, input.offset + input.limit)
        return {
          events: matching as never,
          hasMore: false,
          sourceRevision: 1,
        }
      },
    },
    connections: {
      async list() {
        return []
      },
    },
  })

  await materializer.refresh({ tenantId: "tenant-1" })

  assert.deepEqual(recorded.map((event) => ({
    correlation_id: event.correlation_id,
    resource_id: event.resource_id,
    capability_id: event.capability_id,
  })), [{
    correlation_id: correlationId,
    resource_id: "resource-mixed-audit",
    capability_id: "mail.read",
  }])
})

test("OTel attempted-host receipts materialize ordered failover and the selected Connection", async () => {
  const recorded: GatewayActivityIngest[] = []
  const attempts: RoutingAttemptIngest[] = []
  const correlationId = "routing-correlation-1"
  const rows = [{
    observed_at_millis: 3_000,
    attributes: {
      "genio.event.kind": "ai_gateway_activity",
      "x-request-id": correlationId,
      authority: "model.example.test",
      method: "POST",
      path: "/v1/chat/completions",
      response_code: "200",
      upstream_host: "127.0.0.1:1976",
    },
  }, {
    observed_at_millis: 3_001,
    attributes: {
      "genio.event.kind": "ai_gateway_activity",
      "x-request-id": correlationId,
      authority: "model.internal.test",
      method: "POST",
      path: "/v1/chat/completions",
      response_code: "200",
      upstream_host: "127.0.0.1:18081",
      upstream_hosts_attempted: "127.0.0.1:18081",
      upstream_request_attempt_count: "2",
    },
  }]
  const materializer = createClickHouseGatewayActivityMaterializer({
    origin: "http://clickhouse.test",
    database: "analytics",
    username: "user",
    password: "secret",
    fetch: async () => new Response(rows.map((row) => JSON.stringify(row)).join("\n")),
    activities: {
      async record({ event }) {
        recorded.push(event)
        return {} as never
      },
      async recordAttempt({ event }) {
        attempts.push(event)
        return {} as never
      },
      async get() {
        return {
          candidate_connection_ids: ["connection-primary", "connection-secondary"],
        } as never
      },
    },
    audits: {
      async query() {
        return {
          events: [{
            kind: "ONE_POLICY_DECISION",
            resource_id: "resource-routing",
            capability_id: "model.invoke",
            entitlement_id: "entitlement-routing",
            subject: { subject_id: "person-1" },
            acting_client: { acting_client_id: "client-1" },
            enforcement_point_id: "AI_GATEWAY",
            decision: { input_receipt: {} },
          }] as never,
          hasMore: false,
          sourceRevision: 1,
        }
      },
    },
    connections: {
      async list() {
        return [{
          connection_id: "connection-primary",
          endpoint: "http://127.0.0.1:18080/v1",
          configuration_revision: 3,
          routing_priority: 0,
        }, {
          connection_id: "connection-secondary",
          endpoint: "http://127.0.0.1:18081/v1",
          configuration_revision: 4,
          routing_priority: 10,
        }] as never
      },
    },
  })

  await materializer.refresh({ tenantId: "tenant-1" })

  assert.equal(recorded[0]?.connection_id, "connection-secondary")
  assert.deepEqual(attempts.map((attempt) => ({
    order: attempt.order,
    connection_id: attempt.connection_id,
    outcome: attempt.outcome,
    response_started: attempt.response_started,
  })), [{
    order: 1,
    connection_id: "connection-primary",
    outcome: "RETRIED_BEFORE_RESPONSE",
    response_started: false,
  }, {
    order: 2,
    connection_id: "connection-secondary",
    outcome: "SELECTED",
    response_started: true,
  }])
})

test("OTel materializer projects each persisted MCP Activity to PostHog", async () => {
  const recorded: GatewayActivityIngest[] = []
  const persisted: GatewayActivityEvent[] = []
  const captured: GatewayActivityEvent[] = []
  const correlationId = "posthog-mcp-correlation"
  const materializer = createClickHouseGatewayActivityMaterializer({
    origin: "http://clickhouse.test",
    database: "analytics",
    username: "user",
    password: "secret",
    fetch: async () => new Response(JSON.stringify({
      observed_at_millis: 4_000,
      attributes: {
        "genio.event.kind": "ai_gateway_activity",
        "x-request-id": correlationId,
        authority: "mcp.example.test",
        method: "POST",
        path: "/mcp",
        response_code: "200",
        duration: "18",
        "mcp.method.name": "tools/call",
        "mcp.tool.name": "search",
        "mcp.provider.name": "notion",
        upstream_host: "mcp.example.internal:443",
      },
    })),
    activities: {
      async get() {
        return persisted[0] ?? null
      },
      async record({ tenantId, event }) {
        recorded.push(event)
        const value = persistedActivity(tenantId, {
          ...event,
          provider_id: "NOTION",
        })
        persisted.push(value)
        return value
      },
    },
    audits: {
      async query() {
        return {
          events: [{
            kind: "ONE_POLICY_DECISION",
            resource_id: "resource-mcp",
            capability_id: "mcp.invoke",
            enforcement_point_id: "AI_GATEWAY",
            decision: { input_receipt: { mcp_tool: "notion__search" } },
          }] as never,
          hasMore: false,
          sourceRevision: 1,
        }
      },
    },
    connections: {
      async list() {
        return []
      },
    },
    postHog: {
      async capture({ event }) {
        captured.push(event)
      },
    },
  })

  await materializer.refresh({ tenantId: "tenant-1" })
  await materializer.refresh({ tenantId: "tenant-1" })

  assert.equal(recorded.length, 2)
  assert.equal(captured.length, 2)
  assert.deepEqual(captured, persisted)
  assert.equal(captured[0]?.tenant_id, "tenant-1")
  assert.equal(captured[0]?.provider_id, "NOTION")
  assert.equal(captured[0]?.mcp_tool, "notion__search")
})

test("OTel materializer retries a failed PostHog projection for an existing Activity", async () => {
  const recorded: GatewayActivityIngest[] = []
  const persisted: GatewayActivityEvent[] = []
  const captured: GatewayActivityEvent[] = []
  let captureAttempts = 0
  const materializer = createClickHouseGatewayActivityMaterializer({
    origin: "http://clickhouse.test",
    database: "analytics",
    username: "user",
    password: "secret",
    fetch: async () => new Response(JSON.stringify({
      observed_at_millis: 5_000,
      attributes: {
        "genio.event.kind": "ai_gateway_activity",
        "x-request-id": "posthog-failure-correlation",
        authority: "mcp.example.test",
        method: "POST",
        path: "/mcp",
        response_code: "200",
        "mcp.method.name": "tools/call",
        "mcp.tool.name": "search",
      },
    })),
    activities: {
      async get() {
        return persisted[0] ?? null
      },
      async record({ tenantId, event }) {
        recorded.push(event)
        const value = persistedActivity(tenantId, event)
        persisted.push(value)
        return value
      },
    },
    audits: {
      async query() {
        return {
          events: [{
            kind: "ONE_POLICY_DECISION",
            resource_id: "resource-mcp",
            capability_id: "mcp.invoke",
            enforcement_point_id: "AI_GATEWAY",
            decision: { input_receipt: { mcp_tool: "notion__search" } },
          }] as never,
          hasMore: false,
          sourceRevision: 1,
        }
      },
    },
    connections: {
      async list() {
        return []
      },
    },
    postHog: {
      async capture({ event }) {
        captureAttempts += 1
        if (captureAttempts === 1) throw new Error("unavailable")
        captured.push(event)
      },
    },
  })

  await materializer.refresh({ tenantId: "tenant-1" })
  await materializer.refresh({ tenantId: "tenant-1" })

  assert.equal(recorded.length, 2)
  assert.equal(captureAttempts, 2)
  assert.deepEqual(captured, [persisted[1]])
})
