import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, sign as signPayload } from "node:crypto"
import test from "node:test"

import type { VerificationKeyRing } from "../../../../packages/protocol/src/compact-jws"
import type { SqlTransaction } from "../src/persistence/sql-adapter"
import type { ModelEntitlement } from "../src/capabilities/entitlements/contract"
import type { CompiledEnforcementChain } from "../src/capabilities/enforcement/contract"
import type { GatewayProjection } from "../src/capabilities/gateway-projection/contract"
import type { ModelRoutingPolicy } from "../src/capabilities/model-routing/contract"
import type {
  ConnectionModelMapping,
  PublicModel,
} from "../src/capabilities/models/contract"
import type { GatewayPolicyReleasePlan, CompactJwsSigner } from "../src/capabilities/gateway-policy-release/contract"
import type {
  GatewayPolicyReleaseHead,
  GatewayPolicyReleaseManifestRecord,
  GatewayPolicyReleaseRecord,
  SavedGatewayPolicyRelease,
} from "../src/capabilities/gateway-policy-release/module"
import { canonicalGatewayPolicyReleaseBytes } from "../src/capabilities/gateway-policy-release/planner"
import {
  createGatewayPublicationReleaseCoordinator,
} from "../src/capabilities/gateway-policy-release/publication-commit"
import type { GatewayAggregateCommandRecord } from "../src/capabilities/gateway-runtime-control/contract"
import type { GatewayReleaseReference } from "../../../../packages/protocol/src/gateway-release"

const TENANT_ID = "tenant-acme"
const GATEWAY_ID = "ai-gateway"
const RUNTIME_ID = "gateway-runtime-1"
const ISSUED_AT = 1_800_000_000

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
const releaseRootSigner = signer("release-root-key")
const verificationKeys: VerificationKeyRing = {
  schema_version: 1,
  keys: [{ key_id: artifactSigner.keyId, public_key_pem: artifactSigner.publicKeyPem }],
}

function chain(): CompiledEnforcementChain {
  return {
    chain_id: "chain-resource-a-chat",
    tenant_id: TENANT_ID,
    resource_id: "resource-a",
    capability_id: "chat",
    eligible_connection_ids: ["connection-a"],
    one_policy_revision: 7,
    steps: [
      {
        step_id: "authenticate",
        kind: "AUTHENTICATE",
        phase: "REQUEST",
        implementation: "NATIVE",
        config: {
          schema_version: "genio.one.auth.jwt.v1",
          provider: "tenant-oidc",
          issuer: "https://identity.example.test",
          audiences: ["genio-one"],
          remote_jwks_uri: "https://identity.example.test/.well-known/jwks.json",
          subject_claim: "sub",
          client_claim: "azp",
        },
      },
      {
        step_id: "authorize",
        kind: "AUTHORIZE",
        phase: "REQUEST",
        implementation: "EXT_AUTH",
      },
      {
        step_id: "route",
        kind: "ROUTE",
        phase: "ROUTING",
        implementation: "AIGW_NATIVE",
      },
    ],
    request_filter_order: ["authorize"],
    response_filter_order: [],
  }
}

function projection(): GatewayProjection {
  return {
    schema_version: "genio.one.gateway.v1",
    projection_id: "projection-a",
    tenant_id: TENANT_ID,
    publication_id: "publication-a",
    resource_id: "resource-a",
    capability_id: "chat",
    endpoint_revision: 1,
    policy_revision: 7,
    revision: 11,
    digest: "a".repeat(64),
    signature: {
      algorithm: "Ed25519",
      key_id: "projection-key",
      value: "A".repeat(86),
    },
    publication_endpoint: {
      gateway_id: GATEWAY_ID,
      hostname: "chat.example.test",
      base_path: "/",
    },
    policy_bundle: { enforcement_chain: chain() },
    operation: "APPLY",
    resources: [
      {
        apiVersion: "gateway.networking.k8s.io/v1",
        kind: "HTTPRoute",
        metadata: { name: "chat" },
        spec: {},
      },
    ],
  }
}

