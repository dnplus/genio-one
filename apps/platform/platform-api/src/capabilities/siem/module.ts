import type { ConfigureSiemDestinationInput, SiemDelivery, SiemDestination } from "./contract"

export interface SiemForwarder {
  getDestination(input: { tenantId: string }): Promise<SiemDestination | null>
  configure(input: {
    tenantId: string
    configuredBySubjectId: string
    value: ConfigureSiemDestinationInput
  }): Promise<SiemDestination>
  listDeliveries(input: { tenantId: string; limit: number }): Promise<SiemDelivery[]>
  deliverDue(input?: { limit?: number }): Promise<number>
}
