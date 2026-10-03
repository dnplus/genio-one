import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import { EventEmitter } from "node:events"
import { appendFile, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { mock, test } from "bun:test"

import { gatewayReleasePackageDigest, type GatewayReleasePackage } from "../../../apps/platform/platform-api/src/capabilities/gateway-policy-release/package"
import { createDurableEd25519Signer } from "../../../apps/platform/platform-api/src/capabilities/gateway-projection/signer"
import { signGatewayReleaseCommand } from "../../../apps/platform/platform-api/src/capabilities/runtime-control/gateway-release-integrity"
import type { GatewayActivityIngest } from "../../../apps/platform/platform-api/src/capabilities/activities/contract"
import type { GatewayAuthenticationFailureAuditIngest } from "../../../apps/platform/platform-api/src/capabilities/audit-events/contract"
import { createNativeActivitySourceManager, NATIVE_ACTIVITY_SOURCE_LIMITS, readNativeActivityReceipt, writeNativeActivityReceipt } from "./native-activity-source"
import { createObservationOutbox, ObservationOutboxCapacityError, type ObservationRecord } from "./observation-outbox"
import type { GatewayRuntimeState } from "./runtime"

if (process.env.GENIO_ONE_NATIVE_ACTIVITY_TEST_CHILD !== "1") {
  test("native activity lifecycle executes in an isolated process", async () => {
    const child = Bun.spawn([process.execPath, "test", "--no-orphans", "--timeout", "10000", import.meta.filename], {
      cwd: import.meta.dirname,
      env: { ...process.env, GENIO_ONE_NATIVE_ACTIVITY_TEST_CHILD: "1" },
      stdout: "pipe", stderr: "pipe",
    })
    const timeout = setTimeout(() => child.kill(), 25_000)
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ])
      process.stdout.write(stdout)
      process.stderr.write(stderr)
      assert.equal(exitCode, 0, `${stdout}\n${stderr}`)
      assert.match(`${stdout}\n${stderr}`, /9 pass/)
    } finally {
      clearTimeout(timeout)
      if (child.exitCode === null) child.kill()
    }
  }, 30_000)
} else {
class FakeChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  stdout = Object.assign(new EventEmitter(), { pause() {}, resume() {} })
  logPath?: string
  finalLine?: Record<string, unknown>
  beforeFinalAppend?: () => Promise<void>
}

let processor: FakeChild | undefined
const nativeChildren: FakeChild[] = []

let receiptWriteHook: ((value: any) => Promise<void>) | undefined
const actualSourceManager = createNativeActivitySourceManager
const actualReadReceipt = readNativeActivityReceipt
const actualWriteReceipt = writeNativeActivityReceipt
mock.module("./native-activity-source", () => ({
  createNativeActivitySourceManager: actualSourceManager,
  NATIVE_ACTIVITY_SOURCE_LIMITS,
  readNativeActivityReceipt: actualReadReceipt,
  async writeNativeActivityReceipt(root: string, correlationId: string, value: unknown) {
    await receiptWriteHook?.(value)
    await actualWriteReceipt(root, correlationId, value)
  },
}))

