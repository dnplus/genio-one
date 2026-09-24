import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import WebSocket from "ws"
import type { FastifyInstance } from "fastify"
import { requestAccessToken, requestPrincipal } from "./auth"
import { assertCapability, PERSONAL_BOT_COMPUTER_USE } from "./capability-gate"
import type { BotServerContext } from "./context"
import type { RuntimeSession } from "./runtime-broker"
import type { ManagedDesktop } from "./runtime"
import { requireRuntimePolicyDecision, RuntimePolicyDeniedError } from "./runtime-policy"
import {
  defaultRuntimeCapabilityAction,
  type RuntimeCapabilityId,
} from "@genioone/protocol/runtime-capability-actions"
import type {
  RuntimePolicyDecision,
  RuntimePolicyExecutableAction,
} from "./runtime-policy-contract"
import { runtimePolicyDecisionTarget } from "./runtime-policy-contract"

const PAIRING_MS = 5 * 60_000
const LEASE_MS = 60 * 60_000
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024
const EXECUTOR_VERSION = "0.153.4"

type Pairing = { token: string; session: RuntimeSession; botId: string; expiresAt: number }
type Lease = {
  id: string; secret: string; session: RuntimeSession; botId: string; desktop: ManagedDesktop
  endpoint: WebSocket; consumer: WebSocket | null; timer: ReturnType<typeof setTimeout>
  heartbeat: ReturnType<typeof setInterval>; lastPongAt: number
  pending: Map<string, { decision: RuntimePolicyDecision; processId?: string }>
  processes: Map<string, RuntimePolicyDecision>; closed: boolean
}

function equalSecret(actual: unknown, expected: string) {
  return typeof actual === "string" && /^[a-f0-9]{64}$/.test(actual) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
}

function frame(data: WebSocket.RawData) {
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
}

export function executorMethodCapability(method: string): RuntimeCapabilityId | null {
  if (["initialize", "initialized", "environment/info"].includes(method)) return null
  if (method.startsWith("process/")) return "shell.exec"
  if (["fs/writeFile", "fs/createDirectory", "fs/remove", "fs/copy", "fs/rename"].includes(method)) return "filesystem.write"
  if (method.startsWith("fs/")) return "filesystem.read"
  throw new Error("LOCAL_HANDS_METHOD_UNSUPPORTED")
}

export class LocalHands {
  private readonly pairings = new Map<string, Pairing>()
  private readonly leases = new Map<string, Lease>()

  constructor(private readonly context: BotServerContext) {}

  private input(
    session: RuntimeSession,
    botId: string,
    capabilityId: RuntimeCapabilityId,
    action: RuntimePolicyExecutableAction,
  ) {
    if (!this.context.botRegistry.getOwned(botId, session.principal)) throw new Error("BOT_NOT_FOUND")
    return { principal: session.principal, botId, runtimeId: "codex", capabilityId, action, sessionId: session.id, accessToken: session.accessToken }
  }

  private inputForDecision(session: RuntimeSession, botId: string, decision: RuntimePolicyDecision) {
    const target = runtimePolicyDecisionTarget(decision)
    return this.input(session, botId, target.capabilityId, target.action)
  }

  private async authorize(
    session: RuntimeSession,
    botId: string,
    capabilityId: RuntimeCapabilityId,
    action: RuntimePolicyExecutableAction,
  ) {
    await assertCapability(this.context.capabilityGate, session.principal, PERSONAL_BOT_COMPUTER_USE, session.accessToken)
    const input = this.input(session, botId, capabilityId, action)
    const handsPlacement = capabilityId === "remote_hands.use" && action === "use"
      ? { mode: "enforce" as const, localEndpoint: true as const }
      : undefined
    const decision = await this.context.runtimePolicy.authorize({ ...input, correlationId: randomUUID(), ...(handsPlacement ? { handsPlacement } : {}) })
    try { return requireRuntimePolicyDecision(decision, handsPlacement) }
    catch (error) {
      const reasonCode = error instanceof RuntimePolicyDeniedError ? error.decision.reason_code : decision.reason_code
      if (decision.correlation_id) await this.context.runtimePolicy.report({ ...input, correlationId: decision.correlation_id, outcome: reasonCode === "POLICY_PLACEMENT_CHANGED" ? "FAILED" : "DENY", reasonCode })
      throw error
    }
  }

