import { spawn, spawnSync } from "node:child_process"
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs"
import { createConnection } from "node:net"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { cleanLocalDev } from "./local-dev-clean.mjs"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const platformDir = resolve(root, "apps/platform")
const botDir = resolve(root, "apps/bot")
const signingKeyDir = resolve(platformDir, ".local/gateway-runtime/keys")
const localPlatformOrigin = "http://127.0.0.1:58082"
const localBotServiceEndpoint = "http://127.0.0.1:5181"
const localRuntimeReportKeyId = "local-bot-runtime-report"

const services = [
  {
    name: "platform-api",
    url: "http://127.0.0.1:58082/healthz",
    port: 58082,
    cwd: platformDir,
    args: ["dev:api"],
    marker: "platform-api/src/server.ts",
    healthy(body) {
      return body?.status === "ok" && body?.component === "genio-one-platform-api" && body?.api_mode === "postgres"
    },
    stale(body) {
      return body?.component === "genio-one-platform-api" && body?.api_mode !== "postgres"
    },
    env: {
      GENIO_ONE_PLATFORM_API_MODE: "postgres",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:54320",
      GENIO_ONE_PLATFORM_ORIGIN: localPlatformOrigin,
      GENIO_BOT_SERVICE_ENDPOINT: localBotServiceEndpoint,
    },
  },
  {
    name: "platform-web",
    url: "http://127.0.0.1:5173/management",
    port: 5173,
    cwd: platformDir,
    args: ["dev:web"],
    marker: "vite",
    healthy(body, response) {
      return response.ok && typeof body === "string" && body.includes("root")
    },
    stale() {
      return false
    },
    env: { GENIO_ONE_PLATFORM_ORIGIN: localPlatformOrigin },
  },
  {
    name: "bot-server",
    url: "http://127.0.0.1:5181/api/runtime",
    port: 5181,
    cwd: botDir,
    args: ["dev:server"],
    marker: "server/index.ts",
    healthy(body) {
      return body?.configured === "local" && body?.capabilityGate === "control-plane" && body?.modelDirectory === "one-policy"
    },
    stale(body) {
      return body && !(
        body.configured === "local" && body.capabilityGate === "control-plane" && body.modelDirectory === "one-policy"
      )
    },
    env: {
      GENIO_BOT_RUNTIME: "local",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:54320",
      GENIO_ONE_PLATFORM_ORIGIN: localPlatformOrigin,
    },
  },
  {
    name: "bot-web",
    url: "http://127.0.0.1:5180/",
    port: 5180,
    cwd: botDir,
    args: ["dev:web"],
    marker: "vite",
    healthy(body, response) {
      return response.ok && typeof body === "string" && body.includes("root")
    },
    stale() {
      return false
    },
    env: { GENIO_ONE_PLATFORM_ORIGIN: localPlatformOrigin },
  },
]

const startupServiceNames = ["bot-server", "platform-api", "platform-web", "bot-web"]

const children = new Map()
let stopping = false
let keepAlive

function ensureSigningKeys() {
  mkdirSync(signingKeyDir, { recursive: true })
  for (const name of ["projection", "runtime-command", "policy-artifact", "release-root", "runtime-report"]) {
    const privateKeyPath = resolve(signingKeyDir, `${name}.pem`)
    const publicKeyPath = resolve(signingKeyDir, `${name}.pub.pem`)
    if (existsSync(privateKeyPath) && existsSync(publicKeyPath)) continue
    if (existsSync(privateKeyPath)) {
      const publicKey = createPublicKey(createPrivateKey(readFileSync(privateKeyPath)))
      writeFileSync(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 })
      continue
    }
    const { privateKey, publicKey } = generateKeyPairSync("ed25519")
    writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 })
    writeFileSync(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 })
  }
}

export function runtimePolicyReportEnvironment(serviceName, privateKeyPem, publicKeyPem) {
  if (serviceName === "platform-api") {
    return {
      GENIO_ONE_RUNTIME_REPORT_KEY_ID: localRuntimeReportKeyId,
      GENIO_ONE_RUNTIME_REPORT_PUBLIC_KEY_PEM: publicKeyPem,
    }
  }
  if (serviceName === "bot-server") {
    return {
      GENIO_ONE_RUNTIME_REPORT_KEY_ID: localRuntimeReportKeyId,
      GENIO_ONE_RUNTIME_REPORT_PRIVATE_KEY_PEM: privateKeyPem,
    }
  }
  return {}
}

function serviceEnvironment(service) {
  const runtimeReport = service.name === "platform-api" || service.name === "bot-server"
    ? runtimePolicyReportEnvironment(
      service.name,
      readFileSync(resolve(signingKeyDir, "runtime-report.pem"), "utf8"),
      readFileSync(resolve(signingKeyDir, "runtime-report.pub.pem"), "utf8"),
    )
    : {}
  if (service.name === "platform-api") {
    return {
      ...service.env,
      ...runtimeReport,
      GENIO_ONE_GATEWAY_SIGNING_PRIVATE_KEY_FILE: resolve(signingKeyDir, "projection.pem"),
      GENIO_ONE_RUNTIME_COMMAND_SIGNING_PRIVATE_KEY_FILE: resolve(signingKeyDir, "runtime-command.pem"),
      GENIO_ONE_POLICY_ARTIFACT_SIGNING_PRIVATE_KEY_FILE: resolve(signingKeyDir, "policy-artifact.pem"),
      GENIO_ONE_RELEASE_ROOT_SIGNING_PRIVATE_KEY_FILE: resolve(signingKeyDir, "release-root.pem"),
    }
  }
  return { ...service.env, ...runtimeReport }
}

