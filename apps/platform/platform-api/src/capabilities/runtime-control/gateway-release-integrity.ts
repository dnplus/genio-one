import {
  createHash,
  createPublicKey,
  randomUUID,
  verify as verifySignature,
} from "node:crypto"

import { PlatformApiError } from "../errors"
import { isEd25519Signature } from "../../../../../../packages/protocol/src/ed25519-signature"
import type { GatewayProjectionSigner } from "../gateway-projection/contract"
import {
  RUNTIME_PROTOCOL_SCHEMA_VERSION,
  parseRuntimeProtocolMessage,
  type GatewayReleaseReference,
  type GatewayRuntimeCommand,
  type GatewayRuntimeReport,
  type RuntimeProtocolMessage,
} from "../../../../../../packages/protocol/src/gateway-release"

export type RuntimeIntegrityCode =
  | "RUNTIME_PROTOCOL_INVALID"
  | "RUNTIME_PROTOCOL_DIGEST_MISMATCH"
  | "RUNTIME_PROTOCOL_SIGNATURE_INVALID"
  | "RUNTIME_PROTOCOL_KEY_INVALID"
  | "RUNTIME_REPORT_SCOPE_MISMATCH"
  | "RUNTIME_REPORT_PROJECTION_MISMATCH"

class RuntimeIntegrityError extends PlatformApiError {
  constructor(code: RuntimeIntegrityCode, message: string, statusCode = 422) {
    super(code, statusCode, message)
    this.name = "RuntimeIntegrityError"
  }
}

function canonicalRuntimeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalRuntimeValue(item))
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, canonicalRuntimeValue(record[key])]),
    )
  }
  return value
}

function canonicalRuntimeJson(value: unknown): string {
  return JSON.stringify(canonicalRuntimeValue(value))
}

function envelopeWithoutIntegrity(message: Record<string, unknown>): Record<string, unknown> {
  const value = { ...message }
  delete value.digest
  delete value.signature
  return value
}

export function runtimeProtocolDigest(message: Record<string, unknown>): string {
  return createHash("sha256")
    .update(canonicalRuntimeJson(envelopeWithoutIntegrity(message)))
    .digest("hex")
}

export function runtimeProtocolSignaturePayload(message: Record<string, unknown>): string {
  const expected = runtimeProtocolDigest(message)
  if (message.digest !== expected) {
    throw new RuntimeIntegrityError(
      "RUNTIME_PROTOCOL_DIGEST_MISMATCH",
      `Runtime protocol digest mismatch: expected ${String(message.digest)}, computed ${expected}`,
    )
  }
  const value = { ...message }
  delete value.signature
  return canonicalRuntimeJson(value)
}

function protocolRecord(value: object): Record<string, unknown> {
  return value as unknown as Record<string, unknown>
}

function signaturePayload(value: object): string {
  return runtimeProtocolSignaturePayload(protocolRecord(value))
}

function assertIdentifier(value: string): void {
  if (!value.trim() || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new RuntimeIntegrityError(
      "RUNTIME_PROTOCOL_INVALID",
      "Runtime protocol identifier is invalid",
    )
  }
}

function signatureBytes(value: string): Buffer {
  let decoded: Buffer
  try {
    decoded = Buffer.from(value, "base64url")
  } catch {
    throw new RuntimeIntegrityError(
      "RUNTIME_PROTOCOL_SIGNATURE_INVALID",
      "Runtime protocol signature encoding is invalid",
    )
  }
  if (decoded.length !== 64) {
    throw new RuntimeIntegrityError(
      "RUNTIME_PROTOCOL_SIGNATURE_INVALID",
      "Runtime protocol signature must contain 64 bytes",
    )
  }
  return decoded
}

export function gatewayReleaseReferencesEqual(
  left: GatewayReleaseReference,
  right: GatewayReleaseReference,
): boolean {
  return left.schema_version === right.schema_version &&
    left.release_id === right.release_id &&
    left.gateway_id === right.gateway_id &&
    left.head_revision === right.head_revision &&
    left.package_digest === right.package_digest &&
    left.projection_count === right.projection_count
}

export interface SignGatewayReleaseCommandInput {
  tenantId: string
  runtimeId: string
  release: GatewayReleaseReference
  signer: GatewayProjectionSigner
  commandId?: string
}

