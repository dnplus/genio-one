import type { ApplicationRegistry } from "../applications/module"
import type { AuthorizationAuditEvent } from "../audit-events/contract"
import type { GatewayAuthorizationAuditStore } from "../audit-events/module"
import type { ModelEntitlementCatalog } from "../entitlements/module"
import type { SecurityFindingJournal } from "./journal"

export function watchEntitlementRevocations(
  catalog: ModelEntitlementCatalog,
  journal: SecurityFindingJournal,
  now: () => number,
): ModelEntitlementCatalog {
  return {
    ...catalog,
    async revoke(input) {
      const revoked = await catalog.revoke(input)
      if (revoked.state === "REVOKED") {
        journal.recordRevocation({
          tenantId: input.tenantId,
          authority: { kind: "ENTITLEMENT", entitlement_id: revoked.entitlement_id },
          revokedAt: now(),
          subjectId: revoked.subject_id,
        })
      }
      return revoked
    },
  }
}

export function watchCredentialGenerationRevocations(
  registry: ApplicationRegistry,
  journal: SecurityFindingJournal,
  now: () => number,
): ApplicationRegistry {
  return {
    ...registry,
    async revokeCredential(input) {
      const credential = await registry.revokeCredential(input)
      if (credential.state === "REVOKED") {
        journal.recordRevocation({
          tenantId: input.tenantId,
          authority: {
            kind: "CREDENTIAL_GENERATION",
            credential_id: credential.credential_id,
            generation: credential.generation,
          },
          revokedAt: credential.revoked_at ?? now(),
          subjectId: credential.application_subject_id,
        })
      }
      return credential
    },
  }
}

function observeDecision(journal: SecurityFindingJournal, event: AuthorizationAuditEvent): void {
  if (event.kind !== "ONE_POLICY_DECISION" || event.entitlement_id == null) return
  journal.observeUse({
    tenantId: event.tenant_id,
    subjectId: event.subject.subject_id,
    occurredAt: event.occurred_at,
    auditEventId: event.audit_event_id,
    correlationId: event.correlation_id,
    upstreamAttempted: event.upstream_attempted,
    authority: { kind: "ENTITLEMENT", entitlement_id: event.entitlement_id },
  })
}

export function watchRevokedAuthorityUse(
  store: GatewayAuthorizationAuditStore,
  journal: SecurityFindingJournal,
): GatewayAuthorizationAuditStore {
  const watched: GatewayAuthorizationAuditStore = {
    ...store,
    async record(input) {
      const event = await store.record(input)
      observeDecision(journal, event)
      return event
    },
  }
  if (store.recordInTransaction) {
    watched.recordInTransaction = async (input) => {
      const event = await store.recordInTransaction!(input)
      observeDecision(journal, event)
      return event
    }
  }
  return watched
}
