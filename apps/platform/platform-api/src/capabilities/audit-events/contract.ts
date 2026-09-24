import { Type, type Static } from "typebox"
import { RuntimePolicyAuditEventSchema, type RuntimePolicyAuditEvent } from "../one-policy/runtime"
import { AccessGroupAuditEventSchema, type AccessGroupAuditEvent } from "../access-groups/audit"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })
const NullableIdentifier = Type.Union([Identifier, Type.Null()])

export const AUDIT_EXPORT_MAX_RECORDS = 10_000

const EvidenceSchema = Type.Object({
  subject_id: Identifier,
  evidence_level: Type.Literal("VERIFIED"),
})

export const GatewayAuthorizationAuditIngestSchema = Type.Object({
  audit_event_id: Identifier,
  correlation_id: Identifier,
  kind: Type.Literal("ONE_POLICY_DECISION"),
  outcome: Type.Union([Type.Literal("ALLOW"), Type.Literal("DENY")]),
  subject: EvidenceSchema,
  target_subject_id: Type.Null(),
  actor_subject: Type.Null(),
  acting_client: Type.Object({
    acting_client_id: Identifier,
    evidence_level: Type.Literal("VERIFIED"),
  }),
  resource_id: Identifier,
  capability_id: Identifier,
  device_id: Type.Null(),
  endpoint_version: Type.Null(),
  desired_state_revision: Type.Null(),
  applied_state_revision: Type.Null(),
  applied_policy_version: Identifier,
  policy_proposal_id: Type.Null(),
  proposed_policy_version: Type.Null(),
  access_group_id: Type.Null(),
  destination_host: Type.Null(),
  routing_policy_rule_id: NullableIdentifier,
  route: Type.Literal("MANAGED"),
  missing_deployment_capability: Type.Null(),
  decision: Type.Object({
    decision_id: Identifier,
    correlation_id: Identifier,
    policy_version: Identifier,
    winning_rule_id: NullableIdentifier,
    reason: Identifier,
    visibility: Type.Literal("VISIBLE"),
    access: Type.Union([Type.Literal("ENTITLED"), Type.Literal("DENY")]),
    route: Type.Literal("MANAGED"),
    obligations: Type.Array(Type.Object({
      kind: Identifier,
      enforcement_point_id: Identifier,
      parameters: Type.Array(Type.Tuple([Type.String(), Type.String()])),
    })),
    entitlement_conditions: Type.Object({
      required_verified_acting_client_id: NullableIdentifier,
      requires_device: Type.Boolean(),
    }),
    entitlement_id: NullableIdentifier,
    auto_grant_valid_for: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    input_receipt: Type.Object({
      requested_model_id: NullableIdentifier,
      effective_model_id: NullableIdentifier,
      mcp_method: Type.Optional(NullableIdentifier),
      mcp_tool: Type.Optional(NullableIdentifier),
      mcp_protocol_version: Type.Optional(NullableIdentifier),
      mcp_connection_id: Type.Optional(NullableIdentifier),
    }),
    agent_authority: Type.Optional(Type.Union([
      Type.Object({
        authority_mode: Type.Union([Type.Literal("SELF"), Type.Literal("DELEGATED")]),
        agent_subject_id: Identifier,
        principal_subject_id: NullableIdentifier,
        delegation_id: NullableIdentifier,
        delegation_revision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
        delegation_revocation_generation: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
        target_agent_subject_id: NullableIdentifier,
        execution_grant_id: NullableIdentifier,
        action_digest: NullableIdentifier,
      }, { additionalProperties: false }),
      Type.Null(),
    ])),
  }),
  access_request_id: Type.Null(),
  entitlement_id: NullableIdentifier,
  enforcement_point_id: Type.Union([
    Type.Literal("AI_GATEWAY"),
    Type.Literal("API_GATEWAY"),
  ]),
  obligation_kind: Type.Null(),
  runaway_trigger: Type.Null(),
  upstream_attempted: Type.Boolean(),
  occurred_at: Type.Integer({ minimum: 0 }),
})

export const GatewayAuthorizationAuditEventSchema = Type.Intersect([
  GatewayAuthorizationAuditIngestSchema,
  Type.Object({ tenant_id: Identifier }),
])

