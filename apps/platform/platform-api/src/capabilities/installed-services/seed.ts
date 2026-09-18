import type { InstalledConnectorDeployment } from "../connections/installed-connectors"
import { seedDiscoveryMcp } from "../discovery-mcp/seed"
import type { InstallationServiceKind } from "../resources/contract"
import type { SqlAdapter, SqlTransaction } from "../../persistence/sql-adapter"

export interface InstalledServicesSeedOptions {
  connectorDeployment?: InstalledConnectorDeployment
  publicOrigin?: string
  genioBotEndpoint?: string
  enforcementPointId?: string
  botHealthCheck?: (endpoint: string) => Promise<boolean>
}

export interface InstalledServiceSeedResult {
  service_kind: InstallationServiceKind
  resource_id: string
  connection_id: string
}

type InstalledServiceDefinition = {
  serviceKind: InstallationServiceKind
  resourceId: string
  connectionId: string
  displayName: string
  resourceKind: "MCP" | "SAAS"
  connectionKind: "MCP" | "API"
  endpoint?: string
  namespace?: string
  capabilities: readonly { capability_id: string; display_name: string }[]
  downstreamIdentity: Record<string, unknown>
  status: "DRAFT" | "READY"
  lifecycle: "DRAFT" | "ENABLED" | "DISABLED"
  verificationState: "UNVERIFIED" | "VERIFIED"
  healthState: "UNKNOWN" | "HEALTHY"
}

const SERVICENOW_CAPABILITIES = [
  { capability_id: "mcp.invoke", display_name: "ServiceNow CSM" },
] as const

const MAIL2000_CAPABILITIES = [
  { capability_id: "mcp.invoke", display_name: "Mail2000" },
] as const

const GENIO_BOT_CAPABILITIES = [
  { capability_id: "personal_bot.use", display_name: "Use Genio Bot" },
  { capability_id: "personal_bot.computer_use", display_name: "Use Genio Bot computer runtime" },
] as const

function endpoint(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined
  const parsed = new URL(value.trim())
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("INSTALLED_SERVICE_ENDPOINT_INVALID")
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("INSTALLED_SERVICE_ENDPOINT_INVALID")
  return parsed.toString().replace(/\/$/, "")
}

export async function isGenioBotHealthy(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/healthz", endpoint), {
      redirect: "error",
      signal: AbortSignal.timeout(3_000),
    })
    const body = await response.json() as { status?: string; component?: string }
    return response.ok && body.status === "ok" && body.component === "genio-one-bot"
  } catch {
    return false
  }
}

async function installedServiceDefinitions(options: InstalledServicesSeedOptions): Promise<InstalledServiceDefinition[]> {
  const definitions: InstalledServiceDefinition[] = []
  const serviceNowEndpoint = endpoint(options.connectorDeployment?.endpoints["servicenow-csm"])
  if (serviceNowEndpoint) definitions.push({
    serviceKind: "SERVICENOW_CSM",
    resourceId: "servicenow-csm",
    connectionId: "servicenow-csm",
    displayName: "ServiceNow CSM",
    resourceKind: "MCP",
    connectionKind: "MCP",
    endpoint: serviceNowEndpoint,
    namespace: "servicenow",
    capabilities: SERVICENOW_CAPABILITIES,
    downstreamIdentity: { mode: "USER_OAUTH" },
    status: "DRAFT",
    lifecycle: "DISABLED",
    verificationState: "UNVERIFIED",
    healthState: "UNKNOWN",
  })
  const mailEndpoint = endpoint(options.connectorDeployment?.endpoints.mail2000)
  if (mailEndpoint) definitions.push({
    serviceKind: "MAIL2000",
    resourceId: "mail2000",
    connectionId: "mail2000",
    displayName: "Mail2000",
    resourceKind: "MCP",
    connectionKind: "MCP",
    endpoint: mailEndpoint,
    namespace: "mail2000",
    capabilities: MAIL2000_CAPABILITIES,
    downstreamIdentity: { mode: "USER_PASSWORD" },
    status: "DRAFT",
    lifecycle: "DISABLED",
    verificationState: "UNVERIFIED",
    healthState: "UNKNOWN",
  })
  const botEndpoint = endpoint(options.genioBotEndpoint)
  const botHealthy = botEndpoint
    ? await (options.botHealthCheck ?? isGenioBotHealthy)(botEndpoint)
    : false
  if (botEndpoint) definitions.push({
    serviceKind: "GENIO_BOT",
    resourceId: "genio.personal-bot",
    connectionId: "genio.personal-bot",
    displayName: "Genio Bot",
    resourceKind: "SAAS",
    connectionKind: "API",
    endpoint: botEndpoint,
    capabilities: GENIO_BOT_CAPABILITIES,
    downstreamIdentity: { mode: "NONE" },
    status: botHealthy ? "READY" : "DRAFT",
    lifecycle: botHealthy ? "ENABLED" : "DISABLED",
    verificationState: botHealthy ? "VERIFIED" : "UNVERIFIED",
    healthState: botHealthy ? "HEALTHY" : "UNKNOWN",
  })
  return definitions
}

