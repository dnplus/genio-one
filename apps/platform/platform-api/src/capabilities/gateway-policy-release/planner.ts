import { createHash } from "node:crypto"

import {
  isCompiledAuthorizationBundle,
} from "../../../../../../runtimes/gateway/services/authorizer/signed-bundle"
import type { CompiledAuthorizationRule } from "../../../../../../packages/protocol/src/authorization"
import {
  validateGatewayRoutingArtifact,
  type GatewayRoutingArtifact,
} from "../../../../../../runtimes/gateway/services/shared/gateway-routing-artifact"
import {
  PROCESSOR_POLICY_BUNDLE_SCHEMA_VERSION,
  validateProcessorPolicyBundle,
  type ProcessorPolicyScope,
} from "../../../../../../runtimes/gateway/services/processor/contract"
import {
  POLICY_RELEASE_FILES,
  POLICY_RELEASE_SCHEMA_VERSION,
  type PolicyReleaseManifest,
} from "../../../../../../runtimes/gateway/services/shared/policy-release"
import {
  type CompactJwsSigner,
  type GatewayPolicyReleaseInput,
  type GatewayPolicyReleasePlan,
  type GatewayProjectionReleaseReference,
  type ProcessorPolicyBundle,
  type ReleaseFileArtifact,
  type ReleaseVerificationKey,
  type ReleaseVerificationKeyRing,
} from "./contract"

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value
}

function identifier(value: unknown, label: string): asserts value is string {
  if (!nonEmptyString(value) || value.length > 256 || /[\u0000\r\n]/.test(value)) {
    throw new Error(`${label} must be a non-empty identifier`)
  }
}

function positiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer`)
  }
}

function timestamp(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative integer timestamp`)
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left)
  const rightBytes = new TextEncoder().encode(right)
  const length = Math.min(leftBytes.length, rightBytes.length)
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!
    if (difference !== 0) return difference
  }
  return leftBytes.length - rightBytes.length
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareUtf8(left, right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    )
  }
  return value
}

/** Canonical bytes shared by release identity, artifacts, and manifest. */
export function canonicalGatewayPolicyReleaseBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(stableValue(value)))
}

function assertSigner(signer: CompactJwsSigner, label: string): void {
  if (
    !signer ||
    signer.algorithm !== "EdDSA" ||
    !nonEmptyString(signer.keyId) ||
    signer.keyId.length > 256
  ) {
    throw new Error(`${label} is invalid`)
  }
}

async function compactJws(payload: unknown, signer: CompactJwsSigner): Promise<Uint8Array> {
  assertSigner(signer, "JWS signer")
  const encodedHeader = Buffer.from(
    JSON.stringify({ alg: "EdDSA", kid: signer.keyId }),
    "utf8",
  ).toString("base64url")
  const encodedPayload = Buffer.from(canonicalGatewayPolicyReleaseBytes(payload)).toString(
    "base64url",
  )
  const signingInput = Buffer.from(`${encodedHeader}.${encodedPayload}`, "utf8")
  const signature = await signer.sign(signingInput)
  if (!nonEmptyString(signature) || /[\s.]/.test(signature)) {
    throw new Error("JWS signer returned an invalid signature")
  }
  return new TextEncoder().encode(`${encodedHeader}.${encodedPayload}.${signature}`)
}

function assertAuthorizationRule(value: unknown): asserts value is CompiledAuthorizationRule {
  if (!isRecord(value) || !hasExactKeys(value, [
    "rule_id",
    "disposition",
    "subject_ids",
    "acting_client_ids",
    "resource_id",
    "capability_id",
    "public_models",
    ...(value && typeof value === "object" && "mcp_tools" in value ? ["mcp_tools"] : []),
    ...(value && typeof value === "object" && "required_obligations" in value ? ["required_obligations"] : []),
  ])) {
    throw new Error("authorization bundle contains an invalid rule")
  }
  identifier(value.rule_id, "authorization rule_id")
  if (value.disposition !== "ALLOW" && value.disposition !== "DENY") {
    throw new Error("authorization rule disposition is invalid")
  }
  for (const [label, entries] of [
    ["subject_ids", value.subject_ids],
    ["acting_client_ids", value.acting_client_ids],
    ["public_models", value.public_models],
    ["required_obligations", value.required_obligations ?? []],
  ] as const) {
    if (!Array.isArray(entries) || entries.some((entry) => !nonEmptyString(entry))) {
      throw new Error(`authorization rule ${label} is invalid`)
    }
  }
  identifier(value.resource_id, "authorization resource_id")
  identifier(value.capability_id, "authorization capability_id")
}

