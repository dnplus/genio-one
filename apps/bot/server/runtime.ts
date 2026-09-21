import { ObservationLinks } from "./observation-links"
import { observationContext, observeOperation, type ObservationContext } from "@genioone/telemetry/operation-observability"
import { createNativeTelemetryReceiver } from "@genioone/telemetry/native-telemetry"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { Sandbox as CoreSandbox, type CommandHandle } from "e2b"
import { Sandbox as DesktopSandbox } from "@e2b/desktop"

import { E2BDesktopDriver, type DesktopComputerDriver } from "./desktop-driver"
import { modelGatewayRelayOrigin } from "./bot-model-config"
import { selfHostedE2BConfiguration } from "./e2b-self-host"
import { createJsonLineCollector } from "./jsonl"

export type RuntimeKind = "e2b-self-hosted" | "local" | "endpoint"
export type RuntimeTier = "none" | "headless" | "desktop"

export interface RuntimeDetails {
  kind: RuntimeKind
  tier: RuntimeTier
  cwd: string
  desktopUrl: string | null
  sandboxId: string | null
  environmentId: string | null
  execServerUrl: string | null
  execReady: boolean
  endpoint?: { botId: string; hostname: string; expiresAt: number }
}

export interface CodexRuntime {
  send(message: string): Promise<void>
  close(): Promise<void>
  updateToken?(token: string): Promise<void>
}

export interface ManagedDesktop {
  details: RuntimeDetails
  close(): Promise<void>
  computer?: DesktopComputerDriver
  readFile?(path: string): Promise<Uint8Array>
  writeFile?(path: string, data: Uint8Array): Promise<void>
  openFile?(path: string): Promise<void>
}

export interface RuntimeCallbacks {
  onMessage(message: string): void
  onExit(reason: string): void
}

export interface RuntimeProvisionRequest {
  runtimeSessionId: string
  tenantId: string
  subjectId: string
  actingClientId: string
  botId?: string
  tier: Exclude<RuntimeTier, "none">
}

export interface CodexHomeNamespace {
  tenantId: string
  subjectId: string
  actingClientId: string
  runtimeSessionId?: string
}

export type CodexRuntimeFactory = (
  accessToken: string,
  callbacks: RuntimeCallbacks,
  namespace?: CodexHomeNamespace,
  relaySecret?: string,
) => CodexRuntime

export function configuredRuntimeKind(environment: NodeJS.ProcessEnv = process.env): RuntimeKind {
  const runtime = environment.GENIO_BOT_RUNTIME?.trim() || "e2b-self-hosted"
  if (runtime === "local" || runtime === "e2b-self-hosted") return runtime
  throw new Error("GENIO_BOT_RUNTIME_INVALID")
}

export function pendingRuntimeDetails(
  kind: RuntimeKind = configuredRuntimeKind(),
  tier: RuntimeTier = "none",
): RuntimeDetails {
  return {
    kind,
    tier,
    cwd: kind === "local" ? (process.env.GENIO_BOT_LOCAL_CWD?.trim() || tmpdir()) : "/home/user",
    desktopUrl: null,
    sandboxId: null,
    environmentId: null,
    execServerUrl: null,
    execReady: false,
  }
}

export class PendingRuntime implements ManagedDesktop {
  constructor(readonly details: RuntimeDetails = pendingRuntimeDetails()) {}
  async close() {}
}

const GENIO_ONE_MCP_BEARER_TOKEN_ENV = "GENIO_ONE_MCP_BEARER_TOKEN"
const GENIO_ONE_MODEL_GATEWAY_TOKEN_ENV = "GENIO_ONE_MODEL_GATEWAY_TOKEN"
const REMOTE_NODE_ROOT = "/home/user/.local/node"
const REMOTE_CODEX_ROOT = "/home/user/.local"

export function remoteCodexPathPrefix() {
  return `PATH=${REMOTE_CODEX_ROOT}/bin:${REMOTE_NODE_ROOT}/bin:/usr/local/bin:$PATH`
}

