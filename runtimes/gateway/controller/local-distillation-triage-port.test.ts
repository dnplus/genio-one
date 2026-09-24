import { expect, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import {
  assertKnownDistillationPortOwnership,
  distillationPortRole,
  distillationTriageHandoffPath,
  releaseLocalDistillationTriage,
} from "./local-distillation-triage-port"
import {
  createDistillationTriageHandoff,
  distillationTriageHandoffLockPath,
  distillationTriageHandoffPath as managedHandoffPath,
  promoteDistillationTriageHandoff,
  readDistillationTriageHandoff,
  removeDistillationTriageHandoff,
} from "./local-distillation-triage-handoff.mjs"

const checkout = "/work/genioone-private"

test("only this checkout's triage process is eligible to hand the port to the processor", () => {
  expect(distillationPortRole({
    cwd: `${checkout}/runtimes/gateway`,
    command: "bun services/processor/local-distillation-triage.ts",
  }, checkout)).toBe("local-triage")
  expect(distillationPortRole({
    cwd: `${checkout}/apps/platform`,
    command: "bun /work/genioone-private/runtimes/gateway/services/processor/server.ts",
  }, checkout)).toBe("processor")
  expect(distillationPortRole({
    cwd: "/other/genioone-private/runtimes/gateway",
    command: "bun services/processor/local-distillation-triage.ts",
  }, checkout)).toBe("other")
})

test("an idle triage port does not create a handoff", async () => {
  const result = await releaseLocalDistillationTriage({
    checkoutRoot: checkout,
    owners: [],
    writeHandoff() { throw new Error("handoff") },
    stopPid() { throw new Error("stop") },
    async waitUntilPortFree() { throw new Error("wait") },
  })
  expect(result).toBe("idle")
})

test("an occupied triage port without a verified owner is rejected", () => {
  expect(() => assertKnownDistillationPortOwnership([], true)).toThrow("could not be verified")
  expect(() => assertKnownDistillationPortOwnership([], false)).not.toThrow()
})

test("releasing the local triage records the handoff before stopping it", async () => {
  const events: string[] = []
  const result = await releaseLocalDistillationTriage({
    checkoutRoot: checkout,
    owners: [{ pid: "42", cwd: `${checkout}/runtimes/gateway`, command: "bun services/processor/local-distillation-triage.ts" }],
    writeHandoff(path) {
      expect(path).toBe(distillationTriageHandoffPath(checkout))
      events.push("handoff")
    },
    stopPid(pid) {
      expect(events).toEqual(["handoff"])
      expect(pid).toBe("42")
      events.push("stop")
    },
    async waitUntilPortFree() {
      expect(events).toEqual(["handoff", "stop"])
      return true
    },
  })
  expect(result).toBe("standalone-triage")
})

test("a retained processor records the handoff before it is stopped", async () => {
  const events: string[] = []
  const result = await releaseLocalDistillationTriage({
    checkoutRoot: checkout,
    owners: [{ pid: "7", cwd: checkout, command: "bun runtimes/gateway/services/processor/server.ts" }],
    writeHandoff(path) {
      expect(path).toBe(distillationTriageHandoffPath(checkout))
      events.push("handoff")
    },
    stopPid(pid) {
      expect(events).toEqual(["handoff"])
      expect(pid).toBe("7")
      events.push("stop")
    },
    async waitUntilPortFree() {
      expect(events).toEqual(["handoff", "stop"])
      return true
    },
  })
  expect(result).toBe("retained-processor")
  expect(events).toEqual(["handoff", "stop"])
})

test("a changed PID identity is not signaled", async () => {
  const events: string[] = []
  await expect(releaseLocalDistillationTriage({
    checkoutRoot: checkout,
    owners: [{ pid: "7", cwd: checkout, command: "bun runtimes/gateway/services/processor/server.ts" }],
    writeHandoff() { events.push("handoff") },
    stopPid() { events.push("stop") },
    revalidateOwner() { return "changed" },
    async waitUntilPortFree() { events.push("wait"); return true },
  })).rejects.toThrow("changed before signal")
  expect(events).toEqual(["handoff"])
})

test("an already exited verified owner is not signaled", async () => {
  const result = await releaseLocalDistillationTriage({
    checkoutRoot: checkout,
    owners: [{ pid: "7", cwd: checkout, command: "bun runtimes/gateway/services/processor/server.ts" }],
    writeHandoff() {},
    stopPid() { throw new Error("stop") },
    revalidateOwner() { return "exited" },
    async waitUntilPortFree() { return true },
  })
  expect(result).toBe("retained-processor")
})

test("a listener with an unknown working directory is not owned by this checkout", () => {
  expect(distillationPortRole({ cwd: "", command: "bun services/processor/local-distillation-triage.ts" }, checkout)).toBe("other")
  expect(distillationPortRole({ cwd: "   ", command: "bun runtimes/gateway/services/processor/server.ts" }, checkout)).toBe("other")
})

test("a foreign listener is not stopped", async () => {
  await expect(releaseLocalDistillationTriage({
    checkoutRoot: checkout,
    owners: [{ pid: "9", cwd: "/tmp", command: "bun services/processor/local-distillation-triage.ts" }],
    writeHandoff() { throw new Error("handoff") },
    stopPid() { throw new Error("stop") },
    async waitUntilPortFree() { return true },
  })).rejects.toThrow("port 8182 is occupied")
})

test("a generation cleanup cannot remove a replacement handoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "g1-triage-handoff-"))
  try {
    const takingOver = createDistillationTriageHandoff(root, "taking-over")
    const ready = promoteDistillationTriageHandoff(takingOver, "ready")
    expect(ready).toBeDefined()
    expect(existsSync(takingOver.targetPath)).toBe(false)
    const replacement = createDistillationTriageHandoff(root, "taking-over")
    expect(removeDistillationTriageHandoff(ready!)).toBe(false)
    const current = readDistillationTriageHandoff(root)
    expect(current?.targetPath).toBe(replacement.targetPath)
    expect(current?.phase).toBe("taking-over")
    expect(existsSync(replacement.targetPath)).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("an observed generation cannot clear a promoted current handoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "g1-triage-handoff-"))
  try {
    const takingOver = createDistillationTriageHandoff(root, "taking-over")
    const observed = readDistillationTriageHandoff(root)
    const ready = promoteDistillationTriageHandoff(takingOver, "ready")
    expect(ready).toBeDefined()
    expect(removeDistillationTriageHandoff(observed!)).toBe(false)
    expect(readDistillationTriageHandoff(root)?.targetPath).toBe(ready!.targetPath)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a dangling current pointer is replaced on the next takeover", async () => {
  const root = await mkdtemp(join(tmpdir(), "g1-triage-handoff-"))
  try {
    const handoff = createDistillationTriageHandoff(root, "ready")
    expect(removeDistillationTriageHandoff(handoff)).toBe(true)
    expect(readDistillationTriageHandoff(root)).toBeUndefined()
    const replacement = createDistillationTriageHandoff(root, "taking-over")
    expect(readDistillationTriageHandoff(root)?.targetPath).toBe(replacement.targetPath)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a managed handoff atomically replaces a legacy marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "g1-triage-handoff-"))
  try {
    const path = managedHandoffPath(root)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, "legacy\n")
    expect(readDistillationTriageHandoff(root)?.managed).toBe(false)
    const handoff = createDistillationTriageHandoff(root, "taking-over")
    expect(lstatSync(path).isSymbolicLink()).toBe(true)
    expect(readDistillationTriageHandoff(root)?.targetPath).toBe(handoff.targetPath)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a stale dead-owner lock is reclaimed before the next takeover", async () => {
  const root = await mkdtemp(join(tmpdir(), "g1-triage-handoff-"))
  try {
    const lockPath = distillationTriageHandoffLockPath(root)
    mkdirSync(lockPath, { recursive: true })
    writeFileSync(`${lockPath}/owner.json`, JSON.stringify({
      token: "stale",
      pid: 999_999,
      processStartedAt: "stale",
    }))
    const handoff = createDistillationTriageHandoff(root, "taking-over")
    expect(readDistillationTriageHandoff(root)?.targetPath).toBe(handoff.targetPath)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
