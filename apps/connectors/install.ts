import { isDeepStrictEqual } from "node:util"
import { validateConnectorConfiguration, type ConnectorConfiguration } from "./configuration"
import { randomUUID } from "node:crypto"
import { z } from "zod"

export const CommonInstallConfiguration = z.object({
  connectorConfiguration: z.custom<ConnectorConfiguration>((value) => { try { validateConnectorConfiguration(value); return true } catch { return false } }).optional(),
  platformOrigin: z.string().url(),
  tenantId: z.string().min(1),
  ownerOrganizationId: z.string().min(1),
  environmentId: z.string().min(1),
  gatewayId: z.string().min(1),
  upstreamEndpoint: z.string().url(),
  hostname: z.string().min(1),
  basePath: z.string().startsWith("/"),
  dnsTarget: z.string().min(1),
  identityIssuer: z.string().url(),
  identityAudience: z.string().min(1),
})

export type CommonInstallConfig = z.infer<typeof CommonInstallConfiguration>
export type Api = <T>(path: string, init?: RequestInit) => Promise<T>
interface Resource {
  resource_id: string
  display_name: string
  kind: string
  owner_organization_id: string
  lifecycle: string
  publication_request?: { request_id: string; state: string; publication_state?: string } | null
  publication_endpoint?: { visibility: string; hostname: string; base_path: string } | null
}
interface Connection {
  connector_configuration?: ConnectorConfiguration
  connection_id: string
  endpoint: string
  verification_state: string
  mcp_selected_tools?: string[]
  downstream_identity: { mode: string; oauth_client?: { client_id: string; issuer: string } }
}
interface Discovery {
  state: string
  error_code: string | null
  candidates: Array<{ candidate_id: string; tool_name: string; revision_digest: string }>
}

export interface StandardConnectorDefinition {
  name: string
  namespace: string
  capabilityLabel: string
  tools: readonly string[]
  downstreamIdentity: { mode: "USER_OAUTH" | "USER_PASSWORD"; oauth_client?: { issuer: string; authorization_endpoint: string; token_endpoint: string; client_id: string; scopes: string[] } }
}