  private async reportDecision(session: RuntimeSession, botId: string, decision: RuntimePolicyDecision, outcome: "ALLOW" | "COMPLETED" | "FAILED", reasonCode?: string) {
    if (!decision.correlation_id) throw new Error("LOCAL_HANDS_AUDIT_CORRELATION_REQUIRED")
    await this.context.runtimePolicy.report({ ...this.inputForDecision(session, botId, decision), correlationId: decision.correlation_id, outcome, ...(reasonCode ? { reasonCode } : {}) })
  }

  private async report(lease: Lease, decision: RuntimePolicyDecision, outcome: "ALLOW" | "COMPLETED" | "FAILED", reasonCode?: string) {
    try {
      await this.reportDecision(lease.session, lease.botId, decision, outcome, reasonCode)
    } catch (error) {
      console.warn(JSON.stringify({ event: "endpoint.receipt.unconfirmed", endpoint_id: lease.id, correlation_id: decision.correlation_id ?? null, outcome }))
      throw error
    }
    console.info(JSON.stringify({ event: "endpoint.execution.receipt", endpoint_id: lease.id, runtime_session_id: lease.session.id, bot_id: lease.botId, correlation_id: decision.correlation_id, outcome, reason_code: reasonCode ?? null }))
  }

  async pair(session: RuntimeSession, botId: string) {
    if (session.selectedBotId !== botId) throw new Error("BOT_NOT_SELECTED")
    if (session.leases.headless) throw new Error("LOCAL_HANDS_RUNTIME_CONFLICT")
    if (this.context.botRegistry.timeline.activeTurns(botId).length) throw new Error("LOCAL_HANDS_TURN_RUNNING")
    const decision = await this.authorize(session, botId, "remote_hands.use", "expose")
    await this.reportDecision(session, botId, decision, "COMPLETED", "REMOTE_HANDS_PAIRING_EXPOSED")
    for (const [token, pairing] of this.pairings) if (pairing.expiresAt <= Date.now() || pairing.session.id === session.id) this.pairings.delete(token)
    const token = randomBytes(32).toString("hex")
    const expiresAt = Date.now() + PAIRING_MS
    this.pairings.set(token, { token, session, botId, expiresAt })
    return { token, expiresAt, executorVersion: EXECUTOR_VERSION }
  }

  executorUrl(environmentId: string) {
    const lease = this.leases.get(environmentId)
    if (!lease || lease.closed || !lease.desktop.details.execReady) throw new Error("LOCAL_HANDS_DISCONNECTED")
    return `${lease.desktop.details.execServerUrl}?token=${lease.secret}`
  }

  async stop(session: RuntimeSession, botId: string) {
    for (const [token, pairing] of this.pairings) if (pairing.session.id === session.id && pairing.botId === botId) this.pairings.delete(token)
    if (session.leases.headless?.details.endpoint?.botId !== botId) return
    await this.context.runtimeBroker.stop(session.id, "headless")
    this.context.runtimeBroker.notifyEndpoint(session.id, "genio/runtime/stopped", { tier: "headless", active: session.details })
  }

  private closeLease(lease: Lease, reason: string) {
    if (lease.closed) return
    lease.closed = true
    clearTimeout(lease.timer)
    clearInterval(lease.heartbeat)
    lease.desktop.details.execReady = false
    this.leases.delete(lease.id)
    this.context.runtimeBroker.detachEndpoint(lease.session.id, lease.desktop)
    lease.consumer?.close(1008, reason)
    lease.endpoint.close(1008, reason)
    const unresolved = new Map([...Array.from(lease.pending.values(), ({ decision }) => decision), ...lease.processes.values()].map((decision) => [decision.correlation_id, decision]))
    for (const decision of unresolved.values()) void this.report(lease, decision, "FAILED", "LOCAL_HANDS_RESULT_UNCONFIRMED").catch(() => {})
    lease.pending.clear()
    lease.processes.clear()
    this.context.runtimeBroker.notifyEndpoint(lease.session.id, "genio/runtime/error", { tier: "headless", message: reason })
    console.info(JSON.stringify({ event: "endpoint.lease.closed", endpoint_id: lease.id, runtime_session_id: lease.session.id, reason }))
  }