const publicModel: PublicModel = {
  tenant_id: TENANT_ID,
  model_id: "model-a",
  model_name: "genio-chat",
  display_name: "Genio Chat",
  resource_id: "resource-a",
  visibility: "PUBLIC",
  lifecycle: "PUBLISHED",
  capabilities: ["CHAT"],
  created_at: 1,
}

const entitlement: ModelEntitlement = {
  tenant_id: TENANT_ID,
  entitlement_id: "entitlement-a",
  subject_id: "subject-a",
  client_id: "client-a",
  resource_id: "resource-a",
  capability_id: "chat",
  public_model_id: "model-a",
  state: "ACTIVE",
  starts_at: ISSUED_AT - 1,
  expires_at: ISSUED_AT + 120,
  created_at: 1,
}

const modelMapping: ConnectionModelMapping = {
  tenant_id: TENANT_ID,
  mapping_id: "mapping-a",
  public_model_id: publicModel.model_id,
  resource_id: publicModel.resource_id,
  connection_id: "connection-a",
  provider_model: "gpt-4.1",
  mapping_revision: 3,
  created_at: 1,
}

const routingPolicy: ModelRoutingPolicy = {
  tenant_id: TENANT_ID,
  routing_policy_id: "routing-chat",
  owner_organization_id: "org-acme",
  resource_id: publicModel.resource_id,
  capability_id: "chat",
  routing_revision: 2,
  mode: "DETERMINISTIC",
  candidate_public_model_ids: [publicModel.model_id],
  default_public_model_id: publicModel.model_id,
  session_lease_seconds: null,
  created_at: 1,
  updated_at: 1,
}

const resourceOwner = {
  tenant_id: TENANT_ID,
  resource_id: publicModel.resource_id,
  owner_organization_id: routingPolicy.owner_organization_id,
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function savedRelease(plan: GatewayPolicyReleasePlan, headRevision = 5): SavedGatewayPolicyRelease {
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
    head_revision: headRevision,
    updated_at: plan.manifest.issued_at,
  }
  return { release, target: plan.target, manifest, head }
}

function commandFor(release: GatewayReleaseReference): GatewayAggregateCommandRecord {
  return {
    tenant_id: TENANT_ID,
    runtime_kind: "GATEWAY",
    runtime_id: RUNTIME_ID,
    command_id: "command-a",
    release_id: release.release_id,
    gateway_id: release.gateway_id,
    head_revision: release.head_revision,
    package_digest: release.package_digest,
    projection_count: release.projection_count,
    command: {
      schema_version: "genio.one.runtime.v1",
      message_type: "COMMAND",
      tenant_id: TENANT_ID,
      runtime_id: RUNTIME_ID,
      command_id: "command-a",
      revision: `release-${release.head_revision}`,
      digest: "b".repeat(64),
      signature: { algorithm: "Ed25519", key_id: "runtime-key", value: "A".repeat(86) },
      runtime_kind: "GATEWAY",
      desired_release: release,
    },
    state: "PENDING",
    failure_code: null,
    failure_message: null,
    created_at: ISSUED_AT,
    delivered_at: null,
    acknowledged_at: null,
    failed_at: null,
    updated_at: ISSUED_AT,
  }
}

