import { randomUUID } from "node:crypto"
import { CodexRpcChannels } from "./codex-rpc-channels"
import { PendingInteractions } from "./pending-interactions"
import type { ManagedMcpEndpoints } from "./ce-demo-mcp"

import {
  PendingRuntime,
  type CodexRuntime,
  type ManagedDesktop,
  type RuntimeCallbacks,
  type RuntimeDetails,
  type RuntimeProvisionRequest,
  type RuntimeTier,
} from "./runtime"

export interface GenioPrincipal {
  tenant_id: string
  subject_id: string
  acting_client_id: string
  role?: string
  organization_ids?: string[]
  scopes: string[]
}

export interface RuntimeUsageContext {
  consumerOrganizationId: string
  useCaseId: string
}

export interface RuntimeProvider {
  provision(request: RuntimeProvisionRequest, callbacks: Pick<RuntimeCallbacks, "onExit">): Promise<ManagedDesktop>
}

export interface RuntimeSession {
  id: string
  principal: GenioPrincipal
  details: RuntimeDetails
  runtimeDetails: Partial<Record<RuntimeTier, RuntimeDetails>>
  leases: Partial<Record<Exclude<RuntimeTier, "none">, ManagedDesktop>>
  desktop: ManagedDesktop
  codex?: CodexRuntime
  initialized?: boolean
  initializeResult?: unknown
  activeThreadId?: string | null
  accessToken?: string
  modelRoute?: "codex-subscription" | "genio-gateway"
  selectedBotId?: string | null
  usageContext?: RuntimeUsageContext | null
  managedMcpEndpoints?: ManagedMcpEndpoints
  eventBuffer: string[]
}

interface ManagedRuntimeSession {
  callbacks: RuntimeCallbacks
  interactions: PendingInteractions
  rpcChannels: CodexRpcChannels
  session: RuntimeSession
  principalKey: string
  listeners: Set<RuntimeCallbacks>
  disconnectTimer: ReturnType<typeof setTimeout> | null
  eventBuffer: string[]
}

const executableTiers = new Set<Exclude<RuntimeTier, "none">>(["headless", "desktop"])

export class RuntimeBroker {
  private readonly botTurnClaims = new Map<string, symbol>()

  claimBotTurn(botId: string): (() => void) | null {
    if (this.closing || this.botTurnClaims.has(botId)) return null
    const claim = Symbol(botId)
    this.botTurnClaims.set(botId, claim)
    return () => { if (this.botTurnClaims.get(botId) === claim) this.botTurnClaims.delete(botId) }
  }

  private closing = false
  isClosing() { return this.closing }
  private readonly invocationTasks = new Set<Promise<void>>()

  runInvocationTask(task: () => Promise<void>): Promise<void> {
    if (this.closing) return Promise.resolve()
    const pending = Promise.resolve().then(() => this.closing ? undefined : task())
    this.invocationTasks.add(pending)
    void pending.finally(() => this.invocationTasks.delete(pending)).catch(() => {})
    return pending
  }

  private readonly observers = new Set<(principal: GenioPrincipal, line: string, runtimeId: string) => void>()

  observe(observer: (principal: GenioPrincipal, line: string, runtimeId: string) => void) {
    this.observers.add(observer)
    return () => { this.observers.delete(observer) }
  }
  private readonly sessions = new Map<string, ManagedRuntimeSession>()
  private readonly principalSessions = new Map<string, string>()
  private readonly opening = new Map<string, Promise<ManagedRuntimeSession>>()
  private readonly tierProvisioning = new Map<string, Promise<RuntimeSession>>()

  constructor(
    private readonly provider: RuntimeProvider,
    private readonly disconnectGraceMs = 600_000,
  ) {}

