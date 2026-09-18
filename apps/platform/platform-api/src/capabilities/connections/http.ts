import { listInstalledConnectors, prepareConnectorConfiguration, type InstalledConnectorDeployment } from "./installed-connectors"
import type { FastifyPluginAsync, FastifyRequest } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"
import { Type } from "typebox"

import {
  ConnectionListSchema,
  ConnectionHealthObservationSchema,
  ConnectionHealthBatchObservationSchema,
  ConnectionHealthTargetListSchema,
  ConnectionLifecycleCommandSchema,
  ConnectionPathSchema,
  ConnectionRegistrationSchema,
  CreateConnectionSchema,
  UpdateConnectionCertificateSchema,
  UpdateMcpRoutingSchema,
  ResourceConnectionsPathSchema,
  UpdateConnectionSchema,
} from "./contract"
import type { ResourceConnectionRegistry } from "./module"
import { PlatformApiError } from "../errors"

export interface ConnectionHttpOptions {
  connectorDeployment?: InstalledConnectorDeployment
  registry: ResourceConnectionRegistry
  authorizeRuntime(input: { tenantId: string; runtimeId: string; request: FastifyRequest }): Promise<void>
  runtimeGatewayId(input: { tenantId: string; runtimeId: string }): Promise<string>
}

const RuntimePathSchema = Type.Object({
  tenant_id: Type.String({ minLength: 1, maxLength: 256 }),
  runtime_id: Type.String({ minLength: 1, maxLength: 256 }),
}, { additionalProperties: false })

