import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"

import {
  EndpointActivityEventSchema,
  EndpointActivityIngestSchema,
  EndpointActivityInventorySchema,
  EndpointActivityListPathSchema,
  EndpointActivityListQuerySchema,
  EndpointActivityPathSchema,
} from "./contract"
import type { EndpointActivityStore } from "./module"
import type { EndpointRuntimeStore } from "../endpoint-runtime/module"
import { PlatformApiError } from "../errors"

export interface EndpointActivityHttpOptions {
  store: EndpointActivityStore
  runtime: EndpointRuntimeStore
  authorizeEndpoint(input: {
    tenantId: string
    deviceId: string
    request: { principal?: import("../tenancy-auth/contract").Principal }
  }): Promise<{ subjectId: string }>
}

export const endpointActivityHttp: FastifyPluginAsync<EndpointActivityHttpOptions> = async (app, options) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()
  routes.post(
    "/v1/tenants/:tenant_id/endpoints/:device_id/ai-activities",
    {
      schema: {
        operationId: "recordEndpointActivity",
        tags: ["Endpoint Activity"],
        params: EndpointActivityPathSchema,
        body: EndpointActivityIngestSchema,
        response: { 201: EndpointActivityEventSchema },
      },
    },
    async (request, reply) => {
      const identity = await options.authorizeEndpoint({
        tenantId: request.params.tenant_id,
        deviceId: request.params.device_id,
        request,
      })
      if (
        request.body.evidence_level !== "VERIFIED" ||
        request.body.subject.evidence_level !== "VERIFIED" ||
        request.body.subject.subject_id !== identity.subjectId
      ) {
        throw new PlatformApiError("ENDPOINT_SUBJECT_EVIDENCE_INVALID", 403)
      }
      await options.runtime.assertApplied({
        tenantId: request.params.tenant_id,
        deviceId: request.params.device_id,
        subjectId: identity.subjectId,
        appliedStateRevision: request.body.applied_state_revision,
        appliedPolicyVersion: request.body.applied_policy_version,
      })
      const event = await options.store.record({
        tenantId: request.params.tenant_id,
        deviceId: request.params.device_id,
        subjectId: identity.subjectId,
        event: request.body,
      })
      return reply.code(201).send(event)
    },
  )

  routes.get(
    "/v1/tenants/:tenant_id/ai-activities",
    {
      schema: {
        operationId: "listEndpointActivities",
        tags: ["Endpoint Activity"],
        params: EndpointActivityListPathSchema,
        querystring: EndpointActivityListQuerySchema,
        response: { 200: EndpointActivityInventorySchema },
      },
    },
    async (request) => options.store.inventory({
      tenantId: request.params.tenant_id,
      ...(request.query.device_id ? { deviceId: request.query.device_id } : {}),
      recentLimit: request.query.recent_limit ?? 50,
    }),
  )
}
