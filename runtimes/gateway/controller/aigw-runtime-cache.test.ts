import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
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
  type AigwDownloadInput,
} from "./aigw-runtime-cache"

async function downloadedEnvoy(input: AigwDownloadInput, content = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), version = input.envoyVersion) {
  const binaryPath = join(input.environment.AIGW_DATA_HOME!, "envoy-versions", version, "bin", "envoy")
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

async function fixtureEnvoy(input: AigwDownloadInput): Promise<string> {
  return await downloadedEnvoy(input, Buffer.from("#!/bin/sh\necho envoy\n"))
}

async function archiveFixture(root: string, content?: Buffer, invalidDigest = false) {
  const versions = await readFile(new URL("../../../apps/platform/config/ai-mcp-gateway/provider-versions.env", import.meta.url), "utf8")
  const version = /^ENVOY_PROXY_VERSION=v(\d+\.\d+\.\d+)$/m.exec(versions)![1]!
  const architecture = process.arch === "x64" ? "amd64" : process.arch
  const directory = `envoy-v${version}-${process.platform}-${architecture}`
  const archiveName = `${directory}.tar.xz`
  const sourceRoot = join(root, "archive-source")
  const binaryPath = join(sourceRoot, directory, "bin", "envoy")
  await mkdir(join(binaryPath, ".."), { recursive: true })
  await writeFile(binaryPath, content ?? Buffer.from(`#!/bin/sh\necho "envoy version: fixture/${version}/Clean"\n`), { mode: 0o700 })
  const archivePath = join(root, archiveName)
  const tar = spawnSync("tar", ["-cJf", archivePath, "-C", sourceRoot, directory], { encoding: "utf8" })
  assert.equal(tar.status, 0, tar.stderr)
  const archive = await readFile(archivePath)
  const archiveUrl = `https://archive.tetratelabs.io/envoy/download/v${version}/${archiveName}`
  let requests = 0
  return {
    version,
    requests: () => requests,
    async fetch(url: string): Promise<Response> {
      requests += 1
      if (url.endsWith("/envoy-versions.json")) {
        return Response.json({
          latestVersion: "99.0.0",
          versions: { [version]: { tarballs: { [`${process.platform}/${architecture}`]: archiveUrl } } },
          sha256sums: { [archiveName]: invalidDigest ? "0".repeat(64) : createHash("sha256").update(archive).digest("hex") },
        })
      }
      assert.equal(url, archiveUrl)
      return new Response(new Uint8Array(archive))
    },
  }
}

test("official archive preparation follows the provider pin instead of catalog latest and reuses its verified binary", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "genio-one-aigw-archive-"))
  try {
    const fixture = await archiveFixture(stateRoot)
    const binary = await fixtureAigw(stateRoot)
    const paths = await prepareAigwRuntimeCache({ binary, stateRoot, fetch: fixture.fetch, async version() { return "fixture-v1" } })
    const marker = JSON.parse(await readFile(join(paths.preparedRoot, "genio-one-aigw-cache-v2.json"), "utf8"))
    assert.equal(marker.envoy_version, fixture.version)
    assert.equal(marker.binary_path, `data/envoy-versions/${fixture.version}/bin/envoy`)
    const preferencePath = join(paths.configHome, "envoy-version")
    assert.equal((await readFile(preferencePath, "utf8")).trim(), fixture.version)
    assert.equal((await lstat(preferencePath)).mode & 0o077, 0)
    await writeFile(preferencePath, "1.39.2\n")
    assert.equal(fixture.requests(), 2)
    await prepareAigwRuntimeCache({ binary, stateRoot, fetch: fixture.fetch, async version() { return "fixture-v1" } })
    assert.equal(fixture.requests(), 2)
    assert.equal((await readFile(preferencePath, "utf8")).trim(), fixture.version)
    assert.deepEqual(await readdir(paths.configHome), ["envoy-version"])
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("archive digest failure discards staging before extraction or native probe", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "genio-one-aigw-archive-"))
  try {
    const fixture = await archiveFixture(stateRoot, undefined, true)
    const binary = await fixtureAigw(stateRoot)
    await assert.rejects(() => prepareAigwRuntimeCache({
      binary, stateRoot, fetch: fixture.fetch,
      async version() { return "fixture-v1" },
      async probe() { assert.fail("a digest mismatch must fail before executing Envoy") },
    }), /SHA-256 mismatch/)
    const paths = aigwRuntimePaths(stateRoot)
    assert.equal(existsSync(paths.preparedRoot), false)
    assert.deepEqual(await readdir(join(paths.root, "staging")), [])
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("a verified archive with a partial native binary fails its full probe and leaves no prepared cache", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "genio-one-aigw-archive-"))
  try {
    const fixture = await archiveFixture(stateRoot, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]))
    const binary = await fixtureAigw(stateRoot)
    await assert.rejects(() => prepareAigwRuntimeCache({ binary, stateRoot, fetch: fixture.fetch, async version() { return "fixture-v1" } }))
    const paths = aigwRuntimePaths(stateRoot)
    assert.equal(existsSync(paths.preparedRoot), false)
    assert.deepEqual(await readdir(join(paths.root, "staging")), [])
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("an executable reporting the wrong native version cannot be marked as the provider pin", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "genio-one-aigw-archive-"))
  try {
    const fixture = await archiveFixture(stateRoot, Buffer.from("#!/bin/sh\necho 'envoy version: fixture/1.39.2/Clean'\n"))
    const binary = await fixtureAigw(stateRoot)
    await assert.rejects(() => prepareAigwRuntimeCache({ binary, stateRoot, fetch: fixture.fetch, async version() { return "fixture-v1" } }), /did not report pinned version/)
    assert.equal(existsSync(aigwRuntimePaths(stateRoot).preparedRoot), false)
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("same AIGW identity cannot reuse a legacy or wrong Envoy version marker", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "genio-one-aigw-cache-"))
  try {
    const binary = await fixtureAigw(stateRoot)
    const options = { binary, stateRoot, async download(input: AigwDownloadInput) { await fixtureEnvoy(input) }, async version() { return "fixture-v1" }, async probe() {} }
    const paths = await prepareAigwRuntimeCache(options)
    const markerPath = join(paths.preparedRoot, "genio-one-aigw-cache-v2.json")
    const original = JSON.parse(await readFile(markerPath, "utf8"))
    for (const marker of [{ ...original, schema_version: 1 }, { ...original, envoy_version: "1.39.2" }]) {
      await writeFile(markerPath, JSON.stringify(marker))
      let attempts = 0
      await prepareAigwRuntimeCache({ ...options, async download(input) { attempts += 1; await fixtureEnvoy(input) } })
      assert.equal(attempts, 1)
    }
    await assert.rejects(() => prepareAigwRuntimeCache({
      ...options,
      async version() { return "fixture-v2" },
      async download(input) { await downloadedEnvoy(input, Buffer.from("#!/bin/sh\necho envoy\n"), "1.39.2") },
    }), /did not produce pinned executable/)
    assert.equal(existsSync(paths.preparedRoot), false)
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
})

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
        await fixtureEnvoy(input)
      },
      async version() { return "fixture-v1" },
      async probe() {},
    })
    assert.equal(downloads.length, 1)
    assert.equal(downloads[0]!.timeoutMs, 321_000)
    assert.equal(downloads[0]!.environment.CUSTOM_VALUE, "kept")
    assert.notEqual(downloads[0]!.environment.AIGW_DATA_HOME, "/outside")
    assert.match(downloads[0]!.environment.AIGW_DATA_HOME!, /\/aigw\/staging\/prepare-[^/]+\/prepared\/data$/)
    assert.equal(existsSync(join(first.preparedRoot, "genio-one-aigw-cache-v2.json")), true)

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
          await downloadedEnvoy(input, Buffer.from("incomplete"))
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
        await fixtureEnvoy(input)
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
        await fixtureEnvoy(input)
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
        await fixtureEnvoy(input)
      },
      async version() { return "fixture-v1" },
      async probe() {},
    })
    const marker = JSON.parse(await readFile(join(first.preparedRoot, "genio-one-aigw-cache-v2.json"), "utf8"))
    await writeFile(join(first.dataHome, "envoy-versions", marker.envoy_version, "bin", "envoy"), Buffer.from("incomplete"), { mode: 0o700 })

    let attempts = 0
    await prepareAigwRuntimeCache({
      binary,
      stateRoot,
      async download(input) {
        attempts += 1
        await fixtureEnvoy(input)
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
        async download(input) { await fixtureEnvoy(input) },
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
      async download(input) { await fixtureEnvoy(input) },
      async version() { return "fixture-v1" },
      async probe() {},
    })
    let attempts = 0
    await prepareAigwRuntimeCache({
      binary,
      stateRoot,
      async download(input) {
        attempts += 1
        await fixtureEnvoy(input)
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
