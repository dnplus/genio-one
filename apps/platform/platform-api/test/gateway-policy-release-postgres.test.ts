import assert from "node:assert/strict"
import { generateKeyPairSync, sign as signPayload } from "node:crypto"
import test from "node:test"

import type { VerificationKeyRing } from "../../../../packages/protocol/src/compact-jws"
import { PlatformApiError } from "../src/capabilities/errors"
import type {
  CompactJwsSigner,
  GatewayPolicyReleaseInput,
  GatewayPolicyReleasePlan,
} from "../src/capabilities/gateway-policy-release/contract"
import { planGatewayPolicyRelease } from "../src/capabilities/gateway-policy-release/planner"
import { createPostgresGatewayPolicyReleaseStore } from "../src/capabilities/gateway-policy-release/postgres"
import type {
  SqlAdapter,
  SqlQueryResult,
  SqlTransaction,
} from "../src/persistence/sql-adapter"

type Row = Record<string, unknown>

function signer(keyId: string): CompactJwsSigner & { publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  return {
    algorithm: "EdDSA",
    keyId,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    sign(payload) {
      return signPayload(null, Buffer.from(payload), privateKey).toString("base64url")
    },
  }
}

const artifactSigner = signer("artifact-key")
const rootSigner = signer("release-root-key")
const verificationKeyRing: VerificationKeyRing = {
  schema_version: 1,
  keys: [{ key_id: artifactSigner.keyId, public_key_pem: artifactSigner.publicKeyPem }],
}

function releaseInput(overrides: Partial<GatewayPolicyReleaseInput> = {}): GatewayPolicyReleaseInput {
  return {
    target: {
      tenant_id: "tenant-acme",
      runtime_id: "gateway-runtime-1",
      gateway_id: "ai-gateway",
    },
    issued_at: 1_800_000_000,
    expires_at: 1_800_000_600,
    projections: [
      {
        publication_id: "publication-a",
        projection_id: "projection-a",
        revision: 7,
        digest: "a".repeat(64),
      },
    ],
    authorization_bundle: {
      schema_version: 1,
      tenant_id: "tenant-acme",
      revision: "gateway-revision-7",
      policy_version: "policy-7",
      issued_at: 1_800_000_000,
      expires_at: 1_800_000_600,
      rules: [],
    },
    processor_policy: {
      schema_version: 1,
      tenant_id: "tenant-acme",
      revision: "gateway-revision-7",
      policy_version: "policy-7",
      issued_at: 1_800_000_000,
      expires_at: 1_800_000_600,
      scopes: [],
    },
    gateway_routing_artifact: {
      schema_version: "genio.one.gateway-routing.v1",
      tenant_id: "tenant-acme",
      gateway_id: "ai-gateway",
      revision: "gateway-revision-7",
      policy_version: "policy-7",
      issued_at: 1_800_000_000,
      expires_at: 1_800_000_600,
      scopes: [],
    },
    enforcement_verification_keys: verificationKeyRing,
    artifact_signer: artifactSigner,
    release_root_signer: rootSigner,
    ...overrides,
  }
}

function key(...values: unknown[]): string {
  return values.join("\u0000")
}

class GatewayReleaseSql implements SqlAdapter, SqlTransaction {
  readonly calls: Array<{ text: string; parameters: readonly unknown[] }> = []
  readonly releases = new Map<string, Row>()
  readonly projections: Row[] = []
  readonly manifests = new Map<string, Row>()
  readonly heads = new Map<string, Row>()