function dependencies() {
  const calls: string[] = []
  const scheduledRuntimeIds: string[] = []
  const transaction: SqlTransaction = {
    async query() {
      throw new Error("coordinator dependencies must own SQL")
    },
  }
  return {
    calls,
    scheduledRuntimeIds,
    transaction,
    activeProjections: {
      async listActiveForGatewayInTransaction(input: { transaction: SqlTransaction }) {
        assert.equal(input.transaction, transaction)
        calls.push("projections")
        return [projection()]
      },
    },
    runtimeSelector: {
      async selectGatewayGroupInTransaction(input: { transaction: SqlTransaction }) {
        assert.equal(input.transaction, transaction)
        calls.push("runtime")
        return { tenant_id: TENANT_ID, gateway_id: GATEWAY_ID, runtime_ids: [RUNTIME_ID] }
      },
    },
    policyInputs: {
      async loadForGatewayInTransaction(input: { transaction: SqlTransaction }) {
        assert.equal(input.transaction, transaction)
        calls.push("policy-inputs")
        return {
          enforcement_chains: [chain()],
          public_models: [publicModel],
          entitlements: [entitlement],
          resource_owners: [resourceOwner],
          routing_policies: [routingPolicy],
          model_mappings: [modelMapping],
        }
      },
    },
    releases: {
      async getHeadInTransaction(input: { transaction: SqlTransaction }) {
        assert.equal(input.transaction, transaction)
        calls.push("head")
        return {
          tenant_id: TENANT_ID,
          gateway_id: GATEWAY_ID,
          release_id: "release-old",
          content_digest: "c".repeat(64),
          head_revision: 4,
          updated_at: 1,
        }
      },
      async saveInTransaction(input: {
        transaction: SqlTransaction
        expectedHeadRevision: number | null
        plan: GatewayPolicyReleasePlan
      }) {
        assert.equal(input.transaction, transaction)
        assert.equal(input.expectedHeadRevision, 4)
        calls.push("save")
        return savedRelease(input.plan)
      },
    },
    scheduler: {
      async enqueueGatewayReleaseInTransaction(input: {
        transaction: SqlTransaction
        runtimeId: string
        release: Parameters<typeof commandFor>[0]
      }) {
        assert.equal(input.transaction, transaction)
        calls.push("enqueue")
        scheduledRuntimeIds.push(input.runtimeId)
        return commandFor(input.release)
      },
    },
  }
}

function onlyDelivery(result: Awaited<ReturnType<
  ReturnType<typeof createGatewayPublicationReleaseCoordinator>["commitInTransaction"]
>>) {
  assert.equal(result.deliveries.length, 1)
  return result.deliveries[0]!
}

test("commits one deterministic aggregate release in the owning transaction", async () => {
  const deps = dependencies()
  const coordinator = createGatewayPublicationReleaseCoordinator({
    activeProjections: deps.activeProjections,
    runtimeSelector: deps.runtimeSelector,
    policyInputs: deps.policyInputs,
    releases: deps.releases,
    scheduler: deps.scheduler,
    artifactSigner,
    releaseRootSigner,
    verificationKeys,
    releaseTtlSeconds: 600,
  })

  const first = await coordinator.commitInTransaction({
    transaction: deps.transaction,
    tenantId: TENANT_ID,
    gatewayId: GATEWAY_ID,
    candidate: projection(),
    issuedAt: ISSUED_AT,
  })
  const firstDelivery = onlyDelivery(first)
  assert.deepEqual(deps.calls, [
    "projections",
    "runtime",
    "policy-inputs",
    "head",
    "save",
    "enqueue",
  ])
  assert.equal(firstDelivery.saved.release.expires_at, entitlement.expires_at)
  assert.equal(firstDelivery.package.release_id, firstDelivery.saved.release.release_id)
  assert.equal(firstDelivery.command.package_digest, firstDelivery.package.package_digest)
  assert.equal(firstDelivery.command.head_revision, firstDelivery.saved.head.head_revision)
  assert.equal(firstDelivery.command.projection_count, 1)
  assert.equal(
    firstDelivery.saved.release.gateway_routing_artifact.sha256,
    firstDelivery.saved.manifest.manifest.gateway_routing_artifact.sha256,
  )
  assert.equal(
    digest(new TextEncoder().encode(firstDelivery.package.gateway_routing_artifact_jws)),
    firstDelivery.saved.release.gateway_routing_artifact.sha256,
  )

  deps.calls.length = 0
  const second = await coordinator.commitInTransaction({
    transaction: deps.transaction,
    tenantId: TENANT_ID,
    gatewayId: GATEWAY_ID,
    candidate: projection(),
    issuedAt: ISSUED_AT,
  })
  const secondDelivery = onlyDelivery(second)
  assert.equal(second.release_id, first.release_id)
  assert.equal(secondDelivery.package.package_digest, firstDelivery.package.package_digest)
})

