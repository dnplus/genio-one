import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile, chmod } from "node:fs/promises"
import { basename, dirname, join, relative, resolve } from "node:path"
import { tmpdir } from "node:os"

const CACHE_MARKER = "genio-one-aigw-cache-v1.json"
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10 * 60_000
const MAX_AIGW_UNIX_SOCKET_PATH_BYTES = 103

interface AigwCacheMarker {
  schema_version: 1
  aigw_sha256: string
  aigw_version: string
  binary_path: string
  sha256: string
  bytes: number
}

export interface AigwRuntimePaths {
  root: string
  preparedRoot: string
  configHome: string
  dataHome: string
  stateHome: string
  runtimeDirectory: string
}

export interface AigwEphemeralRuntimeDirectory {
  directory: string
  prefix: string
}

export interface AigwDownloadInput {
  binary: string
  environment: NodeJS.ProcessEnv
  timeoutMs: number
  signal?: AbortSignal
}

export interface AigwEnvoyProbeInput {
  binary: string
  signal?: AbortSignal
}

export interface PrepareAigwRuntimeCacheOptions {
  binary: string
  stateRoot: string
  environment?: NodeJS.ProcessEnv
  timeoutMs?: number
  signal?: AbortSignal
  download?(input: AigwDownloadInput): Promise<void>
  version?(binary: string, signal?: AbortSignal): Promise<string>
  probe?(input: AigwEnvoyProbeInput): Promise<void>
}

function pathInside(path: string, directory: string): boolean {
  const result = relative(directory, path)
  return Boolean(result) && !result.startsWith("..") && !result.includes(`..${process.platform === "win32" ? "\\" : "/"}`)
}

export function aigwRuntimePaths(stateRoot: string): AigwRuntimePaths {
  const root = resolve(stateRoot, "aigw")
  const preparedRoot = join(root, "prepared")
  return {
    root,
    preparedRoot,
    configHome: join(root, "config"),
    dataHome: join(preparedRoot, "data"),
    stateHome: join(root, "state"),
    runtimeDirectory: join(root, "run"),
  }
}

function temporaryRuntimeRoot(): string {
  return process.platform === "win32" ? tmpdir() : "/tmp"
}

function runtimeDirectoryPrefix(stateRoot: string): string {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user"
  const stateHash = createHash("sha256").update(resolve(stateRoot)).digest("hex").slice(0, 10)
  return `g1ag-${uid}-${stateHash}-`
}

function assertOwnedRuntimeDirectory(
  directory: string,
  prefix: string,
): Promise<void> {
  return lstat(directory).then(async (metadata) => {
    const owner = typeof process.getuid === "function" ? process.getuid() : undefined
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (owner !== undefined && metadata.uid !== owner) ||
      resolve(dirname(directory)) !== resolve(temporaryRuntimeRoot()) ||
      !basename(directory).startsWith(prefix)
    ) {
      throw new Error("AIGW ephemeral runtime directory is not an owned private directory")
    }
    await chmod(directory, 0o700)
  })
}

/**
 * AIGW appends `<run-id>/uds.sock` below this directory. Keep it outside a
 * checkout so macOS/Linux Unix-domain socket limits cannot depend on workspace
 * depth. mkdtemp provides a unique, runtime-owned directory for one child.
 */
export async function createAigwEphemeralRuntimeDirectory(
  stateRoot: string,
  runId: string,
): Promise<AigwEphemeralRuntimeDirectory> {
  const root = temporaryRuntimeRoot()
  const prefix = runtimeDirectoryPrefix(stateRoot)
  const directory = await mkdtemp(join(root, prefix))
  await assertOwnedRuntimeDirectory(directory, prefix)
  const socketPath = join(directory, runId, "uds.sock")
  if (Buffer.byteLength(socketPath) > MAX_AIGW_UNIX_SOCKET_PATH_BYTES) {
    await rm(directory, { recursive: true, force: true })
    throw new Error("AIGW Unix socket path exceeds the portable 103-byte limit")
  }
  return { directory, prefix }
}

/** Remove only an exact ephemeral directory produced for this runtime. */
export async function removeAigwEphemeralRuntimeDirectory(
  runtimeDirectory: AigwEphemeralRuntimeDirectory,
): Promise<void> {
  await assertOwnedRuntimeDirectory(runtimeDirectory.directory, runtimeDirectory.prefix)
  await rm(runtimeDirectory.directory, { recursive: true, force: true })
}

/** Run IDs form a Unix socket path, so keep release identity compact. */
export function aigwEphemeralRunId(headRevision: number): string {
  if (!Number.isSafeInteger(headRevision) || headRevision < 0) {
    throw new Error("AIGW release revision must be a non-negative safe integer")
  }
  return `r${headRevision.toString(36)}`
}

