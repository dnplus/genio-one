import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile, chmod } from "node:fs/promises"
import { basename, dirname, join, relative, resolve } from "node:path"
import { tmpdir } from "node:os"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

import { stopProcessTree } from "./process-lifecycle"

const CACHE_MARKER = "genio-one-aigw-cache-v2.json"
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10 * 60_000
const MAX_AIGW_UNIX_SOCKET_PATH_BYTES = 103
const ENVOY_ARCHIVE_ROOT = "https://archive.tetratelabs.io/envoy"

interface AigwCacheMarker {
  schema_version: 2
  aigw_sha256: string
  aigw_version: string
  envoy_version: string
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
  envoyVersion: string
  signal?: AbortSignal
}

export interface AigwEnvoyProbeInput {
  binary: string
  envoyVersion: string
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
  fetch?(url: string, init: RequestInit): Promise<Response>
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

async function pinnedEnvoyVersion(): Promise<string> {
  const versions = await readFile(new URL("../../../apps/platform/config/ai-mcp-gateway/provider-versions.env", import.meta.url), "utf8")
  const version = /^ENVOY_PROXY_VERSION=v(\d+\.\d+\.\d+)$/m.exec(versions)?.[1]
  if (!version) throw new Error("Missing pinned ENVOY_PROXY_VERSION in provider-versions.env")
  return version
}

async function bindEnvoyVersionPreference(paths: AigwRuntimePaths, version: string): Promise<void> {
  await mkdir(paths.configHome, { recursive: true, mode: 0o700 })
  const staging = await mkdtemp(join(paths.configHome, ".envoy-version-"))
  try {
    const preference = join(staging, "envoy-version")
    await writeFile(preference, `${version}\n`, { encoding: "utf8", mode: 0o600 })
    await rename(preference, join(paths.configHome, "envoy-version"))
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function validPreparedCache(paths: AigwRuntimePaths, identity: { sha256: string; version: string }, envoyVersion: string): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(join(paths.preparedRoot, CACHE_MARKER), "utf8")) as AigwCacheMarker
    if (
      marker.schema_version !== 2 ||
      marker.aigw_sha256 !== identity.sha256 ||
      marker.aigw_version !== identity.version ||
      marker.envoy_version !== envoyVersion ||
      typeof marker.binary_path !== "string" ||
      typeof marker.sha256 !== "string" ||
      !Number.isSafeInteger(marker.bytes) || marker.bytes < 5
    ) return false
    const binaryPath = resolve(paths.preparedRoot, marker.binary_path)
    if (!pathInside(binaryPath, paths.preparedRoot) || binaryPath !== join(paths.dataHome, "envoy-versions", envoyVersion, "bin", "envoy")) return false
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
    const child = spawn(input.binary, ["--version"], { stdio: ["ignore", "pipe", "inherit"] })
    let output = ""
    child.stdout?.on("data", (chunk) => { output += String(chunk) })
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
      else if (!output.trim().split(/[\s/]+/).includes(input.envoyVersion)) rejectProbe(new Error(`AIGW Envoy probe did not report pinned version ${input.envoyVersion}`))
      else resolveProbe()
    })
  })
}

async function extractArchive(archive: string, destination: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const child = spawn("tar", ["-xJf", archive, "-C", destination, "--strip-components", "1"], { detached: true, stdio: ["ignore", "ignore", "inherit"] })
  const abort = () => { void stopProcessTree(child).catch(() => undefined) }
  signal.addEventListener("abort", abort, { once: true })
  if (signal.aborted) abort()
  try {
    await new Promise<void>((resolveExtract, rejectExtract) => {
      child.once("error", rejectExtract)
      child.once("exit", (code) => {
        if (signal.aborted) rejectExtract(new Error("AIGW Envoy archive extraction aborted"))
        else if (code !== 0) rejectExtract(new Error(`AIGW Envoy archive extraction exited with code ${code}`))
        else resolveExtract()
      })
    })
  } catch (error) {
    await stopProcessTree(child)
    throw error
  } finally {
    signal.removeEventListener("abort", abort)
  }
}

