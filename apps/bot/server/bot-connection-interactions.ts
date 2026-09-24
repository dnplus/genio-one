import { randomUUID } from "node:crypto"

import type { BotToolResponse } from "./bot-tool-contract"
import type { GenioPrincipal } from "./runtime-broker"

type ConnectionState = "WAITING_CONNECTION" | "RESUMING" | "COMPLETED" | "CANCELLED" | "EXPIRED"
const connectionWaitMs = 90_000

type ConnectionRequest = {
  requestToken: string
  botId: string
  targetBotId: string
  threadId: string
  resourceId: string
  resourceName: string
  capabilityId: string
  reason: string
  resume: { tool: "add_enterprise_resource"; arguments: { botId: string; resourceId: string; capabilityId: string } }
}

type PendingInteraction = ConnectionRequest & {
  runtimeSessionId: string
  principal: GenioPrincipal
  state: ConnectionState
  expiresAt: number
  retry: () => Promise<BotToolResponse>
  resolve: (result: BotToolResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type Delivery = {
  principal: GenioPrincipal
  botId: string
  runtimeSessionId: string
  send: (request: ConnectionRequest) => void
  expire?: (request: ConnectionRequest) => void
}

function samePrincipal(left: GenioPrincipal, right: GenioPrincipal) {
  return left.tenant_id === right.tenant_id && left.subject_id === right.subject_id && left.acting_client_id === right.acting_client_id
}

function validString(value: unknown, maxLength: number) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength
}

async function connectionState(accessToken: string, principal: GenioPrincipal, resourceId: string, connectionId: string) {
  let response: Response
  try {
    const origin = process.env.GENIO_ONE_PLATFORM_ORIGIN?.trim() || "http://127.0.0.1:58082"
    response = await fetch(new URL(`/v1/tenants/${encodeURIComponent(principal.tenant_id)}/me/resource-connections/${encodeURIComponent(resourceId)}`, origin), {
      headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(2_000),
    })
  } catch {
    throw new Error("CONNECTION_PLATFORM_UNAVAILABLE")
  }
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "CONNECTION_PLATFORM_FORBIDDEN" : "CONNECTION_PLATFORM_UNAVAILABLE")
  let rows: unknown
  try { rows = await response.json() } catch { throw new Error("CONNECTION_PLATFORM_INVALID_RESPONSE") }
  if (!Array.isArray(rows)) throw new Error("CONNECTION_PLATFORM_INVALID_RESPONSE")
  const connection = rows.find((row) => row && typeof row === "object" && !Array.isArray(row) && (row as Record<string, unknown>).connection_id === connectionId) as Record<string, unknown> | undefined
  if (!connection) return null
  if (connection.status === "CONNECTED") return "CONNECTED" as const
  if (connection.status === "SAVED" && connection.authentication === "PASSWORD") return "SAVED" as const
  return null
}

function annotateSavedCredential(response: BotToolResponse) {
  if (response.isError) return response
  return {
    ...response,
    content: response.content.map((entry) => {
      if (entry.type !== "text") return entry
      try {
        const value = JSON.parse(entry.text)
        if (!value || typeof value !== "object" || Array.isArray(value)) return entry
        return { ...entry, text: JSON.stringify({ ...value, connectionState: "SAVED", credentialSavedUnverified: true }) }
      } catch {
        return entry
      }
    }),
  }
}

export class BotConnectionInteractions {
  private readonly pending = new Map<string, PendingInteraction>()
  private readonly deliveries = new Set<Delivery>()

  constructor(private readonly waitMs = connectionWaitMs) {}

