import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"

import type { CompiledAuthorizationBundle } from "../../../../packages/protocol/src/authorization"
import { isCompiledAuthorizationBundle } from "../authorizer/signed-bundle"
import type { ProcessorPolicyBundle } from "../processor/contract"
import { validateProcessorPolicyBundle } from "../processor/contract"
import {
  validateGatewayRoutingArtifact,
  type GatewayRoutingArtifact,
} from "./gateway-routing-artifact"
import {
  verifyCompactEdDsaJws,
  type VerificationKeyRing,
} from "../../../../packages/protocol/src/compact-jws"
import {
  verifyGatewayRuntimeCommand,
  type GatewayReleaseReference,
} from "../../../../packages/protocol/src/runtime-command"

export {
  isGatewayReleaseReference,
  type GatewayReleaseReference,
} from "../../../../packages/protocol/src/runtime-command"

export const POLICY_RELEASE_SCHEMA_VERSION = 2 as const

export const POLICY_RELEASE_FILES = {
  authorizationBundle: "authorization-bundle.jws",
  processorPolicyBundle: "processor-policy.jws",
  gatewayRoutingArtifact: "gateway-routing-artifact.jws",
  verificationKeyRing: "enforcement-verification-keys.json",
  manifest: "manifest.jws",
  runtimeCommand: "runtime-command.json",
} as const

export interface PolicyReleaseTarget {
  tenantId: string
  runtimeId: string
  gatewayId: string
}

export interface PolicyReleaseArtifact {
  sha256: string
  key_id: string
}

export interface PolicyReleaseAuthorizationArtifact extends PolicyReleaseArtifact {
  tenant_id: string
  revision: string
  policy_version: string
  issued_at: number
  expires_at: number
}

export interface PolicyReleaseProcessorArtifact extends PolicyReleaseArtifact {
  tenant_id: string
  revision: string
  policy_version: string
  issued_at: number
  expires_at: number
}

export interface PolicyReleaseGatewayRoutingArtifact extends PolicyReleaseArtifact {
  tenant_id: string
  gateway_id: string
  revision: string
  policy_version: string
  issued_at: number
  expires_at: number
}

export interface PolicyReleaseKeyRingArtifact {
  sha256: string
  key_ids: string[]
}

export interface PolicyReleaseProjectionReference {
  publication_id: string
  projection_id: string
  revision: number
  digest: string
}

export interface PolicyReleaseGatewayConfiguration {
  capture_message_content: boolean
}

export interface PolicyReleaseManifest {
  schema_version: typeof POLICY_RELEASE_SCHEMA_VERSION
  release_id: string
  tenant_id: string
  runtime_id: string
  gateway_id: string
  issued_at: number
  expires_at: number
  authorization_bundle: PolicyReleaseAuthorizationArtifact
  processor_policy: PolicyReleaseProcessorArtifact
  gateway_routing_artifact: PolicyReleaseGatewayRoutingArtifact
  enforcement_verification_keys: PolicyReleaseKeyRingArtifact
  gateway_configuration: PolicyReleaseGatewayConfiguration
  gateway_projections: PolicyReleaseProjectionReference[]
}

export type PolicyReleasePointerSource = "CURRENT" | "LKG"

export interface PolicyReleaseObservation {
  source: PolicyReleasePointerSource
  releaseReference: GatewayReleaseReference
}

export interface LoadedPolicyRelease {
  releaseId: string
  source: PolicyReleasePointerSource
  releaseReference: GatewayReleaseReference
  manifest: PolicyReleaseManifest
  authorizationBundle: CompiledAuthorizationBundle
  processorPolicyBundle: ProcessorPolicyBundle
  gatewayRoutingArtifact: GatewayRoutingArtifact
  verificationKeyRing: VerificationKeyRing
}