export async function installStandardConnector(configuration: CommonInstallConfig, definition: StandardConnectorDefinition, request: Api) {
  const config = CommonInstallConfiguration.parse(configuration)
  const base = `/v1/tenants/${encodeURIComponent(config.tenantId)}`
  const json = (value: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(value) })
  const matches = (await request<Resource[]>(`${base}/resources`)).filter((resource) => resource.display_name === definition.name && resource.lifecycle !== "RETIRED")
  if (matches.length > 1) throw new Error("STANDARD_RESOURCE_AMBIGUOUS")
  let resource = matches[0]
  if (resource && (resource.kind !== "MCP" || resource.owner_organization_id !== config.ownerOrganizationId)) throw new Error("STANDARD_RESOURCE_CONFLICT")
  if (!resource) resource = await request<Resource>(`${base}/resources`, json({
    display_name: definition.name, kind: "MCP", owner_organization_id: config.ownerOrganizationId,
    authentication_strategy: "OAUTH", environment_id: config.environmentId, version: "0.1.0",
    capabilities: [{ capability_id: "mcp.invoke", display_name: definition.capabilityLabel }], enforcement_point_id: config.gatewayId,
  }))
  const resourcePath = `${base}/resources/${encodeURIComponent(resource.resource_id)}`
  const connections = await request<Connection[]>(`${resourcePath}/connections`)
  if (connections.length > 1) throw new Error("STANDARD_CONNECTION_AMBIGUOUS")
  let connection = connections[0]
  if (connection && ((config.connectorConfiguration && !isDeepStrictEqual(config.connectorConfiguration, connection.connector_configuration)) || (!config.connectorConfiguration && connection.endpoint !== config.upstreamEndpoint) || connection.downstream_identity.mode !== definition.downstreamIdentity.mode || (definition.downstreamIdentity.oauth_client && (connection.downstream_identity.oauth_client?.client_id !== definition.downstreamIdentity.oauth_client.client_id || connection.downstream_identity.oauth_client?.issuer !== definition.downstreamIdentity.oauth_client.issuer)))) throw new Error("STANDARD_CONNECTION_CONFLICT")
  if (!connection) connection = await request<Connection>(`${resourcePath}/connections`, json({
    display_name: definition.name, connection_kind: "MCP", ...(config.connectorConfiguration ? { connector_configuration: config.connectorConfiguration } : { endpoint: config.upstreamEndpoint }), mcp_tool_namespace: definition.namespace,
    downstream_identity: definition.downstreamIdentity,
  }))
  if (resource.lifecycle === "PUBLISHED") {
    if (resource.publication_endpoint?.visibility !== "PUBLIC" || resource.publication_endpoint.hostname !== config.hostname || resource.publication_endpoint.base_path !== config.basePath) throw new Error("STANDARD_PUBLICATION_CONFLICT")
    if (definition.tools.every((tool) => connection.mcp_selected_tools?.includes(tool)) && (!resource.publication_request || resource.publication_request.publication_state === "READY")) return { resourceId: resource.resource_id, connectionId: connection.connection_id, access: "AUTO_GRANT", lifecycle: resource.lifecycle }
  }
  if (!["DRAFT", "PUBLISHED"].includes(resource.lifecycle)) throw new Error("STANDARD_RESOURCE_NOT_DRAFT")
  const connectionPath = `${resourcePath}/connections/${encodeURIComponent(connection.connection_id)}`
  if (connection.verification_state !== "VERIFIED") await request(`${connectionPath}/verify`, { method: "POST" })
  await request(`${connectionPath}/mcp-discovery`, json({ correlation_id: randomUUID() }))
  let discovery: Discovery | undefined
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    discovery = await request<Discovery>(`${connectionPath}/mcp-discovery/latest`)
    if (discovery.state === "SUCCEEDED" || discovery.state === "FAILED") break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (discovery?.state !== "SUCCEEDED") throw new Error(`STANDARD_DISCOVERY_FAILED:${discovery?.error_code ?? "TIMEOUT"}`)
  const requiredTools = definition.tools
  const tools = discovery.candidates.filter((candidate) => requiredTools.includes(candidate.tool_name))
  if (new Set(tools.map((tool) => tool.tool_name)).size !== requiredTools.length) throw new Error("STANDARD_TOOLS_INCOMPLETE")
  for (const tool of tools.filter((tool) => !connection.mcp_selected_tools?.includes(tool.tool_name))) await request(`${connectionPath}/mcp-discovery/candidates/${encodeURIComponent(tool.candidate_id)}/decision`, json({ expected_revision_digest: tool.revision_digest, state: "PUBLISHED" }))
  const issuer = config.identityIssuer.replace(/\/$/, "")
  if (resource.lifecycle === "DRAFT") await request(`${resourcePath}/capabilities/mcp.invoke/enforcement-chain`, json({ one_policy_revision: 1, steps: [
    { step_id: "authenticate", kind: "AUTHENTICATE", phase: "REQUEST", implementation: "NATIVE", config: { schema_version: "genio.one.auth.jwt.v1", provider: "keycloak", issuer, audiences: [config.identityAudience], remote_jwks_uri: `${issuer}/protocol/openid-connect/certs`, subject_claim: "sub", client_claim: "azp" } },
    { step_id: "authorize", kind: "AUTHORIZE", phase: "REQUEST", implementation: "EXT_AUTH", depends_on: ["authenticate"] },
    { step_id: "route", kind: "ROUTE", phase: "ROUTING", implementation: "AIGW_NATIVE", depends_on: ["authorize"] },
  ] }))
  if (!resource.publication_endpoint) await request(`${resourcePath}/publication-endpoint`, { method: "PUT", body: JSON.stringify({ gateway_id: config.gatewayId, hostname: config.hostname, base_path: config.basePath, visibility: "PUBLIC", dns_management: "EXTERNAL", dns_verification: "VERIFIED", dns_target: config.dnsTarget }) })
  else if (resource.publication_endpoint.visibility !== "PUBLIC" || resource.publication_endpoint.hostname !== config.hostname || resource.publication_endpoint.base_path !== config.basePath) throw new Error("STANDARD_PUBLICATION_CONFLICT")
  resource = await request<Resource>(resourcePath)
  const publication = resource.publication_request?.state === "PENDING" ? resource.publication_request : await request<{ request_id: string }>(`${resourcePath}/publication-requests`, json({}))
  await request(`${resourcePath}/publication-requests/${encodeURIComponent(publication.request_id)}/review`, json({ decision: "APPROVE" }))
  resource = await request<Resource>(resourcePath)
  if (resource.lifecycle !== "PUBLISHED") throw new Error("STANDARD_PUBLICATION_NOT_PUBLISHED")
  return { resourceId: resource.resource_id, connectionId: connection.connection_id, access: "AUTO_GRANT", lifecycle: resource.lifecycle }
}

export function managementApi(origin: string, token: string): Api {
  const url = new URL(origin)
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)))) throw new Error("STANDARD_PLATFORM_ORIGIN_INVALID")
  return async (path, init) => {
    const response = await fetch(new URL(path, url), { ...init, redirect: "error", signal: AbortSignal.timeout(30_000), headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}) } })
    if (!response.ok) throw new Error(`STANDARD_INSTALL_HTTP_${response.status}:${path}`)
    return response.status === 204 ? null : await response.json()
  }
}
