import { Sandbox as CoreSandbox, type CommandHandle } from "e2b"
import { randomUUID } from "node:crypto"
import { Sandbox as DesktopSandbox } from "@e2b/desktop"
import { E2BDesktopDriver, type DesktopComputerDriver } from "./desktop-driver"
import { selfHostedE2BConfiguration } from "./e2b-self-host"
import { isHandsRelativePath, type HandsWorkspace } from "@genioone/protocol/hands"
import type { BotWorkspaceStore } from "./bot-workspace-store"
import type { ManagedDesktop, RuntimeCallbacks, RuntimeDetails, RuntimeProvisionRequest } from "./runtime-contract"

const REMOTE_NODE_ROOT = "/home/user/.local/node"
const REMOTE_CODEX_ROOT = "/home/user/.local"
const E2B_WORKSPACE_ROOT = "/home/user/workspace"
const E2B_CHECKPOINT_ARCHIVE = "/home/user/.cache/genio-checkpoints/workspace.tar.gz"
export const secureWorkspaceFileScript = [
  "import os, sys, shutil",
  "root, relative, mode, temporary = sys.argv[1:]",
  "parts = relative.split('/')",
  "directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)",
  "for part in parts[:-1]:",
  "    if mode == 'write':",
  "        try: os.mkdir(part, mode=0o700, dir_fd=directory)",
  "        except FileExistsError: pass",
  "    child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)",
  "    os.close(directory)",
  "    directory = child",
  "if mode == 'read':",
  "    source = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)",
  "    if os.fstat(source).st_size > 10485760: raise ValueError('ARTIFACT_TOO_LARGE')",
  "    target = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)",
  "else:",
  "    source = os.open(temporary, os.O_RDONLY | os.O_NOFOLLOW)",
  "    target = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600, dir_fd=directory)",
  "with os.fdopen(source, 'rb') as reader, os.fdopen(target, 'wb') as writer:",
  "    shutil.copyfileobj(reader, writer)",
  "os.close(directory)",
].join("\n")

