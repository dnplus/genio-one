import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  createObservationOutbox,
  ObservationOutboxCapacityError,
  type ObservationRecord,
} from "./observation-outbox"

async function temporaryRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "genio-one-observation-outbox-"))
}

async function files(path: string): Promise<string[]> {
  return (await readdir(path)).filter((name) => name.endsWith(".json")).sort()
}

test("acknowledges only after the observation entry is durably written", async () => {
  const root = await temporaryRoot()
  let release!: () => void
  const sendGate = new Promise<void>((resolve) => { release = resolve })
  const outbox = await createObservationOutbox({
    stateRoot: root,
    send: async (_record, _signal) => {
      await sendGate
      return 202
    },
    retryBaseDelayMs: 0,
    retryMaxDelayMs: 1,
  })
  try {
    const accepted = await outbox.enqueue({
      path: "/audit-events",
      correlationId: "corr-durable",
      body: { event: "authentication.failure", result: "DENY" },
    })
    const pending = await files(outbox.pendingDirectory)
    assert.equal(pending.length, 1)
    const stored = JSON.parse(await readFile(join(outbox.pendingDirectory, pending[0]!), "utf8"))
    assert.deepEqual(Object.keys(stored).sort(), ["body", "correlation_id", "path"])
    assert.deepEqual(stored, {
      path: "/audit-events",
      correlation_id: accepted.correlation_id,
      body: { event: "authentication.failure", result: "DENY" },
    })
    release()
    await outbox.drainNow()
    assert.deepEqual(await files(outbox.pendingDirectory), [])
  } finally {
    release()
    await outbox.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test("replays a durable observation after restart", async () => {
  const root = await temporaryRoot()
  const first = await createObservationOutbox({
    stateRoot: root,
    send: async () => 503,
    retryBaseDelayMs: 60_000,
  })
  try {
    await first.enqueue({ path: "/activities", correlationId: "corr-replay", body: { state: "DENY" } })
    await first.stop()

    const delivered: ObservationRecord[] = []
    const second = await createObservationOutbox({
      stateRoot: root,
      send: async (record) => {
        delivered.push(record)
        return 204
      },
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 1,
    })
    try {
      await second.drainNow()
      assert.deepEqual(delivered, [{
        path: "/activities",
        correlation_id: "corr-replay",
        body: { state: "DENY" },
      }])
      assert.deepEqual(await files(second.pendingDirectory), [])
    } finally {
      await second.stop()
    }
  } finally {
    await first.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test("cleans crash leftovers and exposes delivery health", async () => {
  const root = await temporaryRoot()
  const pendingDirectory = join(root, "observation-outbox", "pending")
  await mkdir(pendingDirectory, { recursive: true })
  const temporaryPath = join(pendingDirectory, "1790958590000-crashed.json.temporary.tmp")
  await writeFile(temporaryPath, "partial observation")
  const outbox = await createObservationOutbox({
    stateRoot: root,
    send: async () => 503,
    retryBaseDelayMs: 60_000,
  })
  try {
    assert.deepEqual(await files(outbox.pendingDirectory), [])
    const recovered = await outbox.health()
    assert.equal(recovered.stale_temp_count, 0)
    assert.equal(recovered.blocked, false)
    await outbox.enqueue({ path: "/activities", correlationId: "corr-health", body: { queued: true } })
    await outbox.drainNow()
    const health = await outbox.health()
    assert.equal(health.pending_count, 1)
    assert.equal(health.blocked, false)
    assert.equal(health.degraded, true)
    assert.equal(health.last_retry?.status, 503)
    assert.equal(health.last_delivery_failure?.status, 503)
    assert.equal(health.last_retry?.correlation_id, "corr-health")
  } finally {
    await outbox.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test("deletes entries only after a 2xx acknowledgement", async () => {
  const root = await temporaryRoot()
  let sent = 0
  const outbox = await createObservationOutbox({
    stateRoot: root,
    send: async () => {
      sent += 1
      return 201
    },
    retryBaseDelayMs: 0,
    retryMaxDelayMs: 1,
  })
  try {
    await outbox.enqueue({ path: "/accounting", body: { units: 1 } })
    await outbox.drainNow()
    assert.equal(sent, 1)
    assert.deepEqual(await files(outbox.pendingDirectory), [])
  } finally {
    await outbox.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test("retries network failures and retryable response statuses with bounded backoff", async () => {
  const root = await temporaryRoot()
  const statuses: Array<number | Error> = [
    new Error("network unavailable"),
    408,
    429,
    500,
    401,
    403,
    204,
  ]
  let attempts = 0
  const outbox = await createObservationOutbox({
    stateRoot: root,
    send: async () => {
      const result = statuses[attempts++]!
      if (result instanceof Error) throw result
      return result
    },
    retryBaseDelayMs: 0,
    retryMaxDelayMs: 1,
  })
  try {
    await outbox.enqueue({ path: "/activities", body: { sequence: 1 } })
    for (let index = 0; index < statuses.length + 2; index += 1) await outbox.drainNow()
    assert.equal(attempts, statuses.length)
    assert.deepEqual(await files(outbox.pendingDirectory), [])
  } finally {
    await outbox.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test("bounds delivery attempts with the configured request timeout", async () => {
  const root = await temporaryRoot()
  const outbox = await createObservationOutbox({
    stateRoot: root,
    requestTimeoutMs: 10,
    send: async (_record, signal) => await new Promise<number>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("request timed out")), { once: true })
    }),
    retryBaseDelayMs: 60_000,
  })
  try {
    const startedAt = Date.now()
    await outbox.enqueue({ path: "/activities", body: { timeout: true } })
    await outbox.drainNow()
    assert.ok(Date.now() - startedAt < 500)
    assert.equal((await files(outbox.pendingDirectory)).length, 1)
  } finally {
    await outbox.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test("quarantines a permanent 4xx response and retains the entry", async () => {
  const root = await temporaryRoot()
  const outbox = await createObservationOutbox({
    stateRoot: root,
    send: async () => 422,
  })
  try {
    await outbox.enqueue({ path: "/audit-events", correlationId: "corr-poison", body: { invalid: true } })
    await outbox.drainNow()
    const quarantine = await files(outbox.quarantineDirectory)
    assert.equal(quarantine.length, 1)
    assert.deepEqual(JSON.parse(await readFile(join(outbox.quarantineDirectory, quarantine[0]!), "utf8")), {
      path: "/audit-events",
      correlation_id: "corr-poison",
      body: { invalid: true },
    })
    assert.deepEqual(await files(outbox.pendingDirectory), [])
    const health = await outbox.health()
    assert.equal(health.quarantine_count, 1)
    assert.equal(health.last_delivery_failure?.status, 422)
    assert.equal(health.blocked, true)
    assert.equal(health.degraded, true)
    assert.equal(health.blocked_reason, "outbox quarantine contains undeliverable observations")
  } finally {
    await outbox.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test("stale retryable delivery remains pending and recovers after the outage", async () => {
  const root = await temporaryRoot()
  let current = 1_000_000
  let attempts = 0
  const outbox = await createObservationOutbox({
    stateRoot: root,
    now: () => current,
    send: async () => {
      attempts += 1
      return attempts === 1 ? 503 : 204
    },
    retryBaseDelayMs: 0,
    retryMaxDelayMs: 1,
  })
  try {
    await outbox.enqueue({ path: "/accounting", body: { units: 9 } })
    await outbox.drainNow()
    current += 15 * 60 * 1_000 + 1
    const staleHealth = await outbox.health()
    assert.equal(staleHealth.pending_count, 1)
    assert.equal(staleHealth.quarantine_count, 0)
    assert.equal(staleHealth.blocked, true)
    assert.equal(staleHealth.degraded, true)
    assert.equal(staleHealth.blocked_reason, "oldest pending observation is stale")
    assert.ok((staleHealth.oldest_pending_age_ms ?? 0) >= 15 * 60 * 1_000)

    await outbox.drainNow()
    assert.equal(attempts, 2)
    assert.deepEqual(await files(outbox.pendingDirectory), [])
    const recoveredHealth = await outbox.health()
    assert.equal(recoveredHealth.pending_count, 0)
    assert.equal(recoveredHealth.quarantine_count, 0)
    assert.equal(recoveredHealth.blocked, false)
    assert.equal(recoveredHealth.degraded, false)
  } finally {
    await outbox.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects new observations when byte or file capacity is full", async () => {
  const root = await temporaryRoot()
  const outbox = await createObservationOutbox({
    stateRoot: root,
    send: async () => 503,
    maxFiles: 1,
    maxBytes: 1_024,
    retryBaseDelayMs: 60_000,
  })
  try {
    await outbox.enqueue({ path: "/activities", body: { retained: true } })
    await assert.rejects(
      outbox.enqueue({ path: "/activities", body: { retained: false } }),
      (error: unknown) => error instanceof ObservationOutboxCapacityError && error.status === 507,
    )
    const health = await outbox.health()
    assert.equal(health.blocked, true)
    assert.equal(health.degraded, true)
    assert.equal(health.blocked_reason, "outbox capacity exhausted")
    await outbox.stop()

    const byteRoot = await temporaryRoot()
    const byteLimited = await createObservationOutbox({
      stateRoot: byteRoot,
      send: async () => 503,
      maxBytes: 1,
      maxFiles: 5,
    })
    try {
      await assert.rejects(
        byteLimited.enqueue({ path: "/activities", body: { too: "large" } }),
        (error: unknown) => error instanceof ObservationOutboxCapacityError && error.status === 507,
      )
    } finally {
      await byteLimited.stop()
      await rm(byteRoot, { recursive: true, force: true })
    }
  } finally {
    await outbox.stop()
    await rm(root, { recursive: true, force: true })
  }
})
