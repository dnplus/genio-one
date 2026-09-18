#!/usr/bin/env bun

import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { chmod, lstat, mkdir, readFile, rename, stat, symlink, unlink } from "node:fs/promises"
import { arch, platform } from "node:os"
import { join, resolve } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

const defaultAppRoot = resolve(import.meta.dirname, "..")

export function envoyAigwVersion(versions) {
  const version = versions.match(/^ENVOY_AI_GATEWAY_VERSION=(v[^\s]+)$/m)?.[1]
  if (!version) throw new Error("Missing ENVOY_AI_GATEWAY_VERSION in provider-versions.env")
  return version
}

function releaseTarget(os, cpu) {
  const releasePlatform = { darwin: "darwin", linux: "linux" }[os]
  const releaseArch = { arm64: "arm64", x64: "amd64" }[cpu]
  if (!releasePlatform || !releaseArch) throw new Error(`Unsupported platform: ${os} ${cpu}`)
  return `aigw-${releasePlatform}-${releaseArch}`
}

async function sha256(path) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

async function validInstalledBinary(path, expectedDigest) {
  try {
    return (await stat(path)).isFile() && await sha256(path) === expectedDigest
  } catch {
    return false
  }
}

async function updateCurrentPointer(installBase, version) {
  const currentDirectory = join(installBase, "current")
  try {
    const existing = await lstat(currentDirectory)
    if (!existing.isSymbolicLink()) {
      throw new Error(`Refusing to replace non-symlink local AIGW pointer: ${currentDirectory}`)
    }
    await unlink(currentDirectory)
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  await symlink(version, currentDirectory, "dir")
}

/**
 * Installs the exact AIGW version pinned by the runtime's provider versions.
 * The GitHub asset digest is checked before a binary enters the ignored cache.
 */
export async function installLocalAigw(options = {}) {
  const appRoot = resolve(options.appRoot ?? defaultAppRoot)
  const versionsPath = resolve(options.versionsPath ?? join(appRoot, "config/ai-mcp-gateway/provider-versions.env"))
  const version = envoyAigwVersion(await readFile(versionsPath, "utf8"))
  const assetName = releaseTarget(options.platform ?? platform(), options.arch ?? arch())
  const fetchImplementation = options.fetchImplementation ?? fetch
  const installBase = resolve(appRoot, ".local/aigw")
  const installDirectory = resolve(installBase, version)
  const binaryPath = resolve(installDirectory, "aigw")

  const releaseResponse = await fetchImplementation(
    `https://api.github.com/repos/envoyproxy/ai-gateway/releases/tags/${version}`,
    { headers: { Accept: "application/vnd.github+json" } },
  )
  if (!releaseResponse.ok) throw new Error(`GitHub release lookup failed: HTTP ${releaseResponse.status}`)
  const release = await releaseResponse.json()
  const asset = release.assets?.find((candidate) => candidate.name === assetName)
  if (!asset?.browser_download_url || !asset.digest?.startsWith("sha256:")) {
    throw new Error(`Release ${version} does not publish ${assetName} with a SHA-256 digest`)
  }
  const expectedDigest = asset.digest.slice("sha256:".length)

  await mkdir(installDirectory, { recursive: true })
  if (!(await validInstalledBinary(binaryPath, expectedDigest))) {
    const temporaryPath = `${binaryPath}.download`
    await unlink(temporaryPath).catch(() => undefined)
    const downloadResponse = await fetchImplementation(asset.browser_download_url)
    if (!downloadResponse.ok || !downloadResponse.body) {
      throw new Error(`AIGW download failed: HTTP ${downloadResponse.status}`)
    }
    await pipeline(Readable.fromWeb(downloadResponse.body), createWriteStream(temporaryPath))
    const actualDigest = await sha256(temporaryPath)
    if (actualDigest !== expectedDigest) {
      await unlink(temporaryPath).catch(() => undefined)
      throw new Error(`Digest mismatch for ${assetName}: expected ${expectedDigest}, got ${actualDigest}`)
    }
    await chmod(temporaryPath, 0o755)
    await rename(temporaryPath, binaryPath)
  }

  await updateCurrentPointer(installBase, version)
  return { binaryPath, version, assetName }
}

if (import.meta.main) {
  const installed = await installLocalAigw()
  console.log(installed.binaryPath)
}
