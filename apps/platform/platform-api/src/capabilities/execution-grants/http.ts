import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"

import { PlatformApiError } from "../errors"
import { CreateExecutionGrantRequestSchema, DecideExecutionGrantRequestSchema, ExecutionGrantRequestListSchema, ExecutionGrantRequestPathSchema, ExecutionGrantRequestSchema, ExecutionGrantTenantPathSchema } from "./contract"
import type { ExecutionGrantDirectory } from "./module"

export const executionGrantHttp: FastifyPluginAsync<{ directory: ExecutionGrantDirectory }> = async (app, options) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()
  routes.get("/v1/tenants/:tenant_id/execution-grant-requests", {
    schema: { operationId: "listExecutionGrantRequests", tags: ["Execution Grant"], params: ExecutionGrantTenantPathSchema, response: { 200: ExecutionGrantRequestListSchema } },
  }, async (request) => {
    if (!request.principal) throw new PlatformApiError("AUTHENTICATION_REQUIRED", 401)
    return options.directory.list({ tenantId: request.params.tenant_id, actor: { subjectId: request.principal.subject_id, tenantAdministrator: request.principal.role === "TENANT_ADMINISTRATOR" } })
  })
  routes.post("/v1/tenants/:tenant_id/execution-grant-requests", {
    schema: { operationId: "createExecutionGrantRequest", tags: ["Execution Grant"], params: ExecutionGrantTenantPathSchema, body: CreateExecutionGrantRequestSchema, response: { 201: ExecutionGrantRequestSchema } },
  }, async (request, reply) => {
    if (!request.principal) throw new PlatformApiError("AUTHENTICATION_REQUIRED", 401)
    return reply.code(201).send(await options.directory.request({ tenantId: request.params.tenant_id, actor: { subjectId: request.principal.subject_id, actingClientId: request.principal.client_id }, value: request.body }))
  })
  routes.post("/v1/tenants/:tenant_id/execution-grant-requests/:request_id/decision", {
    schema: { operationId: "decideExecutionGrantRequest", tags: ["Execution Grant"], params: ExecutionGrantRequestPathSchema, body: DecideExecutionGrantRequestSchema, response: { 200: ExecutionGrantRequestSchema } },
  }, async (request) => {
    if (!request.principal) throw new PlatformApiError("AUTHENTICATION_REQUIRED", 401)
    return options.directory.decide({ tenantId: request.params.tenant_id, requestId: request.params.request_id, actor: { subjectId: request.principal.subject_id, tenantAdministrator: request.principal.role === "TENANT_ADMINISTRATOR" }, value: request.body })
  })
}
