import { assertCapability, PERSONAL_BOT_USE } from "./capability-gate"
import { verifyGenioOneAccessToken } from "./auth"
import { botTurnContext } from "./bot-context"
import { botRuntimeInstructions } from "./bot-runtime-instructions"
import { selectBackgroundModel } from "./background-model-selection"
import type { BotScheduleRun } from "./bot-schedules"
import type { BotServerContext } from "./context"
import { canonicalizeNativeParams } from "./native-runtime-params"
import { readNativeRuntimeExposure } from "./native-runtime-policy"
import { createRuntimePolicyLifecycle } from "./runtime-policy-lifecycle"
import { createCodexRuntime, type RuntimeCallbacks } from "./runtime"
import { managedMcpConfig, resolveManagedMcpMounts, type ManagedMcpMounts } from "./managed-mcp"
import { setManagedMcpMounts, type GenioPrincipal, type RuntimeSession } from "./runtime-broker"

function schedulePrincipal(run: BotScheduleRun): GenioPrincipal {
  return { tenant_id: run.tenantId, subject_id: run.ownerSubjectId, acting_client_id: run.actingClientId, scopes: [] }
}

function nativeError(error: unknown) {
  const message = error instanceof Error ? error.message : "BOT_SCHEDULE_RUNTIME_FAILED"
  return message.slice(0, 500)
}

function nativeTurnForClientId(value: unknown, clientUserMessageId: string): { id?: string; status?: string } | null {
  if (!value || typeof value !== "object") return null
  const page = value as { data?: Array<{ id?: string; status?: string; items?: Array<{ type?: string; clientId?: string }> }> }
  for (const turn of page.data ?? []) if (turn.items?.some((item) => item.type === "userMessage" && item.clientId === clientUserMessageId)) return turn
  return null
}

function runStateForNativeTurn(status: string | null): "COMPLETED" | "FAILED" | "BLOCKED" | "RUNNING" {
  if (status === "completed") return "COMPLETED"
  if (status === "failed") return "FAILED"
  if (status === "interrupted") return "BLOCKED"
  return "RUNNING"
}

