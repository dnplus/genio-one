import { Type } from "typebox"
import { PlatformApiError } from "../errors"
import type { FastifyPluginAsync } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"

import {
  EndpointBootstrapSchema,
  EndpointBootstrapRequestSchema,
  EndpointCredentialSchema,
  RegisteredEndpointSchema,
  RevokeEndpointSchema,
  EndpointLifecycleEventSchema,
  EndpointDevicePathSchema,
  EndpointEnrollmentPathSchema,
  EndpointEnrollmentSchema,
  EndpointEnforcementSchema,
  EndpointHeartbeatOutcomeSchema,
  EndpointHeartbeatSchema,
  EndpointRouteResolutionSchema,
  EnrollEndpointSchema,
} from "./contract"
import type { EndpointRuntimeStore } from "./module"

export interface EndpointRuntimeHttpOptions {
  store: EndpointRuntimeStore
  authorizeEndpoint(input: {
    tenantId: string
    deviceId: string
    request: { principal?: import("../tenancy-auth/contract").Principal }
  }): Promise<{ subjectId: string; credentialId: string }>
}

export const endpointRuntimeHttp: FastifyPluginAsync<EndpointRuntimeHttpOptions> = async (app, options) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()
  function administrator(request: { principal?: import("../tenancy-auth/contract").Principal }, tenantId: string) {
    if (!request.principal) throw new PlatformApiError("AUTHENTICATION_REQUIRED", 401)
    if (request.principal.tenant_id !== tenantId || request.principal.role !== "TENANT_ADMINISTRATOR") {
      throw new PlatformApiError("TENANT_ADMINISTRATOR_REQUIRED", 403)
    }
    return request.principal
  }
  routes.post("/v1/tenants/:tenant_id/endpoints/bootstrap", {
    schema: { operationId: "bootstrapEndpointDevice", tags: ["Endpoint Runtime"], params: EndpointEnrollmentPathSchema,
      body: EndpointBootstrapRequestSchema, response: { 201: EndpointBootstrapSchema } },
  }, async (request, reply) => {
    if (!request.principal || request.principal.tenant_id !== request.params.tenant_id) throw new PlatformApiError("UNAUTHENTICATED", 401)
    const bootstrap = await options.store.bootstrap({ tenantId: request.params.tenant_id, subjectId: request.principal.subject_id,
      correlationId: request.body.correlation_id })
    reply.header("cache-control", "no-store")
    return reply.code(201).send(bootstrap)
  })
  routes.post("/v1/tenants/:tenant_id/endpoints/:device_id/rotate-credential", {
    schema: { operationId: "rotateEndpointCredential", tags: ["Endpoint Runtime"], params: EndpointDevicePathSchema,
      response: { 200: EndpointCredentialSchema } },
  }, async (request, reply) => {
    const identity = await options.authorizeEndpoint({ tenantId: request.params.tenant_id, deviceId: request.params.device_id, request })
    reply.header("cache-control", "no-store")
    return options.store.rotateCredential({ tenantId: request.params.tenant_id, deviceId: request.params.device_id, credentialId: identity.credentialId })
  })
  routes.get("/v1/tenants/:tenant_id/endpoints", {
    schema: { operationId: "listEndpointDevices", tags: ["Endpoint Runtime"],
      params: EndpointEnrollmentPathSchema, response: { 200: Type.Array(RegisteredEndpointSchema) } },
  }, async (request) => {
    administrator(request, request.params.tenant_id)
    return options.store.list({ tenantId: request.params.tenant_id })
  })
  routes.get("/v1/tenants/:tenant_id/endpoints/:device_id", {
    schema: { operationId: "getEndpointDevice", tags: ["Endpoint Runtime"],
      params: EndpointDevicePathSchema, response: { 200: RegisteredEndpointSchema } },
  }, async (request) => {
    administrator(request, request.params.tenant_id)
    return options.store.get({ tenantId: request.params.tenant_id, deviceId: request.params.device_id })
  })
  routes.get("/v1/tenants/:tenant_id/endpoints/:device_id/lifecycle-events", {
    schema: { operationId: "listEndpointLifecycleEvents", tags: ["Endpoint Runtime"],
      params: EndpointDevicePathSchema, response: { 200: Type.Array(EndpointLifecycleEventSchema) } },
  }, async (request) => {
    administrator(request, request.params.tenant_id)
    return options.store.lifecycleEvents({ tenantId: request.params.tenant_id, deviceId: request.params.device_id })
  })
  routes.post("/v1/tenants/:tenant_id/endpoints/:device_id/revoke", {
    schema: { operationId: "revokeEndpointDevice", tags: ["Endpoint Runtime"],
      params: EndpointDevicePathSchema, body: RevokeEndpointSchema, response: { 200: RegisteredEndpointSchema } },
  }, async (request) => {
    const principal = administrator(request, request.params.tenant_id)
    return options.store.revoke({ tenantId: request.params.tenant_id, deviceId: request.params.device_id,
      subjectId: principal.subject_id, correlationId: request.body.correlation_id, reason: request.body.reason })
  })
  routes.post(
    "/v1/tenants/:tenant_id/endpoints/enroll",
    {
      schema: {
        operationId: "enrollEndpointRuntime",
        tags: ["Endpoint Runtime"],
        params: EndpointEnrollmentPathSchema,
        body: EnrollEndpointSchema,
        response: { 200: EndpointEnrollmentSchema },
      },
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store")
      const identity = await options.authorizeEndpoint({
        tenantId: request.params.tenant_id,
        deviceId: request.body.device_id,
        request,
      })
      return options.store.enroll({
        credentialId: identity.credentialId,
        tenantId: request.params.tenant_id,
        subjectId: identity.subjectId,
        value: request.body,
      })
    },
  )
  routes.post(
    "/v1/tenants/:tenant_id/endpoints/:device_id/heartbeat",
    {
      schema: {
        operationId: "heartbeatEndpointRuntime",
        tags: ["Endpoint Runtime"],
        params: EndpointDevicePathSchema,
        body: EndpointHeartbeatSchema,
        response: { 200: EndpointHeartbeatOutcomeSchema },
      },
    },
    async (request) => {
      const identity = await options.authorizeEndpoint({
        tenantId: request.params.tenant_id,
        deviceId: request.params.device_id,
        request,
      })
      return options.store.heartbeat({
        tenantId: request.params.tenant_id,
        deviceId: request.params.device_id,
        subjectId: identity.subjectId,
        value: request.body,
      })
    },
  )
  routes.post(
    "/v1/tenants/:tenant_id/endpoints/:device_id/enforcements",
    {
      schema: {
        operationId: "recordEndpointEnforcement",
        tags: ["Endpoint Runtime"],
        params: EndpointDevicePathSchema,
        body: EndpointEnforcementSchema,
        response: { 200: EndpointRouteResolutionSchema },
      },
    },
    async (request) => {
      const identity = await options.authorizeEndpoint({
        tenantId: request.params.tenant_id,
        deviceId: request.params.device_id,
        request,
      })
      return options.store.enforce({
        tenantId: request.params.tenant_id,
        deviceId: request.params.device_id,
        subjectId: identity.subjectId,
        value: request.body,
      })
    },
  )
}
