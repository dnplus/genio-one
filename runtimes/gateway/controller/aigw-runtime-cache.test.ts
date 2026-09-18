import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  aigwRuntimeEnvironment,
  aigwRuntimePaths,
  aigwEphemeralRunId,
  createAigwEphemeralRuntimeDirectory,
  prepareAigwRuntimeCache,
  removeAigwEphemeralRuntimeDirectory,
} from "./aigw-runtime-cache"

async function downloadedEnvoy(environment: NodeJS.ProcessEnv, content = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0])) {
  const binaryPath = join(environment.AIGW_DATA_HOME!, "envoy-versions", "1.38.1", "bin", "envoy")
  await mkdir(join(binaryPath, ".."), { recursive: true })
  await writeFile(binaryPath, content, { mode: 0o700 })
  return binaryPath
}

async function fixtureAigw(root: string): Promise<string> {
  const binary = join(root, "bin", "aigw")
  await mkdir(join(binary, ".."), { recursive: true })
  await writeFile(binary, "#!/bin/sh\necho fixture\n", { mode: 0o700 })
  return binary
}

async function fixtureEnvoy(environment: NodeJS.ProcessEnv): Promise<string> {
  return await downloadedEnvoy(environment, Buffer.from("#!/bin/sh\necho envoy\n"))
}

