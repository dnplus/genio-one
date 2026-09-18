import assert from "node:assert/strict"
import test from "node:test"

import { startLeaseHeartbeat } from "./lease-heartbeat"

interface ScheduledTask {
  callback: () => void
  cancelled: boolean
}

function scheduler() {
  const tasks: ScheduledTask[] = []
  return {
    schedule(callback: () => void): ReturnType<typeof setTimeout> {
      const task = { callback, cancelled: false }
      tasks.push(task)
      return task as unknown as ReturnType<typeof setTimeout>
    },
    cancel(timer: ReturnType<typeof setTimeout>): void {
      (timer as unknown as ScheduledTask).cancelled = true
    },
    async runNext(): Promise<void> {
      const task = tasks.shift()
      assert.ok(task, "expected a scheduled heartbeat")
      assert.equal(task.cancelled, false)
      task.callback()
      await Promise.resolve()
    },
    get pending() { return tasks.filter((task) => !task.cancelled).length },
  }
}

test("lease heartbeat schedules only after the previous renewal settles", async () => {
  const clock = scheduler()
  let renewals = 0
  let resolveFirst: (() => void) | undefined
  let resolveSecond: (() => void) | undefined
  const lifecycle = startLeaseHeartbeat({
    heartbeat: async () => {
      renewals += 1
      await new Promise<void>((resolve) => {
        if (renewals === 1) resolveFirst = resolve
        else resolveSecond = resolve
      })
    },
    onError(error) { throw error },
    intervalMs: 10,
    schedule: clock.schedule,
    cancel: clock.cancel,
  })

  assert.equal(renewals, 1)
  assert.equal(clock.pending, 0)
  resolveFirst?.()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(clock.pending, 1)

  await clock.runNext()
  assert.equal(renewals, 2)
  assert.equal(clock.pending, 0)
  resolveSecond?.()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(clock.pending, 1)
  await lifecycle.stop()
})

test("lease heartbeat stops queued and in-flight work on shutdown", async () => {
  const clock = scheduler()
  const shutdown = new AbortController()
  let aborted = false
  let release: (() => void) | undefined
  const lifecycle = startLeaseHeartbeat({
    heartbeat: async (signal) => {
      signal.addEventListener("abort", () => { aborted = true }, { once: true })
      await new Promise<void>((resolve) => { release = resolve })
    },
    onError(error) { throw error },
    signal: shutdown.signal,
    schedule: clock.schedule,
    cancel: clock.cancel,
  })

  shutdown.abort()
  assert.equal(aborted, true)
  assert.equal(clock.pending, 0)
  release?.()
  await lifecycle.stop()
  await Promise.resolve()
  assert.equal(clock.pending, 0)
})

test("lease heartbeat logs a transient failure then retries", async () => {
  const clock = scheduler()
  const errors: unknown[] = []
  const lifecycle = startLeaseHeartbeat({
    heartbeat: async () => { throw new Error("temporary control-plane failure") },
    onError(error) { errors.push(error) },
    schedule: clock.schedule,
    cancel: clock.cancel,
  })

  await Promise.resolve()
  await Promise.resolve()
  assert.equal(errors.length, 1)
  assert.equal(clock.pending, 1)
  await lifecycle.stop()
})

test("lease heartbeat can wait after a caller has already renewed the lease", async () => {
  const clock = scheduler()
  let renewals = 0
  const lifecycle = startLeaseHeartbeat({
    heartbeat: async () => { renewals += 1 },
    onError(error) { throw error },
    startImmediately: false,
    schedule: clock.schedule,
    cancel: clock.cancel,
  })
  assert.equal(renewals, 0)
  assert.equal(clock.pending, 1)
  await clock.runNext()
  assert.equal(renewals, 1)
  await lifecycle.stop()
})
