import type { BootstrapSubjectInput, CreateSelfServiceAgentInput, CreateSubjectInput, Subject, SuspendSubjectInput, TenantIdentityInventory } from "./contract"

export interface IdentityDirectory {
  inventory(input: { tenantId: string }): Promise<TenantIdentityInventory>
  create(input: { tenantId: string; value: CreateSubjectInput }): Promise<Subject>
  createSelfServiceAgent(input: { tenantId: string; value: CreateSelfServiceAgentInput }): Promise<Subject>
  bootstrap(input: { tenantId: string; subjects: readonly BootstrapSubjectInput[] }): Promise<void>
  /**
   * Stops a Subject authenticating without deleting it, so its activity and
   * entitlement history stay auditable. Reversible by `restore`.
   */
  suspend(input: {
    tenantId: string
    subjectId: string
    suspendedBy: string
    value: SuspendSubjectInput
  }): Promise<Subject>
  restore(input: { tenantId: string; subjectId: string }): Promise<Subject>
  authorizationForSubject(input: { tenantId: string; subjectId: string }): Promise<{
    registered: boolean
    tenant_administrator: boolean
    suspended: boolean
  }>
  subjectForExternalIdentity(input: {
    tenantId: string
    providerId: string
    externalSubjectId: string
  }): Promise<string | null>
  canonicalSubjectId(input: {
    tenantId: string
    subjectId: string
  }): Promise<string | null>
}
