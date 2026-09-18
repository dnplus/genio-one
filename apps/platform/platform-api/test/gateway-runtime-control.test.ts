import assert from "node:assert/strict"
import { generateKeyPairSync, sign as signPayload } from "node:crypto"
import test from "node:test"

import { PlatformApiError } from "../src/capabilities/errors"
import { createDurableEd25519Signer } from "../src/capabilities/gateway-projection/signer"
import type {
  GatewayReleaseReference,
  GatewayRuntimeCommand,
} from "../../../../packages/protocol/src/gateway-release"
import { RUNTIME_PROTOCOL_SCHEMA_VERSION } from "../../../../packages/protocol/src/gateway-release"
import { createInMemoryRuntimeControlStore } from "../src/capabilities/runtime-control/memory"
import {
  runtimeProtocolDigest,
  runtimeProtocolSignaturePayload,
} from "../src/capabilities/runtime-control/gateway-release-integrity"
import { createInMemoryGatewayAggregateRuntimeControlStore } from "../src/capabilities/gateway-runtime-control/memory"

function keyPair() {
  const { privateKey } = generateKeyPairSync("ed25519")
  const signer = createDurableEd25519Signer({
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  })
  return { signer, privateKey }
}

function release(headRevision: number, suffix = "a", count = headRevision): GatewayReleaseReference {
  return {
    schema_version: "genio.one.gateway-release-ref.v1",
    release_id: `release-${suffix}`,
    gateway_id: "ai-gateway",
    head_revision: headRevision,
    package_digest: suffix.repeat(64),
    projection_count: count,
  }
}

function signedReport(
  command: GatewayRuntimeCommand,
  runtime: ReturnType<typeof keyPair>,
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
      key_id: runtime.signer.keyId,
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
    runtime.privateKey,
  ).toString("base64url")
  return {
    ...digestBearing,
    signature: { ...unsigned.signature, value: signature },
  }
}

async function expectCode(code: string, action: () => Promise<unknown>): Promise<void> {
  await assert.rejects(action, (error: unknown) =>
    error instanceof PlatformApiError && error.code === code)
}

async function fixture(status: "ACTIVE" | "DISABLED" = "ACTIVE") {
  const platform = keyPair()
  const runtime = keyPair()
  const registrations = createInMemoryRuntimeControlStore()
  await registrations.registerGatewayRuntime({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    targetId: "ai-gateway",
    oidcClientId: "gateway-client",
    reportKeyId: runtime.signer.keyId,
    reportPublicKeyPem: runtime.signer.publicKeyPem,
    status,
  })
  const store = createInMemoryGatewayAggregateRuntimeControlStore({
    registrations,
    signer: platform.signer,
    idFactory: (prefix, sequence) => `${prefix}-${sequence}`,
  })
  return { platform, runtime, registrations, store }
}

async function enableRuntime(store: Awaited<ReturnType<typeof fixture>>["store"]) {
  return store.saveCapabilities({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    protocolVersions: ["genio.one.runtime.v1"],
    preferredProtocolVersion: "genio.one.runtime.v1",
    deliveryMode: "AGGREGATE_RELEASE",
  })
}

test("capability negotiation is registered, strict, and idempotent", async () => {
  const { store } = await fixture()
  const first = await enableRuntime(store)
  const second = await enableRuntime(store)
  assert.deepEqual(first, second)
  assert.equal(first.row_revision, 1)
  assert.deepEqual(first.protocol_versions, ["genio.one.runtime.v1"])

  await expectCode("RUNTIME_CAPABILITIES_INVALID", () => store.saveCapabilities({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    protocolVersions: ["genio.one.runtime.v1", "genio.one.runtime.v1"],
    preferredProtocolVersion: "genio.one.runtime.v1",
    deliveryMode: "AGGREGATE_RELEASE",
  }))
  await expectCode("RUNTIME_CAPABILITIES_INVALID", () => store.saveCapabilities({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    protocolVersions: ["genio.one.runtime.v999" as never],
    preferredProtocolVersion: "genio.one.runtime.v999" as never,
    deliveryMode: "AGGREGATE_RELEASE",
  }))
  const disabled = await fixture("DISABLED")
  await expectCode("RUNTIME_RUNTIME_NOT_ACTIVE", () => enableRuntime(disabled.store))
})

