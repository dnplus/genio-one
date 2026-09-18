import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"

import {
  GatewayBootstrapConfigurationSchema,
  GatewayLifecycleActionSchema,
  GatewayRegistrationListSchema,
  GatewayRegistrationPathSchema,
  GatewayRegistrationSchema,
  GatewayRegistrationTenantPathSchema,
  RegisterGatewaySchema,
} from "./contract"
import type { GatewayRegistrationLifecycle } from "./module"

export const gatewayRegistrationHttp: FastifyPluginAsync<{
  lifecycle: GatewayRegistrationLifecycle
}> = async (app, options) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()
  routes.get("/v1/tenants/:tenant_id/gateways", {
    schema: {
      operationId: "listGatewayRegistrations",
      tags: ["Gateway Registration"],
      params: GatewayRegistrationTenantPathSchema,
      response: { 200: GatewayRegistrationListSchema },
    },
  }, async (request) => options.lifecycle.list({ tenantId: request.params.tenant_id }))

  routes.post("/v1/tenants/:tenant_id/gateways", {
    schema: {
      operationId: "registerGateway",
      tags: ["Gateway Registration"],
      params: GatewayRegistrationTenantPathSchema,
      body: RegisterGatewaySchema,
      response: { 201: GatewayBootstrapConfigurationSchema },
    },
  }, async (request, reply) => reply.code(201).send(await options.lifecycle.register({
    tenantId: request.params.tenant_id,
    actorSubjectId: request.principal!.subject_id,
    value: request.body,
  })))

  routes.post("/v1/tenants/:tenant_id/gateways/:runtime_id/provision", {
    schema: {
      operationId: "provisionGateway",
      tags: ["Gateway Registration"],
      params: GatewayRegistrationPathSchema,
      body: GatewayLifecycleActionSchema,
      response: { 200: GatewayBootstrapConfigurationSchema },
    },
  }, async (request) => options.lifecycle.provision({
    tenantId: request.params.tenant_id,
    actorSubjectId: request.principal!.subject_id,
    runtimeId: request.params.runtime_id,
  }))

  routes.post("/v1/tenants/:tenant_id/gateways/:runtime_id/retire", {
    schema: {
      operationId: "retireGateway",
      tags: ["Gateway Registration"],
      params: GatewayRegistrationPathSchema,
      body: GatewayLifecycleActionSchema,
      response: { 200: GatewayRegistrationSchema },
    },
  }, async (request) => options.lifecycle.retire({
    tenantId: request.params.tenant_id,
    actorSubjectId: request.principal!.subject_id,
    runtimeId: request.params.runtime_id,
  }))
}
