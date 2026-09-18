import { createHash } from "node:crypto"

import { CE_DEMO_RESOURCE_IDS } from "../../../packages/protocol/src/ce-demo"
import { resolveBotRelayOrigin, resolveGenioOneMcpUrl } from "./runtime"

const CE_DEMO_MCP_RESOURCES = {
  [CE_DEMO_RESOURCE_IDS.context7]: { serverName: "genio_context7" },
  [CE_DEMO_RESOURCE_IDS.archify]: { serverName: "genio_archify" },
} as const

export interface ManagedMcpPublicationEndpoint {
  hostname: string
  base_path: string
  capabilityId?: string
}
export type ManagedMcpEndpoints = Record<string, ManagedMcpPublicationEndpoint>
export interface ManagedMcpBinding {
  resourceId: string
  capabilityId: string
  state: string
  kind: string
}

const CE_STARTER_MCP_SERVER_NAMES = new Set<string>(Object.values(CE_DEMO_MCP_RESOURCES).map((resource) => resource.serverName))

function ceStarterMcpServerName(resourceId: string) {
  return CE_DEMO_MCP_RESOURCES[resourceId as keyof typeof CE_DEMO_MCP_RESOURCES]?.serverName ?? null
}

function isCeStarterResource(sourceResourceId: string | null | undefined, resourceId: string) {
  return sourceResourceId === CE_DEMO_RESOURCE_IDS.bot && ceStarterMcpServerName(resourceId) !== null
}

function hasInstalledMcpBinding(bindings: readonly ManagedMcpBinding[]) {
  return bindings.some((binding) => binding.state === "INSTALLED" && binding.kind === "MCP")
}

function isInstalledMcpBinding(bindings: readonly ManagedMcpBinding[], resourceId: string, capabilityId: string) {
  return bindings.some((binding) =>
    binding.resourceId === resourceId && binding.capabilityId === capabilityId && binding.state === "INSTALLED" && binding.kind === "MCP")
}

function publicationEndpoint(value: unknown): ManagedMcpPublicationEndpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const endpoint = value as Record<string, unknown>
  if (typeof endpoint.hostname !== "string" || typeof endpoint.base_path !== "string") return null
  const hostname = endpoint.hostname.trim()
  const basePath = endpoint.base_path.trim()
  if (!hostname || !basePath.startsWith("/")) return null
  try {
    const origin = new URL(`http://${hostname}`)
    if (origin.hostname !== hostname || origin.port || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) return null
    const target = new URL(basePath, origin)
    if (target.origin !== origin.origin || target.search || target.hash) return null
    return { hostname, base_path: target.pathname }
  } catch {
    return null
  }
}

function managedMcpTransport(environment: NodeJS.ProcessEnv): URL | null {
  const configured = resolveGenioOneMcpUrl(environment)
  if (!configured) return null
  try {
    const transport = new URL(configured)
    return transport.protocol === "http:" || transport.protocol === "https:" ? transport : null
  } catch {
    return null
  }
}

function managedMcpPublicationTarget(endpoint: ManagedMcpPublicationEndpoint, environment: NodeJS.ProcessEnv): string | null {
  const publication = publicationEndpoint(endpoint)
  const transport = managedMcpTransport(environment)
  if (!publication || !transport) return null
  try {
    const origin = new URL(`${transport.protocol}//${publication.hostname}`)
    origin.port = transport.port
    return new URL(publication.base_path, origin).toString()
  } catch {
    return null
  }
}

export function managedMcpEndpointsFromCatalog(
  value: unknown,
  sourceResourceId: string | null | undefined,
  bindings: readonly ManagedMcpBinding[] = [],
): ManagedMcpEndpoints {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MANAGED_MCP_CATALOG_INVALID")
  const capabilities = (value as Record<string, unknown>).capabilities
  if (!Array.isArray(capabilities)) throw new Error("MANAGED_MCP_CATALOG_INVALID")
  const endpoints = new Map<string, ManagedMcpPublicationEndpoint>()
  for (const candidate of capabilities) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue
    const capability = candidate as Record<string, unknown>
    const resourceId = typeof capability.resource_id === "string" ? capability.resource_id.trim() : ""
    const capabilityId = typeof capability.capability_id === "string" ? capability.capability_id.trim() : ""
    if (!resourceId || (capability.access !== "ENTITLED" && capability.access !== "AUTO_GRANT")) continue
    const starter = isCeStarterResource(sourceResourceId, resourceId)
    if (!starter && (!capabilityId || !isInstalledMcpBinding(bindings, resourceId, capabilityId))) continue
    const endpoint = publicationEndpoint(capability.publication_endpoint)
    if (endpoint) endpoints.set(resourceId, starter ? endpoint : { ...endpoint, capabilityId })
  }
  return Object.fromEntries(endpoints)
}

