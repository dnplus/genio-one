import { createHash } from "node:crypto"

import {
  validateGatewayRoutingArtifact,
  type GatewayRoutingArtifact,
} from "../../../../../../runtimes/gateway/services/shared/gateway-routing-artifact"
import { isPolicyReleaseManifest } from "../../../../../../runtimes/gateway/services/shared/policy-release"
import type { SqlAdapter, SqlTransaction } from "../../persistence/sql-adapter"
import { PlatformApiError } from "../errors"
import {
  POLICY_RELEASE_FILES,
  type GatewayPolicyReleasePlan,
  type GatewayProjectionReleaseReference,
  type ReleaseFileArtifact,
} from "./contract"
import type {
  GatewayPolicyReleaseHead,
  GatewayPolicyReleaseManifestRecord,
  GatewayPolicyReleaseRecord,
  GatewayPolicyReleaseStore,
  SaveGatewayPolicyReleaseInput,
  SavedGatewayPolicyRelease,
} from "./module"
import { canonicalGatewayPolicyReleaseBytes } from "./planner"
import { lockGatewayPolicyRelease } from "./transaction-lock"

type DatabaseRow = Record<string, unknown>

export interface PostgresGatewayPolicyReleaseStoreOptions {
  sql: SqlAdapter
}

const RELEASE_COLUMNS = `
  tenant_id,
  release_id,
  gateway_id,
  policy_artifact_revision,
  policy_version,
  extract(epoch from issued_at)::bigint as issued_at,
  extract(epoch from expires_at)::bigint as expires_at,
  content_digest,
  projection_set_digest,
  authorization_bundle,
  authorization_sha256,
  authorization_key_id,
  processor_policy,
  processor_sha256,
  processor_key_id,
  gateway_routing_artifact,
  gateway_routing_artifact_sha256,
  gateway_routing_artifact_key_id,
  enforcement_verification_keys,
  enforcement_verification_keys_sha256,
  extract(epoch from created_at)::bigint as created_at,
  extract(epoch from updated_at)::bigint as updated_at`

const MANIFEST_COLUMNS = `
  tenant_id,
  release_id,
  runtime_id,
  gateway_id,
  manifest,
  manifest_jws,
  manifest_sha256,
  manifest_key_id,
  extract(epoch from created_at)::bigint as created_at,
  extract(epoch from updated_at)::bigint as updated_at`

const HEAD_COLUMNS = `
  tenant_id,
  gateway_id,
  release_id,
  content_digest,
  head_revision,
  extract(epoch from updated_at)::bigint as updated_at`

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function parseInteger(value: unknown, code: string, minimum = 0): number {
  const parsed = typeof value === "bigint" ? Number(value) : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new PlatformApiError(code, 500)
  }
  return parsed
}

function rowString(row: DatabaseRow, key: string): string {
  const value = row[key]
  if (typeof value !== "string" || !value.trim()) {
    throw new PlatformApiError("GATEWAY_POLICY_RELEASE_DATA_INVALID", 500)
  }
  return value
}

function rowBytes(row: DatabaseRow, key: string): Uint8Array {
  const value = row[key]
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new PlatformApiError("GATEWAY_POLICY_RELEASE_DATA_INVALID", 500)
  }
  return new Uint8Array(value)
}

function parseJson(value: unknown, code: string): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new PlatformApiError(code, 500)
  }
}

function compactJws(value: Uint8Array): { keyId: string; payload: unknown } {
  const compact = Buffer.from(value).toString("utf8").trim()
  const [encodedHeader, encodedPayload, signature, extra] = compact.split(".")
  if (!encodedHeader || !encodedPayload || !signature || extra) {
    throw new PlatformApiError("GATEWAY_POLICY_RELEASE_PLAN_INVALID", 500)
  }
  try {
    const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as {
      alg?: unknown
      kid?: unknown
    }
    if (header.alg !== "EdDSA" || typeof header.kid !== "string" || !header.kid.trim()) {
      throw new Error("invalid header")
    }
    return {
      keyId: header.kid,
      payload: JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as unknown,
    }
  } catch {
    throw new PlatformApiError("GATEWAY_POLICY_RELEASE_PLAN_INVALID", 500)
  }
}

