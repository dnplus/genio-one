import { browserObserver } from "./browser-telemetry"
import type { ClientNotification } from "../../server/generated/ClientNotification"
import type { ClientRequest } from "../../server/generated/ClientRequest"
import type { ServerNotification } from "../../server/generated/ServerNotification"
import type { ServerRequest } from "../../server/generated/ServerRequest"

export interface RuntimeDetails {
  kind: "e2b-self-hosted" | "local" | "endpoint"
  tier: "none" | "headless" | "desktop"
  cwd: string
  desktopUrl: string | null
  sandboxId: string | null
  environmentId: string | null
  execServerUrl: string | null
  execReady: boolean
  endpoint?: { botId: string; hostname: string; expiresAt: number }
  modelDirectory?: "codex-subscription" | "genio-gateway"
}

export function runtimeCanExec(runtime: RuntimeDetails | null | undefined) {
  return Boolean(runtime?.execReady && runtime.tier !== "none")
}

export interface CodexModel {
  id: string
  displayName: string
  description: string
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>
}

type MessageHandler = (message: Record<string, unknown>) => void
type CodexOutbound = (ClientRequest | ClientNotification | { id: number; result: unknown }) & { genioTraceparent?: string }
type RequestMethod = ClientRequest["method"]
type RequestParams<Method extends RequestMethod> = Extract<ClientRequest, { method: Method }>["params"]
type NotificationMethod = ClientNotification["method"]
type CodexInbound = ServerRequest | ServerNotification | {
  id: number
  result?: unknown
  error?: unknown
}

function protocolErrorMessage(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const error = value as { message?: unknown; code?: unknown }
    if (typeof error.message === "string" && error.message.trim()) return error.message
    if (typeof error.code === "string" && error.code.trim()) return error.code
  }
  return typeof value === "string" && value.trim() ? value : "CODEX_REQUEST_FAILED"
}

export type ConnectionStatus = "connected" | "connecting" | "disconnected" | "reconnecting"

export class CodexClient {
  private observations = new Map<number, ReturnType<typeof browserObserver.begin>>()
  private interactions = new Map<number | string, { threadId: string; token: string }>()
  private socket: WebSocket | null = null
  private sequence = 0
  private pending = new Map<number, {
    resolve(value: unknown): void
    reject(error: Error): void
  }>()
  private handlers = new Set<MessageHandler>()
  private closeHandlers = new Set<(event: CloseEvent) => void>()
  private statusHandlers = new Set<(status: ConnectionStatus) => void>()
  private accessToken: string | null = null
  private manualClosed = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0

  private isProtocolReady = false
  private outboundQueue: CodexOutbound[] = []
  private readyListeners: Array<{ resolve: () => void; reject: (error: Error) => void }> = []

  onMessage(handler: MessageHandler) {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  onClose(handler: (event: CloseEvent) => void) {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  onStatusChange(handler: (status: ConnectionStatus) => void) {
    this.statusHandlers.add(handler)
    return () => this.statusHandlers.delete(handler)
  }

  private setStatus(status: ConnectionStatus) {
    for (const handler of this.statusHandlers) handler(status)
  }

  async connect(accessToken: string) {
    this.manualClosed = false
    this.accessToken = accessToken
    if (this.socket?.readyState === WebSocket.OPEN && this.isProtocolReady) return
    this.setStatus("connecting")
    await this.setupSocket()
  }

  updateAccessToken(accessToken: string) {
    const next = accessToken.trim()
    if (!next || next === this.accessToken) return
    this.accessToken = next
    if (this.socket?.readyState === WebSocket.OPEN && this.isProtocolReady) {
      this.socket.send(JSON.stringify({ method: "genio/runtime/start", params: { accessToken: next } }))
    }
  }

  private setupSocket(): Promise<void> {
    this.interactions.clear()
    if (this.socket) {
      for (const observation of this.observations.values()) observation.finish(0)
      this.observations.clear()
      for (const listener of this.readyListeners.splice(0)) listener.reject(new Error("CODEX_CONNECTION_REPLACED"))
      for (const request of this.pending.values()) request.reject(new Error("CODEX_CONNECTION_REPLACED"))
      this.pending.clear()
      try { this.socket.close() } catch {}
      this.socket = null
    }
    this.isProtocolReady = false
    this.outboundQueue = []

    const protocol = location.protocol === "https:" ? "wss:" : "ws:"
    const socket = new WebSocket(`${protocol}//${location.host}/api/codex`)
    this.socket = socket

    socket.addEventListener("message", (event) => { if (this.socket === socket) this.receive(String(event.data)) })
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return
      this.isProtocolReady = false
      this.outboundQueue = []
      const isSessionError = event.code === 1008 || event.reason?.includes("SESSION")
      const error = new Error(event.reason || (isSessionError ? "GENIO_ONE_SESSION_REJECTED" : "CODEX_CONNECTION_CLOSED"))

      for (const listener of this.readyListeners.splice(0)) {
        listener.reject(error)
      }

      for (const observation of this.observations.values()) observation.finish(0)
      this.observations.clear()
      for (const request of this.pending.values()) request.reject(error)
      this.pending.clear()

      for (const handler of this.closeHandlers) handler(event)

      if (this.manualClosed || isSessionError) {
        this.setStatus("disconnected")
        return
      }

      this.scheduleReconnect()
    })

    return new Promise<void>((resolve, reject) => {
      const handshakeTimeout = setTimeout(() => {
        if (!this.isProtocolReady) {
          const timeoutErr = new Error("CODEX_HANDSHAKE_TIMEOUT")
          reject(timeoutErr)
          socket.close(1008, "HANDSHAKE_TIMEOUT")
        }
      }, 15000)

      this.readyListeners.push({
        resolve: () => {
          clearTimeout(handshakeTimeout)
          resolve()
        },
        reject: (err) => {
          clearTimeout(handshakeTimeout)
          reject(err)
        },
      })

      socket.addEventListener("open", () => {
        if (this.socket !== socket) return
        this.reconnectAttempts = 0
        if (this.accessToken) {
          socket.send(JSON.stringify({ method: "genio/runtime/start", params: { accessToken: this.accessToken } }))
        }
      }, { once: true })

      socket.addEventListener("error", () => {
        clearTimeout(handshakeTimeout)
        reject(new Error("CODEX_CONNECTION_FAILED"))
      }, { once: true })
    })
  }