export function aigwRuntimeEnvironment(
  environment: NodeJS.ProcessEnv | undefined,
  paths: AigwRuntimePaths,
  runtimeDirectory = paths.runtimeDirectory,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...environment,
    AIGW_CONFIG_HOME: paths.configHome,
    AIGW_DATA_HOME: paths.dataHome,
    AIGW_STATE_HOME: paths.stateHome,
    AIGW_RUNTIME_DIR: runtimeDirectory,
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

async function executableBinary(path: string): Promise<{ sha256: string; bytes: number } | null> {
  try {
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o111) === 0 || metadata.size < 1) return null
    return { sha256: await sha256(path), bytes: metadata.size }
  } catch {
    return null
  }
}

async function stagedEnvoyBinary(dataHome: string): Promise<string | null> {
  const versionRoot = join(dataHome, "envoy-versions")
  let versions: string[]
  try {
    versions = await readdir(versionRoot)
  } catch {
    return null
  }
  const candidates = await Promise.all(versions.map(async (version) => {
    const candidate = join(versionRoot, version, "bin", "envoy")
    return await executableBinary(candidate) ? candidate : null
  }))
  const binaries = candidates.filter((candidate): candidate is string => candidate !== null)
  return binaries.length === 1 ? binaries[0]! : null
}

async function validPreparedCache(paths: AigwRuntimePaths, identity: { sha256: string; version: string }): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(join(paths.preparedRoot, CACHE_MARKER), "utf8")) as AigwCacheMarker
    if (
      marker.schema_version !== 1 ||
      marker.aigw_sha256 !== identity.sha256 ||
      marker.aigw_version !== identity.version ||
      typeof marker.binary_path !== "string" ||
      typeof marker.sha256 !== "string" ||
      !Number.isSafeInteger(marker.bytes) || marker.bytes < 5
    ) return false
    const binaryPath = resolve(paths.preparedRoot, marker.binary_path)
    if (!pathInside(binaryPath, paths.preparedRoot)) return false
    const binary = await executableBinary(binaryPath)
    return binary !== null && binary.bytes === marker.bytes && binary.sha256 === marker.sha256
  } catch {
    return false
  }
}

async function aigwVersion(binary: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new Error("AIGW version probe aborted")
  return await new Promise<string>((resolveVersion, rejectVersion) => {
    const child = spawn(binary, ["version"], { stdio: ["ignore", "pipe", "inherit"] })
    let output = ""
    let forceKill: ReturnType<typeof setTimeout> | undefined
    const timeout = setTimeout(() => {
      child.kill("SIGTERM")
      forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000)
    }, 10_000)
    const abort = () => {
      child.kill("SIGTERM")
      forceKill ??= setTimeout(() => child.kill("SIGKILL"), 5_000)
    }
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
    child.stdout?.on("data", (chunk) => { output += String(chunk) })
    child.once("error", (error) => {
      clearTimeout(timeout)
      if (forceKill) clearTimeout(forceKill)
      signal?.removeEventListener("abort", abort)
      rejectVersion(error)
    })
    child.once("exit", (code) => {
      const version = output.trim()
      clearTimeout(timeout)
      if (forceKill) clearTimeout(forceKill)
      signal?.removeEventListener("abort", abort)
      if (signal?.aborted) {
        rejectVersion(new Error("AIGW version probe aborted"))
      } else if (code !== 0 || !version || version.length > 256) {
        rejectVersion(new Error(`Unable to read AIGW version${code === 0 ? "" : ` (code ${code})`}`))
      } else {
        resolveVersion(version)
      }
    })
  })
}

async function aigwIdentity(options: PrepareAigwRuntimeCacheOptions): Promise<{ sha256: string; version: string }> {
  const metadata = await lstat(options.binary)
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o111) === 0) {
    throw new Error("AIGW binary must be an executable regular file")
  }
  return {
    sha256: await sha256(options.binary),
    version: await (options.version ?? aigwVersion)(options.binary, options.signal),
  }
}

async function probeEnvoy(input: AigwEnvoyProbeInput): Promise<void> {
  if (input.signal?.aborted) throw new Error("AIGW Envoy probe aborted")
  await new Promise<void>((resolveProbe, rejectProbe) => {
    const child = spawn(input.binary, ["--version"], { stdio: ["ignore", "ignore", "inherit"] })
    let forceKill: ReturnType<typeof setTimeout> | undefined
    const terminate = () => {
      child.kill("SIGTERM")
      forceKill ??= setTimeout(() => child.kill("SIGKILL"), 5_000)
    }
    const timeout = setTimeout(terminate, 10_000)
    const abort = terminate
    input.signal?.addEventListener("abort", abort, { once: true })
    if (input.signal?.aborted) abort()
    child.once("error", (error) => {
      clearTimeout(timeout)
      if (forceKill) clearTimeout(forceKill)
      input.signal?.removeEventListener("abort", abort)
      rejectProbe(error)
    })
    child.once("exit", (code, signal) => {
      clearTimeout(timeout)
      if (forceKill) clearTimeout(forceKill)
      input.signal?.removeEventListener("abort", abort)
      if (input.signal?.aborted) rejectProbe(new Error("AIGW Envoy probe aborted"))
      else if (code !== 0) rejectProbe(new Error(`AIGW Envoy probe exited with ${signal ?? `code ${code}`}`))
      else resolveProbe()
    })
  })
}

