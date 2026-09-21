import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, sign as signPayload } from "node:crypto"
import test from "node:test"

import { Check } from "typebox/value"

import type { VerificationKeyRing } from "@genioone/protocol/compact-jws"
import { canonicalGatewayPolicyReleaseBytes, planGatewayPolicyRelease } from "../src/capabilities/gateway-policy-release/planner"
import type {
  CompactJwsSigner,
  GatewayPolicyReleaseInput,
  GatewayPolicyReleasePlan,
} from "../src/capabilities/gateway-policy-release/contract"
import type {
  GatewayPolicyReleaseManifestRecord,
  GatewayPolicyReleaseRecord,
  GatewayPolicyReleaseHead,
  SavedGatewayPolicyRelease,
} from "../src/capabilities/gateway-policy-release/module"
import {
  GatewayReleasePackageSchema,
  buildGatewayReleasePackage,
  gatewayReleasePackageDigest,
} from "../src/capabilities/gateway-policy-release/package"
import type { GatewayProjection } from "../src/capabilities/gateway-projection/contract"

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

function releaseInput(
  runtimeId = "gateway-runtime-1",
  projections: GatewayPolicyReleaseInput["projections"] = [
    {
      publication_id: "publication-a",
      projection_id: "projection-a",
      revision: 7,
      digest: "a".repeat(64),
    },
    {
      publication_id: "publication-b",
      projection_id: "projection-b",
      revision: 3,
      digest: "b".repeat(64),
    },
  ],
): GatewayPolicyReleaseInput {
  return {
    target: {
      tenant_id: "tenant-acme",
      runtime_id: runtimeId,
      gateway_id: "ai-gateway",
    },
    issued_at: 1_800_000_000,
    expires_at: 1_800_000_600,
    projections,
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

function projection(
  reference: GatewayPolicyReleaseInput["projections"][number],
  overrides: Partial<GatewayProjection> = {},
): GatewayProjection {
  const value: GatewayProjection = {
    schema_version: "genio.one.gateway.v1",
    projection_id: reference.projection_id,
    tenant_id: "tenant-acme",
    publication_id: reference.publication_id,
    resource_id: `resource-${reference.publication_id}`,
    capability_id: "chat",
    endpoint_revision: 1,
    policy_revision: 1,
    revision: reference.revision,
    digest: reference.digest,
    signature: {
      algorithm: "Ed25519",
      key_id: "projection-key",
      value: "A".repeat(86),
    },
    publication_endpoint: {
      gateway_id: "ai-gateway",
      hostname: `${reference.publication_id}.example.test`,
      base_path: "/",
    },
    policy_bundle: {
      enforcement_chain: {
        chain_id: `chain-${reference.publication_id}`,
        tenant_id: "tenant-acme",
        resource_id: `resource-${reference.publication_id}`,
        capability_id: "chat",
        eligible_connection_ids: ["connection-a"],
        one_policy_revision: 1,
        steps: [],
        request_filter_order: [],
        response_filter_order: [],
      },
    },
    operation: "APPLY",
    resources: [
      {
        apiVersion: "gateway.networking.k8s.io/v1",
        kind: "HTTPRoute",
        metadata: { name: `route-${reference.publication_id}` },
        spec: {},
      },
    ],
  }
  return { ...value, ...overrides }
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function savedRelease(plan: GatewayPolicyReleasePlan): SavedGatewayPolicyRelease {
  const contentDigest = plan.release_id.slice("release-".length)
  const projectionSetDigest = digest(
    canonicalGatewayPolicyReleaseBytes(plan.manifest.gateway_projections),
  )
  const release: GatewayPolicyReleaseRecord = {
    tenant_id: plan.target.tenant_id,
    release_id: plan.release_id,
    gateway_id: plan.target.gateway_id,
    policy_artifact_revision: plan.manifest.authorization_bundle.revision,
    policy_version: plan.manifest.authorization_bundle.policy_version,
    issued_at: plan.manifest.issued_at,
    expires_at: plan.manifest.expires_at,
    content_digest: contentDigest,
    projection_set_digest: projectionSetDigest,
    projections: plan.manifest.gateway_projections,
    authorization_bundle: plan.authorization_bundle,
    processor_policy: plan.processor_policy,
    gateway_routing_artifact: plan.gateway_routing_artifact,
    enforcement_verification_keys: plan.enforcement_verification_keys,
    created_at: plan.manifest.issued_at,
    updated_at: plan.manifest.issued_at,
  }
  const manifest: GatewayPolicyReleaseManifestRecord = {
    tenant_id: plan.target.tenant_id,
    release_id: plan.release_id,
    runtime_id: plan.target.runtime_id,
    gateway_id: plan.target.gateway_id,
    manifest: plan.manifest,
    manifest_jws: plan.manifest_jws,
    created_at: plan.manifest.issued_at,
    updated_at: plan.manifest.issued_at,
  }
  const head: GatewayPolicyReleaseHead = {
    tenant_id: plan.target.tenant_id,
    gateway_id: plan.target.gateway_id,
    release_id: plan.release_id,
    content_digest: contentDigest,
    head_revision: 4,
    updated_at: plan.manifest.issued_at,
  }
  return { target: plan.target, release, manifest, head }
}

async function fixture(
  runtimeId = "gateway-runtime-1",
  refs = releaseInput(runtimeId).projections,
): Promise<{ saved: SavedGatewayPolicyRelease; projections: GatewayProjection[] }> {
  const plan = await planGatewayPolicyRelease(releaseInput(runtimeId, refs))
  return {
    saved: savedRelease(plan),
    projections: refs.map((reference) => projection(reference)),
  }
}

test("builds a deterministic strict package and runtime release reference", async () => {
  const firstFixture = await fixture()
  const reversedFixture = await fixture("gateway-runtime-1", [
    firstFixture.saved.release.projections[1]!,
    firstFixture.saved.release.projections[0]!,
  ])
  const first = buildGatewayReleasePackage({
    saved: firstFixture.saved,
    projections: firstFixture.projections,
  })
  const second = buildGatewayReleasePackage({
    saved: reversedFixture.saved,
    projections: [...reversedFixture.projections].reverse(),
  })

  assert.deepEqual(first.package, second.package)
  assert.deepEqual(first.reference, second.reference)
  assert.equal(Check(GatewayReleasePackageSchema, first.package), true)
  assert.equal(first.package.projection_count, 2)
  assert.deepEqual(first.package.gateway_configuration, {
    capture_message_content: false,
  })
  assert.ok(first.package.gateway_routing_artifact_jws.length > 0)
  assert.equal(first.package.head_revision, 4)
  assert.equal(first.reference.projection_count, first.package.projection_count)
  assert.equal(first.reference.package_digest, first.package.package_digest)
  const { package_digest: _packageDigest, ...withoutDigest } = first.package
  assert.equal(first.package.package_digest, gatewayReleasePackageDigest(withoutDigest))
  assert.deepEqual(
    first.package.projections.map((entry) => entry.reference.publication_id),
    ["publication-a", "publication-b"],
  )
})

test("package digest is target-specific even when release content is shared", async () => {
  const firstFixture = await fixture("gateway-runtime-1")
  const secondFixture = await fixture("gateway-runtime-2")
  const first = buildGatewayReleasePackage(firstFixture)
  const second = buildGatewayReleasePackage(secondFixture)

  assert.equal(first.package.release_id, second.package.release_id)
  assert.notEqual(first.package.runtime_id, second.package.runtime_id)
  assert.notEqual(first.package.manifest_jws, second.package.manifest_jws)
  assert.notEqual(first.package.package_digest, second.package.package_digest)
  assert.notEqual(first.reference.package_digest, second.reference.package_digest)
})

test("allows an intentional empty release", async () => {
  const empty = await fixture("gateway-runtime-1", [])
  const result = buildGatewayReleasePackage(empty)

  assert.equal(result.package.projection_count, 0)
  assert.deepEqual(result.package.projections, [])
  assert.equal(result.reference.projection_count, 0)
  assert.equal(Check(GatewayReleasePackageSchema, result.package), true)
})

test("rejects a saved target that diverges from the persisted release", async () => {
  const base = await fixture()
  const mismatched: SavedGatewayPolicyRelease = {
    ...base.saved,
    target: { ...base.saved.target, gateway_id: "api-gateway" },
  }
  assert.throws(
    () => buildGatewayReleasePackage({ saved: mismatched, projections: base.projections }),
    /target does not match release, manifest, and head/,
  )
})

test("rejects missing, extra, duplicate, mismatched, and DELETE projections", async () => {
  const base = await fixture()
  assert.throws(
    () => buildGatewayReleasePackage({ saved: base.saved, projections: [base.projections[0]!] }),
    /projection set does not match saved release|missing a projection document/,
  )
  assert.throws(
    () => buildGatewayReleasePackage({
      saved: base.saved,
      projections: [
        ...base.projections,
        projection({
          publication_id: "publication-extra",
          projection_id: "projection-extra",
          revision: 1,
          digest: "e".repeat(64),
        }),
      ],
    }),
    /projection set does not match saved release|extra projection document/,
  )
  assert.throws(
    () => buildGatewayReleasePackage({
      saved: base.saved,
      projections: [
        base.projections[0]!,
        projection(base.saved.release.projections[0]!),
      ],
    }),
    /duplicate publication_id|duplicate projection_id/,
  )
  assert.throws(
    () => buildGatewayReleasePackage({
      saved: base.saved,
      projections: [
        base.projections[0]!,
        projection(base.saved.release.projections[1]!, { digest: "c".repeat(64) }),
      ],
    }),
    /does not match its reference/,
  )
  assert.throws(
    () => buildGatewayReleasePackage({
      saved: base.saved,
      projections: [
        base.projections[0]!,
        projection(base.saved.release.projections[1]!, { operation: "DELETE", resources: [] }),
      ],
    }),
    /cannot include a DELETE projection/,
  )
})

test("rejects a tampered routing artifact before packaging", async () => {
  const base = await fixture()
  const bytes = new TextEncoder().encode("tampered-routing-artifact")
  const tampered: SavedGatewayPolicyRelease = {
    ...base.saved,
    release: {
      ...base.saved.release,
      gateway_routing_artifact: {
        ...base.saved.release.gateway_routing_artifact,
        bytes,
        sha256: digest(bytes),
      },
    },
  }
  assert.throws(
    () => buildGatewayReleasePackage({ saved: tampered, projections: base.projections }),
    /metadata does not match manifest|compact JWS|routing artifact/i,
  )
})
