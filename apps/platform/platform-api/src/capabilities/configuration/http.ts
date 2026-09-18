import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"
import { Type } from "typebox"

import {
  ConfigurationRevisionPathSchema,
  ConfigurationTenantPathSchema,
  CreateConfigurationRevisionSchema,
  ObserveConfigurationProjectionSchema,
  RollbackConfigurationRevisionSchema,
  TenantConfigurationRevisionListSchema,
  TenantConfigurationRevisionSchema,
  TransitionConfigurationRevisionSchema,
} from "./contract"
import type { ConfigurationTransition, TenantConfigurationStore } from "./module"

export const configurationHttp: FastifyPluginAsync<{
  store: TenantConfigurationStore
}> = async (app, options) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()
  routes.get("/v1/tenants/:tenant_id/configuration-revisions", {
    schema: {
      operationId: "listTenantConfigurationRevisions",
      tags: ["Configuration"],
      params: ConfigurationTenantPathSchema,
      response: { 200: TenantConfigurationRevisionListSchema },
    },
  }, async (request) => options.store.list({ tenantId: request.params.tenant_id }))
  routes.get("/v1/tenants/:tenant_id/self-service-configuration", {
    schema: {
      operationId: "getPublishedTenantConfiguration",
      tags: ["Configuration"],
      params: ConfigurationTenantPathSchema,
      response: { 200: Type.Union([TenantConfigurationRevisionSchema, Type.Null()]) },
    },
  }, async (request) => options.store.published({ tenantId: request.params.tenant_id }))
  routes.post("/v1/tenants/:tenant_id/configuration-revisions", {
    schema: {
      operationId: "createTenantConfigurationRevision",
      tags: ["Configuration"],
      params: ConfigurationTenantPathSchema,
      body: CreateConfigurationRevisionSchema,
      response: { 201: TenantConfigurationRevisionSchema },
    },
  }, async (request, reply) => reply.code(201).send(await options.store.create({
    tenantId: request.params.tenant_id,
    createdBySubjectId: request.principal!.subject_id,
    value: request.body,
  })))

  const transition = async (
    request: {
      params: { tenant_id: string; revision: string }
      body: { correlation_id: string; projection_failure_reason?: string }
    },
    value: ConfigurationTransition,
  ) => {
    const transitioned = await options.store.transition({
      tenantId: request.params.tenant_id,
      revision: request.params.revision,
      transition: value,
      value: request.body,
    })
    if (value !== "publish" || !options.store.project || request.body.projection_failure_reason) {
      return transitioned
    }
    return options.store.project({
      tenantId: request.params.tenant_id,
      revision: request.params.revision,
    })
  }
  routes.post("/v1/tenants/:tenant_id/configuration-revisions/:revision/validate", {
    schema: { tags: ["Configuration"], params: ConfigurationRevisionPathSchema, body: TransitionConfigurationRevisionSchema, response: { 200: TenantConfigurationRevisionSchema } },
  }, async (request) => transition(request, "validate"))
  routes.post("/v1/tenants/:tenant_id/configuration-revisions/:revision/preview", {
    schema: { tags: ["Configuration"], params: ConfigurationRevisionPathSchema, body: TransitionConfigurationRevisionSchema, response: { 200: TenantConfigurationRevisionSchema } },
  }, async (request) => transition(request, "preview"))
  routes.post("/v1/tenants/:tenant_id/configuration-revisions/:revision/review", {
    schema: { tags: ["Configuration"], params: ConfigurationRevisionPathSchema, body: TransitionConfigurationRevisionSchema, response: { 200: TenantConfigurationRevisionSchema } },
  }, async (request) => transition(request, "review"))
  routes.post("/v1/tenants/:tenant_id/configuration-revisions/:revision/publish", {
    schema: { tags: ["Configuration"], params: ConfigurationRevisionPathSchema, body: TransitionConfigurationRevisionSchema, response: { 200: TenantConfigurationRevisionSchema } },
  }, async (request) => transition(request, "publish"))
  routes.post("/v1/tenants/:tenant_id/configuration-revisions/:revision/retry", {
    schema: { tags: ["Configuration"], params: ConfigurationRevisionPathSchema, body: TransitionConfigurationRevisionSchema, response: { 200: TenantConfigurationRevisionSchema } },
  }, async (request) => {
    const retried = await options.store.retry({
      tenantId: request.params.tenant_id,
      revision: request.params.revision,
    })
    return options.store.project
      ? options.store.project({
          tenantId: request.params.tenant_id,
          revision: request.params.revision,
        })
      : retried
  })
  routes.post("/v1/tenants/:tenant_id/configuration-revisions/:revision/projection-observation", {
    schema: { tags: ["Configuration"], params: ConfigurationRevisionPathSchema, body: ObserveConfigurationProjectionSchema, response: { 200: TenantConfigurationRevisionSchema } },
  }, async (request) => options.store.observe({
    tenantId: request.params.tenant_id,
    revision: request.params.revision,
    value: request.body,
  }))
  routes.post("/v1/tenants/:tenant_id/configuration-revisions/rollback", {
    schema: { tags: ["Configuration"], params: ConfigurationTenantPathSchema, body: RollbackConfigurationRevisionSchema, response: { 200: TenantConfigurationRevisionSchema } },
  }, async (request) => options.store.rollback({
    tenantId: request.params.tenant_id,
    createdBySubjectId: request.principal!.subject_id,
    value: request.body,
  }))
}
