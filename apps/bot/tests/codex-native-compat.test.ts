import { expect, test } from "bun:test"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import WebSocket from "ws"
import botPackage from "../package.json"
import { createJsonLineCollector } from "../server/jsonl"

type Frame = { id?: number; method?: string; params?: any; result?: any; error?: { code: number; message: string } }
type Pending = { resolve(value: any): void; reject(error: Error): void }
const timeoutMs = 10_000

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), timeoutMs) })])
  } finally { clearTimeout(timer) }
}

function peer(send: (line: string) => void) {
  let id = 0
  let failure: Error | undefined
  const pending = new Map<number, Pending>()
  const events: Frame[] = []
  const listeners = new Set<() => void>()
  return {
    receive(line: string) {
      try {
        const frame: Frame = JSON.parse(line)
        if (frame.method && frame.id !== undefined) throw new Error(`unexpected server request in native smoke: ${frame.method} (${frame.id})`)
        const request = !frame.method && frame.id !== undefined ? pending.get(frame.id) : undefined
        if (request) {
          pending.delete(frame.id!)
          if (frame.error) request.reject(new Error(JSON.stringify(frame.error)))
          else request.resolve(frame.result)
        } else if (frame.method) {
          events.push(frame)
          for (const listener of listeners) listener()
        }
      } catch (error) { this.close(error as Error) }
    },
    close(error: Error) {
      failure = error
      for (const request of pending.values()) request.reject(error)
      pending.clear()
      for (const listener of listeners) listener()
    },
    notify(method: string, params?: unknown) { send(JSON.stringify({ method, params })) },
    async request(method: string, params: unknown) {
      if (failure) throw failure
      const next = ++id
      try {
        return await bounded(new Promise<any>((resolve, reject) => {
          pending.set(next, { resolve, reject })
          try { send(JSON.stringify({ id: next, method, params })) } catch (error) { reject(error as Error) }
        }), method)
      } finally { pending.delete(next) }
    },
    async event(method: string, processId: string) {
      let listener: (() => void) | undefined
      try {
        return await bounded(new Promise<any>((resolve, reject) => {
          listener = () => {
            const index = events.findIndex((frame) => frame.method === method && frame.params?.processId === processId)
            if (index >= 0) resolve(events.splice(index, 1)[0]!.params)
            else if (failure) reject(failure)
          }
          listeners.add(listener)
          listener()
        }), `${method} ${processId}`)
      } finally { if (listener) listeners.delete(listener) }
    },
  }
}

function nativeBinary() {
  const targets: Record<string, string> = { "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin", "linux-arm64": "aarch64-unknown-linux-musl", "linux-x64": "x86_64-unknown-linux-musl" }
  const target = targets[`${process.platform}-${process.arch}`]
  if (!target) throw new Error("native smoke requires macOS or Linux")
  const packageRoot = realpathSync(resolve(import.meta.dir, "../node_modules/@openai/codex"))
  return realpathSync(join(packageRoot, "..", `codex-${process.platform}-${process.arch}`, "vendor", target, "bin", "codex"))
}

function start(binary: string, args: string[], root: string, workspace: string) {
  const home = join(root, "home")
  const codexHome = join(root, "codex")
  mkdirSync(home, { recursive: true })
  mkdirSync(codexHome, { recursive: true })
  const child: ChildProcessWithoutNullStreams = spawn(binary, args, {
    cwd: workspace,
    env: { HOME: home, CODEX_HOME: codexHome, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", RUST_LOG: "error" },
    stdio: ["pipe", "pipe", "pipe"],
  })
  let diagnostics = ""
  child.stderr.on("data", (chunk) => { diagnostics = (diagnostics + chunk.toString()).slice(-8000) })
  const rpc = peer((line) => child.stdin.write(`${line}\n`))
  child.stdout.on("data", createJsonLineCollector((line) => rpc.receive(line)))
  const exited = new Promise<number | null>((resolve) => {
    child.once("close", (code) => { rpc.close(new Error(`child closed ${code}: ${diagnostics}`)); resolve(code) })
    child.once("error", (error) => { rpc.close(error); resolve(null) })
    child.once("exit", () => rpc.close(new Error(`child exited: ${diagnostics}`)))
  })
  return { child, rpc, exited, diagnostics: () => diagnostics }
}

async function freePort() {
  const server = createServer()
  await bounded(new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) }), "allocate port")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("missing port")
  await bounded(new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())), "release port")
  return address.port
}

