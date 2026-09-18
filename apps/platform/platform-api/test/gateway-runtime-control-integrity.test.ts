import assert from "node:assert/strict"
import { generateKeyPairSync, sign as signPayload } from "node:crypto"
import test from "node:test"

import { createDurableEd25519Signer } from "../src/capabilities/gateway-projection/signer"
import type {
  GatewayReleaseReference,
  GatewayRuntimeCommand,
} from "../../../../packages/protocol/src/gateway-release"
import {
  RUNTIME_PROTOCOL_SCHEMA_VERSION,
} from "../../../../packages/protocol/src/gateway-release"
import {
  runtimeProtocolDigest,
  runtimeProtocolSignaturePayload,
  signGatewayReleaseCommand,
  verifyGatewayReleaseReport,
  verifyRuntimeMessage,
} from "../src/capabilities/runtime-control/gateway-release-integrity"

function keyPair() {
  const { privateKey } = generateKeyPairSync("ed25519")
  const signer = createDurableEd25519Signer({
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  })
  return { signer, privateKey }
}

function release(headRevision: number, suffix = "a"): GatewayReleaseReference {
  return {
    schema_version: "genio.one.gateway-release-ref.v1",
    release_id: `release-${suffix}`,
    gateway_id: "ai-gateway",
    head_revision: headRevision,
    package_digest: suffix.repeat(64),
    projection_count: headRevision,
  }
}

function signedReport(
  command: GatewayRuntimeCommand,
  reportKey: ReturnType<typeof keyPair>,
  observedStatus: Record<string, unknown>,
  reportId = `report-${command.command_id}`,
): Record<string, unknown> {
  const status = observedStatus.state === "READY" && observedStatus.components === undefined
    ? {
      ...observedStatus,
      components: ["AI_GATEWAY", "AUTHORIZER", "PROCESSOR"].map((component) => ({
        component,
        state: "READY",
        observed_revision: command.revision,
      })),
    }
    : observedStatus
  const unsigned = {
    schema_version: RUNTIME_PROTOCOL_SCHEMA_VERSION,
    message_type: "REPORT" as const,
    tenant_id: command.tenant_id,
    runtime_id: command.runtime_id,
    report_id: reportId,
    command_id: command.command_id,
    revision: command.revision,
    digest: "0".repeat(64),
    signature: {
      algorithm: "Ed25519" as const,
      key_id: reportKey.signer.keyId,
      value: "placeholder",
    },
    runtime_kind: "GATEWAY" as const,
    observed_status: status,
  }
  const digest = runtimeProtocolDigest(unsigned)
  const digestBearing = { ...unsigned, digest }
  const signature = signPayload(
    null,
    Buffer.from(runtimeProtocolSignaturePayload(digestBearing)),
    reportKey.privateKey,
  ).toString("base64url")
  return {
    ...digestBearing,
    signature: { ...unsigned.signature, value: signature },
  }
}

test("signs and verifies one aggregate Gateway release command", async () => {
  const platform = keyPair()
  const command = await signGatewayReleaseCommand({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    commandId: "release-command-1",
    release: release(7),
    signer: platform.signer,
  })

  assert.equal(command.revision, "7")
  assert.deepEqual(command.desired_release, release(7))
  assert.deepEqual(verifyRuntimeMessage({
    message: command,
    publicKeyPem: platform.signer.publicKeyPem,
    expectedKeyId: platform.signer.keyId,
  }), command)
})

