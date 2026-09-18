import { Type, type Static } from "typebox"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })
const Timestamp = Type.Integer({ minimum: 0 })
const NullableTimestamp = Type.Union([Timestamp, Type.Null()])
const NullableIdentifier = Type.Union([Identifier, Type.Null()])

const AccessRequestStateSchema = Type.Union([
  Type.Literal("PENDING"), Type.Literal("APPROVED"), Type.Literal("DENIED"),
  Type.Literal("CANCELLED"), Type.Literal("EXPIRED"),
])

export const AccessRequestSchema = Type.Object({
  access_request_id: Identifier,
  requester: Identifier,
  target_subject: Identifier,
  acting_client: Type.Object({
    acting_client_id: NullableIdentifier,
    evidence_level: Type.Union([Type.Literal("VERIFIED"), Type.Literal("UNKNOWN")]),
  }, { additionalProperties: false }),
  resource_id: Identifier,
  capability_id: Identifier,
  justification: Type.String({ minLength: 1 }),
  requested_valid_for: Type.Integer({ minimum: 1 }),
  configuration_revision: NullableIdentifier,
  approval_workflow_version: NullableIdentifier,
  approver: Identifier,
  state: AccessRequestStateSchema,
  created_at: Timestamp,
  expires_at: NullableTimestamp,
  resolved_at: NullableTimestamp,
  resolution_reason: Type.Union([Type.String(), Type.Null()]),
  policy_version_at_creation: Identifier,
  approval_stages: Type.Array(Type.Object({
    stage_id: Identifier,
    approver: Type.Object({
      kind: Type.Literal("ORGANIZATION"),
      organization_id: Identifier,
    }, { additionalProperties: false }),
    primary_approver: Identifier,
    assigned_approver: Identifier,
    delegation_id: NullableIdentifier,
    state: AccessRequestStateSchema,
    decided_by: Type.Union([
      Type.Object({ subject_id: Identifier, evidence_level: Type.Literal("VERIFIED") }, { additionalProperties: false }),
      Type.Null(),
    ]),
    decided_at: NullableTimestamp,
  }, { additionalProperties: false })),
  current_approval_stage: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })
export const AccessRequestListSchema = Type.Array(AccessRequestSchema)

export const RequestAccessSchema = Type.Object({
  correlation_id: Identifier,
  target_subject_id: Type.Optional(Identifier),
  resource_id: Identifier,
  capability_id: Identifier,
  justification: Type.String({ minLength: 1, maxLength: 4096 }),
  requested_valid_for_seconds: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false })
export const RequestAccessOutcomeSchema = Type.Union([
  Type.Object({ CREATED: AccessRequestSchema }, { additionalProperties: false }),
  Type.Object({ EXISTING: AccessRequestSchema }, { additionalProperties: false }),
  Type.Object({ ALREADY_ENTITLED: Identifier }, { additionalProperties: false }),
])
export const DecideAccessRequestSchema = Type.Object({
  correlation_id: Identifier,
  decision: Type.Union([
    Type.Object({ APPROVE: Type.Object({ valid_until: Timestamp }, { additionalProperties: false }) }, { additionalProperties: false }),
    Type.Object({ DENY: Type.Object({ reason: Type.String({ minLength: 1, maxLength: 4096 }) }, { additionalProperties: false }) }, { additionalProperties: false }),
  ]),
}, { additionalProperties: false })
export const CancelAccessRequestSchema = Type.Object({
  correlation_id: Identifier,
  reason: Type.String({ minLength: 1, maxLength: 4096 }),
}, { additionalProperties: false })

export const RevokeEntitlementSchema = Type.Object({
  correlation_id: Identifier,
  reason: Type.String({ minLength: 1, maxLength: 4096 }),
}, { additionalProperties: false })

