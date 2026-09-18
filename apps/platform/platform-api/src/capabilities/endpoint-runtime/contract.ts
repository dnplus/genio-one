import { Type, type Static } from "typebox"

const Identifier = Type.String({ minLength: 1, maxLength: 512 })
const EvidenceLevelSchema = Type.Union([
  Type.Literal("UNKNOWN"),
  Type.Literal("ASSERTED"),
  Type.Literal("VERIFIED"),
])
const RouteSchema = Type.Union([
  Type.Literal("DIRECT"),
  Type.Literal("MANAGED"),
  Type.Literal("BLOCK"),
])
const EndpointHealthSchema = Type.Union([
  Type.Literal("UNKNOWN"),
  Type.Literal("HEALTHY"),
  Type.Literal("DEGRADED"),
])
const SubjectEvidenceSchema = Type.Object({
  subject_id: Identifier,
  evidence_level: EvidenceLevelSchema,
}, { additionalProperties: false })
const ActingClientEvidenceSchema = Type.Object({
  acting_client_id: Type.Union([Identifier, Type.Null()]),
  evidence_level: EvidenceLevelSchema,
}, { additionalProperties: false })

const EndpointDesiredStateSchema = Type.Object({
  revision: Identifier,
  policy_version: Identifier,
  routing: Type.Object({
    default_route: RouteSchema,
    rules: Type.Array(Type.Never(), { maxItems: 0 }),
  }, { additionalProperties: false }),
}, { additionalProperties: false })

export const RegisteredEndpointSchema = Type.Object({
  tenant_id: Identifier,
  device_id: Identifier,
  subject_id: Identifier,
  lifecycle_state: Type.Union([Type.Literal("ACTIVE"), Type.Literal("REVOKED")]),
  enrolled_at: Type.Integer({ minimum: 0 }),
  last_seen_at: Type.Integer({ minimum: 0 }),
  observed_state: Type.Object({
    endpoint_version: Identifier,
    applied_state_revision: Type.Union([Identifier, Type.Null()]),
    applied_policy_version: Type.Union([Identifier, Type.Null()]),
    health: EndpointHealthSchema,
    reported_at: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false }),
  revocation_reason: Type.Union([Type.String({ minLength: 1, maxLength: 1024 }), Type.Null()]),
}, { additionalProperties: false })

export const EndpointEnrollmentPathSchema = Type.Object({
  tenant_id: Identifier,
}, { additionalProperties: false })

export const EndpointDevicePathSchema = Type.Object({
  tenant_id: Identifier,
  device_id: Identifier,
}, { additionalProperties: false })

export const EnrollEndpointSchema = Type.Object({
  correlation_id: Identifier,
  identity: Type.Object({
    subject: SubjectEvidenceSchema,
    acting_client: ActingClientEvidenceSchema,
    device_id: Type.Union([Identifier, Type.Null()]),
  }, { additionalProperties: false }),
  device_id: Identifier,
  endpoint_version: Identifier,
  at: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

export const EndpointCredentialSchema = Type.Object({
  token: Identifier,
  expires_at: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

export const EndpointBootstrapSchema = Type.Object({
  tenant_id: Identifier,
  device_id: Identifier,
  subject_id: Identifier,
  credential: EndpointCredentialSchema,
}, { additionalProperties: false })

export const EndpointBootstrapRequestSchema = Type.Object({
  correlation_id: Identifier,
}, { additionalProperties: false })

export const EndpointEnrollmentSchema = Type.Object({
  device: RegisteredEndpointSchema,
  runtime_credential: Type.Union([EndpointCredentialSchema, Type.Null()]),
  configuration: Type.Object({
    heartbeat_interval_seconds: Type.Integer({ minimum: 1 }),
    stale_after_seconds: Type.Integer({ minimum: 1 }),
    desired_state: EndpointDesiredStateSchema,
  }, { additionalProperties: false }),
}, { additionalProperties: false })

export const EndpointHeartbeatSchema = Type.Object({
  correlation_id: Identifier,
  evidence_level: EvidenceLevelSchema,
  subject: SubjectEvidenceSchema,
  endpoint_version: Identifier,
  applied_state_revision: Type.Union([Identifier, Type.Null()]),
  applied_policy_version: Type.Union([Identifier, Type.Null()]),
  health: EndpointHealthSchema,
  at: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

export const EndpointHeartbeatOutcomeSchema = Type.Object({
  device: RegisteredEndpointSchema,
  desired_state: Type.Union([EndpointDesiredStateSchema, Type.Null()]),
}, { additionalProperties: false })

export const EndpointEnforcementSchema = Type.Object({
  correlation_id: Identifier,
  evidence_level: EvidenceLevelSchema,
  subject: SubjectEvidenceSchema,
  destination_host: Type.String({ minLength: 1, maxLength: 253 }),
  acting_client: ActingClientEvidenceSchema,
  client_configuration: Type.Optional(Type.Union([
    Type.Object({
      managed_configuration_revision: Type.Union([Identifier, Type.Null()]),
      otel_collector_origin: Type.Union([Type.String({ minLength: 1, maxLength: 2048 }), Type.Null()]),
    }, { additionalProperties: false }),
    Type.Null(),
  ])),
  applied_state_revision: Identifier,
  applied_policy_version: Identifier,
  route: RouteSchema,
  missing_deployment_capability: Type.Optional(Type.Union([
    Type.Literal("MANAGED_HTTP_PROXY"),
    Type.Literal("PROVIDER_TRANSPORT"),
    Type.Literal("SECURE_ACCESS"),
    Type.Null(),
  ])),
  at: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

export const EndpointRouteResolutionSchema = Type.Object({
  policy_rule_id: Type.Null(),
  resource_id: Type.Null(),
  route: Type.Literal("DIRECT"),
  managed_route: Type.Null(),
  policy_message: Type.Null(),
  missing_deployment_capability: Type.Null(),
}, { additionalProperties: false })

export type EndpointDesiredState = Static<typeof EndpointDesiredStateSchema>
export type RegisteredEndpoint = Static<typeof RegisteredEndpointSchema>
export type EnrollEndpoint = Static<typeof EnrollEndpointSchema>
export type EndpointEnrollment = Static<typeof EndpointEnrollmentSchema>
export type EndpointHeartbeat = Static<typeof EndpointHeartbeatSchema>
export type EndpointHeartbeatOutcome = Static<typeof EndpointHeartbeatOutcomeSchema>
export type EndpointEnforcement = Static<typeof EndpointEnforcementSchema>
export type EndpointRouteResolution = Static<typeof EndpointRouteResolutionSchema>

export const RevokeEndpointSchema = Type.Object({
  correlation_id: Identifier,
  reason: Type.String({ minLength: 1, maxLength: 1024, pattern: "\\S" }),
}, { additionalProperties: false })

export const EndpointLifecycleEventSchema = Type.Object({
  tenant_id: Identifier,
  device_id: Identifier,
  correlation_id: Identifier,
  subject_id: Identifier,
  kind: Type.Union([Type.Literal("ENROLLED"), Type.Literal("REVOKED")]),
  reason: Type.Union([Type.String(), Type.Null()]),
  at: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

export type EndpointLifecycleEvent = Static<typeof EndpointLifecycleEventSchema>

export type EndpointCredential = Static<typeof EndpointCredentialSchema>
export type EndpointBootstrap = Static<typeof EndpointBootstrapSchema>
