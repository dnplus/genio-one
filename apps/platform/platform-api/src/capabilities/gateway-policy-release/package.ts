import { createHash } from "node:crypto"

import { Type, type Static } from "typebox"
import { Check } from "typebox/value"

import {
  GatewayProjectionSchema,
  type GatewayProjection,
} from "../gateway-projection/contract"
import {
  validateGatewayRoutingArtifact,
  type GatewayRoutingArtifact,
} from "../../../../../../runtimes/gateway/services/shared/gateway-routing-artifact"
import {
  GatewayReleaseReferenceSchema,
  type GatewayReleaseReference,
} from "../../../../../../packages/protocol/src/gateway-release"
import { GATEWAY_RELEASE_REFERENCE_SCHEMA_VERSION } from "../../../../../../packages/protocol/src/runtime-command"
import type {
  GatewayProjectionReleaseReference,
  ReleaseFileArtifact,
} from "./contract"
import type { SavedGatewayPolicyRelease } from "./module"
import { canonicalGatewayPolicyReleaseBytes } from "./planner"
import { isPolicyReleaseManifest } from "../../../../../../runtimes/gateway/services/shared/policy-release"

/** Versioned wire format consumed by a Gateway release controller. */
export const GATEWAY_RELEASE_PACKAGE_SCHEMA_VERSION =
  "genio.one.gateway-release.v1" as const

const Identifier = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[^\\u0000\\r\\n]+$",
})
const ReleaseId = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
})
const Digest = Type.String({ pattern: "^[a-f0-9]{64}$" })
const TextArtifact = Type.String({ minLength: 1, maxLength: 16 * 1024 * 1024 })
const JsonInteger = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
const PositiveJsonInteger = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })

const StrictObject = <Properties extends Record<string, object>>(properties: Properties) =>
  Type.Object(properties, { additionalProperties: false })

const GatewayReleasePackageConfigurationSchema = StrictObject({
  capture_message_content: Type.Boolean(),
})

/**
 * The reference is deliberately repeated beside its immutable document. A
 * release controller can verify the closed set before parsing the projection
 * payload, while the projection remains the existing native projection
 * contract (including its intentionally open Kubernetes spec maps).
 */
const GatewayReleasePackageProjectionReferenceSchema = StrictObject({
  publication_id: Identifier,
  projection_id: Identifier,
  revision: PositiveJsonInteger,
  digest: Digest,
})

const GatewayReleasePackageProjectionSchema = StrictObject({
  reference: GatewayReleasePackageProjectionReferenceSchema,
  projection: GatewayProjectionSchema,
})

/**
 * A package is one target-specific, immutable handoff. Artifact content is
 * represented as exact UTF-8 strings so JSON transport cannot silently alter
 * the signed JWS or keyring bytes.
 */
export const GatewayReleasePackageSchema = StrictObject({
  schema_version: Type.Literal(GATEWAY_RELEASE_PACKAGE_SCHEMA_VERSION),
  tenant_id: Identifier,
  runtime_id: Identifier,
  gateway_id: Identifier,
  release_id: ReleaseId,
  head_revision: PositiveJsonInteger,
  package_digest: Digest,
  projection_count: JsonInteger,
  manifest_jws: TextArtifact,
  authorization_bundle_jws: TextArtifact,
  processor_policy_jws: TextArtifact,
  gateway_routing_artifact_jws: TextArtifact,
  enforcement_verification_keys_json: TextArtifact,
  gateway_configuration: GatewayReleasePackageConfigurationSchema,
  projections: Type.Array(GatewayReleasePackageProjectionSchema),
})

export type GatewayReleasePackage = Static<typeof GatewayReleasePackageSchema>
export type GatewayReleasePackageProjection = Static<
  typeof GatewayReleasePackageProjectionSchema
>

export interface BuildGatewayReleasePackageInput {
  saved: SavedGatewayPolicyRelease
  /** The exact immutable projection documents named by `saved.release`. */
  projections: readonly GatewayProjection[]
}

export interface GatewayReleasePackageBuildResult {
  package: GatewayReleasePackage
  reference: GatewayReleaseReference
}

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
    throw new Error(`${label} is invalid`)
  }
}

function releaseId(value: unknown, label: string): asserts value is string {
  identifier(value, label)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${label} is invalid`)
  }
}

function positiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} is invalid`)
  }
}

