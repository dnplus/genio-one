import { Type } from "typebox"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })
const NullableIdentifier = Type.Union([Identifier, Type.Null()])
const RuntimeOperatorState = Type.Union([
  Type.Literal("READY"), Type.Literal("DEGRADED"), Type.Literal("AWAITING_REPORT"),
  Type.Literal("OFFLINE"), Type.Literal("OUT_OF_SYNC"),
])

const RuntimeObservedState = Type.Object({
  command_id: Identifier,
  runtime_id: Identifier,
  runtime_kind: Type.Literal("GATEWAY"),
  runtime_version: Type.String(),
  applied_state_revision: NullableIdentifier,
  applied_policy_version: NullableIdentifier,
  health: Type.Union([Type.Literal("READY"), Type.Literal("DEGRADED")]),
  components: Type.Array(Type.Object({
    component: Identifier,
    applied_config_revision: NullableIdentifier,
    applied_enforcement_bundle_revision: NullableIdentifier,
    health: Type.Union([Type.Literal("READY"), Type.Literal("DEGRADED")]),
    detail: Type.Union([Type.String(), Type.Null()]),
  }, { additionalProperties: false })),
}, { additionalProperties: false })

export const RuntimeInventorySchema = Type.Array(Type.Object({
  runtime_id: Identifier,
  runtime_kind: Type.Literal("GATEWAY"),
  gateway_id: Identifier,
  release_eligible: Type.Boolean(),
  connected: Type.Boolean(),
  pending_command_count: Type.Integer({ minimum: 0 }),
  desired_state_revision: NullableIdentifier,
  desired_policy_version: NullableIdentifier,
  last_successful_state_revision: NullableIdentifier,
  observed_state: Type.Union([RuntimeObservedState, Type.Null()]),
  last_reported_at: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  operator_state: RuntimeOperatorState,
  in_sync: Type.Boolean(),
  health_timed_out: Type.Boolean(),
  health_timeout_seconds: Type.Integer({ minimum: 1 }),
  last_error: Type.Union([Type.String({ maxLength: 2048 }), Type.Null()]),
  remediation_hint: Type.Union([Identifier, Type.Null()]),
  operator_alert_code: Type.Union([
    Type.Literal("RUNTIME_HEALTH_TIMEOUT"),
    Type.Literal("RUNTIME_DISCONNECTED"),
    Type.Literal("RUNTIME_CONFIGURATION_OUT_OF_SYNC"),
    Type.Literal("RUNTIME_DEGRADED"),
    Type.Null(),
  ]),
}, { additionalProperties: false }))

export const GatewayFleetSchema = Type.Object({
  tenant_id: Identifier,
  operator_state: Type.Union([
    Type.Literal("READY"), Type.Literal("DEGRADED"), Type.Literal("DOWN"), Type.Literal("NO_GATEWAYS"),
  ]),
  traffic_available: Type.Boolean(),
  sites: Type.Array(Type.Object({
    gateway_id: Identifier,
    site_id: Identifier,
    region: Identifier,
    operator_state: Type.Union([Type.Literal("READY"), Type.Literal("DEGRADED"), Type.Literal("DOWN")]),
    traffic_available: Type.Boolean(),
    registered_instance_count: Type.Integer({ minimum: 0 }),
    traffic_eligible_instance_count: Type.Integer({ minimum: 0 }),
    traffic_candidates: Type.Array(Identifier),
    instances: Type.Array(Type.Object({
      runtime_id: Identifier,
      operator_state: RuntimeOperatorState,
      traffic_eligible: Type.Boolean(),
      alert_code: Type.Union([Identifier, Type.Null()]),
    }, { additionalProperties: false })),
  }, { additionalProperties: false })),
}, { additionalProperties: false })

export const RuntimeInventoryPathSchema = Type.Object({
  tenant_id: Identifier,
}, { additionalProperties: false })
