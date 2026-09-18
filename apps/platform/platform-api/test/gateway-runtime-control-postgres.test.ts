import assert from "node:assert/strict"
import { generateKeyPairSync, sign as signPayload } from "node:crypto"
import test from "node:test"

import type { SqlAdapter, SqlQueryResult, SqlTransaction } from "../src/persistence/sql-adapter"
import { PlatformApiError } from "../src/capabilities/errors"
import { createDurableEd25519Signer } from "../src/capabilities/gateway-projection/signer"
import type {
  GatewayReleaseReference,
  GatewayRuntimeCommand,
} from "../../../../packages/protocol/src/gateway-release"
import { RUNTIME_PROTOCOL_SCHEMA_VERSION } from "../../../../packages/protocol/src/gateway-release"
import { createPostgresGatewayAggregateRuntimeControlStore } from "../src/capabilities/gateway-runtime-control/postgres"
import {
  runtimeProtocolDigest,
  runtimeProtocolSignaturePayload,
} from "../src/capabilities/runtime-control/gateway-release-integrity"

type Row = Record<string, unknown>

/**
 * This is a SQL-boundary test, not a PostgreSQL substitute. It preserves the
 * rows needed by the runtime adapter so idempotency, mapping, and transaction
 * semantics are exercised without requiring a developer database.
 */
class FakeSqlAdapter implements SqlAdapter, SqlTransaction {
  readonly calls: Array<{ text: string; parameters: readonly unknown[] }> = []
  readonly registration: Row
  capability: Row | null = null
  pilotCandidates: Row[] = []
  readonly commands = new Map<string, Row>()
  readonly observations = new Map<string, Row>()
  readonly reports = new Map<string, Row>()
  private clock = 1_700_000_000

  constructor(status: "ACTIVE" | "DISABLED" = "ACTIVE") {
    this.registration = {
      tenant_id: "tenant-acme",
      runtime_kind: "GATEWAY",
      runtime_id: "gateway-runtime-1",
      target_id: "ai-gateway",
      oidc_client_id: "gateway-client",
      report_key_id: "runtime-report-key",
      report_public_key_pem: "",
      status,
      row_revision: 1,
      created_at: this.clock,
      updated_at: this.clock,
    }
  }

  private timestamp(): number {
    this.clock += 1
    return this.clock
  }

  private commandKey(runtimeId: string, commandId: string): string {
    return `${runtimeId}\u0000${commandId}`
  }

