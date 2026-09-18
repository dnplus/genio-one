import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { EventEmitter } from "node:events"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import Fastify from "fastify"
import websocket from "@fastify/websocket"
import WebSocket from "ws"
import { BotRegistry } from "../../server/bot-registry"
import { RuntimeBroker } from "../../server/runtime-broker"
import { createCapabilityGate } from "../../server/capability-gate"
import { LocalHands, localHandsRoutes } from "../../server/local-hands"
import type { BotServerContext } from "../../server/context"
import type { RuntimePolicyDecision, RuntimePolicyReportInput } from "../../server/runtime-policy-contract"
import { createJsonLineCollector } from "../../server/jsonl"

function opened(socket: WebSocket) {
  return new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject) })
}

function rpc(socket: WebSocket) {
  let id = 0
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
  socket.on("message", (data) => {
    const value = JSON.parse(data.toString())
    const request = pending.get(value.id)
    if (!request) return
    pending.delete(value.id)
    if (value.error) request.reject(new Error(JSON.stringify(value.error)))
    else request.resolve(value.result)
  })
  socket.on("close", () => { for (const request of pending.values()) request.reject(new Error("socket closed")); pending.clear() })
  return (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const next = ++id
    const timer = setTimeout(() => { pending.delete(next); reject(new Error(`RPC timeout: ${method}`)) }, 10_000)
    pending.set(next, { resolve: (value) => { clearTimeout(timer); resolve(value) }, reject: (error) => { clearTimeout(timer); reject(error) } })
    socket.send(JSON.stringify({ id: next, method, params }))
  })
}