test("aggregate enqueue is target-bound, reference-only, and idempotent", async () => {
  const { store } = await fixture()
  await enableRuntime(store)
  const empty = release(1, "a", 0)
  const first = await store.enqueueGatewayRelease({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    release: empty,
  })
  const second = await store.enqueueGatewayRelease({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    release: empty,
  })
  assert.equal(first.command_id, second.command_id)
  assert.deepEqual(first.command.desired_release, empty)
  assert.equal("projections" in first.command, false)
  assert.equal((await store.listPendingGatewayReleaseCommands({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
  })).length, 1)

  await expectCode("RUNTIME_AGGREGATE_COMMAND_IMMUTABLE", () =>
    store.enqueueGatewayRelease({
      tenantId: "tenant-acme",
      runtimeId: "gateway-runtime-1",
      release: { ...empty, package_digest: "b".repeat(64) },
    }))
  await expectCode("RUNTIME_RELEASE_TARGET_MISMATCH", () =>
    store.enqueueGatewayRelease({
      tenantId: "tenant-acme",
      runtimeId: "gateway-runtime-1",
      release: { ...release(2, "b"), gateway_id: "api-gateway" },
    }))
})

test("READY acknowledges the exact release and duplicate reports converge", async () => {
  const { store, runtime } = await fixture()
  await enableRuntime(store)
  const record = await store.enqueueGatewayRelease({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    release: release(1),
  })
  const report = signedReport(record.command, runtime, {
    state: "READY",
    applied_release: record.command.desired_release,
  })
  const accepted = await store.recordGatewayReleaseReport({
    tenantId: "tenant-acme",
    report,
  })
  const replay = await store.recordGatewayReleaseReport({
    tenantId: "tenant-acme",
    report,
  })
  assert.equal(accepted.outcome, "ACCEPTED")
  assert.deepEqual(replay, accepted)
  assert.equal((await store.getGatewayReleaseCommand({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    commandId: record.command_id,
  }))?.state, "ACKNOWLEDGED")

  const reused = signedReport(record.command, runtime, {
    state: "READY",
    applied_release: record.command.desired_release,
    components: [
      {
        component: "AI_GATEWAY",
        state: "READY",
        observed_revision: "1",
        detail: "different signed content",
      },
      { component: "AUTHORIZER", state: "READY", observed_revision: "1" },
      { component: "PROCESSOR", state: "READY", observed_revision: "1" },
    ],
  }, report.report_id as string)
  await expectCode("RUNTIME_REPORT_IMMUTABLE", () => store.recordGatewayReleaseReport({
    tenantId: "tenant-acme",
    report: reused,
  }))
})

test("an applied release suppresses older pending commands from reconnect delivery", async () => {
  const { store, runtime } = await fixture()
  await enableRuntime(store)
  const older = await store.enqueueGatewayRelease({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    release: release(1, "a"),
  })
  const current = await store.enqueueGatewayRelease({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    release: release(2, "b"),
  })
  await store.recordGatewayReleaseReport({
    tenantId: "tenant-acme",
    report: signedReport(current.command, runtime, {
      state: "READY",
      applied_release: current.command.desired_release,
    }),
  })

  assert.equal((await store.getGatewayReleaseCommand({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    commandId: older.command_id,
  }))?.state, "PENDING")
  assert.deepEqual(await store.listPendingGatewayReleaseCommands({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
  }), [])
})

test("reconnect delivery sends only the newest pending desired release", async () => {
  const { store } = await fixture()
  await enableRuntime(store)
  await store.enqueueGatewayRelease({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    release: release(1, "a"),
  })
  const newest = await store.enqueueGatewayRelease({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    release: release(2, "b"),
  })

  const pending = await store.listPendingGatewayReleaseCommands({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
  })
  assert.deepEqual(pending.map((record) => record.command_id), [newest.command_id])
})

