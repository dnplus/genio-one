import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"

import {
  GatewayDiagnosticSettingsPathSchema,
  GatewayDiagnosticSettingsSchema,
  UpdateGatewayDiagnosticSettingsSchema,
} from "./contract"
import type { GatewayDiagnosticSettingsStore } from "./module"

export const gatewayDiagnosticSettingsHttp: FastifyPluginAsync<{
  store: GatewayDiagnosticSettingsStore
}> = async (app, options) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()
  routes.get("/v1/tenants/:tenant_id/gateway-groups/:gateway_id/diagnostics", {
    schema: {
      operationId: "getGatewayDiagnosticSettings",
      tags: ["Runtime Control"],
      params: GatewayDiagnosticSettingsPathSchema,
      response: { 200: GatewayDiagnosticSettingsSchema },
    },
  }, async (request) => options.store.get({
    tenantId: request.params.tenant_id,
    gatewayId: request.params.gateway_id,
  }))
  routes.put("/v1/tenants/:tenant_id/gateway-groups/:gateway_id/diagnostics", {
    schema: {
      operationId: "updateGatewayDiagnosticSettings",
      tags: ["Runtime Control"],
      params: GatewayDiagnosticSettingsPathSchema,
      body: UpdateGatewayDiagnosticSettingsSchema,
      response: { 200: GatewayDiagnosticSettingsSchema },
    },
  }, async (request) => options.store.update({
    tenantId: request.params.tenant_id,
    gatewayId: request.params.gateway_id,
    updatedBy: request.principal!.subject_id,
    value: request.body,
  }))
}
