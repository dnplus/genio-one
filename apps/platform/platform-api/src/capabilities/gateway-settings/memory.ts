import type { GatewayDiagnosticSettings } from "./contract"
import type { GatewayDiagnosticSettingsStore } from "./module"

export function createInMemoryGatewayDiagnosticSettingsStore(options: {
  now?: () => number
} = {}): GatewayDiagnosticSettingsStore {
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000))
  const values = new Map<string, GatewayDiagnosticSettings>()
  const key = (tenantId: string, gatewayId: string) => `${tenantId}\u0000${gatewayId}`
  const get = (tenantId: string, gatewayId: string): GatewayDiagnosticSettings =>
    structuredClone(values.get(key(tenantId, gatewayId)) ?? {
      tenant_id: tenantId,
      gateway_id: gatewayId,
      capture_message_content: true,
      row_revision: 1,
      updated_at: 0,
    })
  return {
    async get({ tenantId, gatewayId }) {
      return get(tenantId, gatewayId)
    },
    async getInTransaction({ tenantId, gatewayId }) {
      return get(tenantId, gatewayId)
    },
    async update({ tenantId, gatewayId, value }) {
      const current = get(tenantId, gatewayId)
      const next = {
        ...current,
        capture_message_content: value.capture_message_content,
        row_revision: current.updated_at === 0 ? 1 : current.row_revision + 1,
        updated_at: now(),
      }
      values.set(key(tenantId, gatewayId), next)
      return structuredClone(next)
    },
  }
}