async function probe(service) {
  try {
    const response = await fetch(service.url, { signal: AbortSignal.timeout(800) })
    const text = await response.text()
    let body = text
    try {
      body = JSON.parse(text)
    } catch {}
    return { response, body }
  } catch {
    return null
  }
}

function portOwners(port) {
  const lsof = spawnSync("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN", "-n", "-P"], { encoding: "utf8" })
  const lsofOwners = lsof.status === 0
    ? lsof.stdout.trim().split(/\s+/).filter((value) => /^\d+$/.test(value))
    : []
  if (lsofOwners.length > 0) return [...new Set(lsofOwners)]

  // lsof is not installed on every supported local development host. ss is
  // available on current Linux distributions and exposes the listener PID.
  const ss = spawnSync("ss", ["-ltnp", `sport = :${port}`], { encoding: "utf8" })
  const ssOutput = typeof ss.stdout === "string" ? ss.stdout : ""
  const ssOwners = [...ssOutput.matchAll(/pid=(\d+)/g)].map((match) => match[1])
  if (ssOwners.length > 0) return [...new Set(ssOwners)]

  // fuser is the portability fallback for smaller Linux images without ss.
  const fuser = spawnSync("fuser", ["-n", "tcp", String(port)], { encoding: "utf8" })
  if (fuser.status !== 0 || typeof fuser.stdout !== "string") return []
  return [...new Set(fuser.stdout.match(/\b\d+\b/g)?.filter((value) => value !== String(port)) ?? [])]
}

function processCommand(pid) {
  const result = spawnSync("ps", ["-p", pid, "-o", "command="], { encoding: "utf8" })
  return result.status === 0 ? result.stdout.trim() : ""
}

function processCwd(pid) {
  try {
    return readlinkSync(`/proc/${pid}/cwd`)
  } catch {
    const result = spawnSync("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"], { encoding: "utf8" })
    const path = typeof result.stdout === "string"
      ? result.stdout.split(/\r?\n/).find((line) => line.startsWith("n"))?.slice(1)
      : ""
    return path ?? ""
  }
}

function portIsOccupied(port) {
  return new Promise((resolveOccupied) => {
    const socket = createConnection({ host: "127.0.0.1", port })
    const finish = (occupied) => {
      socket.destroy()
      resolveOccupied(occupied)
    }
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
    socket.setTimeout(300, () => finish(false))
  })
}

export function serviceOwnerMatches(service, owner) {
  return owner.cwd === service.cwd && owner.command.includes(service.marker)
}

function serviceOwners(service) {
  return portOwners(service.port).map((pid) => ({
    pid,
    cwd: processCwd(pid),
    command: processCommand(pid),
  }))
}

function assertServiceOwners(service, owners) {
  if (owners.length === 0) {
    throw new Error(`${service.name} port ${service.port} is listening but its PID, cwd, and command could not be verified`)
  }
  const unrelated = owners.filter((owner) => !serviceOwnerMatches(service, owner))
  if (unrelated.length > 0) {
    throw new Error(`${service.name} port ${service.port} is occupied by a process outside this checkout: ${unrelated.map((owner) => `${owner.pid} cwd=${owner.cwd || "unknown"} command=${owner.command || "unknown"}`).join("; ")}`)
  }
}

async function waitForPortFree(port) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!(await portIsOccupied(port))) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error(`Port ${port} did not become available`)
}

async function stopStale(service) {
  const owners = serviceOwners(service)
  if (owners.length === 0) {
    if (await portIsOccupied(service.port)) assertServiceOwners(service, owners)
    return
  }
  assertServiceOwners(service, owners)
  for (const { pid } of owners) process.kill(Number(pid), "SIGTERM")
  await waitForPortFree(service.port)
}

function spawnService(service) {
  if (stopping) return false
  const child = spawn("pnpm", service.args, {
    cwd: service.cwd,
    env: { ...process.env, ...serviceEnvironment(service) },
    stdio: "inherit",
  })
  children.set(service.name, child)
  watchServiceExit(child, service)
  process.stdout.write(`${JSON.stringify({ event: "local-dev.service-started", service: service.name, port: service.port })}\n`)
  return true
}

export function watchServiceExit(child, service, {
  isStopping = () => stopping,
  report = (event) => process.stderr.write(`${JSON.stringify(event)}\n`),
  onUnexpectedExit = (exitCode) => shutdown(exitCode),
} = {}) {
  child.once("exit", (code, signal) => {
    children.delete(service.name)
    if (isStopping()) return
    const supervisorExitCode = typeof code === "number" && code !== 0 ? code : 1
    report({ event: "local-dev.service-exit", service: service.name, code, signal })
    void onUnexpectedExit(supervisorExitCode)
  })
}

