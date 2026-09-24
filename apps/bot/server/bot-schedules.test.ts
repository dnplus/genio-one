import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { BotSchedules, nextBotScheduleAt, validateBotScheduleSpec } from "./bot-schedules"
import { BotScheduleRunner } from "./bot-schedule-runner"
import { executeScheduleTool } from "./bot-schedule-tools"
import { createCapabilityGate } from "./capability-gate"
import { selectBackgroundModel } from "./background-model-selection"

const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }

function allowedPolicyDecision(botId: string, capabilityId: string, action: string, sessionId: string, evaluatedAt: number) {
  return { tenant_id: principal.tenant_id, subject_id: principal.subject_id, client_id: principal.acting_client_id, bot_id: botId, runtime_id: "codex", policy_id: "test", policy_display_name: "test", policy_revision: 1, capability_id: capabilityId, action, target: `runtime:codex:${capabilityId}`, decision: "ALLOW" as const, reason_code: "TEST", constraints: [], obligations: [], correlation_id: "correlation", session_id: sessionId, evaluated_at: evaluatedAt }
}

function localTime(epoch: number, timezone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(epoch))
}

async function executeNativeTerminal(status: "completed" | "failed" | "interrupted", auditFails = false, pauseBeforeDispatch = false, packageCapability: "roots" | "binding" | false = false, existingThreadId?: string, initialTurnStatus: string | null = status, completeAfterDispatch = false, mcpAccess: "ENTITLED" | "REQUEST" = "ENTITLED", denyMcpExposure = false) {
  let now = Date.parse("2026-01-01T00:00:00.000Z")
  const schedules = new BotSchedules(new Database(":memory:"), () => now)
  const schedule = schedules.create(principal, "bot", { clientRequestId: `terminal-${status}-${auditFails}-${pauseBeforeDispatch}`, prompt: "執行一次", schedule: { kind: "once", at: "2026-01-01T00:01:00.000Z" } }).schedule!
  now = Date.parse("2026-01-01T00:01:00.000Z")
  schedules.claimDue()
  const [run] = schedules.claimRunnable()
  const originalFetch = globalThis.fetch
  const originalMcpUrl = process.env.GENIO_ONE_MCP_URL
  const originalRelayOrigin = process.env.GENIO_ONE_MCP_RELAY_ORIGIN
  process.env.GENIO_ONE_MCP_URL = "http://one.localhost:1975/mcp"
  process.env.GENIO_ONE_MCP_RELAY_ORIGIN = "https://bot.example.test"
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/catalog")) return Response.json({ capabilities: [{
      resource_id: "resource-notion",
      capability_id: "notion.search",
      access: mcpAccess,
      publication_endpoint: { hostname: "notion.stellar-freight.localhost", base_path: "/mcp" },
    }] })
    return Response.json(principal)
  }) as unknown as typeof fetch
  const binding = { resourceId: "resource-notion", capabilityId: "notion.search", state: "INSTALLED", kind: "MCP" }
  const bot = { id: "bot", name: "排程 Bot", title: "例行工作", description: "執行排程", antiJobs: "", voice: "", updatedAt: now, modelRoute: "codex-subscription", bindings: packageCapability === "binding" ? [binding] : [] }
  const session = { id: "runtime", principal, initialized: true, accessToken: "live", details: { cwd: "/tmp" }, runtimeDetails: {} }
  let turnRequests = 0
  const runtimeListener: { current: { onMessage(line: string): void } | null } = { current: null }
  const requests: Array<{ method: string; params: Record<string, unknown> }> = []
  try {
    const runner = new BotScheduleRunner({
      botSchedules: schedules,
      capabilityGate: createCapabilityGate({ mode: "fixture", personalBotAllowlist: ["tenant:owner"] }),
      runtimeBroker: { isClosing: () => false, findByPrincipal: () => session, claimBotTurn: () => () => undefined, listen: (_runtimeId: string, callbacks: { onMessage(line: string): void }) => {
        runtimeListener.current = callbacks
        return () => undefined
      }, request: async (_runtimeId: string, method: string, params: Record<string, unknown>) => {
        requests.push({ method, params })
        if (method === "model/list") {
          if (pauseBeforeDispatch) schedules.update(principal, "bot", schedule.id, { expectedRevision: schedules.get(principal, "bot", schedule.id)!.revision, enabled: false })
          return { data: [{ id: "gpt-6-astra", model: "gpt-6-astra", hidden: false, isDefault: true }], nextCursor: null }
        }
        if (method === "thread/start") return { thread: { id: "thread" } }
        if (method === "thread/resume") return { thread: { id: existingThreadId } }
        if (method === "turn/start") turnRequests++
        return { turn: { id: "turn" } }
      } },
      runtimePolicy: {
        authorize: async (input: any) => ({ ...allowedPolicyDecision(input.botId, input.capabilityId, input.action, session.id, now), ...(denyMcpExposure && input.capabilityId === "mcp.invoke" ? { decision: "DENY" as const } : {}) }),
        report: async () => { if (auditFails) { schedules.markRun(run!.id, "COMPLETED", { threadId: "thread", turnId: "turn" }); throw new Error("audit unavailable") } },
        read: async (input: any) => ({ ...allowedPolicyDecision(input.botId, "shell.exec", "expose", session.id, now), decisions: input.capabilityIds.map((capabilityId: string) => allowedPolicyDecision(input.botId, capabilityId, "expose", session.id, now)) }),
      },
      modelDirectory: { resolve: async () => [{ publicModelId: "*", displayName: "test", route: { kind: "codex-subscription" } }] }, botToolSessions: { config: () => ({}) },
      botRegistry: { getOwned: () => bot, materialize: () => ({ root: "/tmp", skillRoots: packageCapability === "roots" ? ["/tmp/package-skill"] : [], plugins: [] }), getSession: () => existingThreadId ? { appServerThreadId: existingThreadId } : null, rememberThread: () => undefined, saveSession: () => undefined, recordRuntimeEvent: () => undefined, memory: { recall: () => ({ memories: [] }), workSummary: () => ({ revision: 0, status: "active" }) }, timeline: { hasRunningTurns: () => false, turnStatus: () => initialTurnStatus, workContext: () => ({ turns: [] }) } },
    } as any)
    await (runner as any).execute(run)
    if (completeAfterDispatch) runtimeListener.current?.onMessage(JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } }))
    return { activeSchedules: schedules.listActive(), run: schedules.getRun(run!.id)!, turnRequests, requests }
  } finally {
    globalThis.fetch = originalFetch
    if (originalMcpUrl === undefined) delete process.env.GENIO_ONE_MCP_URL
    else process.env.GENIO_ONE_MCP_URL = originalMcpUrl
    if (originalRelayOrigin === undefined) delete process.env.GENIO_ONE_MCP_RELAY_ORIGIN
    else process.env.GENIO_ONE_MCP_RELAY_ORIGIN = originalRelayOrigin
  }
}

