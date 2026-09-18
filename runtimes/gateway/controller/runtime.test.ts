import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import test from "node:test"

import {
  gatewayReleasePackageDigest,
  type GatewayReleasePackage,
} from "../../../apps/platform/platform-api/src/capabilities/gateway-policy-release/package"
import { createDurableEd25519Signer } from "../../../apps/platform/platform-api/src/capabilities/gateway-projection/signer"
import { signGatewayReleaseCommand } from "../../../apps/platform/platform-api/src/capabilities/runtime-control/gateway-release-integrity"
import { createGatewayRuntime } from "./runtime"

function signer(keyId: string) {
  const { privateKey } = generateKeyPairSync("ed25519")
  return createDurableEd25519Signer({
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    keyId,
  })
}

function releasePackage(): GatewayReleasePackage {
  const unsigned = {
    schema_version: "genio.one.gateway-release.v1" as const,
    tenant_id: "tenant-ai",
    runtime_id: "gateway-runtime-1",
    gateway_id: "ai-gateway",
    release_id: "release-7",
    head_revision: 7,
    projection_count: 0,
    manifest_jws: "manifest",
    authorization_bundle_jws: "authorization",
    processor_policy_jws: "processor",
    gateway_routing_artifact_jws: "routing",
    enforcement_verification_keys_json: "keys",
    gateway_configuration: { capture_message_content: false },
    projections: [],
  }
  return {
    ...unsigned,
    package_digest: gatewayReleasePackageDigest(unsigned),
  }
}

function authorityFloor() {
  return {
    async advance() {},
    async load() { return null },
  }
}

const deployment = {
  tenantId: "tenant-ai",
  runtimeId: "gateway-runtime-1",
  gatewayId: "ai-gateway",
}

test("a restored Gateway Runtime repeats READY with component observations", async () => {
  const platformSigner = signer("platform-command-key")
  const runtimeSigner = signer("gateway-report-key")
  const release = releasePackage()
  const command = await signGatewayReleaseCommand({
    tenantId: release.tenant_id,
    runtimeId: release.runtime_id,
    commandId: "command-release-7",
    release: {
      schema_version: "genio.one.gateway-release-ref.v1",
      release_id: release.release_id,
      gateway_id: release.gateway_id,
      head_revision: release.head_revision,
      package_digest: release.package_digest,
      projection_count: release.projection_count,
    },
    signer: platformSigner,
  })
  const components = [{
    component: "AI_GATEWAY" as const,
    state: "READY" as const,
    observed_revision: String(release.head_revision),
  }]
  let fetched = false
  const runtime = createGatewayRuntime({
    deployment,
    commandKeyRing: {
      schema_version: 1,
      keys: [{
        key_id: platformSigner.keyId,
        public_key_pem: platformSigner.publicKeyPem,
      }],
    },
    signer: runtimeSigner,
    async fetchRelease() {
      fetched = true
      return release
    },
    applier: {
      async apply() {
        return components
      },
    },
    authorityFloor: authorityFloor(),
    state: {
      async load() {
        return { command, release }
      },
      async save() {
        throw new Error("same-revision command must not rewrite current state")
      },
    },
  })

  assert.equal(await runtime.restore(), true)
  const report = await runtime.applyCommand(command)
  assert.equal(fetched, false)
  assert.equal(report.observed_status.state, "READY")
  assert.deepEqual(report.observed_status.components, components)
  assert.deepEqual(report.observed_status.applied_release, command.desired_release)
})