function assertAuthorizationBundle(value: unknown): asserts value is GatewayPolicyReleaseInput["authorization_bundle"] {
  if (!isCompiledAuthorizationBundle(value) || !isRecord(value)) {
    throw new Error("authorization bundle is invalid")
  }
  if (!hasExactKeys(value, [
    "schema_version",
    "tenant_id",
    "revision",
    "policy_version",
    "issued_at",
    "expires_at",
    "rules",
    ...(value && "revoked_entitlement_ids" in value ? ["revoked_entitlement_ids"] : []),
    ...(value && "usage_policies" in value ? ["usage_policies"] : []),
    ...(value && "usage_contexts" in value ? ["usage_contexts"] : []),
    ...(value && "resource_owners" in value ? ["resource_owners"] : []),
    ...(value && "subject_contexts" in value ? ["subject_contexts"] : []),
    ...(value && "agent_delegations" in value ? ["agent_delegations"] : []),
    ...(value && "execution_grants" in value ? ["execution_grants"] : []),
  ])) {
    throw new Error("authorization bundle contains unknown fields")
  }
  if (!Array.isArray(value.rules)) throw new Error("authorization bundle rules are invalid")
  value.rules.forEach(assertAuthorizationRule)
  identifier(value.tenant_id, "authorization tenant_id")
  identifier(value.revision, "authorization revision")
  identifier(value.policy_version, "authorization policy_version")
  timestamp(value.issued_at, "authorization issued_at")
  timestamp(value.expires_at, "authorization expires_at")
  if (value.expires_at <= value.issued_at) {
    throw new Error("authorization bundle expiry must be after issue time")
  }
}

function assertVerificationKeyRing(value: unknown): asserts value is ReleaseVerificationKeyRing {
  if (!isRecord(value) || !hasExactKeys(value, ["schema_version", "keys"])) {
    throw new Error("enforcement verification keyring is invalid")
  }
  if (value.schema_version !== 1 || !Array.isArray(value.keys) || value.keys.length === 0) {
    throw new Error("enforcement verification keyring is invalid")
  }
  const ids: string[] = []
  for (const key of value.keys) {
    if (!isRecord(key) || !hasExactKeys(key, ["key_id", "public_key_pem"])) {
      throw new Error("enforcement verification keyring contains an invalid key")
    }
    identifier(key.key_id, "verification key_id")
    if (typeof key.public_key_pem !== "string" || !key.public_key_pem.trim()) {
      throw new Error("verification public key is invalid")
    }
    ids.push(key.key_id)
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error("enforcement verification keyring contains duplicate key ids")
  }
}

function normalizeVerificationKeyRing(value: ReleaseVerificationKeyRing): ReleaseVerificationKeyRing {
  const keys = [...value.keys]
    .map((key): ReleaseVerificationKey => ({
      key_id: key.key_id,
      public_key_pem: key.public_key_pem,
    }))
    .sort((left, right) => compareUtf8(left.key_id, right.key_id))
  return { schema_version: 1, keys }
}

function assertProcessorScope(value: unknown): asserts value is ProcessorPolicyScope {
  if (!isRecord(value) || !hasExactKeys(value, ["resource_id", "capability_id", "steps"])) {
    throw new Error("processor policy scope is invalid")
  }
  identifier(value.resource_id, "processor resource_id")
  identifier(value.capability_id, "processor capability_id")
  if (!Array.isArray(value.steps)) {
    throw new Error("processor policy scope steps are invalid")
  }
}