mock.module("./local-distillation-triage-port", () => ({
  async releaseLocalDistillationTriageForProcessor() {
    return { path: "/unused/handoff", targetPath: "/unused/handoff-target", contents: "", phase: "taking-over", generation: "fixture", managed: false }
  },
}))
mock.module("./local-distillation-triage-handoff.mjs", () => ({
  promoteDistillationTriageHandoff(handoff: object, phase: string) { return { ...handoff, phase } },
  removeDistillationTriageHandoff() { return true },
}))
mock.module("./process-lifecycle", () => ({
  async stopChild(child: FakeChild | undefined) {
    if (!child || child.exitCode !== null) return
    child.exitCode = 0
    child.emit("exit", 0, null)
  },
  async stopProcessTree(child: FakeChild) {
    if (child.exitCode !== null) return
    if (child.finalLine && child.logPath) {
      await child.beforeFinalAppend?.()
      await appendFile(child.logPath, `${JSON.stringify(child.finalLine)}\n`)
    }
    child.exitCode = 0
    child.emit("exit", 0, null)
  },
  async waitForEnvoyRunReadiness() {},
  async waitForHealth() {},
  async waitForListener() {},
}))
mock.module("./aigw-runtime-cache", () => ({
  aigwEphemeralRunId: (revision: number) => `r${revision}`,
  aigwRuntimeEnvironment: () => ({}),
  async createAigwEphemeralRuntimeDirectory(stateRoot: string) {
    return { directory: join(stateRoot, "fixture-native-runtime"), prefix: "fixture-native-runtime-" }
  },
  async prepareAigwRuntimeCache() { return {} },
  async removeAigwEphemeralRuntimeDirectory() {},
}))
mock.module("node:child_process", () => ({
  spawn(command: string, args: string[]) {
    const child = new FakeChild()
    if (command === "/fixture/aigw") {
      child.logPath = join(dirname(args.at(-1)!), "activity.jsonl")
      nativeChildren.push(child)
    } else if (args.some((argument) => argument.endsWith(join("services", "processor", "server.ts")))) {
      processor = child
    }
    return child
  },
}))

const activityModule = "./local-aigw.ts?native-source-lifecycle"
const { createLocalAigwApplier, authenticationFailureForNativeEvent } = await import(activityModule)
mock.restore()

async function fixture(root: string) {
  const { privateKey } = generateKeyPairSync("ed25519")
  const signer = createDurableEd25519Signer({
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), keyId: "platform-command-key",
  })
  const keyRingPath = join(root, "command-keys.json")
  await writeFile(keyRingPath, JSON.stringify({ schema_version: 1, keys: [{ key_id: signer.keyId, public_key_pem: signer.publicKeyPem }] }))
  return {
    keyRingPath,
    async input(revision: number, empty = false): Promise<GatewayRuntimeState> {
      const resourceId = `resource-${revision}`
      const projection = {
        schema_version: "genio.one.gateway.v1" as const,
        projection_id: `projection-${revision}`, tenant_id: "tenant-1", publication_id: `publication-${revision}`,
        resource_id: resourceId, capability_id: "chat", endpoint_revision: 1, policy_revision: 1, revision,
        digest: "a".repeat(64), signature: { algorithm: "Ed25519" as const, key_id: signer.keyId, value: "A".repeat(86) },
        publication_endpoint: { gateway_id: "gateway-1", hostname: "gateway.test", base_path: "/" },
        policy_bundle: { enforcement_chain: {
          chain_id: `chain-${revision}`, tenant_id: "tenant-1", resource_id: resourceId, capability_id: "chat",
          eligible_connection_ids: [`connection-${revision}`], one_policy_revision: 1, steps: [], request_filter_order: [], response_filter_order: [],
        } },
        operation: "APPLY" as const,
        resources: [{ apiVersion: "gateway.networking.k8s.io/v1", kind: "HTTPRoute", metadata: { name: `route-${revision}` }, spec: {} }],
      }
      const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: signer.keyId })).toString("base64url")
      const payload = Buffer.from(JSON.stringify({ issued_at: 0, expires_at: 1 })).toString("base64url")
      const signature = await signer.sign(new TextEncoder().encode(`${header}.${payload}`))
      const unsigned = {
        schema_version: "genio.one.gateway-release.v1" as const,
        tenant_id: "tenant-1", runtime_id: "runtime-1", gateway_id: "gateway-1", release_id: `release-${revision}`, head_revision: revision,
        projection_count: empty ? 0 : 1, manifest_jws: `${header}.${payload}.${signature}`,
        authorization_bundle_jws: "authorization", processor_policy_jws: "processor", gateway_routing_artifact_jws: "routing",
        enforcement_verification_keys_json: "keys", gateway_configuration: { capture_message_content: false },
        projections: empty ? [] : [{ reference: { publication_id: projection.publication_id, projection_id: projection.projection_id,
          revision, digest: projection.digest }, projection }],
      }
      const release: GatewayReleasePackage = { ...unsigned, package_digest: gatewayReleasePackageDigest(unsigned) }
      const command = await signGatewayReleaseCommand({ tenantId: release.tenant_id, runtimeId: release.runtime_id,
        commandId: `command-${revision}`, release: { schema_version: "genio.one.gateway-release-ref.v1", release_id: release.release_id,
          gateway_id: release.gateway_id, head_revision: revision, package_digest: release.package_digest, projection_count: release.projection_count }, signer })
      return { command, release }
    },
  }
}