function assertGatewayRoutingArtifact(
  value: unknown,
  plan: GatewayPolicyReleasePlan,
): void {
  let artifact: GatewayRoutingArtifact
  try {
    artifact = validateGatewayRoutingArtifact(value)
  } catch {
    throw new PlatformApiError("GATEWAY_POLICY_RELEASE_PLAN_INVALID", 500)
  }
  const metadata = plan.manifest.gateway_routing_artifact
  if (
    artifact.tenant_id !== metadata.tenant_id ||
    artifact.gateway_id !== metadata.gateway_id ||
    artifact.revision !== metadata.revision ||
    artifact.policy_version !== metadata.policy_version ||
    artifact.issued_at !== metadata.issued_at ||
    artifact.expires_at !== metadata.expires_at
  ) {
    throw new PlatformApiError("GATEWAY_POLICY_RELEASE_PLAN_INVALID", 500)
  }
}

function assertArtifact(
  artifact: ReleaseFileArtifact,
  fileName: string,
  expectedSha256: string,
  expectedKeyId?: string,
): void {
  if (
    artifact.file_name !== fileName ||
    artifact.bytes.byteLength === 0 ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    artifact.sha256 !== sha256(artifact.bytes) ||
    artifact.sha256 !== expectedSha256 ||
    (expectedKeyId !== undefined && artifact.key_id !== expectedKeyId)
  ) {
    throw new PlatformApiError("GATEWAY_POLICY_RELEASE_PLAN_INVALID", 500)
  }
}

interface ValidatedPlan {
  contentDigest: string
  projectionSetDigest: string
}

function validatePlan(plan: GatewayPolicyReleasePlan): ValidatedPlan {
  const manifest = plan.manifest
  if (
    !isPolicyReleaseManifest(manifest) ||
    manifest.release_id !== plan.release_id ||
    manifest.tenant_id !== plan.target.tenant_id ||
    manifest.runtime_id !== plan.target.runtime_id ||
    manifest.gateway_id !== plan.target.gateway_id ||
    plan.release_directory !== `releases/${plan.release_id}`
  ) {
    throw new PlatformApiError("GATEWAY_POLICY_RELEASE_PLAN_INVALID", 500)
  }
  const { release_id: _releaseId, runtime_id: _runtimeId, ...commonIdentity } = manifest
  const contentDigest = sha256(canonicalGatewayPolicyReleaseBytes(commonIdentity))
  if (plan.release_id !== `release-${contentDigest}`) {
    throw new PlatformApiError("GATEWAY_POLICY_RELEASE_PLAN_INVALID", 500)
  }
  const projectionSetDigest = sha256(
    canonicalGatewayPolicyReleaseBytes(manifest.gateway_projections),
  )
  assertArtifact(
    plan.authorization_bundle,
    POLICY_RELEASE_FILES.authorizationBundle,
    manifest.authorization_bundle.sha256,
    manifest.authorization_bundle.key_id,
  )
  assertArtifact(
    plan.processor_policy,
    POLICY_RELEASE_FILES.processorPolicyBundle,
    manifest.processor_policy.sha256,
    manifest.processor_policy.key_id,
  )
  assertArtifact(
    plan.gateway_routing_artifact,
    POLICY_RELEASE_FILES.gatewayRoutingArtifact,
    manifest.gateway_routing_artifact.sha256,
    manifest.gateway_routing_artifact.key_id,
  )
  assertArtifact(
    plan.enforcement_verification_keys,
    POLICY_RELEASE_FILES.verificationKeyRing,
    manifest.enforcement_verification_keys.sha256,
  )
  if (!plan.manifest_jws.key_id) {
    throw new PlatformApiError("GATEWAY_POLICY_RELEASE_PLAN_INVALID", 500)
  }
  assertArtifact(
    plan.manifest_jws,
    POLICY_RELEASE_FILES.manifest,
    plan.manifest_jws.sha256,
    plan.manifest_jws.key_id,
  )
  const signedManifest = compactJws(plan.manifest_jws.bytes)
  if (
    signedManifest.keyId !== plan.manifest_jws.key_id ||
    !Buffer.from(canonicalGatewayPolicyReleaseBytes(signedManifest.payload)).equals(
      Buffer.from(canonicalGatewayPolicyReleaseBytes(manifest)),
    )
  ) {
    throw new PlatformApiError("GATEWAY_POLICY_RELEASE_PLAN_INVALID", 500)
  }
  const signedRoutingArtifact = compactJws(plan.gateway_routing_artifact.bytes)
  if (signedRoutingArtifact.keyId !== plan.gateway_routing_artifact.key_id) {
    throw new PlatformApiError("GATEWAY_POLICY_RELEASE_PLAN_INVALID", 500)
  }
  assertGatewayRoutingArtifact(signedRoutingArtifact.payload, plan)
  return { contentDigest, projectionSetDigest }
}