  private scheduleReconnect() {
    if (this.manualClosed || this.reconnectTimer) return
    this.reconnectAttempts++
    const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts - 1), 10000)
    this.setStatus("reconnecting")
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      if (this.manualClosed) return
      try {
        await this.setupSocket()
      } catch {
        this.scheduleReconnect()
      }
    }, delay)
  }

  close() {
    this.manualClosed = true
    this.isProtocolReady = false
    this.outboundQueue = []
    for (const listener of this.readyListeners.splice(0)) {
      listener.reject(new Error("CODEX_CLIENT_CLOSED"))
    }
    for (const request of this.pending.values()) request.reject(new Error("CODEX_CLIENT_CLOSED"))
    this.pending.clear()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.socket?.close(1000, "CLIENT_CLOSED")
    this.socket = null
    this.setStatus("disconnected")
  }

  async initialize() {
    await this.request("initialize", {
      clientInfo: { name: "genio_one_bot", title: "Genio Bot", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
    this.notify("initialized")
  }

  request<Method extends RequestMethod>(method: Method, params: RequestParams<Method>, genioBotId?: string) {
    const id = ++this.sequence
    const response = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }))
    this.send({ method, id, params, ...(genioBotId ? { genioBotId } : {}) } as Extract<ClientRequest, { method: Method }>)
    return response
  }

  async respond(id: number | string, result: unknown) {
    const interaction = this.interactions.get(id)
    if (!interaction) throw new Error("待處理項目已失效，請重新連線後確認目前狀態。")
    await this.requestRaw("genio/request/respond", { threadId: interaction.threadId, requestToken: interaction.token, result })
    if (this.interactions.get(id) === interaction) this.interactions.delete(id)
    await this.restorePending(interaction.threadId).catch(() => {})
  }

  async restorePending(threadId: string, botId?: string) {
    const requests = await this.requestRaw("genio/thread/pending", { threadId }, botId) as Array<Record<string, unknown>>
    for (const [id, entry] of this.interactions) if (entry.threadId === threadId) this.interactions.delete(id)
    this.receive(JSON.stringify({ method: "genio/pending/reset", params: { threadId } }))
    for (const request of requests) this.receive(JSON.stringify(request))
  }

  notify<Method extends NotificationMethod>(method: Method) {
    this.send({ method } as Extract<ClientNotification, { method: Method }>)
  }

  notifyRaw(method: string, params?: unknown) {
    this.send({ method, ...(params === undefined ? {} : { params }) } as CodexOutbound)
  }

  requestRaw(method: string, params?: unknown, genioBotId?: string) {
    const id = ++this.sequence
    const response = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }))
    this.send({ method, id, params, ...(genioBotId ? { genioBotId } : {}) } as CodexOutbound)
    return response
  }

  private send(value: CodexOutbound) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("CODEX_NOT_CONNECTED")
    if ("id" in value && typeof value.id === "number" && "method" in value && !this.observations.has(value.id)) {
      const observation = browserObserver.begin(`rpc.${value.method}`, { transport: "websocket" })
      this.observations.set(value.id, observation)
      if (observation.traceparent) value = { ...value, genioTraceparent: observation.traceparent } as CodexOutbound
    }
    if (!this.isProtocolReady) {
      this.outboundQueue.push(value)
      return
    }
    this.socket.send(JSON.stringify(value))
  }

  private flushOutbound() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.isProtocolReady) return
    for (const item of this.outboundQueue.splice(0)) {
      this.socket.send(JSON.stringify(item))
    }
  }

  private receive(raw: string) {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(raw) as CodexInbound as Record<string, unknown>
    } catch {
      return
    }
    if (typeof message.id === "number" && !message.method) {
      this.observations.get(message.id)?.finish(message.error ? 500 : 200)
      this.observations.delete(message.id)
    }
    if ((typeof message.id === "string" || typeof message.id === "number") && typeof message.genioRequestToken === "string") {
      const params = message.params as { threadId?: string } | undefined
      if (params?.threadId) this.interactions.set(message.id, { threadId: params.threadId, token: message.genioRequestToken })
    }
    if (
      !this.isProtocolReady &&
      (message.method === "genio/codexReady" || message.method === "genio/runtimeReady")
    ) {
      this.isProtocolReady = true
      this.setStatus("connected")
      for (const listener of this.readyListeners.splice(0)) {
        listener.resolve()
      }
      this.flushOutbound()
    }
    const id = typeof message.id === "number" ? message.id : null
    if (id !== null && !message.method) {
      const request = this.pending.get(id)
      if (request) {
        this.pending.delete(id)
        if (message.error) request.reject(new Error(protocolErrorMessage(message.error)))
        else request.resolve(message.result)
      }
    }
    for (const handler of this.handlers) handler(message)
  }
}
