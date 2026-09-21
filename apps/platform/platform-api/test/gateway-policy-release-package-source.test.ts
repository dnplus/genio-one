import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, sign as signPayload } from "node:crypto"
import test from "node:test"

import type { VerificationKeyRing } from "@genioone/protocol/compact-jws"
import type {
  CompactJwsSigner,
  GatewayPolicyReleaseInput,
  GatewayPolicyReleasePlan,
} from "../src/capabilities/gateway-policy-release/contract"
import type {
  GatewayPolicyReleaseHead,
  GatewayPolicyReleaseManifestRecord,
  GatewayPolicyReleaseRecord,
  GatewayPolicyReleaseStore,
  SavedGatewayPolicyRelease,
} from "../src/capabilities/gateway-policy-release/module"
import { createGatewayReleasePackageSource } from "../src/capabilities/gateway-policy-release/package-source"
import {
  canonicalGatewayPolicyReleaseBytes,
  planGatewayPolicyRelease,
} from "../src/capabilities/gateway-policy-release/planner"
import type { GatewayProjection } from "../src/capabilities/gateway-projection/contract"
import { PlatformApiError } from "../src/capabilities/errors"

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
const rootSigner = signer("root-key")
const keyRing: VerificationKeyRing = {
  schema_version: 1,
  keys: [{ key_id: artifactSigner.keyId, public_key_pem: artifactSigner.publicKeyPem }],
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function input(): GatewayPolicyReleaseInput {
  return {
    target: {
      tenant_id: "tenant-acme",
      runtime_id: "gateway-runtime-1",
      gateway_id: "ai-gateway",
    },
    issued_at: 1_800_000_000,
    expires_at: 1_800_000_600,
    projections: [{
      publication_id: "publication-1",
      projection_id: "projection-1",
      revision: 3,
      digest: "a".repeat(64),
    }],
    authorization_bundle: {
      schema_version: 1,
      tenant_id: "tenant-acme",
      revision: "policy-3",
      policy_version: "policy-v3",
      issued_at: 1_800_000_000,
      expires_at: 1_800_000_600,
      rules: [],
    },
    processor_policy: {
      schema_version: 1,
      tenant_id: "tenant-acme",
      revision: "policy-3",
      policy_version: "policy-v3",
      issued_at: 1_800_000_000,
      expires_at: 1_800_000_600,
      scopes: [],
    },
    gateway_routing_artifact: {
      schema_version: "genio.one.gateway-routing.v1",
      tenant_id: "tenant-acme",
      gateway_id: "ai-gateway",
      revision: "policy-3",
      policy_version: "policy-v3",
      issued_at: 1_800_000_000,
      expires_at: 1_800_000_600,
      scopes: [],
    },
    enforcement_verification_keys: keyRing,
    artifact_signer: artifactSigner,
    release_root_signer: rootSigner,
  }
}

function projection(plan: GatewayPolicyReleasePlan): GatewayProjection {
  const reference = plan.manifest.gateway_projections[0]!
  return {
    schema_version: "genio.one.gateway.v1",
    projection_id: reference.projection_id,
    tenant_id: plan.target.tenant_id,
    publication_id: reference.publication_id,
    resource_id: "resource-1",
    capability_id: "chat",
    endpoint_revision: 1,
    policy_revision: 1,
    revision: reference.revision,
    digest: reference.digest,
    signature: { algorithm: "Ed25519", key_id: "projection-key", value: "A".repeat(86) },
    publication_endpoint: {
      gateway_id: plan.target.gateway_id,
      hostname: "chat.example.test",
      base_path: "/",
    },
    policy_bundle: {
      enforcement_chain: {
        chain_id: "chain-1",
        tenant_id: plan.target.tenant_id,
        resource_id: "resource-1",
        capability_id: "chat",
        eligible_connection_ids: ["connection-1"],
        one_policy_revision: 1,
        steps: [],
        request_filter_order: [],
        response_filter_order: [],
      },
    },
    operation: "APPLY",
    resources: [{
      apiVersion: "gateway.networking.k8s.io/v1",
      kind: "HTTPRoute",
      metadata: { name: "route-1" },
      spec: {},
    }],
  }
}

function saved(plan: GatewayPolicyReleasePlan): SavedGatewayPolicyRelease {
  const contentDigest = plan.release_id.slice("release-".length)
  const release: GatewayPolicyReleaseRecord = {
    tenant_id: plan.target.tenant_id,
    release_id: plan.release_id,
    gateway_id: plan.target.gateway_id,
    policy_artifact_revision: plan.manifest.authorization_bundle.revision,
    policy_version: plan.manifest.authorization_bundle.policy_version,
    issued_at: plan.manifest.issued_at,
    expires_at: plan.manifest.expires_at,
    content_digest: contentDigest,
    projection_set_digest: digest(
      canonicalGatewayPolicyReleaseBytes(plan.manifest.gateway_projections),
    ),
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
    head_revision: 1,
    updated_at: plan.manifest.issued_at,
  }
  return { release, manifest, head, target: plan.target }
}

function releaseStore(value: SavedGatewayPolicyRelease): GatewayPolicyReleaseStore {
  return {
    save: async () => value,
    saveInTransaction: async () => value,
    get: async ({ tenantId, releaseId }) =>
      tenantId === value.release.tenant_id && releaseId === value.release.release_id
        ? value.release
        : null,
    getManifest: async ({ tenantId, releaseId, runtimeId }) =>
      tenantId === value.manifest.tenant_id &&
        releaseId === value.manifest.release_id &&
        runtimeId === value.manifest.runtime_id
        ? value.manifest
        : null,
    getHead: async () => value.head,
    getHeadInTransaction: async () => value.head,
  }
}

test("rehydrates the exact target package at the command's historical head", async () => {
  const plan = await planGatewayPolicyRelease(input())
  const persisted = saved(plan)
  const document = projection(plan)
  const source = createGatewayReleasePackageSource({
    releases: releaseStore(persisted),
    projections: {
      getProjection: async ({ projectionId }) =>
        projectionId === document.projection_id ? document : null,
    },
  })

  const value = await source.getPackage({
    tenantId: plan.target.tenant_id,
    runtimeId: plan.target.runtime_id,
    releaseId: plan.release_id,
    headRevision: 12,
  })
  assert.ok(value)
  assert.equal(value.head_revision, 12)
  assert.equal(value.release_id, plan.release_id)
  assert.equal(value.runtime_id, plan.target.runtime_id)
  assert.equal(value.projection_count, 1)
  assert.equal(value.projections[0]?.projection.projection_id, document.projection_id)
})

test("does not expose a release without the runtime-specific manifest", async () => {
  const plan = await planGatewayPolicyRelease(input())
  const source = createGatewayReleasePackageSource({
    releases: releaseStore(saved(plan)),
    projections: { getProjection: async () => projection(plan) },
  })
  assert.equal(await source.getPackage({
    tenantId: plan.target.tenant_id,
    runtimeId: "another-runtime",
    releaseId: plan.release_id,
    headRevision: 1,
  }), null)
})

test("fails closed when an immutable release projection is missing", async () => {
  const plan = await planGatewayPolicyRelease(input())
  const source = createGatewayReleasePackageSource({
    releases: releaseStore(saved(plan)),
    projections: { getProjection: async () => null },
  })
  await assert.rejects(source.getPackage({
    tenantId: plan.target.tenant_id,
    runtimeId: plan.target.runtime_id,
    releaseId: plan.release_id,
    headRevision: 1,
  }), (error: unknown) =>
    error instanceof PlatformApiError &&
    error.code === "GATEWAY_RELEASE_PACKAGE_PROJECTION_MISSING")
})