export interface PolicyReleaseLoaderOptions {
  /** Directory containing immutable `<release_id>/...` release directories. */
  releasesPath: string
  currentPointerPath: string
  lastKnownGoodPointerPath: string
  /** External trust root. It must not be stored inside a mutable release. */
  releaseRootKeyRingPath: string
  /** Platform command trust root used to bind the complete release reference. */
  runtimeCommandKeyRingPath: string
  target: PolicyReleaseTarget
  now?: () => number
}

export interface PolicyReleaseSource {
  current(): Promise<LoadedPolicyRelease>
  releaseObservation(): Promise<PolicyReleaseObservation>
}

function requiredEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

export function policyReleaseLoaderOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): PolicyReleaseLoaderOptions {
  const policyRoot = environment.GENIO_ONE_POLICY_ROOT ?? "/var/lib/genio-one/policy"
  return {
    releasesPath: environment.GENIO_ONE_POLICY_RELEASES ?? join(policyRoot, "releases"),
    currentPointerPath:
      environment.GENIO_ONE_POLICY_CURRENT_POINTER ?? join(policyRoot, "current"),
    lastKnownGoodPointerPath:
      environment.GENIO_ONE_POLICY_LKG_POINTER ?? join(policyRoot, "lkg"),
    releaseRootKeyRingPath:
      environment.GENIO_ONE_POLICY_RELEASE_ROOT_KEYRING ??
      "/var/run/secrets/genio-one/policy-release-root-keys.json",
    runtimeCommandKeyRingPath:
      environment.GENIO_ONE_RUNTIME_COMMAND_KEYRING ??
      "/var/run/secrets/genio-one/runtime-command-verification-keys.json",
    target: {
      tenantId: requiredEnvironmentValue(environment, "GENIO_ONE_TENANT_ID"),
      runtimeId: requiredEnvironmentValue(environment, "GENIO_ONE_RUNTIME_ID"),
      gatewayId: requiredEnvironmentValue(environment, "GENIO_ONE_GATEWAY_ID"),
    },
  }
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

function isIdentifier(value: unknown): value is string {
  return (
    nonEmptyString(value) &&
    value.length <= 256 &&
    !/[\u0000\r\n]/.test(value)
  )
}

function presentString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isSafeReleaseId(value: unknown): value is string {
  return (
    nonEmptyString(value) &&
    value.length <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
  )
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isIdentifier)
}

function isSortedUnique(values: readonly string[]): boolean {
  return values.every(
    (value, index) =>
      index === 0 ||
      Buffer.compare(Buffer.from(values[index - 1], "utf8"), Buffer.from(value, "utf8")) < 0,
  )
}

function isArtifact(value: unknown): value is PolicyReleaseArtifact {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["sha256", "key_id"]) &&
    isSha256(value.sha256) &&
    isIdentifier(value.key_id)
  )
}

const POLICY_ARTIFACT_KEYS = [
  "sha256",
  "key_id",
  "tenant_id",
  "revision",
  "policy_version",
  "issued_at",
  "expires_at",
] as const

const GATEWAY_ROUTING_ARTIFACT_KEYS = [
  "sha256",
  "key_id",
  "tenant_id",
  "gateway_id",
  "revision",
  "policy_version",
  "issued_at",
  "expires_at",
] as const

function isPolicyArtifact(
  value: unknown,
): value is PolicyReleaseAuthorizationArtifact | PolicyReleaseProcessorArtifact {
  return (
    isRecord(value) &&
    hasExactKeys(value, POLICY_ARTIFACT_KEYS) &&
    isArtifact({ sha256: value.sha256, key_id: value.key_id }) &&
    isIdentifier(value.tenant_id) &&
    isIdentifier(value.revision) &&
    isIdentifier(value.policy_version) &&
    isTimestamp(value.issued_at) &&
    isTimestamp(value.expires_at) &&
    value.expires_at > value.issued_at
  )
}