function artifact(
  fileName: string,
  bytes: Uint8Array,
  digest: string,
  keyId?: string,
): ReleaseFileArtifact {
  return {
    file_name: fileName,
    bytes,
    sha256: digest,
    ...(keyId ? { key_id: keyId } : {}),
  }
}

function mapProjection(row: DatabaseRow): GatewayProjectionReleaseReference {
  const revision = parseInteger(
    row.projection_revision,
    "GATEWAY_POLICY_RELEASE_DATA_INVALID",
    1,
  )
  const digest = rowString(row, "projection_digest")
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new PlatformApiError("GATEWAY_POLICY_RELEASE_DATA_INVALID", 500)
  }
  return {
    publication_id: rowString(row, "publication_id"),
    projection_id: rowString(row, "projection_id"),
    revision,
    digest,
  }
}

async function loadProjections(
  executor: SqlAdapter | SqlTransaction,
  tenantId: string,
  releaseId: string,
): Promise<GatewayProjectionReleaseReference[]> {
  const result = await executor.query<DatabaseRow>(
    `select publication_id, projection_id,
            projection_revision, projection_digest
       from genio_one_gateway_policy_release_projections
      where tenant_id = $1 and release_id = $2
      order by publication_id, projection_id`,
    [tenantId, releaseId],
  )
  return result.rows.map(mapProjection)
}

async function mapRelease(
  executor: SqlAdapter | SqlTransaction,
  row: DatabaseRow,
): Promise<GatewayPolicyReleaseRecord> {
  const tenantId = rowString(row, "tenant_id")
  const releaseId = rowString(row, "release_id")
  const projections = await loadProjections(executor, tenantId, releaseId)
  const projectionSetDigest = rowString(row, "projection_set_digest")
  if (projectionSetDigest !== sha256(canonicalGatewayPolicyReleaseBytes(projections))) {
    throw new PlatformApiError("GATEWAY_POLICY_RELEASE_DATA_INVALID", 500)
  }
  const contentDigest = rowString(row, "content_digest")
  if (
    !/^[a-f0-9]{64}$/.test(contentDigest) ||
    releaseId !== `release-${contentDigest}`
  ) {
    throw new PlatformApiError("GATEWAY_POLICY_RELEASE_DATA_INVALID", 500)
  }
  const authorizationBytes = rowBytes(row, "authorization_bundle")
  const authorizationDigest = rowString(row, "authorization_sha256")
  const processorBytes = rowBytes(row, "processor_policy")
  const processorDigest = rowString(row, "processor_sha256")
  const gatewayRoutingBytes = rowBytes(row, "gateway_routing_artifact")
  const gatewayRoutingDigest = rowString(row, "gateway_routing_artifact_sha256")
  const keyRingBytes = rowBytes(row, "enforcement_verification_keys")
  const keyRingDigest = rowString(row, "enforcement_verification_keys_sha256")
  if (
    sha256(authorizationBytes) !== authorizationDigest ||
    sha256(processorBytes) !== processorDigest ||
    sha256(gatewayRoutingBytes) !== gatewayRoutingDigest ||
    sha256(keyRingBytes) !== keyRingDigest
  ) {
    throw new PlatformApiError("GATEWAY_POLICY_RELEASE_DATA_INVALID", 500)
  }
  return {
    tenant_id: tenantId,
    release_id: releaseId,
    gateway_id: rowString(row, "gateway_id"),
    policy_artifact_revision: rowString(row, "policy_artifact_revision"),
    policy_version: rowString(row, "policy_version"),
    issued_at: parseInteger(row.issued_at, "GATEWAY_POLICY_RELEASE_DATA_INVALID"),
    expires_at: parseInteger(row.expires_at, "GATEWAY_POLICY_RELEASE_DATA_INVALID"),
    content_digest: contentDigest,
    projection_set_digest: projectionSetDigest,
    projections,
    authorization_bundle: artifact(
      POLICY_RELEASE_FILES.authorizationBundle,
      authorizationBytes,
      authorizationDigest,
      rowString(row, "authorization_key_id"),
    ),
    processor_policy: artifact(
      POLICY_RELEASE_FILES.processorPolicyBundle,
      processorBytes,
      processorDigest,
      rowString(row, "processor_key_id"),
    ),
    gateway_routing_artifact: artifact(
      POLICY_RELEASE_FILES.gatewayRoutingArtifact,
      gatewayRoutingBytes,
      gatewayRoutingDigest,
      rowString(row, "gateway_routing_artifact_key_id"),
    ),
    enforcement_verification_keys: artifact(
      POLICY_RELEASE_FILES.verificationKeyRing,
      keyRingBytes,
      keyRingDigest,
    ),
    created_at: parseInteger(row.created_at, "GATEWAY_POLICY_RELEASE_DATA_INVALID"),
    updated_at: parseInteger(row.updated_at, "GATEWAY_POLICY_RELEASE_DATA_INVALID"),
  }
}

