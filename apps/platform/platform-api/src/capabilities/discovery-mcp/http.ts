import type { FastifyPluginAsync } from "fastify"
import { randomUUID } from "node:crypto"
import { httpRequestCorrelationId, recordHttpMcpToolCompletion } from "@genioone/telemetry/fastify-observability"
import { handleDiscoveryMcp, type DiscoveryMcpCompletion } from "../../../../../connectors/discovery/server"
import type { AccessGovernanceStore } from "../access/module"
import type { ResourceConnectionRegistry } from "../connections/module"
import { isPlatformApiError, PlatformApiError } from "../errors"
import type { SharedMemoryDirectory } from "../memories/module"
import type { DiscoveryMcpPostHogSink } from "./posthog"

const invocationScope = "genioone-invocation"

type DiscoveryMcpHttpOptions = {
  access: AccessGovernanceStore
  connections: Pick<ResourceConnectionRegistry, "get">
  memories: Pick<SharedMemoryDirectory, "listPersonalAsAgent">
  browserIdentity?: {
    issuer: string
    scopes: readonly string[]
  }
  publicOrigin?: string
  postHog?: DiscoveryMcpPostHogSink
}

function decodeTenantId(value: string): string | null {
  try {
    const tenantId = decodeURIComponent(value)
    if (!tenantId || tenantId === "." || tenantId === ".." || /[\\/\0]/u.test(tenantId)) return null
    return tenantId
  } catch {
    return null
  }
}

export function discoveryTenantIdFromUrl(url: string): string | null {
  const path = url.split("?", 1)[0]
  const match = /^\/v1\/tenants\/([^/]+)\/discovery\/mcp$/u.exec(path)
  return match ? decodeTenantId(match[1]!) : null
}

export function discoveryMetadataUrl(publicOrigin: string, tenantId: string): string {
  const origin = new URL(publicOrigin)
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password) {
    throw new Error("DISCOVERY_PUBLIC_ORIGIN_INVALID")
  }
  return new URL(
    `/.well-known/oauth-protected-resource/v1/tenants/${encodeURIComponent(tenantId)}/discovery/mcp`,
    origin,
  ).toString()
}

function discoveryEndpoint(publicOrigin: string, tenantId: string): string {
  const origin = new URL(publicOrigin)
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password) {
    throw new Error("DISCOVERY_PUBLIC_ORIGIN_INVALID")
  }
  return new URL(`/v1/tenants/${encodeURIComponent(tenantId)}/discovery/mcp`, origin).toString()
}

async function enabledDiscoveryConnection(
  options: DiscoveryMcpHttpOptions,
  tenantId: string,
): Promise<{ endpoint: string }> {
  try {
    const connection = await options.connections.get({
      tenantId,
      resourceId: "genio-one-discovery",
      connectionId: "genio-one-discovery",
    })
    if (
      connection.lifecycle !== "ENABLED" ||
      !options.publicOrigin ||
      connection.endpoint !== discoveryEndpoint(options.publicOrigin, tenantId)
    ) {
      throw new PlatformApiError("DISCOVERY_METADATA_NOT_FOUND", 404)
    }
    return { endpoint: connection.endpoint }
  } catch (error) {
    if (isPlatformApiError(error) && error.statusCode === 404) {
      throw new PlatformApiError("DISCOVERY_METADATA_NOT_FOUND", 404)
    }
    throw error
  }
}

export const discoveryMcpHttp: FastifyPluginAsync<DiscoveryMcpHttpOptions> = async (app, options) => {
  if (options.browserIdentity && options.publicOrigin) {
    const browserIdentity = options.browserIdentity
    app.get("/.well-known/oauth-protected-resource/v1/tenants/:tenant_id/discovery/mcp", { schema: { hide: true } }, async (request, reply) => {
      const tenantId = decodeTenantId((request.params as { tenant_id: string }).tenant_id)
      if (!tenantId) throw new PlatformApiError("DISCOVERY_METADATA_NOT_FOUND", 404)
      const connection = await enabledDiscoveryConnection(options, tenantId)
      reply.header("cache-control", "no-store")
      return reply.send({
        resource: connection.endpoint,
        authorization_servers: [browserIdentity.issuer],
        scopes_supported: browserIdentity.scopes.includes("genioone-invocation") ? ["genioone-invocation"] : [],
        bearer_methods_supported: ["header"],
      })
    })
  }

  app.all("/v1/tenants/:tenant_id/discovery/mcp", { schema: { hide: true } }, async (request, reply) => {
    const principal = request.principal!
    const startedAt = performance.now()
    const correlationId = httpRequestCorrelationId(request)
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
      completed: (completion: DiscoveryMcpCompletion) => {
        const latencyMillis = Math.max(0, Math.round(performance.now() - startedAt))
        recordHttpMcpToolCompletion(request, {
          serverName: "genio-one-discovery",
          toolName: completion.tool,
          statusCode: completion.statusCode,
          durationMillis: latencyMillis,
          outcome: completion.outcome,
          errorCode: completion.errorCode,
        })
        request.log.info({
          event: "discovery.mcp.completed",
          correlation_id: correlationId,
          tenant_id: principal.tenant_id,
          subject_id: principal.subject_id,
          acting_client_id: principal.client_id,
          tool: completion.tool,
          result_count: completion.resultCount,
          catalog_revision: completion.catalogRevision,
          outcome: completion.outcome,
          error_code: completion.errorCode,
          status_code: completion.statusCode,
          duration_ms: latencyMillis,
        }, "Discovery MCP completed")
        if (!options.postHog) return
        const telemetryEvent = {
          tenantId: principal.tenant_id,
          correlationId,
          completionId: randomUUID(),
          tool: completion.tool,
          resultCount: completion.resultCount,
          latencyMillis,
          statusCode: completion.statusCode,
          outcome: completion.outcome,
          errorCode: completion.errorCode,
          occurredAt: Math.floor(Date.now() / 1_000),
        }
        void Promise.resolve().then(() => options.postHog!.capture(telemetryEvent)).catch(() => {
          request.log.warn({ event: "discovery.mcp.posthog_failed", code: "POSTHOG_CAPTURE_FAILED" }, "Discovery MCP telemetry failed")
        })
      },
    })
    reply.header("cache-control", "no-store")
    reply.header("x-request-id", request.id)
    for (const [name, value] of response.headers) reply.header(name, value)
    return reply.code(response.status).send(response.body ? await response.text() : undefined)
  })
}
