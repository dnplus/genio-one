import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"
import { Type } from "typebox"

import { PlatformApiError } from "../errors"
import {
  PostHogBrowserConfigurationSchema,
  PostHogIntegrationSchema,
  PostHogTenantPathSchema,
  UpdatePostHogIntegrationSchema,
} from "./contract"
import type { PostHogIntegrationStore } from "./module"

function requireTenantAdministrator(request: {
  principal?: { role: string }
}): void {
  if (!request.principal) {
    throw new PlatformApiError("UNAUTHENTICATED", 401)
  }
  if (request.principal.role !== "TENANT_ADMINISTRATOR") {
    throw new PlatformApiError("TENANT_ADMINISTRATOR_REQUIRED", 403)
  }
}

export const postHogIntegrationHttp: FastifyPluginAsync<{
  store: PostHogIntegrationStore
}> = async (app, options) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()
  routes.get("/v1/tenants/:tenant_id/telemetry/posthog", {
    schema: {
      operationId: "getPostHogIntegration",
      tags: ["Telemetry"],
      params: PostHogTenantPathSchema,
      response: { 200: PostHogIntegrationSchema },
    },
  }, async (request) => {
    requireTenantAdministrator(request)
    return options.store.get({ tenantId: request.params.tenant_id })
  })
  routes.put("/v1/tenants/:tenant_id/telemetry/posthog", {
    schema: {
      operationId: "updatePostHogIntegration",
      tags: ["Telemetry"],
      params: PostHogTenantPathSchema,
      body: UpdatePostHogIntegrationSchema,
      response: { 200: PostHogIntegrationSchema },
    },
  }, async (request) => {
    requireTenantAdministrator(request)
    return options.store.update({
      tenantId: request.params.tenant_id,
      configuredBySubjectId: request.principal!.subject_id,
      value: request.body,
    })
  })
  routes.get("/v1/tenants/:tenant_id/telemetry/posthog/browser-configuration", {
    schema: {
      operationId: "getPostHogBrowserConfiguration",
      tags: ["Telemetry"],
      params: PostHogTenantPathSchema,
      response: { 200: Type.Union([PostHogBrowserConfigurationSchema, Type.Null()]) },
    },
  }, async (request, reply) => {
    if (!request.principal) throw new PlatformApiError("UNAUTHENTICATED", 401)
    return reply.header("cache-control", "no-store").send(
      await options.store.browserConfiguration({ tenantId: request.params.tenant_id }),
    )
  })
}