test("fans one Gateway Group release out to every eligible replica", async () => {
  const deps = dependencies()
  deps.runtimeSelector.selectGatewayGroupInTransaction = async () => ({
    tenant_id: TENANT_ID,
    gateway_id: GATEWAY_ID,
    runtime_ids: ["gateway-runtime-1", "gateway-runtime-2"],
  })
  const coordinator = createGatewayPublicationReleaseCoordinator({
    activeProjections: deps.activeProjections,
    runtimeSelector: deps.runtimeSelector,
    policyInputs: deps.policyInputs,
    releases: deps.releases,
    scheduler: deps.scheduler,
    artifactSigner,
    releaseRootSigner,
    verificationKeys,
    releaseTtlSeconds: 600,
  })

  const result = await coordinator.commitInTransaction({
    transaction: deps.transaction,
    tenantId: TENANT_ID,
    gatewayId: GATEWAY_ID,
    candidate: projection(),
    issuedAt: ISSUED_AT,
  })

  assert.equal(result.deliveries.length, 2)
  assert.deepEqual(deps.scheduledRuntimeIds, ["gateway-runtime-1", "gateway-runtime-2"])
  assert.deepEqual(
    result.deliveries.map((delivery) => delivery.saved.target.runtime_id),
    ["gateway-runtime-1", "gateway-runtime-2"],
  )
  assert.equal(result.deliveries[0]!.saved.release.release_id, result.release_id)
  assert.equal(result.deliveries[1]!.saved.release.release_id, result.release_id)
  assert.notEqual(
    result.deliveries[0]!.package.package_digest,
    result.deliveries[1]!.package.package_digest,
  )
})

test("reconciles an empty aggregate release after the final route retires", async () => {
  const deps = dependencies()
  deps.activeProjections.listActiveForGatewayInTransaction = async (input) => {
    assert.equal(input.transaction, deps.transaction)
    deps.calls.push("projections")
    return []
  }
  deps.policyInputs.loadForGatewayInTransaction = async (input) => {
    assert.equal(input.transaction, deps.transaction)
    deps.calls.push("policy-inputs")
    return {
      enforcement_chains: [],
      public_models: [],
      entitlements: [],
      resource_owners: [],
      routing_policies: [],
      model_mappings: [],
    }
  }
  const coordinator = createGatewayPublicationReleaseCoordinator({
    activeProjections: deps.activeProjections,
    runtimeSelector: deps.runtimeSelector,
    policyInputs: deps.policyInputs,
    releases: deps.releases,
    scheduler: deps.scheduler,
    artifactSigner,
    releaseRootSigner,
    verificationKeys,
    releaseTtlSeconds: 600,
  })

  const result = await coordinator.reconcileInTransaction({
    transaction: deps.transaction,
    tenantId: TENANT_ID,
    gatewayId: GATEWAY_ID,
    issuedAt: ISSUED_AT,
  })

  const resultDelivery = onlyDelivery(result)
  assert.equal(resultDelivery.package.projection_count, 0)
  assert.deepEqual(resultDelivery.package.projections, [])
  assert.equal(resultDelivery.command.projection_count, 0)
})

test("routing policy and mapping revisions participate in the aggregate release identity", async () => {
  const deps = dependencies()
  const coordinator = createGatewayPublicationReleaseCoordinator({
    activeProjections: deps.activeProjections,
    runtimeSelector: deps.runtimeSelector,
    policyInputs: deps.policyInputs,
    releases: deps.releases,
    scheduler: deps.scheduler,
    artifactSigner,
    releaseRootSigner,
    verificationKeys,
    releaseTtlSeconds: 600,
  })
  const original = await coordinator.commitInTransaction({
    transaction: deps.transaction,
    tenantId: TENANT_ID,
    gatewayId: GATEWAY_ID,
    candidate: projection(),
    issuedAt: ISSUED_AT,
  })

  deps.policyInputs.loadForGatewayInTransaction = async () => ({
    enforcement_chains: [chain()],
    public_models: [publicModel],
    entitlements: [entitlement],
    resource_owners: [resourceOwner],
    routing_policies: [{ ...routingPolicy, routing_revision: 3, updated_at: 2 }],
    model_mappings: [{ ...modelMapping, mapping_revision: 4 }],
  })
  const revised = await coordinator.commitInTransaction({
    transaction: deps.transaction,
    tenantId: TENANT_ID,
    gatewayId: GATEWAY_ID,
    candidate: projection(),
    issuedAt: ISSUED_AT,
  })

  assert.notEqual(revised.release_id, original.release_id)
  assert.notEqual(
    onlyDelivery(revised).package.package_digest,
    onlyDelivery(original).package.package_digest,
  )
})