test("APPLYING and UNKNOWN keep an aggregate command pending until READY", async () => {
  const { store, runtime } = await fixture()
  await enableRuntime(store)
  const initial = await store.enqueueGatewayRelease({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    release: release(1),
  })
  await store.recordGatewayReleaseReport({
    tenantId: "tenant-acme",
    report: signedReport(initial.command, runtime, {
      state: "READY",
      applied_release: initial.command.desired_release,
    }, "report-initial-ready"),
  })
  const record = await store.enqueueGatewayRelease({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    release: release(2, "b"),
  })

  const applying = await store.recordGatewayReleaseReport({
    tenantId: "tenant-acme",
    report: signedReport(record.command, runtime, {
      state: "APPLYING",
      applied_release: initial.command.desired_release,
      components: [{
        component: "AI_GATEWAY",
        state: "APPLYING",
        observed_revision: record.command.revision,
      }],
    }, "report-applying"),
  })
  assert.equal(applying.observed.observed_status.state, "APPLYING")
  assert.equal((await store.getGatewayReleaseCommand({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    commandId: record.command_id,
  }))?.state, "PENDING")

  const unknown = await store.recordGatewayReleaseReport({
    tenantId: "tenant-acme",
    report: signedReport(record.command, runtime, {
      state: "UNKNOWN",
      error: { code: "STARTING", message: "Gateway has not reported readiness yet" },
    }, "report-unknown"),
  })
  assert.equal(unknown.observed.observed_status.state, "UNKNOWN")
  assert.equal((await store.getGatewayReleaseCommand({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    commandId: record.command_id,
  }))?.state, "PENDING")

  await store.recordGatewayReleaseReport({
    tenantId: "tenant-acme",
    report: signedReport(record.command, runtime, {
      state: "READY",
      applied_release: record.command.desired_release,
    }, "report-ready"),
  })
  assert.equal((await store.getGatewayReleaseCommand({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    commandId: record.command_id,
  }))?.state, "ACKNOWLEDGED")
  assert.equal((await store.getLatestGatewayReleaseObserved({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
  }))?.applied_release?.release_id, record.command.desired_release.release_id)
})

test("stale READY remains history and cannot replace the current aggregate release", async () => {
  const { store, runtime } = await fixture()
  await enableRuntime(store)
  const oldCommand = await store.enqueueGatewayRelease({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    release: release(1, "a"),
  })
  const newCommand = await store.enqueueGatewayRelease({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    release: release(2, "b"),
  })
  await store.recordGatewayReleaseReport({
    tenantId: "tenant-acme",
    report: signedReport(newCommand.command, runtime, {
      state: "READY",
      applied_release: newCommand.command.desired_release,
    }),
  })
  const stale = await store.recordGatewayReleaseReport({
    tenantId: "tenant-acme",
    report: signedReport(oldCommand.command, runtime, {
      state: "READY",
      applied_release: oldCommand.command.desired_release,
    }),
  })
  assert.equal(stale.outcome, "STALE")
  assert.equal(stale.observed.applied_release?.release_id, "release-b")
  assert.deepEqual((await store.listGatewayReleaseReportHistory({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
  })).map((entry) => entry.outcome), ["ACCEPTED", "STALE"])
})

test("a failed apply retains only its trusted LKG and marks the command failed", async () => {
  const { store, runtime } = await fixture()
  await enableRuntime(store)
  const first = await store.enqueueGatewayRelease({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    release: release(1, "a"),
  })
  await store.recordGatewayReleaseReport({
    tenantId: "tenant-acme",
    report: signedReport(first.command, runtime, {
      state: "READY",
      applied_release: first.command.desired_release,
    }),
  })
  const second = await store.enqueueGatewayRelease({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    release: release(2, "b"),
  })
  const failed = await store.recordGatewayReleaseReport({
    tenantId: "tenant-acme",
    report: signedReport(second.command, runtime, {
      state: "DEGRADED",
      applied_release: first.command.desired_release,
      error: { code: "APPLY_FAILED", message: "retained LKG" },
    }),
  })
  assert.equal(failed.observed.applied_release?.release_id, "release-a")
  assert.equal((await store.getGatewayReleaseCommand({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    commandId: second.command_id,
  }))?.state, "FAILED")

  await assert.rejects(store.recordGatewayReleaseReport({
    tenantId: "tenant-acme",
    report: signedReport(second.command, runtime, {
      state: "READY",
      applied_release: second.command.desired_release,
    }, "report-after-failure"),
  }), /RUNTIME_REPORT_RELEASE_CONFLICT/)

  const forged = signedReport(second.command, runtime, {
    state: "DEGRADED",
    applied_release: release(1, "c"),
    error: { code: "APPLY_FAILED", message: "forged release" },
  }, "report-forged")
  await assert.rejects(store.recordGatewayReleaseReport({
    tenantId: "tenant-acme",
    report: forged,
  }), /trusted prior Gateway release/)
})