test("a restored Gateway Runtime can refresh its current READY observation without a command", async () => {
  const platformSigner = signer("platform-command-key")
  const runtimeSigner = signer("gateway-report-key")
  const release = releasePackage()
  const command = await signGatewayReleaseCommand({
    tenantId: release.tenant_id,
    runtimeId: release.runtime_id,
    commandId: "command-release-7",
    release: {
      schema_version: "genio.one.gateway-release-ref.v1",
      release_id: release.release_id,
      gateway_id: release.gateway_id,
      head_revision: release.head_revision,
      package_digest: release.package_digest,
      projection_count: release.projection_count,
    },
    signer: platformSigner,
  })
  const runtime = createGatewayRuntime({
    deployment,
    commandKeyRing: {
      schema_version: 1,
      keys: [{
        key_id: platformSigner.keyId,
        public_key_pem: platformSigner.publicKeyPem,
      }],
    },
    signer: runtimeSigner,
    async fetchRelease() {
      throw new Error("periodic report must not fetch a release")
    },
    applier: {
      async apply() {
        return [{
          component: "AI_GATEWAY" as const,
          state: "READY" as const,
          observed_revision: String(release.head_revision),
        }]
      },
    },
    authorityFloor: authorityFloor(),
    state: {
      async load() {
        return { command, release }
      },
      async save() {
        throw new Error("periodic report must not rewrite current state")
      },
    },
  })

  assert.equal(await runtime.reportCurrent(), null)
  assert.equal(await runtime.restore(), true)
  const report = await runtime.reportCurrent()
  assert.equal(report?.observed_status.state, "READY")
  assert.equal(report?.revision, command.revision)
  assert.deepEqual(report?.observed_status.applied_release, command.desired_release)
})

test("a desired release advances the authority floor before a failed apply retains LKG", async () => {
  const platformSigner = signer("platform-command-key")
  const runtimeSigner = signer("gateway-report-key")
  const release = releasePackage()
  const command = await signGatewayReleaseCommand({
    tenantId: release.tenant_id,
    runtimeId: release.runtime_id,
    commandId: "command-release-7",
    release: {
      schema_version: "genio.one.gateway-release-ref.v1",
      release_id: release.release_id,
      gateway_id: release.gateway_id,
      head_revision: release.head_revision,
      package_digest: release.package_digest,
      projection_count: release.projection_count,
    },
    signer: platformSigner,
  })
  let floorAdvanced = false
  const runtime = createGatewayRuntime({
    deployment,
    commandKeyRing: {
      schema_version: 1,
      keys: [{ key_id: platformSigner.keyId, public_key_pem: platformSigner.publicKeyPem }],
    },
    signer: runtimeSigner,
    async fetchRelease() { return release },
    authorityFloor: {
      async advance(input) {
        assert.equal(input.release.release_id, release.release_id)
        floorAdvanced = true
      },
      async load() { return null },
    },
    applier: {
      async apply() {
        assert.equal(floorAdvanced, true)
        throw new Error("native projection failed")
      },
    },
  })

  const report = await runtime.applyCommand(command)

  assert.equal(report.observed_status.state, "DEGRADED")
  assert.equal(floorAdvanced, true)
})

test("a signed command for another Installation or Site is rejected before release fetch", async () => {
  const platformSigner = signer("platform-command-key")
  const runtimeSigner = signer("gateway-report-key")
  const release = releasePackage()
  const command = await signGatewayReleaseCommand({
    tenantId: "tenant-other",
    runtimeId: "gateway-runtime-other-site",
    commandId: "command-cross-deployment",
    release: {
      schema_version: "genio.one.gateway-release-ref.v1",
      release_id: release.release_id,
      gateway_id: release.gateway_id,
      head_revision: release.head_revision,
      package_digest: release.package_digest,
      projection_count: release.projection_count,
    },
    signer: platformSigner,
  })
  let fetched = false
  const runtime = createGatewayRuntime({
    deployment,
    commandKeyRing: {
      schema_version: 1,
      keys: [{ key_id: platformSigner.keyId, public_key_pem: platformSigner.publicKeyPem }],
    },
    signer: runtimeSigner,
    async fetchRelease() {
      fetched = true
      return release
    },
    authorityFloor: authorityFloor(),
    applier: { async apply() { return [] } },
  })

  await assert.rejects(
    runtime.applyCommand(command),
    /Installation\/Site deployment binding/,
  )
  assert.equal(fetched, false)
})
