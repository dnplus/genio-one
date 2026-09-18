import { Type, type Static } from "typebox"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })
const Timestamp = Type.Integer({ minimum: 0 })
const NullableTimestamp = Type.Union([Timestamp, Type.Null()])
const NullableText = Type.Union([Type.String(), Type.Null()])

export const SiemDestinationSchema = Type.Object({
  destination_id: Identifier,
  endpoint_url: Type.String({ minLength: 1, maxLength: 2048 }),
  event_kinds: Type.Array(Identifier, { maxItems: 256 }),
  enabled: Type.Boolean(),
  configured_by: Type.Object({
    subject_id: Identifier,
    evidence_level: Type.Literal("VERIFIED"),
  }, { additionalProperties: false }),
  configured_at: Timestamp,
}, { additionalProperties: false })

export const ConfigureSiemDestinationSchema = Type.Object({
  destination_id: Identifier,
  endpoint_url: Type.String({ minLength: 1, maxLength: 2048 }),
  event_kinds: Type.Array(Identifier, { maxItems: 256 }),
  enabled: Type.Boolean(),
}, { additionalProperties: false })

const SiemDeliverySchema = Type.Object({
  tenant_id: Identifier,
  destination_id: Identifier,
  audit_event_id: Identifier,
  endpoint_url: Type.String(),
  event: Type.Object({
    audit_event_id: Identifier,
    kind: Identifier,
    correlation_id: Identifier,
    occurred_at: Timestamp,
  }, { additionalProperties: true }),
  status: Type.Union([
    Type.Literal("PENDING"), Type.Literal("IN_FLIGHT"), Type.Literal("RETRY_SCHEDULED"),
    Type.Literal("DELIVERED"), Type.Literal("CANCELLED"),
  ]),
  attempt_count: Type.Integer({ minimum: 0 }),
  next_attempt_at: Timestamp,
  lease_owner: NullableText,
  lease_expires_at: NullableTimestamp,
  delivered_at: NullableTimestamp,
  cancelled_at: NullableTimestamp,
  last_error_code: NullableText,
}, { additionalProperties: false })

export const SiemDeliveryListSchema = Type.Array(SiemDeliverySchema)
export const SiemTenantPathSchema = Type.Object({ tenant_id: Identifier }, { additionalProperties: false })
export const SiemDeliveryQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 100 })),
}, { additionalProperties: false })

export type SiemDestination = Static<typeof SiemDestinationSchema>
export type ConfigureSiemDestinationInput = Static<typeof ConfigureSiemDestinationSchema>
export type SiemDelivery = Static<typeof SiemDeliverySchema>
