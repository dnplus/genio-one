#!/usr/bin/env bun

import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { access, chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"

import { parseGatewayBootstrapConfiguration } from "../../../runtimes/gateway/services/shared/gateway-bootstrap"

const defaultAppRoot = resolve(import.meta.dirname, "..")

export function bootstrapPathFromArguments(argumentsList) {
  const values = argumentsList[0] === "--" ? argumentsList.slice(1) : argumentsList
  let bootstrapPath
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === "--bootstrap") {
      if (bootstrapPath || !values[index + 1]) throw new Error("gateway:start:local requires exactly one --bootstrap PATH")
      bootstrapPath = values[index + 1]
      index += 1
      continue
    }
    throw new Error(`Unknown gateway:start:local argument: ${value}`)
  }
  if (!bootstrapPath) throw new Error("gateway:start:local requires --bootstrap PATH from Management UI Register Gateway")
  return bootstrapPath
}

function pathInside(path, directory) {
  const result = relative(directory, path)
  return Boolean(result) && !result.startsWith("..") && !isAbsolute(result)
}

export function localGatewayValkeyOrigin(environment = process.env) {
  const origin = environment.GENIO_ONE_VALKEY_ORIGIN?.trim() || environment.GENIO_ONE_VALKEY_URL?.trim()
  if (!origin) {
    throw new Error("GENIO_ONE_VALKEY_URL is required for gateway:start:local (set it in apps/platform/.env.local)")
  }
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    throw new Error("GENIO_ONE_VALKEY_ORIGIN or GENIO_ONE_VALKEY_URL must be a Redis URL")
  }
  if (!(["redis:", "rediss:"].includes(parsed.protocol)) || !parsed.hostname || parsed.search || parsed.hash) {
    throw new Error("GENIO_ONE_VALKEY_ORIGIN or GENIO_ONE_VALKEY_URL must be a Redis URL without query or fragment")
  }
  return origin
}

export function validatedTokenVaultKey(value, name = "GENIO_ONE_TOKEN_VAULT_KEY") {
  const encoded = value?.trim() ?? ""
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded) || Buffer.from(encoded, "base64").length !== 32) {
    throw new Error(`${name} must be a base64-encoded 32-byte key`)
  }
  return encoded
}

async function existingRegularPrivateFile(path) {
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Local Gateway token vault key must be a regular file: ${path}`)
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new Error(`Local Gateway token vault key must have mode 0600: ${path}`)
  }
}

async function managedPrivateDirectory(path) {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if (error?.code !== "EEXIST") throw error
  }
  const metadata = await lstat(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Local Gateway managed state directory must be a regular directory: ${path}`)
  }
  await chmod(path, 0o700)
}

export async function localGatewayTokenVaultKey(appRoot, environment = process.env) {
  if (environment.GENIO_ONE_TOKEN_VAULT_KEY?.trim()) {
    return validatedTokenVaultKey(environment.GENIO_ONE_TOKEN_VAULT_KEY)
  }
  const localDirectory = resolve(appRoot, ".local")
  const runtimeDirectory = resolve(localDirectory, "gateway-runtime")
  const keysDirectory = resolve(runtimeDirectory, "keys")
  await managedPrivateDirectory(localDirectory)
  await managedPrivateDirectory(runtimeDirectory)
  await managedPrivateDirectory(keysDirectory)
  const keyPath = resolve(keysDirectory, "token-vault.key")
  try {
    await existingRegularPrivateFile(keyPath)
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
    const generated = randomBytes(32).toString("base64")
    try {
      await writeFile(keyPath, generated, { encoding: "utf8", mode: 0o600, flag: "wx" })
    } catch (writeError) {
      if (writeError?.code !== "EEXIST") throw writeError
    }
    await existingRegularPrivateFile(keyPath)
  }
  return validatedTokenVaultKey(await readFile(keyPath, "utf8"), "Local Gateway token vault key")
}