  async start(
    principal: GenioPrincipal,
    callbacks: RuntimeCallbacks,
    codexFactory?: (callbacks: RuntimeCallbacks, runtimeSessionId: string) => CodexRuntime,
    accessToken?: string,
  ): Promise<RuntimeSession> {
    if (this.closing) throw new Error("RUNTIME_BROKER_CLOSING")
    const principalKey = this.principalKey(principal)
    const existingId = this.principalSessions.get(principalKey)
    const existing = existingId ? this.sessions.get(existingId) : null
    if (existing) {
      if (!existing.session.codex && codexFactory) {
        existing.session.initialized = false
        existing.session.initializeResult = undefined
        existing.session.codex = codexFactory(existing.callbacks, existing.session.id)
      }
      if (existing.disconnectTimer) clearTimeout(existing.disconnectTimer)
      existing.disconnectTimer = null
      existing.listeners.add(callbacks)
      if (accessToken && existing.session.accessToken !== accessToken) {
        existing.session.accessToken = accessToken
        if (existing.session.codex?.updateToken) {
          void existing.session.codex.updateToken(accessToken)
        }
      }
      console.info(JSON.stringify({
        event: "runtime.broker.reattached",
        runtime_session_id: existing.session.id,
        tenant_id: principal.tenant_id,
        subject_id: principal.subject_id,
        provider: existing.session.details.kind,
        tier: existing.session.details.tier,
        sandbox_id: existing.session.details.sandboxId,
      }))
      const replayBuffer = [...existing.eventBuffer]
      existing.eventBuffer.length = 0
      for (const line of replayBuffer) {
        try {
          callbacks.onMessage(line)
        } catch (error) {
          console.warn("Failed to replay message to reconnected socket:", error)
        }
      }
      return existing.session
    }

    const pending = this.opening.get(principalKey)
    if (pending) {
      const managed = await pending
      managed.listeners.add(callbacks)
      return managed.session
    }

    const opening = this.openSession(principal, principalKey, callbacks, codexFactory, accessToken)
    this.opening.set(principalKey, opening)
    try {
      return (await opening).session
    } finally {
      this.opening.delete(principalKey)
    }
  }

  async ensure(
    id: string,
    tier: Exclude<RuntimeTier, "none"> = "headless",
    botId?: string,
  ): Promise<RuntimeSession> {
    if (this.closing) throw new Error("RUNTIME_BROKER_CLOSING")
    if (!executableTiers.has(tier)) throw new Error("RUNTIME_TIER_INVALID")
    const managed = this.sessions.get(id)
    if (!managed) throw new Error("RUNTIME_SESSION_NOT_FOUND")
    const current = managed.session.leases[tier]
    if (current) {
      if (current.details.kind === "endpoint" && (!current.details.execReady || current.details.endpoint?.botId !== botId)) throw new Error("LOCAL_HANDS_DISCONNECTED")
      managed.session.details = current.details
      managed.session.runtimeDetails[tier] = current.details
      return managed.session
    }
    if (managed.session.details.kind === "local") throw new Error("LOCAL_RUNTIME_HAS_NO_EXEC")
    const key = `${id}:${tier}`
    const pending = this.tierProvisioning.get(key)
    if (pending) return pending
    const provisioning = this.provisionTier(managed, tier, botId)
    this.tierProvisioning.set(key, provisioning)
    try {
      return await provisioning
    } finally {
      this.tierProvisioning.delete(key)
    }
  }

  async ensureExec(id: string, botId?: string) {
    return this.ensure(id, "headless", botId)
  }

  attachEndpoint(id: string, desktop: ManagedDesktop) {
    const managed = this.sessions.get(id)
    if (!managed || this.closing) throw new Error("RUNTIME_SESSION_NOT_FOUND")
    if (managed.session.leases.headless || this.tierProvisioning.has(`${id}:headless`)) throw new Error("LOCAL_HANDS_RUNTIME_CONFLICT")
    const session = managed.session
    session.leases.headless = desktop
    session.runtimeDetails.headless = desktop.details
    session.details = desktop.details
    session.desktop = desktop
    this.notifyEndpoint(id, "genio/runtime/ready", { ...desktop.details, runtimeSessionId: id })
  }