export async function signGatewayReleaseCommand(
  input: SignGatewayReleaseCommandInput,
): Promise<GatewayRuntimeCommand> {
  assertIdentifier(input.tenantId)
  assertIdentifier(input.runtimeId)
  const commandId = input.commandId ?? randomUUID()
  assertIdentifier(commandId)
  assertIdentifier(input.signer.keyId)
  if (input.signer.algorithm !== "Ed25519") {
    throw new RuntimeIntegrityError(
      "RUNTIME_PROTOCOL_INVALID",
      "Gateway runtime command signer must use Ed25519",
    )
  }

  const unsigned = {
    schema_version: RUNTIME_PROTOCOL_SCHEMA_VERSION,
    message_type: "COMMAND" as const,
    tenant_id: input.tenantId,
    runtime_id: input.runtimeId,
    command_id: commandId,
    revision: String(input.release.head_revision),
    digest: "0".repeat(64),
    signature: {
      algorithm: "Ed25519" as const,
      key_id: input.signer.keyId,
      value: "placeholder",
    },
    runtime_kind: "GATEWAY" as const,
    desired_release: structuredClone(input.release),
  }
  const digest = runtimeProtocolDigest(protocolRecord(unsigned))
  const digestBearing = { ...unsigned, digest }
  const signature = await input.signer.sign(
    new TextEncoder().encode(signaturePayload(digestBearing)),
  )
  const signed = {
    algorithm: "Ed25519" as const,
    key_id: input.signer.keyId,
    value: signature,
  }
  if (!isEd25519Signature(signed)) {
    throw new RuntimeIntegrityError(
      "RUNTIME_PROTOCOL_SIGNATURE_INVALID",
      "Runtime protocol signer returned an invalid signature",
      500,
    )
  }
  return {
    ...digestBearing,
    signature: signed,
  }
}

export interface VerifyRuntimeMessageInput {
  message: unknown
  publicKeyPem: string
  expectedKeyId?: string
}

export function verifyRuntimeMessage(
  input: VerifyRuntimeMessageInput,
): RuntimeProtocolMessage {
  let message: RuntimeProtocolMessage
  try {
    message = parseRuntimeProtocolMessage(input.message)
  } catch (error) {
    throw new RuntimeIntegrityError(
      "RUNTIME_PROTOCOL_INVALID",
      error instanceof Error ? error.message : "Runtime protocol message is invalid",
    )
  }
  const computed = runtimeProtocolDigest(protocolRecord(message))
  if (computed !== message.digest) {
    throw new RuntimeIntegrityError(
      "RUNTIME_PROTOCOL_DIGEST_MISMATCH",
      `Runtime protocol digest mismatch: expected ${message.digest}, computed ${computed}`,
    )
  }
  if (input.expectedKeyId !== undefined && message.signature.key_id !== input.expectedKeyId) {
    throw new RuntimeIntegrityError(
      "RUNTIME_PROTOCOL_SIGNATURE_INVALID",
      "Runtime protocol signature key does not match the registered runtime",
    )
  }
  let key: ReturnType<typeof createPublicKey>
  try {
    key = createPublicKey(input.publicKeyPem)
    if (key.asymmetricKeyType !== "ed25519") throw new Error("not Ed25519")
  } catch {
    throw new RuntimeIntegrityError(
      "RUNTIME_PROTOCOL_KEY_INVALID",
      "Registered runtime report key is invalid",
    )
  }
  if (!verifySignature(
    null,
    Buffer.from(signaturePayload(message)),
    key,
    signatureBytes(message.signature.value),
  )) {
    throw new RuntimeIntegrityError(
      "RUNTIME_PROTOCOL_SIGNATURE_INVALID",
      "Runtime protocol signature is invalid",
    )
  }
  return message
}

export interface VerifyGatewayReleaseReportInput {
  report: unknown
  publicKeyPem: string
  reportKeyId: string
  tenantId: string
  runtimeId: string
  commandId: string
  desiredRelease: GatewayReleaseReference
  priorAppliedRelease?: GatewayReleaseReference | null
}

export function verifyGatewayReleaseReport(
  input: VerifyGatewayReleaseReportInput,
): GatewayRuntimeReport {
  const message = verifyRuntimeMessage({
    message: input.report,
    publicKeyPem: input.publicKeyPem,
    expectedKeyId: input.reportKeyId,
  })
  if (
    message.message_type !== "REPORT" ||
    message.runtime_kind !== "GATEWAY" ||
    message.tenant_id !== input.tenantId ||
    message.runtime_id !== input.runtimeId ||
    message.command_id !== input.commandId ||
    message.revision !== String(input.desiredRelease.head_revision)
  ) {
    throw new RuntimeIntegrityError(
      "RUNTIME_REPORT_SCOPE_MISMATCH",
      "Runtime report does not match the registered aggregate release command",
    )
  }
  const report = message as GatewayRuntimeReport
  const applied = report.observed_status.applied_release
  if (report.observed_status.state === "READY") {
    if (!applied || !gatewayReleaseReferencesEqual(applied, input.desiredRelease)) {
      throw new RuntimeIntegrityError(
        "RUNTIME_REPORT_PROJECTION_MISMATCH",
        "Ready runtime report does not match the commanded Gateway release",
      )
    }
  } else if (
    report.observed_status.state === "APPLYING" &&
    applied !== undefined &&
    gatewayReleaseReferencesEqual(applied, input.desiredRelease)
  ) {
    throw new RuntimeIntegrityError(
      "RUNTIME_REPORT_PROJECTION_MISMATCH",
      "Applying runtime report cannot claim the commanded Gateway release as applied",
    )
  } else if (
    applied !== undefined &&
    (!input.priorAppliedRelease ||
      !gatewayReleaseReferencesEqual(applied, input.priorAppliedRelease))
  ) {
    throw new RuntimeIntegrityError(
      "RUNTIME_REPORT_PROJECTION_MISMATCH",
      "A non-ready runtime report may only retain the trusted prior Gateway release",
    )
  }
  return report
}