  async accept(endpoint: WebSocket, hello: unknown, port: number) {
    const value = hello as { token?: unknown; version?: unknown; cwd?: unknown; hostname?: unknown; executorVersion?: unknown }
    const pairing = typeof value?.token === "string" ? this.pairings.get(value.token) : undefined
    if (!pairing || pairing.expiresAt <= Date.now()) throw new Error("LOCAL_HANDS_PAIRING_EXPIRED")
    this.pairings.delete(pairing.token)
    if (value.version !== 1 || value.executorVersion !== EXECUTOR_VERSION || typeof value.cwd !== "string" || !value.cwd.startsWith("/") || value.cwd.length > 4096 || /[\0\r\n]/.test(value.cwd) || typeof value.hostname !== "string" || !value.hostname.trim() || value.hostname.length > 256) throw new Error("LOCAL_HANDS_HELLO_INVALID")
    const { session, botId } = pairing
    if (this.context.runtimeBroker.get(session.id) !== session || session.selectedBotId !== botId || this.context.botRegistry.timeline.activeTurns(botId).length) throw new Error("LOCAL_HANDS_SESSION_CHANGED")
    await assertCapability(this.context.capabilityGate, session.principal, PERSONAL_BOT_COMPUTER_USE, session.accessToken)
    const decision = await this.authorize(session, botId, "remote_hands.use", "use")
    if (endpoint.readyState !== WebSocket.OPEN) {
      await this.reportDecision(session, botId, decision, "FAILED", "LOCAL_HANDS_DISCONNECTED")
      throw new Error("LOCAL_HANDS_DISCONNECTED")
    }
    const id = `endpoint-${randomUUID()}`
    const expiresAt = Date.now() + LEASE_MS
    const lease: Lease = {
      id, secret: randomBytes(32).toString("hex"), session, botId, endpoint, consumer: null,
      pending: new Map(), processes: new Map(), closed: false,
      lastPongAt: Date.now(),
      timer: setTimeout(() => this.closeLease(lease, "LOCAL_HANDS_LEASE_EXPIRED"), LEASE_MS),
      heartbeat: setInterval(() => {
        if (Date.now() - lease.lastPongAt > 30_000) this.closeLease(lease, "LOCAL_HANDS_HEARTBEAT_TIMEOUT")
        else if (endpoint.readyState === WebSocket.OPEN) endpoint.ping()
      }, 15_000),
      desktop: {
        details: { kind: "endpoint", tier: "headless", cwd: value.cwd, desktopUrl: null, sandboxId: null, environmentId: id, execServerUrl: `ws://127.0.0.1:${port}/api/local-hands/executor/${id}`, execReady: true, endpoint: { botId, hostname: value.hostname, expiresAt } },
        close: async () => { this.closeLease(lease, "LOCAL_HANDS_STOPPED") },
      },
    }
    lease.timer.unref()
    lease.heartbeat.unref()
    endpoint.on("pong", () => { lease.lastPongAt = Date.now() })
    this.leases.set(id, lease)
    let responseQueue = Promise.resolve()
    let responseBytes = 0
    endpoint.on("message", (data, binary) => {
      data = frame(data)
      const bytes = data.length
      if (binary || lease.closed || bytes > MAX_MESSAGE_BYTES - responseBytes) { this.closeLease(lease, "LOCAL_HANDS_FRAME_INVALID"); return }
      responseBytes += bytes
      responseQueue = responseQueue.then(async () => {
        if (binary || frame(data).length > MAX_MESSAGE_BYTES || lease.closed) throw new Error("LOCAL_HANDS_FRAME_INVALID")
        const message = JSON.parse(data.toString())
        const key = JSON.stringify(message.id)
        const pending = lease.pending.get(key)
        if (pending && !message.method) {
          lease.pending.delete(key)
          const failed = Boolean(message.error)
          if (pending.processId && failed) lease.processes.delete(pending.processId)
          if (!pending.processId || failed) await this.report(lease, pending.decision, failed ? "FAILED" : "COMPLETED", failed ? "LOCAL_HANDS_OPERATION_FAILED" : undefined)
        }
        if (message.method === "process/exited") {
          const decision = lease.processes.get(message.params?.processId)
          if (decision) {
            lease.processes.delete(message.params.processId)
            for (const [key, pending] of lease.pending) if (pending.processId === message.params.processId) lease.pending.delete(key)
            await this.report(lease, decision, message.params.exitCode === 0 ? "COMPLETED" : "FAILED")
          }
        }
        if (lease.consumer?.readyState !== WebSocket.OPEN || lease.consumer.bufferedAmount > MAX_MESSAGE_BYTES) throw new Error("LOCAL_HANDS_CONSUMER_UNAVAILABLE")
        lease.consumer.send(data, { binary: false })
      }).catch(() => this.closeLease(lease, "LOCAL_HANDS_RESULT_UNCONFIRMED")).finally(() => { responseBytes -= bytes })
    })
    endpoint.on("close", () => this.closeLease(lease, "LOCAL_HANDS_DISCONNECTED"))
    endpoint.on("error", () => this.closeLease(lease, "LOCAL_HANDS_DISCONNECTED"))
    let completionReportAttempted = false
    try {
      this.context.runtimeBroker.attachEndpoint(session.id, lease.desktop, false)
      completionReportAttempted = true
      await this.reportDecision(session, botId, decision, "COMPLETED", "REMOTE_HANDS_ENDPOINT_ACCEPTED")
      endpoint.send(JSON.stringify({ type: "ready", endpointId: id, expiresAt }))
      this.context.runtimeBroker.notifyEndpoint(session.id, "genio/runtime/ready", { ...lease.desktop.details, runtimeSessionId: session.id })
    } catch (error) {
      if (!completionReportAttempted) {
        try { await this.reportDecision(session, botId, decision, "FAILED", error instanceof Error ? error.message : "LOCAL_HANDS_ACCEPT_FAILED") } catch {}
      }
      this.closeLease(lease, "LOCAL_HANDS_RUNTIME_CONFLICT")
      throw error
    }
    console.info(JSON.stringify({ event: "endpoint.lease.ready", endpoint_id: id, runtime_session_id: session.id, bot_id: botId, expires_at: expiresAt }))
  }