function shellArgument(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function secureFileCommand(root: string, path: string, mode: "read" | "write", temporary: string) {
  return ["python3", "-c", secureWorkspaceFileScript, root, path, mode, temporary].map(shellArgument).join(" ")
}

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

export class SelfHostedE2BDesktop implements ManagedDesktop {
  readonly details: RuntimeDetails
  readonly computer?: DesktopComputerDriver
  readonly proxy: NonNullable<ManagedDesktop["proxy"]>
  private closing: Promise<void> | null = null

  private constructor(
    private readonly sandbox: CoreSandbox,
    private readonly desktopSandbox: DesktopSandbox | null,
    private readonly processHandle: CommandHandle,
    details: RuntimeDetails,
    computer?: DesktopComputerDriver,
    private readonly workspace?: HandsWorkspace,
    private readonly workspaces?: BotWorkspaceStore,
  ) {
    this.details = details
    this.computer = computer
    const configured = process.env.E2B_SANDBOX_URL?.trim()
    if (!configured) throw new Error("E2B_SANDBOX_URL_REQUIRED")
    this.proxy = {
      executor: { url: configured, headers: { "E2b-Sandbox-Id": details.sandboxId!, "E2b-Sandbox-Port": "4512" } },
      ...(details.tier === "desktop" ? {
        desktop: { url: configured, headers: { "E2b-Sandbox-Id": details.sandboxId!, "E2b-Sandbox-Port": "6080" } },
        desktopWebSocket: { url: configured, headers: { "E2b-Sandbox-Id": details.sandboxId!, "E2b-Sandbox-Port": "6080" } },
      } : {}),
    }
  }

  static async create(request: RuntimeProvisionRequest, callbacks: Pick<RuntimeCallbacks, "onExit">, workspaces?: BotWorkspaceStore) {
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
      const workspaceRoot = request.workspace ? E2B_WORKSPACE_ROOT : "/home/user"
      if (request.workspace && workspaces) {
        const prepared = await sandbox.commands.run(`mkdir -p ${E2B_WORKSPACE_ROOT} /home/user/.cache/genio-checkpoints`, { timeoutMs: 10_000 })
        if (prepared.exitCode !== 0) throw new Error("WORKSPACE_PREPARE_FAILED")
        const checkpoint = workspaces.readCheckpoint(request.workspace.workspaceId, request.workspace.revision)
        if (checkpoint) {
          await sandbox.files.write(E2B_CHECKPOINT_ARCHIVE, checkpoint.slice().buffer as ArrayBuffer)
          const restored = await sandbox.commands.run(`tar -C ${E2B_WORKSPACE_ROOT} -xzf ${E2B_CHECKPOINT_ARCHIVE}`, { timeoutMs: 180_000 })
          if (restored.exitCode !== 0) throw new Error("WORKSPACE_RESTORE_FAILED")
        }
      }
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
        cwd: workspaceRoot,
        desktopUrl,
        sandboxId: sandbox.sandboxId,
        environmentId: `e2b-${sandbox.sandboxId}`,
        execServerUrl: `ws://127.0.0.1:${serverPort}/api/executor/${encodeURIComponent(request.runtimeSessionId)}?tier=${encodeURIComponent(tier)}`,
        execReady: true,
        botId: request.botId ?? null,
        workspaceId: request.workspace?.workspaceId ?? null,
        workspaceRevision: request.workspace?.revision ?? null,
        leaseId: sandbox.sandboxId,
      } satisfies RuntimeDetails
      const computer = desktopSandbox && request.botId
        ? new E2BDesktopDriver(desktopSandbox, {
          runtimeSessionId: request.runtimeSessionId,
          tenantId: request.tenantId,
          subjectId: request.subjectId,
          actingClientId: request.actingClientId,
        })
        : undefined
      return new SelfHostedE2BDesktop(sandbox, desktopSandbox, processHandle, details, computer, request.workspace, workspaces)
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
    if (this.closing) return this.closing
    this.closing = this.release().catch((error) => { this.closing = null; throw error })
    return this.closing
  }

  private async release() {
    await this.computer?.close().catch(() => undefined)
    await this.processHandle.kill().catch(() => false)
    if (this.workspace && this.workspaces) {
      let stderr = ""
      let result: { exitCode: number }
      try {
        result = await this.sandbox.commands.run(`tar -C ${E2B_WORKSPACE_ROOT} -czf ${E2B_CHECKPOINT_ARCHIVE} .`, {
          timeoutMs: 180_000,
          onStderr: (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096) },
        })
      } catch (error) {
        if (stderr.includes("No space left on device")) throw new Error("WORKSPACE_CHECKPOINT_CAPACITY_EXCEEDED")
        throw error
      }
      if (stderr.includes("No space left on device")) throw new Error("WORKSPACE_CHECKPOINT_CAPACITY_EXCEEDED")
      if (result.exitCode !== 0) throw new Error("WORKSPACE_CHECKPOINT_FAILED")
      const checkpoint = await this.sandbox.files.read(E2B_CHECKPOINT_ARCHIVE, { format: "bytes" })
      this.details.workspaceRevision = this.workspaces.saveCheckpoint(this.workspace.workspaceId, this.details.workspaceRevision ?? this.workspace.revision, checkpoint)
    }
    await this.desktopSandbox?.stream.stop().catch(() => undefined)
    await this.sandbox.kill().catch(() => undefined)
  }

  async readFile(path: string) {
    if (!isHandsRelativePath(path)) throw new Error("ARTIFACT_PATH_INVALID")
    const temporary = `/tmp/genio-hands-read-${randomUUID()}`
    try {
      const result = await this.sandbox.commands.run(secureFileCommand(this.details.cwd, path, "read", temporary), { timeoutMs: 30_000 })
      if (result.exitCode !== 0) throw new Error("WORKSPACE_FILE_ACCESS_DENIED")
      return await this.sandbox.files.read(temporary, { format: "bytes" })
    } finally { await this.sandbox.commands.run(`rm -f -- ${shellArgument(temporary)}`, { timeoutMs: 10_000 }).catch(() => undefined) }
  }

  async writeFile(path: string, data: Uint8Array) {
    if (!isHandsRelativePath(path)) throw new Error("ARTIFACT_PATH_INVALID")
    if (data.byteLength > 10 * 1024 * 1024) throw new Error("ARTIFACT_TOO_LARGE")
    const temporary = `/tmp/genio-hands-write-${randomUUID()}`
    try {
      await this.sandbox.files.write(temporary, data.slice().buffer as ArrayBuffer)
      const result = await this.sandbox.commands.run(secureFileCommand(this.details.cwd, path, "write", temporary), { timeoutMs: 30_000 })
      if (result.exitCode !== 0) throw new Error("WORKSPACE_FILE_ACCESS_DENIED")
    } finally { await this.sandbox.commands.run(`rm -f -- ${shellArgument(temporary)}`, { timeoutMs: 10_000 }).catch(() => undefined) }
  }

  async openFile(path: string) {
    if (!this.desktopSandbox) throw new Error("DESKTOP_RUNTIME_REQUIRED")
    if (!isHandsRelativePath(path)) throw new Error("ARTIFACT_PATH_INVALID")
    const bytes = await this.readFile(path)
    const directory = `/tmp/genio-hands-open-${randomUUID()}`
    const prepared = await this.sandbox.commands.run(`mkdir -m 700 -- ${shellArgument(directory)}`, { timeoutMs: 10_000 })
    if (prepared.exitCode !== 0) throw new Error("WORKSPACE_OPEN_PREPARE_FAILED")
    const destination = `${directory}/${path.split("/").at(-1)}`
    await this.sandbox.files.write(destination, bytes.slice().buffer as ArrayBuffer)
    await this.desktopSandbox.launch("google-chrome", destination)
  }
}

export function remoteExecServerCommand() {
  return "codex exec-server --listen ws://0.0.0.0:4512 --concurrent-requests 8"
}
