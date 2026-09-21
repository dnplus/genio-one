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
import type { RuntimeCallbacks } from "./runtime"
import type { GenioPrincipal, RuntimeSession } from "./runtime-broker"

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

export class BotScheduleRunner {
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private recoveryOffset = 0
  private readonly retained = new Map<string, () => void>()
  private readonly activeRuns = new Map<string, string>()

  constructor(private readonly context: BotServerContext, private readonly intervalMs = 30_000) {
    this.context.botSchedules.recoverInterrupted()
  }

  start() {
    if (this.timer) return this
    this.trigger()
    this.timer = setInterval(() => this.trigger(), this.intervalMs)
    return this
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const release of this.retained.values()) release()
    this.retained.clear()
  }

  private trigger() {
    void this.tick().catch((error) => console.warn(JSON.stringify({ event: "bot.schedule.tick_failed", error: nativeError(error) })))
  }

  async tick() {
    if (this.ticking || this.context.runtimeBroker.isClosing()) return
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

  private callbacks(sessionId: string): RuntimeCallbacks {
    return {
      onMessage: (line) => {
        let message: { method?: string; params?: { threadId?: string; turn?: { id?: string; status?: string } } } | null = null
        try { message = JSON.parse(line) } catch { return }
        if (message?.method !== "turn/completed") return
        const turnId = message.params?.turn?.id
        if (!turnId) return
        const runId = this.activeRuns.get(`${sessionId}:${turnId}`)
        if (!runId) return
        const completed = message.params?.turn?.status === "completed"
        const run = this.context.botSchedules.markRun(runId, completed ? "COMPLETED" : "BLOCKED", { threadId: message.params?.threadId, turnId, error: completed ? null : `SCHEDULE_NATIVE_TURN_${message.params?.turn?.status ?? "UNKNOWN"}` })
        logSchedule(run, "bot.schedule.native_terminal", { runtimeSessionId: sessionId })
        this.activeRuns.delete(`${sessionId}:${turnId}`)
      },
      onExit: () => {
        for (const [key, runId] of this.activeRuns) if (key.startsWith(`${sessionId}:`)) {
          this.context.botSchedules.markRun(runId, "UNCERTAIN", { error: "SCHEDULE_RUNTIME_EXITED" })
          this.activeRuns.delete(key)
        }
      },
    }
  }

  private async reconcileUncertainRuns() {
    let runs = this.context.botSchedules.recoveryCandidates(100, this.recoveryOffset)
    if (runs.length === 0 && this.recoveryOffset > 0) {
      this.recoveryOffset = 0
      runs = this.context.botSchedules.recoveryCandidates()
    }
    this.recoveryOffset = runs.length === 100 ? this.recoveryOffset + runs.length : 0
    for (const run of runs) {
      if (!run.threadId) {
        this.context.botSchedules.markRun(run.id, "BLOCKED", { error: "SCHEDULE_RECOVERY_THREAD_MISSING" })
        continue
      }
      const principal = schedulePrincipal(run)
      const session = this.context.runtimeBroker.findByPrincipal(principal)
      if (!session?.accessToken || !session.initialized) continue
      try {
        let cursor: string | undefined
        const seen = new Set<string>()
        let turn: { id?: string; status?: string } | null = null
        let complete = false
        for (let pageCount = 0; pageCount < 20; pageCount++) {
          const page = await this.context.runtimeBroker.request(session.id, "thread/turns/list", { threadId: run.threadId, ...(cursor ? { cursor } : {}), limit: 100, itemsView: "full", sortDirection: "desc" }) as { nextCursor?: string }
          turn = nativeTurnForClientId(page, run.clientUserMessageId)
          if (turn) break
          if (!page.nextCursor) { complete = true; break }
          if (seen.has(page.nextCursor)) throw new Error("SCHEDULE_RECOVERY_CURSOR_STALLED")
          seen.add(page.nextCursor)
          cursor = page.nextCursor
        }
        if (!turn) {
          this.context.botSchedules.markRun(run.id, complete ? "BLOCKED" : "UNCERTAIN", { error: complete ? "SCHEDULE_RECOVERY_INPUT_NOT_FOUND" : "SCHEDULE_RECOVERY_HISTORY_INCOMPLETE" })
        } else if (turn.status === "completed") {
          this.context.botSchedules.markRun(run.id, "COMPLETED", { turnId: turn.id, error: null })
        } else if (turn.status === "inProgress") {
          this.context.botSchedules.markRun(run.id, "RUNNING", { turnId: turn.id, error: null })
          this.activeRuns.set(`${session.id}:${turn.id}`, run.id)
        } else {
          this.context.botSchedules.markRun(run.id, "BLOCKED", { turnId: turn.id, error: `SCHEDULE_NATIVE_TURN_${turn.status ?? "UNKNOWN"}` })
        }
      } catch {
        this.context.botSchedules.markRun(run.id, "UNCERTAIN", { error: "SCHEDULE_RECOVERY_HISTORY_UNAVAILABLE" })
      }
    }
  }

  private async execute(run: BotScheduleRun) {
    const { botSchedules, botRegistry, runtimeBroker } = this.context
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
    const session = runtimeBroker.findByPrincipal(principal)
    if (!session) {
      logSchedule(botSchedules.markRun(run.id, "AUTH_REQUIRED", { error: "SCHEDULE_LOGIN_REQUIRED" }), "bot.schedule.auth_required", { phase: "runtime_missing", reason: "SCHEDULE_LOGIN_REQUIRED" })
      return
    }
    if (!session.initialized) {
      logSchedule(botSchedules.markRun(run.id, "AUTH_REQUIRED", { error: "SCHEDULE_LOGIN_REQUIRED" }), "bot.schedule.auth_required", { phase: "runtime_uninitialized", reason: "SCHEDULE_LOGIN_REQUIRED", runtimeSessionId: session.id })
      return
    }
    if (!session.accessToken) {
      logSchedule(botSchedules.markRun(run.id, "AUTH_REQUIRED", { error: "SCHEDULE_LOGIN_REQUIRED" }), "bot.schedule.auth_required", { phase: "runtime_token_missing", reason: "SCHEDULE_LOGIN_REQUIRED", runtimeSessionId: session.id })
      return
    }
    this.retainRuntime(session)
    let authority: GenioPrincipal
    try {
      authority = await verifyGenioOneAccessToken(session.accessToken)
    } catch {
      logSchedule(botSchedules.markRun(run.id, "AUTH_REQUIRED", { error: "SCHEDULE_LOGIN_REQUIRED" }), "bot.schedule.auth_required", { phase: "identity_verify", reason: "SCHEDULE_LOGIN_REQUIRED", runtimeSessionId: session.id })
      return
    }
    if (authority.tenant_id !== principal.tenant_id || authority.subject_id !== principal.subject_id || authority.acting_client_id !== principal.acting_client_id) {
      logSchedule(botSchedules.markRun(run.id, "AUTH_REQUIRED", { error: "SCHEDULE_LOGIN_REQUIRED" }), "bot.schedule.auth_required", { phase: "identity_mismatch", reason: "SCHEDULE_LOGIN_REQUIRED", runtimeSessionId: session.id })
      return
    }
    try {
      await assertCapability(this.context.capabilityGate, authority, PERSONAL_BOT_USE, session.accessToken)
    } catch {
      logSchedule(botSchedules.markRun(run.id, "AUTH_REQUIRED", { error: "SCHEDULE_LOGIN_REQUIRED" }), "bot.schedule.auth_required", { phase: "capability_authorization", reason: "SCHEDULE_LOGIN_REQUIRED", runtimeSessionId: session.id })
      return
    }
    const release = runtimeBroker.claimBotTurn(run.botId)
    if (!release || botRegistry.timeline.hasRunningTurns(run.botId)) {
      release?.()
      botSchedules.markRun(run.id, "QUEUED", { error: "BOT_TURN_BUSY" })
      return
    }
    try {
      await this.startTurn(run, authority, session)
    } catch (error) {
      botSchedules.markRun(run.id, "BLOCKED", { error: nativeError(error) })
    } finally { release() }
  }

  private async startTurn(run: BotScheduleRun, principal: GenioPrincipal, session: RuntimeSession) {
    const { botRegistry, botSchedules } = this.context
    const bot = botRegistry.getOwned(run.botId, principal)
    if (!bot || !session.accessToken) throw new Error("SCHEDULE_LOGIN_REQUIRED")
    const materialized = botRegistry.materialize(bot.id, principal)
    if (
      materialized.skillRoots.length > 0 ||
      materialized.plugins.length > 0 ||
      bot.bindings.some((binding) => binding.state === "INSTALLED" && ["SKILL", "PLUGIN", "MCP"].includes(binding.kind))
    ) {
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
      const route = bot.modelRoute === "genio-gateway" ? { kind: "genio-gateway" as const, modelProvider: "genio_one" } : { kind: "codex-subscription" as const }
      const model = await selectBackgroundModel({ route, modelDirectory: this.context.modelDirectory, principal, botId: bot.id, accessToken: session.accessToken, request: (method, params) => this.context.runtimeBroker.request(session.id, method, params) })
      const exposure = await readNativeRuntimeExposure({ runtimePolicy: this.context.runtimePolicy, session, botId: bot.id, accessToken: session.accessToken })
      const canonical = async (method: "thread/start" | "thread/resume" | "turn/start", params: Record<string, unknown>) => canonicalizeNativeParams({ method, params, session, botId: bot.id, exposure, environment: { hasRuntimeEnvironment: false, hasDesktopRuntime: false }, botRegistry, modelDirectory: this.context.modelDirectory, accessToken: session.accessToken })
      const applyConfig = (params: Record<string, unknown>) => ({
        ...params,
        config: { ...(params.config as Record<string, unknown>), "features.memories": false, "mcp_servers.genio_bot": this.context.botToolSessions.config(bot.id, principal, session.id) },
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
      if (!dispatch) throw new Error("SCHEDULE_DELETED")
      if (!dispatch.enabled) throw new Error("SCHEDULE_PAUSED")
      if (dispatch.revision !== current.revision) throw new Error("SCHEDULE_CHANGED_BEFORE_DISPATCH")
      sent = true
      const started = await this.context.runtimeBroker.request(session.id, "turn/start", params)
      const turnId = started?.turn?.id ?? started?.turnId
      if (typeof turnId !== "string" || !turnId) throw new Error("SCHEDULE_TURN_START_FAILED")
      if (!botRegistry.timeline.turnStatus(bot.id, threadId, turnId)) botRegistry.recordRuntimeEvent(principal, JSON.stringify({ method: "turn/started", params: { threadId, turn: started.turn } }))
      const terminal = botRegistry.timeline.turnStatus(bot.id, threadId, turnId)
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
