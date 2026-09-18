import { PlatformApiError } from "../errors"
import type { DemoInstallationRecord, DemoInstallationStore } from "./module"

export function createInMemoryDemoInstallationStore(): DemoInstallationStore {
  const records = new Map<string, DemoInstallationRecord>()

  return {
    async get(input) {
      return records.get(input.tenantId) ?? null
    },
    async saveInstalled(input) {
      const current = records.get(input.tenantId)
      if (current?.organization_id && current.organization_id !== input.organizationId) {
        throw new PlatformApiError("DEMO_PROJECT_ORGANIZATION_CONFLICT", 409)
      }
      const value: DemoInstallationRecord = {
        tenant_id: input.tenantId,
        organization_id: input.organizationId,
        installation: "INSTALLED",
        resource_ids: [...new Set(input.resourceIds)].sort(),
        item_errors: [...new Set(input.itemErrors ?? [])].sort(),
      }
      records.set(input.tenantId, value)
      return value
    },
    async skip(input) {
      const current = records.get(input.tenantId)
      if (current?.installation === "INSTALLED") return current
      const value: DemoInstallationRecord = {
        tenant_id: input.tenantId,
        organization_id: null,
        installation: "SKIPPED",
        resource_ids: [],
        item_errors: [],
      }
      records.set(input.tenantId, value)
      return value
    },
  }
}
