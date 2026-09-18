import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"

import { DemoProjectPathSchema, DemoProjectResponseSchema, InstallDemoProjectSchema } from "./contract"
import type { DemoProjectService } from "./service"

export interface DemoProjectHttpOptions {
  service: DemoProjectService
}

export const demoProjectHttp: FastifyPluginAsync<DemoProjectHttpOptions> = async (app, options) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()
  routes.get("/v1/tenants/:tenant_id/demo-project", {
    schema: {
      operationId: "getDemoProject",
      tags: ["Demo Project"],
      params: DemoProjectPathSchema,
      response: { 200: DemoProjectResponseSchema },
    },
  }, async (request) => options.service.get({ tenantId: request.params.tenant_id }))
  routes.post("/v1/tenants/:tenant_id/demo-project/install", {
    schema: {
      operationId: "installDemoProject",
      tags: ["Demo Project"],
      params: DemoProjectPathSchema,
      body: InstallDemoProjectSchema,
      response: { 200: DemoProjectResponseSchema },
    },
  }, async (request) => {
    if (!request.principal) throw new Error("UNAUTHENTICATED")
    return options.service.install({
      tenantId: request.params.tenant_id,
      value: request.body,
      actorSubjectId: request.principal.subject_id,
    })
  })
  routes.post("/v1/tenants/:tenant_id/demo-project/skip", {
    schema: {
      operationId: "skipDemoProject",
      tags: ["Demo Project"],
      params: DemoProjectPathSchema,
      response: { 200: DemoProjectResponseSchema },
    },
  }, async (request) => options.service.skip({ tenantId: request.params.tenant_id }))
}
