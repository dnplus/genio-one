import assert from "node:assert/strict"
import test from "node:test"

import Fastify from "fastify"

import { gatewayActivityHttp } from "../src/capabilities/activities/http"
import { createClickHouseGatewayActivityDetailStore } from "../src/capabilities/activities/detail-clickhouse"
import type { GatewayActivityDetail } from "../src/capabilities/activities/detail-contract"

function activityStore() {
  return {
    async record() { return {} as never },
    async list() { return [] },
    async trend() { return [] },
    async summarize({ tenantId, from, to }: { tenantId: string; from: number; to: number }) {
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
  }
}

test("ClickHouse activity detail reads native GenAI content attributes", async () => {
  const queries: string[] = []
  const store = createClickHouseGatewayActivityDetailStore({
    origin: "http://clickhouse.test",
    database: "analytics",
    username: "user",
    password: "secret",
    fetch: async (_url, init) => {
      queries.push(String(init?.body))
      return new Response([
        JSON.stringify({
          captured_at_millis: "1700000000123",
          attributes: {
            "gen_ai.input.messages": JSON.stringify([{ role: "user", content: "hello" }]),
            "gen_ai.output.messages": JSON.stringify([{ role: "assistant", content: "world" }]),
            "gen_ai.input.mime_type": "application/json",
            "gen_ai.output.mime_type": "application/json",
            "input.truncated": "true",
          },
        }),
      ].join("\n"))
    },
  })

  const detail = await store.get({ tenantId: "tenant-1", correlationId: "corr-1" })
  assert.deepEqual(detail, {
    correlation_id: "corr-1",
    availability: "AVAILABLE",
    captured_at: 1_700_000_000,
    expires_at: 1_700_086_400,
    redacted_fields: [],
    request: {
      headers: [],
      body: '[\n  {\n    "role": "user",\n    "content": "hello"\n  }\n]',
      body_truncated: true,
      content_type: "application/json",
    },
    response: {
      headers: [],
      body: '[\n  {\n    "role": "assistant",\n    "content": "world"\n  }\n]',
      body_truncated: false,
      content_type: "application/json",
    },
  } satisfies GatewayActivityDetail)
  assert.match(queries[0]!, /ResourceAttributes\['genio\.tenant\.id'\] = 'tenant-1'/)
  assert.match(queries[0]!, /SpanAttributes\['genio\.correlation\.id'\] = 'corr-1'/)
  assert.match(queries[0]!, /analytics\.otel_gateway_details/)
  assert.match(queries[0]!, /Timestamp >= now\(\) - interval 86400 second/)
})

test("ClickHouse activity detail supports flattened OpenInference messages", async () => {
  const store = createClickHouseGatewayActivityDetailStore({
    origin: "http://clickhouse.test",
    database: "analytics",
    username: "user",
    password: "secret",
    fetch: async () => new Response(JSON.stringify({
      captured_at_millis: 2_000,
      attributes: {
        "llm.input_messages.1.message.role": "user",
        "llm.input_messages.1.message.content": "second",
        "llm.input_messages.0.message.role": "system",
        "llm.input_messages.0.message.content": "first",
      },
    })),
  })

  const detail = await store.get({ tenantId: "tenant-1", correlationId: "corr-2" })
  assert.equal(detail?.availability, "AVAILABLE")
  assert.match(detail?.request?.body ?? "", /\"first\"/)
  assert.match(detail?.request?.body ?? "", /\"second\"/)
})

test("ClickHouse activity detail does not present message metadata as captured content", async () => {
  const store = createClickHouseGatewayActivityDetailStore({
    origin: "http://clickhouse.test",
    database: "analytics",
    username: "user",
    password: "secret",
    fetch: async () => new Response(JSON.stringify({
      captured_at_millis: 2_000,
      attributes: {
        "gen_ai.input.messages": JSON.stringify([{
          role: "user",
          parts: [{ type: "text", content: "captured" }],
        }]),
        "gen_ai.output.messages": JSON.stringify([{
          role: "assistant",
          parts: [],
          finish_reason: "stop",
        }]),
      },
    })),
  })

  const detail = await store.get({ tenantId: "tenant-1", correlationId: "corr-metadata" })
  assert.equal(detail?.availability, "AVAILABLE")
  assert.match(detail?.request?.body ?? "", /\"captured\"/)
  assert.equal(detail?.response, null)
})

test("Activity detail route returns a tenant-scoped detail record", async () => {
  const app = Fastify()
  await app.register(gatewayActivityHttp, {
    store: activityStore(),
    detail: {
      async get({ tenantId, correlationId }) {
        if (tenantId !== "tenant-1" || correlationId !== "corr-1") return null
        return {
          correlation_id: correlationId,
          availability: "AVAILABLE",
          captured_at: 1_700_000_000,
          expires_at: null,
          redacted_fields: [],
          request: null,
          response: null,
        }
      },
    },
    authorizeRuntime: async () => {},
  })

  const response = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-1/api-activities/corr-1/detail",
  })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().correlation_id, "corr-1")

  const missing = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-2/api-activities/corr-1/detail",
  })
  assert.equal(missing.statusCode, 404)
  assert.equal(missing.json().code, "ACTIVITY_DETAIL_NOT_FOUND")
  await app.close()
})