async function connect(url: string, child: ReturnType<typeof start>) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.child.exitCode !== null || child.child.signalCode !== null) throw new Error(`exec-server exited before ready: ${child.diagnostics()}`)
    const socket = new WebSocket(url, { handshakeTimeout: 500 })
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()))
    socket.on("error", () => {})
    const ready = await bounded(new Promise<boolean>((resolve) => { socket.once("open", () => resolve(true)); socket.once("error", () => resolve(false)) }), "exec-server WebSocket")
    if (ready) return socket
    socket.terminate()
    await bounded(closed, "failed readiness socket close")
    await Bun.sleep(30)
  }
  throw new Error("exec-server readiness timeout")
}

async function cycle(binary: string, root: string, workspace: string, restarted: boolean, failBeforePid = false) {
  const port = await freePort()
  const url = `ws://127.0.0.1:${port}`
  const exec = start(binary, ["exec-server", "--listen", url, "--concurrent-requests", "8"], join(root, "exec"), workspace)
  const app = start(binary, ["app-server", "-c", "analytics.enabled=false"], join(root, "app"), workspace)
  let socket: WebSocket | undefined
  let socketClosed: Promise<void> | undefined
  let executor: ReturnType<typeof peer> | undefined
  let ownsLongProcess = false
  let longPid: number | undefined
  try {
    socket = await connect(url, exec)
    socketClosed = new Promise<void>((resolve) => socket!.once("close", () => resolve()))
    executor = peer((line) => socket!.send(line))
    socket.on("message", (data) => executor!.receive(data.toString()))
    socket.on("error", (error) => executor!.close(error))
    socket.on("close", () => executor!.close(new Error("executor socket closed")))
    exec.child.once("exit", () => executor!.close(new Error("executor child exited")))
    exec.child.once("error", (error) => executor!.close(error))
    expect((await executor.request("initialize", { clientName: "genio-native-smoke" })).sessionId).toBeTruthy()
    executor.notify("initialized", {})
    await app.rpc.request("initialize", { clientInfo: { name: "genio_native_smoke", version: "1.0" }, capabilities: { experimentalApi: true } })
    app.rpc.notify("initialized")
    const started = await app.rpc.request("thread/start", { cwd: workspace, approvalPolicy: "on-request", sandbox: "read-only" })
    expect(started.approvalPolicy).toBe("on-request")
    expect(started.sandbox.type).toBe("readOnly")
    expect(started.cwd).toBe(workspace)
    const threadId = started.thread.id
    expect((await app.rpc.request("thread/read", { threadId, includeTurns: false })).thread.id).toBe(threadId)
    await expect(app.rpc.request("thread/resume", { threadId })).rejects.toThrow(/no rollout found/i)
    await expect(app.rpc.request("turn/interrupt", { threadId, turnId: "no-active-turn" })).rejects.toThrow()
    expect((await app.rpc.request("thread/read", { threadId, includeTurns: false })).thread.id).toBe(threadId)
    const environmentId = `native-smoke-${port}`
    await app.rpc.request("environment/add", { environmentId, execServerUrl: url, connectTimeoutMs: 5000 })
    const environment = await app.rpc.request("environment/info", { environmentId })
    expect(environment.cwd).toBe(pathToFileURL(workspace).href)
    expect(environment.shell.name).toBeTruthy()
    const file = pathToFileURL(join(workspace, "persisted.txt")).href
    if (restarted) expect(Buffer.from((await executor.request("fs/readFile", { path: file })).dataBase64, "base64").toString()).toBe("native workspace bytes\n")
    else await executor.request("fs/writeFile", { path: file, dataBase64: Buffer.from("native workspace bytes\n").toString("base64") })
    expect(Buffer.from((await executor.request("fs/readFile", { path: file })).dataBase64, "base64").toString()).toBe("native workspace bytes\n")
    const run = async (processId: string, command: string) => {
      await executor!.request("process/start", { processId, argv: ["/bin/sh", "-c", command], cwd: pathToFileURL(workspace).href, env: { PATH: "/usr/bin:/bin" }, tty: false, pipeStdin: false })
      return executor!.event("process/exited", processId)
    }
    expect((await run("success", "printf 'native output'")).exitCode).toBe(0)
    expect(Buffer.from((await executor.event("process/output", "success")).chunk, "base64").toString()).toBe("native output")
    expect((await run("nonzero", "exit 7")).exitCode).toBe(7)
    ownsLongProcess = true
    await executor.request("process/start", { processId: "long-lived", argv: ["/bin/sh", "-c", "printf '%s' \"$$\" > owned-process.pid; printf '%s' \"$$\"; exec sleep 60"], cwd: pathToFileURL(workspace).href, env: { PATH: "/usr/bin:/bin" }, tty: false, pipeStdin: false })
    const longOutput = await executor.event("process/output", "long-lived")
    if (failBeforePid) throw new Error("injected failure before PID capture")
    longPid = Number(Buffer.from(longOutput.chunk, "base64").toString())
    expect(longPid).toBeGreaterThan(1)
    await executor.request("process/terminate", { processId: "long-lived" })
    await executor.event("process/exited", "long-lived")
    ownsLongProcess = false
    expect(() => process.kill(longPid!, 0)).toThrow()
    longPid = undefined
    await expect(executor.request("fs/readFile", { path: pathToFileURL(join(workspace, "missing.txt")).href })).rejects.toThrow()
    expect(Buffer.from((await executor.request("fs/readFile", { path: file })).dataBase64, "base64").toString()).toBe("native workspace bytes\n")
    app.child.stdin.end()
    expect(await bounded(app.exited, "app-server stdin shutdown")).toBe(0)
    socket.close()
    await bounded(socketClosed, "executor socket close")
    exec.child.stdin.end()
    expect(await Promise.race([exec.exited.then(() => "exited"), Bun.sleep(100).then(() => "still running")])).toBe("still running")
    exec.child.kill("SIGTERM")
    await bounded(exec.exited, "exec-server signal shutdown")
    expect(exec.child.signalCode === "SIGTERM" || exec.child.exitCode === 0).toBe(true)
    console.info(`native cycle ${restarted ? "restart" : "initial"}: metadata, environment, files, output, exit 7, kill, error recovery and awaited shutdown passed (app stdin, standalone WS exec SIGTERM)`)
  } finally {
    const cleanupErrors: unknown[] = []
    if (ownsLongProcess && executor) {
      try {
        await executor.request("process/terminate", { processId: "long-lived" })
        await executor.event("process/exited", "long-lived")
      } catch (error) { cleanupErrors.push(error) }
    }
    socket?.close()
    const cleanup = await Promise.allSettled([
      ...[app, exec].map(async (native) => {
        try {
          native.child.stdin.end()
          if (native === exec && native.child.exitCode === null && native.child.signalCode === null) native.child.kill("SIGTERM")
          await bounded(native.exited, "native graceful cleanup")
        }
        catch (error) {
          native.child.kill("SIGKILL")
          await bounded(native.exited, "native forced cleanup")
          throw error
        }
      }),
      ...(socketClosed ? [bounded(socketClosed, "socket cleanup").catch(async (error) => {
        socket!.terminate()
        await bounded(socketClosed!, "forced socket cleanup")
        throw error
      })] : []),
    ])
    for (const result of cleanup) if (result.status === "rejected") cleanupErrors.push(result.reason)
    if (longPid && Number.isSafeInteger(longPid) && longPid > 1) {
      try {
        try { process.kill(longPid!, "SIGKILL") } catch {}
        await bounded((async () => { for (;;) { try { process.kill(longPid!, 0) } catch { return }; await Bun.sleep(20) } })(), "long process cleanup")
      } catch (error) { cleanupErrors.push(error) }
    }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "native smoke cleanup failed")
  }
}

