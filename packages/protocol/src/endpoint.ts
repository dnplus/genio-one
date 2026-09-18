import Type from "typebox"
import type { Static, TProperties } from "typebox"
import { Check } from "typebox/value"

const RUNTIME_PROTOCOL_SCHEMA_VERSION = "genio.one.runtime.v1" as const

const Identifier = Type.String({ minLength: 1, maxLength: 256 })
const Revision = Type.String({ minLength: 1, maxLength: 128 })
const Digest = Type.String({ pattern: "^[a-f0-9]{64}$" })
const StrictObject = <Properties extends TProperties>(properties: Properties) =>
  Type.Object(properties, { additionalProperties: false })

const RuntimeSignatureSchema = StrictObject({
  algorithm: Type.Literal("Ed25519"),
  key_id: Identifier,
  value: Type.String({ minLength: 1, maxLength: 4096 }),
})

const EndpointRouteSchema = StrictObject({
  host_suffix: Identifier,
  route: Type.Union([
    Type.Literal("DIRECT"),
    Type.Literal("MANAGED"),
    Type.Literal("BLOCK"),
  ]),
  enforcement_point: Type.Optional(Identifier),
})

const EndpointRoutingComponentProjectionSchema = StrictObject({
  component: Type.Literal("ENDPOINT_ROUTING"),
  config_revision: Revision,
  default_route: Type.Union([
    Type.Literal("DIRECT"),
    Type.Literal("MANAGED"),
    Type.Literal("BLOCK"),
  ]),
  rules: Type.Array(EndpointRouteSchema),
})

const EndpointDesiredProjectionSchema = StrictObject({
  runtime_kind: Type.Literal("ENDPOINT"),
  components: Type.Array(EndpointRoutingComponentProjectionSchema, { minItems: 1 }),
})

const RuntimeComponentStateSchema = Type.Union([
  Type.Literal("READY"),
  Type.Literal("DEGRADED"),
  Type.Literal("UNKNOWN"),
])

const EndpointRoutingComponentObservationSchema = StrictObject({
  component: Type.Literal("ENDPOINT_ROUTING"),
  state: RuntimeComponentStateSchema,
  observed_revision: Revision,
  detail: Type.Optional(Type.String({ maxLength: 2048 })),
  payload: Type.Optional(
    StrictObject({
      active_rules: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
  ),
})

const RuntimeObservedErrorSchema = StrictObject({
  code: Identifier,
  message: Type.String({ minLength: 1, maxLength: 2048 }),
})

const EndpointObservedStatusSchema = StrictObject({
  state: RuntimeComponentStateSchema,
  applied_revision: Revision,
  applied_digest: Digest,
  components: Type.Array(EndpointRoutingComponentObservationSchema),
  error: Type.Optional(RuntimeObservedErrorSchema),
})

const CommandEnvelopeFields = {
  schema_version: Type.Literal(RUNTIME_PROTOCOL_SCHEMA_VERSION),
  message_type: Type.Literal("COMMAND"),
  tenant_id: Identifier,
  runtime_id: Identifier,
  command_id: Identifier,
  revision: Revision,
  digest: Digest,
  signature: RuntimeSignatureSchema,
}

const ReportEnvelopeFields = {
  schema_version: Type.Literal(RUNTIME_PROTOCOL_SCHEMA_VERSION),
  message_type: Type.Literal("REPORT"),
  tenant_id: Identifier,
  runtime_id: Identifier,
  report_id: Identifier,
  command_id: Identifier,
  revision: Revision,
  digest: Digest,
  signature: RuntimeSignatureSchema,
}

const EndpointRuntimeCommandSchema = StrictObject({
  ...CommandEnvelopeFields,
  runtime_kind: Type.Literal("ENDPOINT"),
  desired_projection: EndpointDesiredProjectionSchema,
})

const EndpointRuntimeReportSchema = StrictObject({
  ...ReportEnvelopeFields,
  runtime_kind: Type.Literal("ENDPOINT"),
  observed_status: EndpointObservedStatusSchema,
})

export const RuntimeProtocolSchema = Type.Union(
  [EndpointRuntimeCommandSchema, EndpointRuntimeReportSchema],
  {
    $id: "https://genio.one/schemas/runtime-protocol.endpoint.v1.json",
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "GenioOne Endpoint Runtime Protocol v1",
  },
)

export type EndpointRuntimeCommand = Static<typeof EndpointRuntimeCommandSchema>
export type EndpointRuntimeReport = Static<typeof EndpointRuntimeReportSchema>
export type RuntimeProtocolMessage = Static<typeof RuntimeProtocolSchema>

export type RuntimeProtocolValidationCode =
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "INVALID_MESSAGE"

export class RuntimeProtocolValidationError extends Error {
  readonly code: RuntimeProtocolValidationCode

  constructor(code: RuntimeProtocolValidationCode, message: string) {
    super(message)
    this.name = "RuntimeProtocolValidationError"
    this.code = code
  }
}

export function parseRuntimeProtocolMessage(input: unknown): RuntimeProtocolMessage {
  const version =
    typeof input === "object" && input !== null && "schema_version" in input
      ? (input as { schema_version?: unknown }).schema_version
      : undefined

  if (version !== RUNTIME_PROTOCOL_SCHEMA_VERSION) {
    throw new RuntimeProtocolValidationError(
      "UNSUPPORTED_SCHEMA_VERSION",
      `Unsupported Endpoint Runtime Protocol schema version: ${String(version)}`,
    )
  }

  if (!Check(RuntimeProtocolSchema, input)) {
    throw new RuntimeProtocolValidationError(
      "INVALID_MESSAGE",
      "Endpoint Runtime Protocol message does not satisfy the v1 contract",
    )
  }

  return input as RuntimeProtocolMessage
}

export function isRuntimeProtocolMessage(input: unknown): input is RuntimeProtocolMessage {
  return (
    typeof input === "object" &&
    input !== null &&
    "schema_version" in input &&
    (input as { schema_version?: unknown }).schema_version === RUNTIME_PROTOCOL_SCHEMA_VERSION &&
    Check(RuntimeProtocolSchema, input)
  )
}
