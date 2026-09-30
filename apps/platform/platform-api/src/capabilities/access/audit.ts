import { createHash } from "node:crypto"

import { Type, type Static } from "typebox"
import { canonicalJson } from "@genioone/protocol/canonical"

import { PlatformApiError } from "../errors"
import type { GatewayAuthorizationAuditStore } from "../audit-events/module"
import type { SqlTransaction } from "../../persistence/sql-adapter"
import type { AutoGrantActivationAuditEvent } from "./contract"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })
const NullableIdentifier = Type.Union([Identifier, Type.Null()])
const EvidenceSchema = Type.Object({
  subject_id: Identifier,
  evidence_level: Type.Literal("VERIFIED"),
}, { additionalProperties: false })
const ActingClientSchema = Type.Object({
  acting_client_id: Identifier,
  evidence_level: Type.Literal("VERIFIED"),
}, { additionalProperties: false })

export const AccessGovernanceAuditOperationSchema = Type.Union([
  Type.Literal("CREATED"),
  Type.Literal("DENY"),
  Type.Literal("APPROVE"),
  Type.Literal("REVOKE"),
  Type.Literal("CANCEL"),
])

export const AccessGovernanceAuditEventSchema = Type.Object({
  tenant_id: Identifier,
  audit_event_id: Identifier,
  correlation_id: Identifier,
  kind: Type.Literal("ACCESS_GOVERNANCE_CHANGE"),
  outcome: Type.Literal("SUCCESS"),
  subject: EvidenceSchema,
  actor_subject: EvidenceSchema,
  acting_client: ActingClientSchema,
  resource_id: Identifier,
  capability_id: Identifier,
  access_request_id: NullableIdentifier,
  entitlement_id: NullableIdentifier,
  operation: AccessGovernanceAuditOperationSchema,
  occurred_at: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

export type AccessGovernanceAuditOperation = Static<typeof AccessGovernanceAuditOperationSchema>
export type AccessGovernanceAuditEvent = Static<typeof AccessGovernanceAuditEventSchema>

type AccessGovernanceAuditEventBaseInput = {
  tenantId: string
  correlationId: string
  actorSubjectId: string
  subjectId: string
  actingClientId: string
  resourceId: string
  capabilityId: string
  occurredAt: number
}

export type AccessGovernanceAuditEventInput = AccessGovernanceAuditEventBaseInput & (
  | { operation: "CREATED"; accessRequestId: string; entitlementId: null }
  | { operation: "DENY"; accessRequestId: string; entitlementId: null }
  | { operation: "APPROVE"; accessRequestId: string; entitlementId: string }
  | { operation: "CANCEL"; accessRequestId: string; entitlementId: null }
  | { operation: "REVOKE"; accessRequestId: string | null; entitlementId: string }
)

export interface AccessGovernanceAuditWriter {
  record(input: { tenantId: string; event: AccessGovernanceAuditEvent }): Promise<unknown>
  recordInTransaction?(input: { transaction: SqlTransaction; tenantId: string; event: AccessGovernanceAuditEvent }): Promise<unknown>
}

export function accessGovernanceAuditEvent(input: AccessGovernanceAuditEventInput): AccessGovernanceAuditEvent {
  const identity = canonicalJson([
    input.tenantId,
    input.correlationId,
    input.operation,
    input.actorSubjectId,
    input.subjectId,
    input.actingClientId,
    input.resourceId,
    input.capabilityId,
    input.accessRequestId,
    input.entitlementId,
  ])
  return {
    tenant_id: input.tenantId,
    audit_event_id: `access-governance-${createHash("sha256").update(identity).digest("hex")}`,
    correlation_id: input.correlationId,
    kind: "ACCESS_GOVERNANCE_CHANGE",
    outcome: "SUCCESS",
    subject: { subject_id: input.subjectId, evidence_level: "VERIFIED" },
    actor_subject: { subject_id: input.actorSubjectId, evidence_level: "VERIFIED" },
    acting_client: { acting_client_id: input.actingClientId, evidence_level: "VERIFIED" },
    resource_id: input.resourceId,
    capability_id: input.capabilityId,
    access_request_id: input.accessRequestId,
    entitlement_id: input.entitlementId,
    operation: input.operation,
    occurred_at: input.occurredAt,
  }
}

export type AutoGrantActivationDisposition = "GRANTED" | "ALREADY_ENTITLED"

function digest(value: readonly unknown[]): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex")
}

export function autoGrantActivationIdempotencyKey(input: {
  tenantId: string
  subjectId: string
  clientId: string
  correlationId: string
}): string {
  return `auto-grant-${digest([
    input.tenantId,
    input.subjectId,
    input.clientId,
    input.correlationId,
  ])}`
}

export function autoGrantActivationRequestDigest(input: {
  tenantId: string
  subjectId: string
  clientId: string
  resourceId: string
  capabilityId: string
}): string {
  return digest([
    input.tenantId,
    input.subjectId,
    input.clientId,
    input.resourceId,
    input.capabilityId,
  ])
}

export function autoGrantActivationAuditEvent(input: {
  tenantId: string
  subjectId: string
  clientId: string
  correlationId: string
  resourceId: string
  capabilityId: string
  entitlementId: string
  disposition: AutoGrantActivationDisposition
  occurredAt: number
}): AutoGrantActivationAuditEvent {
  return {
    tenant_id: input.tenantId,
    audit_event_id: `auto-grant-${digest([
      input.tenantId,
      input.subjectId,
      input.clientId,
      input.correlationId,
      input.resourceId,
      input.capabilityId,
    ])}`,
    correlation_id: input.correlationId,
    kind: "AUTO_GRANT_ACTIVATION",
    outcome: "SUCCESS",
    activation: input.disposition,
    subject: { subject_id: input.subjectId, evidence_level: "VERIFIED" },
    actor_subject: { subject_id: input.subjectId, evidence_level: "VERIFIED" },
    acting_client: { acting_client_id: input.clientId, evidence_level: "VERIFIED" },
    resource_id: input.resourceId,
    capability_id: input.capabilityId,
    entitlement_id: input.entitlementId,
    occurred_at: input.occurredAt,
  }
}

export async function recordAutoGrantActivationOnce(
  audit: Pick<GatewayAuthorizationAuditStore, "findById">,
  event: AutoGrantActivationAuditEvent,
  write: () => Promise<unknown>,
  transaction?: SqlTransaction,
): Promise<void> {
  const recorded = await audit.findById({ tenantId: event.tenant_id, auditEventId: event.audit_event_id, transaction })
  if (recorded) {
    if (canonicalJson(recorded) !== canonicalJson({ ...event, occurred_at: recorded.occurred_at })) {
      throw new PlatformApiError("AUDIT_EVENT_CONFLICT", 409)
    }
    return
  }
  await write()
}
