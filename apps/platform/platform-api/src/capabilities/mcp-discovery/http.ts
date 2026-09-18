import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"
import type { FastifyPluginAsync, FastifyRequest } from "fastify"
import { Type } from "typebox"

import { PlatformApiError, isPlatformApiError } from "../errors"
import type { RuntimeControlStore } from "../runtime-control/contract"
import type { McpOAuthService } from "../mcp-oauth/module"
import {
  CompleteMcpDiscoverySchema,
  DecideMcpDiscoveryCandidateSchema,
  McpDiscoveryCredentialSchema,
  McpDiscoveryOperationSchema,
  RequestMcpDiscoverySchema,
} from "./contract"
import type { McpDiscoveryStore } from "./module"

const Identifier = Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000\\r\\n]+$" })

const ConnectionPathSchema = Type.Object({
  tenant_id: Identifier,
  resource_id: Identifier,
  connection_id: Identifier,
}, { additionalProperties: false })

const CandidatePathSchema = Type.Object({
  tenant_id: Identifier,
  resource_id: Identifier,
  connection_id: Identifier,
  candidate_id: Identifier,
}, { additionalProperties: false })

const RuntimePathSchema = Type.Object({
  tenant_id: Identifier,
  runtime_id: Identifier,
}, { additionalProperties: false })

const RuntimeOperationPathSchema = Type.Object({
  tenant_id: Identifier,
  runtime_id: Identifier,
  operation_id: Identifier,
}, { additionalProperties: false })

export type McpDiscoveryRuntimeAuthorizer = (input: {
  tenantId: string
  runtimeId: string
  request: FastifyRequest
}) => boolean | void | Promise<boolean | void>

export interface McpDiscoveryHttpOptions {
  store: McpDiscoveryStore
  registrations: RuntimeControlStore
  authorizeRuntime: McpDiscoveryRuntimeAuthorizer
  oauth: McpOAuthService
}

async function authorizeRuntime(
  options: McpDiscoveryHttpOptions,
  tenantId: string,
  runtimeId: string,
  request: FastifyRequest,
): Promise<{ gatewayId: string }> {
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
  return { gatewayId: registration.target_id }
}

export const mcpDiscoveryHttp: FastifyPluginAsync<McpDiscoveryHttpOptions> = async (
  app,
  options,
) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()

  routes.post(
    "/v1/tenants/:tenant_id/resources/:resource_id/connections/:connection_id/mcp-discovery",
    {
      schema: {
        operationId: "requestMcpDiscovery",
        summary: "Request MCP discovery from the owning Gateway Runtime group",
        tags: ["Connections"],
        params: ConnectionPathSchema,
        body: RequestMcpDiscoverySchema,
        response: { 202: McpDiscoveryOperationSchema },
      },
    },
    async (request, reply) => {
      const operation = await options.store.request({
        tenantId: request.params.tenant_id,
        resourceId: request.params.resource_id,
        connectionId: request.params.connection_id,
        requestedBySubjectId: request.principal!.subject_id,
        correlationId: request.body.correlation_id,
      })
      return reply.code(202).send(operation)
    },
  )

  routes.get(
    "/v1/tenants/:tenant_id/resources/:resource_id/connections/:connection_id/mcp-discovery/latest",
    {
      schema: {
        operationId: "getLatestMcpDiscovery",
        summary: "Get the latest MCP discovery observation",
        tags: ["Connections"],
        params: ConnectionPathSchema,
        response: { 200: Type.Union([McpDiscoveryOperationSchema, Type.Null()]) },
      },
    },
    async (request) => options.store.latest({
      tenantId: request.params.tenant_id,
      resourceId: request.params.resource_id,
      connectionId: request.params.connection_id,
    }),
  )

  routes.post(
    "/v1/tenants/:tenant_id/resources/:resource_id/connections/:connection_id/mcp-discovery/candidates/:candidate_id/decision",
    {
      schema: {
        operationId: "decideMcpDiscoveryCandidate",
        summary: "Publish, ignore, or block one immutable MCP discovery candidate",
        tags: ["Connections"],
        params: CandidatePathSchema,
        body: DecideMcpDiscoveryCandidateSchema,
        response: { 200: McpDiscoveryOperationSchema },
      },
    },
    async (request) => options.store.decideCandidate({
      tenantId: request.params.tenant_id,
      resourceId: request.params.resource_id,
      connectionId: request.params.connection_id,
      candidateId: request.params.candidate_id,
      expectedRevisionDigest: request.body.expected_revision_digest,
      state: request.body.state,
    }),
  )

  routes.get(
    "/v1/tenants/:tenant_id/runtime-control/GATEWAY/:runtime_id/operations/mcp-discovery/next",
    {
      schema: {
        operationId: "claimMcpDiscoveryOperation",
        summary: "Claim the next MCP discovery operation for a Gateway Runtime group",
        tags: ["Runtime Control"],
        params: RuntimePathSchema,
        response: { 200: Type.Union([McpDiscoveryOperationSchema, Type.Null()]) },
      },
    },
    async (request) => {
      const tenantId = request.params.tenant_id
      const runtimeId = request.params.runtime_id
      const runtime = await authorizeRuntime(options, tenantId, runtimeId, request)
      return options.store.claimNext({
        tenantId,
        runtimeId,
        gatewayId: runtime.gatewayId,
      })
    },
  )

  routes.post(
    "/v1/tenants/:tenant_id/runtime-control/GATEWAY/:runtime_id/operations/mcp-discovery/:operation_id/result",
    {
      schema: {
        operationId: "completeMcpDiscoveryOperation",
        summary: "Report an MCP discovery operation result",
        tags: ["Runtime Control"],
        params: RuntimeOperationPathSchema,
        body: CompleteMcpDiscoverySchema,
        response: { 200: McpDiscoveryOperationSchema },
      },
    },
    async (request) => {
      const tenantId = request.params.tenant_id
      const runtimeId = request.params.runtime_id
      await authorizeRuntime(options, tenantId, runtimeId, request)
      return options.store.complete({
        tenantId,
        runtimeId,
        operationId: request.params.operation_id,
        result: request.body,
      })
    },
  )

  routes.get(
    "/v1/tenants/:tenant_id/runtime-control/GATEWAY/:runtime_id/operations/mcp-discovery/:operation_id/credential",
    {
      schema: {
        operationId: "resolveMcpDiscoveryCredential",
        summary: "Resolve the claimed subject credential for an MCP discovery operation",
        tags: ["Runtime Control"],
        params: RuntimeOperationPathSchema,
        response: { 200: McpDiscoveryCredentialSchema },
      },
    },
    async (request) => {
      const tenantId = request.params.tenant_id
      const runtimeId = request.params.runtime_id
      const runtime = await authorizeRuntime(options, tenantId, runtimeId, request)
      const operation = await options.store.get({
        tenantId,
        operationId: request.params.operation_id,
      })
      if (
        !operation ||
        operation.state !== "RUNNING" ||
        operation.runtime_id !== runtimeId ||
        operation.gateway_id !== runtime.gatewayId ||
        operation.downstream_identity.mode !== "USER_OAUTH"
      ) {
        throw new PlatformApiError("MCP_DISCOVERY_CREDENTIAL_UNAVAILABLE", 409)
      }
      const credential = await options.oauth.resolveAccessToken({
        tenantId,
        connectionId: operation.connection_id,
        subjectId: operation.requested_by_subject_id,
      })
      return {
        access_token: credential.accessToken,
        expires_at: credential.expiresAt,
      }
    },
  )
}
