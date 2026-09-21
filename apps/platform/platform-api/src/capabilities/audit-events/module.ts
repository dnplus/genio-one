import type { AccessGroupAuditEvent, AuthorizationAuditEvent, GatewayAuthorizationAuditIngest, PolicyChangeAuditEvent, RuntimePolicyAuditEvent } from "./contract"
import type { SqlTransaction } from "../../persistence/sql-adapter"

export type AuthorizationAuditIngest = GatewayAuthorizationAuditIngest | RuntimePolicyAuditEvent | PolicyChangeAuditEvent | AccessGroupAuditEvent

export interface GatewayAuthorizationAuditStore {
  record(input: { tenantId: string; event: AuthorizationAuditIngest }): Promise<AuthorizationAuditEvent>
  recordInTransaction?(input: { transaction: SqlTransaction; tenantId: string; event: AuthorizationAuditIngest }): Promise<AuthorizationAuditEvent>
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
