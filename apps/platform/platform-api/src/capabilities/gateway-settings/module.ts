import type { SqlTransaction } from "../../persistence/sql-adapter"
import type {
  GatewayDiagnosticSettings,
  UpdateGatewayDiagnosticSettings,
} from "./contract"

export interface GatewayDiagnosticSettingsSource {
  getInTransaction(input: {
    transaction: SqlTransaction
    tenantId: string
    gatewayId: string
  }): Promise<GatewayDiagnosticSettings>
}

export interface GatewayDiagnosticSettingsStore extends GatewayDiagnosticSettingsSource {
  get(input: { tenantId: string; gatewayId: string }): Promise<GatewayDiagnosticSettings>
  update(input: {
    tenantId: string
    gatewayId: string
    updatedBy: string
    value: UpdateGatewayDiagnosticSettings
  }): Promise<GatewayDiagnosticSettings>
}
