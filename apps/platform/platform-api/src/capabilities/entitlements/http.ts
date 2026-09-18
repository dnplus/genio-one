import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"

import {
  EntitlementTenantPathSchema,
  GrantModelEntitlementSchema,
  ModelEntitlementListSchema,
  ModelEntitlementSchema,
} from "./contract"
import type { ModelEntitlementCatalog } from "./module"

export const modelEntitlementHttp: FastifyPluginAsync<{
  catalog: ModelEntitlementCatalog
}> = async (app, options) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()
  routes.get(
    "/v1/tenants/:tenant_id/entitlements",
    {
      schema: {
        operationId: "listModelEntitlements",
        tags: ["Entitlements"],
        params: EntitlementTenantPathSchema,
        response: { 200: ModelEntitlementListSchema },
      },
    },
    async (request) => options.catalog.list({ tenantId: request.params.tenant_id }),
  )
  routes.post(
    "/v1/tenants/:tenant_id/entitlements",
    {
      schema: {
        operationId: "grantModelEntitlement",
        tags: ["Entitlements"],
        params: EntitlementTenantPathSchema,
        body: GrantModelEntitlementSchema,
        response: { 201: ModelEntitlementSchema },
      },
    },
    async (request, reply) => reply.code(201).send(await options.catalog.grant({
      tenantId: request.params.tenant_id,
      value: request.body,
      idempotencyKey: typeof request.headers["idempotency-key"] === "string"
        ? request.headers["idempotency-key"]
        : undefined,
    })),
  )
}