export function remoteCodexBootstrapCommand(version: string) {
  const archive = "/tmp/node-v22.18.0-linux-x64.tar.gz"
  return [
    "set -eu",
    `mkdir -p ${REMOTE_NODE_ROOT} ${REMOTE_CODEX_ROOT}/bin`,
    `curl --fail --location --retry 3 https://nodejs.org/dist/v22.18.0/node-v22.18.0-linux-x64.tar.gz --output ${archive}`,
    `tar -C ${REMOTE_NODE_ROOT} --strip-components=1 -xzf ${archive}`,
    `rm -f ${archive}`,
    `${remoteCodexPathPrefix()} npm install --global --prefix ${REMOTE_CODEX_ROOT} @openai/codex@${version} >/tmp/genio-codex-install.log 2>&1`,
    `${remoteCodexPathPrefix()} codex --version`,
  ].join(" && ")
}

function resolveCodexCommand(configured?: string): string {
  const custom = configured?.trim()
  return custom || "codex"
}

function namespacePart(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "unknown"
}

export function codexChildEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const child = { ...environment }
  delete child.GENIO_ONE_RUNTIME_REPORT_KEY_ID
  delete child.GENIO_ONE_RUNTIME_REPORT_PRIVATE_KEY_PEM
  return child
}

class ServerCodexRuntime implements CodexRuntime {
  private readonly links: ObservationLinks
  private readonly requestObservations = new Map<number | string, { context: ObservationContext; method: string; threadId?: string }>()
  private readonly telemetry: ReturnType<typeof createNativeTelemetryReceiver> | undefined
  private readonly child: ChildProcessWithoutNullStreams