export const PolicyChangeAuditEventSchema = Type.Object({
  tenant_id: Identifier,
  audit_event_id: Identifier,
  correlation_id: Identifier,
  kind: Type.Literal("POLICY_CHANGE"),
  outcome: Type.Literal("SUCCESS"),
  subject: EvidenceSchema,
  actor_subject: EvidenceSchema,
  policy_key: Type.String({ minLength: 1, maxLength: 4_096 }),
  action: Type.Union([
    Type.Literal("DRAFT_SAVED"),
    Type.Literal("VALIDATED"),
    Type.Literal("REVIEWED"),
    Type.Literal("PUBLISHED"),
    Type.Literal("DISCARDED"),
    Type.Literal("SETTINGS_UPDATED"),
    Type.Literal("SYSTEM_PUBLISHED"),
    Type.Literal("ENABLED"),
    Type.Literal("DISABLED"),
  ]),
  policy_draft_version: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  base_revision: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  published_revision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  lifecycle: Type.Union([Type.Literal("DRAFT"), Type.Literal("VALIDATED"), Type.Literal("REVIEWED"), Type.Null()]),
  content_digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  enabled: Type.Optional(Type.Boolean()),
  occurred_at: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

export const AuthorizationAuditEventSchema = Type.Union([
  GatewayAuthorizationAuditEventSchema,
  RuntimePolicyAuditEventSchema,
  PolicyChangeAuditEventSchema,
  AccessGroupAuditEventSchema,
])

export const GatewayAuthorizationAuditPathSchema = Type.Object({
  tenant_id: Identifier,
  runtime_id: Identifier,
})
export const GatewayAuthorizationAuditListPathSchema = Type.Object({ tenant_id: Identifier })
export const GatewayAuthorizationAuditListQuerySchema = Type.Object({
  correlation_id: Type.Optional(Identifier),
  enforcement_point_id: Type.Optional(Identifier),
  kind: Type.Optional(Identifier),
  outcome: Type.Optional(Identifier),
  resource_id: Type.Optional(Identifier),
  subject_id: Type.Optional(Identifier),
  from: Type.Optional(Type.Integer({ minimum: 0 })),
  to: Type.Optional(Type.Integer({ minimum: 0 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000, default: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 100 })),
  metadata: Type.Optional(Type.Boolean({ default: false })),
})

export const AuditExportQuerySchema = Type.Object({
  from: Type.Integer({ minimum: 0 }),
  to: Type.Integer({ minimum: 0 }),
  resource_id: Identifier,
})

export const AuditExportRecordSchema = Type.Object({
  policy_version: NullableIdentifier,
  decision_correlation_id: Identifier,
  audit_event_id: Identifier,
  correlation_id: Identifier,
  resource_id: NullableIdentifier,
  occurred_at: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

export const AuditExportArtifactSchema = Type.Object({
  schema_version: Type.Literal("genioone.audit-export.v1"),
  tenant_id: Identifier,
  from: Type.Integer({ minimum: 0 }),
  to: Type.Integer({ minimum: 0 }),
  resource_id: Identifier,
  record_count: Type.Integer({ minimum: 0, maximum: AUDIT_EXPORT_MAX_RECORDS }),
  records: Type.Array(AuditExportRecordSchema, { maxItems: AUDIT_EXPORT_MAX_RECORDS }),
}, { additionalProperties: false })

export const GatewayAuthorizationAuditQueryResponseSchema = Type.Object({
  events: Type.Array(AuthorizationAuditEventSchema),
  source_revision: Type.Integer({ minimum: 0 }),
  offset: Type.Integer({ minimum: 0 }),
  limit: Type.Integer({ minimum: 1 }),
  freshness: Type.Object({
    as_of: Type.Integer({ minimum: 0 }),
    latest_event_at: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    age_seconds: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  }),
  coverage: Type.Object({
    requested_from: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    requested_to: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    returned_from: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    returned_to: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    returned_count: Type.Integer({ minimum: 0 }),
    has_more: Type.Boolean(),
  }),
})

export type GatewayAuthorizationAuditIngest = Static<typeof GatewayAuthorizationAuditIngestSchema>
export type GatewayAuthorizationAuditEvent = Static<typeof GatewayAuthorizationAuditEventSchema>
export type PolicyChangeAuditEvent = Static<typeof PolicyChangeAuditEventSchema>
export type { AccessGroupAuditEvent }
export type AuthorizationAuditEvent = Static<typeof AuthorizationAuditEventSchema>
export type GatewayAuthorizationAuditQueryResponse = Static<typeof GatewayAuthorizationAuditQueryResponseSchema>
export type AuditExportQuery = Static<typeof AuditExportQuerySchema>
export type AuditExportRecord = Static<typeof AuditExportRecordSchema>
export type AuditExportArtifact = Static<typeof AuditExportArtifactSchema>
export type { RuntimePolicyAuditEvent }
