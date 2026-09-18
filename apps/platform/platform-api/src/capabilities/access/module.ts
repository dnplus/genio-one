import type { PrincipalRole } from "../tenancy-auth/contract"
import type { SqlTransaction } from "../../persistence/sql-adapter"
import type {
  AccessNotification,
  AccessRequest,
  CancelAccessRequestInput,
  DecideAccessRequestInput,
  LegacyEntitlement,
  RevokeEntitlementInput,
  RequestAccessInput,
  RequestAccessOutcome,
  SubjectCatalog,
} from "./contract"

export interface AccessActor {
  subjectId: string
  clientId: string
  role: PrincipalRole
  organizationIds: readonly string[]
}

export interface AccessEntitlementReleasePublisher {
  reconcileInTransaction(input: {
    transaction: SqlTransaction
    tenantId: string
    gatewayId: string
    issuedAt: number
  }): Promise<void>
}

export interface AccessGovernanceStore {
  catalog(input: { tenantId: string; actor: AccessActor }): Promise<SubjectCatalog>
  request(input: {
    tenantId: string
    actor: AccessActor
    value: RequestAccessInput
  }): Promise<RequestAccessOutcome>
  listMine(input: { tenantId: string; actor: AccessActor }): Promise<AccessRequest[]>
  listManagement(input: { tenantId: string; actor: AccessActor }): Promise<AccessRequest[]>
  decide(input: {
    tenantId: string
    actor: AccessActor
    requestId: string
    value: DecideAccessRequestInput
  }): Promise<{ request: AccessRequest; entitlement: LegacyEntitlement | null }>
  cancel(input: {
    tenantId: string
    actor: AccessActor
    requestId: string
    value: CancelAccessRequestInput
  }): Promise<AccessRequest>
  revokeEntitlement(input: {
    tenantId: string
    actor: AccessActor
    entitlementId: string
    value: RevokeEntitlementInput
  }): Promise<LegacyEntitlement>
  entitlementsForSubject(input: { tenantId: string; actor: AccessActor }): Promise<LegacyEntitlement[]>
  entitlementsForOwner(input: { tenantId: string; actor: AccessActor }): Promise<LegacyEntitlement[]>
  notifications(input: { tenantId: string; actor: AccessActor }): Promise<AccessNotification[]>
}