async function downloadOfficialEnvoy(input: AigwDownloadInput, fetchArchive: (url: string, init: RequestInit) => Promise<Response>): Promise<void> {
  if (input.signal?.aborted) throw new Error("AIGW Envoy download aborted")
  const platform = process.platform === "darwin" || process.platform === "linux" ? process.platform : undefined
  const architecture = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : undefined
  if (!platform || !architecture) throw new Error(`Unsupported Envoy archive platform: ${process.platform}/${process.arch}`)
  const timeout = AbortSignal.timeout(input.timeoutMs)
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
  const archiveName = `envoy-v${input.envoyVersion}-${platform}-${architecture}.tar.xz`
  const archiveUrl = `${ENVOY_ARCHIVE_ROOT}/download/v${input.envoyVersion}/${archiveName}`
  const archivePath = join(dirname(input.environment.AIGW_DATA_HOME!), archiveName)
  try {
    const manifestResponse = await fetchArchive(`${ENVOY_ARCHIVE_ROOT}/envoy-versions.json`, { signal })
    if (!manifestResponse.ok) throw new Error(`Official Envoy catalog lookup failed: HTTP ${manifestResponse.status}`)
    const manifest = await manifestResponse.json() as {
      versions?: Record<string, { tarballs?: Record<string, string> }>
      sha256sums?: Record<string, string>
    }
    const expectedDigest = manifest.sha256sums?.[archiveName]
    if (manifest.versions?.[input.envoyVersion]?.tarballs?.[`${platform}/${architecture}`] !== archiveUrl || typeof expectedDigest !== "string" || !/^[a-f0-9]{64}$/.test(expectedDigest)) {
      throw new Error(`Official Envoy catalog does not publish pinned ${input.envoyVersion} for ${platform}/${architecture} with SHA-256`)
    }
    const response = await fetchArchive(archiveUrl, { signal })
    if (!response.ok || !response.body) throw new Error(`Official Envoy archive download failed: HTTP ${response.status}`)
    await pipeline(Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream), createWriteStream(archivePath, { mode: 0o600 }), { signal })
    if (await sha256(archivePath) !== expectedDigest) throw new Error(`Official Envoy archive SHA-256 mismatch for ${archiveName}`)
    const destination = join(input.environment.AIGW_DATA_HOME!, "envoy-versions", input.envoyVersion)
    await mkdir(destination, { recursive: true, mode: 0o700 })
    await extractArchive(archivePath, destination, signal)
    signal.throwIfAborted()
  } catch (error) {
    if (input.signal?.aborted) throw new Error("AIGW Envoy download aborted")
    if (timeout.aborted) throw new Error(`AIGW Envoy download did not finish within ${input.timeoutMs}ms`)
    throw error
  } finally {
    await rm(archivePath, { force: true })
  }
}

export async function prepareAigwRuntimeCache(options: PrepareAigwRuntimeCacheOptions): Promise<AigwRuntimePaths> {
  const paths = aigwRuntimePaths(options.stateRoot)
  const identity = await aigwIdentity(options)
  const envoyVersion = await pinnedEnvoyVersion()
  if (await validPreparedCache(paths, identity, envoyVersion)) {
    await bindEnvoyVersionPreference(paths, envoyVersion)
    return paths
  }

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
    const download: (input: AigwDownloadInput) => Promise<void> = options.download ?? ((input) => downloadOfficialEnvoy(input, options.fetch ?? fetch))
    await download({
      binary: options.binary,
      environment: aigwRuntimeEnvironment(options.environment, stagedPaths),
      timeoutMs: options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
      envoyVersion,
      signal: options.signal,
    })
    const binaryPath = join(stagedPaths.dataHome, "envoy-versions", envoyVersion, "bin", "envoy")
    const binary = await executableBinary(binaryPath)
    if (!binary) throw new Error(`AIGW Envoy download did not produce pinned executable ${envoyVersion}`)
    await (options.probe ?? probeEnvoy)({ binary: binaryPath, envoyVersion, signal: options.signal })
    if (options.signal?.aborted) throw new Error("AIGW Envoy preparation aborted")
    await writeFile(join(stagedPreparedRoot, CACHE_MARKER), `${JSON.stringify({
      schema_version: 2,
      aigw_sha256: identity.sha256,
      aigw_version: identity.version,
      envoy_version: envoyVersion,
      binary_path: relative(stagedPreparedRoot, binaryPath),
      sha256: binary.sha256,
      bytes: binary.bytes,
    } satisfies AigwCacheMarker)}\n`, { encoding: "utf8", mode: 0o600 })
    await bindEnvoyVersionPreference(paths, envoyVersion)
    await rename(stagedPreparedRoot, paths.preparedRoot)
    return paths
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true })
  }
}