  notifyEndpoint(id: string, method: string, params: Record<string, unknown>) {
    const managed = this.sessions.get(id)
    if (!managed) return
    const event = JSON.stringify({ method, params })
    for (const listener of managed.listeners) listener.onMessage(event)
  }

  private async openSession(
    principal: GenioPrincipal,
    principalKey: string,
    callbacks: RuntimeCallbacks,
    codexFactory?: (callbacks: RuntimeCallbacks, runtimeSessionId: string) => CodexRuntime,
    accessToken?: string,
  ) {
    const id = randomUUID()
    const listeners = new Set<RuntimeCallbacks>([callbacks])
    const eventBuffer: string[] = []
    const rpcChannels = new CodexRpcChannels()
    const interactions = new PendingInteractions()

    let currentSession: RuntimeSession | null = null
    let exited = false
    const brokerCallbacks: RuntimeCallbacks = {
      onMessage: (line: string) => {
        for (const observer of this.observers) observer(principal, line, id)
        let parsed: {
          id?: number | string
          result?: { thread?: { id?: string } }
          method?: string
          params?: { thread?: { id?: string } }
        } | null = null
        try {
          parsed = JSON.parse(line)
        } catch {}

        if (parsed) interactions.observe(parsed)

        if (parsed && rpcChannels.receive(parsed, (result) => {
          if (!currentSession) return
          currentSession.initializeResult = result
          currentSession.initialized = true
        })) return

        if (parsed && currentSession) {
          if (parsed.id === 1 && parsed.result && !currentSession.initializeResult) {
            currentSession.initializeResult = parsed.result
            currentSession.initialized = true
          }
          if (parsed.result?.thread?.id) currentSession.activeThreadId = parsed.result.thread.id
          if (parsed.method === "thread/started" && parsed.params?.thread?.id) {
            currentSession.activeThreadId = parsed.params.thread.id
          }
        }

        if (listeners.size === 0) {
          eventBuffer.push(line)
          if (eventBuffer.length > 200) eventBuffer.shift()
        }
        for (const listener of listeners) {
          try {
            listener.onMessage(line)
          } catch (error) {
            console.warn("Failed to dispatch line to listener:", error)
          }
        }
      },
      onExit: (reason: string) => {
        exited = true
        for (const listener of listeners) {
          try {
            listener.onExit(reason)
          } catch {}
        }
        void this.stop(id)
      },
    }

    const codex = codexFactory ? codexFactory(brokerCallbacks, id) : undefined
    const pending = new PendingRuntime()
    const session: RuntimeSession = {
      id,
      principal,
      details: pending.details,
      runtimeDetails: { none: pending.details },
      leases: {},
      desktop: pending,
      codex,
      accessToken,
      selectedBotId: null,
      usageContext: null,
      eventBuffer,
    }
    currentSession = session
    const managed: ManagedRuntimeSession = { callbacks: brokerCallbacks, session, principalKey, listeners, disconnectTimer: null, eventBuffer, rpcChannels, interactions }
    if (!exited) {
      this.sessions.set(id, managed)
      this.principalSessions.set(principalKey, id)
    }
    console.info(JSON.stringify({
      event: "runtime.broker.started",
      runtime_session_id: id,
      tenant_id: principal.tenant_id,
      subject_id: principal.subject_id,
      provider: pending.details.kind,
      tier: "none",
      sandbox_id: pending.details.sandboxId,
      exec_ready: false,
    }))
    return managed
  }