  async query<Result extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Result>> {
    this.calls.push({ text, parameters })
    const sql = text.toLowerCase()
    const rows = (value: Row | Row[] | null): Result[] =>
      (value === null ? [] : Array.isArray(value) ? value : [value]) as Result[]

    if (sql.includes("join genio_one_platform_runtime_capabilities")) {
      const tenantId = String(parameters[0] ?? "")
      const gatewayId = String(parameters[1] ?? "")
      const matches = this.pilotCandidates.filter((candidate) => {
        const versions = typeof candidate.protocol_versions === "string"
          ? JSON.parse(candidate.protocol_versions)
          : candidate.protocol_versions
        return candidate.tenant_id === tenantId &&
          candidate.runtime_kind === "GATEWAY" &&
          candidate.target_id === gatewayId &&
          candidate.status === "ACTIVE" &&
          Array.isArray(versions) && versions.includes("genio.one.runtime.v1") &&
          candidate.preferred_protocol_version === "genio.one.runtime.v1" &&
          candidate.delivery_mode === "AGGREGATE_RELEASE"
      })
      return { rows: rows(matches), rowCount: matches.length }
    }

    if (
      sql.includes("from genio_one_platform_runtime_registrations") &&
      sql.includes("and target_id = $2")
    ) {
      const tenantId = String(parameters[0] ?? "")
      const gatewayId = String(parameters[1] ?? "")
      const matches = this.pilotCandidates
        .filter((candidate) =>
          candidate.tenant_id === tenantId &&
          candidate.runtime_kind === "GATEWAY" &&
          candidate.target_id === gatewayId)
        .map((candidate) => ({ runtime_id: candidate.runtime_id }))
      return { rows: rows(matches), rowCount: matches.length }
    }

    if (sql.includes("genio_one_platform_runtime_aggregate_commands")) {
      const tenantId = String(parameters[0] ?? "")
      const runtimeId = String(parameters[1] ?? "")
      if (sql.includes("insert into")) {
        const releaseId = String(parameters[3])
        if ([...this.commands.values()].some((row) =>
          row.tenant_id === tenantId && row.runtime_id === runtimeId && row.release_id === releaseId)) {
          return { rows: [], rowCount: 0 }
        }
        const command: Row = {
          tenant_id: tenantId,
          runtime_kind: "GATEWAY",
          runtime_id: runtimeId,
          command_id: parameters[2],
          release_id: releaseId,
          gateway_id: parameters[4],
          head_revision: parameters[5],
          package_digest: parameters[6],
          projection_count: parameters[7],
          command: JSON.parse(String(parameters[8])),
          state: "PENDING",
          failure_code: null,
          failure_message: null,
          created_at: this.timestamp(),
          delivered_at: null,
          acknowledged_at: null,
          failed_at: null,
          updated_at: this.clock,
        }
        this.commands.set(this.commandKey(runtimeId, String(parameters[2])), command)
        return { rows: rows(command), rowCount: 1 }
      }
      if (sql.includes("set state = 'acknowledged'")) {
        const command = this.commands.get(this.commandKey(runtimeId, String(parameters[2])))
        if (!command || command.state !== "PENDING") return { rows: [], rowCount: 0 }
        command.state = "ACKNOWLEDGED"
        command.acknowledged_at = this.timestamp()
        command.updated_at = this.clock
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes("set state = 'failed'")) {
        const command = this.commands.get(this.commandKey(runtimeId, String(parameters[2])))
        if (!command || command.state !== "PENDING") return { rows: [], rowCount: 0 }
        command.state = "FAILED"
        command.failure_code = parameters[3]
        command.failure_message = parameters[4]
        command.failed_at = this.timestamp()
        command.updated_at = this.clock
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes("set delivered_at")) {
        const command = this.commands.get(this.commandKey(runtimeId, String(parameters[2])))
        if (!command || !["PENDING", "ACKNOWLEDGED"].includes(String(command.state))) {
          return { rows: [], rowCount: 0 }
        }
        command.delivered_at ??= this.timestamp()
        command.updated_at = this.clock
        return { rows: rows(command), rowCount: 1 }
      }
      if (sql.includes("set updated_at = now()")) {
        const command = this.commands.get(this.commandKey(runtimeId, String(parameters[2])))
        if (!command || command.state !== "PENDING") return { rows: [], rowCount: 0 }
        command.updated_at = this.timestamp()
        return { rows: rows(command), rowCount: 1 }
      }
      if (sql.includes("release_id = $3")) {
        const releaseId = String(parameters[2])
        const command = [...this.commands.values()].find((row) =>
          row.tenant_id === tenantId && row.runtime_id === runtimeId && row.release_id === releaseId)
        return { rows: rows(command ?? null), rowCount: command ? 1 : 0 }
      }
      if (sql.includes("command_id = $3")) {
        const command = this.commands.get(this.commandKey(runtimeId, String(parameters[2])))
        return { rows: rows(command ?? null), rowCount: command ? 1 : 0 }
      }
      const pending = [...this.commands.values()].filter((row) =>
        row.tenant_id === tenantId && row.runtime_id === runtimeId && row.state === "PENDING")
      return { rows: rows(pending), rowCount: pending.length }
    }

    if (sql.includes("genio_one_platform_runtime_aggregate_observed_states")) {
      const runtimeId = String(parameters[1] ?? "")
      const observed = this.observations.get(runtimeId)
      if (sql.includes("insert into")) {
        const next: Row = {
          tenant_id: parameters[0],
          runtime_kind: "GATEWAY",
          runtime_id: runtimeId,
          command_id: parameters[2],
          report_id: parameters[3],
          revision: parameters[4],
          digest: parameters[5],
          applied_release: JSON.parse(String(parameters[6])),
          observed_status: JSON.parse(String(parameters[7])),
          observed_at: this.timestamp(),
          updated_at: this.clock,
        }
        this.observations.set(runtimeId, next)
        return { rows: rows(next), rowCount: 1 }
      }
      return { rows: rows(observed ?? null), rowCount: observed ? 1 : 0 }
    }

    if (sql.includes("genio_one_platform_runtime_aggregate_report_history")) {
      const tenantId = String(parameters[0] ?? "")
      const runtimeId = String(parameters[1] ?? "")
      if (sql.includes("insert into")) {
        const reportId = String(parameters[2])
        if (this.reports.has(`${runtimeId}\u0000${reportId}`)) return { rows: [], rowCount: 0 }
        const report: Row = {
          tenant_id: tenantId,
          runtime_kind: "GATEWAY",
          runtime_id: runtimeId,
          report_id: reportId,
          command_id: parameters[3],
          release_id: parameters[4],
          package_digest: parameters[5],
          revision: parameters[6],
          digest: parameters[7],
          report: JSON.parse(String(parameters[8])),
          outcome: parameters[9],
          observed_at: this.timestamp(),
        }
        this.reports.set(`${runtimeId}\u0000${reportId}`, report)
        return { rows: rows(report), rowCount: 1 }
      }
      if (sql.includes("report_id = $3")) {
        const report = this.reports.get(`${runtimeId}\u0000${String(parameters[2])}`)
        return { rows: rows(report ?? null), rowCount: report ? 1 : 0 }
      }
      const history = [...this.reports.values()].filter((row) =>
        row.tenant_id === tenantId && row.runtime_id === runtimeId)
      return { rows: rows(history), rowCount: history.length }
    }

    if (sql.includes("genio_one_platform_runtime_capabilities")) {
      if (sql.includes("insert into")) {
        const next: Row = {
          tenant_id: parameters[0],
          runtime_kind: "GATEWAY",
          runtime_id: parameters[1],
          protocol_versions: JSON.parse(String(parameters[2])),
          preferred_protocol_version: parameters[3],
          delivery_mode: parameters[4],
          row_revision: 1,
          created_at: this.timestamp(),
          updated_at: this.clock,
        }
        this.capability = next
        return { rows: rows(next), rowCount: 1 }
      }
      if (sql.includes("set protocol_versions")) {
        if (!this.capability) return { rows: [], rowCount: 0 }
        this.capability.protocol_versions = JSON.parse(String(parameters[2]))
        this.capability.preferred_protocol_version = parameters[3]
        this.capability.delivery_mode = parameters[4]
        this.capability.row_revision = Number(this.capability.row_revision) + 1
        this.capability.updated_at = this.timestamp()
        return { rows: rows(this.capability), rowCount: 1 }
      }
      return { rows: rows(this.capability), rowCount: this.capability ? 1 : 0 }
    }

    if (sql.includes("from genio_one_platform_runtime_registrations")) {
      const tenantId = String(parameters[0] ?? "")
      const runtimeId = String(parameters[1] ?? "")
      const found = this.registration.tenant_id === tenantId && this.registration.runtime_id === runtimeId
        ? this.registration
        : null
      return { rows: rows(found), rowCount: found ? 1 : 0 }
    }

    return { rows: [], rowCount: 0 }
  }