test("Local Hands runs real Endpoint exec-server commands, reports outcomes, blocks revoked policy and never falls back", async () => {
  const directory = mkdtempSync(join(tmpdir(), "genio-local-hands-test-"))
  const registry = new BotRegistry(join(directory, "registry.sqlite"), join(directory, "artifacts"))
  const broker = new RuntimeBroker({ provision: async () => { throw new Error("unexpected cloud provisioning") } })
  const principal = { tenant_id: "local-hands-test", subject_id: "test-owner", acting_client_id: "genio-one-bot", scopes: [] }
  const bot = registry.create(principal, { name: "Local Hands test", description: "Dedicated integration test" })
  const receipts: RuntimePolicyReportInput[] = []
  let deny = false
  let runtimeReady: (value: any) => void = () => {}
  const session = await broker.start(principal, { onMessage: (line) => { const value = JSON.parse(line); if (value.method === "genio/runtime/ready") runtimeReady(value.params) }, onExit() {} }, undefined, "test-token")
  session.selectedBotId = bot.id
  const context = {
    botRegistry: registry, runtimeBroker: broker, capabilityGate: createCapabilityGate({ mode: "open" }),
    runtimePolicy: {
      authorize: async (input: any): Promise<RuntimePolicyDecision> => ({ tenant_id: principal.tenant_id, subject_id: principal.subject_id, client_id: principal.acting_client_id, bot_id: bot.id, runtime_id: "codex", capability_id: input.capabilityId, action: input.action, target: `runtime:codex:${input.capabilityId}`, decision: deny ? "DENY" : "ALLOW", reason_code: deny ? "TEST_POLICY_REVOKED" : "TEST_POLICY_ALLOWED", policy_id: "test-policy", policy_display_name: "Test policy", policy_revision: 1, constraints: [], obligations: [{ kind: "audit", parameters: {} }], session_id: session.id, correlation_id: input.correlationId, evaluated_at: Date.now() }),
      report: async (input: RuntimePolicyReportInput) => {
        const previous = receipts.find((receipt) => receipt.correlationId === input.correlationId)
        if (previous && previous.outcome !== input.outcome) throw new Error("RUNTIME_REPORT_CORRELATION_CONFLICT")
        if (!previous) receipts.push(input)
      },
    },
  } as unknown as BotServerContext
  const hands = new LocalHands(context)
  context.localHands = hands
  const app = Fastify()
  await app.register(websocket)
  await localHandsRoutes(app, context)
  const origin = await app.listen({ host: "127.0.0.1", port: 0 })
  let child: ReturnType<typeof spawn> | undefined
  let consumer: WebSocket | undefined
  let appServer: ReturnType<typeof spawn> | undefined
  try {
    const pairing = await hands.pair(session, bot.id)
    const connected = new Promise<any>((resolve) => { runtimeReady = resolve })
    child = spawn(resolve(import.meta.dir, "../../../../target/debug/genio-endpoint-hands"), ["--bot-url", origin, "--workspace", directory, "--codex", resolve(import.meta.dir, "../../node_modules/.bin/codex")], { env: { ...process.env, GENIO_ONE_LOCAL_HANDS_TOKEN: pairing.token }, stdio: ["ignore", "ignore", "pipe"] })
    let diagnostics = ""
    child.stderr?.on("data", (data) => { diagnostics += data.toString() })
    const details = await Promise.race([connected, new Promise<never>((_, reject) => { child!.once("error", reject); child!.once("exit", (code) => reject(new Error(`endpoint exited ${code}: ${diagnostics}`))) })])
    expect(details.kind).toBe("endpoint")
    expect(details.cwd).toBe(realpathSync(directory))
    const wrong = new WebSocket(`${origin.replace("http", "ws")}/api/local-hands/executor/${details.environmentId}?token=wrong`)
    const wrongClosed = new Promise<number>((resolve) => wrong.once("close", (code) => resolve(code)))
    expect(await wrongClosed).toBe(1008)
    const reused = new WebSocket(`${origin.replace("http", "ws")}/api/local-hands/connect`)
    await opened(reused)
    const reusedClosed = new Promise<number>((resolve) => reused.once("close", (code) => resolve(code)))
    reused.send(JSON.stringify({ token: pairing.token }))
    expect(await reusedClosed).toBe(1008)
    consumer = new WebSocket(hands.executorUrl(details.environmentId))
    const request = rpc(consumer)
    await opened(consumer)
    const init = await request("initialize", { clientName: "genio-local-hands-integration" })
    expect(init.sessionId).toBeTruthy()
    consumer.send(JSON.stringify({ method: "initialized", params: {} }))
    const file = join(directory, "result.txt")
    const processId = "local-hands-command"
    const exited = new Promise<any>((resolve) => consumer!.on("message", (data) => { const value = JSON.parse(data.toString()); if (value.method === "process/exited" && value.params.processId === processId) resolve(value.params) }))
    await request("process/start", { processId, argv: ["/bin/sh", "-c", "printf 'created on endpoint' > result.txt; printf '\\nmodified on endpoint' >> result.txt"], cwd: pathToFileURL(details.cwd).href, env: { PATH: "/usr/bin:/bin" }, tty: false, pipeStdin: false })
    expect((await exited).exitCode).toBe(0)
    expect(readFileSync(file, "utf8")).toBe("created on endpoint\nmodified on endpoint")
    expect(receipts.some((item) => item.capabilityId === "shell.exec" && item.outcome === "COMPLETED")).toBe(true)
    await request("fs/writeFile", { path: pathToFileURL(file).href, dataBase64: Buffer.from("native filesystem edit").toString("base64") })
    expect(readFileSync(file, "utf8")).toBe("native filesystem edit")
    expect(receipts.some((item) => item.capabilityId === "filesystem.write" && item.outcome === "COMPLETED")).toBe(true)
    const runningPid = new Promise<number>((resolve) => consumer!.on("message", (data) => {
      const value = JSON.parse(data.toString())
      if (value.method === "process/output" && value.params.processId === "long-lived") resolve(Number(Buffer.from(value.params.chunk, "base64").toString()))
    }))
    await request("process/start", { processId: "long-lived", argv: ["/bin/sh", "-c", "printf '%s' \"$$\"; exec sleep 30"], cwd: pathToFileURL(details.cwd).href, env: { PATH: "/usr/bin:/bin" }, tty: false, pipeStdin: false })
    const pid = await runningPid
    expect(pid).toBeGreaterThan(1)
    deny = true
    await expect(request("process/start", { processId: "denied", argv: ["/bin/sh", "-c", "printf overwritten > result.txt"], cwd: pathToFileURL(details.cwd).href, env: {}, tty: false, pipeStdin: false })).rejects.toThrow("socket closed")
    expect(readFileSync(file, "utf8")).toBe("native filesystem edit")
    expect(session.details.execReady).toBe(false)
    expect(session.details.kind).toBe("endpoint")
    const deadline = Date.now() + 5000
    let stopped = false
    while (Date.now() < deadline) {
      try { process.kill(pid, 0) } catch { stopped = true; break }
      await Bun.sleep(20)
    }
    expect(stopped).toBe(true)
    expect(receipts.some((item) => item.reasonCode === "LOCAL_HANDS_RESULT_UNCONFIRMED" && item.outcome === "FAILED")).toBe(true)
    await expect(broker.ensure(session.id, "headless", bot.id)).rejects.toThrow("LOCAL_HANDS_DISCONNECTED")
    await hands.stop(session, bot.id)
    expect(session.leases.headless).toBeUndefined()
    deny = false
    const secondPairing = await hands.pair(session, bot.id)
    const nextConnected = new Promise<any>((resolve) => { runtimeReady = resolve })
    child = spawn(resolve(import.meta.dir, "../../../../target/debug/genio-endpoint-hands"), ["--bot-url", origin, "--workspace", directory, "--codex", resolve(import.meta.dir, "../../node_modules/.bin/codex")], { env: { ...process.env, GENIO_ONE_LOCAL_HANDS_TOKEN: secondPairing.token }, stdio: "ignore" })
    const nextDetails = await nextConnected
    mkdirSync(join(directory, "appserver-home"))
    appServer = spawn(resolve(import.meta.dir, "../../node_modules/.bin/codex"), ["app-server", "-c", "analytics.enabled=false"], { env: { PATH: process.env.PATH, HOME: directory, CODEX_HOME: join(directory, "appserver-home") }, stdio: ["pipe", "pipe", "ignore"] })
    const transport = new EventEmitter() as unknown as WebSocket
    transport.send = (line) => { appServer!.stdin!.write(`${line}\n`) }
    appServer.stdout!.on("data", createJsonLineCollector((line) => transport.emit("message", Buffer.from(line))))
    appServer.once("exit", () => transport.emit("close"))
    const nativeRequest = rpc(transport)
    await nativeRequest("initialize", { clientInfo: { name: "genio_local_hands_native_test", version: "1.0" }, capabilities: { experimentalApi: true } })
    transport.send(JSON.stringify({ method: "initialized" }))
    await nativeRequest("environment/add", { environmentId: nextDetails.environmentId, execServerUrl: hands.executorUrl(nextDetails.environmentId), connectTimeoutMs: 10_000 })
    const environment = await nativeRequest("environment/info", { environmentId: nextDetails.environmentId })
    expect(environment.cwd).toBe(pathToFileURL(realpathSync(directory)).href)
    expect(environment.shell.name).toBeTruthy()
    await hands.stop(session, bot.id)
  } finally {
    consumer?.close()
    await hands.close()
    child?.kill("SIGTERM")
    appServer?.kill("SIGTERM")
    await app.close()
    await broker.close()
    registry.close()
    rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)
