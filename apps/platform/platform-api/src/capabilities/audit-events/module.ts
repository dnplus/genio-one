import type { AccessGovernanceAuditEvent, AccessGroupAuditEvent, AuthenticationAttemptReceipt, AuthorizationAuditEvent, AutoGrantActivationAuditEvent, GatewayAuthorizationAuditIngest, GatewayAuthenticationFailureAuditIngest, ManagementAuthorizationAuditEvent, PolicyChangeAuditEvent, RuntimePolicyAuditEvent } from "./contract"
import type { SqlTransaction } from "../../persistence/sql-adapter"

export type AuthorizationAuditIngest = GatewayAuthorizationAuditIngest | GatewayAuthenticationFailureAuditIngest | RuntimePolicyAuditEvent | PolicyChangeAuditEvent | ManagementAuthorizationAuditEvent | AccessGroupAuditEvent | AccessGovernanceAuditEvent | AutoGrantActivationAuditEvent

export type AuthorizationAuditQueryInput = {
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
}

export interface GatewayAuthorizationAuditStore {
  record(input: { tenantId: string; event: AuthorizationAuditIngest }): Promise<AuthorizationAuditEvent>
  recordInTransaction?(input: { transaction: SqlTransaction; tenantId: string; event: AuthorizationAuditIngest }): Promise<AuthorizationAuditEvent>
  recordAuthenticationAttempt(input: { receipt: AuthenticationAttemptReceipt }): Promise<AuthenticationAttemptReceipt>
  queryAuthenticationAttempts?(input: {
    correlationId?: string
    code?: string
    outcome?: AuthenticationAttemptReceipt["outcome"]
    offset: number
    limit: number
  }): Promise<{ receipts: AuthenticationAttemptReceipt[]; hasMore: boolean; sourceRevision: number }>
  findById(input: { tenantId: string; auditEventId: string; transaction?: SqlTransaction }): Promise<AuthorizationAuditEvent | null>
  findRuntimeAuthorization(input: { tenantId: string; correlationId: string }): Promise<RuntimePolicyAuditEvent | null>
  findRuntimeReport(input: { tenantId: string; correlationId: string }): Promise<RuntimePolicyAuditEvent | null>
  query(input: AuthorizationAuditQueryInput): Promise<{ events: AuthorizationAuditEvent[]; hasMore: boolean; sourceRevision: number }>
}

export type PolicyAuthorizationAuditStore = Omit<GatewayAuthorizationAuditStore, "query"> & {
  query(input: AuthorizationAuditQueryInput & { kind: "POLICY_CHANGE" }): Promise<{
    events: PolicyChangeAuditEvent[]
    hasMore: boolean
    sourceRevision: number
  }>
  query(input: AuthorizationAuditQueryInput): Promise<{
    events: AuthorizationAuditEvent[]
    hasMore: boolean
    sourceRevision: number
  }>
}
