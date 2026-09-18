import type { DemoInstallationState } from "./contract"

export interface DemoInstallationRecord {
  tenant_id: string
  organization_id: string | null
  installation: Exclude<DemoInstallationState, "NOT_INSTALLED">
  resource_ids: string[]
  item_errors: string[]
}

export interface DemoInstallationStore {
  get(input: { tenantId: string }): Promise<DemoInstallationRecord | null>
  saveInstalled(input: {
    tenantId: string
    organizationId: string
    resourceIds: readonly string[]
    itemErrors?: readonly string[]
  }): Promise<DemoInstallationRecord>
  skip(input: { tenantId: string }): Promise<DemoInstallationRecord>
}