function mapManifest(row: DatabaseRow): GatewayPolicyReleaseManifestRecord {
  const manifest = parseJson(row.manifest, "GATEWAY_POLICY_RELEASE_DATA_INVALID")
  if (!isPolicyReleaseManifest(manifest)) {
    throw new PlatformApiError("GATEWAY_POLICY_RELEASE_DATA_INVALID", 500)
  }
  const bytes = rowBytes(row, "manifest_jws")
  const digest = rowString(row, "manifest_sha256")
  if (sha256(bytes) !== digest) {
    throw new PlatformApiError("GATEWAY_POLICY_RELEASE_DATA_INVALID", 500)
  }
  const tenantId = rowString(row, "tenant_id")
  const releaseId = rowString(row, "release_id")
  const runtimeId = rowString(row, "runtime_id")
  const gatewayId = rowString(row, "gateway_id")
  const manifestKeyId = rowString(row, "manifest_key_id")
  const signedManifest = compactJws(bytes)
  if (
    manifest.tenant_id !== tenantId ||
    manifest.release_id !== releaseId ||
    manifest.runtime_id !== runtimeId ||
    manifest.gateway_id !== gatewayId ||
    signedManifest.keyId !== manifestKeyId ||
    !Buffer.from(canonicalGatewayPolicyReleaseBytes(signedManifest.payload)).equals(
      Buffer.from(canonicalGatewayPolicyReleaseBytes(manifest)),
    )
  ) {
    throw new PlatformApiError("GATEWAY_POLICY_RELEASE_DATA_INVALID", 500)
  }
  return {
    tenant_id: tenantId,
    release_id: releaseId,
    runtime_id: runtimeId,
    gateway_id: gatewayId,
    manifest,
    manifest_jws: artifact(
      POLICY_RELEASE_FILES.manifest,
      bytes,
      digest,
      manifestKeyId,
    ),
    created_at: parseInteger(row.created_at, "GATEWAY_POLICY_RELEASE_DATA_INVALID"),
    updated_at: parseInteger(row.updated_at, "GATEWAY_POLICY_RELEASE_DATA_INVALID"),
  }
}

function mapHead(row: DatabaseRow): GatewayPolicyReleaseHead {
  return {
    tenant_id: rowString(row, "tenant_id"),
    gateway_id: rowString(row, "gateway_id"),
    release_id: rowString(row, "release_id"),
    content_digest: rowString(row, "content_digest"),
    head_revision: parseInteger(row.head_revision, "GATEWAY_POLICY_RELEASE_DATA_INVALID", 1),
    updated_at: parseInteger(row.updated_at, "GATEWAY_POLICY_RELEASE_DATA_INVALID"),
  }
}

async function selectRelease(
  executor: SqlAdapter | SqlTransaction,
  tenantId: string,
  releaseId: string,
  forUpdate = false,
): Promise<GatewayPolicyReleaseRecord | null> {
  const result = await executor.query<DatabaseRow>(
    `select ${RELEASE_COLUMNS}
       from genio_one_gateway_policy_releases
      where tenant_id = $1 and release_id = $2${forUpdate ? " for update" : ""}`,
    [tenantId, releaseId],
  )
  return result.rows[0] ? mapRelease(executor, result.rows[0]) : null
}

async function selectManifest(
  executor: SqlAdapter | SqlTransaction,
  tenantId: string,
  releaseId: string,
  runtimeId: string,
  forUpdate = false,
): Promise<GatewayPolicyReleaseManifestRecord | null> {
  const result = await executor.query<DatabaseRow>(
    `select ${MANIFEST_COLUMNS}
       from genio_one_gateway_policy_release_manifests
      where tenant_id = $1 and release_id = $2 and runtime_id = $3${
        forUpdate ? " for update" : ""
      }`,
    [tenantId, releaseId, runtimeId],
  )
  return result.rows[0] ? mapManifest(result.rows[0]) : null
}

