import type { AuthorizationAuditEvent, GatewayAuthorizationAuditIngest, RuntimePolicyAuditEvent } from "./contract"

export interface GatewayAuthorizationAuditStore {
  record(input: { tenantId: string; event: GatewayAuthorizationAuditIngest | RuntimePolicyAuditEvent }): Promise<AuthorizationAuditEvent>
  findRuntimeAuthorization(input: { tenantId: string; correlationId: string }): Promise<RuntimePolicyAuditEvent | null>
  findRuntimeReport(input: { tenantId: string; correlationId: string }): Promise<RuntimePolicyAuditEvent | null>
  query(input: {
    tenantId: string
    correlationId?: string
    enforcementPointId?: string
    kind?: string
    outcome?: string
    resourceId?: string
    subjectId?: string
    from?: number
    to?: number
    offset: number
    limit: number
  }): Promise<{ events: AuthorizationAuditEvent[]; hasMore: boolean; sourceRevision: number }>
}