async function ensureSystemOrganization(transaction: SqlTransaction, tenantId: string) {
  await transaction.query(`insert into genio_one_organizations
    (tenant_id, organization_id, display_name, slug)
    values ($1, 'genio-one-system', 'GenioOne', 'genio-one-system')
    on conflict (tenant_id, organization_id) do nothing`, [tenantId])
}

async function seedService(
  transaction: SqlTransaction,
  tenantId: string,
  definition: InstalledServiceDefinition,
  enforcementPointId: string,
) {
  const resource = await transaction.query<Record<string, unknown>>(`insert into genio_one_resources
    (tenant_id, resource_id, display_name, kind, owner_organization_id,
     authentication_strategy, environment_id, version, lifecycle,
     operational_state, capabilities, enforcement_point_id,
     installation_owned, service_kind, documentation)
    values ($1, $2, $3, $4, 'genio-one-system', 'NONE', 'platform', '1.0.0', $5,
            'UNKNOWN', $6::text::jsonb, $7, true, $8, $9)
    on conflict (tenant_id, resource_id) do nothing
    returning resource_id`, [
    tenantId,
    definition.resourceId,
    definition.displayName,
    definition.resourceKind,
    "DRAFT",
    JSON.stringify(definition.capabilities),
    enforcementPointId,
    definition.serviceKind,
    `${definition.displayName} 是 GenioOne 安裝提供的固定服務。設定與授權由 Platform 管理。`,
  ])
  if (!resource.rows[0]) {
    const existing = await transaction.query<Record<string, unknown>>(`select installation_owned, service_kind
      from genio_one_resources where tenant_id = $1 and resource_id = $2`, [tenantId, definition.resourceId])
    if (existing.rows[0]?.installation_owned !== true || existing.rows[0]?.service_kind !== definition.serviceKind) {
      throw new Error(`INSTALLED_SERVICE_ID_CONFLICT:${definition.resourceId}`)
    }
  }
  const existing = await transaction.query<Record<string, unknown>>(`select connection_id, endpoint, connector_configuration
    from genio_one_resource_connections
    where tenant_id = $1 and resource_id = $2 and connection_id = $3`, [tenantId, definition.resourceId, definition.connectionId])
  if (!existing.rows[0]) {
    await transaction.query(`insert into genio_one_resource_connections
      (tenant_id, resource_id, connection_id, display_name, connection_kind,
       provider_type, provider_profile_id, endpoint, mcp_tool_namespace,
       downstream_identity, request_mapping, status, lifecycle, verification_state, health_state,
       health_observed_at, health_source_revision, mcp_selected_tools)
      values ($1, $2, $3, $4, $5, null, null, $6, $7, $8::text::jsonb,
              $9::text::jsonb, $10, $11, $12, $13,
              case when $13 = 'HEALTHY' then now() else null end,
              case when $13 = 'HEALTHY' then 1 else null end, '{}')`, [
      tenantId,
      definition.resourceId,
      definition.connectionId,
      definition.displayName,
      definition.connectionKind,
      definition.endpoint,
      definition.namespace ?? null,
      JSON.stringify(definition.downstreamIdentity),
      definition.connectionKind === "API"
        ? JSON.stringify({ default_action: "PASSTHROUGH", rules: [] })
        : null,
      definition.status,
      definition.lifecycle,
      definition.verificationState,
      definition.healthState,
    ])
  } else if (existing.rows[0].connector_configuration === null && existing.rows[0].endpoint !== definition.endpoint) {
    await transaction.query(`update genio_one_resource_connections
      set endpoint = $4, configuration_revision = configuration_revision + 1,
          row_revision = row_revision + 1, updated_at = now()
      where tenant_id = $1 and resource_id = $2 and connection_id = $3`, [
      tenantId,
      definition.resourceId,
      definition.connectionId,
      definition.endpoint,
    ])
  }
  return {
    service_kind: definition.serviceKind,
    resource_id: definition.resourceId,
    connection_id: definition.connectionId,
  } satisfies InstalledServiceSeedResult
}

export async function seedInstalledServices(
  sql: SqlAdapter,
  tenantId: string,
  options: InstalledServicesSeedOptions = {},
): Promise<InstalledServiceSeedResult[]> {
  const results: InstalledServiceSeedResult[] = []
  if (options.publicOrigin) {
    await seedDiscoveryMcp(sql, tenantId, options.publicOrigin)
    results.push({
      service_kind: "DISCOVERY",
      resource_id: "genio-one-discovery",
      connection_id: "genio-one-discovery",
    })
  }
  const enforcementPointId = options.enforcementPointId?.trim() || "PLATFORM"
  for (const definition of await installedServiceDefinitions(options)) {
    const result = await sql.transaction(async (transaction) => {
      await ensureSystemOrganization(transaction, tenantId)
      return seedService(transaction, tenantId, definition, enforcementPointId)
    })
    results.push(result)
  }
  return results
}

export const INSTALLED_SERVICE_RESOURCE_IDS = {
  SERVICENOW_CSM: "servicenow-csm",
  MAIL2000: "mail2000",
  DISCOVERY: "genio-one-discovery",
  GENIO_BOT: "genio.personal-bot",
} as const
