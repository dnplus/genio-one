import { createHash } from "node:crypto"

import { Type, type Static } from "typebox"
import { canonicalJson } from "@genioone/protocol/canonical"
import type { SqlTransaction } from "../../persistence/sql-adapter"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })
const EvidenceSchema = Type.Object({
  subject_id: Identifier,
  evidence_level: Type.Literal("VERIFIED"),
}, { additionalProperties: false })

export const AccessGroupAuditOperationSchema = Type.Union([
  Type.Literal("CREATED"),
  Type.Literal("UPDATED"),
  Type.Literal("ENABLED"),
  Type.Literal("DISABLED"),
  Type.Literal("MEMBERS_REPLACED"),
])

export const AccessGroupAuditEventSchema = Type.Object({
  tenant_id: Identifier,
  audit_event_id: Identifier,
  correlation_id: Identifier,
  kind: Type.Literal("ACCESS_GROUP_CHANGE"),
  outcome: Type.Literal("SUCCESS"),
  subject: EvidenceSchema,
  actor_subject: EvidenceSchema,
  access_group_id: Identifier,
  operation: AccessGroupAuditOperationSchema,
  before_revision: Type.Integer({ minimum: 0 }),
  after_revision: Type.Integer({ minimum: 1 }),
  occurred_at: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

export type AccessGroupAuditOperation = Static<typeof AccessGroupAuditOperationSchema>
export type AccessGroupAuditEvent = Static<typeof AccessGroupAuditEventSchema>

export interface AccessGroupAuditWriter {
  record(input: { tenantId: string; event: AccessGroupAuditEvent }): Promise<unknown>
  recordInTransaction?(input: { transaction: SqlTransaction; tenantId: string; event: AccessGroupAuditEvent }): Promise<unknown>
}

export function accessGroupAuditEvent(input: {
  tenantId: string
  accessGroupId: string
  actorSubjectId: string
  correlationId: string
  operation: AccessGroupAuditOperation
  beforeRevision: number
  afterRevision: number
  occurredAt: number
}): AccessGroupAuditEvent {
  const identity = canonicalJson([
    input.tenantId,
    input.accessGroupId,
    input.correlationId,
    input.operation,
    input.beforeRevision,
    input.afterRevision,
  ])
  return {
    tenant_id: input.tenantId,
    audit_event_id: `access-group-${createHash("sha256").update(identity).digest("hex")}`,
    correlation_id: input.correlationId,
    kind: "ACCESS_GROUP_CHANGE",
    outcome: "SUCCESS",
    subject: { subject_id: input.actorSubjectId, evidence_level: "VERIFIED" },
    actor_subject: { subject_id: input.actorSubjectId, evidence_level: "VERIFIED" },
    access_group_id: input.accessGroupId,
    operation: input.operation,
    before_revision: input.beforeRevision,
    after_revision: input.afterRevision,
    occurred_at: input.occurredAt,
  }
}
