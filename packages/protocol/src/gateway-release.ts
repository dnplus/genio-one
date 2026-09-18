import { Type, type Static, type TProperties } from "typebox"
import { Check } from "typebox/value"
import {
  GATEWAY_RELEASE_REFERENCE_SCHEMA_VERSION,
  RUNTIME_PROTOCOL_SCHEMA_VERSION,
} from "./runtime-command"
import {
  Ed25519SignatureSchema,
  type Ed25519Signature,
} from "./ed25519-signature"

export { RUNTIME_PROTOCOL_SCHEMA_VERSION } from "./runtime-command"

const Identifier = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[^\\u0000\\r\\n]+$",
})
const Revision = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[^\\u0000\\r\\n]+$",
})
const Sha256Digest = Type.String({ pattern: "^[a-f0-9]{64}$" })
const JsonInteger = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
const PositiveJsonInteger = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
const DetailText = Type.String({ maxLength: 2048, pattern: "^[^\\u0000\\r\\n]*$" })
const ErrorText = Type.String({ minLength: 1, maxLength: 2048, pattern: "^[^\\u0000\\r\\n]+$" })
const ReleaseId = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
})

/** TypeBox object schemas are closed at the protocol boundary. */
const StrictObject = <Properties extends TProperties>(properties: Properties) =>
  Type.Object(properties, { additionalProperties: false })

/* -------------------------------------------------------------------------- */
/* Shared envelope                                                            */
/* -------------------------------------------------------------------------- */

const RuntimeComponentStateSchema = Type.Union([
  Type.Literal("APPLYING"),
  Type.Literal("READY"),
  Type.Literal("DEGRADED"),
  Type.Literal("UNKNOWN"),
])

const CommandEnvelopeFields = {
  schema_version: Type.Literal(RUNTIME_PROTOCOL_SCHEMA_VERSION),
  message_type: Type.Literal("COMMAND"),
  tenant_id: Identifier,
  runtime_id: Identifier,
  command_id: Identifier,
  revision: Revision,
  digest: Sha256Digest,
  signature: Ed25519SignatureSchema,
  runtime_kind: Type.Literal("GATEWAY"),
}

const ReportEnvelopeFields = {
  schema_version: Type.Literal(RUNTIME_PROTOCOL_SCHEMA_VERSION),
  message_type: Type.Literal("REPORT"),
  tenant_id: Identifier,
  runtime_id: Identifier,
  report_id: Identifier,
  command_id: Identifier,
  revision: Revision,
  digest: Sha256Digest,
  signature: Ed25519SignatureSchema,
  runtime_kind: Type.Literal("GATEWAY"),
}

/* -------------------------------------------------------------------------- */
/* Aggregate Gateway release reference                                      */
/* -------------------------------------------------------------------------- */

/**
 * The command points at one Gateway-level release, not at one publication.
 * `projection_count: 0` is valid and represents an intentional empty release
 * (for example, after the last route is retired).
 */
export const GatewayReleaseReferenceSchema = StrictObject({
  schema_version: Type.Literal(GATEWAY_RELEASE_REFERENCE_SCHEMA_VERSION),
  release_id: ReleaseId,
  gateway_id: Identifier,
  head_revision: PositiveJsonInteger,
  package_digest: Sha256Digest,
  projection_count: JsonInteger,
})

/** Short alias used by runtime-control callers. */
export type GatewayReleaseReference = Static<typeof GatewayReleaseReferenceSchema>
export type GatewayReleaseRef = GatewayReleaseReference

/* -------------------------------------------------------------------------- */
/* Gateway observed state                                                    */
/* -------------------------------------------------------------------------- */

const GatewayComponentObservationFields = {
  state: RuntimeComponentStateSchema,
  observed_revision: Revision,
  detail: Type.Optional(DetailText),
}

const AIGatewayComponentObservationSchema = StrictObject({
  component: Type.Literal("AI_GATEWAY"),
  ...GatewayComponentObservationFields,
  payload: Type.Optional(
    StrictObject({
      provider_health: Type.Optional(RuntimeComponentStateSchema),
      active_routes: Type.Optional(JsonInteger),
      active_connections: Type.Optional(JsonInteger),
    }),
  ),
})

const AuthorizerComponentObservationSchema = StrictObject({
  component: Type.Literal("AUTHORIZER"),
  ...GatewayComponentObservationFields,
})

const ProcessorComponentObservationSchema = StrictObject({
  component: Type.Literal("PROCESSOR"),
  ...GatewayComponentObservationFields,
})

const GatewayComponentObservationSchema = Type.Union([
  AIGatewayComponentObservationSchema,
  AuthorizerComponentObservationSchema,
  ProcessorComponentObservationSchema,
])

const RuntimeObservedErrorSchema = StrictObject({
  code: Identifier,
  message: ErrorText,
})

/**
 * Components and errors are optional while a runtime is starting or applying
 * a release. The semantic validator below tightens that shape for each
 * aggregate state: READY is a complete, trusted inventory; DEGRADED carries
 * an explicit error; UNKNOWN carries no state that could be mistaken for a
 * trusted observation.
 */
export const GatewayObservedStateSchema = StrictObject({
  state: RuntimeComponentStateSchema,
  applied_release: Type.Optional(GatewayReleaseReferenceSchema),
  components: Type.Optional(Type.Array(GatewayComponentObservationSchema)),
  error: Type.Optional(RuntimeObservedErrorSchema),
})

export type GatewayComponentObservation = Static<typeof GatewayComponentObservationSchema>
export type RuntimeObservedError = Static<typeof RuntimeObservedErrorSchema>
export type GatewayObservedState = Static<typeof GatewayObservedStateSchema>

