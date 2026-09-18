import { PlatformApiError } from "../errors"
import type { GatewayRegistration } from "./contract"
import type { GatewayRegistrationRepository } from "./module"

export function createInMemoryGatewayRegistrationRepository(options: {
  now?: () => number
} = {}): GatewayRegistrationRepository {
  const values = new Map<string, GatewayRegistration>()
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000))
  const key = (tenantId: string, runtimeId: string) => `${tenantId}\u0000${runtimeId}`
  return {
    async list({ tenantId }) {
      return [...values.values()]
        .filter((value) => value.tenant_id === tenantId)
        .sort((left, right) => right.registered_at - left.registered_at)
        .map((value) => structuredClone(value))
    },
    async get({ tenantId, runtimeId }) {
      const value = values.get(key(tenantId, runtimeId))
      return value ? structuredClone(value) : null
    },
    async create({ tenantId, actorSubjectId, gatewayId, value }) {
      const entryKey = key(tenantId, value.runtime_id)
      if (values.has(entryKey)) throw new PlatformApiError("GATEWAY_ALREADY_REGISTERED", 409)
      const created: GatewayRegistration = {
        tenant_id: tenantId,
        runtime_id: value.runtime_id,
        display_name: value.display_name,
        gateway_id: gatewayId,
        site_id: value.site_id,
        region: value.region,
        labels: structuredClone(value.labels),
        identity_client_id: value.runtime_id,
        state: "PROVISIONING",
        registered_by: actorSubjectId,
        registered_at: now(),
        activated_at: null,
        retired_at: null,
        row_revision: 1,
      }
      values.set(entryKey, created)
      return structuredClone(created)
    },
    async activate({ tenantId, runtimeId }) {
      const entryKey = key(tenantId, runtimeId)
      const current = values.get(entryKey)
      if (!current || current.state !== "PROVISIONING") {
        throw new PlatformApiError("GATEWAY_PROVISIONING_STATE_INVALID", 409)
      }
      const active: GatewayRegistration = {
        ...current,
        state: "ACTIVE",
        activated_at: now(),
        row_revision: current.row_revision + 1,
      }
      values.set(entryKey, active)
      return structuredClone(active)
    },
    async retire({ tenantId, runtimeId }) {
      const entryKey = key(tenantId, runtimeId)
      const current = values.get(entryKey)
      if (!current) throw new PlatformApiError("GATEWAY_NOT_FOUND", 404)
      if (current.state === "RETIRED") return structuredClone(current)
      const retired: GatewayRegistration = {
        ...current,
        state: "RETIRED",
        retired_at: now(),
        row_revision: current.row_revision + 1,
      }
      values.set(entryKey, retired)
      return structuredClone(retired)
    },
  }
}
