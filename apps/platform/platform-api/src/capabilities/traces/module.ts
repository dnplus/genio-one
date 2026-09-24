import type { TraceSummary, TraceSpansPage, LogInventory, LogQuery } from "./contract"

export interface TraceStore {
  spans(input: { tenantId: string; traceId: string; after?: string; limit?: number }): Promise<TraceSpansPage>
  logs(input: LogQuery): Promise<LogInventory>
  list(input: { tenantId: string; limit: number; before?: number; beforeTraceId?: string; correlationId?: string; search?: string; from?: number; until?: number }): Promise<TraceSummary[]>
}
