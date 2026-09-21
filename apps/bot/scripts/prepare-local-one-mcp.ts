import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"

const platformOrigin = process.env.GENIO_ONE_PLATFORM_ORIGIN?.trim() || "http://127.0.0.1:58082"
const keycloakOrigin = process.env.GENIO_ONE_KEYCLOAK_ORIGIN?.trim() || "http://127.0.0.1:58080"
const tenantId = process.env.GENIO_ONE_TENANT_ID?.trim() || "tenant-keycloak-local"
const managementToken = process.env.GENIO_ONE_MANAGEMENT_TOKEN?.trim() || "genio-one-local-admin"
const ownerOrganizationId = process.env.GENIO_ONE_OWNER_ORGANIZATION_ID?.trim() || "org-9e737aa2-fac5-45a8-8e04-81bf0ab87454"
const displayName = "ServiceNow CSM Pilot"
const tools = ["read_case"]
const capabilities = [
  { capability_id: "mcp.invoke", display_name: "Use ServiceNow CSM tools." },
]

async function request<T>(path: string, init?: RequestInit) {
  const response = await fetch(new URL(path, platformOrigin), {
    ...init,
    headers: {
      authorization: `Bearer ${managementToken}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${response.status} ${path} ${text}`)
  return (text ? JSON.parse(text) : null) as T
}

interface Resource {
  resource_id: string
  display_name: string
  lifecycle: "DRAFT" | "PUBLISHED" | "DEPRECATED" | "RETIRED"
  capabilities: Array<{ capability_id: string }>
}

interface Connection {
  connection_id: string
  display_name: string
  configuration_revision: number
  verification_state: string
  mcp_selected_tools: string[]
}

interface Entitlement {
  entitlement_id: string
  subject_id: string | null
  client_id: string | null
  resource_id: string
  capability_id: string
  state: string
}

interface McpDiscovery {
  state: string
  error_code: string | null
  candidates: Array<{
    candidate_id: string
    tool_name: string
    capability_id: string
    revision_digest: string
    state: string
  }>
}

interface EnforcementChainRevision {
  one_policy_revision: number
  chain: {
    steps: unknown
  }
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

async function missingIsNull<T>(path: string) {
  try {
    return await request<T>(path)
  } catch (error) {
    if (error instanceof Error && /^404\s/.test(error.message)) return null
    throw error
  }
}

async function ensureResourceCapabilityPolicy(
  resourceId: string,
  capabilityId: string,
  steps: unknown,
) {
  const path = `/v1/tenants/${tenantId}/resources/${encodeURIComponent(resourceId)}/capabilities/${encodeURIComponent(capabilityId)}`
  const current = await missingIsNull<EnforcementChainRevision>(`${path}/enforcement-chain`)
  const baseRevision = current?.one_policy_revision ?? 0
  const definition = { one_policy_revision: baseRevision + 1, steps }
  if (current && isDeepStrictEqual(current.chain.steps, steps)) return current
  const existing = await missingIsNull<ResourceCapabilityPolicyDraft>(`${path}/policy-draft`)
  let draft = existing &&
    existing.base_revision === baseRevision &&
    existing.content.kind === "RESOURCE_CAPABILITY" &&
    isDeepStrictEqual(existing.content.definition, definition)
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
  if (draft.lifecycle !== "REVIEWED") throw new Error(`MCP_POLICY_DRAFT_LIFECYCLE_INVALID ${draft.lifecycle}`)
  return request<EnforcementChainRevision>(`${path}/policy-draft/publish`, {
    method: "POST",
    body: JSON.stringify({
      expected_version: draft.version,
      expected_content_digest: draft.content_digest,
    }),
  })
}

let resource = (await request<Resource[]>(`/v1/tenants/${tenantId}/resources`))
  .find((candidate) => candidate.display_name === displayName && candidate.lifecycle !== "RETIRED")

if (!resource) {
  resource = await request<Resource>(`/v1/tenants/${tenantId}/resources`, {
    method: "POST",
    body: JSON.stringify({
      display_name: displayName,
      kind: "MCP",
      owner_organization_id: ownerOrganizationId,
      authentication_strategy: "OAUTH",
      environment_id: "pilot",
      version: "v3",
      capabilities,
      enforcement_point_id: "genio-ai-mcp-gateway",
    }),
  })
}

if (
  resource.lifecycle === "DRAFT" &&
  (resource.capabilities.length !== 1 || resource.capabilities[0]?.capability_id !== "mcp.invoke")
) {
  resource = await request<Resource>(`/v1/tenants/${tenantId}/resources/${resource.resource_id}`, {
    method: "PATCH",
    body: JSON.stringify({ capabilities }),
  })
}

let connection = (await request<Connection[]>(`/v1/tenants/${tenantId}/resources/${resource.resource_id}/connections`))
  .find((candidate) => candidate.display_name === "ServiceNow CSM Local")

if (!connection) {
  connection = await request<Connection>(`/v1/tenants/${tenantId}/resources/${resource.resource_id}/connections`, {
    method: "POST",
    body: JSON.stringify({
      display_name: "ServiceNow CSM Local",
      connection_kind: "MCP",
      endpoint: "http://127.0.0.1:19003/mcp",
      mcp_tool_namespace: "servicenow",
      credential_ref: "mcp-service-api-key-local",
      downstream_identity: { mode: "SERVICE", authentication: "API_KEY" },
    }),
  })
}

if (connection.verification_state !== "VERIFIED") {
  connection = await request<Connection>(`/v1/tenants/${tenantId}/resources/${resource.resource_id}/connections/${connection.connection_id}/verify`, {
    method: "POST",
  })
}

if (!tools.every((tool) => connection!.mcp_selected_tools.includes(tool))) {
  await request(`/v1/tenants/${tenantId}/resources/${resource.resource_id}/connections/${connection.connection_id}/mcp-discovery`, {
    method: "POST",
    body: JSON.stringify({ correlation_id: `genio-bot-${randomUUID()}` }),
  })
  let discovery: McpDiscovery | null = null
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    discovery = await request(`/v1/tenants/${tenantId}/resources/${resource.resource_id}/connections/${connection.connection_id}/mcp-discovery/latest`)
    if (discovery?.state === "SUCCEEDED" || discovery?.state === "FAILED") break
    await Bun.sleep(250)
  }
  if (!discovery || discovery.state !== "SUCCEEDED") {
    throw new Error(`MCP_DISCOVERY_FAILED ${discovery?.error_code ?? "TIMEOUT"}`)
  }
  for (const candidate of discovery.candidates.filter((item) => tools.includes(item.tool_name))) {
    await request(`/v1/tenants/${tenantId}/resources/${resource.resource_id}/connections/${connection.connection_id}/mcp-discovery/candidates/${candidate.candidate_id}/decision`, {
      method: "POST",
      body: JSON.stringify({
        expected_revision_digest: candidate.revision_digest,
        state: "PUBLISHED",
      }),
    })
  }
  connection = (await request<Connection[]>(`/v1/tenants/${tenantId}/resources/${resource.resource_id}/connections`))
    .find((candidate) => candidate.connection_id === connection!.connection_id)!
}

const discovery = await request<McpDiscovery>(`/v1/tenants/${tenantId}/resources/${resource.resource_id}/connections/${connection.connection_id}/mcp-discovery/latest`)
if (discovery.state !== "SUCCEEDED") {
  throw new Error(`MCP_DISCOVERY_NOT_READY ${discovery.error_code ?? discovery.state}`)
}
for (const candidate of discovery.candidates.filter((item) => tools.includes(item.tool_name))) {
  await request(`/v1/tenants/${tenantId}/resources/${resource.resource_id}/connections/${connection.connection_id}/mcp-discovery/candidates/${candidate.candidate_id}/decision`, {
    method: "POST",
    body: JSON.stringify({
      expected_revision_digest: candidate.revision_digest,
      state: "PUBLISHED",
    }),
  })
}
const publishedToolCapabilities = discovery.candidates
  .filter((candidate) => tools.includes(candidate.tool_name) && candidate.state === "PUBLISHED")
  .map((candidate) => ({
    capability_id: candidate.capability_id,
    display_name: `Use ${candidate.tool_name}`,
  }))
if (publishedToolCapabilities.length !== tools.length) {
  throw new Error("MCP_PUBLISHED_TOOL_CAPABILITIES_INCOMPLETE")
}

const issuer = `${keycloakOrigin}/realms/genio-one`
for (const capability of capabilities) {
  await ensureResourceCapabilityPolicy(resource.resource_id, capability.capability_id, [
    {
      step_id: "authenticate",
      kind: "AUTHENTICATE",
      phase: "REQUEST",
      implementation: "NATIVE",
      config: {
        schema_version: "genio.one.auth.jwt.v1",
        provider: "keycloak",
        issuer,
        audiences: ["genio-one-product-api"],
        remote_jwks_uri: `${issuer}/protocol/openid-connect/certs`,
        subject_claim: "sub",
        client_claim: "azp",
      },
    },
    {
      step_id: "authorize",
      kind: "AUTHORIZE",
      phase: "REQUEST",
      implementation: "EXT_AUTH",
      depends_on: ["authenticate"],
    },
    {
      step_id: "route",
      kind: "ROUTE",
      phase: "ROUTING",
      implementation: "AIGW_NATIVE",
      depends_on: ["authorize"],
    },
  ])
}

if (resource.lifecycle === "DRAFT") {
  const endpoint = {
    gateway_id: "genio-ai-mcp-gateway",
    hostname: "one.localhost",
    base_path: "/mcp",
    visibility: "PRIVATE",
    dns_management: "EXTERNAL",
    dns_verification: "VERIFIED",
    dns_target: "127.0.0.1",
  }
  await request(`/v1/tenants/${tenantId}/resources/${resource.resource_id}/publication-endpoint`, {
    method: "PUT",
    body: JSON.stringify(endpoint),
  })
}

const existingEntitlements = await request<Entitlement[]>(`/v1/tenants/${tenantId}/entitlements`)
for (const capability of [...capabilities, ...publishedToolCapabilities]) {
  const exists = existingEntitlements.some((entitlement) =>
    entitlement.resource_id === resource!.resource_id &&
    entitlement.capability_id === capability.capability_id &&
    entitlement.subject_id === "person-platform-admin" &&
    entitlement.client_id === "genio-one-bot" &&
    entitlement.state === "ACTIVE")
  if (!exists) {
    await request(`/v1/tenants/${tenantId}/entitlements`, {
      method: "POST",
      body: JSON.stringify({
        subject_id: "person-platform-admin",
        client_id: "genio-one-bot",
        resource_id: resource.resource_id,
        capability_id: capability.capability_id,
      }),
    })
  }
}

if (resource.lifecycle === "DRAFT") {
  const publication = await request<{ request_id: string }>(`/v1/tenants/${tenantId}/resources/${resource.resource_id}/publication-requests`, {
    method: "POST",
    body: JSON.stringify({ requested_by: "person-platform-admin" }),
  })
  resource = await request<Resource>(`/v1/tenants/${tenantId}/resources/${resource.resource_id}/publication-requests/${publication.request_id}/review`, {
    method: "POST",
    body: JSON.stringify({ decision: "APPROVE", reviewer_id: "person-platform-admin" }),
  })
}

console.log(JSON.stringify({
  event: "genio-one-bot.one-mcp.ready",
  resourceId: resource.resource_id,
  connectionId: connection.connection_id,
  lifecycle: resource.lifecycle,
  endpoint: "http://one.localhost:1975/mcp",
  capability: capabilities[0]!.capability_id,
  tools: discovery.candidates
    .filter((candidate) => tools.includes(candidate.tool_name) && candidate.state === "PUBLISHED")
    .map((candidate) => ({ name: `servicenow__${candidate.tool_name}`, capabilityId: candidate.capability_id })),
  correlationId: randomUUID(),
}, null, 2))
