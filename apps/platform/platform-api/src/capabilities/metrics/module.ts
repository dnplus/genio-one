import type { GatewayMetricsSummary } from "./contract"

export interface GatewayMetricsStore {
  summarize(input: { tenantId: string; windowSeconds: number }): Promise<GatewayMetricsSummary>
}
