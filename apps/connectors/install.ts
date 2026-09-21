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

interface EnforcementChainRevision {
  one_policy_revision: number
  chain: {
    eligible_connection_ids: string[]
    steps: unknown
  }
}

interface ResourceCapabilityPolicyDefinition {
  one_policy_revision: number
  eligible_connection_ids?: string[]
  steps: unknown
}

interface ResourceCapabilityPolicyDraft {
  version: number
  base_revision: number
  content_digest: string
  lifecycle: "DRAFT" | "VALIDATED" | "REVIEWED"
  content: {
    kind: string
    definition: unknown
  }
}

export interface StandardConnectorDefinition {
  name: string
  namespace: string
  capabilityLabel: string
  tools: readonly string[]
  downstreamIdentity: { mode: "USER_OAUTH" | "USER_PASSWORD"; oauth_client?: { issuer: string; authorization_endpoint: string; token_endpoint: string; client_id: string; scopes: string[] } }
}

function isNotFound(error: unknown) {
  return error instanceof Error && /(?:^|_)HTTP_404:/.test(error.message)
}

async function missingIsNull<T>(request: Api, path: string) {
  try {
    return await request<T>(path)
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

function samePublishedChain(
  current: EnforcementChainRevision,
  definition: ResourceCapabilityPolicyDefinition,
) {
  if (!isDeepStrictEqual(current.chain.steps, definition.steps)) return false
  if (!definition.eligible_connection_ids) return true
  return isDeepStrictEqual(
    [...current.chain.eligible_connection_ids].sort(),
    [...definition.eligible_connection_ids].sort(),
  )
}

function sameDraft(
  draft: ResourceCapabilityPolicyDraft,
  baseRevision: number,
  definition: ResourceCapabilityPolicyDefinition,
) {
  return draft.base_revision === baseRevision &&
    draft.content.kind === "RESOURCE_CAPABILITY" &&
    isDeepStrictEqual(draft.content.definition, definition)
}

export async function ensureResourceCapabilityPolicy(
  request: Api,
  input: {
    base: string
    resourceId: string
    capabilityId: string
    steps: unknown
    eligibleConnectionIds?: string[]
  },
) {
  const path = `${input.base}/resources/${encodeURIComponent(input.resourceId)}/capabilities/${encodeURIComponent(input.capabilityId)}`
  const current = await missingIsNull<EnforcementChainRevision>(request, `${path}/enforcement-chain`)
  const baseRevision = current?.one_policy_revision ?? 0
  const definition: ResourceCapabilityPolicyDefinition = {
    one_policy_revision: baseRevision + 1,
    ...(input.eligibleConnectionIds ? { eligible_connection_ids: [...input.eligibleConnectionIds].sort() } : {}),
    steps: input.steps,
  }
  if (current && samePublishedChain(current, definition)) return current
  const existing = await missingIsNull<ResourceCapabilityPolicyDraft>(request, `${path}/policy-draft`)
  let draft = existing && sameDraft(existing, baseRevision, definition)
    ? existing
    : await request<ResourceCapabilityPolicyDraft>(`${path}/policy-draft`, {
        method: "PUT",
        body: JSON.stringify({
          expected_version: existing?.version ?? 0,
          base_revision: baseRevision,
          content: { kind: "RESOURCE_CAPABILITY", definition },
        }),
      })
  const transition = (action: "validate" | "review") => request<ResourceCapabilityPolicyDraft>(`${path}/policy-draft/${action}`, {
    method: "POST",
    body: JSON.stringify({
      expected_version: draft.version,
      expected_content_digest: draft.content_digest,
    }),
  })
  if (draft.lifecycle === "DRAFT") draft = await transition("validate")
  if (draft.lifecycle === "VALIDATED") draft = await transition("review")
  if (draft.lifecycle !== "REVIEWED") throw new Error(`STANDARD_POLICY_DRAFT_LIFECYCLE_INVALID:${draft.lifecycle}`)
  return request<EnforcementChainRevision>(`${path}/policy-draft/publish`, {
    method: "POST",
    body: JSON.stringify({
      expected_version: draft.version,
      expected_content_digest: draft.content_digest,
    }),
  })
}

function standardEnforcementSteps(config: CommonInstallConfig) {
  const issuer = config.identityIssuer.replace(/\/$/, "")
  return [
    { step_id: "authenticate", kind: "AUTHENTICATE", phase: "REQUEST", implementation: "NATIVE", config: { schema_version: "genio.one.auth.jwt.v1", provider: "keycloak", issuer, audiences: [config.identityAudience], remote_jwks_uri: `${issuer}/protocol/openid-connect/certs`, subject_claim: "sub", client_claim: "azp" } },
    { step_id: "authorize", kind: "AUTHORIZE", phase: "REQUEST", implementation: "EXT_AUTH", depends_on: ["authenticate"] },
    { step_id: "route", kind: "ROUTE", phase: "ROUTING", implementation: "AIGW_NATIVE", depends_on: ["authorize"] },
  ]
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
    if (definition.tools.every((tool) => connection.mcp_selected_tools?.includes(tool)) && (!resource.publication_request || resource.publication_request.publication_state === "READY")) {
      await ensureResourceCapabilityPolicy(request, { base, resourceId: resource.resource_id, capabilityId: "mcp.invoke", steps: standardEnforcementSteps(config) })
      return { resourceId: resource.resource_id, connectionId: connection.connection_id, access: "AUTO_GRANT", lifecycle: resource.lifecycle }
    }
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
  const requiredToolSet = new Set(requiredTools)
  const selectedToolSet = connection.mcp_selected_tools ? new Set(connection.mcp_selected_tools) : null
  const matchedToolNames = new Set<string>()
  const pendingTools: typeof discovery.candidates = []
  for (const candidate of discovery.candidates) {
    if (requiredToolSet.has(candidate.tool_name)) {
      matchedToolNames.add(candidate.tool_name)
      if (!selectedToolSet?.has(candidate.tool_name)) {
        pendingTools.push(candidate)
      }
    }
  }
  if (matchedToolNames.size !== requiredTools.length) throw new Error("STANDARD_TOOLS_INCOMPLETE")
  await Promise.all(pendingTools.map((tool) => request(`${connectionPath}/mcp-discovery/candidates/${encodeURIComponent(tool.candidate_id)}/decision`, json({ expected_revision_digest: tool.revision_digest, state: "PUBLISHED" }))))
  await ensureResourceCapabilityPolicy(request, { base, resourceId: resource.resource_id, capabilityId: "mcp.invoke", steps: standardEnforcementSteps(config) })
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