function nativeEvent(revision: number, correlationId: string, authenticationFailure = false) {
  return {
    "x-request-id": correlationId, "genio.subject.id": "unverified-subject", "genio.client.id": "unverified-client",
    route_name: `namespace/route-${revision}/rule/0`, method: "POST", path: "/v1/chat/completions?token=private",
    response_code: authenticationFailure ? 401 : 200,
    response_code_details: authenticationFailure ? "jwt_authn_access_denied{JwtExpired}" : "via_upstream",
    start_time: "2026-10-01T00:00:00Z", duration: 10,
  }
}

async function cursor(root: string, releaseId: string): Promise<number> {
  try { return Number((await readFile(join(root, releaseId, "activity.cursor"), "utf8")).trim()) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error }
}

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Native activity lifecycle condition did not become ready")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function applier(root: string, keyRingPath: string,
  onActivity: (event: GatewayActivityIngest) => Promise<void>,
  onAuthenticationFailure: (event: GatewayAuthenticationFailureAuditIngest) => Promise<void>) {
  return createLocalAigwApplier({ binary: "/fixture/aigw", stateRoot: root, adminPort: 1064,
    runtimeCommandKeyRingPath: keyRingPath, releaseRootKeyRingPath: "/unused/release-root.json", onActivity, onAuthenticationFailure })
}

