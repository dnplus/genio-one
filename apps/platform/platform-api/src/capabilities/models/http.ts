import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"
import { Type } from "typebox"

import {
  CreatePublicModelSchema,
  AddConnectionModelMappingSchema,
  ConnectionModelMappingSchema,
  ConnectionModelMappingListSchema,
  ModelPathSchema,
  PublicModelListSchema,
  PublicModelSchema,
  ResourceModelsPathSchema,
  ResourceModelPathSchema,
} from "./contract"
import type { PublicModelCatalog } from "./module"
import { PlatformApiError } from "../errors"
import type { EntitlementResolver } from "../tenancy-auth/contract"

export interface ModelHttpOptions {
  catalog: PublicModelCatalog
  entitlementResolver: EntitlementResolver
}

export const modelHttp: FastifyPluginAsync<ModelHttpOptions> = async (app, options) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()

  routes.get(
    "/v1/tenants/:tenant_id/models",
    {
      schema: {
        operationId: "listPublicModels",
        summary: "List public AI models",
        tags: ["Models"],
        params: ModelPathSchema,
        querystring: Type.Object({
          visibility: Type.Optional(Type.Union([Type.Literal("PUBLIC"), Type.Literal("PRIVATE")])),
          resource_id: Type.Optional(Type.String({ minLength: 1 })),
        }),
        response: { 200: PublicModelListSchema },
      },
    },
    async (request) => {
      if (
        request.query.visibility === "PRIVATE" &&
        request.principal?.role !== "TENANT_ADMINISTRATOR"
      ) {
        throw new PlatformApiError(
          "PRIVATE_MODEL_CATALOG_ADMIN_REQUIRED",
          403,
          "Private models are available only through an authorized management view",
        )
      }
      return options.catalog.list({
        tenantId: request.params.tenant_id,
        visibility: request.query.visibility ?? "PUBLIC",
        resourceId: request.query.resource_id,
        includeUnpublishedResources:
          request.query.resource_id !== undefined &&
          request.principal?.role === "TENANT_ADMINISTRATOR",
      })
    },
  )

  routes.get(
    "/v1/tenants/:tenant_id/me/models",
    {
      schema: {
        operationId: "listMyPublicModels",
        summary: "List public AI models available to the authenticated principal",
        tags: ["Models"],
        params: ModelPathSchema,
        response: { 200: PublicModelListSchema },
      },
    },
    async (request) => {
      const principal = request.principal
      if (!principal) throw new PlatformApiError("UNAUTHENTICATED", 401)
      let entitledModelIds: readonly string[]
      try {
        entitledModelIds = await options.entitlementResolver.resolve({
          tenantId: request.params.tenant_id,
          subjectId: principal.subject_id,
          clientId: principal.client_id,
        })
      } catch {
        throw new PlatformApiError(
          "ENTITLEMENT_RESOLUTION_FAILED",
          503,
          "The effective model entitlement could not be resolved",
        )
      }
      if (!Array.isArray(entitledModelIds)) {
        throw new PlatformApiError(
          "ENTITLEMENT_RESOLUTION_FAILED",
          503,
          "The effective model entitlement could not be resolved",
        )
      }
      const entitled = new Set(
        entitledModelIds.filter(
          (modelId): modelId is string =>
            typeof modelId === "string" && modelId.length > 0,
        ),
      )
      if (entitled.size === 0) return []
      const models = await options.catalog.list({
        tenantId: request.params.tenant_id,
        visibility: "PUBLIC",
      })
      return models.filter(
        (model) =>
          model.visibility === "PUBLIC" &&
          model.lifecycle === "PUBLISHED" &&
          entitled.has(model.model_id),
      )
    },
  )

  routes.post(
    "/v1/tenants/:tenant_id/resources/:resource_id/models/:model_id/mappings",
    {
      schema: {
        operationId: "addConnectionModelMapping",
        summary: "Stage a Connection mapping for an existing Public Model",
        tags: ["Models"],
        params: ResourceModelPathSchema,
        body: AddConnectionModelMappingSchema,
        response: { 201: ConnectionModelMappingSchema },
      },
    },
    async (request, reply) => {
      const mapping = await options.catalog.addMapping({
        tenantId: request.params.tenant_id,
        resourceId: request.params.resource_id,
        modelId: request.params.model_id,
        value: request.body,
      })
      return reply.code(201).send(mapping)
    },
  )

  routes.post(
    "/v1/tenants/:tenant_id/resources/:resource_id/models",
    {
      schema: {
        operationId: "createPublicModel",
        summary: "Register a public model for an AI Resource",
        tags: ["Models"],
        params: ResourceModelsPathSchema,
        body: CreatePublicModelSchema,
        response: { 201: PublicModelSchema },
      },
    },
    async (request, reply) => {
      const model = await options.catalog.create({
        tenantId: request.params.tenant_id,
        resourceId: request.params.resource_id,
        value: request.body,
      })
      return reply.code(201).send(model)
    },
  )

  routes.get(
    "/v1/tenants/:tenant_id/resources/:resource_id/model-mappings",
    {
      schema: {
        operationId: "listConnectionModelMappings",
        summary: "List provider model mappings for a Resource",
        tags: ["Models"],
        params: ResourceModelsPathSchema,
        querystring: Type.Object({
          public_model_id: Type.Optional(Type.String({ minLength: 1 })),
        }),
        response: { 200: ConnectionModelMappingListSchema },
      },
    },
    async (request) =>
      options.catalog.listMappings({
        tenantId: request.params.tenant_id,
        resourceId: request.params.resource_id,
        publicModelId: request.query.public_model_id,
      }),
  )
}
