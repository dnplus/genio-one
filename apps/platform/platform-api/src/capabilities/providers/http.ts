import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"

import {
  CreateProviderProfileSchema,
  ProviderProfileListSchema,
  ProviderProfilePathSchema,
  ProviderProfileSchema,
} from "./contract"
import type { ProviderProfileCatalog } from "./module"

export interface ProviderHttpOptions {
  catalog: ProviderProfileCatalog
}

export const providerHttp: FastifyPluginAsync<ProviderHttpOptions> = async (app, options) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()

  routes.get(
    "/v1/tenants/:tenant_id/providers/profiles",
    {
      schema: {
        operationId: "listProviderProfiles",
        summary: "List AI provider profiles",
        tags: ["Providers"],
        params: ProviderProfilePathSchema,
        response: { 200: ProviderProfileListSchema },
      },
    },
    async (request) => options.catalog.list({ tenantId: request.params.tenant_id }),
  )

  routes.post(
    "/v1/tenants/:tenant_id/providers/profiles",
    {
      schema: {
        operationId: "createProviderProfile",
        summary: "Create an AI provider profile without storing a secret",
        tags: ["Providers"],
        params: ProviderProfilePathSchema,
        body: CreateProviderProfileSchema,
        response: { 201: ProviderProfileSchema },
      },
    },
    async (request, reply) => {
      const profile = await options.catalog.create({
        tenantId: request.params.tenant_id,
        value: request.body,
      })
      return reply.code(201).send(profile)
    },
  )
}