/* -------------------------------------------------------------------------- */
/* Gateway command/report                                                     */
/* -------------------------------------------------------------------------- */

export const GatewayRuntimeCommandSchema = StrictObject({
  ...CommandEnvelopeFields,
  desired_release: GatewayReleaseReferenceSchema,
})

export const GatewayRuntimeReportSchema = StrictObject({
  ...ReportEnvelopeFields,
  observed_status: GatewayObservedStateSchema,
})

export const RuntimeProtocolSchema = Type.Union(
  [GatewayRuntimeCommandSchema, GatewayRuntimeReportSchema],
  {
    $id: "https://genio.one/schemas/runtime-protocol.gateway.v1.json",
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "GenioOne Gateway Runtime Protocol v1",
  },
)

export type RuntimeSignature = Ed25519Signature
export type GatewayRuntimeCommand = Static<typeof GatewayRuntimeCommandSchema>
export type GatewayRuntimeReport = Static<typeof GatewayRuntimeReportSchema>
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

function schemaVersion(input: unknown): unknown {
  return typeof input === "object" && input !== null && "schema_version" in input
    ? (input as { schema_version?: unknown }).schema_version
    : undefined
}

function assertVersion(input: unknown): void {
  if (schemaVersion(input) !== RUNTIME_PROTOCOL_SCHEMA_VERSION) {
    throw new RuntimeProtocolValidationError(
      "UNSUPPORTED_SCHEMA_VERSION",
      `Unsupported Runtime Protocol schema version: ${String(schemaVersion(input))}`,
    )
  }
}

function invalidMessage(): RuntimeProtocolValidationError {
  return new RuntimeProtocolValidationError(
    "INVALID_MESSAGE",
    "Runtime Protocol v1 message does not satisfy the Gateway contract",
  )
}

function hasValidObservedStateSemantics(
  status: GatewayObservedState,
  reportRevision: string,
): boolean {
  const components = status.components ?? []
  if (new Set(components.map((component) => component.component)).size !== components.length) {
    return false
  }

  switch (status.state) {
    case "READY": {
      if (status.applied_release === undefined ||
        status.components === undefined ||
        status.components.length === 0 ||
        status.error !== undefined) {
        return false
      }

      const headRevision = String(status.applied_release.head_revision)
      return reportRevision === headRevision &&
        status.components.every((component) =>
          component.state === "READY" && component.observed_revision === headRevision)
    }
    case "DEGRADED":
      return status.error !== undefined
    case "UNKNOWN":
      // UNKNOWN is only a startup/untrusted state. Do not retain an applied
      // release or component inventory under it; that would look trusted to
      // callers even though the runtime explicitly cannot vouch for it.
      return status.applied_release === undefined &&
        status.components === undefined
    case "APPLYING":
      // APPLYING is an in-flight state. A runtime may retain a previously
      // applied release and/or report partial component progress, but it has
      // not established a new trusted READY state yet.
      return status.error === undefined
  }
}

function hasValidObservedStatus(input: GatewayRuntimeReport): boolean {
  return hasValidObservedStateSemantics(input.observed_status, input.revision)
}

function hasValidCommandSemantics(input: GatewayRuntimeCommand): boolean {
  return input.revision === String(input.desired_release.head_revision)
}

export function parseGatewayRuntimeCommand(input: unknown): GatewayRuntimeCommand {
  assertVersion(input)
  if (!Check(GatewayRuntimeCommandSchema, input)) throw invalidMessage()
  const command = input as GatewayRuntimeCommand
  if (!hasValidCommandSemantics(command)) throw invalidMessage()
  return command
}

export function isGatewayRuntimeCommand(input: unknown): input is GatewayRuntimeCommand {
  return Check(GatewayRuntimeCommandSchema, input) &&
    hasValidCommandSemantics(input as GatewayRuntimeCommand)
}

export function parseGatewayRuntimeReport(input: unknown): GatewayRuntimeReport {
  assertVersion(input)
  if (!Check(GatewayRuntimeReportSchema, input)) throw invalidMessage()
  const report = input as GatewayRuntimeReport
  if (!hasValidObservedStatus(report)) throw invalidMessage()
  return report
}

export function isGatewayRuntimeReport(input: unknown): input is GatewayRuntimeReport {
  return Check(GatewayRuntimeReportSchema, input) &&
    hasValidObservedStatus(input as GatewayRuntimeReport)
}

/**
 * Parse an observed-state value read outside its signed report envelope.
 * Durable stores must supply the persisted report revision so READY retains
 * the same revision binding as the wire-level report parser.
 */
export function parseGatewayObservedState(
  input: unknown,
  reportRevision: string,
): GatewayObservedState {
  if (!Check(GatewayObservedStateSchema, input)) throw invalidMessage()
  const status = input as GatewayObservedState
  if (!hasValidObservedStateSemantics(status, reportRevision)) throw invalidMessage()
  return status
}

export function parseRuntimeProtocolMessage(input: unknown): RuntimeProtocolMessage {
  assertVersion(input)
  if (!Check(RuntimeProtocolSchema, input)) throw invalidMessage()
  const message = input as RuntimeProtocolMessage
  if (message.message_type === "COMMAND" && !hasValidCommandSemantics(message)) {
    throw invalidMessage()
  }
  if (message.message_type === "REPORT" && !hasValidObservedStatus(message)) {
    throw invalidMessage()
  }
  return message
}

export function isRuntimeProtocolMessage(input: unknown): input is RuntimeProtocolMessage {
  if (!Check(RuntimeProtocolSchema, input)) return false
  const message = input as RuntimeProtocolMessage
  return message.message_type === "COMMAND"
    ? hasValidCommandSemantics(message)
    : hasValidObservedStatus(message)
}
