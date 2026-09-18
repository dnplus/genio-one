import type { AiUsageDashboard, ConsoleTimeZone, GatewayActivityEvent, GatewayActivityIngest, GatewayActivityTrendPoint, OutcomeAttribution, OutcomeAttributionInput, RoutingAttemptEvent, RoutingAttemptIngest } from "./contract"
import type { GatewayActivityDetailStore } from "./detail-module"

export interface GatewayActivityStore {
  record(input: { tenantId: string; event: GatewayActivityIngest }): Promise<GatewayActivityEvent>
  get?(input: { tenantId: string; correlationId: string }): Promise<GatewayActivityEvent | null>
  recordAttempt?(input: { tenantId: string; event: RoutingAttemptIngest }): Promise<RoutingAttemptEvent>
  listAttempts?(input: { tenantId: string; correlationId: string }): Promise<RoutingAttemptEvent[]>
  list(input: { tenantId: string; limit: number }): Promise<GatewayActivityEvent[]>
  listSession?(input: { tenantId: string; sessionId: string }): Promise<GatewayActivityEvent[]>
  recordOutcome?(input: { tenantId: string; correlationId: string; recordedBySubjectId: string; value: OutcomeAttributionInput }): Promise<OutcomeAttribution>
  listOutcomes?(input: { tenantId: string; correlationId: string }): Promise<OutcomeAttribution[]>
  trend(input: { tenantId: string; from: number; to: number; timeZone: ConsoleTimeZone }): Promise<GatewayActivityTrendPoint[]>
  summarize(input: { tenantId: string; from: number; to: number }): Promise<AiUsageDashboard>
}

export interface GatewayActivityMaterializer {
  refresh(input: { tenantId: string }): Promise<void>
}

export type { GatewayActivityDetailStore }