  async query<Result extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Result>> {
    this.calls.push({ text, parameters })
    if (text.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 }

    if (text.includes("insert into genio_one_gateway_policy_releases")) {
      const releaseKey = key(parameters[0], parameters[1])
      if (this.releases.has(releaseKey)) return { rows: [], rowCount: 0 }
      const row: Row = {
        tenant_id: parameters[0],
        release_id: parameters[1],
        gateway_id: parameters[2],
        policy_artifact_revision: parameters[3],
        policy_version: parameters[4],
        issued_at: parameters[5],
        expires_at: parameters[6],
        content_digest: parameters[7],
        projection_set_digest: parameters[8],
        authorization_bundle: parameters[9],
        authorization_sha256: parameters[10],
        authorization_key_id: parameters[11],
        processor_policy: parameters[12],
        processor_sha256: parameters[13],
        processor_key_id: parameters[14],
        gateway_routing_artifact: parameters[15],
        gateway_routing_artifact_sha256: parameters[16],
        gateway_routing_artifact_key_id: parameters[17],
        enforcement_verification_keys: parameters[18],
        enforcement_verification_keys_sha256: parameters[19],
        created_at: 1_800_000_000,
        updated_at: 1_800_000_000,
      }
      this.releases.set(releaseKey, row)
      return {
        rows: [{ tenant_id: parameters[0] } as unknown as Result],
        rowCount: 1,
      }
    }
    if (text.includes("insert into genio_one_gateway_policy_release_projections")) {
      this.projections.push({
        tenant_id: parameters[0],
        release_id: parameters[1],
        publication_id: parameters[2],
        projection_id: parameters[3],
        projection_revision: parameters[4],
        projection_digest: parameters[5],
      })
      return { rows: [], rowCount: 1 }
    }
    if (text.includes("from genio_one_gateway_policy_release_projections")) {
      const rows = this.projections
        .filter((row) => row.tenant_id === parameters[0] && row.release_id === parameters[1])
        .sort((left, right) => String(left.publication_id).localeCompare(String(right.publication_id)))
      return { rows: rows as Result[], rowCount: rows.length }
    }
    if (text.includes("from genio_one_gateway_policy_releases")) {
      const row = this.releases.get(key(parameters[0], parameters[1]))
      return row
        ? { rows: [row as Result], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    }

    if (text.includes("insert into genio_one_gateway_policy_release_manifests")) {
      const manifestKey = key(parameters[0], parameters[1], parameters[2])
      if (!this.manifests.has(manifestKey)) {
        this.manifests.set(manifestKey, {
          tenant_id: parameters[0],
          release_id: parameters[1],
          runtime_id: parameters[2],
          gateway_id: parameters[3],
          manifest: parameters[4],
          manifest_jws: parameters[5],
          manifest_sha256: parameters[6],
          manifest_key_id: parameters[7],
          created_at: 1_800_000_000,
          updated_at: 1_800_000_000,
        })
      }
      return { rows: [], rowCount: 1 }
    }
    if (text.includes("from genio_one_gateway_policy_release_manifests")) {
      const row = this.manifests.get(key(parameters[0], parameters[1], parameters[2]))
      return row
        ? { rows: [row as Result], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    }

    if (text.includes("insert into genio_one_gateway_policy_release_heads")) {
      const headKey = key(parameters[0], parameters[1])
      const row: Row = {
        tenant_id: parameters[0],
        gateway_id: parameters[1],
        release_id: parameters[2],
        content_digest: parameters[3],
        head_revision: 1,
        updated_at: 1_800_000_000,
      }
      this.heads.set(headKey, row)
      return { rows: [row as Result], rowCount: 1 }
    }
    if (text.includes("update genio_one_gateway_policy_release_heads")) {
      const headKey = key(parameters[0], parameters[1])
      const current = this.heads.get(headKey)
      if (!current || current.head_revision !== parameters[4]) {
        return { rows: [], rowCount: 0 }
      }
      const row: Row = {
        ...current,
        release_id: parameters[2],
        content_digest: parameters[3],
        head_revision: Number(current.head_revision) + 1,
      }
      this.heads.set(headKey, row)
      return { rows: [row as Result], rowCount: 1 }
    }
    if (text.includes("from genio_one_gateway_policy_release_heads")) {
      const row = this.heads.get(key(parameters[0], parameters[1]))
      return row
        ? { rows: [row as Result], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    }
    throw new Error(`Unexpected SQL in test: ${text}`)
  }

  transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
    return work(this)
  }
}

function errorCode(error: unknown): string | null {
  return error instanceof PlatformApiError ? error.code : null
}

async function plan(overrides: Partial<GatewayPolicyReleaseInput> = {}): Promise<GatewayPolicyReleasePlan> {
  return planGatewayPolicyRelease(releaseInput(overrides))
}

test("persists one immutable release, exact membership, runtime manifest, and CAS head", async () => {
  const sql = new GatewayReleaseSql()
  const store = createPostgresGatewayPolicyReleaseStore({ sql })
  const firstPlan = await plan()
  const first = await store.save({ plan: firstPlan, expectedHeadRevision: null })

  assert.equal(first.release.release_id, firstPlan.release_id)
  assert.deepEqual(first.release.projections, firstPlan.manifest.gateway_projections)
  assert.equal(
    first.release.gateway_routing_artifact.sha256,
    firstPlan.gateway_routing_artifact.sha256,
  )
  assert.equal(first.manifest.runtime_id, "gateway-runtime-1")
  assert.equal(first.head.head_revision, 1)
  assert.equal(first.head.release_id, firstPlan.release_id)
  assert.ok(sql.calls.some((call) => call.text.includes("pg_advisory_xact_lock")))

  const secondRuntimePlan = await plan({
    target: { ...releaseInput().target, runtime_id: "gateway-runtime-2" },
  })
  const secondRuntime = await store.save({
    plan: secondRuntimePlan,
    expectedHeadRevision: 1,
  })
  assert.equal(secondRuntime.release.release_id, firstPlan.release_id)
  assert.equal(secondRuntime.manifest.runtime_id, "gateway-runtime-2")
  assert.equal(secondRuntime.head.head_revision, 1)
  assert.equal(sql.releases.size, 1)
  assert.equal(sql.manifests.size, 2)

  const nextInput = releaseInput({
    issued_at: 1_800_001_000,
    expires_at: 1_800_001_600,
    projections: [],
  })
  nextInput.authorization_bundle = {
    ...nextInput.authorization_bundle,
    revision: "gateway-revision-8",
    policy_version: "policy-8",
    issued_at: nextInput.issued_at,
    expires_at: nextInput.expires_at,
  }
  nextInput.processor_policy = {
    ...nextInput.processor_policy,
    revision: "gateway-revision-8",
    policy_version: "policy-8",
    issued_at: nextInput.issued_at,
    expires_at: nextInput.expires_at,
  }
  nextInput.gateway_routing_artifact = {
    ...nextInput.gateway_routing_artifact,
    revision: "gateway-revision-8",
    policy_version: "policy-8",
    issued_at: nextInput.issued_at,
    expires_at: nextInput.expires_at,
  }
  const retiredPlan = await planGatewayPolicyRelease(nextInput)
  const retired = await store.save({ plan: retiredPlan, expectedHeadRevision: 1 })
  assert.deepEqual(retired.release.projections, [])
  assert.equal(retired.head.head_revision, 2)
  assert.equal(retired.head.release_id, retiredPlan.release_id)

  await assert.rejects(
    store.save({ plan: firstPlan, expectedHeadRevision: 1 }),
    (error: unknown) => errorCode(error) === "GATEWAY_POLICY_RELEASE_HEAD_CONFLICT",
  )
})

test("rejects a mutated target manifest for an existing runtime release", async () => {
  const sql = new GatewayReleaseSql()
  const store = createPostgresGatewayPolicyReleaseStore({ sql })
  const original = await plan()
  await store.save({ plan: original, expectedHeadRevision: null })

  const alternateRoot = signer("alternate-release-root")
  const resigned = await plan({ release_root_signer: alternateRoot })
  assert.equal(resigned.release_id, original.release_id)
  await assert.rejects(
    store.save({ plan: resigned, expectedHeadRevision: 1 }),
    (error: unknown) => errorCode(error) === "GATEWAY_POLICY_RELEASE_MANIFEST_IMMUTABLE",
  )
})

test("reads and locks the release head inside the caller transaction", async () => {
  const sql = new GatewayReleaseSql()
  const store = createPostgresGatewayPolicyReleaseStore({ sql })
  await store.save({ plan: await plan(), expectedHeadRevision: null })
  sql.calls.length = 0

  const head = await store.getHeadInTransaction({
    transaction: sql,
    tenantId: "tenant-acme",
    gatewayId: "ai-gateway",
  })

  assert.equal(head?.head_revision, 1)
  assert.match(sql.calls[0]!.text, /pg_advisory_xact_lock/)
  assert.match(sql.calls[1]!.text, /for update/)
})
