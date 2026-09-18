import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"

import {
  ModelRoutingPolicyMutationSchema,
  ModelRoutingPolicyPathSchema,
  ModelRoutingPolicySchema,
  ModelRouteLeaseSchema,
  ModelRoutingPathSchema,
  ResolveModelRouteSchema,
} from "./contract"
import type { ModelRouter, ModelRoutingPolicyStore } from "./module"
import { PlatformApiError } from "../errors"
import type { ResourceRegistry } from "../resources/module"

export interface ModelRoutingHttpOptions {
  router: ModelRouter
  policies: ModelRoutingPolicyStore
  resources: ResourceRegistry
}

export const modelRoutingHttp: FastifyPluginAsync<ModelRoutingHttpOptions> = async (
  app,
  options,
) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()

  routes.get(
    "/v1/tenants/:tenant_id/resources/:resource_id/capabilities/:capability_id/model-routing-policy",
    {
      schema: {
        operationId: "getLatestModelRoutingPolicy",
        summary: "Get the latest model-routing policy revision",
        tags: ["Model Routing"],
        params: ModelRoutingPolicyPathSchema,
        response: { 200: ModelRoutingPolicySchema },
      },
    },
    async (request) => {
      const resource = await options.resources.getResource({
        tenantId: request.params.tenant_id,
        resourceId: request.params.resource_id,
      })
      if (!resource.capabilities.some(
        (capability) => capability.capability_id === request.params.capability_id,
      )) {
        throw new PlatformApiError("RESOURCE_CAPABILITY_NOT_FOUND", 404)
      }
      const policy = await options.policies.getLatest({
        tenantId: request.params.tenant_id,
        ownerOrganizationId: resource.owner_organization_id,
        resourceId: request.params.resource_id,
        capabilityId: request.params.capability_id,
      })
      if (!policy) throw new PlatformApiError("MODEL_ROUTING_POLICY_NOT_FOUND", 404)
      return policy
    },
  )

  routes.put(
    "/v1/tenants/:tenant_id/resources/:resource_id/capabilities/:capability_id/model-routing-policy",
    {
      schema: {
        operationId: "saveModelRoutingPolicyRevision",
        summary: "Save an immutable model-routing policy revision",
        tags: ["Model Routing"],
        params: ModelRoutingPolicyPathSchema,
        body: ModelRoutingPolicyMutationSchema,
        response: { 200: ModelRoutingPolicySchema },
      },
    },
    async (request) => {
      const resource = await options.resources.getResource({
        tenantId: request.params.tenant_id,
        resourceId: request.params.resource_id,
      })
      if (!resource.capabilities.some(
        (capability) => capability.capability_id === request.params.capability_id,
      )) {
        throw new PlatformApiError("RESOURCE_CAPABILITY_NOT_FOUND", 404)
      }
      return options.policies.save({
        tenantId: request.params.tenant_id,
        value: {
          owner_organization_id: resource.owner_organization_id,
          resource_id: resource.resource_id,
          capability_id: request.params.capability_id,
          ...request.body,
        },
      })
    },
  )

  routes.post(
    "/v1/tenants/:tenant_id/model-routing/resolve",
    {
      schema: {
        operationId: "resolveModelRoute",
        summary: "Resolve a deterministic or session-scoped model route",
        tags: ["Model Routing"],
        params: ModelRoutingPathSchema,
        body: ResolveModelRouteSchema,
        response: { 200: ModelRouteLeaseSchema },
      },
    },
    async (request) =>
      options.router.resolve({
        tenantId: request.params.tenant_id,
        value: request.body,
      }),
  )
}