describe("BotSchedules", () => {
  test("uses timezone-aware daily slots once across the repeated DST hour", () => {
    const spec = { kind: "recurring", frequency: "daily", time: "01:30", timezone: "America/New_York" } as const
    const first = nextBotScheduleAt(spec, Date.parse("2025-11-02T04:00:00.000Z"))!
    expect(new Date(first).toISOString()).toBe("2025-11-02T05:30:00.000Z")
    const afterFirst = nextBotScheduleAt(spec, first + 1)!
    expect(localTime(afterFirst, spec.timezone)).toBe("2025-11-03, 01:30")
  })

  test("moves a nonexistent DST wall time to the next valid local time", () => {
    const spec = { kind: "recurring", frequency: "daily", time: "02:30", timezone: "America/New_York" } as const
    const slot = nextBotScheduleAt(spec, Date.parse("2025-03-09T05:00:00.000Z"))!
    expect(localTime(slot, spec.timezone)).toBe("2025-03-09, 03:30")
  })

  test("deduplicates create requests, claims one due slot, and skips missed recurring slots", () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z")
    const schedules = new BotSchedules(new Database(":memory:"), () => now)
    const input = { clientRequestId: "same-request", prompt: "整理每日摘要", schedule: { kind: "once", at: "2026-01-01T00:05:00.000Z" } }
    const first = schedules.create(principal, "bot", input)
    const duplicate = schedules.create(principal, "bot", input)
    expect(duplicate).toMatchObject({ schedule: first.schedule, created: false })
    now = Date.parse("2026-01-01T00:05:00.000Z")
    const due = schedules.claimDue()
    expect(due).toHaveLength(1)
    expect(schedules.claimDue()).toEqual([])
    expect(schedules.claimRunnable()).toHaveLength(1)
    expect(schedules.claimRunnable()).toEqual([])
  })

  test("releases a completed one-time schedule from active owner retention", () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z")
    const schedules = new BotSchedules(new Database(":memory:"), () => now)
    schedules.create(principal, "bot", { clientRequestId: "one-time-retention", prompt: "執行一次", schedule: { kind: "once", at: "2026-01-01T00:01:00.000Z" } })
    expect(schedules.listActive()).toHaveLength(1)
    now = Date.parse("2026-01-01T00:01:00.000Z")
    schedules.claimDue()
    const [run] = schedules.claimRunnable()
    schedules.markRun(run!.id, "COMPLETED")
    expect(schedules.listActive()).toEqual([])
  })

  test("keeps immutable create receipts across a late retry, edit, and delete", () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z")
    const schedules = new BotSchedules(new Database(":memory:"), () => now)
    const input = { clientRequestId: "receipt", prompt: "原始工作", schedule: { kind: "once", at: "2026-01-01T00:01:00.000Z" } }
    const created = schedules.create(principal, "bot", input)
    now = Date.parse("2026-01-01T00:02:00.000Z")
    expect(schedules.create(principal, "bot", input)).toMatchObject({ created: false, schedule: { id: created.schedule!.id } })
    const edited = schedules.update(principal, "bot", created.schedule!.id, { expectedRevision: created.schedule!.revision, prompt: "已編輯工作", enabled: false })
    expect(schedules.create(principal, "bot", input)).toMatchObject({ created: false, schedule: { id: created.schedule!.id, prompt: "已編輯工作" } })
    expect(() => schedules.create(principal, "bot", { ...input, prompt: "不同 payload" })).toThrow("BOT_SCHEDULE_IDEMPOTENCY_CONFLICT")
    schedules.delete(principal, "bot", edited.id, edited.revision)
    expect(schedules.create(principal, "bot", input)).toEqual({ schedule: null, scheduleId: created.schedule!.id, created: false, deleted: true })
    expect(schedules.list(principal, "bot")).toEqual([])
  })

  test("requires an explicit ISO offset for one-time schedules", () => {
    expect(() => validateBotScheduleSpec({ kind: "once", at: "12" })).toThrow("BOT_SCHEDULE_ONCE_INVALID")
    expect(() => validateBotScheduleSpec({ kind: "once", at: "2026-01-01T12:00" })).toThrow("BOT_SCHEDULE_ONCE_INVALID")
    expect(validateBotScheduleSpec({ kind: "once", at: "2026-01-01T12:00:00+08:00" })).toEqual({ kind: "once", at: "2026-01-01T04:00:00.000Z" })
  })

  test("requires a current revision, preserves paused schedules, and never replays interrupted work", () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z")
    const schedules = new BotSchedules(new Database(":memory:"), () => now)
    const created = schedules.create(principal, "bot", { clientRequestId: "pause", prompt: "例行檢查", schedule: { kind: "recurring", frequency: "daily", time: "00:05", timezone: "UTC" } }).schedule!
    expect(() => schedules.update(principal, "bot", created.id, { expectedRevision: 999, enabled: false })).toThrow("BOT_SCHEDULE_CHANGED")
    const paused = schedules.update(principal, "bot", created.id, { expectedRevision: created.revision, enabled: false })
    expect(paused.enabled).toBe(false)
    now = Date.parse("2026-01-01T00:06:00.000Z")
    expect(schedules.claimDue()).toEqual([])
    const resumed = schedules.update(principal, "bot", paused.id, { expectedRevision: paused.revision, enabled: true })
    expect(resumed.nextRunAt).toBe(Date.parse("2026-01-02T00:05:00.000Z"))
  })

  test("requeues a claimed run that crashed before it acquired a thread", () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z")
    const db = new Database(":memory:")
    const first = new BotSchedules(db, () => now)
    first.create(principal, "bot", { clientRequestId: "restart", prompt: "執行一次", schedule: { kind: "once", at: "2026-01-01T00:01:00.000Z" } })
    now = Date.parse("2026-01-01T00:01:00.000Z")
    first.claimDue()
    const [claimed] = first.claimRunnable()
    expect(claimed?.state).toBe("CLAIMED")
    const restarted = new BotSchedules(db, () => now)
    restarted.recoverInterrupted()
    expect(restarted.getRun(claimed!.id)?.state).toBe("QUEUED")
    expect(restarted.claimRunnable()).toHaveLength(1)
  })

  test("deletion is owner-scoped and retains already-created run evidence", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z")
    const schedules = new BotSchedules(new Database(":memory:"), () => now)
    const created = schedules.create(principal, "bot", { clientRequestId: "delete", prompt: "執行一次", schedule: { kind: "once", at: "2026-01-01T00:01:00.000Z" } }).schedule!
    now = Date.parse("2026-01-01T00:01:00.000Z")
    schedules.claimDue()
    const other = { ...principal, subject_id: "other" }
    expect(schedules.get(other, "bot", created.id)).toBeNull()
    schedules.delete(principal, "bot", created.id, created.revision + 1)
    expect(schedules.listRuns(principal, "bot")).toHaveLength(1)
    const response = await executeScheduleTool("list_schedule_runs", { scheduleId: created.id }, {
      context: { botSchedules: schedules, botRegistry: { getOwned: () => ({ id: "bot" }) } },
      botId: "bot",
      principal,
      accessToken: "live",
    } as any)
    expect(JSON.parse((response.content[0] as { text: string }).text)).toMatchObject({ runs: [{ scheduleId: created.id }] })
  })

  test("marks a due run AUTH_REQUIRED when no current owner runtime exists", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z")
    const schedules = new BotSchedules(new Database(":memory:"), () => now)
    schedules.create(principal, "bot", { clientRequestId: "auth", prompt: "執行一次", schedule: { kind: "once", at: "2026-01-01T00:01:00.000Z" } })
    now = Date.parse("2026-01-01T00:01:00.000Z")
    const [due] = schedules.claimDue()
    const [run] = schedules.claimRunnable()
    const runner = new BotScheduleRunner({ botSchedules: schedules, runtimeBroker: { isClosing: () => false, findByPrincipal: () => null, listen: () => () => undefined }, botRegistry: { timeline: { hasRunningTurns: () => false } } } as any)
    const originalInfo = console.info
    const events: unknown[] = []
    console.info = (...args) => { events.push(args[0]) }
    try {
      await (runner as any).execute(run)
    } finally {
      console.info = originalInfo
    }
    expect(schedules.getRun(due!.id)?.state).toBe("AUTH_REQUIRED")
    expect(events.map((event) => JSON.parse(String(event)))).toContainEqual(expect.objectContaining({ event: "bot.schedule.auth_required", run_id: due!.id, schedule_id: due!.scheduleId, bot_id: "bot", tenant_id: principal.tenant_id, owner_subject_id: principal.subject_id, runtime_session_id: null, phase: "runtime_missing", reason: "SCHEDULE_LOGIN_REQUIRED", state: "AUTH_REQUIRED" }))
    expect(schedules.claimRunnable()).toEqual([])
    expect(schedules.resumeAuthorized(principal)).toBe(1)
    expect(schedules.claimRunnable()).toHaveLength(1)
  })

  test("coalesces missed AUTH_REQUIRED slots to the latest one after login", () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z")
    const schedules = new BotSchedules(new Database(":memory:"), () => now)
    schedules.create(principal, "bot", { clientRequestId: "daily-auth", prompt: "每日例行工作", schedule: { kind: "recurring", frequency: "daily", time: "00:01", timezone: "UTC" } })
    for (const day of [1, 2, 3]) {
      now = Date.parse(`2026-01-0${day}T00:01:00.000Z`)
      schedules.claimDue()
      const [run] = schedules.claimRunnable()
      schedules.markRun(run!.id, "AUTH_REQUIRED", { error: "SCHEDULE_LOGIN_REQUIRED" })
    }
    expect(schedules.resumeAuthorized(principal)).toBe(1)
    const runs = schedules.listRuns(principal, "bot")
    expect(runs.filter((run) => run.state === "QUEUED")).toHaveLength(1)
    expect(runs.filter((run) => run.error === "SCHEDULE_SUPERSEDED")).toHaveLength(2)
  })

  test("coalesces queued slots while a Bot remains busy", () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z")
    const schedules = new BotSchedules(new Database(":memory:"), () => now)
    schedules.create(principal, "bot", { clientRequestId: "daily-busy", prompt: "每日例行工作", schedule: { kind: "recurring", frequency: "daily", time: "00:01", timezone: "UTC" } })
    now = Date.parse("2026-01-01T00:01:00.000Z")
    schedules.claimDue()
    now = Date.parse("2026-01-02T00:01:00.000Z")
    schedules.claimDue()
    const runs = schedules.listRuns(principal, "bot")
    expect(runs.filter((run) => run.state === "QUEUED")).toHaveLength(1)
    expect(runs.filter((run) => run.error === "SCHEDULE_SUPERSEDED")).toHaveLength(1)
    const [claimed] = schedules.claimRunnable()
    expect(claimed?.slotAt).toBe(Date.parse("2026-01-02T00:01:00.000Z"))
    expect(schedules.claimRunnable()).toEqual([])
  })

  test("rotates a busy backlog while new schedules keep arriving", () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z")
    const schedules = new BotSchedules(new Database(":memory:"), () => now)
    for (let index = 0; index < 21; index++) {
      schedules.create(principal, `busy-${index}`, { clientRequestId: `busy-${index}`, prompt: "忙碌工作", schedule: { kind: "once", at: "2026-01-01T00:01:00.000Z" } })
    }
    now = Date.parse("2026-01-01T00:01:00.000Z")
    schedules.claimDue(100)
    const busy = schedules.claimRunnable(100)
    for (const run of busy) schedules.markRun(run.id, "QUEUED", { error: "BOT_TURN_BUSY" })
    now = Date.parse("2026-01-01T00:02:00.000Z")
    for (let index = 0; index < 20; index++) schedules.create(principal, `new-first-${index}`, { clientRequestId: `new-first-${index}`, prompt: "新工作", schedule: { kind: "once", at: "2026-01-01T00:02:00.000Z" } })
    schedules.claimDue(100)
    const firstTick = schedules.claimRunnable(20)
    expect(firstTick.every((run) => busy.some((prior) => prior.id === run.id))).toBe(true)
    for (const run of firstTick) schedules.markRun(run.id, "QUEUED", { error: "BOT_TURN_BUSY" })
    const remaining = busy.find((run) => !firstTick.some((claimed) => claimed.id === run.id))!
    now = Date.parse("2026-01-01T00:03:00.000Z")
    for (let index = 0; index < 20; index++) schedules.create(principal, `new-second-${index}`, { clientRequestId: `new-second-${index}`, prompt: "新工作", schedule: { kind: "once", at: "2026-01-01T00:03:00.000Z" } })
    schedules.claimDue(100)
    const secondTick = schedules.claimRunnable(20)
    expect(secondTick.some((run) => run.id === remaining.id)).toBe(true)
    for (const run of secondTick) {
      if (busy.some((prior) => prior.id === run.id)) schedules.markRun(run.id, "QUEUED", { error: "BOT_TURN_BUSY" })
      else schedules.markRun(run.id, "COMPLETED")
    }
    now = Date.parse("2026-01-01T00:04:00.000Z")
    const thirdTick = schedules.claimRunnable(20)
    expect(thirdTick.some((run) => run.botId.startsWith("new-first-"))).toBe(true)
  })

  test("cancels unsent work when its Bot is deleted while retaining owner-scoped history", () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z")
    const schedules = new BotSchedules(new Database(":memory:"), () => now)
    const schedule = schedules.create(principal, "bot", { clientRequestId: "deleted-bot", prompt: "執行一次", schedule: { kind: "once", at: "2026-01-01T00:01:00.000Z" } }).schedule!
    now = Date.parse("2026-01-01T00:01:00.000Z")
    schedules.claimDue()
    expect(schedules.cancelBot(principal, "bot")).toEqual({ schedules: 1, runs: 1 })
    expect(schedules.list(principal, "bot")).toEqual([])
    expect(schedules.listActive()).toEqual([])
    expect(schedules.listRuns(principal, "bot", schedule.id)).toMatchObject([{ scheduleId: schedule.id, state: "BLOCKED", error: "BOT_DELETED" }])
    expect(schedules.listRuns({ ...principal, subject_id: "other" }, "bot", schedule.id)).toEqual([])
  })

  test("reconciles an interrupted run from its native clientUserMessageId without replaying it", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z")
    const schedules = new BotSchedules(new Database(":memory:"), () => now)
    const schedule = schedules.create(principal, "bot", { clientRequestId: "history", prompt: "執行一次", schedule: { kind: "recurring", frequency: "daily", time: "00:01", timezone: "UTC" } }).schedule!
    now = Date.parse("2026-01-01T00:01:00.000Z")
    schedules.claimDue()
    const [run] = schedules.claimRunnable()
    schedules.markRun(run!.id, "UNCERTAIN", { threadId: "native-thread", error: "SCHEDULE_RUNTIME_EXITED" })
    const session = { id: "runtime", accessToken: "live", initialized: true }
    const runner = new BotScheduleRunner({
      botSchedules: schedules,
      runtimeBroker: {
        isClosing: () => false,
        findByPrincipal: () => session,
        listen: () => () => undefined,
        request: async () => ({ data: [{ id: "native-turn", status: "completed", items: [{ type: "userMessage", clientId: run!.clientUserMessageId }] }] }),
      },
      botRegistry: { timeline: { hasRunningTurns: () => false } },
    } as any)
    await (runner as any).reconcileUncertainRuns()
    expect(schedules.getRun(run!.id)).toMatchObject({ state: "COMPLETED", turnId: "native-turn" })
    expect(schedules.get(principal, "bot", schedule.id)?.enabled).toBe(true)
  })

  test("keeps an uncertain run retryable when native history is temporarily unavailable", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z")
    const schedules = new BotSchedules(new Database(":memory:"), () => now)
    schedules.create(principal, "bot", { clientRequestId: "history-unavailable", prompt: "執行一次", schedule: { kind: "recurring", frequency: "daily", time: "00:01", timezone: "UTC" } })
    now = Date.parse("2026-01-01T00:01:00.000Z")
    schedules.claimDue()
    const [run] = schedules.claimRunnable()
    schedules.markRun(run!.id, "UNCERTAIN", { threadId: "native-thread", error: "SCHEDULE_RUNTIME_EXITED" })
    const runner = new BotScheduleRunner({
      botSchedules: schedules,
      runtimeBroker: { isClosing: () => false, findByPrincipal: () => ({ id: "runtime", accessToken: "live", initialized: true }), listen: () => () => undefined, request: async () => { throw new Error("temporary history outage") } },
      botRegistry: { timeline: { hasRunningTurns: () => false } },
    } as any)
    await (runner as any).reconcileUncertainRuns()
    expect(schedules.getRun(run!.id)).toMatchObject({ state: "UNCERTAIN", error: "SCHEDULE_RECOVERY_HISTORY_UNAVAILABLE" })
  })

  test("rotates past offline recovery candidates to reconcile an available owner", async () => {
    const db = new Database(":memory:")
    const schedules = new BotSchedules(db, () => Date.parse("2026-01-01T00:00:00.000Z"))
    const insert = db.query("insert into bot_schedule_runs (id, schedule_id, tenant_id, owner_subject_id, acting_client_id, bot_id, slot_at, client_user_message_id, state, attempts, thread_id, created_at, updated_at) values (?, ?, 'tenant', ?, 'genio-one-bot', ?, ?, ?, 'UNCERTAIN', 1, ?, ?, ?)")
    for (let index = 0; index < 101; index++) insert.run(`offline-${index}`, `schedule-${index}`, `offline-${index}`, `offline-bot-${index}`, index, `offline-message-${index}`, `offline-thread-${index}`, index, index)
    insert.run("available", "available-schedule", "available-owner", "available-bot", 102, "available-message", "available-thread", 102, 102)
    const session = { id: "available-runtime", accessToken: "live", initialized: true }
    const runner = new BotScheduleRunner({
      botSchedules: schedules,
      runtimeBroker: {
        findByPrincipal: (candidate: typeof principal) => candidate.subject_id === "available-owner" ? session : null,
        request: async () => ({ data: [{ id: "available-turn", status: "completed", items: [{ type: "userMessage", clientId: "available-message" }] }] }),
      },
      botRegistry: { timeline: { hasRunningTurns: () => false } },
    } as any)
    await (runner as any).reconcileUncertainRuns()
    expect(schedules.getRun("available")?.state).toBe("UNCERTAIN")
    await (runner as any).reconcileUncertainRuns()
    expect(schedules.getRun("available")).toMatchObject({ state: "COMPLETED", turnId: "available-turn" })
  })

  test("retains a running owner after more than one hundred offline uncertain runs", () => {
    const db = new Database(":memory:")
    const schedules = new BotSchedules(db, () => Date.parse("2026-01-01T00:00:00.000Z"))
    const insert = db.query("insert into bot_schedule_runs (id, schedule_id, tenant_id, owner_subject_id, acting_client_id, bot_id, slot_at, client_user_message_id, state, attempts, thread_id, created_at, updated_at) values (?, ?, 'tenant', ?, 'genio-one-bot', ?, ?, ?, ?, 1, ?, ?, ?)")
    for (let index = 0; index < 101; index++) insert.run(`offline-retention-${index}`, `offline-schedule-${index}`, `offline-owner-${index}`, `offline-bot-${index}`, index, `offline-message-${index}`, "UNCERTAIN", `offline-thread-${index}`, index, index)
    insert.run("live-retention", "deleted-schedule", "live-owner", "live-bot", 102, "live-message", "RUNNING", "live-thread", 102, 102)
    let listeners = 0
    let releases = 0
    const session = { id: "live-runtime" }
    const runner = new BotScheduleRunner({
      botSchedules: schedules,
      runtimeBroker: {
        findByPrincipal: (candidate: typeof principal) => candidate.subject_id === "live-owner" ? session : null,
        listen: () => { listeners++; return () => { releases++ } },
      },
    } as any)
    const retain = () => (runner as any).retainActiveOwnerRuntimes()
    retain()
    expect(listeners).toBe(1)
    schedules.markRun("live-retention", "COMPLETED")
    retain()
    expect(releases).toBe(1)
  })

  test("persists UNCERTAIN with its thread when turn dispatch loses the runtime response", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z")
    const schedules = new BotSchedules(new Database(":memory:"), () => now)
    schedules.create(principal, "bot", { clientRequestId: "disconnect", prompt: "執行一次", schedule: { kind: "once", at: "2026-01-01T00:01:00.000Z" } })
    now = Date.parse("2026-01-01T00:01:00.000Z")
    schedules.claimDue()
    const [run] = schedules.claimRunnable()
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => Response.json(principal)) as unknown as typeof fetch
    const bot = { id: "bot", name: "排程 Bot", title: "例行工作", description: "執行排程", antiJobs: "", voice: "", updatedAt: now, modelRoute: "codex-subscription", bindings: [] }
    const session = { id: "runtime", principal, initialized: true, accessToken: "live", details: { cwd: "/tmp" }, runtimeDetails: {} }
    try {
      const runner = new BotScheduleRunner({
        botSchedules: schedules,
        capabilityGate: createCapabilityGate({ mode: "fixture", personalBotAllowlist: ["tenant:owner"] }),
        runtimeBroker: {
          isClosing: () => false,
          findByPrincipal: () => session,
          claimBotTurn: () => () => undefined,
          listen: () => () => undefined,
          request: async (_runtimeId: string, method: string) => {
            if (method === "model/list") return { data: [{ id: "astra-id", model: "gpt-6-astra", hidden: false, isDefault: true }], nextCursor: null }
            return method === "thread/start" ? { thread: { id: "thread" } } : Promise.reject(new Error("transport closed"))
          },
        },
        runtimePolicy: {
          authorize: async (input: any) => allowedPolicyDecision(input.botId, input.capabilityId, input.action, session.id, now),
          report: async () => undefined,
          read: async (input: any) => ({ ...allowedPolicyDecision(input.botId, "shell.exec", "expose", session.id, now), decisions: input.capabilityIds.map((capabilityId: string) => allowedPolicyDecision(input.botId, capabilityId, "expose", session.id, now)) }),
        },
        modelDirectory: { resolve: async () => [{ publicModelId: "gpt-5.5", displayName: "test", route: { kind: "codex-subscription" } }] },
        botToolSessions: { config: () => ({}) },
        botRegistry: { getOwned: () => bot, materialize: () => ({ root: "/tmp", skillRoots: [], plugins: [] }), getSession: () => null, rememberThread: () => undefined, saveSession: () => undefined, recordRuntimeEvent: () => undefined, memory: { recall: () => ({ memories: [] }), workSummary: () => ({ revision: 0, status: "active" }) }, timeline: { hasRunningTurns: () => false, turnStatus: () => null, workContext: () => ({ turns: [] }) } },
      } as any)
      await (runner as any).execute(run)
      expect(schedules.getRun(run!.id)).toMatchObject({ state: "UNCERTAIN", threadId: "thread" })
    } finally { globalThis.fetch = originalFetch }
  })

  test("converges native early completed and failed turns instead of leaving them running", async () => {
    await expect(executeNativeTerminal("completed")).resolves.toMatchObject({ run: { state: "COMPLETED", turnId: "turn" } })
    await expect(executeNativeTerminal("failed")).resolves.toMatchObject({ run: { state: "FAILED", turnId: "turn" } })
  })

  test("installs a completion listener for a resumed one-time run before native dispatch", async () => {
    await expect(executeNativeTerminal("completed", false, false, false, undefined, null, true)).resolves.toMatchObject({ activeSchedules: [], run: { state: "COMPLETED", turnId: "turn" } })
  })

  test("uses the current native default for new and resumed Codex threads", async () => {
    const fresh = await executeNativeTerminal("completed")
    expect(fresh.requests.find((request) => request.method === "thread/start")?.params.model).toBe("gpt-6-astra")
    expect(fresh.requests.find((request) => request.method === "turn/start")?.params.model).toBe("gpt-6-astra")
    const resumed = await executeNativeTerminal("completed", false, false, false, "persisted-spark-thread")
    expect(resumed.requests.find((request) => request.method === "thread/resume")?.params.model).toBe("gpt-6-astra")
    expect(resumed.requests.find((request) => request.method === "turn/start")?.params.model).toBe("gpt-6-astra")
  })

  test("selects a native default found on a later model page", async () => {
    const requests: Array<Record<string, unknown>> = []
    const model = await selectBackgroundModel({
      route: { kind: "codex-subscription" },
      modelDirectory: {} as any,
      principal,
      botId: "bot",
      request: async (_method, params) => {
        requests.push(params)
        return params.cursor
          ? { data: [{ id: "astra-id", model: "gpt-6-astra", hidden: false, isDefault: true }], nextCursor: null }
          : { data: [{ id: "luna-id", model: "gpt-5.6-luna", hidden: false, isDefault: false }], nextCursor: "page-2" }
      },
    })
    expect(model).toBe("gpt-6-astra")
    expect(requests).toEqual([{ limit: 100, includeHidden: false }, { limit: 100, includeHidden: false, cursor: "page-2" }])
  })

  test("keeps a concurrent completion while marking deferred audit reporting", async () => {
    await expect(executeNativeTerminal("completed", true)).resolves.toMatchObject({ run: { state: "COMPLETED", error: "SCHEDULE_AUDIT_REPORT_DEFERRED" } })
  })

  test("rechecks pause state after asynchronous preparation before dispatch", async () => {
    await expect(executeNativeTerminal("completed", false, true)).resolves.toMatchObject({ run: { state: "BLOCKED", error: "SCHEDULE_PAUSED" }, turnRequests: 0 })
  })

  test("blocks Skills and Plugins before native dispatch", async () => {
    await expect(executeNativeTerminal("completed", false, false, "roots")).resolves.toMatchObject({ run: { state: "BLOCKED", error: "SCHEDULE_PACKAGE_CAPABILITIES_UNAVAILABLE" }, turnRequests: 0 })
  })

  test("mounts an entitled installed MCP binding before one scheduled dispatch", async () => {
    const result = await executeNativeTerminal("completed", false, false, "binding")
    expect(result).toMatchObject({ run: { state: "COMPLETED", turnId: "turn" }, turnRequests: 1 })
    expect(result.requests.find((request) => request.method === "thread/start")?.params.config).toMatchObject({
      "mcp_servers.genio_mcp_notion": {
        url: "https://bot.example.test/api/mcp-gateway/runtime/bots/bot/resource-notion/mcp",
      },
    })
    expect(result.requests.filter((request) => request.method === "turn/start")).toHaveLength(1)
  })

  test("does not dispatch an installed MCP schedule after access is revoked or policy denies exposure", async () => {
    await expect(executeNativeTerminal("completed", false, false, "binding", undefined, "completed", false, "REQUEST")).resolves.toMatchObject({ run: { state: "AUTH_REQUIRED", error: "SCHEDULE_MCP_AUTH_REQUIRED" }, turnRequests: 0 })
    await expect(executeNativeTerminal("completed", false, false, "binding", undefined, "completed", false, "ENTITLED", true)).resolves.toMatchObject({ run: { state: "BLOCKED", error: "SCHEDULE_MCP_POLICY_DENIED" }, turnRequests: 0 })
  })
})
