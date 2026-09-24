import { spawn, spawnSync } from "node:child_process"
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { cleanLocalDev } from "./local-dev-clean.mjs"
import {
  createDistillationTriageHandoff,
  parseDistillationTriageHandoff,
  readDistillationTriageHandoff,
  removeDistillationTriageHandoff,
} from "../runtimes/gateway/controller/local-distillation-triage-handoff.mjs"
import {
  distillationPortRole,
  listeningPortOwners,
  portIsOccupied,
  portOwnerRevalidation,
  processCommand,
  processCwd,
} from "../runtimes/gateway/controller/local-port-owner.mjs"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const platformDir = resolve(root, "apps/platform")
const botDir = resolve(root, "apps/bot")
const gatewayDir = resolve(root, "runtimes/gateway")
const signingKeyDir = resolve(platformDir, ".local/gateway-runtime/keys")
const distillationLaunchConfigurationPath = resolve(platformDir, ".local/gateway-runtime/distillation-launch-configuration")
const processorAdapterCredentialNames = "GENIO_ONE_PROCESSOR_ADAPTER_CREDENTIAL_ENV_NAMES"

export function configureDistillationLaunch(serviceList, startupNames, env, fileExists) {
  const configuredFile = typeof env.GENIO_ONE_PROCESSOR_ADAPTERS_FILE === "string" ? env.GENIO_ONE_PROCESSOR_ADAPTERS_FILE.trim() : ""
  const file = configuredFile ? resolve(gatewayDir, configuredFile) : ""
  const enabled = Boolean(file) && fileExists(file)
  const bot = serviceList.find((service) => service.name === "bot-server")
  const triage = serviceList.find((service) => service.name === "distillation-triage")
  const platform = serviceList.find((service) => service.name === "platform-api")
  // Platform starts from apps/platform, so a relative adapter path must reach it already resolved.
  if (platform && file) platform.env.GENIO_ONE_PROCESSOR_ADAPTERS_FILE = file
  if (!enabled) {
    delete bot.env.GENIO_ONE_DISTILLATION_TRIAGE_URL
    delete bot.env.GENIO_ONE_DISTILLATION_TRIAGE_TOKEN
    delete bot.env.GENIO_ONE_DISTILLATION_ADAPTER_ID
    delete triage.env.GENIO_ONE_PROCESSOR_ADAPTERS_FILE
    return startupNames.filter((name) => name !== "distillation-triage")
  }
  triage.env.GENIO_ONE_PROCESSOR_ADAPTERS_FILE = file
  return startupNames
}

function configuredCredentialEnvironmentNames(environment) {
  const serialized = environment[processorAdapterCredentialNames]
  if (typeof serialized !== "string") return []
  return [...new Set(serialized.split(","))]
}

function referencedCredentialEnvironmentNames(registry, allowedNames) {
  if (!registry || typeof registry !== "object" || !Array.isArray(registry.adapters)) return []
  const allowed = new Set(allowedNames)
  return [...new Set(registry.adapters
    .map((adapter) => adapter && typeof adapter === "object" ? adapter.credential_env : undefined)
    .filter((name) => typeof name === "string" && allowed.has(name)))].sort()
}

function processorAdapterCredentialDigest(serializedRegistry, environment) {
  const names = configuredCredentialEnvironmentNames(environment)
  let registry = null
  try {
    registry = JSON.parse(String(serializedRegistry))
  } catch {}
  const referenced = referencedCredentialEnvironmentNames(registry, names)
  return createHash("sha256").update(JSON.stringify({
    names: environment[processorAdapterCredentialNames] ?? null,
    values: referenced.map((name) => [name, environment[name] ?? null]),
  })).digest("hex")
}