function isGatewayRoutingArtifactMetadata(
  value: unknown,
): value is PolicyReleaseGatewayRoutingArtifact {
  return (
    isRecord(value) &&
    hasExactKeys(value, GATEWAY_ROUTING_ARTIFACT_KEYS) &&
    isArtifact({ sha256: value.sha256, key_id: value.key_id }) &&
    isIdentifier(value.tenant_id) &&
    isIdentifier(value.gateway_id) &&
    isIdentifier(value.revision) &&
    isIdentifier(value.policy_version) &&
    isTimestamp(value.issued_at) &&
    isTimestamp(value.expires_at) &&
    value.expires_at > value.issued_at
  )
}

function isKeyRingArtifact(value: unknown): value is PolicyReleaseKeyRingArtifact {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["sha256", "key_ids"]) &&
    isSha256(value.sha256) &&
    stringArray(value.key_ids) &&
    isSortedUnique(value.key_ids)
  )
}

function projectionKey(value: PolicyReleaseProjectionReference): string {
  return `${value.publication_id}\u0000${value.projection_id}`
}

function isProjectionReference(value: unknown): value is PolicyReleaseProjectionReference {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["publication_id", "projection_id", "revision", "digest"]) &&
    isIdentifier(value.publication_id) &&
    isIdentifier(value.projection_id) &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 1 &&
    isSha256(value.digest)
  )
}

function isClosedProjectionSet(value: unknown): value is PolicyReleaseProjectionReference[] {
  if (!Array.isArray(value) || !value.every(isProjectionReference)) return false
  const keys = value.map(projectionKey)
  if (!isSortedUnique(keys)) return false
  const publicationIds = value.map((projection) => projection.publication_id)
  const projectionIds = value.map((projection) => projection.projection_id)
  return (
    new Set(publicationIds).size === publicationIds.length &&
    new Set(projectionIds).size === projectionIds.length
  )
}

function isGatewayConfiguration(value: unknown): value is PolicyReleaseGatewayConfiguration {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["capture_message_content"]) &&
    typeof value.capture_message_content === "boolean"
  )
}

export function isPolicyReleaseManifest(value: unknown): value is PolicyReleaseManifest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schema_version",
      "release_id",
      "tenant_id",
      "runtime_id",
      "gateway_id",
      "issued_at",
      "expires_at",
      "authorization_bundle",
      "processor_policy",
      "gateway_routing_artifact",
      "enforcement_verification_keys",
      "gateway_configuration",
      "gateway_projections",
    ]) ||
    value.schema_version !== POLICY_RELEASE_SCHEMA_VERSION ||
    !isSafeReleaseId(value.release_id) ||
    !isIdentifier(value.tenant_id) ||
    !isIdentifier(value.runtime_id) ||
    !isIdentifier(value.gateway_id) ||
    !isTimestamp(value.issued_at) ||
    !isTimestamp(value.expires_at) ||
    value.expires_at <= value.issued_at ||
    !isPolicyArtifact(value.authorization_bundle) ||
    !isPolicyArtifact(value.processor_policy) ||
    !isGatewayRoutingArtifactMetadata(value.gateway_routing_artifact) ||
    !isKeyRingArtifact(value.enforcement_verification_keys) ||
    !isGatewayConfiguration(value.gateway_configuration) ||
    !isClosedProjectionSet(value.gateway_projections)
  ) {
    return false
  }
  const authorization = value.authorization_bundle
  const processor = value.processor_policy
  const routing = value.gateway_routing_artifact
  return (
    authorization.tenant_id === value.tenant_id &&
    processor.tenant_id === value.tenant_id &&
    routing.tenant_id === value.tenant_id &&
    routing.gateway_id === value.gateway_id &&
    authorization.revision === processor.revision &&
    authorization.revision === routing.revision &&
    authorization.policy_version === processor.policy_version &&
    authorization.policy_version === routing.policy_version &&
    authorization.issued_at === value.issued_at &&
    processor.issued_at === value.issued_at &&
    routing.issued_at === value.issued_at &&
    authorization.expires_at === value.expires_at &&
    processor.expires_at === value.expires_at &&
    routing.expires_at === value.expires_at
  )
}

