import type { FastifyPluginAsync } from "fastify"
import { handleDiscoveryMcp } from "../../../../../connectors/discovery/server"
import type { AccessGovernanceStore } from "../access/module"
import type { ResourceConnectionRegistry } from "../connections/module"
import { PlatformApiError } from "../errors"
import type { SharedMemoryDirectory } from "../memories/module"

const invocationScope = "genioone-invocation"

export const discoveryMcpHttp: FastifyPluginAsync<{
  access: AccessGovernanceStore
  connections: Pick<ResourceConnectionRegistry, "get">
  memories: Pick<SharedMemoryDirectory, "listPersonalAsAgent">
}> = async (app, options) => {
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
      nativeCapabilities: async () => {
        if (!principal.scopes?.includes(invocationScope)) return []
        try {
          await options.memories.listPersonalAsAgent(principal, { limit: 1 })
        } catch (error) {
          if (error instanceof PlatformApiError && error.code === "MEMORY_AGENT_GRANT_INVALID") return []
          throw error
        }
        return [{
          native_capability_id: "genio-one-personal-memory",
          display_name: "記憶 MCP",
          description: "提供 PERSONAL、TEAM 與 ORGANIZATION 範圍的記憶操作；實際可用範圍由權限與成員資格決定。",
          transport: "streamable-http" as const,
          direct_mcp_route: `/v1/tenants/${encodeURIComponent(principal.tenant_id)}/memory/mcp`,
          authorization: {
            scheme: "bearer" as const,
            token_source: "same_discovery_request" as const,
          },
        }]
      },
      completed: (tool, count, revision) => request.log.info({ event: "discovery.mcp.completed", correlation_id: request.id, tenant_id: principal.tenant_id, subject_id: principal.subject_id, acting_client_id: principal.client_id, tool, result_count: count, catalog_revision: revision }, "Discovery MCP completed"),
    })
    reply.header("cache-control", "no-store")
    reply.header("x-request-id", request.id)
    for (const [name, value] of response.headers) reply.header(name, value)
    return reply.code(response.status).send(response.body ? await response.text() : undefined)
  })
}