  attachConsumer(id: string, token: unknown, consumer: WebSocket) {
    const lease = this.leases.get(id)
    if (!lease || lease.closed || lease.consumer || !equalSecret(token, lease.secret)) { consumer.close(1008, "LOCAL_HANDS_EXECUTOR_FORBIDDEN"); return }
    lease.consumer = consumer
    let queue = Promise.resolve()
    let requestBytes = 0
    consumer.on("message", (data, binary) => {
      data = frame(data)
      const bytes = data.length
      if (binary || lease.closed || bytes > MAX_MESSAGE_BYTES - requestBytes) { this.closeLease(lease, "LOCAL_HANDS_FRAME_INVALID"); return }
      requestBytes += bytes
      queue = queue.then(async () => {
        if (binary || frame(data).length > MAX_MESSAGE_BYTES || lease.closed || lease.endpoint.readyState !== WebSocket.OPEN || lease.endpoint.bufferedAmount > MAX_MESSAGE_BYTES) throw new Error("LOCAL_HANDS_DISCONNECTED")
        const message = JSON.parse(data.toString())
        if (typeof message.method !== "string") throw new Error("LOCAL_HANDS_REQUEST_INVALID")
        const capabilityId = executorMethodCapability(message.method)
        if (capabilityId) {
          if (message.id === undefined || lease.pending.size >= 64) throw new Error("LOCAL_HANDS_REQUEST_INVALID")
          const action = defaultRuntimeCapabilityAction(capabilityId)
          if (!action) throw new Error("RUNTIME_POLICY_CAPABILITY_INVALID")
          const placement = await this.authorize(lease.session, lease.botId, "remote_hands.use", "use")
          await this.reportDecision(lease.session, lease.botId, placement, "ALLOW", "LOCAL_HANDS_OPERATION_PLACEMENT_ALLOWED")
          if (lease.closed) throw new Error("LOCAL_HANDS_DISCONNECTED")
          const decision = await this.authorize(lease.session, lease.botId, capabilityId, action)
          if (lease.closed) throw new Error("LOCAL_HANDS_DISCONNECTED")
          const key = JSON.stringify(message.id)
          if (lease.pending.has(key)) throw new Error("LOCAL_HANDS_DUPLICATE_REQUEST")
          lease.pending.set(key, { decision, ...(message.method === "process/start" ? { processId: message.params?.processId } : {}) })
          if (message.method === "process/start") {
            if (typeof message.params?.processId !== "string" || lease.processes.has(message.params.processId)) throw new Error("LOCAL_HANDS_PROCESS_INVALID")
            lease.processes.set(message.params.processId, decision)
          }
        }
        lease.endpoint.send(data, { binary: false })
      }).catch(() => this.closeLease(lease, "LOCAL_HANDS_EXECUTION_DENIED")).finally(() => { requestBytes -= bytes })
    })
    consumer.on("close", () => this.closeLease(lease, "LOCAL_HANDS_DISCONNECTED"))
    consumer.on("error", () => this.closeLease(lease, "LOCAL_HANDS_DISCONNECTED"))
  }