export async function resolveManagedMcpEndpoints(
  sourceResourceId: string | null | undefined,
  bindings: readonly ManagedMcpBinding[] = [],
  tenantId: string,
  accessToken: string | null | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = globalThis.fetch,
) {
  if (sourceResourceId !== CE_DEMO_RESOURCE_IDS.bot && !hasInstalledMcpBinding(bindings)) return {}
  if (!accessToken?.trim()) throw new Error("MANAGED_MCP_CATALOG_UNAVAILABLE")
  const origin = environment.GENIO_ONE_PLATFORM_ORIGIN?.trim() || "http://127.0.0.1:58082"
  let response: Response
  try {
    response = await fetcher(new URL(`/v1/tenants/${encodeURIComponent(tenantId)}/catalog`, origin), {
      headers: { authorization: `Bearer ${accessToken.trim()}`, accept: "application/json" },
      signal: AbortSignal.timeout(2_000),
    })
  } catch {
    throw new Error("MANAGED_MCP_CATALOG_UNAVAILABLE")
  }
  if (!response.ok) throw new Error("MANAGED_MCP_CATALOG_UNAVAILABLE")
  try {
    return managedMcpEndpointsFromCatalog(await response.json(), sourceResourceId, bindings)
  } catch (error) {
    if (error instanceof Error && error.message === "MANAGED_MCP_CATALOG_INVALID") throw error
    throw new Error("MANAGED_MCP_CATALOG_INVALID")
  }
}

export function managedMcpTarget(
  resourceId: string,
  endpoints: ManagedMcpEndpoints = {},
  environment: NodeJS.ProcessEnv = process.env,
) {
  const endpoint = endpoints[resourceId]
  return endpoint ? managedMcpPublicationTarget(endpoint, environment) : null
}

export function managedMcpServerName(sourceResourceId: string | null | undefined, resourceId: string) {
  const starterServerName = isCeStarterResource(sourceResourceId, resourceId) ? ceStarterMcpServerName(resourceId) : null
  if (starterServerName) return starterServerName
  return `genio_mcp_${createHash("sha256").update(resourceId).digest("hex").slice(0, 24)}`
}

export function isManagedMcpServerName(value: unknown) {
  return typeof value === "string" && (CE_STARTER_MCP_SERVER_NAMES.has(value) || /^genio_mcp_[a-f0-9]{24}$/.test(value))
}

export function managedMcpConfig(
  sourceResourceId: string | null | undefined,
  runtimeSessionId: string,
  endpoints: ManagedMcpEndpoints = {},
  environment: NodeJS.ProcessEnv = process.env,
) {
  const relayOrigin = resolveBotRelayOrigin(environment)
  return Object.fromEntries(Object.keys(endpoints).flatMap((resourceId) => {
    if (!managedMcpTarget(resourceId, endpoints, environment)) return []
    const url = new URL(`/api/mcp-gateway/${encodeURIComponent(runtimeSessionId)}/${encodeURIComponent(resourceId)}/mcp`, relayOrigin).toString()
    return [[`mcp_servers.${managedMcpServerName(sourceResourceId, resourceId)}`, {
      url,
      bearer_token_env_var: "GENIO_ONE_MCP_BEARER_TOKEN",
      default_tools_approval_mode: "writes",
      required: false,
    }]]
  }))
}

export function isManagedMcpResourceForBot(
  sourceResourceId: string | null | undefined,
  bindings: readonly ManagedMcpBinding[] = [],
  resourceId: string,
  endpoints: ManagedMcpEndpoints = {},
) {
  const endpoint = endpoints[resourceId]
  if (!endpoint) return false
  return isCeStarterResource(sourceResourceId, resourceId) || Boolean(endpoint.capabilityId && isInstalledMcpBinding(bindings, resourceId, endpoint.capabilityId))
}