function validateTarget(target: PolicyReleaseTarget): void {
  if (
    !isIdentifier(target.tenantId) ||
    !isIdentifier(target.runtimeId) ||
    !isIdentifier(target.gatewayId)
  ) {
    throw new Error("policy release target is invalid")
  }
}

function parseJsonFile(contents: Buffer, label: string): unknown {
  try {
    return JSON.parse(contents.toString("utf8")) as unknown
  } catch {
    throw new Error(`${label} is invalid JSON`)
  }
}

function validateVerificationKeyRing(value: unknown): VerificationKeyRing {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schema_version", "keys"]) ||
    value.schema_version !== 1 ||
    !Array.isArray(value.keys) ||
    value.keys.length === 0
  ) {
    throw new Error("verification keyring is invalid")
  }
  const ids: string[] = []
  for (const candidate of value.keys) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ["key_id", "public_key_pem"]) ||
      !isIdentifier(candidate.key_id) ||
      !presentString(candidate.public_key_pem)
    ) {
      throw new Error("verification keyring is invalid")
    }
    ids.push(candidate.key_id)
  }
  if (!isSortedUnique(ids)) {
    throw new Error("verification keyring keys must be sorted and unique")
  }
  return value as unknown as VerificationKeyRing
}

function compactJwsKeyId(compactJws: string): string {
  const [encodedHeader, encodedPayload, encodedSignature, extra] = compactJws.trim().split(".")
  if (!encodedHeader || !encodedPayload || !encodedSignature || extra) {
    throw new Error("policy artifact is not compact JWS")
  }
  let header: unknown
  try {
    header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as unknown
  } catch {
    throw new Error("policy artifact JWS header is invalid")
  }
  if (
    !isRecord(header) ||
    (!hasExactKeys(header, ["alg", "kid"]) &&
      !hasExactKeys(header, ["alg", "kid", "typ"])) ||
    header.alg !== "EdDSA" ||
    !isIdentifier(header.kid)
  ) {
    throw new Error("policy artifact JWS header is invalid")
  }
  return header.kid
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

function pathInside(root: string, child: string): boolean {
  const rel = relative(root, child)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`))
}

/**
 * Read one immutable release selected by an atomic pointer. Consumers never
 * promote LKG themselves: only the Gateway release controller can declare a
 * release LKG after native projection, authorizer, and processor are all ready.
 */
export class FilePolicyReleaseLoader implements PolicyReleaseSource {
  private readonly releasesPath: string

  constructor(private readonly options: PolicyReleaseLoaderOptions) {
    validateTarget(options.target)
    this.releasesPath = resolve(options.releasesPath)
  }

  async current(): Promise<LoadedPolicyRelease> {
    let currentError: unknown
    try {
      return await this.loadFromPointer(this.options.currentPointerPath, "CURRENT")
    } catch (error) {
      currentError = error
    }
    try {
      return await this.loadFromPointer(this.options.lastKnownGoodPointerPath, "LKG")
    } catch (lkgError) {
      throw new Error(
        `policy release unavailable${currentError instanceof Error ? `: current=${currentError.message}` : ""}${lkgError instanceof Error ? `; lkg=${lkgError.message}` : ""}`,
      )
    }
  }

  async releaseObservation(): Promise<PolicyReleaseObservation> {
    const release = await this.current()
    return {
      source: release.source,
      releaseReference: release.releaseReference,
    }
  }

  private async loadFromPointer(
    pointerPath: string,
    source: PolicyReleasePointerSource,
  ): Promise<LoadedPolicyRelease> {
    const releaseId = await this.readPointer(pointerPath)
    const release = await this.loadRelease(releaseId)
    const afterLoad = await this.readPointer(pointerPath)
    if (afterLoad !== releaseId) {
      throw new Error("policy release pointer changed while loading")
    }
    return { ...release, source }
  }

  private async readPointer(pointerPath: string): Promise<string> {
    const value = (await readFile(pointerPath, "utf8")).trim()
    if (!isSafeReleaseId(value)) throw new Error("policy release pointer is invalid")
    return value
  }

  private async readRootKeyRing(): Promise<VerificationKeyRing> {
    return validateVerificationKeyRing(
      parseJsonFile(await readFile(this.options.releaseRootKeyRingPath), "release root keyring"),
    )
  }

  private async readRuntimeCommandKeyRing(): Promise<VerificationKeyRing> {
    return validateVerificationKeyRing(
      parseJsonFile(
        await readFile(this.options.runtimeCommandKeyRingPath),
        "runtime command keyring",
      ),
    )
  }

  private async loadRelease(
    releaseId: string,
  ): Promise<Omit<LoadedPolicyRelease, "source">> {
    if (!isSafeReleaseId(releaseId)) throw new Error("policy release id is invalid")
    const releasePath = resolve(this.releasesPath, releaseId)
    if (!pathInside(this.releasesPath, releasePath) || releasePath === this.releasesPath) {
      throw new Error("policy release path is invalid")
    }

    const manifest = this.verifyManifest(
      await readFile(join(releasePath, POLICY_RELEASE_FILES.manifest), "utf8"),
      await this.readRootKeyRing(),
    )
    if (manifest.release_id !== releaseId) {
      throw new Error("policy release id does not match manifest")
    }
    this.assertTarget(manifest)
    const now = this.options.now?.() ?? Math.floor(Date.now() / 1000)
    if (now < manifest.issued_at || now >= manifest.expires_at) {
      throw new Error("policy release is expired")
    }

    const runtimeCommand = verifyGatewayRuntimeCommand(
      parseJsonFile(
        await readFile(join(releasePath, POLICY_RELEASE_FILES.runtimeCommand)),
        "Gateway runtime command",
      ),
      await this.readRuntimeCommandKeyRing(),
    )
    if (
      runtimeCommand.tenant_id !== this.options.target.tenantId ||
      runtimeCommand.runtime_id !== this.options.target.runtimeId
    ) {
      throw new Error("Gateway runtime command target does not match runtime")
    }
    const releaseReference = runtimeCommand.desired_release
    if (
      releaseReference.release_id !== manifest.release_id ||
      releaseReference.gateway_id !== manifest.gateway_id ||
      releaseReference.projection_count !== manifest.gateway_projections.length
    ) {
      throw new Error("gateway release reference does not match manifest")
    }

    const [authorizationContents, processorContents, routingContents, keyRingContents] = await Promise.all([
      readFile(join(releasePath, POLICY_RELEASE_FILES.authorizationBundle)),
      readFile(join(releasePath, POLICY_RELEASE_FILES.processorPolicyBundle)),
      readFile(join(releasePath, POLICY_RELEASE_FILES.gatewayRoutingArtifact)),
      readFile(join(releasePath, POLICY_RELEASE_FILES.verificationKeyRing)),
    ])
    this.assertHash(
      authorizationContents,
      manifest.authorization_bundle.sha256,
      "authorization bundle",
    )
    this.assertHash(processorContents, manifest.processor_policy.sha256, "processor policy")
    this.assertHash(
      routingContents,
      manifest.gateway_routing_artifact.sha256,
      "gateway routing artifact",
    )
    this.assertHash(
      keyRingContents,
      manifest.enforcement_verification_keys.sha256,
      "enforcement verification keyring",
    )

    const verificationKeyRing = validateVerificationKeyRing(
      parseJsonFile(keyRingContents, "enforcement verification keyring"),
    )
    const keyIds = verificationKeyRing.keys.map((key) => key.key_id)
    if (
      keyIds.length !== manifest.enforcement_verification_keys.key_ids.length ||
      keyIds.some((keyId, index) => keyId !== manifest.enforcement_verification_keys.key_ids[index])
    ) {
      throw new Error("enforcement verification keyring does not match manifest")
    }
    this.assertArtifactKey(authorizationContents, manifest.authorization_bundle, keyIds)
    this.assertArtifactKey(processorContents, manifest.processor_policy, keyIds)
    this.assertArtifactKey(routingContents, manifest.gateway_routing_artifact, keyIds)

    const authorizationBundle = verifyCompactEdDsaJws(
      authorizationContents.toString("utf8"),
      verificationKeyRing,
    )
    if (!isCompiledAuthorizationBundle(authorizationBundle)) {
      throw new Error("authorization bundle payload is invalid")
    }
    const processorPolicyBundle = validateProcessorPolicyBundle(
      verifyCompactEdDsaJws(processorContents.toString("utf8"), verificationKeyRing),
    )
    const gatewayRoutingArtifact = validateGatewayRoutingArtifact(
      verifyCompactEdDsaJws(routingContents.toString("utf8"), verificationKeyRing),
    )
    this.assertBundleMetadata(
      authorizationBundle,
      processorPolicyBundle,
      gatewayRoutingArtifact,
      manifest,
    )

    return {
      releaseId,
      releaseReference,
      manifest,
      authorizationBundle,
      processorPolicyBundle,
      gatewayRoutingArtifact,
      verificationKeyRing,
    }
  }

  private verifyManifest(contents: string, keyRing: VerificationKeyRing): PolicyReleaseManifest {
    const payload = verifyCompactEdDsaJws(contents, keyRing)
    if (!isPolicyReleaseManifest(payload)) throw new Error("policy release manifest is invalid")
    return payload
  }

  private assertTarget(manifest: PolicyReleaseManifest): void {
    if (
      manifest.tenant_id !== this.options.target.tenantId ||
      manifest.runtime_id !== this.options.target.runtimeId ||
      manifest.gateway_id !== this.options.target.gatewayId
    ) {
      throw new Error("policy release target does not match runtime")
    }
  }

  private assertArtifactKey(
    contents: Buffer,
    artifact: PolicyReleaseArtifact,
    keyIds: readonly string[],
  ): void {
    if (!keyIds.includes(artifact.key_id)) {
      throw new Error("policy artifact key is not in the release keyring")
    }
    if (compactJwsKeyId(contents.toString("utf8")) !== artifact.key_id) {
      throw new Error("policy artifact key does not match manifest")
    }
  }

  private assertBundleMetadata(
    authorization: CompiledAuthorizationBundle,
    processor: ProcessorPolicyBundle,
    routing: GatewayRoutingArtifact,
    manifest: PolicyReleaseManifest,
  ): void {
    const auth = manifest.authorization_bundle
    const process = manifest.processor_policy
    const route = manifest.gateway_routing_artifact
    if (
      authorization.tenant_id !== auth.tenant_id ||
      authorization.revision !== auth.revision ||
      authorization.policy_version !== auth.policy_version ||
      authorization.issued_at !== auth.issued_at ||
      authorization.expires_at !== auth.expires_at ||
      processor.tenant_id !== process.tenant_id ||
      processor.revision !== process.revision ||
      processor.policy_version !== process.policy_version ||
      processor.issued_at !== process.issued_at ||
      processor.expires_at !== process.expires_at ||
      routing.tenant_id !== route.tenant_id ||
      routing.gateway_id !== manifest.gateway_id ||
      routing.revision !== route.revision ||
      routing.policy_version !== route.policy_version ||
      routing.issued_at !== route.issued_at ||
      routing.expires_at !== route.expires_at
    ) {
      throw new Error("policy bundle metadata does not match manifest")
    }
  }

  private assertHash(contents: Buffer, expected: string, label: string): void {
    if (sha256(contents) !== expected) throw new Error(`${label} hash does not match manifest`)
  }
}
