import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"
import { Type } from "typebox"

import type { ProcessorAdapterCatalog } from "./catalog"

export interface ProcessorAdapterHttpOptions {
  catalog: ProcessorAdapterCatalog
}

const AdapterSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  kind: Type.Union([Type.Literal("JEV"), Type.Literal("HTTP"), Type.Literal("PRESIDIO")]),
  endpoint: Type.String({ minLength: 1 }),
  model: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false })

export const processorAdapterHttp: FastifyPluginAsync<ProcessorAdapterHttpOptions> = async (
  app,
  options,
) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()
  routes.get(
    "/v1/tenants/:tenant_id/processor-adapters",
    {
      schema: {
        operationId: "listProcessorAdapters",
        summary: "List tenant-scoped processor adapter metadata",
        tags: ["One Policy"],
        params: Type.Object({ tenant_id: Type.String({ minLength: 1 }) }),
        response: { 200: Type.Object({ adapters: Type.Array(AdapterSchema) }, { additionalProperties: false }) },
      },
    },
    async (request) => ({
      adapters: await options.catalog.list({ tenantId: request.params.tenant_id }),
    }),
  )
}