  async transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
    return work(this)
  }
}

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
  return { ...digestBearing, signature: { ...unsigned.signature, value: signature } }
}

function fixture(status: "ACTIVE" | "DISABLED" = "ACTIVE") {
  const platform = keyPair()
  const runtime = keyPair()
  const sql = new FakeSqlAdapter(status)
  sql.registration.report_key_id = runtime.signer.keyId
  sql.registration.report_public_key_pem = runtime.signer.publicKeyPem
  const store = createPostgresGatewayAggregateRuntimeControlStore({
    sql,
    signer: platform.signer,
    commandPublicKeyPem: platform.signer.publicKeyPem,
    idFactory: (() => {
      let sequence = 0
      return (prefix: string) => `${prefix}-${++sequence}`
    })(),
    now: () => 1_700_000_000,
  })
  return { platform, runtime, sql, store }
}

async function enableRuntime(store: ReturnType<typeof fixture>["store"]): Promise<void> {
  await store.saveCapabilities({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    protocolVersions: ["genio.one.runtime.v1"],
    preferredProtocolVersion: "genio.one.runtime.v1",
    deliveryMode: "AGGREGATE_RELEASE",
  })
}

async function expectCode(code: string, action: () => Promise<unknown>): Promise<void> {
  await assert.rejects(action, (error: unknown) =>
    error instanceof PlatformApiError && error.code === code)
}