test("AIGW cache preparation atomically adopts one official download and reuses its marked binary", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "genio-one-aigw-cache-"))
  const downloads: Array<{ environment: NodeJS.ProcessEnv; timeoutMs: number }> = []
  try {
    const binary = await fixtureAigw(stateRoot)
    const first = await prepareAigwRuntimeCache({
      binary,
      stateRoot,
      environment: { AIGW_DATA_HOME: "/outside", CUSTOM_VALUE: "kept" },
      timeoutMs: 321_000,
      async download(input) {
        downloads.push(input)
        await fixtureEnvoy(input.environment)
      },
      async version() { return "fixture-v1" },
      async probe() {},
    })
    assert.equal(downloads.length, 1)
    assert.equal(downloads[0]!.timeoutMs, 321_000)
    assert.equal(downloads[0]!.environment.CUSTOM_VALUE, "kept")
    assert.notEqual(downloads[0]!.environment.AIGW_DATA_HOME, "/outside")
    assert.match(downloads[0]!.environment.AIGW_DATA_HOME!, /\/aigw\/staging\/prepare-[^/]+\/prepared\/data$/)
    assert.equal(existsSync(join(first.preparedRoot, "genio-one-aigw-cache-v1.json")), true)

    const second = await prepareAigwRuntimeCache({
      binary,
      stateRoot,
      async download() {
        assert.fail("a valid prepared cache must be reused")
      },
      async version() { return "fixture-v1" },
      async probe() {},
    })
    assert.deepEqual(second, first)
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("failed or interrupted AIGW preparation is discarded and cannot be adopted by the next start", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "genio-one-aigw-cache-"))
  try {
    const binary = await fixtureAigw(stateRoot)
    await assert.rejects(
      () => prepareAigwRuntimeCache({
        binary,
        stateRoot,
        async download(input) {
          await downloadedEnvoy(input.environment, Buffer.from("incomplete"))
          throw new Error("interrupted download")
        },
        async version() { return "fixture-v1" },
        async probe() {},
      }),
      /interrupted download/,
    )
    const paths = aigwRuntimePaths(stateRoot)
    assert.equal(existsSync(paths.preparedRoot), false)

    let attempts = 0
    await prepareAigwRuntimeCache({
      binary,
      stateRoot,
      async download(input) {
        attempts += 1
        await fixtureEnvoy(input.environment)
      },
      async version() { return "fixture-v1" },
      async probe() {},
    })
    assert.equal(attempts, 1)

    await writeFile(binary, "#!/bin/sh\necho upgraded-fixture\n", { mode: 0o700 })
    let hashAttempts = 0
    await prepareAigwRuntimeCache({
      binary,
      stateRoot,
      async download(input) {
        hashAttempts += 1
        await fixtureEnvoy(input.environment)
      },
      async version() { return "fixture-v2" },
      async probe() {},
    })
    assert.equal(hashAttempts, 1)
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("a marker does not adopt a cache whose Envoy binary was interrupted after preparation", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "genio-one-aigw-cache-"))
  try {
    const binary = await fixtureAigw(stateRoot)
    const first = await prepareAigwRuntimeCache({
      binary,
      stateRoot,
      async download(input) {
        await fixtureEnvoy(input.environment)
      },
      async version() { return "fixture-v1" },
      async probe() {},
    })
    await writeFile(join(first.dataHome, "envoy-versions", "1.38.1", "bin", "envoy"), Buffer.from("incomplete"), { mode: 0o700 })

    let attempts = 0
    await prepareAigwRuntimeCache({
      binary,
      stateRoot,
      async download(input) {
        attempts += 1
        await fixtureEnvoy(input.environment)
      },
      async version() { return "fixture-v1" },
      async probe() {},
    })
    assert.equal(attempts, 1)
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("a download is not adopted when its native Envoy probe fails", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "genio-one-aigw-cache-"))
  try {
    const binary = await fixtureAigw(stateRoot)
    await assert.rejects(
      () => prepareAigwRuntimeCache({
        binary,
        stateRoot,
        async download(input) { await fixtureEnvoy(input.environment) },
        async version() { return "fixture-v1" },
        async probe() { throw new Error("envoy probe failed") },
      }),
      /envoy probe failed/,
    )
    assert.equal(existsSync(aigwRuntimePaths(stateRoot).preparedRoot), false)
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("a changed AIGW version never reuses the prior Envoy cache marker", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "genio-one-aigw-cache-"))
  try {
    const binary = await fixtureAigw(stateRoot)
    await prepareAigwRuntimeCache({
      binary,
      stateRoot,
      async download(input) { await fixtureEnvoy(input.environment) },
      async version() { return "fixture-v1" },
      async probe() {},
    })
    let attempts = 0
    await prepareAigwRuntimeCache({
      binary,
      stateRoot,
      async download(input) {
        attempts += 1
        await fixtureEnvoy(input.environment)
      },
      async version() { return "fixture-v2" },
      async probe() {},
    })
    assert.equal(attempts, 1)
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("an aborted preparation passes its signal to the official download seam and leaves no cache", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "genio-one-aigw-cache-"))
  const controller = new AbortController()
  try {
    const binary = await fixtureAigw(stateRoot)
    const preparation = prepareAigwRuntimeCache({
      binary,
      stateRoot,
      signal: controller.signal,
      async download(input) {
        if (input.signal?.aborted) throw new Error("download aborted")
        await new Promise<void>((_resolve, reject) => {
          input.signal?.addEventListener("abort", () => reject(new Error("download aborted")), { once: true })
        })
      },
      async version() { return "fixture-v1" },
      async probe() {},
    })
    controller.abort()
    await assert.rejects(preparation, /download aborted/)
    assert.equal(existsSync(aigwRuntimePaths(stateRoot).preparedRoot), false)
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("runtime AIGW homes override inherited homes while preserving unrelated environment", () => {
  const paths = aigwRuntimePaths("/workspace/.local/gateway-runtime/runtime-a")
  assert.deepEqual(aigwRuntimeEnvironment({
    AIGW_CONFIG_HOME: "/outside/config",
    AIGW_DATA_HOME: "/outside/data",
    AIGW_STATE_HOME: "/outside/state",
    AIGW_RUNTIME_DIR: "/outside/run",
    KEEP: "yes",
  }, paths), {
    ...process.env,
    AIGW_CONFIG_HOME: paths.configHome,
    AIGW_DATA_HOME: paths.dataHome,
    AIGW_STATE_HOME: paths.stateHome,
    AIGW_RUNTIME_DIR: paths.runtimeDirectory,
    KEEP: "yes",
  })
})

test("long workspaces use a private short runtime directory for AIGW Unix sockets", async () => {
  const stateRoot = `/workspace/${"very-long-checkout-name/".repeat(12)}gateway-runtime`
  const runId = aigwEphemeralRunId(5)
  const runtimeDirectory = await createAigwEphemeralRuntimeDirectory(stateRoot, runId)
  try {
    const metadata = await lstat(runtimeDirectory.directory)
    assert.equal(metadata.isDirectory(), true)
    assert.equal(metadata.isSymbolicLink(), false)
    assert.equal(metadata.mode & 0o077, 0)
    assert.ok(Buffer.byteLength(join(runtimeDirectory.directory, runId, "uds.sock")) <= 103)
  } finally {
    await removeAigwEphemeralRuntimeDirectory(runtimeDirectory)
  }
})

test("ephemeral runtime cleanup rejects a replaced symlink", async () => {
  const runtimeDirectory = await createAigwEphemeralRuntimeDirectory("/workspace/gateway-runtime", aigwEphemeralRunId(5))
  try {
    await rm(runtimeDirectory.directory, { recursive: true, force: true })
    await symlink("/tmp", runtimeDirectory.directory)
    await assert.rejects(
      () => removeAigwEphemeralRuntimeDirectory(runtimeDirectory),
      /not an owned private directory/,
    )
  } finally {
    await rm(runtimeDirectory.directory, { recursive: true, force: true })
  }
})
