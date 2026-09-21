import { isDeepStrictEqual } from "node:util"
import { readFile } from "node:fs/promises"
import { CommonInstallConfiguration, ensureResourceCapabilityPolicy, managementApi, type Api, type CommonInstallConfig } from "../install"

interface Resource {
  resource_id: string
  display_name: string
  kind: string
  owner_organization_id: string
  environment_id: string
  enforcement_point_id: string
  lifecycle: string
  publication_endpoint?: { hostname: string; base_path: string; visibility: string } | null
  publication_request?: { request_id: string; state: string; publication_state?: string } | null
}

export async function installBreezeAsr(config: CommonInstallConfig, api: Api) {
  const base = `/v1/tenants/${encodeURIComponent(config.tenantId)}`
  const json = (value: unknown, method = "POST") => ({ method, body: JSON.stringify(value) })
  const matches = (await api<Resource[]>(`${base}/resources`)).filter((resource) => resource.display_name === "Breeze ASR" && resource.lifecycle !== "RETIRED")
  if (matches.length > 1) throw new Error("ASR_RESOURCE_AMBIGUOUS")
  let resource = matches[0]
  if (resource && (resource.kind !== "LLM" || resource.owner_organization_id !== config.ownerOrganizationId || resource.environment_id !== config.environmentId || resource.enforcement_point_id !== config.gatewayId)) throw new Error("ASR_RESOURCE_CONFLICT")
  resource ??= await api<Resource>(`${base}/resources`, json({
    display_name: "Breeze ASR", kind: "LLM", owner_organization_id: config.ownerOrganizationId,
    authentication_strategy: "OAUTH", environment_id: config.environmentId, version: "0.1.0",
    capabilities: [{ capability_id: "model.invoke", display_name: "語音轉文字" }], enforcement_point_id: config.gatewayId,
  }))
  const path = `${base}/resources/${encodeURIComponent(resource.resource_id)}`
  const connections = await api<Array<{ connection_id: string; endpoint: string; provider_type: string; verification_state: string }>>(`${path}/connections`)
  if (connections.length > 1) throw new Error("ASR_CONNECTION_AMBIGUOUS")
  let connection = connections[0]
  if (connection && (connection.endpoint !== config.upstreamEndpoint || connection.provider_type !== "GENERIC_OPENAI_COMPATIBLE")) throw new Error("ASR_CONNECTION_CONFLICT")
  connection ??= await api<typeof connections[number]>(`${path}/connections`, json({ display_name: "Breeze ASR 本機推論", connection_kind: "LLM", provider_type: "GENERIC_OPENAI_COMPATIBLE", endpoint: config.upstreamEndpoint }))
  if (connection.verification_state !== "VERIFIED") await api(`${path}/connections/${encodeURIComponent(connection.connection_id)}/verify`, { method: "POST" })
  const models = await api<Array<{ model_id: string; model_name: string; capabilities: string[] }>>(`${base}/models?resource_id=${encodeURIComponent(resource.resource_id)}`)
  if (models.some((model) => model.model_name !== "breeze-asr") || models.length > 1) throw new Error("ASR_MODEL_CONFLICT")
  let model = models[0]
  if (model && !model.capabilities.includes("TRANSCRIPTION")) throw new Error("ASR_MODEL_CAPABILITY_CONFLICT")
  model ??= await api<typeof models[number]>(`${path}/models`, json({
    model_name: "breeze-asr", display_name: "Breeze ASR 25", visibility: "PUBLIC", capabilities: ["TRANSCRIPTION"],
    mappings: [{ connection_id: connection.connection_id, provider_model: "breeze-asr" }],
  }))
  const mappings = await api<Array<{ public_model_id: string; connection_id: string; provider_model: string }>>(`${path}/model-mappings`)
  if (mappings.length !== 1 || mappings[0]?.public_model_id !== model.model_id || mappings[0]?.connection_id !== connection.connection_id || mappings[0]?.provider_model !== "breeze-asr") throw new Error("ASR_MODEL_MAPPING_CONFLICT")
  if (resource.publication_endpoint && (resource.publication_endpoint.hostname !== config.hostname || resource.publication_endpoint.base_path !== config.basePath || resource.publication_endpoint.visibility !== "PUBLIC")) throw new Error("ASR_PUBLICATION_CONFLICT")
  const policyPath = `${path}/capabilities/model.invoke`
  const routing = { routing_revision: 1, mode: "DETERMINISTIC", candidate_public_model_ids: [model.model_id], default_public_model_id: model.model_id, session_lease_seconds: null }
  const issuer = config.identityIssuer.replace(/\/$/, "")
  const steps = [
    { step_id: "authenticate", kind: "AUTHENTICATE", phase: "REQUEST", implementation: "NATIVE", config: { schema_version: "genio.one.auth.jwt.v1", provider: "keycloak", issuer, audiences: [config.identityAudience], remote_jwks_uri: `${issuer}/protocol/openid-connect/certs`, subject_claim: "sub", client_claim: "azp" } },
    { step_id: "authorize", kind: "AUTHORIZE", phase: "REQUEST", implementation: "EXT_AUTH", depends_on: ["authenticate"] },
    { step_id: "route", kind: "ROUTE", phase: "ROUTING", implementation: "AIGW_NATIVE", depends_on: ["authorize"] },
  ]
  try {
    const existing = await api<Record<string, unknown>>(`${policyPath}/model-routing-policy`)
    if (Object.entries(routing).some(([key, value]) => !isDeepStrictEqual(existing[key], value)) || (Array.isArray(existing.context_requirements) && existing.context_requirements.length)) throw new Error("ASR_ROUTING_POLICY_CONFLICT")
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("STANDARD_INSTALL_HTTP_404:") || resource.lifecycle !== "DRAFT") throw error
    await api(`${policyPath}/model-routing-policy`, json(routing, "PUT"))
  }
  await ensureResourceCapabilityPolicy(api, {
    base,
    resourceId: resource.resource_id,
    capabilityId: "model.invoke",
    steps,
  })
  if (resource.lifecycle !== "PUBLISHED") {
    if (resource.lifecycle !== "DRAFT") throw new Error("ASR_RESOURCE_NOT_DRAFT")
    if (!resource.publication_endpoint) await api(`${path}/publication-endpoint`, json({ gateway_id: config.gatewayId, hostname: config.hostname, base_path: config.basePath, visibility: "PUBLIC", dns_management: "EXTERNAL", dns_verification: "VERIFIED", dns_target: config.dnsTarget }, "PUT"))
    const publication = resource.publication_request?.state === "PENDING" ? resource.publication_request : await api<{ request_id: string }>(`${path}/publication-requests`, json({}))
    await api(`${path}/publication-requests/${encodeURIComponent(publication.request_id)}/review`, json({ decision: "APPROVE" }))
    resource = await api<Resource>(path)
  }
  if (resource.lifecycle !== "PUBLISHED") throw new Error("ASR_PUBLICATION_INCOMPLETE")
  return { resourceId: resource.resource_id, connectionId: connection.connection_id, model: "breeze-asr", publicationState: resource.publication_request?.publication_state ?? "UNVERIFIED" }
}

if (import.meta.main) {
  const file = process.argv[2]
  if (!file) throw new Error("Usage: bun breeze-asr/install.ts <configuration.json>")
  const token = process.env.GENIO_ONE_ACCESS_TOKEN?.trim()
  if (!token) throw new Error("GENIO_ONE_ACCESS_TOKEN_REQUIRED")
  const config = CommonInstallConfiguration.parse(JSON.parse(await readFile(file, "utf8")))
  const response = await fetch(`${config.upstreamEndpoint.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(5000), redirect: "error" })
  if (!response.ok || !(await response.json() as { data?: Array<{ id: string }> }).data?.some((model) => model.id === "breeze-asr")) throw new Error("BREEZE_ASR_MODEL_NOT_READY")
  console.log(JSON.stringify(await installBreezeAsr(config, managementApi(config.platformOrigin, token)), null, 2))
}
