import type {
  GatewayProjection,
  GatewayProjectionRequest,
  GatewayProjectionSource,
} from "./contract"

export interface GatewayProjector {
  compile(input: {
    tenantId: string
    value: GatewayProjectionRequest
  }): Promise<GatewayProjection>
}

export type { GatewayProjectionSource }