const mode = process.env.GENIO_CODEX_TEST_MODE ?? "native"
if (mode !== "native" && mode !== "migration") throw new Error("GENIO_CODEX_TEST_MODE must be native or migration")

test("native smoke peer fails a server request that reuses an outstanding client ID", async () => {
  const sent: string[] = []
  const rpc = peer((line) => { sent.push(line) })
  const request = rpc.request("thread/start", {})
  rpc.receive(JSON.stringify({ id: 1, method: "item/commandExecution/requestApproval", params: {} }))
  await expect(request).rejects.toThrow("unexpected server request in native smoke")
  expect(sent).toHaveLength(1)
  await expect(rpc.request("thread/read", {})).rejects.toThrow("unexpected server request in native smoke")
})

if (mode === "native") test("native smoke cleans its owned process when it fails before capturing the PID", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "genio-codex-native-failure-")))
  const workspace = join(root, "workspace")
  mkdirSync(workspace)
  let pid: number | undefined
  try {
    await expect(cycle(nativeBinary(), root, workspace, false, true)).rejects.toThrow("injected failure before PID capture")
    pid = Number(readFileSync(join(workspace, "owned-process.pid"), "utf8"))
    expect(Number.isSafeInteger(pid) && pid > 1).toBe(true)
    expect(() => process.kill(pid!, 0)).toThrow()
  } finally {
    try {
      try { pid ??= Number(readFileSync(join(workspace, "owned-process.pid"), "utf8")) } catch {}
      if (pid && Number.isSafeInteger(pid) && pid > 1) {
        try { process.kill(pid, "SIGKILL") } catch {}
        await bounded((async () => { for (;;) { try { process.kill(pid!, 0) } catch { return }; await Bun.sleep(20) } })(), "regression process cleanup")
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
}, 90_000)

if (mode === "native") test("package Codex native pair supports metadata, executor operations and workspace restart without credentials", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "genio-codex-native-")))
  const workspace = join(root, "workspace")
  mkdirSync(workspace)
  try {
    const binary = nativeBinary()
    const version = start(binary, ["--version"], join(root, "version"), workspace)
    let output = ""
    version.child.stdout.on("data", (chunk) => { output += chunk.toString() })
    try {
      version.child.stdin.end()
      expect(await bounded(version.exited, "binary version")).toBe(0)
      expect(output.trim()).toBe(`codex-cli ${botPackage.devDependencies["@openai/codex"]}`)
      console.info(`package binary ${binary}: ${output.trim()}`)
    } finally {
      if (version.child.exitCode === null && version.child.signalCode === null) version.child.kill("SIGKILL")
      await bounded(version.exited, "version cleanup")
    }
    await cycle(binary, join(root, "initial"), workspace, false)
    await cycle(binary, join(root, "restart"), workspace, true)
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 90_000)

