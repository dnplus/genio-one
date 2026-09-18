import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"
import { Type } from "typebox"

import {
  ConfigureSiemDestinationSchema,
  SiemDeliveryListSchema,
  SiemDeliveryQuerySchema,
  SiemDestinationSchema,
  SiemTenantPathSchema,
} from "./contract"
import type { SiemForwarder } from "./module"

export const siemHttp: FastifyPluginAsync<{ forwarder: SiemForwarder }> = async (app, options) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()
  routes.get("/v1/tenants/:tenant_id/siem-destination", {
    schema: {
      tags: ["Audit"], params: SiemTenantPathSchema,
      response: { 200: Type.Union([SiemDestinationSchema, Type.Null()]) },
    },
  }, async (request) => options.forwarder.getDestination({ tenantId: request.params.tenant_id }))
  routes.put("/v1/tenants/:tenant_id/siem-destination", {
    schema: {
      tags: ["Audit"], params: SiemTenantPathSchema, body: ConfigureSiemDestinationSchema,
      response: { 200: SiemDestinationSchema },
    },
  }, async (request) => options.forwarder.configure({
    tenantId: request.params.tenant_id,
    configuredBySubjectId: request.principal!.subject_id,
    value: request.body,
  }))
  routes.get("/v1/tenants/:tenant_id/siem-deliveries", {
    schema: {
      tags: ["Audit"], params: SiemTenantPathSchema, querystring: SiemDeliveryQuerySchema,
      response: { 200: SiemDeliveryListSchema },
    },
  }, async (request) => options.forwarder.listDeliveries({
    tenantId: request.params.tenant_id,
    limit: request.query.limit ?? 100,
  }))
}