function pilotCandidate(overrides: Row = {}): Row {
  return {
    tenant_id: "tenant-acme",
    runtime_kind: "GATEWAY",
    runtime_id: "gateway-runtime-1",
    target_id: "ai-gateway",
    status: "ACTIVE",
    protocol_versions: JSON.stringify(["genio.one.runtime.v1"]),
    preferred_protocol_version: "genio.one.runtime.v1",
    delivery_mode: "AGGREGATE_RELEASE",
    ...overrides,
  }
}

test("Gateway Group selector returns every eligible replica and locks candidates", async () => {
  const { store, sql } = fixture()
  sql.pilotCandidates = [
    pilotCandidate({ runtime_id: "gateway-runtime-2" }),
    pilotCandidate(),
  ]

  const selected = await store.selectGatewayGroupInTransaction({
    transaction: sql,
    tenantId: "tenant-acme",
    gatewayId: "ai-gateway",
  })

  assert.deepEqual(selected, {
    tenant_id: "tenant-acme",
    gateway_id: "ai-gateway",
    runtime_ids: ["gateway-runtime-1", "gateway-runtime-2"],
  })
  const selection = sql.calls.find((call) =>
    call.text.includes("join genio_one_platform_runtime_capabilities"))
  const topologyLock = sql.calls.findIndex((call) =>
    call.text.includes("pg_advisory_xact_lock") &&
    call.parameters[0] === "tenant:tenant-acme|runtime-topology")
  const selectionIndex = sql.calls.indexOf(selection!)
  assert.ok(selection)
  assert.ok(topologyLock >= 0 && topologyLock < selectionIndex)
  assert.match(selection.text, /for update of runtime_registration, runtime_capability/i)
  assert.deepEqual(selection.parameters, ["tenant-acme", "ai-gateway"])
  assert.match(selection.text, /order\s+by\s+runtime_registration\.runtime_id/i)
})

test("Gateway Group selector excludes unsupported, inactive, and different-gateway runtimes", async () => {
  const { store, sql } = fixture()
  sql.pilotCandidates = [
    pilotCandidate({ runtime_id: "gateway-runtime-unsupported", protocol_versions: JSON.stringify(["genio.one.runtime.v999"]), preferred_protocol_version: "genio.one.runtime.v999" }),
    pilotCandidate({ runtime_id: "gateway-runtime-disabled", status: "DISABLED" }),
    pilotCandidate({ runtime_id: "gateway-runtime-other-target", target_id: "other-gateway" }),
  ]

  await expectCode("GATEWAY_RUNTIME_NOT_ELIGIBLE", () => store.selectGatewayGroupInTransaction({
    transaction: sql,
    tenantId: "tenant-acme",
    gatewayId: "ai-gateway",
  }))

  sql.pilotCandidates = []
  await expectCode("GATEWAY_RUNTIME_NOT_REGISTERED", () => store.selectGatewayGroupInTransaction({
    transaction: sql,
    tenantId: "tenant-acme",
    gatewayId: "ai-gateway",
  }))
})

test("Gateway Group selector validates identifiers and persisted capability data", async () => {
  const { store, sql } = fixture()
  sql.pilotCandidates = [pilotCandidate()]

  await expectCode("TENANT_REQUIRED", () => store.selectGatewayGroupInTransaction({
    transaction: sql,
    tenantId: " tenant-acme",
    gatewayId: "ai-gateway",
  }))
  await expectCode("RUNTIME_TARGET_REQUIRED", () => store.selectGatewayGroupInTransaction({
    transaction: sql,
    tenantId: "tenant-acme",
    gatewayId: "ai\ngateway",
  }))

  sql.pilotCandidates = [pilotCandidate({
    protocol_versions: JSON.stringify(["genio.one.runtime.v1", "unknown-version"]),
  })]
  await expectCode("RUNTIME_CAPABILITIES_DATA_INVALID", () => store.selectGatewayGroupInTransaction({
    transaction: sql,
    tenantId: "tenant-acme",
    gatewayId: "ai-gateway",
  }))

  sql.pilotCandidates = [pilotCandidate({
    protocol_versions: JSON.stringify(["genio.one.runtime.v1", "genio.one.runtime.v1"]),
  })]
  await expectCode("RUNTIME_CAPABILITIES_DATA_INVALID", () => store.selectGatewayGroupInTransaction({
    transaction: sql,
    tenantId: "tenant-acme",
    gatewayId: "ai-gateway",
  }))
})