  constructor(accessToken: string, callbacks: RuntimeCallbacks, namespace?: CodexHomeNamespace, relaySecret = accessToken) {
    const command = resolveCodexCommand(process.env.GENIO_BOT_CODEX_COMMAND)
    const appDir = resolve(import.meta.dir, "..")
    const cwd = process.env.GENIO_BOT_SERVER_CWD?.trim()
      ? resolve(process.env.GENIO_BOT_SERVER_CWD.trim())
      : tmpdir()
    const configuredHome = process.env.GENIO_BOT_CODEX_HOME?.trim()
    const codexHomeBase = configuredHome ? resolve(appDir, configuredHome) : resolve(appDir, ".local/codex-home")
    const codexHome = resolve(
      codexHomeBase,
      "namespaces",
      namespacePart(namespace?.tenantId || "tenant"),
      namespacePart(namespace?.subjectId || "subject"),
      namespacePart(namespace?.actingClientId || "client"),
    )
    mkdirSync(codexHome, { recursive: true })
    this.links = new ObservationLinks(resolve(codexHome, `${namespacePart(namespace?.runtimeSessionId ?? "default")}-observation-links.json`), namespace?.tenantId ?? "unassigned")
    const modelGatewayUpstreamUrl = process.env.GENIO_ONE_MODEL_GATEWAY_BASE_URL?.trim()
    const modelGatewayBaseUrl = modelGatewayUpstreamUrl && namespace?.runtimeSessionId
      ? `${modelGatewayRelayOrigin()}/api/model-gateway/${encodeURIComponent(namespace.runtimeSessionId)}/v1`
      : modelGatewayUpstreamUrl
    const modelGatewayUsesRelay = Boolean(namespace?.runtimeSessionId)
    const collectorEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ||
      process.env.GENIO_ONE_OTEL_COLLECTOR_ORIGIN?.trim() ||
      (process.env.GENIO_ONE_OTEL_HTTP_PORT ? `http://127.0.0.1:${process.env.GENIO_ONE_OTEL_HTTP_PORT}` : "http://127.0.0.1:4318")
    try { this.telemetry = createNativeTelemetryReceiver({ origin: collectorEndpoint, identity: namespace ?? {} }) }
    catch { console.warn(JSON.stringify({ event: "codex.telemetry.receiver_unavailable", delivery: "NATIVE_TELEMETRY_UNAVAILABLE" })) }
    const otelEndpoint = this.telemetry?.origin
    const childEnvironment = codexChildEnvironment()
    this.child = spawn(command, appServerArguments({
      otelEndpoint,
      discoveryMcpUrl: resolveGenioDiscoveryMcpUrl(process.env, namespace),
      ...(modelGatewayBaseUrl ? {
        modelProvider: {
          id: "genio_one",
          name: "GenioOne AI Gateway",
          baseUrl: modelGatewayBaseUrl,
          tokenEnvVar: GENIO_ONE_MODEL_GATEWAY_TOKEN_ENV,
        },
      } : {}),
    }), {
      cwd,
      env: {
        ...childEnvironment,
        CODEX_HOME: codexHome,
        [GENIO_ONE_MCP_BEARER_TOKEN_ENV]: relaySecret,
        ...(modelGatewayUsesRelay
          ? { [GENIO_ONE_MODEL_GATEWAY_TOKEN_ENV]: relaySecret }
          : modelGatewayBaseUrl ? { [GENIO_ONE_MODEL_GATEWAY_TOKEN_ENV]: accessToken } : {}),
        OTEL_EXPORTER_OTLP_ENDPOINT: otelEndpoint,
        OTEL_SERVICE_NAME: process.env.OTEL_SERVICE_NAME?.trim() || "genio-one-bot-codex",
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const collect = createJsonLineCollector((line) => {
      try {
        const parsed = JSON.parse(line)
        if (parsed.method) {
          console.info(JSON.stringify({ event: "codex.rpc.notify", method: parsed.method, ...(parsed.method === "account/login/completed" ? { success: parsed.params?.success === true, error: typeof parsed.params?.error === "string" ? parsed.params.error.replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]").slice(0, 600) : null } : {}) }))
        }
      } catch {}
      let message: any
      try { message = JSON.parse(line) } catch {}
      const pending = message?.id !== undefined ? this.requestObservations.get(message.id) : undefined
      const threadId = message?.params?.threadId ?? message?.params?.thread?.id
      const turnId = message?.params?.turnId ?? message?.params?.turn?.id
      let parent = pending?.context ?? (turnId ? this.links.get(`turn:${turnId}`) : threadId ? this.links.get(`thread:${threadId}`) : undefined)
      if (!parent && message?.method === "turn/started" && threadId) parent = this.links.get(`thread:${threadId}`)
      if (pending) {
        this.requestObservations.delete(message.id)
        if (message.result?.thread?.id) this.links.put(`thread:${message.result.thread.id}`, pending.context)
        if (message.result?.turn?.id) this.links.put(`turn:${message.result.turn.id}`, pending.context)
      }
      if (parent && turnId && message?.method === "turn/started") this.links.put(`turn:${turnId}`, parent)
      const notify = () => observeOperation("genio-one-bot", "codex.notification", { tenantId: namespace?.tenantId, runtimeSessionId: namespace?.runtimeSessionId, parent_availability: parent ? "CAPTURED" : "NOT_PROVIDED", message }, () => callbacks.onMessage(line))
      if (parent) observationContext.run(parent, notify)
      else observationContext.exit(notify)
    })
    this.child.stdout.on("data", (chunk) => collect(String(chunk)))
    this.child.stderr.on("data", (chunk) => {
      console.error(JSON.stringify({ event: "codex.stderr", runtime: "server", message: String(chunk).trim() }))
    })
    this.child.on("error", (err) => {
      this.telemetry?.close()
      void this.links.close()
      console.error(JSON.stringify({ event: "codex.process.error", error: err instanceof Error ? err.message : String(err) }))
      callbacks.onExit(`codex error (${err instanceof Error ? err.message : String(err)})`)
    })
    this.child.on("exit", (code, signal) => { this.telemetry?.close(); void this.links.close(); callbacks.onExit(`codex exited (${code ?? signal ?? "unknown"})`) })
  }

  async send(message: string) {
    await this.links.ready()
    try {
      const parsed = JSON.parse(message)
      const context = observationContext.getStore()
      if (context && parsed.id !== undefined && parsed.method) {
        this.requestObservations.set(parsed.id, { context, method: parsed.method, threadId: parsed.params?.threadId })
        if (this.requestObservations.size > 4096) this.requestObservations.delete(this.requestObservations.keys().next().value!)
        if (parsed.method === "turn/start" && parsed.params?.threadId) this.links.put(`thread:${parsed.params.threadId}`, context)
      }
      if (parsed.method) {
        console.info(JSON.stringify({ event: "codex.rpc.request", method: parsed.method, id: parsed.id }))
      }
    } catch {}
    if (!this.child.stdin.writable) {
      throw new Error("CODEX_STDIN_NOT_WRITABLE")
    }
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(`${message}\n`, (error) => error ? reject(error) : resolve())
    })
  }

  async updateToken(_token: string) {
    // Child processes in POSIX inherit environment variables at spawn time;
    // they cannot be hot-reloaded via process.env mutation without leaking into the parent process.
  }

  async close() {
    await this.links.close()
    if (!this.child.pid || this.child.exitCode !== null || this.child.signalCode !== null) { this.telemetry?.close(); return }
    await new Promise<void>((resolve) => {
      const forceKillTimer = setTimeout(() => {
        if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL")
      }, 3000)
      this.child.once("exit", () => { clearTimeout(forceKillTimer); resolve() })
      this.child.kill("SIGTERM")
    })
    this.telemetry?.close()
  }
}

type E2BCommandResult = { exitCode: number; stdout: string }

function isE2BCommandExit(error: unknown) {
  return Boolean(error && typeof error === "object" && typeof (error as { exitCode?: unknown }).exitCode === "number")
}

export async function e2bCommandResult(run: () => Promise<E2BCommandResult>) {
  try {
    return await run()
  } catch (error) {
    if (isE2BCommandExit(error)) return null
    throw error
  }
}

export function requiresCodexBootstrap(result: E2BCommandResult | null, version: string) {
  return !result || result.exitCode !== 0 || result.stdout.trim() !== `codex-cli ${version}`
}

function e2bProvisioningError(error: unknown) {
  const value = error && typeof error === "object" ? error as { statusCode?: unknown; exitCode?: unknown } : undefined
  return {
    error_name: error instanceof Error ? error.name : "UnknownError",
    ...(typeof value?.statusCode === "number" ? { error_code: value.statusCode } : {}),
    ...(typeof value?.exitCode === "number" ? { command_exit_code: value.exitCode } : {}),
  }
}

class SelfHostedE2BDesktop implements ManagedDesktop {
  readonly details: RuntimeDetails
  readonly computer?: DesktopComputerDriver

  private constructor(
    private readonly sandbox: CoreSandbox,
    private readonly desktopSandbox: DesktopSandbox | null,
    private readonly processHandle: CommandHandle,
    details: RuntimeDetails,
    computer?: DesktopComputerDriver,
  ) {
    this.details = details
    this.computer = computer
  }

  static async create(request: RuntimeProvisionRequest, callbacks: Pick<RuntimeCallbacks, "onExit">) {
    const configuration = selfHostedE2BConfiguration()
    const tier = request.tier
    let stage = "sandbox.create"
    console.info(JSON.stringify({ event: "runtime.e2b.provisioning", stage, tier, runtime_session_id: request.runtimeSessionId }))
    const template = tier === "desktop" ? configuration.desktopTemplate : configuration.headlessTemplate
    const sandboxOptions = {
      ...configuration.connection,
      ...(tier === "desktop" ? { resolution: [1440, 900] as [number, number] } : {}),
      timeoutMs: 60 * 60 * 1000,
      metadata: {
        app: "genio-one-bot",
        tier,
        session: request.runtimeSessionId,
        tenant: request.tenantId,
        subject: request.subjectId,
        acting_client: request.actingClientId,
        ...(request.botId ? { bot_id: request.botId } : {}),
      },
    }
    const sandbox = tier === "desktop"
      ? await DesktopSandbox.create(template, sandboxOptions)
      : await CoreSandbox.create(template, sandboxOptions)
    const desktopSandbox = tier === "desktop" ? sandbox as DesktopSandbox : null
    try {
      stage = "codex.version"
      console.info(JSON.stringify({ event: "runtime.e2b.provisioning", stage, runtime_session_id: request.runtimeSessionId, sandbox_id: sandbox.sandboxId }))
      const installed = await e2bCommandResult(() => sandbox.commands.run(`${remoteCodexPathPrefix()} codex --version`, { timeoutMs: 10_000 }))
      if (requiresCodexBootstrap(installed, configuration.codexVersion)) {
        stage = "codex.bootstrap"
        console.info(JSON.stringify({ event: "runtime.e2b.provisioning", stage, tier, runtime_session_id: request.runtimeSessionId, sandbox_id: sandbox.sandboxId }))
        const bootstrap = await sandbox.commands.run(remoteCodexBootstrapCommand(configuration.codexVersion), {
          timeoutMs: 180_000,
        })
        if (requiresCodexBootstrap(bootstrap, configuration.codexVersion)) {
          throw new Error("SELF_HOSTED_E2B_CODEX_VERSION_MISMATCH")
        }
      }

      let desktopUrl: string | null = null
      if (desktopSandbox) {
        stage = "desktop.stream"
        console.info(JSON.stringify({ event: "runtime.e2b.provisioning", stage, tier, runtime_session_id: request.runtimeSessionId, sandbox_id: sandbox.sandboxId }))
        await desktopSandbox.stream.start({ requireAuth: true })
        const authKey = desktopSandbox.stream.getAuthKey()
        desktopUrl = desktopSandbox.stream.getUrl({ authKey })
      }
      stage = "codex.exec-server"
      console.info(JSON.stringify({ event: "runtime.e2b.provisioning", stage, tier, runtime_session_id: request.runtimeSessionId, sandbox_id: sandbox.sandboxId }))
      const processHandle = await sandbox.commands.run(`${remoteCodexPathPrefix()} ${remoteExecServerCommand()}`, {
        background: true,
        timeoutMs: 60 * 60 * 1000,
        onStderr: (chunk) => {
          console.error(JSON.stringify({ event: "codex.exec-server.stderr", runtime: "e2b-self-hosted", message: chunk.trim() }))
        },
      })

      processHandle.wait().then(
        (result) => callbacks.onExit(`codex exec-server exited (${result.exitCode})`),
        (error) => callbacks.onExit(error instanceof Error ? error.message : "codex exec-server exited"),
      )

      const serverPort = Number.parseInt(process.env.GENIO_BOT_PORT || "5181", 10)
      const details = {
        kind: "e2b-self-hosted",
        tier,
        cwd: "/home/user",
        desktopUrl,
        sandboxId: sandbox.sandboxId,
        environmentId: `e2b-${sandbox.sandboxId}`,
        execServerUrl: `ws://127.0.0.1:${serverPort}/api/executor/${encodeURIComponent(request.runtimeSessionId)}?tier=${encodeURIComponent(tier)}`,
        execReady: true,
      } satisfies RuntimeDetails
      const computer = desktopSandbox && request.botId
        ? new E2BDesktopDriver(desktopSandbox, {
          runtimeSessionId: request.runtimeSessionId,
          tenantId: request.tenantId,
          subjectId: request.subjectId,
          actingClientId: request.actingClientId,
        })
        : undefined
      return new SelfHostedE2BDesktop(sandbox, desktopSandbox, processHandle, details, computer)
    } catch (error) {
      console.error(JSON.stringify({
        event: "runtime.e2b.provisioning.failed",
        stage,
        runtime_session_id: request.runtimeSessionId,
        sandbox_id: sandbox.sandboxId,
        ...e2bProvisioningError(error),
      }))
      await desktopSandbox?.stream.stop().catch(() => undefined)
      await sandbox.kill().catch(() => undefined)
      throw error
    }
  }

  async close() {
    await this.computer?.close().catch(() => undefined)
    await this.processHandle.kill().catch(() => false)
    await this.desktopSandbox?.stream.stop().catch(() => undefined)
    await this.sandbox.kill().catch(() => undefined)
  }

  async readFile(path: string) {
    return this.sandbox.files.read(path, { format: "bytes" })
  }

  async writeFile(path: string, data: Uint8Array) {
    await this.sandbox.files.write(path, data.slice().buffer as ArrayBuffer)
  }

  async openFile(path: string) {
    if (!this.desktopSandbox) throw new Error("DESKTOP_RUNTIME_REQUIRED")
    await this.desktopSandbox.launch("google-chrome", path)
  }
}

/** Resolve MCP URL for Codex app-server. Missing/invalid → null (degrade; do not block chat). */
function configuredRelayOrigin(value: string | undefined) {
  const relayOrigin = value?.trim().replace(/\/$/, "")
  if (!relayOrigin) return null
  try {
    const url = new URL(relayOrigin)
    return url.protocol === "http:" || url.protocol === "https:" ? relayOrigin : null
  } catch {
    return null
  }
}

export function resolveBotRelayOrigin(environment: NodeJS.ProcessEnv = process.env) {
  const relayOrigin = configuredRelayOrigin(environment.GENIO_ONE_MCP_RELAY_ORIGIN)
  if (relayOrigin) return relayOrigin
  const configuredPort = Number.parseInt(environment.GENIO_BOT_PORT?.trim() || "5181", 10)
  const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65_535 ? configuredPort : 5181
  return `http://127.0.0.1:${port}`
}

export function resolveGenioOneMcpUrl(environment: NodeJS.ProcessEnv = process.env, runtimeSessionId?: string): string | null {
  const configured = environment.GENIO_ONE_MCP_URL?.trim()
  const value = configured || (environment.NODE_ENV === "production" ? "" : "http://one.localhost:1975/mcp")
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    if (runtimeSessionId) return null
    return url.toString()
  } catch {
    return null
  }
}

export function resolveGenioDiscoveryMcpUrl(environment: NodeJS.ProcessEnv, namespace?: CodexHomeNamespace): string | undefined {
  if (!namespace?.tenantId) return undefined
  const platform = environment.GENIO_ONE_PLATFORM_ORIGIN?.trim()
  if (!platform) return undefined
  try {
    new URL(platform)
    if (namespace.runtimeSessionId) return `${resolveBotRelayOrigin(environment)}/api/discovery-mcp/${encodeURIComponent(namespace.runtimeSessionId)}/mcp`
    return new URL(`/v1/tenants/${encodeURIComponent(namespace.tenantId)}/discovery/mcp`, platform).toString()
  } catch {
    return undefined
  }
}

export interface AppServerMcpConfiguration {
  discoveryMcpUrl?: string
  otelEndpoint?: string
  modelProvider?: {
    id: string
    name: string
    baseUrl: string
    tokenEnvVar: string
  }
}

export function appServerArguments(configuration: AppServerMcpConfiguration) {
  const argumentsList = [
    "app-server",
    "-c",
    "analytics.enabled=false",
    "-c",
    "features.default_mode_request_user_input=true",
    "-c",
    "features.memories=false",
  ]
  if (configuration.otelEndpoint) {
    const origin = configuration.otelEndpoint.replace(/\/$/, "")
    for (const [field, signal] of [["exporter", "logs"], ["trace_exporter", "traces"], ["metrics_exporter", "metrics"]]) {
      argumentsList.push("-c", `otel.${field}={otlp-http={endpoint=${JSON.stringify(`${origin}/v1/${signal}`)},protocol="json"}}`)
    }
    argumentsList.push("-c", "otel.log_user_prompt=true")
  } else {
    for (const field of ["exporter", "trace_exporter", "metrics_exporter"]) argumentsList.push("-c", `otel.${field}="none"`)
  }
  if (configuration.discoveryMcpUrl) {
    argumentsList.push(
      "-c", `mcp_servers.genio_discovery.url=${JSON.stringify(configuration.discoveryMcpUrl)}`,
      "-c", `mcp_servers.genio_discovery.bearer_token_env_var=${JSON.stringify(GENIO_ONE_MCP_BEARER_TOKEN_ENV)}`,
      "-c", 'mcp_servers.genio_discovery.default_tools_approval_mode="writes"',
      "-c", "mcp_servers.genio_discovery.required=false",
    )
  }
  if (configuration.modelProvider) {
    argumentsList.push(
      "-c", `model_providers.${configuration.modelProvider.id}.name=${JSON.stringify(configuration.modelProvider.name)}`,
      "-c", `model_providers.${configuration.modelProvider.id}.base_url=${JSON.stringify(configuration.modelProvider.baseUrl)}`,
      "-c", `model_providers.${configuration.modelProvider.id}.env_key=${JSON.stringify(configuration.modelProvider.tokenEnvVar)}`,
    )
  }
  return argumentsList
}

function shellArgument(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export function appServerCommand(configuration: AppServerMcpConfiguration) {
  return ["codex", ...appServerArguments(configuration)].map(shellArgument).join(" ")
}

export function remoteExecServerCommand() {
  return "codex exec-server --listen ws://0.0.0.0:4512 --concurrent-requests 8"
}

export function createCodexRuntime(accessToken: string, callbacks: RuntimeCallbacks, namespace?: CodexHomeNamespace, relaySecret?: string): CodexRuntime {
  return new ServerCodexRuntime(accessToken, callbacks, namespace, relaySecret)
}

export async function createManagedRuntime(request: RuntimeProvisionRequest, callbacks: Pick<RuntimeCallbacks, "onExit">): Promise<ManagedDesktop> {
  const runtime = configuredRuntimeKind()
  if (runtime === "local") throw new Error("REMOTE_RUNTIME_NOT_CONFIGURED")
  return SelfHostedE2BDesktop.create(request, callbacks)
}

export const createManagedDesktop = createManagedRuntime
