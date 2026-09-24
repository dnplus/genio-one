import { randomBytes, randomUUID } from "node:crypto"
import { CodexRpcChannels } from "./codex-rpc-channels"
import { PendingInteractions } from "./pending-interactions"
import type { ManagedMcpMounts } from "./managed-mcp"
import type { HandsWorkspace } from "@genioone/protocol/hands"
import type { BotWorkspaceStore } from "./bot-workspace-store"
import type { HandsPlacementGate } from "./hands-placement-gate"
import type { HandsAsset } from "./hands-assets"
import { issueHandsMcpGrant, revokeHandsMcpGrants, type HandsMcpGrantHolder, type HandsMcpProvision } from "./hands-mcp-grant"

import {
  PendingRuntime,
  configuredRuntimeKind,
  pendingRuntimeDetails,
  type CodexRuntime,
  type ManagedDesktop,
  type RuntimeCallbacks,
  type RuntimeDetails,
  type RuntimeProvisionRequest,
  type RuntimeTier,
  resolveHandsRelayOrigin,
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

export interface RuntimeSession extends HandsMcpGrantHolder {
  id: string
  relaySecret: string
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
  managedMcpMountsByBot?: Record<string, ManagedMcpMounts>
  eventBuffer: string[]
}

export interface BotSelection {
  botId: string
  usageContext: RuntimeUsageContext | null
  mcpMounts: ManagedMcpMounts
}

export function setBotSelection(session: RuntimeSession, selection: BotSelection | null) {
  session.selectedBotId = selection?.botId ?? null
  session.usageContext = selection?.usageContext ?? null
  if (selection) setManagedMcpMounts(session, selection.botId, selection.mcpMounts)
}

export function managedMcpMountsForBot(session: RuntimeSession, botId: string): ManagedMcpMounts {
  return session.managedMcpMountsByBot?.[botId] ?? {}
}

export function setManagedMcpMounts(session: RuntimeSession, botId: string, mounts: ManagedMcpMounts) {
  session.managedMcpMountsByBot = {
    ...session.managedMcpMountsByBot,
    [botId]: mounts,
  }
}

interface ManagedRuntimeSession {
  callbacks: RuntimeCallbacks
  interactions: PendingInteractions
  rpcChannels: CodexRpcChannels
  invocationAccessTokens: Map<string, { invocationId: string; accessToken: string }>
  session: RuntimeSession
  principalKey: string
  listeners: Set<RuntimeCallbacks>
  disconnectTimer: ReturnType<typeof setTimeout> | null
  eventBuffer: string[]
}

const executableTiers = new Set<Exclude<RuntimeTier, "none">>(["headless", "desktop"])

export class RuntimeBroker {
  private readonly botTurnClaims = new Map<string, { token: symbol; sessionId?: string }>()
  hasOtherBotTurn(sessionId: string, botId: string) {
    const session = this.sessions.get(sessionId)?.session
    return Boolean(session && Array.from(this.botTurnClaims).some(([current, claim]) => current !== botId && (claim.sessionId === sessionId || (!claim.sessionId && this.workspaces?.belongsToOwner(session.principal, current)))))
  }

  claimBotTurn(botId: string, sessionId?: string): (() => void) | null {
    if (this.closing || this.botTurnClaims.has(botId)) return null
    if (Array.from(this.stoppingSessions.keys()).some((id) => {
      const session = this.sessions.get(id)?.session
      return session && this.workspaces?.belongsToOwner(session.principal, botId)
    })) return null
    const claim = Symbol(botId)
    this.botTurnClaims.set(botId, { token: claim, sessionId })
    return () => { if (this.botTurnClaims.get(botId)?.token === claim) this.botTurnClaims.delete(botId) }
  }

  private closing = false
  isClosing() { return this.closing }
  hasProvisioning(id: string) { return this.tierProvisioning.has(id) }
  hasActiveBotLease(tenantId: string, ownerSubjectId: string, botId: string) {
    return Array.from(this.sessions.values()).some((managed) =>
      managed.session.principal.tenant_id === tenantId &&
      managed.session.principal.subject_id === ownerSubjectId &&
      (this.tierProvisioningTargets.get(managed.session.id)?.botId === botId || Object.values(managed.session.leases).some((lease) => lease?.details.botId === botId && lease.details.kind !== "endpoint")),
    )
  }
  hasActiveWorkspaceLease(workspaceId: string) {
    return Array.from(this.sessions.values()).some((managed) =>
      this.tierProvisioningTargets.get(managed.session.id)?.workspaceId === workspaceId || Object.values(managed.session.leases).some((lease) => lease?.details.workspaceId === workspaceId),
    )
  }
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
  private readonly tierProvisioningTargets = new Map<string, { botId: string | null; workspaceId: string | null }>()
  private readonly stoppingSessions = new Map<string, Promise<void>>()

  constructor(
    private readonly provider: RuntimeProvider,
    private readonly disconnectGraceMs = 600_000,
    private readonly workspaces?: BotWorkspaceStore,
    private readonly handsPlacement?: HandsPlacementGate,
    private readonly options: { handsAssets?: (principal: GenioPrincipal, botId: string) => HandsAsset[] } = {},
  ) {}

  refreshWorkspaceDetails(id: string) {
    const session = this.sessions.get(id)?.session
    if (!session) return
    const kind = configuredRuntimeKind()
    const workspace = kind !== "local" && session.selectedBotId && this.workspaces
      ? this.workspaces.active(session.principal, session.selectedBotId)
      : null
    const pending = pendingRuntimeDetails(kind === "local" ? kind : workspace?.provider ?? kind)
    pending.botId = session.selectedBotId ?? null
    pending.workspaceId = workspace?.workspaceId ?? null
    pending.workspaceRevision = workspace?.revision ?? null
    session.runtimeDetails.none = pending
    const active = Object.values(session.leases).find((lease) => lease?.details.execReady && lease.details.botId === session.selectedBotId && lease.details.workspaceId === workspace?.workspaceId)
    session.details = active?.details ?? pending
    session.desktop = active ?? new PendingRuntime(pending)
  }

  async start(
    principal: GenioPrincipal,
    callbacks: RuntimeCallbacks,
    codexFactory?: (callbacks: RuntimeCallbacks, runtimeSessionId: string, relaySecret: string) => CodexRuntime,
    accessToken?: string,
  ): Promise<RuntimeSession> {
    if (this.closing) throw new Error("RUNTIME_BROKER_CLOSING")
    const principalKey = this.principalKey(principal)
    const existingId = this.principalSessions.get(principalKey)
    const existing = existingId ? this.sessions.get(existingId) : null
    if (existing) {
      const stopping = this.stoppingSessions.get(existing.session.id)
      if (stopping) { await stopping; return this.start(principal, callbacks, codexFactory, accessToken) }
      if (!existing.session.codex && codexFactory) {
        existing.session.initialized = false
        existing.session.initializeResult = undefined
        existing.session.codex = codexFactory(existing.callbacks, existing.session.id, existing.session.relaySecret)
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
    if (this.stoppingSessions.has(id)) throw new Error("RUNTIME_BROKER_STOPPING")
    const managed = this.sessions.get(id)
    if (!managed) throw new Error("RUNTIME_SESSION_NOT_FOUND")
    const current = managed.session.leases[tier]
    if (current) {
      if (current.details.kind === "endpoint" && (!current.details.execReady || current.details.endpoint?.botId !== botId)) throw new Error("LOCAL_HANDS_DISCONNECTED")
      if (current.details.kind === "endpoint") {
        managed.session.details = current.details
        managed.session.runtimeDetails[tier] = current.details
        return managed.session
      }
    }
    if (managed.session.details.kind === "local") throw new Error("LOCAL_RUNTIME_HAS_NO_EXEC")
    const key = id
    const pending = this.tierProvisioning.get(key)
    if (pending) { await pending; return this.ensure(id, tier, botId) }
    const retry = this.workspaces?.unresolvedLeaseAttempt(managed.session.principal, id)
    if (retry && (retry.tier !== tier || retry.botId !== botId)) throw new Error("WORKSPACE_BUSY")
    if (Object.entries(managed.session.leases).some(([otherTier, lease]) => otherTier !== tier && lease && lease.details.kind !== "endpoint")) throw new Error("WORKSPACE_BUSY")
    const replaceCurrent = Boolean(current && current.details.kind !== "endpoint" && (current.details.botId ?? null) !== (botId ?? null))
    const activeWorkspaceId = botId && this.workspaces ? this.workspaces.active(managed.session.principal, botId)?.workspaceId ?? null : null
    this.tierProvisioningTargets.set(key, { botId: botId ?? null, workspaceId: activeWorkspaceId })
    const provisioning = Promise.resolve().then(async () => {
      if (replaceCurrent) await this.stopTier(id, managed, tier)
      return this.acquireTier(managed, tier, botId)
    })
    this.tierProvisioning.set(key, provisioning)
    try {
      return await provisioning
    } finally {
      this.tierProvisioning.delete(key)
      this.tierProvisioningTargets.delete(key)
    }
  }

  private async acquireTier(managed: ManagedRuntimeSession, tier: Exclude<RuntimeTier, "none">, botId?: string): Promise<RuntimeSession> {
    const session = managed.session
    const workspace = botId && this.workspaces
      ? this.handsPlacement
        ? await this.handsPlacement.ensureWorkspace({ principal: session.principal, botId, sessionId: session.id, accessToken: this.accessTokenForBot(session.id, botId) || "" })
        : this.workspaces.ensureActive(session.principal, botId)
      : undefined
    const retry = this.workspaces?.unresolvedLeaseAttempt(session.principal, session.id)
    if (retry && retry.workspaceId !== (workspace?.workspaceId ?? null)) throw new Error("WORKSPACE_BUSY")
    const target = this.tierProvisioningTargets.get(session.id)
    if (target) target.workspaceId = workspace?.workspaceId ?? null
    const current = session.leases[tier]
    if (current && current.details.execReady && (current.details.botId ?? null) === (botId ?? null) && (current.details.workspaceId ?? null) === (workspace?.workspaceId ?? null)) {
      session.details = current.details
      session.runtimeDetails[tier] = current.details
      return session
    }
    if (current || Object.entries(session.leases).some(([otherTier, lease]) => otherTier !== tier && lease && lease.details.kind !== "endpoint")) throw new Error("WORKSPACE_BUSY")
    if (workspace && this.workspaces?.active(session.principal, botId!)?.workspaceId !== workspace.workspaceId) throw new Error("WORKSPACE_CHANGED")
    const ready = await this.provisionTier(managed, tier, botId, workspace)
    if (workspace && this.workspaces?.active(session.principal, botId!)?.workspaceId !== workspace.workspaceId) {
      const lease = session.leases[tier]
      if (lease) {
        revokeHandsMcpGrants(session, tier)
        lease.details.execReady = false
        await lease.close()
        delete session.leases[tier]
        delete session.runtimeDetails[tier]
        this.refreshWorkspaceDetails(session.id)
      }
      throw new Error("WORKSPACE_CHANGED")
    }
    return ready
  }

  async ensureExec(id: string, botId?: string) {
    return this.ensure(id, "headless", botId)
  }

  attachEndpoint(id: string, desktop: ManagedDesktop, notify = true) {
    const managed = this.sessions.get(id)
    if (!managed || this.closing) throw new Error("RUNTIME_SESSION_NOT_FOUND")
    if (managed.session.leases.headless || this.tierProvisioning.has(id)) throw new Error("LOCAL_HANDS_RUNTIME_CONFLICT")
    const session = managed.session
    session.leases.headless = desktop
    session.runtimeDetails.headless = desktop.details
    session.details = desktop.details
    session.desktop = desktop
    if (notify) this.notifyEndpoint(id, "genio/runtime/ready", { ...desktop.details, runtimeSessionId: id })
  }

  detachEndpoint(id: string, desktop: ManagedDesktop) {
    const managed = this.sessions.get(id)
    if (!managed || managed.session.leases.headless !== desktop) return false
    const session = managed.session
    delete session.leases.headless
    delete session.runtimeDetails.headless
    if (session.desktop === desktop) {
      session.details = this.activeDetails(session)
      session.desktop = session.leases.desktop ?? new PendingRuntime(session.details)
    }
    console.info(JSON.stringify({ event: "runtime.broker.endpoint.detached", runtime_session_id: id }))
    return true
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
    codexFactory?: (callbacks: RuntimeCallbacks, runtimeSessionId: string, relaySecret: string) => CodexRuntime,
    accessToken?: string,
  ) {
    const id = randomUUID()
    const relaySecret = randomBytes(32).toString("base64url")
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

    const codex = codexFactory ? codexFactory(brokerCallbacks, id, relaySecret) : undefined
    const pending = new PendingRuntime()
    const session: RuntimeSession = {
      id,
      relaySecret,
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
    const managed: ManagedRuntimeSession = { callbacks: brokerCallbacks, session, principalKey, listeners, disconnectTimer: null, eventBuffer, rpcChannels, interactions, invocationAccessTokens: new Map() }
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

  private handsAssets(session: RuntimeSession, botId?: string): HandsAsset[] {
    if (!botId || !this.options.handsAssets) return []
    try {
      return this.options.handsAssets(session.principal, botId)
    } catch (error) {
      console.warn(JSON.stringify({ event: "runtime.broker.hands_assets.skipped", runtime_session_id: session.id, bot_id: botId, reason: error instanceof Error ? error.message : "HANDS_ASSET_UNAVAILABLE" }))
      return []
    }
  }

  private handsMcpProvision(session: RuntimeSession, tier: string, botId?: string): HandsMcpProvision | undefined {
    const relayOrigin = resolveHandsRelayOrigin()
    if (!relayOrigin || !botId) return undefined
    const mounts = managedMcpMountsForBot(session, botId)
    if (Object.keys(mounts).length === 0) return undefined
    return { token: issueHandsMcpGrant(session, { botId, tier }), relayOrigin, botId, mounts }
  }

  private async provisionTier(
    managed: ManagedRuntimeSession,
    tier: Exclude<RuntimeTier, "none">,
    botId?: string,
    workspace?: HandsWorkspace,
  ) {
    const session = managed.session
    const handsMcp = this.handsMcpProvision(session, tier, botId)
    const handsAssets = handsMcp ? this.handsAssets(session, botId) : []
    let provisionedLease: ManagedDesktop | null = null
    let earlyExitReason: string | null = null
    const cloudflare = workspace?.provider === "cloudflare-hands"
    const leaseRequestId = cloudflare && workspace && this.workspaces
      ? this.workspaces.reserveLeaseAttempt(workspace, tier, session.id, session.principal.acting_client_id)
      : randomUUID()
    let desktop: ManagedDesktop
    try {
      desktop = await this.provider.provision({
      runtimeSessionId: session.id,
      leaseRequestId,
      tenantId: session.principal.tenant_id,
      subjectId: session.principal.subject_id,
      actingClientId: session.principal.acting_client_id,
      ...(botId ? { botId } : {}),
      ...(workspace ? { workspace } : {}),
      tier,
      ...(handsMcp ? { handsMcp } : {}),
      ...(handsAssets.length > 0 ? { handsAssets } : {}),
    }, {
      onExit: (reason) => {
        if (!provisionedLease) { earlyExitReason = reason; return }
        if (session.leases[tier] !== provisionedLease || !provisionedLease.details.execReady) return
        void this.stop(session.id, tier).catch((error) => console.error(JSON.stringify({ event: "runtime.broker.lease.checkpoint_failed", runtime_session_id: session.id, tier, error: error instanceof Error ? error.message : String(error) })))
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
    } catch (error) {
      revokeHandsMcpGrants(session, tier)
      if (cloudflare && workspace && this.workspaces && error instanceof Error && error.message === "HANDS_LEASE_LOST") this.workspaces.rotateLostLeaseAttempt(workspace.workspaceId, tier, leaseRequestId)
      throw error
    }
    provisionedLease = desktop
    if (earlyExitReason) {
      revokeHandsMcpGrants(session, tier)
      await desktop.close().catch(() => undefined)
      throw new Error(`RUNTIME_LEASE_EXITED_BEFORE_READY:${earlyExitReason}`)
    }
    if (!this.sessions.has(session.id)) {
      revokeHandsMcpGrants(session, tier)
      console.warn(JSON.stringify({ event: "runtime.broker.provision.aborted", runtime_session_id: session.id, tier }))
      await desktop.close().catch(() => undefined)
      throw new Error("RUNTIME_SESSION_ABORTED")
    }
    if (cloudflare && workspace && this.workspaces) this.workspaces.markLeaseAttemptReady(workspace.workspaceId, tier, leaseRequestId)
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

  async stop(id: string, tier?: Exclude<RuntimeTier, "none">, expectedBotId?: string) {
    if (!tier) {
      const current = this.stoppingSessions.get(id)
      if (current) return current
      const pending = Promise.resolve().then(() => this.stopSession(id, expectedBotId))
      this.stoppingSessions.set(id, pending)
      try { await pending }
      finally { if (this.stoppingSessions.get(id) === pending) this.stoppingSessions.delete(id) }
      return
    }
    const managed = this.sessions.get(id)
    if (!managed) return
    const provisioning = this.tierProvisioning.get(id)
    if (provisioning) await provisioning.catch(() => undefined)
    if (expectedBotId && this.tierProvisioningTargets.get(id)?.botId && this.tierProvisioningTargets.get(id)?.botId !== expectedBotId) throw new Error("RUNTIME_WORKSPACE_NOT_OWNED")
    return this.stopTier(id, managed, tier, expectedBotId)
  }

  private async stopTier(id: string, managed: ManagedRuntimeSession, tier: Exclude<RuntimeTier, "none">, expectedBotId?: string) {
    const lease = managed.session.leases[tier]
    if (!lease) {
      if (this.workspaces?.unresolvedLeaseAttempt(managed.session.principal, id)?.tier === tier) throw new Error("HANDS_PROVISION_UNCONFIRMED")
      return
    }
    if (expectedBotId && (lease.details.botId ?? lease.details.endpoint?.botId) !== expectedBotId) throw new Error("RUNTIME_WORKSPACE_NOT_OWNED")
    revokeHandsMcpGrants(managed.session, tier)
    lease.details.execReady = false
    try { await lease.close() }
    catch (error) { lease.details.execReady = true; throw error }
    if (managed.session.leases[tier] !== lease) return
    delete managed.session.leases[tier]
    delete managed.session.runtimeDetails[tier]
    if (managed.session.details.tier === tier) this.refreshWorkspaceDetails(id)
    console.info(JSON.stringify({ event: "runtime.broker.lease.stopped", runtime_session_id: id, tier }))
  }

  private async stopSession(id: string, expectedBotId?: string) {
    const managed = this.sessions.get(id)
    if (!managed) return
    const provisioning = this.tierProvisioning.get(id)
    if (provisioning) await provisioning.catch(() => undefined)
    if (this.workspaces?.unresolvedLeaseAttempt(managed.session.principal, id)) throw new Error("HANDS_PROVISION_UNCONFIRMED")
    if (expectedBotId && (this.hasOtherBotTurn(id, expectedBotId) || Object.values(managed.session.leases).some((lease) => lease && (lease.details.botId ?? lease.details.endpoint?.botId) !== expectedBotId))) throw new Error("RUNTIME_WORKSPACE_NOT_OWNED")
    const session = managed.session
    revokeHandsMcpGrants(session)
    if (session.codex) {
      try {
        await session.codex.close()
        session.codex = undefined
        session.initialized = false
      } catch (error) {
        console.warn("Failed to close codex on session stop:", error)
      }
    }
    for (const leaseTier of ["desktop", "headless"] as const) await this.stop(id, leaseTier)
    this.sessions.delete(id)
    if (this.principalSessions.get(managed.principalKey) === id) this.principalSessions.delete(managed.principalKey)
    if (managed.disconnectTimer) clearTimeout(managed.disconnectTimer)
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

  bindInvocationAccessToken(id: string, botId: string, invocationId: string, accessToken: string) {
    const managed = this.sessions.get(id)
    const boundBotId = botId.trim()
    const boundInvocationId = invocationId.trim()
    const token = accessToken.trim()
    if (!managed) throw new Error("RUNTIME_SESSION_NOT_FOUND")
    if (!boundBotId || !boundInvocationId || !token) throw new Error("RUNTIME_INVOCATION_ACCESS_TOKEN_INVALID")
    const existing = managed.invocationAccessTokens.get(boundBotId)
    if (existing && existing.invocationId !== boundInvocationId) throw new Error("RUNTIME_INVOCATION_ACCESS_TOKEN_CONFLICT")
    managed.invocationAccessTokens.set(boundBotId, { invocationId: boundInvocationId, accessToken: token })
    let released = false
    return () => {
      if (released) return
      released = true
      if (managed.invocationAccessTokens.get(boundBotId)?.invocationId === boundInvocationId) {
        managed.invocationAccessTokens.delete(boundBotId)
      }
    }
  }

  accessTokenForBot(id: string, botId: string) {
    const managed = this.sessions.get(id)
    return managed?.invocationAccessTokens.get(botId)?.accessToken ?? managed?.session.accessToken
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

  activeSessionPrincipals(): GenioPrincipal[] {
    return Array.from(this.sessions.values())
      .map((managed) => managed.session)
      .filter((session) => session.initialized && Boolean(session.accessToken?.trim()))
      .map((session) => session.principal)
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
    const workspaceId = session.runtimeDetails.none?.workspaceId
    return Object.values(session.leases).find((lease) => lease?.details.botId === session.selectedBotId && lease.details.workspaceId === workspaceId)?.details ?? session.runtimeDetails.none ?? new PendingRuntime().details
  }
}