export function distillationLaunchConfiguration(serviceList, readFile = readFileSync, environment = process.env) {
  const bot = serviceList.find((service) => service.name === "bot-server")
  const triage = serviceList.find((service) => service.name === "distillation-triage")
  const adaptersFile = triage.env.GENIO_ONE_PROCESSOR_ADAPTERS_FILE
  const serializedRegistry = adaptersFile ? readFile(adaptersFile, "utf8") : null
  const adaptersDigest = serializedRegistry === null
    ? null
    : createHash("sha256").update(serializedRegistry).digest("hex")
  const credentialDigest = serializedRegistry === null
    ? null
    : processorAdapterCredentialDigest(serializedRegistry, environment)
  return createHash("sha256").update(JSON.stringify({
    bot: {
      triageUrl: bot.env.GENIO_ONE_DISTILLATION_TRIAGE_URL ?? null,
      triageToken: bot.env.GENIO_ONE_DISTILLATION_TRIAGE_TOKEN ?? null,
      adapterId: bot.env.GENIO_ONE_DISTILLATION_ADAPTER_ID ?? null,
    },
    triage: {
      listen: triage.env.GENIO_ONE_AI_PROCESSOR_HTTP_LISTEN ?? null,
      token: triage.env.GENIO_ONE_DISTILLATION_TRIAGE_TOKEN ?? null,
      adaptersFile: adaptersFile ?? null,
      adaptersDigest,
      credentialDigest,
    },
  })).digest("hex")
}

export function distillationLaunchState(configuration, botOwners, triageOwners = []) {
  return JSON.stringify({
    schema_version: 2,
    configuration,
    botPids: botOwners.map((owner) => owner.pid).sort(),
    triagePids: triageOwners.map((owner) => owner.pid).sort(),
  })
}

function launchConfiguration(state) {
  try {
    const parsed = JSON.parse(state)
    return parsed && typeof parsed === "object" && parsed.schema_version === 2 && typeof parsed.configuration === "string"
      ? parsed.configuration
      : null
  } catch {
    return null
  }
}

export function canRestartStandaloneDistillationTriage(owners, checkoutRoot) {
  return owners.length > 0 && owners.every((owner) => distillationPortRole(owner, checkoutRoot) === "local-triage")
}

export function adoptDistillationProcessor({ owners, checkoutRoot, handoffExists, createHandoff }) {
  if (owners.length === 0 || !owners.every((owner) => distillationPortRole(owner, checkoutRoot) === "processor")) return false
  if (!handoffExists()) createHandoff()
  return true
}

export async function reconcileDistillationLaunchConfiguration(input) {
  if (input.previous === input.current) return false
  const previousConfiguration = launchConfiguration(input.previous)
  const currentConfiguration = launchConfiguration(input.current)
  if (
    input.hasAdoptedProcessor?.() &&
    (!previousConfiguration || !currentConfiguration || previousConfiguration !== currentConfiguration)
  ) {
    throw new Error("Gateway Runtime owns the active Processor; restart and reapply it before changing local distillation adapter or credential configuration")
  }
  await input.stopBot()
  await input.stopTriage()
  return true
}

export function nextTriageHandoffAction({ processorListening, handoffExists, timedOut }) {
  if (processorListening) return "active"
  if (handoffExists && !timedOut) return "wait"
  return "restore"
}

export function triageHandoffStartupRecoveryOptions({ handoffExists, portOccupied, handoffPhase }) {
  if (!handoffExists || portOccupied) return undefined
  return unmanagedTriageRecoveryOptions({ handoffPhase })
}

export function triageHandoffPhase(contents) {
  return parseDistillationTriageHandoff(contents).phase
}

export function shouldMonitorUnmanagedTriageHandoff({ handoffExists, triageChildActive, recoveryActive, processorActive }) {
  return handoffExists && !triageChildActive && !recoveryActive && !processorActive
}

export function unmanagedTriageRecoveryOptions({ handoffPhase }) {
  return { waitForProcessor: handoffPhase === "taking-over" }
}

export function triggerUnmanagedTriageRecovery(input) {
  if (!shouldMonitorUnmanagedTriageHandoff(input)) return false
  void input.recover(unmanagedTriageRecoveryOptions(input))
  return true
}

export function nextTriageRestoreAction({ portOccupied, ownersVerified }) {
  if (!portOccupied) return "spawn"
  return ownersVerified ? "ready" : "wait"
}