function logSchedule(run: BotScheduleRun, event: string, input: { phase?: string; reason?: string; runtimeSessionId?: string | null } = {}) {
  console.info(JSON.stringify({
    event,
    run_id: run.id,
    schedule_id: run.scheduleId,
    bot_id: run.botId,
    tenant_id: run.tenantId,
    owner_subject_id: run.ownerSubjectId,
    acting_client_id: run.actingClientId,
    runtime_session_id: input.runtimeSessionId ?? null,
    ...(input.phase ? { phase: input.phase } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(run.threadId ? { thread_id: run.threadId } : {}),
    ...(run.turnId ? { turn_id: run.turnId } : {}),
    state: run.state,
  }))
}

function hasInstalledMcpBinding(bindings: ReadonlyArray<{ state?: string; kind?: string }>) {
  return bindings.some((binding) => binding.state === "INSTALLED" && binding.kind === "MCP")
}

function hasUnsupportedSchedulePackage(bindings: ReadonlyArray<{ state?: string; kind?: string }>) {
  return bindings.some((binding) => binding.state === "INSTALLED" && (binding.kind === "SKILL" || binding.kind === "PLUGIN"))
}

interface ScheduleRuntime {
  session: RuntimeSession
  release: () => void
  preparing: boolean
  terminalTurns: Map<string, { threadId?: string; status?: string }>
  stopping?: Promise<void>
}

export class BotScheduleRunner {
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private recoveryOffset = 0
  private readonly retained = new Map<string, () => void>()
  private readonly activeRuns = new Map<string, string>()
  private readonly scheduleRuntimes = new Map<string, ScheduleRuntime>()
  private stopped = false

  constructor(private readonly context: BotServerContext, private readonly intervalMs = 30_000) {
    this.context.botSchedules.recoverInterrupted()
  }

  start() {
    if (this.timer) return this
    this.stopped = false
    this.trigger()
    this.timer = setInterval(() => this.trigger(), this.intervalMs)
    return this
  }

  async stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const release of this.retained.values()) release()
    this.retained.clear()
    for (const [runId] of this.scheduleRuntimes) {
      const run = this.context.botSchedules.getRun(runId)
      if (run?.state === "RUNNING" || run?.state === "STARTING") this.context.botSchedules.markRun(runId, "UNCERTAIN", { error: "SCHEDULE_RUNNER_STOPPED" })
    }
    await Promise.all([...this.scheduleRuntimes.keys()].map((runId) => this.releaseScheduleRuntime(runId)))
  }

  private trigger() {
    void this.tick().catch((error) => console.warn(JSON.stringify({ event: "bot.schedule.tick_failed", error: nativeError(error) })))
  }

  async tick() {
    if (this.ticking || this.stopped || this.context.runtimeBroker.isClosing()) return
    this.ticking = true
    try {
      this.retainActiveOwnerRuntimes()
      this.context.botSchedules.claimDue()
      await this.reconcileUncertainRuns()
      for (const run of this.context.botSchedules.claimRunnable()) void this.execute(run).catch((error) => console.warn(JSON.stringify({ event: "bot.schedule.run_unhandled", run_id: run.id, error: nativeError(error) })))
    } finally { this.ticking = false }
  }

  private retainActiveOwnerRuntimes() {
    const wanted = new Set<string>()
    const principals = [
      ...this.context.botSchedules.listActive().map((schedule) => ({ tenant_id: schedule.tenantId, subject_id: schedule.ownerSubjectId, acting_client_id: schedule.actingClientId })),
      ...this.context.botSchedules.retainedOwnerPrincipals(),
    ]
    for (const principal of principals) {
      const session = this.context.runtimeBroker.findByPrincipal(principal)
      if (!session) continue
      wanted.add(session.id)
      this.retainRuntime(session)
    }
    for (const [sessionId, release] of this.retained) if (!wanted.has(sessionId)) {
      release()
      this.retained.delete(sessionId)
    }
  }

  private retainRuntime(session: RuntimeSession) {
    if (!this.retained.has(session.id)) this.retained.set(session.id, this.context.runtimeBroker.listen(session.id, this.callbacks(session.id)))
  }

  private callbacks(sessionId: string, scheduleRunId?: string): RuntimeCallbacks {
    return {
      onMessage: (line) => {
        let message: { method?: string; params?: { threadId?: string; turn?: { id?: string; status?: string } } } | null = null
        try { message = JSON.parse(line) } catch { return }
        if (message?.method !== "turn/completed") return
        const turnId = message.params?.turn?.id
        if (!turnId) return
        const owned = scheduleRunId ? this.scheduleRuntimes.get(scheduleRunId) : undefined
        if (owned?.stopping) return
        owned?.terminalTurns.set(turnId, { threadId: message.params?.threadId, status: message.params?.turn?.status })
        const runId = this.activeRuns.get(`${sessionId}:${turnId}`)
        if (!runId) return
        const status = message.params?.turn?.status
        const state = status === "completed" ? "COMPLETED" : status === "failed" ? "FAILED" : "BLOCKED"
        const run = this.context.botSchedules.markRun(runId, state, { threadId: message.params?.threadId, turnId, error: state === "COMPLETED" ? null : `SCHEDULE_NATIVE_TURN_${status ?? "UNKNOWN"}` })
        logSchedule(run, "bot.schedule.native_terminal", { runtimeSessionId: sessionId })
        this.activeRuns.delete(`${sessionId}:${turnId}`)
        if (owned && !owned.preparing) void this.releaseScheduleRuntime(runId).catch((error) => this.logCleanupFailure(runId, error))
      },
      onExit: () => {
        for (const [key, runId] of this.activeRuns) if (key.startsWith(`${sessionId}:`)) {
          this.context.botSchedules.markRun(runId, "UNCERTAIN", { error: "SCHEDULE_RUNTIME_EXITED" })
          this.activeRuns.delete(key)
        }
        const owned = scheduleRunId ? this.scheduleRuntimes.get(scheduleRunId) : undefined
        if (owned && !owned.stopping) {
          const run = this.context.botSchedules.getRun(scheduleRunId!)
          if (run?.state === "STARTING" || run?.state === "RUNNING") this.context.botSchedules.markRun(run.id, "UNCERTAIN", { error: "SCHEDULE_RUNTIME_EXITED" })
          void this.releaseScheduleRuntime(scheduleRunId!).catch((error) => this.logCleanupFailure(scheduleRunId!, error))
        }
      },
    }
  }

  private releaseScheduleRuntime(runId: string): Promise<void> {
    const owned = this.scheduleRuntimes.get(runId)
    if (!owned) return Promise.resolve()
    if (owned.stopping) return owned.stopping
    owned.release()
    for (const [key, activeRunId] of this.activeRuns) if (activeRunId === runId && key.startsWith(`${owned.session.id}:`)) this.activeRuns.delete(key)
    const stopping = Promise.resolve().then(() => this.context.runtimeBroker.stop(owned.session.id)).then(() => {
      if (this.scheduleRuntimes.get(runId) === owned) this.scheduleRuntimes.delete(runId)
    }).finally(() => { if (owned.stopping === stopping) owned.stopping = undefined })
    owned.stopping = stopping
    return stopping
  }

  private logCleanupFailure(runId: string, error: unknown) {
    console.warn(JSON.stringify({ event: "bot.schedule.runtime_cleanup_failed", run_id: runId, error: nativeError(error) }))
  }

  private async reconcileUncertainRuns() {
    const { botSchedules, runtimeBroker } = this.context
    let runs = this.context.botSchedules.recoveryCandidates(100, this.recoveryOffset)
    if (runs.length === 0 && this.recoveryOffset > 0) {
      this.recoveryOffset = 0
      runs = this.context.botSchedules.recoveryCandidates()
    }
    this.recoveryOffset = runs.length === 100 ? this.recoveryOffset + runs.length : 0
    for (const run of runs) {
      if (this.stopped || runtimeBroker.isClosing()) return
      if (!run.threadId) {
        this.context.botSchedules.markRun(run.id, "BLOCKED", { error: "SCHEDULE_RECOVERY_THREAD_MISSING" })
        continue
      }
      const principal = schedulePrincipal(run)
      const live = runtimeBroker.findByPrincipal(principal)
      if (live && (!live.accessToken || !live.initialized)) continue
      let session = live
      let phase = "authority"
      try {
        if (!session) {
          await this.releaseScheduleRuntime(run.id)
          const authority = await this.recoveryAuthority(run)
          if (!authority) continue
          phase = "runtime"
          session = await this.openScheduleRuntime(run, authority.principal, authority.accessToken)
        } else {
          this.retainRuntime(session)
        }
        phase = "history"
        let cursor: string | undefined
        const seen = new Set<string>()
        let turn: { id?: string; status?: string } | null = null
        let complete = false
        for (let pageCount = 0; pageCount < 20; pageCount++) {
          if (this.stopped || runtimeBroker.isClosing()) throw new Error("SCHEDULE_RUNNER_STOPPED")
          const page = await runtimeBroker.request(session.id, "thread/turns/list", { threadId: run.threadId, ...(cursor ? { cursor } : {}), limit: 100, itemsView: "full", sortDirection: "desc" }) as { nextCursor?: string }
          turn = nativeTurnForClientId(page, run.clientUserMessageId)
          if (turn) break
          if (!page.nextCursor) { complete = true; break }
          if (seen.has(page.nextCursor)) throw new Error("SCHEDULE_RECOVERY_CURSOR_STALLED")
          seen.add(page.nextCursor)
          cursor = page.nextCursor
        }
        const terminal = turn?.id ? this.scheduleRuntimes.get(run.id)?.terminalTurns.get(turn.id) : undefined
        if (terminal) turn = { ...turn, status: terminal.status ?? "UNKNOWN" }
        if (!turn) {
          botSchedules.markRun(run.id, complete ? "BLOCKED" : "UNCERTAIN", { error: complete ? "SCHEDULE_RECOVERY_INPUT_NOT_FOUND" : "SCHEDULE_RECOVERY_HISTORY_INCOMPLETE" })
        } else if (turn.status === "completed") {
          botSchedules.markRun(run.id, "COMPLETED", { turnId: turn.id, error: null })
        } else if (turn.status === "inProgress") {
          botSchedules.markRun(run.id, live ? "RUNNING" : "UNCERTAIN", { turnId: turn.id, error: live ? null : "SCHEDULE_RECOVERY_NATIVE_TURN_IN_PROGRESS" })
          if (live) this.activeRuns.set(`${session.id}:${turn.id}`, run.id)
        } else {
          botSchedules.markRun(run.id, turn.status === "failed" ? "FAILED" : "BLOCKED", { turnId: turn.id, error: `SCHEDULE_NATIVE_TURN_${turn.status ?? "UNKNOWN"}` })
        }
      } catch (error) {
        const reason = this.stopped || runtimeBroker.isClosing() ? "SCHEDULE_RECOVERY_STOPPED" : phase === "authority" ? "SCHEDULE_RECOVERY_AUTH_REQUIRED" : "SCHEDULE_RECOVERY_HISTORY_UNAVAILABLE"
        logSchedule(botSchedules.markRun(run.id, "UNCERTAIN", { error: reason }), "bot.schedule.recovery_deferred", { phase, reason: nativeError(error), runtimeSessionId: session?.id })
      } finally {
        if (!live) await this.releaseScheduleRuntime(run.id)
      }
    }
  }

  private async recoveryAuthority(run: BotScheduleRun) {
    const source = this.context.scheduleAuthority
    if (!source) return null
    const principal = schedulePrincipal(run)
    const accessToken = await source.issue({ principal, botId: run.botId, scheduleId: run.scheduleId, runId: run.id })
    if (this.stopped || this.context.runtimeBroker.isClosing()) throw new Error("SCHEDULE_RUNNER_STOPPED")
    if (!accessToken) throw new Error("SCHEDULE_LOGIN_REQUIRED")
    const authority = await verifyGenioOneAccessToken(accessToken, AbortSignal.timeout(10_000))
    if (authority.tenant_id !== principal.tenant_id || authority.subject_id !== principal.subject_id || authority.acting_client_id !== principal.acting_client_id) throw new Error("SCHEDULE_IDENTITY_MISMATCH")
    await assertCapability(this.context.capabilityGate, authority, PERSONAL_BOT_USE, accessToken)
    if (this.stopped || this.context.runtimeBroker.isClosing()) throw new Error("SCHEDULE_RUNNER_STOPPED")
    return { principal: authority, accessToken }
  }

  private async execute(run: BotScheduleRun) {
    const { botSchedules, botRegistry, runtimeBroker } = this.context
    if (this.stopped || runtimeBroker.isClosing()) return
    const principal = schedulePrincipal(run)
    const schedule = botSchedules.get(principal, run.botId, run.scheduleId)
    if (!schedule) {
      botSchedules.markRun(run.id, "BLOCKED", { error: "SCHEDULE_DELETED" })
      return
    }
    if (!schedule.enabled) {
      botSchedules.markRun(run.id, "BLOCKED", { error: "SCHEDULE_PAUSED" })
      return
    }
    const authRequired = (phase: string, runtimeSessionId?: string) => {
      logSchedule(botSchedules.markRun(run.id, "AUTH_REQUIRED", { error: "SCHEDULE_LOGIN_REQUIRED" }), "bot.schedule.auth_required", { phase, reason: "SCHEDULE_LOGIN_REQUIRED", runtimeSessionId })
    }
    const live = runtimeBroker.findByPrincipal(principal)
    let accessToken: string
    if (live) {
      if (!live.initialized) return authRequired("runtime_uninitialized", live.id)
      if (!live.accessToken) return authRequired("runtime_token_missing", live.id)
      this.retainRuntime(live)
      accessToken = live.accessToken
    } else {
      const authoritySource = this.context.scheduleAuthority
      if (!authoritySource) return authRequired("runtime_missing")
      let issued: string | null
      try {
        issued = await authoritySource.issue({ principal, botId: run.botId, scheduleId: run.scheduleId, runId: run.id })
      } catch {
        return authRequired("authority_unavailable")
      }
      if (!issued) return authRequired("runtime_missing")
      accessToken = issued
    }
    let authority: GenioPrincipal
    try {
      authority = await verifyGenioOneAccessToken(accessToken, AbortSignal.timeout(10_000))
    } catch {
      return authRequired("identity_verify", live?.id)
    }
    if (authority.tenant_id !== principal.tenant_id || authority.subject_id !== principal.subject_id || authority.acting_client_id !== principal.acting_client_id) {
      return authRequired("identity_mismatch", live?.id)
    }
    try {
      await assertCapability(this.context.capabilityGate, authority, PERSONAL_BOT_USE, accessToken)
    } catch {
      return authRequired("capability_authorization", live?.id)
    }
    if (this.stopped || runtimeBroker.isClosing()) {
      botSchedules.markRun(run.id, "BLOCKED", { error: "SCHEDULE_RUNNER_STOPPED" })
      return
    }
    let session: RuntimeSession
    try {
      session = live ?? await this.openScheduleRuntime(run, authority, accessToken)
    } catch (error) {
      botSchedules.markRun(run.id, "BLOCKED", { error: `SCHEDULE_RUNTIME_START_FAILED:${nativeError(error)}`.slice(0, 500) })
      return
    }
    const release = runtimeBroker.claimBotTurn(run.botId, session.id)
    if (!release || botRegistry.timeline.hasRunningTurns(run.botId)) {
      release?.()
      botSchedules.markRun(run.id, "QUEUED", { error: "BOT_TURN_BUSY" })
      await this.releaseScheduleRuntime(run.id)
      return
    }
    try {
      await this.startTurn(run, authority, session)
    } catch (error) {
      botSchedules.markRun(run.id, "BLOCKED", { error: nativeError(error) })
    } finally {
      release()
      const owned = this.scheduleRuntimes.get(run.id)
      if (owned) {
        owned.preparing = false
        if (botSchedules.getRun(run.id)?.state !== "RUNNING") await this.releaseScheduleRuntime(run.id)
      }
    }
  }

  private async openScheduleRuntime(run: BotScheduleRun, principal: GenioPrincipal, accessToken: string) {
    const { runtimeBroker } = this.context
    const makeCodexRuntime = this.context.createCodexRuntime ?? createCodexRuntime
    const opening: RuntimeCallbacks = { onMessage: () => undefined, onExit: () => undefined }
    const session = await runtimeBroker.startSchedule(principal, run.id, opening, (callbacks, runtimeSessionId, relaySecret) => makeCodexRuntime(accessToken, callbacks, {
      tenantId: principal.tenant_id,
      subjectId: principal.subject_id,
      actingClientId: principal.acting_client_id,
      runtimeSessionId,
    }, relaySecret), accessToken)
    this.scheduleRuntimes.set(run.id, { session, release: runtimeBroker.listen(session.id, this.callbacks(session.id, run.id)), preparing: true, terminalTurns: new Map() })
    runtimeBroker.detach(session.id, opening)
    try {
      if (this.stopped || runtimeBroker.isClosing()) throw new Error("SCHEDULE_RUNNER_STOPPED")
      await runtimeBroker.request(session.id, "initialize", {
        clientInfo: { name: "genio_one_bot_schedule", title: "Genio Bot schedule", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      })
      await runtimeBroker.channel(session.id, opening)?.send(JSON.stringify({ method: "initialized" }))
      runtimeBroker.detach(session.id, opening)
      if (this.stopped || runtimeBroker.isClosing()) throw new Error("SCHEDULE_RUNNER_STOPPED")
      if (!session.initialized || !session.accessToken) throw new Error("SCHEDULE_RUNTIME_UNINITIALIZED")
      return session
    } catch (error) {
      await this.releaseScheduleRuntime(run.id)
      throw error
    }
  }

  private async startTurn(run: BotScheduleRun, principal: GenioPrincipal, session: RuntimeSession) {
    const { botRegistry, botSchedules } = this.context
    const bot = botRegistry.getOwned(run.botId, principal)
    if (!bot || !session.accessToken) throw new Error("SCHEDULE_LOGIN_REQUIRED")
    const materialized = botRegistry.materialize(bot.id, principal)
    if (materialized.skillRoots.length > 0 || materialized.plugins.length > 0 || hasUnsupportedSchedulePackage(bot.bindings)) {
      botSchedules.markRun(run.id, "BLOCKED", { error: "SCHEDULE_PACKAGE_CAPABILITIES_UNAVAILABLE" })
      return
    }
    botSchedules.markRun(run.id, "STARTING")
    const lifecycle = createRuntimePolicyLifecycle({ policy: this.context.runtimePolicy, accessToken: () => session.accessToken ?? null, onReportFailure: () => undefined })
    const modelDecision = bot.modelRoute === "codex-subscription"
      ? await lifecycle.authorize(session, bot.id, "codex.subscription", "use")
      : await lifecycle.authorize(session, bot.id, "model.invoke", "invoke")
    let sent = false
    let threadId = botRegistry.getSession(bot.id)?.appServerThreadId ?? undefined
    try {
      let mcpMounts: ManagedMcpMounts = {}
      let mcpConfig: Record<string, unknown> = {}
      if (hasInstalledMcpBinding(bot.bindings)) {
        let degradation: string | null = null
        mcpMounts = await resolveManagedMcpMounts({
          bindings: bot.bindings,
          tenantId: principal.tenant_id,
          accessToken: session.accessToken,
          onDegraded: (reason) => { degradation = reason },
        })
        if (Object.keys(mcpMounts).length === 0) {
          const error = degradation === "MANAGED_MCP_CATALOG_STATUS_401" || degradation === "MANAGED_MCP_CATALOG_STATUS_403" || degradation === null
            ? "SCHEDULE_MCP_AUTH_REQUIRED"
            : "SCHEDULE_MCP_CATALOG_UNAVAILABLE"
          const state = error === "SCHEDULE_MCP_AUTH_REQUIRED" ? "AUTH_REQUIRED" : "BLOCKED"
          logSchedule(botSchedules.markRun(run.id, state, { error }), "bot.schedule.mcp_unavailable", {
            phase: "catalog",
            reason: error,
            runtimeSessionId: session.id,
          })
          await lifecycle.report(session, bot.id, modelDecision, "FAILED", error)
          return
        }
        if (Object.keys(managedMcpConfig(session.id, bot.id, mcpMounts)).length === 0) {
          botSchedules.markRun(run.id, "BLOCKED", { error: "SCHEDULE_MCP_ENDPOINT_UNAVAILABLE" })
          await lifecycle.report(session, bot.id, modelDecision, "FAILED", "SCHEDULE_MCP_ENDPOINT_UNAVAILABLE")
          return
        }
        const allowed: ManagedMcpMounts = {}
        for (const [resourceId, mount] of Object.entries(mcpMounts)) {
          try {
            const decision = await lifecycle.authorize(session, bot.id, "mcp.invoke", "expose")
            if (!await lifecycle.report(session, bot.id, decision, "COMPLETED", "MANAGED_MCP_CONFIG_INJECTED")) throw new Error("RUNTIME_POLICY_REPORT_UNAVAILABLE")
            allowed[resourceId] = mount
          } catch (error) {
            logSchedule(botSchedules.markRun(run.id, "BLOCKED", { error: "SCHEDULE_MCP_POLICY_DENIED" }), "bot.schedule.mcp_denied", {
              phase: "policy",
              reason: error instanceof Error ? error.message : "SCHEDULE_MCP_POLICY_DENIED",
              runtimeSessionId: session.id,
            })
            await lifecycle.report(session, bot.id, modelDecision, "FAILED", "SCHEDULE_MCP_POLICY_DENIED")
            return
          }
        }
        mcpMounts = allowed
        if (Object.keys(mcpMounts).length === 0) {
          botSchedules.markRun(run.id, "BLOCKED", { error: "SCHEDULE_MCP_POLICY_DENIED" })
          await lifecycle.report(session, bot.id, modelDecision, "FAILED", "SCHEDULE_MCP_POLICY_DENIED")
          return
        }
        mcpConfig = managedMcpConfig(session.id, bot.id, mcpMounts)
        setManagedMcpMounts(session, bot.id, mcpMounts)
      }
      const route = bot.modelRoute === "genio-gateway" ? { kind: "genio-gateway" as const, modelProvider: "genio_one" } : { kind: "codex-subscription" as const }
      const model = await selectBackgroundModel({ route, modelDirectory: this.context.modelDirectory, principal, botId: bot.id, accessToken: session.accessToken, request: (method, params) => this.context.runtimeBroker.request(session.id, method, params) })
      const exposure = await readNativeRuntimeExposure({ runtimePolicy: this.context.runtimePolicy, session, botId: bot.id, accessToken: session.accessToken })
      const canonical = async (method: "thread/start" | "thread/resume" | "turn/start", params: Record<string, unknown>) => canonicalizeNativeParams({ method, params, session, botId: bot.id, exposure, environment: { hasRuntimeEnvironment: false, hasDesktopRuntime: false }, botRegistry, modelDirectory: this.context.modelDirectory, accessToken: session.accessToken })
      const applyConfig = (params: Record<string, unknown>) => ({
        ...params,
        config: {
          ...(params.config as Record<string, unknown>),
          "features.memories": false,
          "mcp_servers.genio_bot": this.context.botToolSessions.config(bot.id, principal, session.id),
          ...mcpConfig,
        },
        baseInstructions: botRuntimeInstructions(bot),
      })
      if (threadId) {
        try { await this.context.runtimeBroker.request(session.id, "thread/resume", applyConfig(await canonical("thread/resume", { threadId, model, excludeTurns: true }))) }
        catch (error) {
          if (!/no rollout found for thread id/i.test(nativeError(error))) throw error
          botRegistry.setThreadHistoryStatus(bot.id, threadId, "unavailable")
          botRegistry.saveSession({ botId: bot.id, appServerThreadId: null })
          threadId = undefined
        }
      }
      if (!threadId) {
        const started = await this.context.runtimeBroker.request(session.id, "thread/start", applyConfig(await canonical("thread/start", { model })))
        threadId = started?.thread?.id
        if (typeof threadId !== "string" || !threadId) throw new Error("SCHEDULE_THREAD_START_FAILED")
        botRegistry.rememberThread(bot.id, threadId)
        botRegistry.saveSession({ botId: bot.id, appServerThreadId: threadId, activeRuntimeTier: "none" })
      }
      const current = botSchedules.get(principal, bot.id, run.scheduleId)
      if (!current) throw new Error("SCHEDULE_DELETED")
      if (!current.enabled) throw new Error("SCHEDULE_PAUSED")
      botSchedules.markRun(run.id, "STARTING", { threadId })
      const prompt = `Scheduled run (${new Date(run.slotAt).toISOString()}). Continue the user's requested routine below. This is an authorized scheduled trigger, not a new authorization for actions outside the saved task.\n\n${current.prompt}`
      const params = await canonical("turn/start", { threadId, clientUserMessageId: run.clientUserMessageId, model, input: [{ type: "text", text: prompt, text_elements: [] }], additionalContext: botTurnContext(botRegistry, bot.id, threadId, {}, bot, principal) })
      const dispatch = botSchedules.get(principal, bot.id, run.scheduleId)
      if (this.stopped || this.context.runtimeBroker.isClosing()) throw new Error("SCHEDULE_RUNNER_STOPPED")
      if (!dispatch) throw new Error("SCHEDULE_DELETED")
      if (!dispatch.enabled) throw new Error("SCHEDULE_PAUSED")
      if (dispatch.revision !== current.revision) throw new Error("SCHEDULE_CHANGED_BEFORE_DISPATCH")
      sent = true
      const started = await this.context.runtimeBroker.request(session.id, "turn/start", params)
      const turnId = started?.turn?.id ?? started?.turnId
      if (typeof turnId !== "string" || !turnId) throw new Error("SCHEDULE_TURN_START_FAILED")
      if (!botRegistry.timeline.turnStatus(bot.id, threadId, turnId)) botRegistry.recordRuntimeEvent(principal, JSON.stringify({ method: "turn/started", params: { threadId, turn: started.turn } }))
      const terminal = this.scheduleRuntimes.get(run.id)?.terminalTurns.get(turnId)?.status ?? botRegistry.timeline.turnStatus(bot.id, threadId, turnId)
      const state = runStateForNativeTurn(terminal)
      const saved = botSchedules.markRun(run.id, state, { threadId, turnId, error: null })
      logSchedule(saved, "bot.schedule.native_dispatched", { runtimeSessionId: session.id })
      if (state !== "RUNNING") logSchedule(saved, "bot.schedule.native_terminal", { runtimeSessionId: session.id })
      if (state === "RUNNING") this.activeRuns.set(`${session.id}:${turnId}`, run.id)
      const audited = await lifecycle.report(session, bot.id, modelDecision, "ALLOW")
      if (!audited) {
        const latest = botSchedules.getRun(run.id)
        if (latest) botSchedules.markRun(run.id, latest.state, { threadId, turnId, error: "SCHEDULE_AUDIT_REPORT_DEFERRED" })
      }
    } catch (error) {
      await lifecycle.report(session, bot.id, modelDecision, "FAILED", sent ? "SCHEDULE_TURN_UNCERTAIN" : "SCHEDULE_TURN_PREPARATION_FAILED")
      if (sent) {
        botSchedules.markRun(run.id, "UNCERTAIN", { threadId, error: nativeError(error) })
        return
      }
      throw error
    }
  }
}

export function runBotSchedules(context: BotServerContext, intervalMs?: number) {
  return new BotScheduleRunner(context, intervalMs).start()
}