async function runOfficialDownload(input: AigwDownloadInput): Promise<void> {
  if (input.signal?.aborted) throw new Error("AIGW Envoy download aborted")
  await new Promise<void>((resolveDownload, rejectDownload) => {
    const child = spawn(input.binary, ["download-envoy"], { env: input.environment, stdio: "inherit" })
    let settled = false
    let timedOut = false
    let aborted = false
    let forceKill: ReturnType<typeof setTimeout> | undefined
    let abort: () => void = () => undefined
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (forceKill) clearTimeout(forceKill)
      input.signal?.removeEventListener("abort", abort)
      if (error) rejectDownload(error)
      else resolveDownload()
    }
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      forceKill = setTimeout(() => {
        child.kill("SIGKILL")
      }, 5_000)
    }, input.timeoutMs)
    abort = () => {
      aborted = true
      child.kill("SIGTERM")
      forceKill ??= setTimeout(() => child.kill("SIGKILL"), 5_000)
    }
    input.signal?.addEventListener("abort", abort, { once: true })
    if (input.signal?.aborted) abort()
    child.once("error", (error) => {
      finish(error)
    })
    child.once("exit", (code, signal) => {
      if (aborted) {
        finish(new Error("AIGW Envoy download aborted"))
      } else if (timedOut) {
        finish(new Error(`AIGW Envoy download did not finish within ${input.timeoutMs}ms`))
      } else if (code !== 0) {
        finish(new Error(`AIGW Envoy download exited with ${signal ?? `code ${code}`}`))
      } else {
        finish()
      }
    })
  })
}

/**
 * Prepares a runtime-owned Envoy cache through the official AIGW CLI. The
 * cache is only adopted after the native command has succeeded and its Envoy
 * binary is marked with a verified size and digest.
 */
export async function prepareAigwRuntimeCache(options: PrepareAigwRuntimeCacheOptions): Promise<AigwRuntimePaths> {
  const paths = aigwRuntimePaths(options.stateRoot)
  const identity = await aigwIdentity(options)
  if (await validPreparedCache(paths, identity)) return paths

  const stagingRoot = join(paths.root, "staging")
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 })
  await rm(paths.preparedRoot, { recursive: true, force: true })
  const stagingDirectory = await mkdtemp(join(stagingRoot, "prepare-"))
  const stagedPreparedRoot = join(stagingDirectory, "prepared")
  const stagedPaths = {
    ...paths,
    preparedRoot: stagedPreparedRoot,
    configHome: join(stagingDirectory, "config"),
    dataHome: join(stagedPreparedRoot, "data"),
    stateHome: join(stagingDirectory, "state"),
    runtimeDirectory: join(stagingDirectory, "run"),
  }
  try {
    await Promise.all([
      mkdir(stagedPaths.configHome, { recursive: true, mode: 0o700 }),
      mkdir(stagedPaths.dataHome, { recursive: true, mode: 0o700 }),
      mkdir(stagedPaths.stateHome, { recursive: true, mode: 0o700 }),
      mkdir(stagedPaths.runtimeDirectory, { recursive: true, mode: 0o700 }),
    ])
    await (options.download ?? runOfficialDownload)({
      binary: options.binary,
      environment: aigwRuntimeEnvironment(options.environment, stagedPaths),
      timeoutMs: options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
      signal: options.signal,
    })
    const binaryPath = await stagedEnvoyBinary(stagedPaths.dataHome)
    if (!binaryPath) throw new Error("AIGW Envoy download did not produce exactly one executable Envoy binary")
    const binary = await executableBinary(binaryPath)
    if (!binary) throw new Error("AIGW Envoy binary failed integrity validation")
    await (options.probe ?? probeEnvoy)({ binary: binaryPath, signal: options.signal })
    await writeFile(join(stagedPreparedRoot, CACHE_MARKER), `${JSON.stringify({
      schema_version: 1,
      aigw_sha256: identity.sha256,
      aigw_version: identity.version,
      binary_path: relative(stagedPreparedRoot, binaryPath),
      sha256: binary.sha256,
      bytes: binary.bytes,
    } satisfies AigwCacheMarker)}\n`, { encoding: "utf8", mode: 0o600 })
    await rename(stagedPreparedRoot, paths.preparedRoot)
    return paths
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true })
  }
}
