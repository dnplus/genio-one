import type { GatewayMetricsStore } from "./module"

export function createInMemoryGatewayMetricsStore(): GatewayMetricsStore {
  return {
    async summarize({ tenantId, windowSeconds }) {
      return {
        tenant_id: tenantId,
        enforcement_point_id: "AI_GATEWAY",
        window_seconds: windowSeconds,
        sampled_at: null,
        request_count: 0,
        success_count: 0,
        error_count: 0,
        provider_attempt_count: 0,
        average_latency_millis: null,
        request_bytes: 0,
        response_bytes: 0,
      }
    },
  }
}
