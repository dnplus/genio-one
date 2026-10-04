import assert from "node:assert/strict"
import test from "node:test"

import type { GatewayActivityEvent, GatewayActivityIngest, RoutingAttemptIngest } from "../src/capabilities/activities/contract"
import { createClickHouseGatewayActivityMaterializer } from "../src/capabilities/activities/otel-clickhouse"
import { createPostHogGatewayActivitySink } from "../src/capabilities/activities/posthog"

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

function otelSpan(input: {
  traceId: string
  spanId: string
  parentSpanId: string | null
  spanName: string
  spanKind: string
  serviceName?: string
  correlationId?: string | null
  resourceTenantId?: string | null
  spanTenantId?: string | null
  httpStatus?: string | null
  statusCode: string
  mcpMethod?: string | null
  mcpTool?: string | null
  errorType?: string | null
  hasExceptionEvent?: boolean
  hasExceptionType?: boolean
}): Record<string, unknown> {
  return {
    service_name: input.serviceName ?? "genio-ai-mcp-gateway.genio-one",
    trace_id: input.traceId,
    span_id: input.spanId,
    parent_span_id: input.parentSpanId,
    span_name: input.spanName,
    span_kind: input.spanKind,
    correlation_id: input.correlationId ?? null,
    resource_tenant_id: input.resourceTenantId ?? null,
    span_tenant_id: input.spanTenantId ?? null,
    http_status: input.httpStatus ?? null,
    status_code: input.statusCode,
    mcp_method: input.mcpMethod ?? null,
    mcp_tool: input.mcpTool ?? null,
    error_type: input.errorType ?? null,
    has_exception_event: input.hasExceptionEvent ?? false,
    has_exception_type: input.hasExceptionType ?? false,
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

test("OTel materializer waits for a trusted completion span before projecting an HTTP 200 MCP Activity", async () => {
  const recorded: GatewayActivityIngest[] = []
  const captured: GatewayActivityEvent[] = []
  const queries: string[] = []
  const correlationId = "mcp-semantic-error-correlation"
  const traceId = "a".repeat(32)
  const logRows = [{
    observed_at_millis: 1_100,
    trace_id: traceId,
    resource_tenant_id: "tenant-1",
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
  }]
  let spanRows: Array<Record<string, unknown>> = []
  const materializer = createClickHouseGatewayActivityMaterializer({
    origin: "http://clickhouse.test",
    database: "analytics",
    username: "user",
    password: "secret",
    fetch: async (_input, init) => {
      const query = String(init?.body)
      queries.push(query)
      return query.includes("otel_traces")
        ? new Response(spanRows.map((row) => JSON.stringify(row)).join("\n"))
        : new Response(logRows.map((row) => JSON.stringify(row)).join("\n"))
    },
    activities: {
      async record({ tenantId, event }) {
        recorded.push(event)
        return persistedActivity(tenantId, event)
      },
    },
    audits: {
      async query() {
        return {
          events: [{
            kind: "ONE_POLICY_DECISION",
            resource_id: "resource-mcp-error",
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

  assert.equal(recorded.length, 1)
  assert.equal(recorded[0]?.status_code, 200)
  assert.equal(recorded[0]?.outcome, "COMPLETED")
  assert.equal(recorded[0]?.error_code, null)
  assert.equal(captured.length, 0)

  spanRows = [
    otelSpan({
      traceId,
      spanId: "1".repeat(16),
      parentSpanId: null,
      spanName: "ingress",
      spanKind: "Server",
      correlationId,
      httpStatus: "200",
      statusCode: "Unset",
    }),
    otelSpan({
      traceId,
      spanId: "2".repeat(16),
      parentSpanId: "1".repeat(16),
      spanName: "router httproute/mail2000",
      spanKind: "Client",
      statusCode: "Unset",
    }),
    otelSpan({
      traceId,
      spanId: "3".repeat(16),
      parentSpanId: "2".repeat(16),
      spanName: "tools/call notion__search",
      spanKind: "Client",
      serviceName: "ai-gateway",
      correlationId,
      statusCode: "Error",
      mcpMethod: "tools/call",
      errorType: "internal_error",
      hasExceptionEvent: true,
      hasExceptionType: true,
    }),
  ]
  await materializer.refresh({ tenantId: "tenant-1" })

  assert.equal(recorded.length, 2)
  assert.equal(recorded[1]?.status_code, 200)
  assert.equal(recorded[1]?.outcome, "FAILED")
  assert.equal(recorded[1]?.error_code, "MCP_TOOL_RESULT_ERROR")
  assert.equal(captured.length, 1)
  assert.equal(captured[0]?.outcome, "FAILED")
  assert.equal(queries.length, 4)
  assert.match(queries[1]!, /TraceId as trace_id/)
  assert.ok(queries[1]!.includes("match(ServiceName, '^genio-ai-mcp-gateway(?:\\\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)?$'"))
  assert.ok(queries[1]!.includes("ServiceName = 'ai-gateway'"))
  assert.match(queries[1]!, /ResourceAttributes\['genio\.tenant\.id'\] = 'tenant-1'/)
  assert.match(queries[1]!, /SpanAttributes\['genio\.tenant\.id'\] = 'tenant-1'/)
  assert.match(queries[1]!, /TraceId in \('[a]{32}'\)/)
  assert.match(queries[1]!, /SpanName = 'ingress'/)
  assert.match(queries[1]!, /SpanKind = 'Server'/)
  assert.match(queries[1]!, /StatusCode in \('Error', 'Ok', 'Unset'\)/)
  assert.match(queries[1]!, /SpanAttributes\['http\.status_code'\] = '200'/)
  assert.match(queries[1]!, /ParentSpanId as parent_span_id/)
  assert.match(queries[1]!, /SpanAttributes\['error\.type'\] as error_type/)
  assert.match(queries[1]!, /has\(Events\.Name, 'exception'\)/)
  assert.match(queries[1]!, /SpanAttributes\['genio\.correlation\.id'\] in \('mcp-semantic-error-correlation'\)/)
  assert.doesNotMatch(queries[1]!, /SpanAttributes as attributes|Body|StatusMessage|exception\.message/i)
})

test("OTel MCP semantic errors require tenant or owned trace identity and preserve HTTP failures", async () => {
  const recorded: GatewayActivityIngest[] = []
  const captured: GatewayActivityEvent[] = []
  const queries: string[] = []
  const rows = [
    {
      correlationId: "mcp-valid-correlation",
      traceId: "b".repeat(32),
      responseCode: "200",
      responseDetails: null,
    },
    {
      correlationId: "mcp-wrong-tenant-correlation",
      traceId: "c".repeat(32),
      responseCode: "200",
      responseDetails: null,
    },
    {
      correlationId: "mcp-wrong-trace-correlation",
      traceId: "d".repeat(32),
      responseCode: "200",
      responseDetails: null,
    },
    {
      correlationId: "mcp-http-failure-correlation",
      traceId: "e".repeat(32),
      responseCode: "502",
      responseDetails: "upstream_reset",
    },
    {
      correlationId: "mcp-success-correlation",
      traceId: "f".repeat(32),
      responseCode: "200",
      responseDetails: null,
    },
    {
      correlationId: "mcp-unset-correlation",
      traceId: "g".repeat(32),
      responseCode: "200",
      responseDetails: null,
    },
    {
      correlationId: "mcp-error-without-metadata-correlation",
      traceId: "l".repeat(32),
      responseCode: "200",
      responseDetails: null,
    },
    {
      correlationId: "mcp-untrusted-service-correlation",
      traceId: "h".repeat(32),
      responseCode: "200",
      responseDetails: null,
    },
    {
      correlationId: "mcp-wrong-span-correlation",
      traceId: "i".repeat(32),
      responseCode: "200",
      responseDetails: null,
    },
    {
      correlationId: "mcp-wrong-tool-correlation",
      traceId: "j".repeat(32),
      responseCode: "200",
      responseDetails: null,
    },
    {
      correlationId: "mcp-parent-mismatch-correlation",
      traceId: "k".repeat(32),
      responseCode: "200",
      responseDetails: null,
    },
  ]
  const logRows = rows.map((row, index) => ({
    observed_at_millis: 1_200 + index,
    trace_id: row.traceId,
    resource_tenant_id: "tenant-1",
    attributes: {
      "genio.event.kind": "ai_gateway_activity",
      "x-request-id": row.correlationId,
      authority: "mcp.example.test",
      method: "POST",
      path: "/mcp",
      response_code: row.responseCode,
      ...(row.responseDetails ? { response_code_details: row.responseDetails } : {}),
      "mcp.method.name": "tools/call",
      "mcp.tool.name": "search",
      "mcp.provider.name": "notion",
      upstream_host: "mcp.example.internal:443",
    },
  }))
  const chain = (input: {
    traceId: string
    correlationId: string
    finalStatus: string
    finalServiceName?: string
    finalCorrelationId?: string
    finalTool?: string
    finalResourceTenantId?: string | null
    finalParentSpanId?: string
    errorType?: string | null
    hasExceptionEvent?: boolean
  }): Record<string, unknown>[] => {
    const ingressSpanId = `${input.traceId.slice(0, 1)}1`.repeat(8)
    const routerSpanId = `${input.traceId.slice(0, 1)}2`.repeat(8)
    const finalSpanId = `${input.traceId.slice(0, 1)}3`.repeat(8)
    return [
      otelSpan({
        traceId: input.traceId,
        spanId: ingressSpanId,
        parentSpanId: null,
        spanName: "ingress",
        spanKind: "Server",
        correlationId: input.correlationId,
        httpStatus: "200",
        statusCode: "Unset",
      }),
      otelSpan({
        traceId: input.traceId,
        spanId: routerSpanId,
        parentSpanId: ingressSpanId,
        spanName: "router httproute/mcp",
        spanKind: "Client",
        statusCode: "Unset",
      }),
      otelSpan({
        traceId: input.traceId,
        spanId: finalSpanId,
        parentSpanId: input.finalParentSpanId ?? routerSpanId,
        spanName: `tools/call ${input.finalTool ?? "notion__search"}`,
        spanKind: "Client",
        serviceName: input.finalServiceName ?? "ai-gateway",
        correlationId: input.finalCorrelationId ?? input.correlationId,
        resourceTenantId: input.finalResourceTenantId,
        statusCode: input.finalStatus,
        mcpMethod: "tools/call",
        errorType: input.errorType ?? null,
        hasExceptionEvent: input.hasExceptionEvent ?? false,
      }),
    ]
  }
  const spanRows = [
    ...chain({
      traceId: rows[0]!.traceId,
      correlationId: rows[0]!.correlationId,
      finalStatus: "Error",
      errorType: "internal_error",
      hasExceptionEvent: true,
    }),
    ...chain({
      traceId: rows[1]!.traceId,
      correlationId: rows[1]!.correlationId,
      finalStatus: "Error",
      finalResourceTenantId: "tenant-other",
      errorType: "internal_error",
      hasExceptionEvent: true,
    }),
    ...chain({
      traceId: "1".repeat(32),
      correlationId: rows[2]!.correlationId,
      finalStatus: "Error",
      errorType: "internal_error",
      hasExceptionEvent: true,
    }),
    ...chain({
      traceId: rows[4]!.traceId,
      correlationId: rows[4]!.correlationId,
      finalStatus: "Ok",
    }),
    ...chain({
      traceId: rows[5]!.traceId,
      correlationId: rows[5]!.correlationId,
      finalStatus: "Unset",
    }),
    ...chain({
      traceId: rows[6]!.traceId,
      correlationId: rows[6]!.correlationId,
      finalStatus: "Error",
    }),
    ...chain({
      traceId: rows[7]!.traceId,
      correlationId: rows[7]!.correlationId,
      finalStatus: "Error",
      finalServiceName: "untrusted-service",
      errorType: "internal_error",
      hasExceptionEvent: true,
    }),
    ...chain({
      traceId: rows[8]!.traceId,
      correlationId: rows[8]!.correlationId,
      finalStatus: "Error",
      finalCorrelationId: "different-correlation",
      errorType: "internal_error",
      hasExceptionEvent: true,
    }),
    ...chain({
      traceId: rows[9]!.traceId,
      correlationId: rows[9]!.correlationId,
      finalStatus: "Error",
      finalTool: "other__tool",
      errorType: "internal_error",
      hasExceptionEvent: true,
    }),
    ...chain({
      traceId: rows[10]!.traceId,
      correlationId: rows[10]!.correlationId,
      finalStatus: "Error",
      finalParentSpanId: "missing-parent",
      errorType: "internal_error",
      hasExceptionEvent: true,
    }),
  ]
  const materializer = createClickHouseGatewayActivityMaterializer({
    origin: "http://clickhouse.test",
    database: "analytics",
    username: "user",
    password: "secret",
    fetch: async (_input, init) => {
      const query = String(init?.body)
      queries.push(query)
      return query.includes("otel_traces")
        ? new Response(spanRows.map((row) => JSON.stringify(row)).join("\n"))
        : new Response(logRows.map((row) => JSON.stringify(row)).join("\n"))
    },
    activities: {
      async record({ tenantId, event }) {
        recorded.push(event)
        return persistedActivity(tenantId, event)
      },
    },
    audits: {
      async query(input) {
        return {
          events: [{
            kind: "ONE_POLICY_DECISION",
            resource_id: `resource-${input.correlationId}`,
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

  const byCorrelation = new Map(recorded.map((event) => [event.correlation_id, event]))
  assert.equal(byCorrelation.get(rows[0]!.correlationId)?.outcome, "FAILED")
  assert.equal(byCorrelation.get(rows[0]!.correlationId)?.error_code, "MCP_TOOL_RESULT_ERROR")
  for (const index of [1, 2, 4, 5, 7, 8, 9, 10]) {
    assert.equal(byCorrelation.get(rows[index]!.correlationId)?.outcome, "COMPLETED", rows[index]!.correlationId)
    assert.equal(byCorrelation.get(rows[index]!.correlationId)?.error_code, null, rows[index]!.correlationId)
  }
  assert.equal(byCorrelation.get(rows[6]!.correlationId)?.status_code, 200)
  assert.equal(byCorrelation.get(rows[6]!.correlationId)?.outcome, "FAILED")
  assert.equal(byCorrelation.get(rows[6]!.correlationId)?.error_code, "MCP_TOOL_RESULT_ERROR")
  assert.equal(byCorrelation.get(rows[3]!.correlationId)?.status_code, 502)
  assert.equal(byCorrelation.get(rows[3]!.correlationId)?.outcome, "FAILED")
  assert.equal(byCorrelation.get(rows[3]!.correlationId)?.error_code, "upstream_reset")
  assert.deepEqual(captured.map((event) => event.correlation_id), [
    rows[0]!.correlationId,
    rows[3]!.correlationId,
    rows[4]!.correlationId,
    rows[6]!.correlationId,
  ])
  const capturedError = captured.find((event) => event.correlation_id === rows[6]!.correlationId)!
  const projected: Array<{ event: string; properties: Record<string, unknown> }> = []
  const sink = createPostHogGatewayActivitySink({
    integrations: {
      async get() {
        return {
          enabled: true,
          host: "https://us.i.posthog.com",
          project_id: 630618,
          project_token: "phc_materializer_test",
          configured_by: "tenant-admin",
          configured_at: 1,
        }
      },
    },
    request: Object.assign(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      projected.push(JSON.parse(String(init?.body)))
      return Response.json({ status: 1 })
    }, { preconnect: fetch.preconnect }),
  })
  await sink.capture({ event: capturedError })
  assert.deepEqual(projected.map((event) => event.event), ["$mcp_tool_call", "$ai_span"])
  assert.equal(projected.find((event) => event.event === "$mcp_tool_call")?.properties.$mcp_is_error, true)
  assert.equal(projected.find((event) => event.event === "$ai_span")?.properties.$ai_is_error, true)
  assert.equal(projected.find((event) => event.event === "$ai_span")?.properties.$ai_http_status, 200)
  assert.ok(queries[1]!.includes("match(ServiceName, '^genio-ai-mcp-gateway(?:\\\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)?$'"))
  assert.doesNotMatch(queries[1]!, /ServiceName !=|NOT trusted|Body|SpanAttributes as attributes/i)
})

test("OTel MCP span enrichment failure does not block the canonical Activity", async () => {
  const recorded: GatewayActivityIngest[] = []
  const captured: GatewayActivityEvent[] = []
  const correlationId = "mcp-span-query-failure-correlation"
  let queryCount = 0
  const materializer = createClickHouseGatewayActivityMaterializer({
    origin: "http://clickhouse.test",
    database: "analytics",
    username: "user",
    password: "secret",
    fetch: async () => {
      queryCount += 1
      if (queryCount === 2) return new Response("unavailable", { status: 503 })
      return new Response(JSON.stringify({
        observed_at_millis: 1_300,
        trace_id: "1".repeat(32),
        resource_tenant_id: "tenant-1",
        attributes: {
          "genio.event.kind": "ai_gateway_activity",
          "x-request-id": correlationId,
          authority: "mcp.example.test",
          method: "POST",
          path: "/mcp",
          response_code: "200",
          "mcp.method.name": "tools/call",
          "mcp.tool.name": "search",
        },
      }))
    },
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
            resource_id: "resource-mcp-query-failure",
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

  assert.equal(queryCount, 2)
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0]?.status_code, 200)
  assert.equal(recorded[0]?.outcome, "COMPLETED")
  assert.equal(recorded[0]?.error_code, null)
  assert.equal(captured.length, 0)
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
    fetch: async (_input, init) => {
      const query = String(init?.body)
      return query.includes("otel_traces")
        ? new Response([
            otelSpan({
              traceId: "4".repeat(32),
              spanId: "4".repeat(16),
              parentSpanId: null,
              spanName: "ingress",
              spanKind: "Server",
              correlationId,
              httpStatus: "200",
              statusCode: "Unset",
            }),
            otelSpan({
              traceId: "4".repeat(32),
              spanId: "4".repeat(16).replaceAll("4", "5"),
              parentSpanId: "4".repeat(16),
              spanName: "router httproute/mcp",
              spanKind: "Client",
              statusCode: "Unset",
            }),
            otelSpan({
              traceId: "4".repeat(32),
              spanId: "4".repeat(16).replaceAll("4", "6"),
              parentSpanId: "5".repeat(16),
              spanName: "tools/call notion__search",
              spanKind: "Client",
              serviceName: "ai-gateway",
              correlationId,
              statusCode: "Ok",
              mcpMethod: "tools/call",
            }),
          ].map((row) => JSON.stringify(row)).join("\n"))
        : new Response(JSON.stringify({
            observed_at_millis: 4_000,
            trace_id: "4".repeat(32),
            resource_tenant_id: "tenant-1",
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
          }))
    },
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
    fetch: async (_input, init) => {
      const query = String(init?.body)
      return query.includes("otel_traces")
        ? new Response([
            otelSpan({
              traceId: "5".repeat(32),
              spanId: "5".repeat(16),
              parentSpanId: null,
              spanName: "ingress",
              spanKind: "Server",
              correlationId: "posthog-failure-correlation",
              httpStatus: "200",
              statusCode: "Unset",
            }),
            otelSpan({
              traceId: "5".repeat(32),
              spanId: "5".repeat(16).replaceAll("5", "6"),
              parentSpanId: "5".repeat(16),
              spanName: "router httproute/mcp",
              spanKind: "Client",
              statusCode: "Unset",
            }),
            otelSpan({
              traceId: "5".repeat(32),
              spanId: "5".repeat(16).replaceAll("5", "7"),
              parentSpanId: "6".repeat(16),
              spanName: "tools/call notion__search",
              spanKind: "Client",
              serviceName: "ai-gateway",
              correlationId: "posthog-failure-correlation",
              statusCode: "Ok",
              mcpMethod: "tools/call",
            }),
          ].map((row) => JSON.stringify(row)).join("\n"))
        : new Response(JSON.stringify({
            observed_at_millis: 5_000,
            trace_id: "5".repeat(32),
            resource_tenant_id: "tenant-1",
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
          }))
    },
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
