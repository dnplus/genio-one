import type { SqlAdapter } from "../../persistence/sql-adapter"
import type {
  PostHogBrowserConfiguration,
  PostHogIntegration,
} from "./contract"
import { requirePostHogBinding, type PostHogIntegrationStore } from "./module"

type Row = Record<string, unknown>

const COLUMNS = `enabled, host, project_id, project_token, configured_by_subject_id,
  case when configured_at is null then null else extract(epoch from configured_at)::bigint end as configured_at`

function nullableText(row: Row, key: string): string | null {
  const value = row[key]
  return value === null || value === undefined ? null : String(value)
}

function nullableNumber(row: Row, key: string): number | null {
  const value = row[key]
  return value === null || value === undefined ? null : Number(value)
}

function integration(row: Row): PostHogIntegration {
  return {
    enabled: row.enabled === true || row.enabled === "true",
    host: nullableText(row, "host") as PostHogIntegration["host"],
    project_id: nullableNumber(row, "project_id"),
    project_token: nullableText(row, "project_token"),
    configured_by: nullableText(row, "configured_by_subject_id"),
    configured_at: nullableNumber(row, "configured_at"),
  }
}

function defaults(): PostHogIntegration {
  return {
    enabled: false,
    host: null,
    project_id: null,
    project_token: null,
    configured_by: null,
    configured_at: null,
  }
}

function browserConfiguration(value: PostHogIntegration): PostHogBrowserConfiguration | null {
  if (!value.enabled || !value.host || !value.project_id || !value.project_token) return null
  return {
    enabled: true,
    host: value.host,
    project_id: value.project_id,
    project_token: value.project_token,
  }
}

export function createPostgresPostHogIntegrationStore(options: {
  sql: SqlAdapter
}): PostHogIntegrationStore {
  const get = async (tenantId: string): Promise<PostHogIntegration> => {
    const result = await options.sql.query<Row>(
      `select ${COLUMNS}
         from genio_one_posthog_integrations
        where tenant_id = $1`,
      [tenantId],
    )
    return result.rows[0] ? integration(result.rows[0]) : defaults()
  }
  return {
    get({ tenantId }) {
      return get(tenantId)
    },
    async listEnabledTenantIds() {
      const result = await options.sql.query<Row>(
        `select tenant_id
           from genio_one_posthog_integrations
          where enabled = true
          order by tenant_id asc`,
      )
      return result.rows.flatMap((row) => {
        const tenantId = row.tenant_id
        return typeof tenantId === "string" && tenantId ? [tenantId] : []
      })
    },
    async update({ tenantId, configuredBySubjectId, value }) {
      requirePostHogBinding(value)
      const result = await options.sql.query<Row>(
        `insert into genio_one_posthog_integrations
           (tenant_id, enabled, host, project_id, project_token, configured_by_subject_id, configured_at)
         values ($1, $2, $3, $4, $5, $6, now())
         on conflict (tenant_id) do update
           set enabled = excluded.enabled,
               host = coalesce(excluded.host, genio_one_posthog_integrations.host),
               project_id = coalesce(excluded.project_id, genio_one_posthog_integrations.project_id),
               project_token = coalesce(excluded.project_token, genio_one_posthog_integrations.project_token),
               configured_by_subject_id = excluded.configured_by_subject_id,
               configured_at = excluded.configured_at
         returning ${COLUMNS}`,
        [
          tenantId,
          value.enabled,
          value.host ?? null,
          value.project_id ?? null,
          value.project_token ?? null,
          configuredBySubjectId,
        ],
      )
      return integration(result.rows[0]!)
    },
    async browserConfiguration({ tenantId }) {
      return browserConfiguration(await get(tenantId))
    },
  }
}
