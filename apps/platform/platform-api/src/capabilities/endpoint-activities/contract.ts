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

export const EndpointActivityPathSchema = Type.Object({
  tenant_id: Identifier,
  device_id: Identifier,
}, { additionalProperties: false })

export const EndpointActivityListPathSchema = Type.Object({
  tenant_id: Identifier,
}, { additionalProperties: false })

export const EndpointActivityListQuerySchema = Type.Object({
  device_id: Type.Optional(Identifier),
  recent_limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 50 })),
}, { additionalProperties: false })

export const EndpointActivityIngestSchema = Type.Object({
  correlation_id: Identifier,
  evidence_level: EvidenceLevelSchema,
  subject: Type.Object({
    subject_id: Identifier,
    evidence_level: EvidenceLevelSchema,
  }, { additionalProperties: false }),
  destination_host: Type.String({ minLength: 1, maxLength: 253 }),
  acting_client: Type.Object({
    acting_client_id: Type.Union([Identifier, Type.Null()]),
    evidence_level: EvidenceLevelSchema,
  }, { additionalProperties: false }),
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
  request_count: Type.Integer({ minimum: 1 }),
  bytes_sent: Type.Integer({ minimum: 0 }),
  bytes_received: Type.Integer({ minimum: 0 }),
  observed_at: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

const EndpointClientSchema = Type.Union([
  Type.Object({ status: Type.Literal("UNKNOWN") }, { additionalProperties: false }),
  Type.Object({
    status: Type.Literal("VERIFIED"),
    acting_client_id: Identifier,
  }, { additionalProperties: false }),
])

export const EndpointActivityEventSchema = Type.Object({
  activity_id: Identifier,
  correlation_id: Identifier,
  kind: Type.Union([Type.Literal("DISCOVERY"), Type.Literal("USAGE")]),
  tenant_id: Identifier,
  subject_id: Identifier,
  device_id: Identifier,
  destination_host: Identifier,
  resource_id: Identifier,
  resource_class: Type.Union([Type.Literal("KNOWN"), Type.Literal("UNCLASSIFIED")]),
  client: EndpointClientSchema,
  client_compliance: Type.Optional(Type.Object({
    state: Type.Union([Type.Literal("COMPLIANT"), Type.Literal("NON_COMPLIANT")]),
    issues: Type.Array(Type.Union([
      Type.Literal("MANAGED_CONFIGURATION"),
      Type.Literal("OTEL_CONFIGURATION"),
    ])),
  }, { additionalProperties: false })),
  route: RouteSchema,
  routing_policy_rule_id: Type.Union([Identifier, Type.Null()]),
  applied_state_revision: Identifier,
  applied_policy_version: Identifier,
  request_count: Type.Integer({ minimum: 1 }),
  bytes_sent: Type.Integer({ minimum: 0 }),
  bytes_received: Type.Integer({ minimum: 0 }),
  observed_at: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

const EndpointActivityResourceSummarySchema = Type.Object({
  resource_id: Identifier,
  resource_class: Type.Union([Type.Literal("KNOWN"), Type.Literal("UNCLASSIFIED")]),
  destination_hosts: Type.Array(Identifier),
  subjects: Type.Array(Identifier),
  devices: Type.Array(Identifier),
  clients: Type.Array(EndpointClientSchema),
  routes: Type.Array(RouteSchema),
  first_seen_at: Type.Integer({ minimum: 0 }),
  last_seen_at: Type.Integer({ minimum: 0 }),
  request_count: Type.Integer({ minimum: 1 }),
  bytes_sent: Type.Integer({ minimum: 0 }),
  bytes_received: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

export const EndpointActivityInventorySchema = Type.Object({
  resources: Type.Array(EndpointActivityResourceSummarySchema),
  recent_activity: Type.Array(EndpointActivityEventSchema),
}, { additionalProperties: false })

export type EndpointActivityIngest = Static<typeof EndpointActivityIngestSchema>
export type EndpointActivityEvent = Static<typeof EndpointActivityEventSchema>
export type EndpointActivityResourceSummary = Static<typeof EndpointActivityResourceSummarySchema>
export type EndpointActivityInventory = Static<typeof EndpointActivityInventorySchema>