test("Usage Policy and managed Usage Context participate in the signed release identity", async () => {
  const deps = dependencies()
  let usageRevision = 1
  deps.policyInputs.loadForGatewayInTransaction = async () => ({
    enforcement_chains: [chain()],
    public_models: [publicModel],
    entitlements: [entitlement],
    resource_owners: [resourceOwner],
    routing_policies: [routingPolicy],
    model_mappings: [modelMapping],
    usage_policies: [{
      tenant_id: TENANT_ID,
      usage_policy_id: "usage-policy-a",
      revision: usageRevision,
      owner_organization_id: "org-acme",
      accounting_key_id: "accounting-shared",
      selectors: { resource_id: "resource-a", capability_id: "chat" },
      limits: { request_quota: { limit: usageRevision === 1 ? 10 : 5, window_seconds: 60 } },
      state: "ACTIVE",
      created_at: ISSUED_AT,
    }],
    usage_contexts: [{
      subject_id: "subject-a",
      consumer_organization_id: "org-consumer",
      use_case_id: "support-assistant",
    }],
  })
  const coordinator = createGatewayPublicationReleaseCoordinator({
    activeProjections: deps.activeProjections,
    runtimeSelector: deps.runtimeSelector,
    policyInputs: deps.policyInputs,
    releases: deps.releases,
    scheduler: deps.scheduler,
    artifactSigner,
    releaseRootSigner,
    verificationKeys,
    releaseTtlSeconds: 600,
  })
  const original = await coordinator.commitInTransaction({
    transaction: deps.transaction,
    tenantId: TENANT_ID,
    gatewayId: GATEWAY_ID,
    candidate: projection(),
    issuedAt: ISSUED_AT,
  })
  usageRevision = 2
  const revised = await coordinator.commitInTransaction({
    transaction: deps.transaction,
    tenantId: TENANT_ID,
    gatewayId: GATEWAY_ID,
    candidate: projection(),
    issuedAt: ISSUED_AT,
  })
  assert.notEqual(revised.release_id, original.release_id)
  assert.notEqual(
    onlyDelivery(revised).package.authorization_bundle_jws,
    onlyDelivery(original).package.authorization_bundle_jws,
  )
})

test("requires separate artifact and release-root signing roles", () => {
  const deps = dependencies()
  assert.throws(
    () => createGatewayPublicationReleaseCoordinator({
      activeProjections: deps.activeProjections,
      runtimeSelector: deps.runtimeSelector,
      policyInputs: deps.policyInputs,
      releases: deps.releases,
      scheduler: deps.scheduler,
      artifactSigner,
      releaseRootSigner: artifactSigner,
      verificationKeys,
      releaseTtlSeconds: 600,
    }),
    /distinct keys/,
  )
})

test("rejects a runtime selector result outside the publication target", async () => {
  const deps = dependencies()
  deps.runtimeSelector.selectGatewayGroupInTransaction = async () => ({
    tenant_id: TENANT_ID,
    gateway_id: "other-gateway",
    runtime_ids: [RUNTIME_ID],
  })
  const coordinator = createGatewayPublicationReleaseCoordinator({
    activeProjections: deps.activeProjections,
    runtimeSelector: deps.runtimeSelector,
    policyInputs: deps.policyInputs,
    releases: deps.releases,
    scheduler: deps.scheduler,
    artifactSigner,
    releaseRootSigner,
    verificationKeys,
    releaseTtlSeconds: 600,
  })

  await assert.rejects(
    coordinator.commitInTransaction({
      transaction: deps.transaction,
      tenantId: TENANT_ID,
      gatewayId: GATEWAY_ID,
      candidate: projection(),
      issuedAt: ISSUED_AT,
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "RUNTIME_RELEASE_TARGET_MISMATCH",
  )
})
