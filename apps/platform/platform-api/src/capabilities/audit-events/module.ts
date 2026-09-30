import type { AccessGovernanceAuditEvent, AccessGroupAuditEvent, AuthorizationAuditEvent, AutoGrantActivationAuditEvent, GatewayAuthorizationAuditIngest, PolicyChangeAuditEvent, RuntimePolicyAuditEvent } from "./contract"
import type { SqlTransaction } from "../../persistence/sql-adapter"

export type AuthorizationAuditIngest = GatewayAuthorizationAuditIngest | RuntimePolicyAuditEvent | PolicyChangeAuditEvent | AccessGroupAuditEvent | AccessGovernanceAuditEvent | AutoGrantActivationAuditEvent

export interface GatewayAuthorizationAuditStore {
  record(input: { tenantId: string; event: AuthorizationAuditIngest }): Promise<AuthorizationAuditEvent>
  recordInTransaction?(input: { transaction: SqlTransaction; tenantId: string; event: AuthorizationAuditIngest }): Promise<AuthorizationAuditEvent>
  findById(input: { tenantId: string; auditEventId: string; transaction?: SqlTransaction }): Promise<AuthorizationAuditEvent | null>
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