export const LegacyEntitlementSchema = Type.Object({
  entitlement_id: Identifier,
  subject_id: Identifier,
  resource_id: Identifier,
  capability_id: Identifier,
  state: Type.Union([Type.Literal("ACTIVE"), Type.Literal("REVOKED"), Type.Literal("EXPIRED")]),
  valid_from: Timestamp,
  valid_until: Timestamp,
  revocation_reason: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false })
export const LegacyEntitlementListSchema = Type.Array(LegacyEntitlementSchema)

const SubjectCatalogCapabilitySchema = Type.Object({
  resource_id: Identifier,
  resource_display_name: Identifier,
  capability_id: Identifier,
  capability_display_name: Identifier,
  resource_owner_id: Identifier,
  resource_owner_display_name: Identifier,
  connection_status: Identifier,
  access: Type.Union([Type.Literal("ENTITLED"), Type.Literal("AUTO_GRANT"), Type.Literal("REQUEST")]),
  hub_status: Type.Union([Type.Literal("CONNECTED"), Type.Literal("AVAILABLE"), Type.Literal("REQUEST_ACCESS"), Type.Literal("PENDING_APPROVAL")]),
  restriction_reason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  publication_endpoint: Type.Optional(Type.Object({
    hostname: Type.String({ minLength: 1, maxLength: 253 }),
    base_path: Type.String({ minLength: 1, maxLength: 2048 }),
  }, { additionalProperties: false })),
  resource_kind: Type.Optional(Type.String()),
  builtin_service: Type.Optional(Type.Literal("DISCOVERY")),
  extension_metadata: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])),
}, { additionalProperties: false })
export const SubjectCatalogSchema = Type.Object({
  tenant_id: Identifier,
  catalog_revision: Identifier,
  subject_id: Identifier,
  subject_display_name: Identifier,
  capabilities: Type.Array(SubjectCatalogCapabilitySchema),
}, { additionalProperties: false })

const AccessNotificationSchema = Type.Object({
  notification_id: Identifier,
  kind: Type.Union([Type.Literal("PENDING_APPROVAL"), Type.Literal("REQUEST_APPROVED"), Type.Literal("REQUEST_DENIED")]),
  notification_type: Type.Optional(Identifier),
  audience: Type.Union([Type.Literal("APPROVER"), Type.Literal("REQUESTER"), Type.Literal("TARGET_SUBJECT"), Type.Literal("RESOURCE_OWNER")]),
  recipient_subject_id: Identifier,
  requester: NullableIdentifier,
  access_request_id: NullableIdentifier,
  entitlement_id: NullableIdentifier,
  resource_id: Identifier,
  capability_id: Identifier,
  occurred_at: Timestamp,
  valid_until: NullableTimestamp,
  delivery_channels: Type.Optional(Type.Array(Type.Literal("IN_APP"))),
  action_path: Identifier,
}, { additionalProperties: false })
export const AccessNotificationListSchema = Type.Array(AccessNotificationSchema)

export const AccessTenantPathSchema = Type.Object({ tenant_id: Identifier }, { additionalProperties: false })
export const AccessRequestPathSchema = Type.Object({
  tenant_id: Identifier,
  request_id: Identifier,
}, { additionalProperties: false })
export const AccessEntitlementPathSchema = Type.Object({
  tenant_id: Identifier,
  entitlement_id: Identifier,
}, { additionalProperties: false })

export type AccessRequest = Static<typeof AccessRequestSchema>
export type RequestAccessInput = Static<typeof RequestAccessSchema>
export type RequestAccessOutcome = Static<typeof RequestAccessOutcomeSchema>
export type DecideAccessRequestInput = Static<typeof DecideAccessRequestSchema>
export type CancelAccessRequestInput = Static<typeof CancelAccessRequestSchema>
export type RevokeEntitlementInput = Static<typeof RevokeEntitlementSchema>
export type LegacyEntitlement = Static<typeof LegacyEntitlementSchema>
export type SubjectCatalog = Static<typeof SubjectCatalogSchema>
export type AccessNotification = Static<typeof AccessNotificationSchema>
