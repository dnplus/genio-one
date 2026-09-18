import assert from "node:assert/strict"
import test from "node:test"

import { createClickHouseGatewayMetricsStore } from "../src/capabilities/metrics/clickhouse"
import { createClickHouseTraceStore } from "../src/capabilities/traces/clickhouse"

const clickhouse = {
  origin: "http://clickhouse.test",
  database: "analytics",
  username: "reader",
  password: "secret",
}

test("ClickHouse traces keep tenant-scoped trace selection and return the complete span set", async () => {
  let query = ""
  const store = createClickHouseTraceStore({
    ...clickhouse,
    fetch: async (_input, init) => {
      query = String(init?.body)
      return new Response([
        JSON.stringify({ trace_id: "1".repeat(32), span_id: "2".repeat(16), parent_span_id: "", span_name: "ingress", service_name: "gateway", started_at_millis: 1000, duration_nanos: 2_000_000, status_code: "Ok", correlation_id: "request-1" }),
        JSON.stringify({ trace_id: "1".repeat(32), span_id: "3".repeat(16), parent_span_id: "2".repeat(16), span_name: "provider", service_name: "gateway", started_at_millis: 1001, duration_nanos: 500_000, status_code: "Unset", correlation_id: "" }),
      ].join("\n"), { status: 200 })
    },
  })
  const traces = await store.list({ tenantId: "tenant-1", limit: 5 })
  assert.match(query, /SpanAttributes\['genio\.tenant\.id'\] = 'tenant-1'/)
  assert.match(query, /and TraceId in/)
  assert.match(query, /where \(ResourceAttributes\[/)
  assert.match(query, /SpanAttributes as attributes/)
  assert.equal(traces[0]?.span_count, 2)
  assert.equal(traces[0]?.correlation_id, "request-1")
})

test("ClickHouse metrics summarize only the public listener and provider hop", async () => {
  const queries: string[] = []
  const responses = [
    { request_count: 3, success_count: 3, error_count: 0, provider_attempt_count: 3, sampled_at: 1234 },
    { latency_samples: 3, latency_total_millis: 750, request_bytes: 300, response_bytes: 900 },
  ]
  const store = createClickHouseGatewayMetricsStore({
    ...clickhouse,
    fetch: async (_input, init) => {
      queries.push(String(init?.body))
      return new Response(`${JSON.stringify(responses.shift())}\n`, { status: 200 })
    },
  })
  const summary = await store.summarize({ tenantId: "tenant-1", windowSeconds: 900 })
  assert.ok(queries.join("\n").includes("^http-[0-9]+$"))
  assert.match(queries.join("\n"), /select distinct ResourceAttributes/)
  assert.match(queries.join("\n"), /listener\.http\.downstream_rq_completed/)
  assert.match(queries.join("\n"), /listener\.http\.downstream_rq_xx/)
  assert.match(queries.join("\n"), /%-aigw\/%/)
  assert.match(queries.join("\n"), /ResourceAttributes\['genio\.tenant\.id'\] = 'tenant-1'/)
  assert.deepEqual(summary, {
    tenant_id: "tenant-1",
    enforcement_point_id: "AI_GATEWAY",
    window_seconds: 900,
    sampled_at: 1234,
    request_count: 3,
    success_count: 3,
    error_count: 0,
    provider_attempt_count: 3,
    average_latency_millis: 250,
    request_bytes: 300,
    response_bytes: 900,
  })
})

test("raw logs use tenant-scoped keyset pagination and load full records only on expansion", async () => {
  const queries: string[] = []
  const row = (id: string) => ({ record_id: id.repeat(32), timestamp_nanos: "1788930000000000000", timestamp_millis: 1788930000000, service: "test", severity: "INFO", body: "event", trace_id: "a".repeat(32), span_id: "b".repeat(16), correlation_id: "correlation", details_loaded: false, attributes: null, resource_attributes: null })
  const store = createClickHouseTraceStore({ ...clickhouse, fetch: async (_input, init) => { queries.push(String(init?.body)); return new Response([row("A"), row("B")].map(value => JSON.stringify(value)).join("\n")) } })
  const page = await store.logs({ tenantId: "tenant-1", limit: 1 })
  assert.equal(page.records.length, 1)
  assert.ok(page.next_cursor)
  await store.logs({ tenantId: "tenant-1", limit: 1, cursor: page.next_cursor! })
  assert.match(queries[0]!, /LogAttributes\['genio.tenant.id'\] = 'tenant-1'/)
  assert.match(queries[0]!, /NULL as attributes/)
  assert.match(queries[1]!, /\(Timestamp, record_id\) </)
  await store.logs({ tenantId: "tenant-1", record_id: "A".repeat(32), timestamp_nanos: "1788930000000000000" })
  assert.match(queries[2]!, /LogAttributes as attributes/)
  assert.match(queries[2]!, /Timestamp = fromUnixTimestamp64Nano/)
  await assert.rejects(store.logs({ tenantId: "tenant-1", cursor: "invalid" }), /INVALID_LOG_CURSOR/)
})

test("trace span pages retain full metadata and advance within the authorized tenant", async () => {
  const queries: string[] = []
  const row = (span: string) => ({ trace_id: "a".repeat(32), span_id: span.repeat(16), parent_span_id: "", span_name: "operation", service_name: "producer", started_at_millis: 1000, duration_nanos: 1000000, status_code: "Ok", correlation_id: "request", attributes: { complete: "payload" }, resource_attributes: { version: "1" } })
  const store = createClickHouseTraceStore({ ...clickhouse, fetch: async (_input, init) => { queries.push(String(init?.body)); return new Response([row("b"), row("c")].map(value => JSON.stringify(value)).join("\n")) } })
  const first = await store.spans({ tenantId: "tenant-1", traceId: "a".repeat(32), limit: 1 })
  assert.equal(first.spans.length, 1)
  assert.equal(first.spans[0]?.attributes?.complete, "payload")
  assert.equal(first.next_cursor, "b".repeat(16))
  await store.spans({ tenantId: "tenant-1", traceId: "a".repeat(32), after: first.next_cursor!, limit: 1 })
  assert.match(queries[1]!, /SpanId > 'bbbbbbbbbbbbbbbb'/)
  assert.match(queries[1]!, /ResourceAttributes\['genio.tenant.id'\] = 'tenant-1'/)
})
