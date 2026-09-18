import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"

import { GatewayMetricsPathSchema, GatewayMetricsQuerySchema, GatewayMetricsSummarySchema } from "./contract"
import type { GatewayMetricsStore } from "./module"

export const gatewayMetricsHttp: FastifyPluginAsync<{ store: GatewayMetricsStore }> = async (app, options) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()
  routes.get(
    "/v1/tenants/:tenant_id/metrics",
    {
      schema: {
        operationId: "getGatewayMetrics",
        tags: ["Observability"],
        params: GatewayMetricsPathSchema,
        querystring: GatewayMetricsQuerySchema,
        response: { 200: GatewayMetricsSummarySchema },
      },
    },
    async (request) => options.store.summarize({
      tenantId: request.params.tenant_id,
      windowSeconds: request.query.window_seconds ?? 900,
    }),
  )
}
