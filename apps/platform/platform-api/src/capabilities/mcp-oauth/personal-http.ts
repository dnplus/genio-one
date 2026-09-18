import type { FastifyPluginAsync, FastifyRequest } from "fastify"
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox"
import { Type } from "typebox"
import type { AccessGovernanceStore } from "../access/module"
import type { ResourceConnectionRegistry } from "../connections/module"
import { PlatformApiError } from "../errors"
import type { McpOAuthService } from "./module"
import { McpOAuthAuthorizationSchema } from "./contract"
import type { PersonalCredentials } from "../personal-credentials/module"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })
const ResourcePath = Type.Object({ tenant_id: Identifier, resource_id: Identifier })
const ConnectionPath = Type.Object({ tenant_id: Identifier, resource_id: Identifier, connection_id: Identifier })

export const personalConnectionHttp: FastifyPluginAsync<{
  access: Pick<AccessGovernanceStore, "catalog">
  connections: Pick<ResourceConnectionRegistry, "list" | "get">
  oauth: McpOAuthService
  passwords: PersonalCredentials
}> = async (app, options) => {
  const routes = app.withTypeProvider<TypeBoxTypeProvider>()
  const base = "/v1/tenants/:tenant_id/me/resource-connections/:resource_id"
  async function entitled(request: FastifyRequest, tenantId: string, resourceId: string) {
    const principal = request.principal
    if (!principal || principal.tenant_id !== tenantId) throw new PlatformApiError("UNAUTHENTICATED", 401)
    const catalog = await options.access.catalog({ tenantId, actor: {
      subjectId: principal.subject_id, clientId: principal.client_id,
      role: principal.role, organizationIds: principal.organization_ids,
    } })
    if (!catalog.capabilities.some((capability) => capability.resource_id === resourceId && (capability.access === "AUTO_GRANT" || capability.access === "ENTITLED"))) {
      throw new PlatformApiError("CONNECTION_ACCESS_REQUIRED", 403)
    }
    return principal.subject_id
  }
  routes.get(base, { schema: { params: ResourcePath, response: { 200: Type.Array(Type.Object({
    connection_id: Identifier, display_name: Type.String(),
    authentication: Type.Union([Type.Literal("OAUTH"), Type.Literal("PASSWORD")]), status: Type.Union([Type.Literal("CONNECTED"), Type.Literal("SAVED"), Type.Literal("NEEDS_CONNECTION")]),
  }, { additionalProperties: false })) } } }, async (request, reply) => {
    const { tenant_id: tenantId, resource_id: resourceId } = request.params
    const subjectId = await entitled(request, tenantId, resourceId)
    const connections = await options.connections.list({ tenantId, resourceId })
    const personal = connections.filter((connection) => connection.connection_kind === "MCP" && ["USER_OAUTH", "USER_PASSWORD"].includes(connection.downstream_identity.mode) && connection.lifecycle === "ENABLED")
    const result = await Promise.all(personal.map(async (connection) => ({
      connection_id: connection.connection_id,
      display_name: connection.display_name,
      authentication: connection.downstream_identity.mode === "USER_PASSWORD" ? "PASSWORD" as const : "OAUTH" as const,
      status: connection.downstream_identity.mode === "USER_PASSWORD"
        ? (await options.passwords.status({ tenantId, resourceId, connectionId: connection.connection_id, subjectId })).status
        : await options.oauth.status({ tenantId, resourceId, connectionId: connection.connection_id, subjectId }) ? "CONNECTED" as const : "NEEDS_CONNECTION" as const,
    })))
    return reply.header("cache-control", "no-store").send(result)
  })
  routes.post(`${base}/:connection_id/password`, { schema: { params: ConnectionPath, body: Type.Object({
    username: Type.String({ minLength: 1, maxLength: 512 }), password: Type.String({ minLength: 1, maxLength: 4096 }),
  }, { additionalProperties: false }), response: { 200: Type.Object({ status: Type.Literal("SAVED") }) } } }, async (request, reply) => {
    const { tenant_id: tenantId, resource_id: resourceId, connection_id: connectionId } = request.params
    const subjectId = await entitled(request, tenantId, resourceId)
    const result = await options.passwords.save({ tenantId, resourceId, connectionId, subjectId }, request.body)
    return reply.header("cache-control", "no-store").send(result)
  })
  routes.post(`${base}/:connection_id/authorize`, { schema: { params: ConnectionPath, response: { 200: McpOAuthAuthorizationSchema } } }, async (request, reply) => {
    const { tenant_id: tenantId, resource_id: resourceId, connection_id: connectionId } = request.params
    const subjectId = await entitled(request, tenantId, resourceId)
    const connection = await options.connections.get({ tenantId, resourceId, connectionId })
    if (connection.lifecycle !== "ENABLED") throw new PlatformApiError("CONNECTION_NOT_ENABLED", 409)
    return reply.header("cache-control", "no-store").send(await options.oauth.start({ tenantId, resourceId, connectionId, subjectId }))
  })
  routes.delete(`${base}/:connection_id`, { schema: { params: ConnectionPath, response: { 204: Type.Null() } } }, async (request, reply) => {
    const { tenant_id: tenantId, resource_id: resourceId, connection_id: connectionId } = request.params
    const principal = request.principal
    if (!principal || principal.tenant_id !== tenantId) throw new PlatformApiError("UNAUTHENTICATED", 401)
    await options.connections.get({ tenantId, resourceId, connectionId })
    await options.oauth.disconnect({ tenantId, connectionId, subjectId: principal.subject_id })
    await options.passwords.remove({ tenantId, resourceId, connectionId, subjectId: principal.subject_id })
    return reply.code(204).send(null)
  })
}