const migrationBaseline = process.env.GENIO_CODEX_MIGRATION_BASELINE_BINARY

if (mode === "migration") test("0.162 native config survives reopening with the upgraded package", async () => {
  if (!migrationBaseline) throw new Error("GENIO_CODEX_MIGRATION_BASELINE_BINARY must point to a retained package-owned 0.162.0 native executable")
  const root = realpathSync(mkdtempSync(join(tmpdir(), "genio-codex-migration-")))
  const workspace = join(root, "workspace")
  mkdirSync(workspace)
  try {
    const baseline = realpathSync(migrationBaseline!)
    const version = start(baseline, ["--version"], join(root, "version"), workspace)
    let reported = ""
    version.child.stdout.on("data", (chunk) => { reported += chunk.toString() })
    try {
      version.child.stdin.end()
      expect(await bounded(version.exited, "migration baseline version")).toBe(0)
      expect(reported.trim()).toBe("codex-cli 0.162.0")
    } finally {
      if (version.child.exitCode === null && version.child.signalCode === null) version.child.kill("SIGKILL")
      await bounded(version.exited, "migration version cleanup")
    }
    let savedConfig: Buffer | undefined
    for (const [index, binary] of [baseline, nativeBinary()].entries()) {
      const app = start(binary, ["app-server", "-c", "analytics.enabled=false"], join(root, "persisted"), workspace)
      try {
        await app.rpc.request("initialize", { clientInfo: { name: "genio_config_migration", version: "1.0" }, capabilities: { experimentalApi: true } })
        app.rpc.notify("initialized")
        if (index === 0) {
          for (const [keyPath, value] of [["approval_policy", "on-request"], ["sandbox_mode", "read-only"]]) {
            await app.rpc.request("config/value/write", { keyPath, value, mergeStrategy: "replace" })
          }
          savedConfig = readFileSync(join(root, "persisted/codex/config.toml"))
        }
        const { config } = await app.rpc.request("config/read", { cwd: workspace })
        expect(config.approval_policy).toBe("on-request")
        expect(config.sandbox_mode).toBe("read-only")
        const started = await app.rpc.request("thread/start", { cwd: workspace })
        expect(started.approvalPolicy).toBe("on-request")
        expect(started.sandbox.type).toBe("readOnly")
        expect(readFileSync(join(root, "persisted/codex/config.toml")).equals(savedConfig!)).toBe(true)
        app.child.stdin.end()
        expect(await bounded(app.exited, "migration app shutdown")).toBe(0)
      } finally {
        if (app.child.exitCode === null && app.child.signalCode === null) app.child.kill("SIGKILL")
        await bounded(app.exited, "migration app cleanup")
      }
    }
    console.info("0.162 -> package upgrade preserved native config bytes and effective on-request/read-only thread defaults; saved rollout and pending approval migration remain untested")
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 60_000)