  private async provisionTier(
    managed: ManagedRuntimeSession,
    tier: Exclude<RuntimeTier, "none">,
    botId?: string,
  ) {
    const session = managed.session
    const desktop = await this.provider.provision({
      runtimeSessionId: session.id,
      tenantId: session.principal.tenant_id,
      subjectId: session.principal.subject_id,
      actingClientId: session.principal.acting_client_id,
      ...(botId ? { botId } : {}),
      tier,
    }, {
      onExit: (reason) => {
        delete session.leases[tier]
        delete session.runtimeDetails[tier]
        if (session.details.tier === tier) {
          session.details = this.activeDetails(session)
          const fallbackLease = session.leases.desktop ?? session.leases.headless
          session.desktop = fallbackLease ?? new PendingRuntime(session.details)
        }
        console.warn(JSON.stringify({
          event: "runtime.broker.lease.exited",
          runtime_session_id: session.id,
          tier,
          reason,
        }))
        const event = JSON.stringify({ method: "genio/runtime/error", params: { tier, message: reason } })
        for (const listener of managed.listeners) listener.onMessage(event)
      },
    })
    if (!this.sessions.has(session.id)) {
      console.warn(JSON.stringify({ event: "runtime.broker.provision.aborted", runtime_session_id: session.id, tier }))
      await desktop.close().catch(() => undefined)
      throw new Error("RUNTIME_SESSION_ABORTED")
    }
    session.leases[tier] = desktop
    session.runtimeDetails[tier] = desktop.details
    session.details = desktop.details
    session.desktop = desktop
    console.info(JSON.stringify({
      event: "runtime.broker.lease.ready",
      runtime_session_id: session.id,
      tenant_id: session.principal.tenant_id,
      subject_id: session.principal.subject_id,
      tier,
      bot_id: botId ?? null,
      provider: desktop.details.kind,
      sandbox_id: desktop.details.sandboxId,
    }))
    return session
  }

  detach(id: string, callbacks: RuntimeCallbacks) {
    const managed = this.sessions.get(id)
    if (!managed) return
    managed.listeners.delete(callbacks)
    managed.rpcChannels.detach(callbacks)
    if (managed.listeners.size > 0 || managed.disconnectTimer) return
    managed.disconnectTimer = setTimeout(() => {
      managed.disconnectTimer = null
      void this.stop(id)
    }, this.disconnectGraceMs)
    console.info(JSON.stringify({
      event: "runtime.broker.detached",
      runtime_session_id: id,
      tenant_id: managed.session.principal.tenant_id,
      subject_id: managed.session.principal.subject_id,
      grace_ms: this.disconnectGraceMs,
    }))
  }

  listen(id: string, callbacks: RuntimeCallbacks) {
    const managed = this.sessions.get(id)
    if (!managed) return () => undefined
    if (managed.disconnectTimer) clearTimeout(managed.disconnectTimer)
    managed.disconnectTimer = null
    managed.listeners.add(callbacks)
    return () => this.detach(id, callbacks)
  }

  channel(id: string, callbacks: RuntimeCallbacks) {
    const managed = this.sessions.get(id)
    if (!managed?.session.codex) return null
    return managed.rpcChannels.channel(managed.session.codex, callbacks)
  }

