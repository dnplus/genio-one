import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { basename, dirname, join, resolve } from "node:path"
import { existsSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"

import { mock, test } from "bun:test"

let handoffPath = ""
let releaseCalls = 0
let listenerCalls = 0
let releasedCheckoutRoot = ""
let listenerFailure: number | undefined = 8082
let replacementProcessorEnvironment: NodeJS.ProcessEnv | undefined
let processorReadiness: Promise<void> | undefined
let releaseObserved: (() => void) | undefined
let handoffGeneration = 0
let latestMockHandoff: ReturnType<typeof createMockHandoff> | undefined
let replacementProcessor: (EventEmitter & {
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  stdout: EventEmitter
}) | undefined

function createMockHandoff(phase: "taking-over" | "ready") {
  const generation = `mock-${++handoffGeneration}`
  const targetPath = `${handoffPath}.${generation}`
  const contents = `${phase}\n${generation}\n`
  writeFileSync(targetPath, contents)
  const pointerPath = `${handoffPath}.pointer-${generation}`
  try {
    symlinkSync(basename(targetPath), pointerPath)
    renameSync(pointerPath, handoffPath)
  } catch (error) {
    rmSync(pointerPath, { force: true })
    throw error
  }
  const handoff = { path: handoffPath, targetPath, contents, phase, generation, managed: true }
  latestMockHandoff = handoff
  return handoff
}

function promoteMockHandoff(handoff: ReturnType<typeof createMockHandoff>, phase: "taking-over" | "ready") {
  try {
    if (resolve(dirname(handoffPath), readlinkSync(handoffPath)) !== handoff.targetPath) return undefined
  } catch {
    return undefined
  }
  return createMockHandoff(phase)
}

function removeMockHandoff(handoff: ReturnType<typeof createMockHandoff>) {
  try {
    rmSync(handoff.targetPath, { force: true })
    return true
  } catch {
    return false
  }
}

mock.module("./local-distillation-triage-port", () => ({
  async releaseLocalDistillationTriageForProcessor(checkoutRoot: string) {
    releaseCalls += 1
    releasedCheckoutRoot = checkoutRoot
    releaseObserved?.()
    return createMockHandoff("taking-over")
  },
}))

mock.module("./local-distillation-triage-handoff.mjs", () => ({
  promoteDistillationTriageHandoff(handoff: ReturnType<typeof createMockHandoff>, phase: "taking-over" | "ready") {
    return promoteMockHandoff(handoff, phase)
  },
  removeDistillationTriageHandoff(handoff: ReturnType<typeof createMockHandoff>) {
    return removeMockHandoff(handoff)
  },
}))

mock.module("./process-lifecycle", () => ({
  async stopChild(child: { exitCode?: number | null; emit?: (event: string, ...arguments_: unknown[]) => boolean } | undefined) {
    if (child?.exitCode === null) {
      child.exitCode = 0
      child.emit?.("exit", 0, null)
    }
  },
  async stopProcessTree() {},
  async waitForEnvoyRunReadiness() {},
  async waitForHealth() {},
  async waitForListener(port: number) {
    listenerCalls += 1
    if (port === listenerFailure) throw new Error("processor readiness failed")
    if (port === 8082) await processorReadiness
  },
}))

mock.module("./aigw-runtime-cache", () => ({
  aigwEphemeralRunId: () => "r1",
  aigwRuntimeEnvironment: () => ({}),
  async createAigwEphemeralRuntimeDirectory() {
    return { directory: "/tmp/g1aigw-handoff", prefix: "g1aigw-handoff-" }
  },
  async prepareAigwRuntimeCache() {
    return {
      root: "/tmp/g1aigw-handoff",
      preparedRoot: "/tmp/g1aigw-handoff/prepared",
      configHome: "/tmp/g1aigw-handoff/config",
      dataHome: "/tmp/g1aigw-handoff/data",
      stateHome: "/tmp/g1aigw-handoff/state",
      runtimeDirectory: "/tmp/g1aigw-handoff/run",
    }
  },
  async removeAigwEphemeralRuntimeDirectory() {},
}))

mock.module("node:child_process", () => ({
  spawn(...arguments_: unknown[]) {
    const [command, childArguments, spawnOptions] = arguments_
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      stdout: new EventEmitter(),
    })
    if (
      typeof command === "string" &&
      Array.isArray(childArguments) &&
      childArguments.some((argument) =>
        typeof argument === "string" && argument.endsWith(join("services", "processor", "server.ts"))
      ) &&
      spawnOptions && typeof spawnOptions === "object"
    ) {
      replacementProcessorEnvironment = (spawnOptions as { env?: NodeJS.ProcessEnv }).env
      replacementProcessor = child
    }
    return child
  },
}))

const handoffModule = "./local-aigw.ts?handoff-failure"
const { createLocalAigwApplier } = await import(handoffModule)
mock.restore()

function releaseInput() {
  return {
    command: {
      tenant_id: "tenant-1",
      runtime_id: "runtime-1",
      desired_release: { gateway_id: "gateway-1" },
    } as any,
    release: {
      release_id: "release-1",
      head_revision: 1,
      projection_count: 1,
      gateway_configuration: { capture_message_content: false },
      projections: [{ projection: { operation: "APPLY", resources: [] } }],
      manifest_jws: "manifest",
      authorization_bundle_jws: "authorization",
      processor_policy_jws: "processor",
      gateway_routing_artifact_jws: "routing",
      enforcement_verification_keys_json: "keys",
    } as any,
  }
}

function applierFor(stateRoot: string, environment?: NodeJS.ProcessEnv) {
  return createLocalAigwApplier({
    binary: "/unused/aigw",
    stateRoot,
    adminPort: 1064,
    runtimeCommandKeyRingPath: "/unused/runtime-command-keyring.json",
    releaseRootKeyRingPath: "/unused/release-root-keyring.json",
    environment,
  })
}