function assertProcessorPolicyBundle(value: unknown): asserts value is ProcessorPolicyBundle {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schema_version",
    "tenant_id",
    "revision",
    "policy_version",
    "issued_at",
    "expires_at",
    "scopes",
  ])) {
    throw new Error("processor policy bundle is invalid")
  }
  if (
    value.schema_version !== PROCESSOR_POLICY_BUNDLE_SCHEMA_VERSION ||
    !Array.isArray(value.scopes)
  ) {
    throw new Error("processor policy bundle is invalid")
  }
  identifier(value.tenant_id, "processor tenant_id")
  identifier(value.revision, "processor revision")
  identifier(value.policy_version, "processor policy_version")
  timestamp(value.issued_at, "processor issued_at")
  timestamp(value.expires_at, "processor expires_at")
  if (value.expires_at <= value.issued_at) {
    throw new Error("processor policy bundle expiry must be after issue time")
  }
  const scopeKeys = new Set<string>()
  for (const scope of value.scopes) {
    assertProcessorScope(scope)
    const key = `${scope.resource_id}\u0000${scope.capability_id}`
    if (scopeKeys.has(key)) throw new Error("processor policy bundle contains duplicate scope")
    scopeKeys.add(key)
  }
}

function assertGatewayRoutingArtifact(
  value: unknown,
): asserts value is GatewayRoutingArtifact {
  try {
    validateGatewayRoutingArtifact(value)
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Gateway routing artifact is invalid: ${error.message}`
        : "Gateway routing artifact is invalid",
    )
  }
}

function normalizeProcessorPolicyBundle(value: ProcessorPolicyBundle): ProcessorPolicyBundle {
  const scopes = [...value.scopes]
    .map((scope) => ({
      resource_id: scope.resource_id,
      capability_id: scope.capability_id,
      steps: scope.steps,
    }))
    .sort((left, right) => {
      const resourceOrder = compareUtf8(left.resource_id, right.resource_id)
      return resourceOrder !== 0
        ? resourceOrder
        : compareUtf8(left.capability_id, right.capability_id)
    })
  const normalized = {
    schema_version: PROCESSOR_POLICY_BUNDLE_SCHEMA_VERSION,
    tenant_id: value.tenant_id,
    revision: value.revision,
    policy_version: value.policy_version,
    issued_at: value.issued_at,
    expires_at: value.expires_at,
    scopes,
  }
  validateProcessorPolicyBundle(normalized)
  return normalized
}

function normalizeProjectionReferences(
  references: readonly GatewayProjectionReleaseReference[],
): GatewayProjectionReleaseReference[] {
  const publications = new Set<string>()
  const projections = new Set<string>()
  const normalized = references.map((reference) => {
    if (!isRecord(reference) || !hasExactKeys(reference, [
      "publication_id",
      "projection_id",
      "revision",
      "digest",
    ])) {
      throw new Error("Gateway projection reference is invalid")
    }
    identifier(reference.publication_id, "projection publication_id")
    identifier(reference.projection_id, "projection projection_id")
    positiveInteger(reference.revision, "projection revision")
    if (!/^[a-f0-9]{64}$/.test(reference.digest)) {
      throw new Error("projection digest is invalid")
    }
    if (publications.has(reference.publication_id)) {
      throw new Error("Gateway release contains duplicate publication_id")
    }
    if (projections.has(reference.projection_id)) {
      throw new Error("Gateway release contains duplicate projection_id")
    }
    publications.add(reference.publication_id)
    projections.add(reference.projection_id)
    return {
      publication_id: reference.publication_id,
      projection_id: reference.projection_id,
      revision: reference.revision,
      digest: reference.digest,
    }
  })
  normalized.sort((left, right) => {
    const publicationOrder = compareUtf8(left.publication_id, right.publication_id)
    return publicationOrder !== 0
      ? publicationOrder
      : compareUtf8(left.projection_id, right.projection_id)
  })
  return normalized
}

function assertTarget(target: GatewayPolicyReleaseInput["target"]): void {
  if (!isRecord(target) || !hasExactKeys(target, ["tenant_id", "runtime_id", "gateway_id"])) {
    throw new Error("Gateway release target is invalid")
  }
  identifier(target.tenant_id, "release tenant_id")
  identifier(target.runtime_id, "release runtime_id")
  identifier(target.gateway_id, "release gateway_id")
}

function fileArtifact(
  fileName: string,
  bytes: Uint8Array,
  keyId?: string,
): ReleaseFileArtifact {
  return {
    file_name: fileName,
    bytes,
    sha256: sha256(bytes),
    ...(keyId ? { key_id: keyId } : {}),
  }
}

/**
 * Build one immutable Gateway release. It deliberately emits a closed set of
 * projections and one scoped processor artifact, rather than planning one
 * independently mutable artifact per publication.
 */
export async function planGatewayPolicyRelease(
  input: GatewayPolicyReleaseInput,
): Promise<GatewayPolicyReleasePlan> {
  assertTarget(input.target)
  timestamp(input.issued_at, "release issued_at")
  timestamp(input.expires_at, "release expires_at")
  if (input.expires_at <= input.issued_at) {
    throw new Error("Gateway release expiry must be after issue time")
  }
  assertAuthorizationBundle(input.authorization_bundle)
  assertProcessorPolicyBundle(input.processor_policy)
  assertGatewayRoutingArtifact(input.gateway_routing_artifact)
  assertVerificationKeyRing(input.enforcement_verification_keys)
  assertSigner(input.artifact_signer, "artifact signer")
  assertSigner(input.release_root_signer, "release root signer")
  if (
    input.gateway_configuration !== undefined &&
    typeof input.gateway_configuration.capture_message_content !== "boolean"
  ) {
    throw new Error("gateway configuration is invalid")
  }

  if (input.authorization_bundle.tenant_id !== input.target.tenant_id) {
    throw new Error("authorization bundle tenant does not match release target")
  }
  if (input.processor_policy.tenant_id !== input.target.tenant_id) {
    throw new Error("processor policy tenant does not match release target")
  }
  if (input.gateway_routing_artifact.tenant_id !== input.target.tenant_id) {
    throw new Error("gateway routing artifact tenant does not match release target")
  }
  if (input.gateway_routing_artifact.gateway_id !== input.target.gateway_id) {
    throw new Error("gateway routing artifact gateway does not match release target")
  }
  if (
    input.processor_policy.revision !== input.authorization_bundle.revision ||
    input.processor_policy.policy_version !== input.authorization_bundle.policy_version
  ) {
    throw new Error("policy artifact revisions do not match release")
  }
  if (
    input.gateway_routing_artifact.revision !== input.authorization_bundle.revision ||
    input.gateway_routing_artifact.policy_version !== input.authorization_bundle.policy_version
  ) {
    throw new Error("gateway routing artifact revision does not match policy artifacts")
  }
  if (
    input.authorization_bundle.issued_at !== input.issued_at ||
    input.authorization_bundle.expires_at !== input.expires_at ||
    input.processor_policy.issued_at !== input.issued_at ||
    input.processor_policy.expires_at !== input.expires_at
  ) {
    throw new Error("policy artifact timestamps do not match release")
  }
  if (
    input.gateway_routing_artifact.issued_at !== input.issued_at ||
    input.gateway_routing_artifact.expires_at !== input.expires_at
  ) {
    throw new Error("gateway routing artifact timestamps do not match release")
  }
  if (input.enforcement_verification_keys.keys.every(
    (key) => key.key_id !== input.artifact_signer.keyId,
  )) {
    throw new Error("artifact signer is absent from enforcement verification keyring")
  }

  const projections = normalizeProjectionReferences(input.projections)
  const verificationKeyRing = normalizeVerificationKeyRing(input.enforcement_verification_keys)
  const processorPolicy = normalizeProcessorPolicyBundle(input.processor_policy)
  const authorizationBytes = await compactJws(input.authorization_bundle, input.artifact_signer)
  const processorBytes = await compactJws(processorPolicy, input.artifact_signer)
  const gatewayRoutingBytes = await compactJws(
    input.gateway_routing_artifact,
    input.artifact_signer,
  )
  const verificationKeyRingBytes = canonicalGatewayPolicyReleaseBytes(verificationKeyRing)
  const authorizationArtifact = fileArtifact(
    POLICY_RELEASE_FILES.authorizationBundle,
    authorizationBytes,
    input.artifact_signer.keyId,
  )
  const processorArtifact = fileArtifact(
    POLICY_RELEASE_FILES.processorPolicyBundle,
    processorBytes,
    input.artifact_signer.keyId,
  )
  const gatewayRoutingArtifact = fileArtifact(
    POLICY_RELEASE_FILES.gatewayRoutingArtifact,
    gatewayRoutingBytes,
    input.artifact_signer.keyId,
  )
  const verificationKeyRingArtifact = fileArtifact(
    POLICY_RELEASE_FILES.verificationKeyRing,
    verificationKeyRingBytes,
  )

  const commonIdentity = {
    schema_version: POLICY_RELEASE_SCHEMA_VERSION,
    tenant_id: input.target.tenant_id,
    gateway_id: input.target.gateway_id,
    issued_at: input.issued_at,
    expires_at: input.expires_at,
    authorization_bundle: {
      sha256: authorizationArtifact.sha256,
      key_id: input.artifact_signer.keyId,
      tenant_id: input.authorization_bundle.tenant_id,
      revision: input.authorization_bundle.revision,
      policy_version: input.authorization_bundle.policy_version,
      issued_at: input.authorization_bundle.issued_at,
      expires_at: input.authorization_bundle.expires_at,
    },
    processor_policy: {
      sha256: processorArtifact.sha256,
      key_id: input.artifact_signer.keyId,
      tenant_id: processorPolicy.tenant_id,
      revision: processorPolicy.revision,
      policy_version: processorPolicy.policy_version,
      issued_at: processorPolicy.issued_at,
      expires_at: processorPolicy.expires_at,
    },
    gateway_routing_artifact: {
      sha256: gatewayRoutingArtifact.sha256,
      key_id: input.artifact_signer.keyId,
      tenant_id: input.gateway_routing_artifact.tenant_id,
      gateway_id: input.gateway_routing_artifact.gateway_id,
      revision: input.gateway_routing_artifact.revision,
      policy_version: input.gateway_routing_artifact.policy_version,
      issued_at: input.gateway_routing_artifact.issued_at,
      expires_at: input.gateway_routing_artifact.expires_at,
    },
    enforcement_verification_keys: {
      sha256: verificationKeyRingArtifact.sha256,
      key_ids: verificationKeyRing.keys.map((key) => key.key_id),
    },
    gateway_configuration: {
      capture_message_content: input.gateway_configuration?.capture_message_content ?? false,
    },
    gateway_projections: projections,
  }
  // A release ID identifies the immutable artifact/projection set for one
  // gateway. Runtime placement is deliberately kept in the signed manifest
  // so the same gateway content can be planned for different runtime targets
  // without changing its content identity.
  const releaseId = `release-${sha256(canonicalGatewayPolicyReleaseBytes(commonIdentity))}`
  const identity = {
    ...commonIdentity,
    runtime_id: input.target.runtime_id,
    gateway_id: input.target.gateway_id,
  }
  const manifest: PolicyReleaseManifest = {
    ...identity,
    release_id: releaseId,
  }
  const manifestBytes = await compactJws(manifest, input.release_root_signer)

  return {
    release_id: releaseId,
    release_directory: `releases/${releaseId}`,
    target: { ...input.target },
    manifest,
    manifest_jws: fileArtifact(
      POLICY_RELEASE_FILES.manifest,
      manifestBytes,
      input.release_root_signer.keyId,
    ),
    authorization_bundle: authorizationArtifact,
    processor_policy: processorArtifact,
    gateway_routing_artifact: gatewayRoutingArtifact,
    enforcement_verification_keys: verificationKeyRingArtifact,
  }
}