  async request(id: string, method: string, params: unknown): Promise<any> {
    let channel: CodexRuntime | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise((resolve, reject) => {
        channel = this.channel(id, {
          onMessage(line) {
            try {
              const message = JSON.parse(line)
              if (message.error) reject(new Error(JSON.stringify(message.error)))
              else resolve(message.result)
            } catch (error) { reject(error) }
          },
          onExit(reason) { reject(new Error(reason)) },
        })
        if (!channel) { reject(new Error("RUNTIME_SESSION_NOT_FOUND")); return }
        timer = setTimeout(() => reject(new Error("BOT_RUNTIME_REQUEST_TIMEOUT")), 30_000)
        void channel.send(JSON.stringify({ id: 1, method, params })).catch(reject)
      })
    } finally {
      if (timer) clearTimeout(timer)
      if (channel) await (channel as CodexRuntime).close()
    }
  }

  async stop(id: string, tier?: Exclude<RuntimeTier, "none">) {
    const managed = this.sessions.get(id)
    if (!managed) return
    if (tier) {
      const lease = managed.session.leases[tier]
      if (!lease) return
      delete managed.session.leases[tier]
      delete managed.session.runtimeDetails[tier]
      await lease.close()
      if (managed.session.details.tier === tier) {
        managed.session.details = this.activeDetails(managed.session)
        const fallbackLease = managed.session.leases.desktop ?? managed.session.leases.headless
        managed.session.desktop = fallbackLease ?? new PendingRuntime(managed.session.details)
      }
      console.info(JSON.stringify({ event: "runtime.broker.lease.stopped", runtime_session_id: id, tier }))
      return
    }
    this.sessions.delete(id)
    if (this.principalSessions.get(managed.principalKey) === id) this.principalSessions.delete(managed.principalKey)
    if (managed.disconnectTimer) clearTimeout(managed.disconnectTimer)
    const session = managed.session
    if (session.codex) {
      try {
        await session.codex.close()
      } catch (error) {
        console.warn("Failed to close codex on session stop:", error)
      }
    }
    await Promise.all(Object.values(session.leases).map((lease) => lease?.close()))
    console.info(JSON.stringify({
      event: "runtime.broker.stopped",
      runtime_session_id: id,
      tenant_id: session.principal.tenant_id,
      subject_id: session.principal.subject_id,
      provider: session.details.kind,
      sandbox_id: session.details.sandboxId,
    }))
  }

  latestDetails() {
    return Array.from(this.sessions.values()).at(-1)?.session.details ?? null
  }

  latestRuntimeDetails() {
    return Array.from(this.sessions.values()).at(-1)?.session.runtimeDetails ?? null
  }

  get(id: string) {
    return this.sessions.get(id)?.session ?? null
  }

  pendingInteractions(id: string, threadId: string) {
    return this.sessions.get(id)?.interactions.list(threadId) ?? []
  }

  waitingFor(id: string, threadIds: string[]): "answer" | "approval" | undefined {
    const requests = threadIds.flatMap((threadId) => this.pendingInteractions(id, threadId)).filter((request) => request.method !== "item/tool/requestUserInput" || request.params.isBlocking !== false)
    if (requests.some((request) => request.method !== "item/tool/requestUserInput")) return "approval"
    return requests.length ? "answer" : undefined
  }

  async respondToInteraction(id: string, threadId: string, token: string, result: unknown) {
    const managed = this.sessions.get(id)
    if (!managed?.session.codex) throw new Error("BOT_INTERACTION_EXPIRED")
    const entry = managed.interactions.list(threadId).find((request) => request.genioRequestToken === token)
    await managed.interactions.respond(threadId, token, result, (line) => managed.session.codex!.send(line))
    if (entry) {
      const line = JSON.stringify({ method: "serverRequest/resolved", params: { threadId, requestId: entry.id } })
      for (const observer of this.observers) observer(managed.session.principal, line, id)
    }
  }

  findByPrincipal(principal: Pick<GenioPrincipal, "tenant_id" | "subject_id" | "acting_client_id">) {
    const id = this.principalSessions.get(`${principal.tenant_id}\u0000${principal.subject_id}\u0000${principal.acting_client_id}`)
    return id ? this.sessions.get(id)?.session ?? null : null
  }

  findBySubject(tenantId: string, subjectId: string) {
    return Array.from(this.sessions.values()).find((managed) =>
      managed.session.principal.tenant_id === tenantId && managed.session.principal.subject_id === subjectId,
    )?.session ?? null
  }

  activeCount() {
    return this.sessions.size
  }

  async close() {
    this.closing = true
    await Promise.allSettled([...this.opening.values(), ...this.tierProvisioning.values()])
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.stop(id)))
    await Promise.allSettled([...this.invocationTasks])
  }

  private principalKey(principal: GenioPrincipal) {
    return `${principal.tenant_id}\u0000${principal.subject_id}\u0000${principal.acting_client_id}`
  }

  private activeDetails(session: RuntimeSession): RuntimeDetails {
    return session.runtimeDetails.desktop ?? session.runtimeDetails.headless ?? session.runtimeDetails.none ?? new PendingRuntime().details
  }
}