export const connectionHttp: FastifyPluginAsync<ConnectionHttpOptions> = async (
  app,
  options,
) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()
  routes.get("/v1/tenants/:tenant_id/connectors", {
    schema: {
      operationId: "listInstalledConnectors", tags: ["Connections"],
      params: Type.Object({ tenant_id: Type.String({ minLength: 1 }) }),
      response: { 200: Type.Array(Type.Object({
        kind: Type.Union([Type.Literal("servicenow-csm"), Type.Literal("mail2000")]),
        display_name: Type.String(),
        available: Type.Boolean(),
        resource_id: Type.String(),
        connection_id: Type.String(),
        configuration_required: Type.Boolean(),
        lifecycle: Type.Union([
          Type.Literal("DRAFT"),
          Type.Literal("ENABLED"),
          Type.Literal("DISABLED"),
          Type.Literal("REVOKE_PENDING"),
          Type.Literal("REVOKED"),
        ]),
      })) },
    },
  }, (request) => listInstalledConnectors(options.connectorDeployment, {
    tenantId: request.params.tenant_id,
    registry: options.registry,
  }))

  routes.get(
    "/v1/tenants/:tenant_id/runtime-control/GATEWAY/:runtime_id/connection-health-targets",
    {
      schema: {
        operationId: "listRuntimeConnectionHealthTargets",
        summary: "List Connection health targets assigned to a Gateway Runtime",
        tags: ["Runtime Control"],
        params: RuntimePathSchema,
        response: { 200: ConnectionHealthTargetListSchema },
      },
    },
    async (request) => {
      await options.authorizeRuntime({
        tenantId: request.params.tenant_id,
        runtimeId: request.params.runtime_id,
        request,
      })
      const gatewayId = await options.runtimeGatewayId({
        tenantId: request.params.tenant_id,
        runtimeId: request.params.runtime_id,
      })
      return options.registry.listHealthTargets({ tenantId: request.params.tenant_id, gatewayId })
    },
  )

  routes.post(
    "/v1/tenants/:tenant_id/runtime-control/GATEWAY/:runtime_id/connection-health-observations",
    {
      schema: {
        operationId: "observeRuntimeConnectionHealthBatch",
        summary: "Record one Runtime Connection health scan",
        tags: ["Runtime Control"],
        params: RuntimePathSchema,
        body: ConnectionHealthBatchObservationSchema,
        response: { 200: ConnectionListSchema },
      },
    },
    async (request) => {
      await options.authorizeRuntime({
        tenantId: request.params.tenant_id,
        runtimeId: request.params.runtime_id,
        request,
      })
      const gatewayId = await options.runtimeGatewayId({
        tenantId: request.params.tenant_id,
        runtimeId: request.params.runtime_id,
      })
      return options.registry.observeHealthBatch({
        tenantId: request.params.tenant_id,
        gatewayId,
        value: request.body,
      })
    },
  )

  routes.get(
    "/v1/tenants/:tenant_id/resources/:resource_id/connections",
    {
      schema: {
        operationId: "listResourceConnections",
        summary: "List Connections owned by a Resource",
        tags: ["Connections"],
        params: ResourceConnectionsPathSchema,
        response: { 200: ConnectionListSchema },
      },
    },
    async (request) =>
      options.registry.list({
        tenantId: request.params.tenant_id,
        resourceId: request.params.resource_id,
      }),
  )

  routes.post(
    "/v1/tenants/:tenant_id/resources/:resource_id/connections",
    {
      schema: {
        operationId: "createResourceConnection",
        summary: "Register a provider Connection for a Resource",
        tags: ["Connections"],
        params: ResourceConnectionsPathSchema,
        body: Type.Object({ ...CreateConnectionSchema.properties, endpoint: Type.Optional(CreateConnectionSchema.properties.endpoint) }),
        response: { 201: ConnectionRegistrationSchema },
      },
    },
    async (request, reply) => {
      const prepared = request.body.connector_configuration
        ? prepareConnectorConfiguration(request.body.connector_configuration, options.connectorDeployment)
        : null
      if (prepared && request.body.connection_kind !== "MCP") throw new PlatformApiError("CONNECTOR_REQUIRES_MCP_RESOURCE", 422)
      if (!prepared && !request.body.endpoint) throw new PlatformApiError("CONNECTION_ENDPOINT_REQUIRED", 422)
      const connection = await options.registry.create({
        tenantId: request.params.tenant_id,
        resourceId: request.params.resource_id,
        value: { ...request.body, endpoint: request.body.endpoint ?? "", ...prepared },
      })
      return reply.code(201).send(connection)
    },
  )

  routes.patch(
    "/v1/tenants/:tenant_id/resources/:resource_id/connections/:connection_id",
    {
      schema: {
        operationId: "updateResourceConnection",
        summary: "Update a draft Resource Connection",
        tags: ["Connections"],
        params: ConnectionPathSchema,
        body: UpdateConnectionSchema,
        response: { 200: ConnectionRegistrationSchema },
      },
    },
    async (request) => {
      const current = await options.registry.get({ tenantId: request.params.tenant_id, resourceId: request.params.resource_id, connectionId: request.params.connection_id })
      const configuration = request.body.connector_configuration
      if (current.connector_configuration && !configuration && (request.body.endpoint !== undefined || request.body.downstream_identity !== undefined)) throw new PlatformApiError("CONNECTOR_CONFIGURATION_REQUIRED", 422)
      if (configuration && (current.connection_kind !== "MCP" || (current.connector_configuration && current.connector_configuration.kind !== configuration.kind))) throw new PlatformApiError("CONNECTOR_KIND_MISMATCH", 422)
      return options.registry.update({
        tenantId: request.params.tenant_id,
        resourceId: request.params.resource_id,
        connectionId: request.params.connection_id,
        value: { ...request.body, ...(configuration ? prepareConnectorConfiguration(configuration, options.connectorDeployment) : {}) },
      })
    },
  )

  routes.put(
    "/v1/tenants/:tenant_id/resources/:resource_id/connections/:connection_id/certificate",
    {
      schema: {
        operationId: "updateResourceConnectionCertificate",
        summary: "Update the upstream TLS trust certificate for a Resource Connection",
        tags: ["Connections"],
        params: ConnectionPathSchema,
        body: UpdateConnectionCertificateSchema,
        response: { 200: ConnectionRegistrationSchema },
      },
    },
    async (request) =>
      options.registry.updateCertificate({
        tenantId: request.params.tenant_id,
        resourceId: request.params.resource_id,
        connectionId: request.params.connection_id,
        value: request.body,
      }),
  )

  routes.post("/v1/tenants/:tenant_id/resources/:resource_id/connections/:connection_id/test", {
    schema: {
      operationId: "testResourceConnection",
      summary: "Test saved Connection connectivity without enabling or publishing it",
      tags: ["Connections"],
      params: ConnectionPathSchema,
      response: { 200: Type.Object({
        connection_id: Type.String(), configuration_revision: Type.Integer(),
        checked_at: Type.Integer(), duration_ms: Type.Integer(), source: Type.Literal("CONTROL_PLANE"),
        http_status: Type.Union([Type.Integer(), Type.Null()]),
        passed: Type.Boolean(), check: Type.Union([Type.Literal("PROTECTED_ENDPOINT"), Type.Literal("MCP_DISCOVERY"), Type.Literal("HTTP_REACHABILITY"), Type.Literal("PROVIDER_CONNECTIVITY")]),
        reason_code: Type.String(),
      }) },
    },
  }, async (request) => options.registry.test({ tenantId: request.params.tenant_id, resourceId: request.params.resource_id, connectionId: request.params.connection_id }))

  routes.post(
    "/v1/tenants/:tenant_id/resources/:resource_id/connections/:connection_id/verify",
    {
      schema: {
        operationId: "verifyResourceConnection",
        summary: "Verify a draft Connection through a trusted provider probe",
        tags: ["Connections"],
        params: ConnectionPathSchema,
        response: { 200: ConnectionRegistrationSchema },
      },
    },
    async (request) => options.registry.verify({
      tenantId: request.params.tenant_id,
      resourceId: request.params.resource_id,
      connectionId: request.params.connection_id,
      serviceKind: request.routeResource?.service_kind,
    }),
  )

  routes.post(
    "/v1/tenants/:tenant_id/resources/:resource_id/connections/:connection_id/mcp-routing",
    {
      schema: {
        operationId: "updateConnectionMcpRouting",
        summary: "Configure the MCP namespace and governed tool selection for a draft Connection",
        tags: ["Connections"],
        params: ConnectionPathSchema,
        body: UpdateMcpRoutingSchema,
        response: { 200: ConnectionRegistrationSchema },
      },
    },
    async (request) =>
      options.registry.updateMcpRouting({
        tenantId: request.params.tenant_id,
        resourceId: request.params.resource_id,
        connectionId: request.params.connection_id,
        expectedRevision: request.body.expected_revision,
        mcpToolNamespace: request.body.mcp_tool_namespace,
      }),
  )

  routes.post(
    "/v1/tenants/:tenant_id/resources/:resource_id/connections/:connection_id/lifecycle",
    {
      schema: {
        operationId: "transitionResourceConnectionLifecycle",
        summary: "Stage a Resource Connection lifecycle transition",
        tags: ["Connections"],
        params: ConnectionPathSchema,
        body: ConnectionLifecycleCommandSchema,
        response: { 200: ConnectionRegistrationSchema },
      },
    },
    async (request) => options.registry.transitionLifecycle({
      tenantId: request.params.tenant_id,
      resourceId: request.params.resource_id,
      connectionId: request.params.connection_id,
      value: request.body,
    }),
  )

  routes.post(
    "/v1/tenants/:tenant_id/resources/:resource_id/connections/:connection_id/health-observations",
    {
      schema: {
        operationId: "observeResourceConnectionHealth",
        summary: "Record a runtime-owned Connection health observation",
        tags: ["Connections"],
        params: ConnectionPathSchema,
        body: ConnectionHealthObservationSchema,
        response: { 200: ConnectionRegistrationSchema },
      },
    },
    async (request) => {
      const runtimeId = request.principal?.client_id
      if (!runtimeId) throw new PlatformApiError("RUNTIME_ACCESS_DENIED", 403)
      await options.authorizeRuntime({ tenantId: request.params.tenant_id, runtimeId, request })
      const gatewayId = await options.runtimeGatewayId({
        tenantId: request.params.tenant_id,
        runtimeId,
      })
      return options.registry.observeHealth({
        tenantId: request.params.tenant_id,
        gatewayId,
        resourceId: request.params.resource_id,
        connectionId: request.params.connection_id,
        value: request.body,
      })
    },
  )

  routes.delete(
    "/v1/tenants/:tenant_id/resources/:resource_id/connections/:connection_id",
    {
      schema: {
        operationId: "deleteResourceConnection",
        summary: "Delete a draft Resource Connection",
        tags: ["Connections"],
        params: ConnectionPathSchema,
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      await options.registry.remove({
        tenantId: request.params.tenant_id,
        resourceId: request.params.resource_id,
        connectionId: request.params.connection_id,
      })
      return reply.code(204).send(null)
    },
  )
}