export function sameServiceOwners(expectedOwners, currentOwners) {
  return expectedOwners.length === currentOwners.length && expectedOwners.every((owner) =>
    currentOwners.some((current) =>
      current.pid === owner.pid && current.cwd === owner.cwd && current.command === owner.command
    )
  )
}

export function canCompleteTriageRecovery({ service, expectedOwners, currentOwners, healthy }) {
  return healthy && expectedOwners.length > 0 &&
    currentOwners.every((owner) => serviceOwnerMatches(service, owner)) &&
    sameServiceOwners(expectedOwners, currentOwners)
}

function readTriageHandoff() {
  return readDistillationTriageHandoff(root)
}

function sameTriageHandoff(expected, current) {
  return Boolean(expected && current) &&
    expected.managed === current.managed &&
    expected.targetPath === current.targetPath &&
    expected.contents === current.contents &&
    expected.generation === current.generation
}

function clearTriageHandoff(expected) {
  if (!sameTriageHandoff(expected, readTriageHandoff())) return false
  return removeDistillationTriageHandoff(expected)
}

let triageRecovery = null
function recoverDistillationTriageAfterHandoff({ handoff = readTriageHandoff(), waitForProcessor = handoff?.phase === "taking-over" } = {}) {
  if (triageRecovery) return triageRecovery
  if (!handoff) return Promise.resolve()
  const service = services.find((item) => item.name === "distillation-triage")
  triageRecovery = (async () => {
    const deadline = Date.now() + (waitForProcessor ? 120_000 : 0)
    while (!stopping && Date.now() < deadline) {
      const currentHandoff = readTriageHandoff()
      if (!sameTriageHandoff(handoff, currentHandoff)) return
      const owners = serviceOwners(service)
      const action = nextTriageHandoffAction({
        processorListening: owners.some((owner) => distillationPortRole(owner, root) === "processor"),
        handoffExists: Boolean(currentHandoff),
        timedOut: false,
      })
      if (action === "active") return
      if (action === "restore") break
      await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    }
    if (stopping) return
    const currentHandoff = readTriageHandoff()
    if (!sameTriageHandoff(handoff, currentHandoff)) return
    const owners = serviceOwners(service)
    const action = nextTriageHandoffAction({
      processorListening: owners.some((owner) => distillationPortRole(owner, root) === "processor"),
      handoffExists: Boolean(currentHandoff),
      timedOut: true,
    })
    if (action === "active") return
    if (children.has(service.name)) return
    const occupied = await portIsOccupied(service.port)
    const restoreOwners = occupied ? serviceOwners(service) : []
    const restoreAction = nextTriageRestoreAction({
      portOccupied: occupied,
      ownersVerified: restoreOwners.length > 0 && restoreOwners.every((owner) => serviceOwnerMatches(service, owner)),
    })
    if (restoreAction === "ready") {
      const health = await probe(service)
      const confirmedOwners = serviceOwners(service)
      if (!canCompleteTriageRecovery({
        service,
        expectedOwners: restoreOwners,
        currentOwners: confirmedOwners,
        healthy: Boolean(health && service.healthy(health.body, health.response)),
      })) return
      clearTriageHandoff(handoff)
      return
    }
    if (restoreAction === "wait") return
    if (!sameTriageHandoff(handoff, readTriageHandoff())) return
    if (!spawnService(service)) return
    let healthy
    try {
      healthy = await waitForHealthy(service)
    } catch {
      if (!stopping) await shutdown(1)
      return
    }
    if (healthy) clearTriageHandoff(handoff)
    else if (!stopping) await shutdown(1)
  })().finally(() => { triageRecovery = null })
  return triageRecovery
}

