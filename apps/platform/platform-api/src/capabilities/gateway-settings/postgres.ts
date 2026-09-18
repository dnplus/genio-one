import type { SqlAdapter, SqlTransaction } from "../../persistence/sql-adapter"
import type { ResourceLifecycleReleasePublisher } from "../resources/module"
import type { GatewayDiagnosticSettings } from "./contract"
import type {
  GatewayDiagnosticSettingsSource,
  GatewayDiagnosticSettingsStore,
} from "./module"

type Row = Record<string, unknown>

const COLUMNS = `tenant_id, gateway_id, capture_message_content, row_revision,
  extract(epoch from updated_at)::bigint as updated_at`

function mapSettings(row: Row): GatewayDiagnosticSettings {
  return {
    tenant_id: String(row.tenant_id),
    gateway_id: String(row.gateway_id),
    capture_message_content: row.capture_message_content === true || row.capture_message_content === "true",
    row_revision: Number(row.row_revision),
    updated_at: Number(row.updated_at),
  }
}

function defaults(tenantId: string, gatewayId: string): GatewayDiagnosticSettings {
  return {
    tenant_id: tenantId,
    gateway_id: gatewayId,
    capture_message_content: true,
    row_revision: 1,
    updated_at: 0,
  }
}

async function get(
  executor: SqlAdapter | SqlTransaction,
  tenantId: string,
  gatewayId: string,
): Promise<GatewayDiagnosticSettings> {
  const result = await executor.query<Row>(
    `select ${COLUMNS}
       from genio_one_gateway_diagnostic_settings
      where tenant_id = $1 and gateway_id = $2`,
    [tenantId, gatewayId],
  )
  return result.rows[0] ? mapSettings(result.rows[0]) : defaults(tenantId, gatewayId)
}

export function createPostgresGatewayDiagnosticSettingsSource(): GatewayDiagnosticSettingsSource {
  return {
    getInTransaction({ transaction, tenantId, gatewayId }) {
      return get(transaction, tenantId, gatewayId)
    },
  }
}

export function createPostgresGatewayDiagnosticSettingsStore(options: {
  sql: SqlAdapter
  releasePublisher: ResourceLifecycleReleasePublisher
  now?: () => number
}): GatewayDiagnosticSettingsStore {
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000))
  return {
    get({ tenantId, gatewayId }) {
      return get(options.sql, tenantId, gatewayId)
    },
    getInTransaction({ transaction, tenantId, gatewayId }) {
      return get(transaction, tenantId, gatewayId)
    },
    async update({ tenantId, gatewayId, updatedBy, value }) {
      return options.sql.transaction(async (transaction) => {
        const result = await transaction.query<Row>(
          `insert into genio_one_gateway_diagnostic_settings
             (tenant_id, gateway_id, capture_message_content, updated_by_subject_id)
           values ($1, $2, $3, $4)
           on conflict (tenant_id, gateway_id) do update
             set capture_message_content = excluded.capture_message_content,
                 updated_by_subject_id = excluded.updated_by_subject_id,
                 row_revision = genio_one_gateway_diagnostic_settings.row_revision + 1,
                 updated_at = now()
           returning ${COLUMNS}`,
          [tenantId, gatewayId, value.capture_message_content, updatedBy],
        )
        await options.releasePublisher.reconcileInTransaction({
          transaction,
          tenantId,
          gatewayId,
          issuedAt: now(),
        })
        return mapSettings(result.rows[0]!)
      })
    },
  }
}