export async function waitForHealthy(service, { isStopping = () => stopping } = {}) {
  const timeoutMs = service.healthTimeoutMs ?? 60_000
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  let lastProbe = "no response"
  while (Date.now() < deadline) {
    if (isStopping()) return false
    const result = await probe(service)
    if (isStopping()) return false
    if (result && service.healthy(result.body, result.response)) return true
    if (!result) lastProbe = "connection failed"
    else if (result.response) lastProbe = `HTTP ${result.response.status}`
    const remainingMs = deadline - Date.now()
    if (remainingMs > 0) await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(500, remainingMs)))
  }
  const elapsedSeconds = ((Date.now() - startedAt) / 1_000).toFixed(1)
  throw new Error(`${service.name ?? "service"} did not become healthy on port ${service.port} after ${elapsedSeconds}s (timeout ${timeoutMs / 1_000}s; last probe: ${lastProbe})`)
}

async function ensureService(service) {
  if (stopping) return false
  const result = await probe(service)
  if (stopping) return false
  const occupied = await portIsOccupied(service.port)
  if (stopping) return false
  const owners = serviceOwners(service)
  if (result && service.healthy(result.body, result.response)) {
    assertServiceOwners(service, owners)
    process.stdout.write(`${JSON.stringify({ event: "local-dev.service-existing", service: service.name, port: service.port })}\n`)
    return true
  }
  if (result && service.stale(result.body, result.response)) {
    await stopStale(service)
    if (stopping) return false
    process.stdout.write(`${JSON.stringify({ event: "local-dev.service-stale-restarted", service: service.name, port: service.port })}\n`)
  } else if (occupied) {
    assertServiceOwners(service, owners)
    throw new Error(`${service.name} port ${service.port} is occupied but does not expose the expected health contract`)
  }
  if (!spawnService(service)) return false
  return waitForHealthy(service)
}

async function runCommand(command, args, cwd) {
  await new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: "inherit" })
    child.once("error", rejectCommand)
    child.once("exit", (code, signal) => code === 0
      ? resolveCommand()
      : rejectCommand(new Error(`${command} ${args.join(" ")} exited with ${code ?? `signal ${signal ?? "unknown"}`}`)))
  })
}

async function ensureIdentity() {
  if (stopping) return false
  const identity = await probe({ url: "http://127.0.0.1:58080/realms/genio-one/.well-known/openid-configuration" })
  if (stopping) return false
  if (identity?.response.ok) {
    process.stdout.write(`${JSON.stringify({ event: "local-dev.service-existing", service: "keycloak", port: 58080 })}\n`)
    return true
  }
  if (!existsSync(resolve(platformDir, ".env.local"))) throw new Error("apps/platform/.env.local is required for local identity startup")
  await runCommand("pnpm", ["env:up:identity"], platformDir)
  const healthy = await waitForHealthy({
    name: "keycloak",
    url: "http://127.0.0.1:58080/realms/genio-one/.well-known/openid-configuration",
    port: 58080,
    healthTimeoutMs: 90_000,
    healthy(_body, response) { return response.ok },
  })
  if (!healthy) return false
  process.stdout.write(`${JSON.stringify({ event: "local-dev.service-started", service: "keycloak", port: 58080 })}\n`)
  return true
}

async function shutdown(code = 0) {
  if (stopping) return
  stopping = true
  if (keepAlive) clearInterval(keepAlive)
  for (const child of children.values()) child.kill("SIGTERM")
  await new Promise((resolveWait) => setTimeout(resolveWait, 300))
  process.exitCode = code
}

async function main() {
  if (stopping) return
  ensureSigningKeys()
  if (!(await ensureIdentity()) || stopping) return
  await runCommand("pnpm", ["env:up:analytics"], platformDir)
  if (stopping) return
  for (const name of startupServiceNames.slice(0, 2)) {
    if (!(await ensureService(services.find((service) => service.name === name))) || stopping) return
  }
  const started = await Promise.all(startupServiceNames.slice(2).map((name) =>
    ensureService(services.find((service) => service.name === name)),
  ))
  if (stopping || started.some((value) => !value)) return
  process.stdout.write(`${JSON.stringify({ event: "local-dev.ready", services: services.map((service) => service.name), origins: { platform: "http://127.0.0.1:5173/management", bot: "http://127.0.0.1:5180/" } })}\n`)
  keepAlive = setInterval(() => {}, 60_000)
  await new Promise(() => {})
}

async function commandMain() {
  if (process.argv.slice(2).includes("clean")) return cleanLocalDev()
  return main()
}

process.once("SIGINT", () => void shutdown())
process.once("SIGTERM", () => void shutdown())

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  commandMain().catch(async (error) => {
    process.stderr.write(`${JSON.stringify({ event: "local-dev.failed", message: error instanceof Error ? error.message : String(error) })}\n`)
    await shutdown(1)
  })
}

export { ensureIdentity, ensureService, probe, services, startupServiceNames }