async function selectHead(
  executor: SqlAdapter | SqlTransaction,
  tenantId: string,
  gatewayId: string,
  forUpdate = false,
): Promise<GatewayPolicyReleaseHead | null> {
  const result = await executor.query<DatabaseRow>(
    `select ${HEAD_COLUMNS}
       from genio_one_gateway_policy_release_heads
      where tenant_id = $1 and gateway_id = $2${forUpdate ? " for update" : ""}`,
    [tenantId, gatewayId],
  )
  return result.rows[0] ? mapHead(result.rows[0]) : null
}

function sameManifest(
  existing: GatewayPolicyReleaseManifestRecord,
  plan: GatewayPolicyReleasePlan,
): boolean {
  return (
    existing.manifest_jws.sha256 === plan.manifest_jws.sha256 &&
    Buffer.from(existing.manifest_jws.bytes).equals(Buffer.from(plan.manifest_jws.bytes)) &&
    Buffer.from(canonicalGatewayPolicyReleaseBytes(existing.manifest)).equals(
      Buffer.from(canonicalGatewayPolicyReleaseBytes(plan.manifest)),
    )
  )
}

async function saveWithTransaction(
  transaction: SqlTransaction,
  input: SaveGatewayPolicyReleaseInput,
): Promise<SavedGatewayPolicyRelease> {
  const { plan } = input
  if (
    input.expectedHeadRevision !== null &&
    (!Number.isSafeInteger(input.expectedHeadRevision) || input.expectedHeadRevision < 1)
  ) {
    throw new PlatformApiError("GATEWAY_POLICY_RELEASE_HEAD_REVISION_INVALID", 422)
  }
  const validated = validatePlan(plan)
  await lockGatewayPolicyRelease({
    transaction,
    tenantId: plan.target.tenant_id,
    gatewayId: plan.target.gateway_id,
  })

  const inserted = await transaction.query(
    `insert into genio_one_gateway_policy_releases
       (tenant_id, release_id, gateway_id, policy_artifact_revision, policy_version,
        issued_at, expires_at, content_digest, projection_set_digest,
        authorization_bundle, authorization_sha256, authorization_key_id,
        processor_policy, processor_sha256, processor_key_id,
        gateway_routing_artifact, gateway_routing_artifact_sha256,
        gateway_routing_artifact_key_id,
        enforcement_verification_keys, enforcement_verification_keys_sha256)
     values ($1, $2, $3, $4, $5, to_timestamp($6), to_timestamp($7), $8, $9,
             $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
     on conflict (tenant_id, release_id) do nothing
     returning tenant_id`,
    [
      plan.target.tenant_id,
      plan.release_id,
      plan.target.gateway_id,
      plan.manifest.authorization_bundle.revision,
      plan.manifest.authorization_bundle.policy_version,
      plan.manifest.issued_at,
      plan.manifest.expires_at,
      validated.contentDigest,
      validated.projectionSetDigest,
      Buffer.from(plan.authorization_bundle.bytes),
      plan.authorization_bundle.sha256,
      plan.authorization_bundle.key_id,
      Buffer.from(plan.processor_policy.bytes),
      plan.processor_policy.sha256,
      plan.processor_policy.key_id,
      Buffer.from(plan.gateway_routing_artifact.bytes),
      plan.gateway_routing_artifact.sha256,
      plan.gateway_routing_artifact.key_id,
      Buffer.from(plan.enforcement_verification_keys.bytes),
      plan.enforcement_verification_keys.sha256,
    ],
  )

  if (inserted.rowCount === 1) {
    for (const projection of plan.manifest.gateway_projections) {
      await transaction.query(
        `insert into genio_one_gateway_policy_release_projections
           (tenant_id, release_id, publication_id, projection_id,
            projection_revision, projection_digest)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          plan.target.tenant_id,
          plan.release_id,
          projection.publication_id,
          projection.projection_id,
          projection.revision,
          projection.digest,
        ],
      )
    }
  }

  const release = await selectRelease(
    transaction,
    plan.target.tenant_id,
    plan.release_id,
    true,
  )
  if (
    !release ||
    release.gateway_id !== plan.target.gateway_id ||
    release.content_digest !== validated.contentDigest ||
    release.projection_set_digest !== validated.projectionSetDigest
  ) {
    throw new PlatformApiError("GATEWAY_POLICY_RELEASE_IMMUTABLE", 409)
  }

  await transaction.query(
    `insert into genio_one_gateway_policy_release_manifests
       (tenant_id, release_id, runtime_id, gateway_id, manifest,
        manifest_jws, manifest_sha256, manifest_key_id)
     values ($1, $2, $3, $4, $5::text::jsonb, $6, $7, $8)
     on conflict (tenant_id, release_id, runtime_id) do nothing`,
    [
      plan.target.tenant_id,
      plan.release_id,
      plan.target.runtime_id,
      plan.target.gateway_id,
      JSON.stringify(plan.manifest),
      Buffer.from(plan.manifest_jws.bytes),
      plan.manifest_jws.sha256,
      plan.manifest_jws.key_id,
    ],
  )
  const manifest = await selectManifest(
    transaction,
    plan.target.tenant_id,
    plan.release_id,
    plan.target.runtime_id,
    true,
  )
  if (!manifest || !sameManifest(manifest, plan)) {
    throw new PlatformApiError("GATEWAY_POLICY_RELEASE_MANIFEST_IMMUTABLE", 409)
  }

  const currentHead = await selectHead(
    transaction,
    plan.target.tenant_id,
    plan.target.gateway_id,
    true,
  )
  let head: GatewayPolicyReleaseHead
  if (!currentHead) {
    if (input.expectedHeadRevision !== null) {
      throw new PlatformApiError("GATEWAY_POLICY_RELEASE_HEAD_CONFLICT", 409)
    }
    const result = await transaction.query<DatabaseRow>(
      `insert into genio_one_gateway_policy_release_heads
         (tenant_id, gateway_id, release_id, content_digest, head_revision)
       values ($1, $2, $3, $4, 1)
       returning ${HEAD_COLUMNS}`,
      [
        plan.target.tenant_id,
        plan.target.gateway_id,
        plan.release_id,
        validated.contentDigest,
      ],
    )
    if (!result.rows[0]) throw new PlatformApiError("GATEWAY_POLICY_RELEASE_HEAD_CONFLICT", 409)
    head = mapHead(result.rows[0])
  } else if (currentHead.release_id === plan.release_id) {
    if (currentHead.content_digest !== validated.contentDigest) {
      throw new PlatformApiError("GATEWAY_POLICY_RELEASE_HEAD_INVALID", 500)
    }
    head = currentHead
  } else {
    if (
      input.expectedHeadRevision === null ||
      input.expectedHeadRevision !== currentHead.head_revision
    ) {
      throw new PlatformApiError("GATEWAY_POLICY_RELEASE_HEAD_CONFLICT", 409)
    }
    const result = await transaction.query<DatabaseRow>(
      `update genio_one_gateway_policy_release_heads
          set release_id = $3, content_digest = $4,
              head_revision = head_revision + 1, updated_at = now()
        where tenant_id = $1 and gateway_id = $2 and head_revision = $5
        returning ${HEAD_COLUMNS}`,
      [
        plan.target.tenant_id,
        plan.target.gateway_id,
        plan.release_id,
        validated.contentDigest,
        input.expectedHeadRevision,
      ],
    )
    if (!result.rows[0]) throw new PlatformApiError("GATEWAY_POLICY_RELEASE_HEAD_CONFLICT", 409)
    head = mapHead(result.rows[0])
  }

  return { release, target: { ...plan.target }, manifest, head }
}

export function createPostgresGatewayPolicyReleaseStore(
  options: PostgresGatewayPolicyReleaseStoreOptions,
): GatewayPolicyReleaseStore {
  return {
    save(input) {
      return options.sql.transaction((transaction) => saveWithTransaction(transaction, input))
    },
    saveInTransaction(input) {
      return saveWithTransaction(input.transaction, input)
    },
    async get(input) {
      return selectRelease(options.sql, input.tenantId, input.releaseId)
    },
    async getManifest(input) {
      return selectManifest(options.sql, input.tenantId, input.releaseId, input.runtimeId)
    },
    async getHead(input) {
      return selectHead(options.sql, input.tenantId, input.gatewayId)
    },
    async getHeadInTransaction(input) {
      await lockGatewayPolicyRelease(input)
      return selectHead(input.transaction, input.tenantId, input.gatewayId, true)
    },
  }
}