function monitorUnmanagedTriageHandoff() {
  const handoff = readTriageHandoff()
  const handoffExists = Boolean(handoff)
  const triageChildActive = children.has("distillation-triage")
  const recoveryActive = Boolean(triageRecovery)
  if (!handoffExists || triageChildActive || recoveryActive) return
  const service = services.find((item) => item.name === "distillation-triage")
  const processorActive = serviceOwners(service)
    .some((owner) => distillationPortRole(owner, root) === "processor")
  triggerUnmanagedTriageRecovery({
    handoffExists,
    triageChildActive,
    recoveryActive,
    processorActive,
    handoffPhase: handoff.phase,
    recover: (options) => recoverDistillationTriageAfterHandoff({ ...options, handoff }),
  })
}

export { distillationPortRole }
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
      GENIO_ONE_DISTILLATION_TRIAGE_URL: "http://127.0.0.1:8182/v1/distillation-triage",
      GENIO_ONE_DISTILLATION_TRIAGE_TOKEN: "local-distillation-triage",
      GENIO_ONE_DISTILLATION_ADAPTER_ID: "jev-production",
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
  {
    name: "distillation-triage",
    url: "http://127.0.0.1:8182/healthz",
    port: 8182,
    cwd: gatewayDir,
    args: ["dev:distillation-triage"],
    marker: "local-distillation-triage.ts",
    healthy(body) {
      return body?.status === "ok" && body?.component === "local-distillation-triage"
    },
    stale() {
      return false
    },
    handoffRecovery({ occupied }) {
      const handoff = readTriageHandoff()
      return triageHandoffStartupRecoveryOptions({
        handoffExists: Boolean(handoff),
        portOccupied: occupied,
        handoffPhase: handoff?.phase,
      })
    },
    adopt(owners) {
      return adoptDistillationProcessor({
        owners,
        checkoutRoot: root,
        handoffExists() {
          return Boolean(readTriageHandoff())
        },
        createHandoff() {
          createDistillationTriageHandoff(root, "ready")
        },
      })
    },
    onUnexpectedExit() {
      const handoff = readTriageHandoff()
      if (!handoff) return undefined
      void recoverDistillationTriageAfterHandoff({ handoff })
      return "ignore"
    },
    env: {
      GENIO_ONE_AI_PROCESSOR_HTTP_LISTEN: "127.0.0.1:8182",
      GENIO_ONE_DISTILLATION_TRIAGE_TOKEN: "local-distillation-triage",
    },
  },
]

const startupServiceNames = ["distillation-triage", "bot-server", "platform-api", "platform-web", "bot-web"]

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

export function serviceOwnerMatches(service, owner) {
  return owner.cwd === service.cwd && owner.command.includes(service.marker)
}

export function signalVerifiedServiceOwner({ service, owner, currentOwner, signal }) {
  const state = portOwnerRevalidation(owner, currentOwner)
  if (state === "exited") return "exited"
  if (state === "changed" || !serviceOwnerMatches(service, currentOwner)) {
    throw new Error(`${service.name} port ${service.port} owner changed before signal`)
  }
  try {
    signal(owner.pid)
  } catch (error) {
    if (error?.code === "ESRCH") return "exited"
    throw error
  }
  return "signaled"
}

function serviceOwners(service) {
  return listeningPortOwners(service.port)
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
  for (const owner of owners) {
    signalVerifiedServiceOwner({
      service,
      owner,
      currentOwner: { cwd: processCwd(owner.pid), command: processCommand(owner.pid) },
      signal(pid) { process.kill(Number(pid), "SIGTERM") },
    })
  }
  await waitForPortFree(service.port)
}

async function stopDistillationTriage(service) {
  const handoff = readTriageHandoff()
  const owners = serviceOwners(service)
  if (owners.length === 0) {
    if (await portIsOccupied(service.port)) assertServiceOwners(service, owners)
    return
  }
  const unrelated = owners.filter((owner) => distillationPortRole(owner, root) === "other")
  if (unrelated.length > 0) {
    throw new Error(`${service.name} port ${service.port} is occupied by a process outside this checkout: ${unrelated.map((owner) => `${owner.pid} cwd=${owner.cwd || "unknown"} command=${owner.command || "unknown"}`).join("; ")}`)
  }
  if (!canRestartStandaloneDistillationTriage(owners, root)) return
  for (const owner of owners) {
    signalVerifiedServiceOwner({
      service,
      owner,
      currentOwner: { cwd: processCwd(owner.pid), command: processCommand(owner.pid) },
      signal(pid) { process.kill(Number(pid), "SIGTERM") },
    })
  }
  await waitForPortFree(service.port)
  clearTriageHandoff(handoff)
}

