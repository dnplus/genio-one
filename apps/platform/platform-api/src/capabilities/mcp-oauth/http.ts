import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"
import type { FastifyPluginAsync, FastifyRequest } from "fastify"
import { Type } from "typebox"

import {
  McpOAuthAuthorizationSchema,
  McpOAuthBindingSchema,
  McpOAuthCallbackQuerySchema,
  McpOAuthConnectionPathSchema,
} from "./contract"
import type { PersonalCredentials } from "../personal-credentials/module"
import type { McpOAuthService } from "./module"
import type { RuntimeControlStore } from "../runtime-control/contract"
import { isPlatformApiError, PlatformApiError } from "../errors"

const Identifier = Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000\\r\\n]+$" })

const RuntimePathSchema = Type.Object({
  tenant_id: Identifier,
  runtime_id: Identifier,
}, { additionalProperties: false })

const RuntimeHeadersQuerySchema = Type.Object({
  resource_id: Identifier,
  subject_id: Identifier,
  mcp_method: Type.Optional(Identifier),
}, { additionalProperties: false })

const RuntimeHeadersSchema = Type.Object({
  headers: Type.Array(Type.Object({
    name: Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z0-9-]+$" }),
    value: Type.String({ minLength: 1, maxLength: 16384, pattern: "^[^\\u0000\\r\\n]+$" }),
  }, { additionalProperties: false }), { maxItems: 1024 }),
}, { additionalProperties: false })

export type McpOAuthRuntimeAuthorizer = (input: {
  tenantId: string
  runtimeId: string
  request: FastifyRequest
}) => boolean | void | Promise<boolean | void>

export interface McpOAuthHttpOptions {
  service: McpOAuthService
  passwords: PersonalCredentials
  registrations: RuntimeControlStore
  authorizeRuntime: McpOAuthRuntimeAuthorizer
}

async function authorizeRuntime(
  options: McpOAuthHttpOptions,
  tenantId: string,
  runtimeId: string,
  request: FastifyRequest,
): Promise<void> {
  try {
    if (await options.authorizeRuntime({ tenantId, runtimeId, request }) === false) {
      throw new PlatformApiError("RUNTIME_ACCESS_DENIED", 403)
    }
  } catch (error) {
    if (isPlatformApiError(error)) throw error
    throw new PlatformApiError("RUNTIME_ACCESS_DENIED", 403)
  }
  const registration = await options.registrations.getGatewayRuntime({
    tenantId,
    runtimeKind: "GATEWAY",
    runtimeId,
  })
  if (!registration) throw new PlatformApiError("RUNTIME_RUNTIME_NOT_REGISTERED", 404)
  if (registration.status !== "ACTIVE") throw new PlatformApiError("RUNTIME_RUNTIME_NOT_ACTIVE", 403)
}

export const mcpOAuthHttp: FastifyPluginAsync<McpOAuthHttpOptions> = async (
  app,
  options,
) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()

  routes.post(
    "/v1/tenants/:tenant_id/resources/:resource_id/connections/:connection_id/mcp-oauth/authorize",
    {
      schema: {
        operationId: "startMcpOAuthAuthorization",
        summary: "Start OAuth authorization for the authenticated subject and MCP Connection",
        tags: ["Connections"],
        params: McpOAuthConnectionPathSchema,
        response: { 200: McpOAuthAuthorizationSchema },
      },
    },
    async (request) => options.service.start({
      tenantId: request.params.tenant_id,
      resourceId: request.params.resource_id,
      connectionId: request.params.connection_id,
      subjectId: request.principal!.subject_id,
    }),
  )

  routes.get(
    "/v1/tenants/:tenant_id/resources/:resource_id/connections/:connection_id/mcp-oauth",
    {
      schema: {
        operationId: "getMcpOAuthBinding",
        summary: "Get the authenticated subject's OAuth binding for an MCP Connection",
        tags: ["Connections"],
        params: McpOAuthConnectionPathSchema,
        response: { 200: Type.Union([McpOAuthBindingSchema, Type.Null()]) },
      },
    },
    async (request) => options.service.status({
      tenantId: request.params.tenant_id,
      resourceId: request.params.resource_id,
      connectionId: request.params.connection_id,
      subjectId: request.principal!.subject_id,
    }),
  )

  routes.delete(
    "/v1/tenants/:tenant_id/resources/:resource_id/connections/:connection_id/mcp-oauth",
    {
      schema: {
        operationId: "disconnectMcpOAuthBinding",
        summary: "Disconnect the authenticated subject's OAuth binding from an MCP Connection",
        tags: ["Connections"],
        params: McpOAuthConnectionPathSchema,
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      await options.service.disconnect({
        tenantId: request.params.tenant_id,
        connectionId: request.params.connection_id,
        subjectId: request.principal!.subject_id,
      })
      return reply.code(204).send(null)
    },
  )

  routes.get(
    "/v1/tenants/:tenant_id/runtime-control/GATEWAY/:runtime_id/mcp-oauth/headers",
    {
      schema: {
        operationId: "resolveMcpOAuthRequestHeaders",
        summary: "Resolve subject-scoped OAuth request headers for a Gateway Runtime",
        tags: ["Runtime Control"],
        params: RuntimePathSchema,
        querystring: RuntimeHeadersQuerySchema,
        response: { 200: RuntimeHeadersSchema },
      },
    },
    async (request, reply) => {
      await authorizeRuntime(
        options,
        request.params.tenant_id,
        request.params.runtime_id,
        request,
      )
      const credentialsOptional = ["initialize", "notifications/initialized", "tools/list", "ping"].includes(request.query.mcp_method ?? "")
      const headers = await options.service.resolveRequestHeaders({
        credentialsOptional,
        tenantId: request.params.tenant_id,
        resourceId: request.query.resource_id,
        subjectId: request.query.subject_id,
      })
      const passwordHeaders = await options.passwords.resolveRequestHeaders({ credentialsOptional, tenantId: request.params.tenant_id, resourceId: request.query.resource_id, subjectId: request.query.subject_id })
      return reply.header("cache-control", "no-store").send({ headers: [...headers, ...passwordHeaders] })
    },
  )

  routes.get(
    "/v1/mcp-oauth/callback",
    {
      schema: {
        operationId: "completeMcpOAuthAuthorization",
        summary: "Complete an MCP OAuth authorization code flow",
        tags: ["Connections"],
        querystring: McpOAuthCallbackQuerySchema,
      },
    },
    async (request, reply) => {
      const target = await options.service.complete({
        state: request.query.state,
        code: request.query.code,
        iss: request.query.iss,
        error: request.query.error,
      })
      return reply.redirect(target, 303)
    },
  )
}
