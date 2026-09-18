import type { GatewayActivityDetail } from "./detail-contract"

export interface GatewayActivityDetailStore {
  get(input: {
    tenantId: string
    correlationId: string
  }): Promise<GatewayActivityDetail | null>
}
