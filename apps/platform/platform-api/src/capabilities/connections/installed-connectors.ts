import { connectorConfigurationToken, validateConnectorConfiguration, type ConnectorConfiguration, type ConnectorKind } from "../../../../../connectors/configuration"
import { PlatformApiError } from "../errors"
import type { DownstreamIdentityProjection } from "./contract"
import type { ResourceConnectionRegistry } from "./module"

export interface InstalledConnectorDeployment {
  configurationKey: string
  endpoints: Partial<Record<ConnectorKind, string>>
}

export interface InstalledConnectorInventory {
  kind: ConnectorKind
  display_name: string
  available: boolean
  resource_id: string
  connection_id: string
  configuration_required: boolean
  lifecycle: "DRAFT" | "ENABLED" | "DISABLED" | "REVOKE_PENDING" | "REVOKED"
}

const INSTALLED_CONNECTOR_IDS: Record<ConnectorKind, { resourceId: string; connectionId: string; displayName: string }> = {
  "servicenow-csm": { resourceId: "servicenow-csm", connectionId: "servicenow-csm", displayName: "ServiceNow CSM" },
  mail2000: { resourceId: "mail2000", connectionId: "mail2000", displayName: "Mail2000" },
}

export function installedConnectorsFromEnvironment(environment: NodeJS.ProcessEnv): InstalledConnectorDeployment | undefined {
  const configurationKey = environment.GENIO_CONNECTOR_CONFIGURATION_KEY
  if (!configurationKey) return undefined
  if (configurationKey.length < 32) throw new Error("CONNECTOR_CONFIGURATION_KEY_REQUIRED")
  return { configurationKey, endpoints: {
    ...(environment.GENIO_CONNECTOR_SERVICENOW_ENDPOINT ? { "servicenow-csm": environment.GENIO_CONNECTOR_SERVICENOW_ENDPOINT } : {}),
    ...(environment.GENIO_CONNECTOR_MAIL2000_ENDPOINT ? { mail2000: environment.GENIO_CONNECTOR_MAIL2000_ENDPOINT } : {}),
  } }
}

export function prepareConnectorConfiguration(value: ConnectorConfiguration, deployment?: InstalledConnectorDeployment) {
  let configuration: ConnectorConfiguration
  try { configuration = validateConnectorConfiguration(value) }
  catch { throw new PlatformApiError("CONNECTOR_CONFIGURATION_INVALID", 422) }
  const base = deployment?.endpoints[configuration.kind]
  if (!base || !deployment) throw new PlatformApiError("CONNECTOR_NOT_INSTALLED", 409)
  const endpoint = `${base.replace(/\/$/, "")}/${connectorConfigurationToken(configuration, deployment.configurationKey)}`
  if (endpoint.length > 2048) throw new PlatformApiError("CONNECTOR_CONFIGURATION_TOO_LONG", 422)
  const origin = configuration.kind === "servicenow-csm" ? new URL(configuration.instance_url).origin : ""
  const downstreamIdentity: DownstreamIdentityProjection = configuration.kind === "servicenow-csm" ? {
    mode: "USER_OAUTH",
    oauth_client: { issuer: origin, authorization_endpoint: `${origin}/oauth_auth.do`, token_endpoint: `${origin}/oauth_token.do`, client_id: configuration.oauth_client_id, scopes: configuration.oauth_scopes },
  } : { mode: "USER_PASSWORD" }
  return { endpoint, connector_configuration: configuration, downstream_identity: downstreamIdentity }
}

export async function listInstalledConnectors(
  deployment?: InstalledConnectorDeployment,
  input?: { tenantId?: string; registry?: Pick<ResourceConnectionRegistry, "list"> },
): Promise<InstalledConnectorInventory[]> {
  return Promise.all(Object.entries(deployment?.endpoints ?? {}).map(async ([kind, endpoint]) => {
    let available = false
    try {
      const health = new URL("/health", endpoint)
      const response = await fetch(health, { redirect: "error", signal: AbortSignal.timeout(3000) })
      const body = await response.json() as { service?: string; status?: string }
      available = response.ok && body.service === `genio-connector-${kind}` && body.status === "ready"
    } catch {}
    const connectorKind = kind as ConnectorKind
    const identity = INSTALLED_CONNECTOR_IDS[connectorKind]
    let connection = null
    if (input?.tenantId && input.registry && identity) {
      try {
        const connections = await input.registry.list({ tenantId: input.tenantId, resourceId: identity.resourceId })
        connection = connections.find((candidate) => candidate.connection_id === identity.connectionId) ?? null
      } catch {}
    }
    return {
      kind: connectorKind,
      display_name: identity?.displayName ?? connectorKind,
      available,
      resource_id: identity?.resourceId ?? connectorKind,
      connection_id: identity?.connectionId ?? connectorKind,
      configuration_required: !connection?.connector_configuration,
      lifecycle: connection?.lifecycle ?? "DISABLED",
    }
  }))
}