test("release switches retain capacity-rejected native activities and JWT audits until real outbox ACK", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-source-switch-"))
  const f = await fixture(root)
  const first = await f.input(1)
  const second = await f.input(2)
  let online = false
  let time = Date.now()
  const accepted: ObservationRecord[] = []
  const failures: unknown[] = []
  const outbox = await createObservationOutbox({ stateRoot: root, maxFiles: 4, now: () => time,
    retryBaseDelayMs: 0, retryMaxDelayMs: 1,
    async send(record) { if (!online) return 503; accepted.push(record); return 202 } })
  const runtime = applier(root, f.keyRingPath, async (event) => {
    try { await outbox.enqueue({ path: "/activities", body: event, correlationId: event.correlation_id }) }
    catch (error) { failures.push(error); throw error }
  }, async (event) => { await outbox.enqueue({ path: "/audit-events", body: event, correlationId: event.correlation_id }) })
  try {
    for (let index = 0; index < 4; index += 1) await outbox.enqueue({ path: "/activities", body: { filler: index } })
    await runtime.apply(first)
    await writeFile(join(root, first.release.release_id, "activity.jsonl"), `${JSON.stringify(nativeEvent(1, "old-jwt", true))}\n`)
    await until(() => failures.length > 0)
    assert.equal(failures[0] instanceof ObservationOutboxCapacityError, true)
    assert.equal(await cursor(root, first.release.release_id), 0)
    const result = await runtime.apply(second)
    assert.equal(result[0].state, "READY")
    await writeFile(join(root, second.release.release_id, "activity.jsonl"), `${JSON.stringify(nativeEvent(2, "new-jwt", true))}\n`)
    online = true
    time += 100
    await outbox.drainNow()
    await until(async () => (await cursor(root, first.release.release_id)) === 1 && (await cursor(root, second.release.release_id)) === 1)
    time += 100
    await outbox.drainNow()
    const events = accepted.filter((record) => record.correlation_id === "old-jwt" || record.correlation_id === "new-jwt")
    assert.equal(events.filter((record) => record.path === "/activities" && record.correlation_id === "old-jwt").length, 1)
    assert.equal(events.filter((record) => record.path === "/activities" && record.correlation_id === "new-jwt").length, 1)
    assert.equal(events.filter((record) => record.path === "/audit-events").length, 2)
    for (const record of events.filter((entry) => entry.path === "/activities")) {
      const event = record.body as GatewayActivityIngest
      assert.equal(event.resource_id, record.correlation_id === "old-jwt" ? "resource-1" : "resource-2")
      assert.equal(event.release_id, record.correlation_id === "old-jwt" ? "release-1" : "release-2")
      assert.equal(event.subject_id, null)
      assert.equal(event.acting_client_id, null)
      assert.equal(event.path, "/v1/chat/completions")
    }
    const oldAudit = events.find((entry) => entry.path === "/audit-events" && entry.correlation_id === "old-jwt")!
    assert.deepEqual(oldAudit.body, authenticationFailureForNativeEvent("release-1", nativeEvent(1, "old-jwt", true), 1))
  } finally {
    await runtime.close()
    await outbox.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test("producer final appends recover after shutdown into an empty release with the original expired signed context and receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-source-restart-"))
  const f = await fixture(root)
  const first = await f.input(1)
  const empty = await f.input(9, true)
  let failed = 0
  const initial = applier(root, f.keyRingPath, async () => { failed += 1; throw new Error("outbox persistence 503") }, async () => {})
  let recovered: ReturnType<typeof applier> | undefined
  try {
    await initial.apply(first)
    const child = nativeChildren.at(-1)!
    for (const correlationId of ["old-event", "final-event"]) {
      processor!.stdout.emit("data", Buffer.from(`${JSON.stringify({ event: "genio.one.processor-http-request-completed",
        correlation_id: correlationId, bundle_revision: "original-processor-revision", steps: [{ step_id: "original-step", action: "CLASSIFY" }],
        data_classifications: [], safety_decisions: [] })}\n`))
      await until(async () => (await readNativeActivityReceipt(join(root, "release-1"), correlationId)) !== null)
    }
    child.finalLine = nativeEvent(1, "final-event")
    child.beforeFinalAppend = async () => {
      const receipt = await readNativeActivityReceipt(join(root, "release-1"), "final-event") as any
      assert.equal(receipt.processor_receipt.bundle_revision, "original-processor-revision")
    }
    await writeFile(child.logPath!, `${JSON.stringify(nativeEvent(1, "old-event"))}\n`)
    await until(() => failed > 0)
    await initial.close()
    assert.equal(await cursor(root, "release-1"), 0)
    assert.equal((await readFile(child.logPath!, "utf8")).trim().split("\n").length, 2)
    const persisted: GatewayActivityIngest[] = []
    recovered = applier(root, f.keyRingPath, async (event) => { persisted.push(event) }, async () => {})
    await recovered.apply(empty)
    await until(async () => (await cursor(root, "release-1")) === 2)
    assert.deepEqual(persisted.map((event) => event.correlation_id), ["old-event", "final-event"])
    for (const event of persisted) {
      assert.equal(event.release_id, "release-1")
      assert.equal(event.release_head_revision, 1)
      assert.equal(event.resource_id, "resource-1")
      assert.equal(event.processor_bundle_revision, "original-processor-revision")
      assert.deepEqual(event.processor_request_steps, [{ step_id: "original-step", action: "CLASSIFY" }])
    }
    await until(async () => await stat(join(root, "release-1", "activity-source.complete.json")).then(() => true, () => false))
    assert.equal((await stat(join(root, "release-1"))).mode & 0o777, 0o700)
    assert.equal((await stat(join(root, "release-1", "activity-source.complete.json"))).mode & 0o777, 0o600)
  } finally {
    await recovered?.close()
    await initial.close()
    await rm(root, { recursive: true, force: true })
  }
})

function sourceManager(root: string, keyRingPath: string,
  deliver: (input: { release: GatewayReleasePackage; value: unknown; lineNumber: number }) => Promise<void>, errors: unknown[] = []) {
  return createNativeActivitySourceManager({ stateRoot: root, runtimeCommandKeyRingPath: keyRingPath,
    onError({ error }) { errors.push(error) },
    async consume(batch) {
      let count = 0
      for (const line of batch.lines) {
        await deliver({ release: batch.context.release, value: JSON.parse(line), lineNumber: batch.lineOffset + count + 1 })
        count += 1
        await batch.persistCursor(count)
      }
      return count
    },
  })
}