test("accepts READY only when the exact commanded release was applied", async () => {
  const platform = keyPair()
  const runtime = keyPair()
  const desired = release(7)
  const command = await signGatewayReleaseCommand({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    commandId: "release-command-1",
    release: desired,
    signer: platform.signer,
  })
  const report = signedReport(command, runtime, {
    state: "READY",
    applied_release: desired,
    components: [
      {
        component: "AI_GATEWAY",
        state: "READY",
        observed_revision: "7",
        payload: { active_routes: 7 },
      },
      { component: "AUTHORIZER", state: "READY", observed_revision: "7" },
      { component: "PROCESSOR", state: "READY", observed_revision: "7" },
    ],
  })

  assert.equal(verifyGatewayReleaseReport({
    report,
    publicKeyPem: runtime.signer.publicKeyPem,
    reportKeyId: runtime.signer.keyId,
    tenantId: command.tenant_id,
    runtimeId: command.runtime_id,
    commandId: command.command_id,
    desiredRelease: desired,
  }).observed_status.state, "READY")

  const mismatched = signedReport(command, runtime, {
    state: "READY",
    applied_release: release(7, "b"),
  }, "report-mismatched")
  assert.throws(() => verifyGatewayReleaseReport({
    report: mismatched,
    publicKeyPem: runtime.signer.publicKeyPem,
    reportKeyId: runtime.signer.keyId,
    tenantId: command.tenant_id,
    runtimeId: command.runtime_id,
    commandId: command.command_id,
    desiredRelease: desired,
  }), /does not match the commanded Gateway release/)
})

test("a non-ready report can retain only the trusted prior release", async () => {
  const platform = keyPair()
  const runtime = keyPair()
  const prior = release(6, "b")
  const command = await signGatewayReleaseCommand({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    commandId: "release-command-2",
    release: release(7),
    signer: platform.signer,
  })
  const retained = signedReport(command, runtime, {
    state: "DEGRADED",
    applied_release: prior,
    error: { code: "APPLY_FAILED", message: "kept last known good release" },
  })
  assert.equal(verifyGatewayReleaseReport({
    report: retained,
    publicKeyPem: runtime.signer.publicKeyPem,
    reportKeyId: runtime.signer.keyId,
    tenantId: command.tenant_id,
    runtimeId: command.runtime_id,
    commandId: command.command_id,
    desiredRelease: command.desired_release,
    priorAppliedRelease: prior,
  }).observed_status.state, "DEGRADED")

  assert.throws(() => verifyGatewayReleaseReport({
    report: retained,
    publicKeyPem: runtime.signer.publicKeyPem,
    reportKeyId: runtime.signer.keyId,
    tenantId: command.tenant_id,
    runtimeId: command.runtime_id,
    commandId: command.command_id,
    desiredRelease: command.desired_release,
    priorAppliedRelease: release(5, "c"),
  }), /trusted prior Gateway release/)

  const applyingTarget = signedReport(command, runtime, {
    state: "APPLYING",
    applied_release: command.desired_release,
  }, "report-applying-target")
  assert.throws(() => verifyGatewayReleaseReport({
    report: applyingTarget,
    publicKeyPem: runtime.signer.publicKeyPem,
    reportKeyId: runtime.signer.keyId,
    tenantId: command.tenant_id,
    runtimeId: command.runtime_id,
    commandId: command.command_id,
    desiredRelease: command.desired_release,
    priorAppliedRelease: command.desired_release,
  }), /cannot claim the commanded Gateway release as applied/)
})

test("runtime integrity rejects digest and signature tampering", async () => {
  const platform = keyPair()
  const command = await signGatewayReleaseCommand({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    release: release(1),
    signer: platform.signer,
  })
  assert.throws(() => verifyRuntimeMessage({
    message: { ...command, digest: "f".repeat(64) },
    publicKeyPem: platform.signer.publicKeyPem,
  }), /digest mismatch/)
  assert.throws(() => verifyRuntimeMessage({
    message: {
      ...command,
      signature: { ...command.signature, value: "A".repeat(86) },
    },
    publicKeyPem: platform.signer.publicKeyPem,
  }), /signature is invalid/)
})

test("runtime command creation rejects a malformed signer result", async () => {
  const platform = keyPair()
  await assert.rejects(
    () => signGatewayReleaseCommand({
      tenantId: "tenant-acme",
      runtimeId: "gateway-runtime-1",
      release: release(1),
      signer: {
        ...platform.signer,
        sign: () => "not-an-ed25519-signature",
      },
    }),
    /signer returned an invalid signature/,
  )
})
