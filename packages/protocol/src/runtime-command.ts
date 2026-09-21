import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto"

import type { VerificationKeyRing } from "./compact-jws"
import { canonicalJson, compareUtf8 } from "./canonical"
import {
  isEd25519Signature,
  type Ed25519Signature,
} from "./ed25519-signature"

export const RUNTIME_PROTOCOL_SCHEMA_VERSION = "genio.one.runtime.v1" as const
export const GATEWAY_RELEASE_REFERENCE_SCHEMA_VERSION =
  "genio.one.gateway-release-ref.v1" as const

export interface GatewayReleaseReference {
  schema_version: typeof GATEWAY_RELEASE_REFERENCE_SCHEMA_VERSION
  release_id: string
  gateway_id: string
  head_revision: number
  package_digest: string
  projection_count: number
}

export interface GatewayRuntimeCommand {
  schema_version: typeof RUNTIME_PROTOCOL_SCHEMA_VERSION
  message_type: "COMMAND"
  tenant_id: string
  runtime_id: string
  command_id: string
  revision: string
  digest: string
  signature: Ed25519Signature
  runtime_kind: "GATEWAY"
  desired_release: GatewayReleaseReference
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function isIdentifier(value: unknown, maxLength = 256): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function isSafeReleaseId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
  )
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
}

export function isGatewayReleaseReference(
  value: unknown,
): value is GatewayReleaseReference {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "schema_version",
      "release_id",
      "gateway_id",
      "head_revision",
      "package_digest",
      "projection_count",
    ]) &&
    value.schema_version === GATEWAY_RELEASE_REFERENCE_SCHEMA_VERSION &&
    isSafeReleaseId(value.release_id) &&
    isIdentifier(value.gateway_id) &&
    Number.isSafeInteger(value.head_revision) &&
    Number(value.head_revision) >= 1 &&
    isSha256(value.package_digest) &&
    Number.isSafeInteger(value.projection_count) &&
    Number(value.projection_count) >= 0
  )
}

function isGatewayRuntimeCommand(value: unknown): value is GatewayRuntimeCommand {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "schema_version",
      "message_type",
      "tenant_id",
      "runtime_id",
      "command_id",
      "revision",
      "digest",
      "signature",
      "runtime_kind",
      "desired_release",
    ]) &&
    value.schema_version === RUNTIME_PROTOCOL_SCHEMA_VERSION &&
    value.message_type === "COMMAND" &&
    isIdentifier(value.tenant_id) &&
    isIdentifier(value.runtime_id) &&
    isIdentifier(value.command_id) &&
    isIdentifier(value.revision, 128) &&
    isSha256(value.digest) &&
    isEd25519Signature(value.signature) &&
    value.runtime_kind === "GATEWAY" &&
    isGatewayReleaseReference(value.desired_release) &&
    value.revision === String(value.desired_release.head_revision)
  )
}

function withoutIntegrity(command: GatewayRuntimeCommand): Record<string, unknown> {
  const value = { ...command } as Record<string, unknown>
  delete value.digest
  delete value.signature
  return value
}

function commandDigest(command: GatewayRuntimeCommand): string {
  return createHash("sha256")
    .update(canonicalJson(withoutIntegrity(command)))
    .digest("hex")
}

function signaturePayload(command: GatewayRuntimeCommand): string {
  const value = { ...command } as Record<string, unknown>
  delete value.signature
  return canonicalJson(value)
}

function verificationKey(
  keyRing: VerificationKeyRing,
  keyId: string,
): ReturnType<typeof createPublicKey> {
  if (
    !isRecord(keyRing) ||
    !hasExactKeys(keyRing, ["schema_version", "keys"]) ||
    keyRing.schema_version !== 1 ||
    !Array.isArray(keyRing.keys) ||
    keyRing.keys.length === 0
  ) {
    throw new Error("runtime command verification keyring is invalid")
  }

  let prior = ""
  let selected: string | undefined
  for (const candidate of keyRing.keys) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ["key_id", "public_key_pem"]) ||
      !isIdentifier(candidate.key_id) ||
      typeof candidate.public_key_pem !== "string" ||
      candidate.public_key_pem.trim().length === 0 ||
      (prior && compareUtf8(prior, candidate.key_id) >= 0)
    ) {
      throw new Error("runtime command verification keyring is invalid")
    }
    prior = candidate.key_id
    if (candidate.key_id === keyId) selected = candidate.public_key_pem
  }
  if (!selected) throw new Error("runtime command signing key is unknown")

  try {
    const key = createPublicKey(selected)
    if (key.asymmetricKeyType !== "ed25519") throw new Error("not Ed25519")
    return key
  } catch {
    throw new Error("runtime command verification key is invalid")
  }
}

export function verifyGatewayRuntimeCommand(
  value: unknown,
  keyRing: VerificationKeyRing,
): GatewayRuntimeCommand {
  if (!isGatewayRuntimeCommand(value)) {
    throw new Error("Gateway runtime command is invalid")
  }
  const computed = commandDigest(value)
  if (value.digest !== computed) {
    throw new Error("Gateway runtime command digest does not match")
  }
  const signature = Buffer.from(value.signature.value, "base64url")
  if (
    signature.length !== 64 ||
    !verifySignature(
      null,
      Buffer.from(signaturePayload(value)),
      verificationKey(keyRing, value.signature.key_id),
      signature,
    )
  ) {
    throw new Error("Gateway runtime command signature is invalid")
  }
  return value
}

export function gatewayReleaseReferencesEqual(
  left: GatewayReleaseReference,
  right: GatewayReleaseReference,
): boolean {
  return (
    left.schema_version === right.schema_version &&
    left.release_id === right.release_id &&
    left.gateway_id === right.gateway_id &&
    left.head_revision === right.head_revision &&
    left.package_digest === right.package_digest &&
    left.projection_count === right.projection_count
  )
}
