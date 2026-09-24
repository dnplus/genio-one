import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"

import { TraceSpansPathSchema, TraceSpansQuerySchema, TraceSpansPageSchema, TraceInventorySchema, TraceListPathSchema, TraceListQuerySchema, LogListQuerySchema, LogInventorySchema } from "./contract"
import type { TraceStore } from "./module"

export const traceHttp: FastifyPluginAsync<{ store: TraceStore }> = async (app, options) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()
  routes.get("/v1/tenants/:tenant_id/traces/:trace_id/spans", { schema: { operationId: "listTraceSpans", tags: ["Observability"], params: TraceSpansPathSchema, querystring: TraceSpansQuerySchema, response: { 200: TraceSpansPageSchema } } }, async request => options.store.spans({ tenantId: request.params.tenant_id, traceId: request.params.trace_id, ...request.query }))
  routes.get(
    "/v1/tenants/:tenant_id/traces",
    {
      schema: {
        operationId: "listTraces",
        tags: ["Observability"],
        params: TraceListPathSchema,
        querystring: TraceListQuerySchema,
        response: { 200: TraceInventorySchema },
      },
    },
    async (request) => ({
      traces: await options.store.list({
        tenantId: request.params.tenant_id,
        limit: request.query.limit ?? 20,
        before: request.query.before,
        beforeTraceId: request.query.before_trace_id,
        correlationId: request.query.correlation_id,
        search: request.query.search,
        from: request.query.from,
        until: request.query.until,
      }),
    }),
  )
  routes.get("/v1/tenants/:tenant_id/logs", { schema: { operationId: "listTelemetryLogs", tags: ["Observability"], params: TraceListPathSchema, querystring: LogListQuerySchema, response: { 200: LogInventorySchema } } }, async request => options.store.logs({ tenantId: request.params.tenant_id, ...request.query }))

}