  begin(input: Omit<ConnectionRequest, "requestToken"> & { principal: GenioPrincipal; runtimeSessionId: string; retry: () => Promise<BotToolResponse> }) {
    if (!validString(input.botId, 128) || !validString(input.targetBotId, 128) || !validString(input.threadId, 256) || !validString(input.resourceId, 256) || !validString(input.resourceName, 512) || !validString(input.capabilityId, 256) || !validString(input.runtimeSessionId, 256)) throw new Error("BOT_CONNECTION_INTERACTION_INVALID")
    const requestToken = randomUUID()
    const expiresAt = Date.now() + this.waitMs
    let resolve!: (result: BotToolResponse) => void
    let reject!: (error: Error) => void
    const wait = new Promise<BotToolResponse>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject })
    const entry = {
      ...input,
      requestToken,
      expiresAt,
      state: "WAITING_CONNECTION" as const,
      resolve,
      reject,
      timer: setTimeout(() => this.expire(requestToken), Math.max(1, expiresAt - Date.now())),
    }
    entry.timer.unref()
    this.pending.set(requestToken, entry)
    this.deliver(entry)
    return { request: this.request(entry), wait }
  }

  subscribe(input: { principal: GenioPrincipal; botId: string; runtimeSessionId: string; send: (request: ConnectionRequest) => void; expire?: (request: ConnectionRequest) => void }) {
    const delivery: Delivery = { ...input }
    this.deliveries.add(delivery)
    for (const entry of this.pending.values()) {
      if (entry.state === "WAITING_CONNECTION" && entry.botId === input.botId && entry.runtimeSessionId === input.runtimeSessionId && samePrincipal(entry.principal, input.principal)) input.send(this.request(entry))
    }
    return () => this.deliveries.delete(delivery)
  }

  pendingRequests(input: { principal: GenioPrincipal; botId: string; runtimeSessionId: string; threadId: string }) {
    return [...this.pending.values()]
      .filter((entry) => entry.state === "WAITING_CONNECTION" && entry.botId === input.botId && entry.runtimeSessionId === input.runtimeSessionId && entry.threadId === input.threadId && samePrincipal(entry.principal, input.principal))
      .map((entry) => this.request(entry))
  }

  async complete(input: { principal: GenioPrincipal; runtimeSessionId: string; requestToken: unknown; botId: unknown; threadId: unknown; resourceId: unknown; connectionId: unknown; status: unknown; accessToken: string }) {
    const entry = this.pending.get(typeof input.requestToken === "string" ? input.requestToken : "")
    if (!entry || entry.state === "EXPIRED") throw new Error("BOT_CONNECTION_REQUEST_EXPIRED")
    if (entry.state === "CANCELLED") throw new Error("BOT_CONNECTION_REQUEST_CANCELLED")
    if (entry.state !== "WAITING_CONNECTION") throw new Error("BOT_CONNECTION_REQUEST_BUSY")
    if (!samePrincipal(entry.principal, input.principal) || entry.runtimeSessionId !== input.runtimeSessionId || entry.botId !== input.botId || entry.threadId !== input.threadId || entry.resourceId !== input.resourceId) throw new Error("BOT_CONNECTION_REQUEST_FORBIDDEN")
    if (!validString(input.connectionId, 256)) throw new Error("BOT_CONNECTION_ID_INVALID")
    const connectionId = input.connectionId
    if (typeof connectionId !== "string") throw new Error("BOT_CONNECTION_ID_INVALID")
    const currentState = await connectionState(input.accessToken, entry.principal, entry.resourceId, connectionId)
    if (!currentState || input.status !== currentState) throw new Error("BOT_CONNECTION_NOT_CONNECTED")
    const current = this.pending.get(entry.requestToken)
    const state = entry.state as ConnectionState
    if (state === "CANCELLED") throw new Error("BOT_CONNECTION_REQUEST_CANCELLED")
    if (current !== entry || state === "EXPIRED") throw new Error("BOT_CONNECTION_REQUEST_EXPIRED")
    if (state !== "WAITING_CONNECTION") throw new Error("BOT_CONNECTION_REQUEST_BUSY")
    entry.state = "RESUMING"
    clearTimeout(entry.timer)
    try {
      const result = currentState === "SAVED" ? annotateSavedCredential(await entry.retry()) : await entry.retry()
      entry.state = "COMPLETED"
      this.pending.delete(entry.requestToken)
      entry.resolve(result)
      return result
    } catch (error) {
      entry.state = "WAITING_CONNECTION"
      const remaining = entry.expiresAt - Date.now()
      if (remaining <= 0) this.expire(entry.requestToken)
      else {
        entry.timer = setTimeout(() => this.expire(entry.requestToken), remaining)
        entry.timer.unref()
        this.deliver(entry)
      }
      throw error
    }
  }

  cancel(input: { principal: GenioPrincipal; runtimeSessionId: string; requestToken: unknown; botId: unknown; threadId: unknown }) {
    const entry = this.pending.get(typeof input.requestToken === "string" ? input.requestToken : "")
    if (!entry || entry.state === "EXPIRED") throw new Error("BOT_CONNECTION_REQUEST_EXPIRED")
    if (!samePrincipal(entry.principal, input.principal) || entry.runtimeSessionId !== input.runtimeSessionId || entry.botId !== input.botId || entry.threadId !== input.threadId) throw new Error("BOT_CONNECTION_REQUEST_FORBIDDEN")
    if (entry.state !== "WAITING_CONNECTION") throw new Error("BOT_CONNECTION_REQUEST_BUSY")
    entry.state = "CANCELLED"
    clearTimeout(entry.timer)
    this.pending.delete(entry.requestToken)
    entry.reject(new Error("BOT_CONNECTION_REQUEST_CANCELLED"))
  }

  private expire(requestToken: string) {
    const entry = this.pending.get(requestToken)
    if (!entry || entry.state !== "WAITING_CONNECTION") return
    entry.state = "EXPIRED"
    this.pending.delete(requestToken)
    entry.reject(new Error("BOT_CONNECTION_REQUEST_EXPIRED"))
    const request = this.request(entry)
    for (const delivery of this.matchingDeliveries(entry)) delivery.expire?.(request)
  }

  private request(entry: PendingInteraction): ConnectionRequest {
    const { principal: _principal, runtimeSessionId: _runtimeSessionId, state: _state, expiresAt: _expiresAt, retry: _retry, resolve: _resolve, reject: _reject, timer: _timer, ...request } = entry
    return request
  }

  private deliver(entry: PendingInteraction) {
    const request = this.request(entry)
    for (const delivery of this.matchingDeliveries(entry)) delivery.send(request)
  }

  private matchingDeliveries(entry: PendingInteraction) {
    return [...this.deliveries].filter((delivery) => delivery.botId === entry.botId && delivery.runtimeSessionId === entry.runtimeSessionId && samePrincipal(delivery.principal, entry.principal))
  }
}