function recordedDistillationLaunchConfiguration() {
  return existsSync(distillationLaunchConfigurationPath)
    ? readFileSync(distillationLaunchConfigurationPath, "utf8").trim()
    : ""
}

function recordDistillationLaunchConfiguration(configuration) {
  mkdirSync(dirname(distillationLaunchConfigurationPath), { recursive: true })
  writeFileSync(distillationLaunchConfigurationPath, `${configuration}\n`, { mode: 0o600 })
}

function spawnService(service) {
  if (stopping) return false
  const child = spawn("pnpm", service.args, {
    cwd: service.cwd,
    env: { ...process.env, ...serviceEnvironment(service) },
    stdio: "inherit",
  })
  children.set(service.name, child)
  watchServiceExit(child, service, {
    report: (event) => {
      if (service.onUnexpectedExit?.() === "ignore") return
      process.stderr.write(`${JSON.stringify(event)}\n`)
    },
    onUnexpectedExit: (code) => {
      if (service.onUnexpectedExit?.() === "ignore") return
      shutdown(code)
    },
  })
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
  const handoffRecovery = service.handoffRecovery?.({ occupied, owners })
  if (handoffRecovery) {
    await recoverDistillationTriageAfterHandoff(handoffRecovery)
    if (stopping) return false
    return ensureService(service)
  }
  if (result && service.stale(result.body, result.response)) {
    await stopStale(service)
    if (stopping) return false
    process.stdout.write(`${JSON.stringify({ event: "local-dev.service-stale-restarted", service: service.name, port: service.port })}\n`)
  } else if (occupied) {
    if (typeof service.adopt === "function" && service.adopt(owners)) {
      process.stdout.write(`${JSON.stringify({ event: "local-dev.service-adopted", service: service.name, port: service.port })}\n`)
      return true
    }
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
  const launchNames = configureDistillationLaunch(services, startupServiceNames, process.env, existsSync)
  const configuration = distillationLaunchConfiguration(services, readFileSync, process.env)
  const bot = services.find((service) => service.name === "bot-server")
  const triage = services.find((service) => service.name === "distillation-triage")
  const standaloneTriageOwners = () => serviceOwners(triage)
    .filter((owner) => distillationPortRole(owner, root) === "local-triage")
  await reconcileDistillationLaunchConfiguration({
    previous: recordedDistillationLaunchConfiguration(),
    current: distillationLaunchState(configuration, serviceOwners(bot), standaloneTriageOwners()),
    hasAdoptedProcessor: () => serviceOwners(triage)
      .some((owner) => distillationPortRole(owner, root) === "processor"),
    stopBot: () => stopStale(bot),
    stopTriage: () => stopDistillationTriage(triage),
  })
  if (stopping) return
  const sequential = launchNames.filter((name) => name !== "platform-web" && name !== "bot-web")
  const parallel = launchNames.filter((name) => name === "platform-web" || name === "bot-web")
  for (const name of sequential) {
    if (!(await ensureService(services.find((service) => service.name === name))) || stopping) return
  }
  const started = await Promise.all(parallel.map((name) =>
    ensureService(services.find((service) => service.name === name)),
  ))
  if (stopping || started.some((value) => !value)) return
  recordDistillationLaunchConfiguration(distillationLaunchState(configuration, serviceOwners(bot), standaloneTriageOwners()))
  process.stdout.write(`${JSON.stringify({ event: "local-dev.ready", services: services.map((service) => service.name), origins: { platform: "http://127.0.0.1:5173/management", bot: "http://127.0.0.1:5180/" } })}\n`)
  monitorUnmanagedTriageHandoff()
  keepAlive = setInterval(monitorUnmanagedTriageHandoff, 500)
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