  async close() {
    this.pairings.clear()
    for (const lease of this.leases.values()) this.closeLease(lease, "LOCAL_HANDS_STOPPED")
  }
}

export async function localHandsRoutes(app: FastifyInstance, context: BotServerContext) {
  const hands = context.localHands!
  app.post("/api/bots/:botId/local-hands/pair", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      const { botId } = request.params as { botId: string }
      if (!context.botRegistry.getOwned(botId, principal)) return reply.code(404).send({ error: "BOT_NOT_FOUND" })
      const session = context.runtimeBroker.findByPrincipal(principal)
      if (!session) return reply.code(409).send({ error: "RUNTIME_SESSION_NOT_FOUND" })
      session.accessToken = requestAccessToken(request)
      return reply.header("cache-control", "no-store").send(await hands.pair(session, botId))
    } catch (error) { return reply.code(403).send({ error: error instanceof Error ? error.message : "LOCAL_HANDS_PAIRING_FAILED" }) }
  })
  app.delete("/api/bots/:botId/local-hands", async (request, reply) => {
    try {
      const principal = await requestPrincipal(request)
      const { botId } = request.params as { botId: string }
      if (!context.botRegistry.getOwned(botId, principal)) return reply.code(404).send({ error: "BOT_NOT_FOUND" })
      const session = context.runtimeBroker.findByPrincipal(principal)
      if (session) await hands.stop(session, botId)
      return { stopped: true }
    } catch { return reply.code(401).send({ error: "GENIO_ONE_SESSION_REJECTED" }) }
  })
  app.get("/api/local-hands/connect", { websocket: true }, (socket) => {
    const timer = setTimeout(() => socket.close(1008, "LOCAL_HANDS_HELLO_REQUIRED"), 10_000)
    socket.once("message", (data, binary) => {
      clearTimeout(timer)
      const address = app.server.address()
      if (binary || frame(data).length > 8192 || !address || typeof address === "string") { socket.close(1008, "LOCAL_HANDS_HELLO_INVALID"); return }
      let hello: unknown
      try { hello = JSON.parse(data.toString()) } catch { socket.close(1008, "LOCAL_HANDS_HELLO_INVALID"); return }
      void hands.accept(socket, hello, address.port).catch((error) => socket.close(1008, error instanceof Error ? error.message : "LOCAL_HANDS_REJECTED"))
    })
    socket.on("error", () => clearTimeout(timer))
    socket.on("close", () => clearTimeout(timer))
  })
  app.get("/api/local-hands/executor/:id", { websocket: true, logLevel: "silent" }, (socket, request) => {
    if (request.headers.origin || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.ip)) { socket.close(1008, "LOCAL_HANDS_EXECUTOR_FORBIDDEN"); return }
    hands.attachConsumer((request.params as { id: string }).id, (request.query as { token?: string }).token, socket)
  })
}
