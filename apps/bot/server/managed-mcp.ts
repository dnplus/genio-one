import { createHash } from "node:crypto"

import { resolveBotRelayOrigin, resolveGenioOneMcpUrl } from "./runtime"

const MANAGED_SERVER_NAME = /^genio_[a-z0-9_]+$/
const MCP_SERVER_NAME_PREFIX = "genio_mcp_"
const SERVER_NAME_SLUG_LIMIT = 32
const CATALOG_TIMEOUT_MS = 2_000
const DEFAULT_PLATFORM_ORIGIN = "http://127.0.0.1:58082"

export interface ManagedMcpBinding {
  resourceId: string
  capabilityId: string
  state: string
  kind: string
}

export interface ManagedMcpMount {
  resourceId: string
  capabilityId: string
  serverName: string
  hostname: string
  basePath: string
}
export type ManagedMcpMounts = Record<string, ManagedMcpMount>

export function isManagedMcpServerName(value: unknown) {
  return typeof value === "string" && MANAGED_SERVER_NAME.test(value)
}

function isInstalledMcpBinding(bindings: readonly ManagedMcpBinding[], resourceId: string, capabilityId: string) {
  return bindings.some((binding) =>
    binding.resourceId === resourceId && binding.capabilityId === capabilityId && binding.state === "INSTALLED" && binding.kind === "MCP")
}

function parsePublicationEndpoint(value: unknown): { hostname: string; basePath: string } | null {
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
    return { hostname, basePath: target.pathname }
  } catch {
    return null
  }
}

function publicationSlug(hostname: string) {
  return hostname.split(".")[0]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, SERVER_NAME_SLUG_LIMIT)
}

function hashedServerName(resourceId: string) {
  return `${MCP_SERVER_NAME_PREFIX}${createHash("sha256").update(resourceId).digest("hex").slice(0, 24)}`
}

export function managedMcpMountsFromCatalog(
  value: unknown,
  bindings: readonly ManagedMcpBinding[],
): ManagedMcpMounts {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MANAGED_MCP_CATALOG_INVALID")
  const capabilities = (value as Record<string, unknown>).capabilities
  if (!Array.isArray(capabilities)) throw new Error("MANAGED_MCP_CATALOG_INVALID")

  const authorized = new Map<string, Omit<ManagedMcpMount, "serverName">>()
  for (const candidate of capabilities) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue
    const capability = candidate as Record<string, unknown>
    const resourceId = typeof capability.resource_id === "string" ? capability.resource_id.trim() : ""
    const capabilityId = typeof capability.capability_id === "string" ? capability.capability_id.trim() : ""
    if (!resourceId || !capabilityId) continue
    if (capability.access !== "ENTITLED" && capability.access !== "AUTO_GRANT") continue
    if (!isInstalledMcpBinding(bindings, resourceId, capabilityId)) continue
    const endpoint = parsePublicationEndpoint(capability.publication_endpoint)
    if (endpoint) authorized.set(resourceId, { resourceId, capabilityId, ...endpoint })
  }

  const slugUses = new Map<string, number>()
  for (const mount of authorized.values()) {
    const slug = publicationSlug(mount.hostname)
    if (slug) slugUses.set(slug, (slugUses.get(slug) ?? 0) + 1)
  }

  const mounts: ManagedMcpMounts = {}
  for (const [resourceId, mount] of authorized) {
    const slug = publicationSlug(mount.hostname)
    const serverName = slug && slugUses.get(slug) === 1
      ? `${MCP_SERVER_NAME_PREFIX}${slug}`
      : hashedServerName(resourceId)
    mounts[resourceId] = { ...mount, serverName }
  }
  return mounts
}

export interface ResolveManagedMcpMountsOptions {
  bindings: readonly ManagedMcpBinding[]
  tenantId: string
  accessToken: string | null | undefined
  environment?: NodeJS.ProcessEnv
  fetcher?: typeof fetch
  onDegraded?: (reason: string) => void
}

export async function resolveManagedMcpMounts(options: ResolveManagedMcpMountsOptions): Promise<ManagedMcpMounts> {
  const { bindings, tenantId, accessToken, environment = process.env, fetcher = globalThis.fetch, onDegraded } = options
  if (!bindings.some((binding) => binding.state === "INSTALLED" && binding.kind === "MCP")) return {}
  if (!accessToken?.trim()) {
    onDegraded?.("MANAGED_MCP_ACCESS_TOKEN_MISSING")
    return {}
  }
  const origin = environment.GENIO_ONE_PLATFORM_ORIGIN?.trim() || DEFAULT_PLATFORM_ORIGIN
  let response: Response
  try {
    response = await fetcher(new URL(`/v1/tenants/${encodeURIComponent(tenantId)}/catalog`, origin), {
      headers: { authorization: `Bearer ${accessToken.trim()}`, accept: "application/json" },
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    })
  } catch {
    onDegraded?.("MANAGED_MCP_CATALOG_UNREACHABLE")
    return {}
  }
  if (!response.ok) {
    onDegraded?.(`MANAGED_MCP_CATALOG_STATUS_${response.status}`)
    return {}
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error("MANAGED_MCP_CATALOG_INVALID")
  }
  return managedMcpMountsFromCatalog(body, bindings)
}

export function managedMcpTarget(mount: ManagedMcpMount, environment: NodeJS.ProcessEnv = process.env): string | null {
  const configured = resolveGenioOneMcpUrl(environment)
  if (!configured) return null
  try {
    const transport = new URL(configured)
    if (transport.protocol !== "http:" && transport.protocol !== "https:") return null
    const origin = new URL(`${transport.protocol}//${mount.hostname}`)
    origin.port = transport.port
    return new URL(mount.basePath, origin).toString()
  } catch {
    return null
  }
}

export function authorizedManagedMcpMount(
  resourceId: string,
  mounts: ManagedMcpMounts,
  bindings: readonly ManagedMcpBinding[],
): ManagedMcpMount | null {
  const mount = mounts[resourceId]
  if (!mount) return null
  return isInstalledMcpBinding(bindings, resourceId, mount.capabilityId) ? mount : null
}

export function managedMcpConfig(
  runtimeSessionId: string,
  mounts: ManagedMcpMounts = {},
  environment: NodeJS.ProcessEnv = process.env,
) {
  const relayOrigin = resolveBotRelayOrigin(environment)
  return Object.fromEntries(Object.values(mounts).flatMap((mount) => {
    if (!managedMcpTarget(mount, environment)) return []
    const url = new URL(`/api/mcp-gateway/${encodeURIComponent(runtimeSessionId)}/${encodeURIComponent(mount.resourceId)}/mcp`, relayOrigin).toString()
    return [[`mcp_servers.${mount.serverName}`, {
      url,
      bearer_token_env_var: "GENIO_ONE_MCP_BEARER_TOKEN",
      default_tools_approval_mode: "writes",
      required: false,
    }]]
  }))
}
