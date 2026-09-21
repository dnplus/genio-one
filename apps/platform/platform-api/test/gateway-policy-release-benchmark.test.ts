import assert from "node:assert/strict"
import { generateKeyPairSync, sign as signPayload } from "node:crypto"
import test from "node:test"

import type { VerificationKeyRing } from "@genioone/protocol/compact-jws"
import type {
  CompactJwsSigner,
  GatewayPolicyReleaseInput,
  GatewayProjectionReleaseReference,
} from "../src/capabilities/gateway-policy-release/contract"
import { planGatewayPolicyRelease } from "../src/capabilities/gateway-policy-release/planner"
import { createPostgresGatewayPolicyReleaseStore } from "../src/capabilities/gateway-policy-release/postgres"
import { compareUtf8 } from "@genioone/protocol/canonical"
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

function generateProjections(count: number): GatewayProjectionReleaseReference[] {
  const projections: GatewayProjectionReleaseReference[] = []
  for (let i = 0; i < count; i++) {
    projections.push({
      publication_id: `pub-${i}`,
      projection_id: `proj-${i}`,
      revision: i + 1,
      digest: "a".repeat(64),
    })
  }
  return projections
}

function releaseInput(projectionsCount: number): GatewayPolicyReleaseInput {
  return {
    target: {
      tenant_id: "tenant-acme",
      runtime_id: "gateway-runtime-1",
      gateway_id: "ai-gateway",
    },
    issued_at: 1_800_000_000,
    expires_at: 1_800_000_600,
    projections: generateProjections(projectionsCount),
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
  }
}

function key(...values: unknown[]): string {
  return values.join("\u0000")
}

class BenchmarkSql implements SqlAdapter, SqlTransaction {
  callsCount = 0
  readonly releases = new Map<string, Row>()
  readonly projections: Row[] = []
  readonly manifests = new Map<string, Row>()
  readonly heads = new Map<string, Row>()

  async query<Result extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Result>> {
    this.callsCount++
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
      for (let i = 0; i < parameters.length; i += 6) {
        this.projections.push({
          tenant_id: parameters[i],
          release_id: parameters[i + 1],
          publication_id: parameters[i + 2],
          projection_id: parameters[i + 3],
          projection_revision: parameters[i + 4],
          projection_digest: parameters[i + 5],
        })
      }
      return { rows: [], rowCount: parameters.length / 6 }
    }

    if (text.includes("from genio_one_gateway_policy_release_projections")) {
      const rows = this.projections
        .filter((row) => row.tenant_id === parameters[0] && row.release_id === parameters[1])
        .sort((left, right) => {
          const pub = compareUtf8(String(left.publication_id), String(right.publication_id))
          if (pub !== 0) return pub
          return compareUtf8(String(left.projection_id), String(right.projection_id))
        })
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

    throw new Error(`Unexpected SQL in benchmark: ${text}`)
  }

  transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
    return work(this)
  }
}

test("benchmark projection save batching", async () => {
  const counts = [50, 100, 500]
  for (const count of counts) {
    const input = releaseInput(count)
    const plan = await planGatewayPolicyRelease(input)
    const sql = new BenchmarkSql()
    const store = createPostgresGatewayPolicyReleaseStore({ sql })

    const start = performance.now()
    const saved = await store.save({ plan, expectedHeadRevision: null })
    const elapsedMs = performance.now() - start

    assert.equal(saved.release.projections.length, count)
    console.log(`[BENCHMARK] Projections: ${count} | SQL Queries: ${sql.callsCount} | Time: ${elapsedMs.toFixed(3)}ms`)
  }
})