test("Postgres runtime capability and aggregate command persistence is idempotent", async () => {
  const { store, sql } = fixture()
  await enableRuntime(store)
  const capability = await store.getCapabilities({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
  })
  assert.deepEqual(capability?.protocol_versions, ["genio.one.runtime.v1"])

  const desired = release(1, "a", 0)
  const first = await store.enqueueGatewayRelease({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    release: desired,
  })
  const retry = await store.enqueueGatewayRelease({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    release: desired,
  })
  assert.equal(retry.command_id, first.command_id)
  assert.equal(sql.commands.size, 1)
  assert.equal((await store.listPendingGatewayReleaseCommands({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
  })).length, 1)
  assert.ok(sql.calls.some((call) =>
    call.text.includes("genio_one_platform_runtime_aggregate_observed_states") &&
    call.text.includes("observed.observed_status ->> 'state' in ('READY', 'DEGRADED')") &&
    call.text.includes("observed.revision::bigint") &&
    call.text.includes("order by head_revision desc") &&
    call.text.includes("limit 1")))
  assert.ok(sql.calls.some((call) => call.text.includes("on conflict (tenant_id, runtime_kind, runtime_id, release_id)")))

  await expectCode("RUNTIME_AGGREGATE_COMMAND_IMMUTABLE", () => store.enqueueGatewayRelease({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    release: { ...desired, package_digest: "b".repeat(64) },
  }))
  await expectCode("RUNTIME_RELEASE_TARGET_MISMATCH", () => store.enqueueGatewayRelease({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    release: { ...release(2, "b"), gateway_id: "other-gateway" },
  }))
})

test("Postgres runtime verifies reports, preserves LKG, and classifies stale history", async () => {
  const { store, runtime } = fixture()
  await enableRuntime(store)
  const first = await store.enqueueGatewayRelease({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    release: release(1, "a"),
  })
  const ready = await store.recordGatewayReleaseReport({
    tenantId: "tenant-acme",
    report: signedReport(first.command, runtime, {
      state: "READY",
      applied_release: first.command.desired_release,
    }),
  })
  assert.equal(ready.outcome, "ACCEPTED")
  assert.equal((await store.getGatewayReleaseCommand({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    commandId: first.command_id,
  }))?.state, "ACKNOWLEDGED")
  const duplicateReport = signedReport(first.command, runtime, {
    state: "READY",
    applied_release: first.command.desired_release,
  })
  const duplicate = await store.recordGatewayReleaseReport({
    tenantId: "tenant-acme",
    report: duplicateReport,
  })
  assert.equal(duplicate.outcome, "ACCEPTED")

  const second = await store.enqueueGatewayRelease({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    release: release(2, "b"),
  })
  const degraded = await store.recordGatewayReleaseReport({
    tenantId: "tenant-acme",
    report: signedReport(second.command, runtime, {
      state: "DEGRADED",
      applied_release: first.command.desired_release,
      error: { code: "APPLY_FAILED", message: "retained LKG" },
    }),
  })
  assert.equal(degraded.observed.applied_release?.release_id, "release-a")
  assert.equal((await store.getGatewayReleaseCommand({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    commandId: second.command_id,
  }))?.state, "FAILED")

  await expectCode("RUNTIME_REPORT_RELEASE_CONFLICT", () =>
    store.recordGatewayReleaseReport({
      tenantId: "tenant-acme",
      report: signedReport(second.command, runtime, {
        state: "READY",
        applied_release: second.command.desired_release,
      }, "report-after-failure"),
    }))

  const stale = await store.recordGatewayReleaseReport({
    tenantId: "tenant-acme",
    report: signedReport(first.command, runtime, {
      state: "READY",
      applied_release: first.command.desired_release,
    }, "report-stale"),
  })
  assert.equal(stale.outcome, "STALE")
  assert.equal(stale.observed.applied_release?.release_id, "release-a")
  assert.deepEqual((await store.listGatewayReleaseReportHistory({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
  })).map((item) => item.outcome), ["ACCEPTED", "ACCEPTED", "STALE"])
})

