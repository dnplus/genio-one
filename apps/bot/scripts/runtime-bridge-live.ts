import WebSocket from "ws"

const accessToken = process.env.GENIO_BOT_TEST_ACCESS_TOKEN?.trim()
if (!accessToken) throw new Error("GENIO_BOT_TEST_ACCESS_TOKEN_REQUIRED")

const socket = new WebSocket(process.env.GENIO_BOT_TEST_WEBSOCKET_URL?.trim() || "ws://127.0.0.1:5181/api/codex")
let sequence = 0
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
let runtimeReadyResolve: ((value: Record<string, unknown>) => void) | null = null
const runtimeReady = new Promise<Record<string, unknown>>((resolve) => {
  runtimeReadyResolve = resolve
})
let execReadyResolve: ((value: Record<string, unknown>) => void) | null = null
const execReady = new Promise<Record<string, unknown>>((resolve) => {
  execReadyResolve = resolve
})
let runtimeStoppedResolve: (() => void) | null = null
const runtimeStopped = new Promise<void>((resolve) => {
  runtimeStoppedResolve = resolve
})

socket.on("message", (payload) => {
  const message = JSON.parse(String(payload)) as Record<string, unknown>
  if (message.method === "genio/runtime/stopped") {
    runtimeStoppedResolve?.()
    return
  }
  if (message.method === "genio/runtimeReady") {
    runtimeReadyResolve?.(message.params as Record<string, unknown>)
    return
  }
  if (message.method === "genio/runtime/ready" || message.method === "genio/execReady") {
    execReadyResolve?.(message.params as Record<string, unknown>)
    return
  }
  if (typeof message.id !== "number" || message.method) return
  const request = pending.get(message.id)
  if (!request) return
  pending.delete(message.id)
  if (message.error) request.reject(new Error(JSON.stringify(message.error)))
  else request.resolve(message.result)
})

function request(method: string, params: unknown) {
  const id = ++sequence
  const result = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }))
  socket.send(JSON.stringify({ method, id, params }))
  return result
}

await new Promise<void>((resolve, reject) => {
  socket.once("open", resolve)
  socket.once("error", reject)
})
socket.send(JSON.stringify({ method: "genio/runtime/start", params: { accessToken } }))

const started = await Promise.race([
  runtimeReady,
  Bun.sleep(120_000).then(() => { throw new Error("RUNTIME_READY_TIMEOUT") }),
])
if (started.execReady) throw new Error("RUNTIME_STARTED_WITH_EAGER_SANDBOX")
socket.send(JSON.stringify({ method: "genio/runtime/ensure", params: { tier: "headless", botId: "bot-live-probe" } }))
const runtime = await Promise.race([
  execReady,
  Bun.sleep(120_000).then(() => { throw new Error("EXEC_READY_TIMEOUT") }),
])
await request("initialize", {
  clientInfo: { name: "genio_one_bot_live_probe", title: "Genio Bot Runtime Bridge Probe", version: "0.1.0" },
  capabilities: { experimentalApi: true, requestAttestation: false },
})
socket.send(JSON.stringify({ method: "initialized" }))

const environmentId = String(runtime.environmentId || "")
const execServerUrl = String(runtime.execServerUrl || "")
if (!environmentId || !execServerUrl) throw new Error("REMOTE_EXECUTOR_DETAILS_REQUIRED")
if (runtime.tier !== "headless") throw new Error(`HEADLESS_RUNTIME_REQUIRED ${JSON.stringify(runtime)}`)
await request("environment/add", {
  environmentId,
  execServerUrl,
  connectTimeoutMs: 30_000,
})
const info = await request("environment/info", { environmentId }) as {
  shell?: { name?: string; path?: string }
  cwd?: string
}
if (!info.shell?.name || info.cwd !== "file:///home/user") {
  throw new Error(`REMOTE_EXECUTOR_INFO_INVALID ${JSON.stringify(info)}`)
}

console.log(JSON.stringify({
  event: "genio-one-bot.runtime-bridge.ready",
  runtimeSessionId: runtime.runtimeSessionId,
  sandboxId: runtime.sandboxId,
  environmentId,
  shell: info.shell.name,
  cwd: info.cwd,
  agentLoopPlacement: "server",
  executorPlacement: "e2b",
}))
socket.send(JSON.stringify({ method: "genio/runtime/stop", params: {} }))
await Promise.race([runtimeStopped, Bun.sleep(10_000)])
socket.close()
