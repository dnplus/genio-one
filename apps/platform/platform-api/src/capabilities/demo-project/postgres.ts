import { PlatformApiError } from "../errors"
import type { SqlAdapter } from "../../persistence/sql-adapter"
import type { DemoInstallationRecord, DemoInstallationStore } from "./module"

function record(row: Record<string, unknown>): DemoInstallationRecord {
  const installation = row.installation
  const organizationId = row.organization_id
  const resourceIds = row.resource_ids
  const itemErrors = row.item_errors
  if (
    (installation !== "SKIPPED" && installation !== "INSTALLED") ||
    (organizationId !== null && typeof organizationId !== "string") ||
    !Array.isArray(resourceIds) ||
    resourceIds.some((resourceId) => typeof resourceId !== "string") ||
    !Array.isArray(itemErrors) ||
    itemErrors.some((itemId) => typeof itemId !== "string")
  ) {
    throw new PlatformApiError("DEMO_INSTALLATION_DATA_INVALID", 500)
  }
  return {
    tenant_id: String(row.tenant_id),
    organization_id: organizationId,
    installation,
    resource_ids: resourceIds,
    item_errors: itemErrors,
  }
}

export function createPostgresDemoInstallationStore(sql: SqlAdapter): DemoInstallationStore {
  return {
    async get(input) {
      const result = await sql.query<Record<string, unknown>>(
        `select tenant_id, organization_id, installation, resource_ids, item_errors
           from genio_one_demo_installations
          where tenant_id = $1`,
        [input.tenantId],
      )
      return result.rows[0] ? record(result.rows[0]) : null
    },
    async saveInstalled(input) {
      const resourceIds = [...new Set(input.resourceIds)].sort()
      const itemErrors = [...new Set(input.itemErrors ?? [])].sort()
      const saved = await sql.query<Record<string, unknown>>(
        `insert into genio_one_demo_installations
           (tenant_id, organization_id, installation, resource_ids, item_errors)
         values ($1, $2, 'INSTALLED', $3::text[], $4::text[])
         on conflict (tenant_id) do update
           set organization_id = excluded.organization_id,
               installation = excluded.installation,
               resource_ids = excluded.resource_ids,
               item_errors = excluded.item_errors,
               updated_at = now()
         where genio_one_demo_installations.organization_id is null
            or genio_one_demo_installations.organization_id = excluded.organization_id
         returning tenant_id, organization_id, installation, resource_ids, item_errors`,
        [input.tenantId, input.organizationId, resourceIds, itemErrors],
      )
      if (saved.rows[0]) return record(saved.rows[0])
      const current = await sql.query<Record<string, unknown>>(
        `select tenant_id, organization_id, installation, resource_ids, item_errors
           from genio_one_demo_installations
          where tenant_id = $1`,
        [input.tenantId],
      )
      const existing = current.rows[0] ? record(current.rows[0]) : null
      if (existing?.organization_id && existing.organization_id !== input.organizationId) {
        throw new PlatformApiError("DEMO_PROJECT_ORGANIZATION_CONFLICT", 409)
      }
      throw new PlatformApiError("DEMO_PROJECT_INSTALLATION_WRITE_CONFLICT", 409)
    },
    async skip(input) {
      const saved = await sql.query<Record<string, unknown>>(
        `insert into genio_one_demo_installations
           (tenant_id, organization_id, installation, resource_ids, item_errors)
         values ($1, null, 'SKIPPED', '{}', '{}')
         on conflict (tenant_id) do update
           set organization_id = null,
               installation = 'SKIPPED',
               resource_ids = '{}',
               item_errors = '{}',
               updated_at = now()
         where genio_one_demo_installations.installation = 'SKIPPED'
         returning tenant_id, organization_id, installation, resource_ids, item_errors`,
        [input.tenantId],
      )
      if (saved.rows[0]) return record(saved.rows[0])
      const current = await sql.query<Record<string, unknown>>(
        `select tenant_id, organization_id, installation, resource_ids, item_errors
           from genio_one_demo_installations
          where tenant_id = $1`,
        [input.tenantId],
      )
      const existing = current.rows[0] ? record(current.rows[0]) : null
      if (existing?.installation === "INSTALLED") return existing
      throw new PlatformApiError("DEMO_PROJECT_SKIP_WRITE_CONFLICT", 409)
    },
  }
}