export async function localGatewayStartConfiguration(options = {}) {
  const appRoot = resolve(options.appRoot ?? defaultAppRoot)
  const environment = options.environment ?? process.env
  const bootstrapDirectory = resolve(appRoot, ".local/gateway-bootstrap")
  const requestedBootstrapPath = bootstrapPathFromArguments(options.argumentsList ?? process.argv.slice(2))
  const invocationDirectory = resolve(options.cwd ?? process.env.INIT_CWD ?? process.cwd())
  const bootstrapPath = resolve(invocationDirectory, requestedBootstrapPath)
  if (!pathInside(bootstrapPath, bootstrapDirectory)) {
    throw new Error(`Gateway bootstrap must be saved below ${bootstrapDirectory}`)
  }
  const metadata = await lstat(bootstrapPath)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Gateway bootstrap must be a regular local file")
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new Error(`Gateway bootstrap must have mode 0600: ${bootstrapPath}`)
  }
  const bootstrap = parseGatewayBootstrapConfiguration(JSON.parse(await readFile(bootstrapPath, "utf8")))
  const runtimeId = bootstrap.runtime_id
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(runtimeId)) {
    throw new Error("Gateway bootstrap runtime_id is unsafe for local state")
  }
  const stateRoot = resolve(appRoot, ".local/gateway-runtime", runtimeId)
  const stateBase = resolve(appRoot, ".local/gateway-runtime")
  if (!pathInside(stateRoot, stateBase)) throw new Error("Gateway bootstrap runtime_id is unsafe for local state")
  const aigwBinary = resolve(appRoot, ".local/aigw/current/aigw")
  try {
    await access(aigwBinary, constants.X_OK)
  } catch {
    throw new Error(`Local AIGW binary is unavailable: run pnpm gateway:install:local first (${aigwBinary})`)
  }
  return {
    aigwBinary,
    bootstrapPath,
    controllerPath: resolve(appRoot, "../../runtimes/gateway/controller/server.ts"),
    repositoryRoot: resolve(appRoot, "../.."),
    runtimeId,
    stateRoot,
    valkeyOrigin: localGatewayValkeyOrigin(environment),
    tokenVaultKey: await localGatewayTokenVaultKey(appRoot, environment),
  }
}

export function localGatewayRuntimeEnvironment(configuration, environment = process.env) {
  if (environment.GENIO_ONE_RUNTIME_TOKEN?.trim()) {
    throw new Error("GENIO_ONE_RUNTIME_TOKEN is not accepted by gateway:start:local; use the OIDC bootstrap from Register Gateway")
  }
  return {
    ...environment,
    GENIO_ONE_GATEWAY_APPLY_MODE: "LOCAL_AIGW",
    GENIO_ONE_GATEWAY_BOOTSTRAP_FILE: configuration.bootstrapPath,
    GENIO_ONE_AIGW_BINARY: configuration.aigwBinary,
    GENIO_ONE_GATEWAY_RUNTIME_STATE: configuration.stateRoot,
    GENIO_ONE_VALKEY_ORIGIN: configuration.valkeyOrigin,
    GENIO_ONE_TOKEN_VAULT_KEY: configuration.tokenVaultKey,
  }
}

export function forwardRuntimeSignal(child, signal) {
  if (child.exitCode === null) child.kill(signal)
}

export async function startLocalGateway(options = {}) {
  const configuration = await localGatewayStartConfiguration(options)
  const environment = localGatewayRuntimeEnvironment(configuration, options.environment)
  const spawnImplementation = options.spawnImplementation ?? spawn
  await new Promise((resolveStart, rejectStart) => {
    const child = spawnImplementation(process.execPath, [configuration.controllerPath], {
      cwd: configuration.repositoryRoot,
      env: environment,
      stdio: "inherit",
    })
    const forwardInterrupt = () => forwardRuntimeSignal(child, "SIGINT")
    const forwardTermination = () => forwardRuntimeSignal(child, "SIGTERM")
    process.once("SIGINT", forwardInterrupt)
    process.once("SIGTERM", forwardTermination)
    const removeSignalListeners = () => {
      process.removeListener("SIGINT", forwardInterrupt)
      process.removeListener("SIGTERM", forwardTermination)
    }
    child.once("error", (error) => {
      removeSignalListeners()
      rejectStart(error)
    })
    child.once("exit", (code, signal) => {
      removeSignalListeners()
      code === 0
        ? resolveStart()
        : rejectStart(new Error(`Gateway Runtime exited with ${code ?? `signal ${signal ?? "unknown"}`}`))
    })
  })
}

if (import.meta.main) await startLocalGateway()
