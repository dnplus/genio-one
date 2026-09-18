import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"

import {
  ResourceCreateSchema,
  ResourceIdPathSchema,
  ResourceLifecycleCommandSchema,
  OpenApiImportSchema,
  ResourceListSchema,
  ResourcePublicationEndpointInputSchema,
  ResourceRegistrationSchema,
  ResourceUpdateSchema,
  TenantPathSchema,
} from "./contract"
import type { ResourceCatalog, ResourceRegistry } from "./module"
import type { ResourceRegistration } from "./contract"
import type { Principal } from "../tenancy-auth/contract"
import { PlatformApiError } from "../errors"
import { resourceCreateFromOpenApi } from "./openapi"

function filterManagementResources(
  resources: ResourceRegistration[],
  principal: Principal,
) {
  if (principal.role === "TENANT_ADMINISTRATOR") return resources
  if (principal.role === "ORGANIZATION_ADMINISTRATOR") {
    const organizationIds = new Set(principal.organization_ids)
    return resources.filter(
      (resource) => organizationIds.has(resource.owner_organization_id),
    )
  }
  return []
}

export interface ResourceHttpOptions {
  catalog: ResourceCatalog
  registry: ResourceRegistry
}

export const resourceHttp: FastifyPluginAsync<ResourceHttpOptions> = async (
  app,
  options,
) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()

  routes.get(
    "/v1/tenants/:tenant_id/resources",
    {
      schema: {
        operationId: "listResources",
        summary: "List governed Resources",
        description:
          "Returns the Tenant Resource Catalog from the TypeScript Control Plane canonical store.",
        tags: ["Resources"],
        params: TenantPathSchema,
        response: {
          200: ResourceListSchema,
        },
      },
    },
    async (request, reply) => {
      const resources = await options.catalog.listResources({
        tenantId: request.params.tenant_id,
        authorization: request.headers.authorization,
      })
      if (!request.principal) throw new PlatformApiError("UNAUTHENTICATED", 401)
      return reply.code(200).send(
        filterManagementResources(resources, request.principal),
      )
    },
  )

  routes.post(
    "/v1/tenants/:tenant_id/resources",
    {
      schema: {
        operationId: "createResource",
        summary: "Create a draft Resource",
        tags: ["Resources"],
        params: TenantPathSchema,
        body: ResourceCreateSchema,
        response: { 201: ResourceRegistrationSchema },
      },
    },
    async (request, reply) => {
      const resource = await options.registry.createResource({
        tenantId: request.params.tenant_id,
        value: request.body,
      })
      return reply.code(201).send(resource)
    },
  )

  routes.post(
    "/v1/tenants/:tenant_id/resources/import-openapi",
    {
      schema: {
        operationId: "importOpenApiResource",
        summary: "Create a draft API Resource from an OpenAPI document",
        tags: ["Resources"],
        params: TenantPathSchema,
        body: OpenApiImportSchema,
        response: { 201: ResourceRegistrationSchema },
      },
    },
    async (request, reply) => {
      const resource = await options.registry.createResource({
        tenantId: request.params.tenant_id,
        value: resourceCreateFromOpenApi(request.body),
      })
      return reply.code(201).send(resource)
    },
  )

  routes.get(
    "/v1/tenants/:tenant_id/resources/:resource_id",
    {
      schema: {
        operationId: "getResource",
        summary: "Get a Resource",
        tags: ["Resources"],
        params: ResourceIdPathSchema,
        response: { 200: ResourceRegistrationSchema },
      },
    },
    async (request) =>
      request.routeResource ??
      options.catalog.getResource({
        tenantId: request.params.tenant_id,
        resourceId: request.params.resource_id,
        authorization: request.headers.authorization,
      }),
  )

  routes.patch(
    "/v1/tenants/:tenant_id/resources/:resource_id",
    {
      schema: {
        operationId: "updateResource",
        summary: "Update draft Resource content",
        tags: ["Resources"],
        params: ResourceIdPathSchema,
        body: ResourceUpdateSchema,
        response: { 200: ResourceRegistrationSchema },
      },
    },
    async (request) =>
      options.registry.updateResource({
        tenantId: request.params.tenant_id,
        resourceId: request.params.resource_id,
        value: request.body,
      }),
  )

  routes.post(
    "/v1/tenants/:tenant_id/resources/:resource_id/lifecycle",
    {
      schema: {
        operationId: "transitionResourceLifecycle",
        summary: "Move a Resource through its lifecycle",
        tags: ["Resources"],
        params: ResourceIdPathSchema,
        body: ResourceLifecycleCommandSchema,
        response: { 200: ResourceRegistrationSchema },
      },
    },
    async (request) =>
      options.registry.setLifecycle({
        tenantId: request.params.tenant_id,
        resourceId: request.params.resource_id,
        lifecycle: request.body.lifecycle,
      }),
  )

  routes.put(
    "/v1/tenants/:tenant_id/resources/:resource_id/publication-endpoint",
    {
      schema: {
        operationId: "setResourcePublicationEndpoint",
        summary: "Configure a draft Resource publication endpoint",
        description:
          "Stores the vhost, base path, visibility, and server-verified DNS state used by the publication workflow. It does not publish the Resource.",
        tags: ["Resources"],
        params: ResourceIdPathSchema,
        body: ResourcePublicationEndpointInputSchema,
        response: { 200: ResourceRegistrationSchema },
      },
    },
    async (request) =>
      options.registry.setPublicationEndpoint({
        tenantId: request.params.tenant_id,
        resourceId: request.params.resource_id,
        value: request.body,
      }),
  )

}
