import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"

import {
  GatewayProjectionPathSchema,
  GatewayProjectionRequestSchema,
  GatewayProjectionSchema,
} from "./contract"
import type { GatewayProjector } from "./module"

export interface GatewayProjectionHttpOptions {
  projector: GatewayProjector
}

export const gatewayProjectionHttp: FastifyPluginAsync<GatewayProjectionHttpOptions> = async (
  app,
  options,
) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()
  routes.post(
    "/v1/tenants/:tenant_id/ai-gateway/projections",
    {
      schema: {
        operationId: "compileGatewayProjection",
        summary: "Compile a persisted Publication snapshot into a signed Envoy projection",
        description:
          "The compiler accepts only a server-created Publication reference. Resource, Connection, model, and One Policy data are resolved from the immutable review snapshot.",
        tags: ["AI Gateway"],
        params: GatewayProjectionPathSchema,
        body: GatewayProjectionRequestSchema,
        response: { 200: GatewayProjectionSchema },
      },
    },
    async (request) =>
      options.projector.compile({
        tenantId: request.params.tenant_id,
        value: request.body,
      }),
  )
}
