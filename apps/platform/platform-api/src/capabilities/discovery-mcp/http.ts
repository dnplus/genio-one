import type { FastifyPluginAsync } from "fastify"
import { handleDiscoveryMcp } from "../../../../../connectors/discovery/server"
import type { AccessGovernanceStore } from "../access/module"
import type { ResourceConnectionRegistry } from "../connections/module"
import { PlatformApiError } from "../errors"

export const discoveryMcpHttp: FastifyPluginAsync<{ access: AccessGovernanceStore; connections: Pick<ResourceConnectionRegistry, "get"> }> = async (app, options) => {
  app.all("/v1/tenants/:tenant_id/discovery/mcp", { schema: { hide: true } }, async (request, reply) => {
    const principal = request.principal!
    const connection = await options.connections.get({ tenantId: principal.tenant_id, resourceId: "genio-one-discovery", connectionId: "genio-one-discovery" })
    if (connection.lifecycle !== "ENABLED") throw new PlatformApiError("DISCOVERY_SERVICE_DISABLED", 403)
    const headers = new Headers()
    for (const name of ["content-type", "accept", "mcp-protocol-version", "mcp-session-id"]) {
      const value = request.headers[name]
      if (typeof value === "string") headers.set(name, value)
    }
    const response = await handleDiscoveryMcp(new Request(`http://platform${request.url}`, {
      method: request.method,
      headers,
      ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: request.body === undefined ? undefined : JSON.stringify(request.body) }),
    }), {
      catalog: () => options.access.catalog({ tenantId: principal.tenant_id, actor: {
        subjectId: principal.subject_id, clientId: principal.client_id, role: principal.role, organizationIds: principal.organization_ids,
      } }),
      completed: (tool, count, revision) => request.log.info({ event: "discovery.mcp.completed", correlation_id: request.id, tenant_id: principal.tenant_id, subject_id: principal.subject_id, acting_client_id: principal.client_id, tool, result_count: count, catalog_revision: revision }, "Discovery MCP completed"),
    })
    reply.header("cache-control", "no-store")
    reply.header("x-request-id", request.id)
    for (const [name, value] of response.headers) reply.header(name, value)
    return reply.code(response.status).send(response.body ? await response.text() : undefined)
  })
}