function currentReplacementProcessor() {
  return replacementProcessor
}

function currentHandoffContents() {
  return readFile(handoffPath, "utf8")
}

test("replacement Processor receives the adapter registry resolved from the Gateway cwd", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "g1aigw-handoff-state-"))
  handoffPath = join(stateRoot, "distillation-triage-handoff")
  listenerFailure = undefined
  replacementProcessorEnvironment = undefined
  replacementProcessor = undefined
  const applier = applierFor(stateRoot, {
    GENIO_ONE_PROCESSOR_ADAPTERS_FILE: "fixtures/adapters.json",
  })
  try {
    await applier.apply(releaseInput())
    const observedEnvironment = replacementProcessorEnvironment as NodeJS.ProcessEnv | undefined
    assert.equal(
      observedEnvironment?.GENIO_ONE_PROCESSOR_ADAPTERS_FILE,
      resolve(import.meta.dirname, "..", "fixtures/adapters.json"),
    )
  } finally {
    await applier.close()
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("processor readiness failure preserves the triage handoff for supervisor recovery", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "g1aigw-handoff-state-"))
  handoffPath = join(stateRoot, "distillation-triage-handoff")
  releaseCalls = 0
  listenerCalls = 0
  releasedCheckoutRoot = ""
  listenerFailure = 8082
  const applier = applierFor(stateRoot)
  let closed = false
  try {
    await assert.rejects(applier.apply(releaseInput()), /processor readiness failed/)
    assert.equal(releaseCalls, 1)
    assert.equal(listenerCalls, 2)
    await applier.close()
    closed = true
    assert.equal(releasedCheckoutRoot.length > 0, true)
    assert.match(await currentHandoffContents(), /^taking-over\n/)
  } finally {
    if (!closed) await applier.close()
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("a ready retained Processor keeps its handoff marker for lifetime recovery", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "g1aigw-handoff-state-"))
  handoffPath = join(stateRoot, "distillation-triage-handoff")
  listenerFailure = undefined
  const applier = applierFor(stateRoot)
  try {
    await applier.apply(releaseInput())
    assert.equal(existsSync(handoffPath), true)
    assert.match(await currentHandoffContents(), /^ready\n/)
  } finally {
    await applier.close()
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("a ready standalone triage handoff remains for lifetime recovery", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "g1aigw-handoff-state-"))
  handoffPath = join(stateRoot, "distillation-triage-handoff")
  listenerFailure = undefined
  const applier = applierFor(stateRoot)
  try {
    await applier.apply(releaseInput())
    assert.equal(existsSync(handoffPath), true)
    assert.match(await currentHandoffContents(), /^ready\n/)
  } finally {
    await applier.close()
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("orderly Processor close retains its ready handoff until the live supervisor acknowledges recovery", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "g1aigw-handoff-state-"))
  handoffPath = join(stateRoot, "distillation-triage-handoff")
  listenerFailure = undefined
  const applier = applierFor(stateRoot)
  let closed = false
  try {
    await applier.apply(releaseInput())
    assert.equal(existsSync(handoffPath), true)
    await applier.close()
    closed = true
    assert.equal(existsSync(handoffPath), true)
    assert.match(await currentHandoffContents(), /^ready\n/)
    assert.equal(removeMockHandoff(latestMockHandoff!), true)
    assert.equal(existsSync(handoffPath), false)
  } finally {
    if (!closed) await applier.close()
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("orderly Processor close preserves a handoff replaced after its takeover", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "g1aigw-handoff-state-"))
  handoffPath = join(stateRoot, "distillation-triage-handoff")
  listenerFailure = undefined
  const applier = applierFor(stateRoot)
  let closed = false
  try {
    await applier.apply(releaseInput())
    createMockHandoff("taking-over")
    await applier.close()
    closed = true
    assert.match(await currentHandoffContents(), /^taking-over\n/)
  } finally {
    if (!closed) await applier.close()
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("a live takeover keeps its taking-over phase until the replacement Processor is ready", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "g1aigw-handoff-state-"))
  handoffPath = join(stateRoot, "distillation-triage-handoff")
  listenerFailure = undefined
  replacementProcessor = undefined
  let releaseComplete = () => {}
  const released = new Promise<void>((resolveRelease) => { releaseComplete = resolveRelease })
  let releaseProcessor = () => {}
  processorReadiness = new Promise<void>((resolveProcessor) => { releaseProcessor = resolveProcessor })
  releaseObserved = () => releaseComplete()
  const applier = applierFor(stateRoot)
  try {
    const applying = applier.apply(releaseInput())
    await released
    assert.match(await currentHandoffContents(), /^taking-over\n/)
    releaseProcessor()
    await applying
    assert.match(await currentHandoffContents(), /^ready\n/)
  } finally {
    processorReadiness = undefined
    releaseObserved = undefined
    await applier.close()
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("unexpected Processor exit preserves its triage handoff for recovery", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "g1aigw-handoff-state-"))
  handoffPath = join(stateRoot, "distillation-triage-handoff")
  listenerFailure = undefined
  replacementProcessor = undefined
  const applier = applierFor(stateRoot)
  try {
    await applier.apply(releaseInput())
    const child = currentReplacementProcessor()
    assert.ok(child)
    child.exitCode = 1
    child.emit("exit", 1, null)
    await applier.close()
    assert.equal(existsSync(handoffPath), true)
    assert.match(await currentHandoffContents(), /^ready\n/)
  } finally {
    await applier.close()
    await rm(stateRoot, { recursive: true, force: true })
  }
})
