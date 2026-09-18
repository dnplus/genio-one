import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"

import {
  CreateIdentityProviderSchema,
  IdentityProviderAliasPathSchema,
  IdentityProviderListSchema,
  IdentityProviderPathSchema,
  IdentityProviderSchema,
  UpdateIdentityProviderSchema,
} from "./contract"
import type { IdentityProviderRegistry } from "./module"

export const identityProviderHttp: FastifyPluginAsync<{
  registry: IdentityProviderRegistry
}> = async (app, options) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()

  routes.get("/v1/tenants/:tenant_id/identity-providers", {
    schema: {
      operationId: "listIdentityProviders",
      tags: ["Identity"],
      params: IdentityProviderPathSchema,
      response: { 200: IdentityProviderListSchema },
    },
  }, async (request) => options.registry.list({ tenantId: request.params.tenant_id }))

  routes.post("/v1/tenants/:tenant_id/identity-providers", {
    schema: {
      operationId: "createIdentityProvider",
      tags: ["Identity"],
      params: IdentityProviderPathSchema,
      body: CreateIdentityProviderSchema,
      response: { 201: IdentityProviderSchema },
    },
  }, async (request, reply) => reply.code(201).send(await options.registry.create({
    tenantId: request.params.tenant_id,
    value: request.body,
  })))

  routes.patch("/v1/tenants/:tenant_id/identity-providers/:alias", {
    schema: {
      operationId: "updateIdentityProvider",
      tags: ["Identity"],
      params: IdentityProviderAliasPathSchema,
      body: UpdateIdentityProviderSchema,
      response: { 200: IdentityProviderSchema },
    },
  }, async (request) => options.registry.update({
    tenantId: request.params.tenant_id,
    alias: request.params.alias,
    value: request.body,
  }))

  routes.delete("/v1/tenants/:tenant_id/identity-providers/:alias", {
    schema: {
      operationId: "deleteIdentityProvider",
      tags: ["Identity"],
      params: IdentityProviderAliasPathSchema,
      response: { 204: { type: "null" } },
    },
  }, async (request, reply) => {
    await options.registry.remove({
      tenantId: request.params.tenant_id,
      alias: request.params.alias,
    })
    return reply.code(204).send(null)
  })
}
