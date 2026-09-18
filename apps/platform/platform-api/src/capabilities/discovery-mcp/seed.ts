import { DISCOVERY_TOOLS } from "../../../../../connectors/discovery/server"
import type { SqlAdapter } from "../../persistence/sql-adapter"

export async function seedDiscoveryMcp(sql: SqlAdapter, tenantId: string, publicOrigin: string) {
  const origin = new URL(publicOrigin)
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password) throw new Error("DISCOVERY_PUBLIC_ORIGIN_INVALID")
  const endpoint = new URL(`/v1/tenants/${encodeURIComponent(tenantId)}/discovery/mcp`, origin).toString()
  await sql.transaction(async (transaction) => {
    await transaction.query(`insert into genio_one_organizations (tenant_id, organization_id, display_name, slug)
      values ($1, 'genio-one-system', 'GenioOne', 'genio-one-system') on conflict (tenant_id, organization_id) do nothing`, [tenantId])
    await transaction.query(`insert into genio_one_resources
      (tenant_id, resource_id, display_name, kind, owner_organization_id, authentication_strategy, environment_id, version, lifecycle, operational_state, capabilities, enforcement_point_id, builtin_service, installation_owned, service_kind, documentation)
      values ($1, 'genio-one-discovery', 'GenioOne Discovery', 'MCP', 'genio-one-system', 'OAUTH', 'platform', '1.0.0', 'PUBLISHED', 'HEALTHY', $2::text::jsonb, 'PLATFORM', 'DISCOVERY', true, 'DISCOVERY', $3)
      on conflict (tenant_id, resource_id) do update set installation_owned = true, service_kind = 'DISCOVERY'
      where genio_one_resources.builtin_service = 'DISCOVERY'`, [tenantId, JSON.stringify(DISCOVERY_TOOLS), 'GenioOne 內建的唯讀探索服務，隨平台安裝及更新。使用登入者身分查詢 Catalog，僅回傳可見資源、能力與存取狀態。'])
    const resource = await transaction.query(`select builtin_service from genio_one_resources where tenant_id = $1 and resource_id = 'genio-one-discovery'`, [tenantId])
    if (resource.rows[0]?.builtin_service !== "DISCOVERY") throw new Error("DISCOVERY_RESOURCE_ID_CONFLICT")
    await transaction.query(`insert into genio_one_resource_connections
      (tenant_id, resource_id, connection_id, display_name, connection_kind, provider_type, provider_profile_id, endpoint, mcp_tool_namespace, downstream_identity, status, lifecycle, verification_state, health_state, mcp_selected_tools)
      values ($1, 'genio-one-discovery', 'genio-one-discovery', 'GenioOne Discovery', 'MCP', null, null, $2, 'genio-discovery', '{"mode":"NONE"}'::jsonb, 'READY', 'ENABLED', 'VERIFIED', 'HEALTHY', $3::text[])
      on conflict (tenant_id, resource_id, connection_id) do update set endpoint = excluded.endpoint, downstream_identity = excluded.downstream_identity, mcp_tool_namespace = excluded.mcp_tool_namespace, row_revision = genio_one_resource_connections.row_revision + 1,
        configuration_revision = genio_one_resource_connections.configuration_revision + 1, updated_at = now()
      where genio_one_resource_connections.endpoint is distinct from excluded.endpoint
        or genio_one_resource_connections.downstream_identity is distinct from excluded.downstream_identity
        or genio_one_resource_connections.mcp_tool_namespace is distinct from excluded.mcp_tool_namespace`, [tenantId, endpoint, DISCOVERY_TOOLS.map((tool) => tool.capability_id)])
  })
}