test("Postgres runtime keeps APPLYING and UNKNOWN commands pending until READY", async () => {
  const { store, runtime } = fixture()
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
  const command = await store.enqueueGatewayRelease({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    release: release(2, "b"),
  })

  const applying = await store.recordGatewayReleaseReport({
    tenantId: "tenant-acme",
    report: signedReport(command.command, runtime, {
      state: "APPLYING",
      applied_release: initial.command.desired_release,
      components: [{
        component: "AI_GATEWAY",
        state: "APPLYING",
        observed_revision: command.command.revision,
      }],
    }, "report-applying"),
  })
  assert.equal(applying.observed.observed_status.state, "APPLYING")
  assert.equal((await store.getGatewayReleaseCommand({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    commandId: command.command_id,
  }))?.state, "PENDING")

  const unknown = await store.recordGatewayReleaseReport({
    tenantId: "tenant-acme",
    report: signedReport(command.command, runtime, {
      state: "UNKNOWN",
      error: { code: "STARTING", message: "Gateway has not reported readiness yet" },
    }, "report-unknown"),
  })
  assert.equal(unknown.observed.observed_status.state, "UNKNOWN")
  assert.equal((await store.getGatewayReleaseCommand({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    commandId: command.command_id,
  }))?.state, "PENDING")

  await store.recordGatewayReleaseReport({
    tenantId: "tenant-acme",
    report: signedReport(command.command, runtime, {
      state: "READY",
      applied_release: command.command.desired_release,
    }, "report-ready"),
  })
  assert.equal((await store.getGatewayReleaseCommand({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    commandId: command.command_id,
  }))?.state, "ACKNOWLEDGED")
  assert.equal((await store.getLatestGatewayReleaseObserved({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
  }))?.applied_release?.release_id, command.command.desired_release.release_id)
})

test("Postgres runtime rejects semantically invalid persisted observed state", async () => {
  const invalidStatuses: Row[] = [
    {
      state: "READY",
      applied_release: release(1),
      components: [],
    },
    {
      state: "DEGRADED",
    },
    {
      state: "UNKNOWN",
      components: [],
    },
    {
      state: "APPLYING",
      error: { code: "APPLY_FAILED", message: "not an in-flight state" },
    },
  ]

  for (const [index, observedStatus] of invalidStatuses.entries()) {
    const { store, sql } = fixture()
    sql.observations.set("gateway-runtime-1", {
      tenant_id: "tenant-acme",
      runtime_kind: "GATEWAY",
      runtime_id: "gateway-runtime-1",
      command_id: `command-${index}`,
      report_id: `report-${index}`,
      revision: "1",
      digest: "a".repeat(64),
      applied_release: observedStatus.applied_release ?? null,
      observed_status: observedStatus,
      observed_at: 1_700_000_000,
      updated_at: 1_700_000_000,
    })

    await expectCode("RUNTIME_OBSERVED_STATE_INVALID", () =>
      store.getLatestGatewayReleaseObserved({
        tenantId: "tenant-acme",
        runtimeId: "gateway-runtime-1",
      }))
  }

  const { store, sql } = fixture()
  sql.observations.set("gateway-runtime-1", {
    tenant_id: "tenant-acme",
    runtime_kind: "GATEWAY",
    runtime_id: "gateway-runtime-1",
    command_id: "command-ready",
    report_id: "report-ready",
    revision: "1",
    digest: "a".repeat(64),
    applied_release: null,
    observed_status: {
      state: "READY",
      applied_release: release(1),
      components: ["AI_GATEWAY", "AUTHORIZER", "PROCESSOR"].map((component) => ({
        component,
        state: "READY",
        observed_revision: "1",
      })),
    },
    observed_at: 1_700_000_000,
    updated_at: 1_700_000_000,
  })
  await expectCode("RUNTIME_OBSERVED_STATE_INVALID", () =>
    store.getLatestGatewayReleaseObserved({
      tenantId: "tenant-acme",
      runtimeId: "gateway-runtime-1",
    }))
})

test("Postgres runtime fails closed for missing registration or negotiated capability", async () => {
  const { store } = fixture("DISABLED")
  await expectCode("RUNTIME_RUNTIME_NOT_ACTIVE", () => store.saveCapabilities({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    protocolVersions: ["genio.one.runtime.v1"],
    preferredProtocolVersion: "genio.one.runtime.v1",
    deliveryMode: "AGGREGATE_RELEASE",
  }))

  const active = fixture()
  await expectCode("RUNTIME_AGGREGATE_DELIVERY_UNSUPPORTED", () => active.store.enqueueGatewayRelease({
    tenantId: "tenant-acme",
    runtimeId: "gateway-runtime-1",
    release: release(1),
  }))
})