test("tampered historical projection context stays unacknowledged rather than inventing a verified Resource", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-source-trust-"))
  const f = await fixture(root)
  const first = await f.input(1)
  const empty = await f.input(2, true)
  const initial = sourceManager(root, f.keyRingPath, async () => { throw new Error("503") })
  const errors: unknown[] = []
  let delivered = 0
  let restored: ReturnType<typeof sourceManager> | undefined
  try {
    await initial.start(first)
    await initial.register(first)
    await writeFile(join(root, "release-1", "activity.jsonl"), `${JSON.stringify(nativeEvent(1, "historical"))}\n`)
    await initial.seal("release-1")
    await initial.close()
    const path = join(root, "release-1", "activity-source.json")
    const context = JSON.parse(await readFile(path, "utf8"))
    context.release.projections[0].projection.resource_id = "invented-resource"
    const { package_digest: _digest, ...unsigned } = context.release
    context.release.package_digest = gatewayReleasePackageDigest(unsigned)
    await writeFile(path, JSON.stringify(context), { mode: 0o600 })
    restored = sourceManager(root, f.keyRingPath, async () => { delivered += 1 }, errors)
    await restored.start(empty)
    await restored.drain()
    assert.equal(delivered, 0)
    assert.equal(await cursor(root, "release-1"), 0)
    assert.equal(errors.some((error) => error instanceof Error && /does not match the command/.test(error.message)), true)
  } finally {
    await restored?.close()
    await initial.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("one bounded drain shares work across concurrent requests without accumulating callback queues", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-source-batch-"))
  const f = await fixture(root)
  const first = await f.input(1)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const lineNumbers: number[] = []
  const manager = sourceManager(root, f.keyRingPath, async ({ lineNumber }) => {
    lineNumbers.push(lineNumber)
    if (lineNumber === 1) await gate
  })
  try {
    await manager.start(first)
    await manager.register(first)
    const lines = Array.from({ length: NATIVE_ACTIVITY_SOURCE_LIMITS.lines + 1 }, (_, index) => JSON.stringify({ id: index }))
    await writeFile(join(root, "release-1", "activity.jsonl"), `${lines.join("\n")}\n`)
    const firstDrain = manager.drain()
    await until(() => lineNumbers.length > 0)
    const concurrent = Array.from({ length: 100 }, () => manager.drain())
    assert.equal(concurrent.every((operation) => operation === firstDrain), true)
    assert.deepEqual(lineNumbers, [1])
    release()
    await Promise.all([firstDrain, ...concurrent])
    assert.equal(await cursor(root, "release-1"), NATIVE_ACTIVITY_SOURCE_LIMITS.lines)
    await manager.drain()
    assert.equal(await cursor(root, "release-1"), NATIVE_ACTIVITY_SOURCE_LIMITS.lines + 1)
    assert.deepEqual(lineNumbers, Array.from({ length: NATIVE_ACTIVITY_SOURCE_LIMITS.lines + 1 }, (_, index) => index + 1))
  } finally {
    release()
    await manager.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("oversized metadata is retained on disk without loading a resident context or acknowledging its log", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-source-limit-"))
  const f = await fixture(root)
  const first = await f.input(1)
  const empty = await f.input(2, true)
  const initial = sourceManager(root, f.keyRingPath, async () => { throw new Error("503") })
  const errors: unknown[] = []
  let delivered = 0
  let restored: ReturnType<typeof sourceManager> | undefined
  try {
    await initial.start(first)
    await initial.register(first)
    await initial.close()
    const path = join(root, "release-1", "activity-source.json")
    const handle = await open(path, "r+")
    await handle.truncate(NATIVE_ACTIVITY_SOURCE_LIMITS.contextBytes + 1)
    await handle.close()
    restored = sourceManager(root, f.keyRingPath, async () => { delivered += 1 }, errors)
    await restored.start(empty)
    await restored.drain()
    assert.equal(delivered, 0)
    assert.equal(await cursor(root, "release-1"), 0)
    assert.equal(errors.some((error) => error instanceof Error && /exceeds its read limit/.test(error.message)), true)
    assert.equal((await stat(path)).size, NATIVE_ACTIVITY_SOURCE_LIMITS.contextBytes + 1)
  } finally {
    await restored?.close()
    await initial.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("an empty release continues retrying a partially acknowledged JWT line until its audit callback durably accepts it", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-source-empty-"))
  const f = await fixture(root)
  const first = await f.input(1)
  const empty = await f.input(2, true)
  let auditBlocked = true
  let activityAttempts = 0
  let auditAttempts = 0
  const activityPath = join(root, "accepted-activity.json")
  const auditPath = join(root, "accepted-audit.json")
  const durableAccept = async (path: string, event: unknown) => {
    let handle: Awaited<ReturnType<typeof open>>
    try { handle = await open(path, "wx", 0o600) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), event)
      return
    }
    try { await handle.writeFile(JSON.stringify(event)); await handle.sync() }
    finally { await handle.close() }
  }
  const runtime = applier(root, f.keyRingPath, async (event) => {
    activityAttempts += 1
    await durableAccept(activityPath, event)
  }, async (event) => {
    auditAttempts += 1
    if (auditBlocked) throw new Error("outbox audit persistence 503")
    await durableAccept(auditPath, event)
  })
  try {
    await runtime.apply(first)
    await writeFile(join(root, "release-1", "activity.jsonl"), `${JSON.stringify(nativeEvent(1, "jwt-audit-retry", true))}\n`)
    await until(() => auditAttempts > 0)
    assert.equal(await cursor(root, "release-1"), 0)
    const result = await runtime.apply(empty)
    assert.equal(result[0].state, "READY")
    assert.equal(result[0].payload.active_routes, 0)
    assert.equal(await cursor(root, "release-1"), 0)
    auditBlocked = false
    await until(async () => (await cursor(root, "release-1")) === 1)
    assert.equal(activityAttempts >= 2, true)
    assert.equal(auditAttempts >= 2, true)
    assert.equal(JSON.parse(await readFile(activityPath, "utf8")).release_id, "release-1")
    assert.deepEqual(JSON.parse(await readFile(auditPath, "utf8")),
      authenticationFailureForNativeEvent("release-1", nativeEvent(1, "jwt-audit-retry", true), 1))
  } finally {
    await runtime.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("a native line crossing the byte batch waits for its newline and never advances on a partial event", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-source-byte-batch-"))
  const f = await fixture(root)
  const first = await f.input(1)
  let deliveries = 0
  const manager = sourceManager(root, f.keyRingPath, async () => { deliveries += 1 })
  try {
    await manager.start(first)
    await manager.register(first)
    const path = join(root, "release-1", "activity.jsonl")
    const line = JSON.stringify({ padding: "x".repeat(NATIVE_ACTIVITY_SOURCE_LIMITS.readBytes + 100) })
    await writeFile(path, line)
    await manager.drain()
    assert.equal(deliveries, 0)
    assert.equal(await cursor(root, "release-1"), 0)
    await manager.drain()
    assert.equal(deliveries, 0)
    assert.equal(await cursor(root, "release-1"), 0)
    await appendFile(path, "\n")
    await manager.drain()
    assert.equal(deliveries, 1)
    assert.equal(await cursor(root, "release-1"), 1)
  } finally {
    await manager.close()
    await rm(root, { recursive: true, force: true })
  }
})


test("upgrade recovery captures the previous signed current state before a newer empty release overwrites it", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-source-upgrade-"))
  const f = await fixture(root)
  const previous = await f.input(1)
  const next = await f.input(2, true)
  const legacyRoot = join(root, "release-without-signed-package")
  const errors: unknown[] = []
  const delivered: Array<{ releaseId: string; resourceId: string }> = []
  const manager = sourceManager(root, f.keyRingPath, async ({ release }) => {
    delivered.push({ releaseId: release.release_id, resourceId: release.projections[0]!.projection.resource_id })
  }, errors)
  try {
    await mkdir(join(root, "release-1"))
    await mkdir(legacyRoot)
    await writeFile(join(root, "release-1", "activity.jsonl"), `${JSON.stringify(nativeEvent(1, "pre-upgrade"))}\n`)
    await writeFile(join(legacyRoot, "activity.jsonl"), `${JSON.stringify(nativeEvent(1, "unknown-legacy"))}\n`)
    await writeFile(join(root, "current.json"), JSON.stringify(previous))
    await manager.start(next)
    await writeFile(join(root, "current.json"), JSON.stringify(next))
    for (let count = 0; count < 4; count += 1) await manager.drain()
    assert.deepEqual(delivered, [{ releaseId: "release-1", resourceId: "resource-1" }])
    assert.equal(await cursor(root, "release-1"), 1)
    assert.equal(await cursor(root, "release-without-signed-package"), 0)
    const saved = JSON.parse(await readFile(join(root, "release-1", "activity-source.json"), "utf8"))
    assert.deepEqual(saved.command, previous.command)
    assert.deepEqual(saved.release, previous.release)
    assert.equal(errors.some((error) => error instanceof Error && /no verified release context/.test(error.message)), true)
  } finally {
    await manager.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("a newer Processor response receipt cannot commit ahead of a pending older reader snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-source-receipt-race-"))
  const f = await fixture(root)
  const first = await f.input(1)
  const empty = await f.input(2, true)
  let allowDelivery = false
  const persisted: GatewayActivityIngest[] = []
  const runtime = applier(root, f.keyRingPath, async (event) => {
    if (!allowDelivery) throw new Error("outbox persistence 503")
    persisted.push(event)
  }, async () => {})
  let releaseOld!: () => void
  const oldGate = new Promise<void>((resolve) => { releaseOld = resolve })
  let olderReaderPending = false
  let newWriteStarted = false
  let armed = false
  try {
    await runtime.apply(first)
    processor!.stdout.emit("data", Buffer.from(`${JSON.stringify({ event: "genio.one.processor-http-request-completed",
      correlation_id: "receipt-race", bundle_revision: "original-revision", steps: [{ step_id: "request-step", action: "CLASSIFY" }],
      data_classifications: [], safety_decisions: [] })}\n`))
    await until(async () => (await readNativeActivityReceipt(join(root, "release-1"), "receipt-race")) !== null)
    armed = true
    receiptWriteHook = async (value) => {
      const receipt = value.processor_receipt
      if (armed && receipt.response_steps.length === 0) {
        armed = false
        olderReaderPending = true
        await oldGate
      }
      if (receipt.response_steps.some((step: { step_id: string }) => step.step_id === "response-step")) newWriteStarted = true
    }
    await writeFile(join(root, "release-1", "activity.jsonl"), `${JSON.stringify(nativeEvent(1, "receipt-race"))}\n`)
    await until(() => olderReaderPending)
    processor!.stdout.emit("data", Buffer.from(`${JSON.stringify({ event: "genio.one.processor-http-response-completed",
      correlation_id: "receipt-race", bundle_revision: "original-revision", steps: [{ step_id: "response-step", action: "CLASSIFY" }],
      data_classifications: [], safety_decisions: [] })}\n`))
    assert.equal(newWriteStarted, false)
    assert.equal(await cursor(root, "release-1"), 0)
    releaseOld()
    await until(async () => {
      const stored = await readNativeActivityReceipt(join(root, "release-1"), "receipt-race") as any
      return stored?.processor_receipt.response_steps[0]?.step_id === "response-step"
    })
    allowDelivery = true
    await runtime.apply(empty)
    await until(async () => (await cursor(root, "release-1")) === 1)
    assert.equal(newWriteStarted, true)
    assert.equal(persisted.length, 1)
    assert.equal(persisted[0]!.release_id, "release-1")
    assert.deepEqual(persisted[0]!.processor_request_steps, [{ step_id: "request-step", action: "CLASSIFY" }])
    assert.deepEqual(persisted[0]!.processor_response_steps, [{ step_id: "response-step", action: "CLASSIFY" }])
  } finally {
    releaseOld()
    receiptWriteHook = undefined
    await runtime.close()
    await rm(root, { recursive: true, force: true })
  }
})

}