function digest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} is invalid`)
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

function projectionKey(reference: Pick<GatewayProjectionReleaseReference, "publication_id" | "projection_id">): string {
  return `${reference.publication_id}\u0000${reference.projection_id}`
}

function exactUtf8(bytes: Uint8Array, label: string): string {
  if (bytes.byteLength === 0) throw new Error(`${label} is empty`)
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`${label} is not valid UTF-8`)
  }
  const encoded = new TextEncoder().encode(text)
  if (!Buffer.from(encoded).equals(Buffer.from(bytes))) {
    throw new Error(`${label} is not an exact UTF-8 representation`)
  }
  return text
}

function artifactText(
  artifact: ReleaseFileArtifact,
  expectedFileName: string,
  label: string,
): string {
  if (
    !isRecord(artifact) ||
    artifact.file_name !== expectedFileName ||
    !(artifact.bytes instanceof Uint8Array) ||
    artifact.bytes.byteLength === 0 ||
    typeof artifact.sha256 !== "string" ||
    artifact.sha256 !== sha256(artifact.bytes)
  ) {
    throw new Error(`${label} artifact is invalid`)
  }
  return exactUtf8(artifact.bytes, label)
}

interface CompactJwsDocument {
  key_id: string
  payload: unknown
}

function compactJwsDocument(value: string, label: string): CompactJwsDocument {
  const parts = value.split(".")
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error(`${label} is not a compact JWS`)
  }
  try {
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as unknown
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as unknown
    if (
      !isRecord(header) ||
      !hasExactKeys(header, ["alg", "kid"]) ||
      header.alg !== "EdDSA" ||
      !nonEmptyString(header.kid)
    ) {
      throw new Error("invalid JWS header")
    }
    return { key_id: header.kid, payload }
  } catch {
    throw new Error(`${label} is invalid`)
  }
}

function validatedGatewayRoutingArtifact(value: unknown): GatewayRoutingArtifact {
  try {
    return validateGatewayRoutingArtifact(value)
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `gateway routing artifact is invalid: ${error.message}`
        : "gateway routing artifact is invalid",
    )
  }
}

function assertGatewayRoutingArtifactMetadata(
  artifact: GatewayRoutingArtifact,
  manifest: SavedGatewayPolicyRelease["manifest"]["manifest"],
): void {
  const metadata = manifest.gateway_routing_artifact
  if (
    artifact.tenant_id !== metadata.tenant_id ||
    artifact.gateway_id !== metadata.gateway_id ||
    artifact.revision !== metadata.revision ||
    artifact.policy_version !== metadata.policy_version ||
    artifact.issued_at !== metadata.issued_at ||
    artifact.expires_at !== metadata.expires_at
  ) {
    throw new Error("gateway routing artifact payload does not match manifest")
  }
}

function artifactMetadataMatches(
  artifact: ReleaseFileArtifact,
  expected: {
    sha256: string
    key_id: string
  },
  label: string,
): void {
  if (artifact.sha256 !== expected.sha256 || artifact.key_id !== expected.key_id) {
    throw new Error(`${label} metadata does not match manifest`)
  }
}

function assertSignedManifest(
  manifestText: string,
  manifest: SavedGatewayPolicyRelease["manifest"]["manifest"],
  artifact: ReleaseFileArtifact,
): void {
  const decoded = compactJwsDocument(manifestText, "manifest JWS")
  if (
    decoded.key_id !== artifact.key_id ||
    !Buffer.from(canonicalGatewayPolicyReleaseBytes(decoded.payload)).equals(
      Buffer.from(canonicalGatewayPolicyReleaseBytes(manifest)),
    )
  ) {
    throw new Error("manifest JWS payload does not match saved manifest")
  }
}

function assertKeyRingJson(
  keyRingText: string,
  expected: { sha256: string; key_ids: readonly string[] },
): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(keyRingText) as unknown
  } catch {
    throw new Error("enforcement verification keyring is invalid JSON")
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, ["schema_version", "keys"]) ||
      parsed.schema_version !== 1 || !Array.isArray(parsed.keys)) {
    throw new Error("enforcement verification keyring is invalid")
  }
  const keyIds = parsed.keys.map((entry) => {
    if (!isRecord(entry) || !hasExactKeys(entry, ["key_id", "public_key_pem"]) ||
        !nonEmptyString(entry.key_id) ||
        typeof entry.public_key_pem !== "string" ||
        entry.public_key_pem.trim().length === 0) {
      throw new Error("enforcement verification keyring is invalid")
    }
    return entry.key_id
  })
  if (
    sha256(new TextEncoder().encode(keyRingText)) !== expected.sha256 ||
    keyIds.length !== expected.key_ids.length ||
    keyIds.some((keyId, index) => keyId !== expected.key_ids[index])
  ) {
    throw new Error("enforcement verification keyring does not match manifest")
  }
}

function assertReference(
  value: unknown,
  label: string,
): asserts value is GatewayProjectionReleaseReference {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["publication_id", "projection_id", "revision", "digest"])
  ) {
    throw new Error(`${label} is invalid`)
  }
  identifier(value.publication_id, `${label} publication_id`)
  identifier(value.projection_id, `${label} projection_id`)
  positiveInteger(value.revision, `${label} revision`)
  digest(value.digest, `${label} digest`)
}

function assertManifestTarget(saved: SavedGatewayPolicyRelease): void {
  const { target, release, manifest, head } = saved
  if (!isRecord(target) || !hasExactKeys(target, ["tenant_id", "runtime_id", "gateway_id"])) {
    throw new Error("saved Gateway release target is invalid")
  }
  identifier(target.tenant_id, "release tenant_id")
  identifier(target.runtime_id, "release runtime_id")
  identifier(target.gateway_id, "release gateway_id")
  releaseId(release.release_id, "release release_id")
  identifier(release.tenant_id, "release tenant_id")
  identifier(release.gateway_id, "release gateway_id")
  identifier(manifest.tenant_id, "manifest tenant_id")
  identifier(manifest.runtime_id, "manifest runtime_id")
  identifier(manifest.gateway_id, "manifest gateway_id")
  identifier(head.tenant_id, "head tenant_id")
  identifier(head.gateway_id, "head gateway_id")
  releaseId(head.release_id, "head release_id")
  digest(release.content_digest, "release content_digest")
  digest(head.content_digest, "head content_digest")
  positiveInteger(head.head_revision, "head head_revision")
  if (!Array.isArray(release.projections)) {
    throw new Error("saved Gateway release projections are invalid")
  }

  if (
    release.release_id !== `release-${release.content_digest}` ||
    release.tenant_id !== target.tenant_id ||
    release.gateway_id !== target.gateway_id ||
    release.release_id !== head.release_id ||
    release.content_digest !== head.content_digest ||
    manifest.tenant_id !== target.tenant_id ||
    manifest.runtime_id !== target.runtime_id ||
    manifest.gateway_id !== target.gateway_id ||
    manifest.release_id !== release.release_id ||
    !isPolicyReleaseManifest(manifest.manifest) ||
    manifest.manifest.tenant_id !== target.tenant_id ||
    manifest.manifest.runtime_id !== target.runtime_id ||
    manifest.manifest.gateway_id !== target.gateway_id ||
    manifest.manifest.release_id !== release.release_id ||
    manifest.manifest.gateway_projections.length !== release.projections.length
  ) {
    throw new Error("saved Gateway release target does not match release, manifest, and head")
  }
}

function normalizedReferences(
  saved: SavedGatewayPolicyRelease,
): GatewayProjectionReleaseReference[] {
  const references = saved.release.projections.map((reference, index) => {
    assertReference(reference, `saved projection reference ${index}`)
    return {
      publication_id: reference.publication_id,
      projection_id: reference.projection_id,
      revision: reference.revision,
      digest: reference.digest,
    }
  })
  const seenPublications = new Set<string>()
  const seenProjections = new Set<string>()
  for (const reference of references) {
    if (seenPublications.has(reference.publication_id)) {
      throw new Error("saved Gateway release contains duplicate publication_id")
    }
    if (seenProjections.has(reference.projection_id)) {
      throw new Error("saved Gateway release contains duplicate projection_id")
    }
    seenPublications.add(reference.publication_id)
    seenProjections.add(reference.projection_id)
  }
  references.sort((left, right) => {
    const publicationOrder = compareUtf8(left.publication_id, right.publication_id)
    return publicationOrder !== 0
      ? publicationOrder
      : compareUtf8(left.projection_id, right.projection_id)
  })
  return references
}

function assertManifestReferences(
  saved: SavedGatewayPolicyRelease,
  references: readonly GatewayProjectionReleaseReference[],
): void {
  const manifestReferences = saved.manifest.manifest.gateway_projections
  if (manifestReferences.length !== references.length) {
    throw new Error("saved Gateway release manifest projection set does not match release")
  }
  const expected = references.map(projectionKey).sort(compareUtf8)
  const actual = manifestReferences.map((reference, index) => {
    assertReference(reference, `manifest projection reference ${index}`)
    return projectionKey(reference)
  }).sort(compareUtf8)
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    throw new Error("saved Gateway release manifest projection set does not match release")
  }
  for (const reference of references) {
    const manifestReference = manifestReferences.find(
      (candidate) => candidate.publication_id === reference.publication_id &&
        candidate.projection_id === reference.projection_id,
    )
    if (
      !manifestReference ||
      manifestReference.revision !== reference.revision ||
      manifestReference.digest !== reference.digest
    ) {
      throw new Error("saved Gateway release manifest projection reference does not match release")
    }
  }
}

function buildProjectionEntries(
  saved: SavedGatewayPolicyRelease,
  references: readonly GatewayProjectionReleaseReference[],
  projections: readonly GatewayProjection[],
): GatewayReleasePackageProjection[] {
  const expectedByKey = new Map<string, GatewayProjectionReleaseReference>()
  for (const reference of references) expectedByKey.set(projectionKey(reference), reference)

  const seenPublications = new Set<string>()
  const seenProjections = new Set<string>()
  const actualByKey = new Map<string, GatewayProjection>()
  for (const [index, projection] of projections.entries()) {
    if (!Check(GatewayProjectionSchema, projection)) {
      throw new Error(`Gateway projection ${index} does not satisfy its schema`)
    }
    if (projection.operation !== "APPLY") {
      throw new Error("Gateway release package cannot include a DELETE projection")
    }
    identifier(projection.tenant_id, `Gateway projection ${index} tenant_id`)
    identifier(projection.publication_id, `Gateway projection ${index} publication_id`)
    identifier(projection.projection_id, `Gateway projection ${index} projection_id`)
    positiveInteger(projection.revision, `Gateway projection ${index} revision`)
    digest(projection.digest, `Gateway projection ${index} digest`)
    identifier(projection.publication_endpoint.gateway_id, `Gateway projection ${index} gateway_id`)
    if (seenPublications.has(projection.publication_id)) {
      throw new Error("Gateway release package contains duplicate publication_id")
    }
    if (seenProjections.has(projection.projection_id)) {
      throw new Error("Gateway release package contains duplicate projection_id")
    }
    seenPublications.add(projection.publication_id)
    seenProjections.add(projection.projection_id)
    const key = projectionKey(projection)
    if (actualByKey.has(key)) throw new Error("Gateway release package contains duplicate projection")
    actualByKey.set(key, projection)
  }

  if (actualByKey.size !== expectedByKey.size) {
    throw new Error("Gateway release package projection set does not match saved release")
  }
  const entries = references.map((reference) => {
    const projection = actualByKey.get(projectionKey(reference))
    if (!projection) throw new Error("Gateway release package is missing a projection document")
    if (
      projection.tenant_id !== saved.target.tenant_id ||
      projection.publication_endpoint.gateway_id !== saved.target.gateway_id ||
      projection.publication_id !== reference.publication_id ||
      projection.projection_id !== reference.projection_id ||
      projection.revision !== reference.revision ||
      projection.digest !== reference.digest
    ) {
      throw new Error("Gateway release package projection does not match its reference")
    }
    return {
      reference: { ...reference },
      projection,
    }
  })
  if (entries.length !== actualByKey.size) {
    throw new Error("Gateway release package contains an extra projection document")
  }
  return entries
}

/**
 * Assemble one target-specific package from a persisted release and its
 * immutable projection documents. The function is pure and intentionally
 * rejects any document outside the release's closed membership set.
 */
export function buildGatewayReleasePackage(
  input: BuildGatewayReleasePackageInput,
): GatewayReleasePackageBuildResult {
  if (!isRecord(input) || !Array.isArray(input.projections)) {
    throw new Error("Gateway release package input is invalid")
  }
  assertManifestTarget(input.saved)
  const references = normalizedReferences(input.saved)
  digest(input.saved.release.projection_set_digest, "release projection_set_digest")
  if (
    input.saved.release.projection_set_digest !==
    sha256(canonicalGatewayPolicyReleaseBytes(references))
  ) {
    throw new Error("saved Gateway release projection set digest does not match projections")
  }
  assertManifestReferences(input.saved, references)

  const manifestJws = artifactText(
    input.saved.manifest.manifest_jws,
    "manifest.jws",
    "manifest JWS",
  )
  const authorizationBundleJws = artifactText(
    input.saved.release.authorization_bundle,
    "authorization-bundle.jws",
    "authorization bundle JWS",
  )
  const processorPolicyJws = artifactText(
    input.saved.release.processor_policy,
    "processor-policy.jws",
    "processor policy JWS",
  )
  const gatewayRoutingArtifactJws = artifactText(
    input.saved.release.gateway_routing_artifact,
    "gateway-routing-artifact.jws",
    "gateway routing artifact JWS",
  )
  const enforcementVerificationKeysJson = artifactText(
    input.saved.release.enforcement_verification_keys,
    "enforcement-verification-keys.json",
    "enforcement verification keyring",
  )
  artifactMetadataMatches(
    input.saved.release.authorization_bundle,
    input.saved.manifest.manifest.authorization_bundle,
    "authorization bundle JWS",
  )
  artifactMetadataMatches(
    input.saved.release.processor_policy,
    input.saved.manifest.manifest.processor_policy,
    "processor policy JWS",
  )
  artifactMetadataMatches(
    input.saved.release.gateway_routing_artifact,
    input.saved.manifest.manifest.gateway_routing_artifact,
    "gateway routing artifact JWS",
  )
  if (!input.saved.manifest.manifest_jws.key_id) {
    throw new Error("manifest JWS key id is missing")
  }
  assertSignedManifest(
    manifestJws,
    input.saved.manifest.manifest,
    input.saved.manifest.manifest_jws,
  )
  const authorizationJws = compactJwsDocument(
    authorizationBundleJws,
    "authorization bundle JWS",
  )
  const processorJws = compactJwsDocument(processorPolicyJws, "processor policy JWS")
  const gatewayRoutingJws = compactJwsDocument(
    gatewayRoutingArtifactJws,
    "gateway routing artifact JWS",
  )
  if (
    authorizationJws.key_id !== input.saved.release.authorization_bundle.key_id ||
    processorJws.key_id !== input.saved.release.processor_policy.key_id ||
    gatewayRoutingJws.key_id !== input.saved.release.gateway_routing_artifact.key_id
  ) {
    throw new Error("policy artifact JWS key id does not match saved artifact")
  }
  assertGatewayRoutingArtifactMetadata(
    validatedGatewayRoutingArtifact(gatewayRoutingJws.payload),
    input.saved.manifest.manifest,
  )
  assertKeyRingJson(
    enforcementVerificationKeysJson,
    input.saved.manifest.manifest.enforcement_verification_keys,
  )
  // Validate the signed manifest's parsed shape before copying its bytes into
  // the package. The Postgres mapper does the same check, but this assembler
  // is also used with a memory/test store.
  if (
    !Check(GatewayReleaseReferenceSchema, {
      schema_version: GATEWAY_RELEASE_REFERENCE_SCHEMA_VERSION,
      release_id: input.saved.release.release_id,
      gateway_id: input.saved.target.gateway_id,
      head_revision: input.saved.head.head_revision,
      package_digest: "0".repeat(64),
      projection_count: references.length,
    })
  ) {
    throw new Error("saved Gateway release head is invalid")
  }

  const entries = buildProjectionEntries(input.saved, references, input.projections)
  const withoutDigest = {
    schema_version: GATEWAY_RELEASE_PACKAGE_SCHEMA_VERSION,
    tenant_id: input.saved.target.tenant_id,
    runtime_id: input.saved.target.runtime_id,
    gateway_id: input.saved.target.gateway_id,
    release_id: input.saved.release.release_id,
    head_revision: input.saved.head.head_revision,
    projection_count: entries.length,
    manifest_jws: manifestJws,
    authorization_bundle_jws: authorizationBundleJws,
    processor_policy_jws: processorPolicyJws,
    gateway_routing_artifact_jws: gatewayRoutingArtifactJws,
    enforcement_verification_keys_json: enforcementVerificationKeysJson,
    gateway_configuration: {
      capture_message_content:
        input.saved.manifest.manifest.gateway_configuration.capture_message_content,
    },
    projections: entries,
  }
  const packageDigest = sha256(canonicalGatewayPolicyReleaseBytes(withoutDigest))
  const packageValue = {
    ...withoutDigest,
    package_digest: packageDigest,
  } as GatewayReleasePackage
  if (!Check(GatewayReleasePackageSchema, packageValue)) {
    throw new Error("assembled Gateway release package is invalid")
  }

  const reference = {
    schema_version: GATEWAY_RELEASE_REFERENCE_SCHEMA_VERSION,
    release_id: packageValue.release_id,
    gateway_id: packageValue.gateway_id,
    head_revision: packageValue.head_revision,
    package_digest: packageValue.package_digest,
    projection_count: packageValue.projection_count,
  } satisfies GatewayReleaseReference
  if (!Check(GatewayReleaseReferenceSchema, reference)) {
    throw new Error("assembled Gateway release reference is invalid")
  }
  return { package: packageValue, reference }
}

/** Canonical digest input is exported for runtime-control and persistence tests. */
export function gatewayReleasePackageDigest(
  value: Omit<GatewayReleasePackage, "package_digest">,
): string {
  return sha256(canonicalGatewayPolicyReleaseBytes(value))
}
