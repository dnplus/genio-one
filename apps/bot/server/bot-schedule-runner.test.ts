import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { BotScheduleRunner } from "./bot-schedule-runner"
import { BotSchedules, type BotScheduleRun } from "./bot-schedules"
import { createCapabilityGate } from "./capability-gate"
import { RuntimeBroker, type GenioPrincipal } from "./runtime-broker"
import type { CodexHomeNamespace, RuntimeCallbacks } from "./runtime"

const principal: GenioPrincipal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }

function barrier() {
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  const ready = new Promise<void>((resolve) => { entered = resolve })
  return { ready, release, wait: async () => { entered(); await waiting } }
}

interface NativeChild {
  id: string
  issuedToken: string
  token: string | undefined
  callbacks: RuntimeCallbacks
  methods: string[]
  updates: string[]
  closes: number
  turnId: string
}

interface ScenarioOptions {
  beforeIssue?: () => Promise<void>
  beforeVerify?: () => Promise<void>
  beforeCapability?: () => Promise<void>
  beforeRequest?: (child: NativeChild, request: { method: string; params?: Record<string, unknown> }) => Promise<void>
  initializeFailures?: number
  failedMethod?: string
  earlyTerminal?: "completed" | "failed" | "interrupted"
  earlyRecoveryTerminal?: "completed" | "failed" | "interrupted"
  historyStatus?: string
  issueToken?: string | null
  verificationStatus?: number
  verifiedPrincipal?: GenioPrincipal
}

function scenario(options: ScenarioOptions = {}) {
  let now = Date.parse("2026-01-01T00:00:00.000Z")
  const database = new Database(":memory:")
  const schedules = new BotSchedules(database, () => now)
  schedules.create(principal, "bot", { clientRequestId: "scenario", prompt: "執行例行工作", schedule: { kind: "recurring", frequency: "daily", time: "00:01", timezone: "UTC" } })
  const broker = new RuntimeBroker({ provision: async () => { throw new Error("UNEXPECTED_PROVISION") } })
  const children: NativeChild[] = []
  const dispatched: Array<{ threadId: string; turnId: string; clientId: string }> = []
  const activeTokens = new Map<string, string>()
  const originalFetch = globalThis.fetch
  globalThis.fetch = Object.assign(
    async (_input: Parameters<typeof fetch>[0]) => {
      await options.beforeVerify?.()
      return Response.json(options.verifiedPrincipal ?? principal, { status: options.verificationStatus ?? 200 })
    },
    { preconnect: originalFetch.preconnect },
  )
  const gate = createCapabilityGate({ mode: "fixture", personalBotAllowlist: ["tenant:owner"] })
  const resolve = gate.resolve.bind(gate)
  gate.resolve = async (...args) => {
    await options.beforeCapability?.()
    return resolve(...args)
  }
  let initializationFailures = options.initializeFailures ?? 0
  const createRuntime = (token: string, callbacks: RuntimeCallbacks, namespace?: CodexHomeNamespace) => {
    const child: NativeChild = { id: namespace!.runtimeSessionId!, issuedToken: token, token, callbacks, methods: [], updates: [], closes: 0, turnId: `turn-${children.length}` }
    children.push(child)
    activeTokens.set(child.id, token)
    return {
      async send(line: string) {
        const request = JSON.parse(line)
        child.methods.push(request.method)
        if (request.id === undefined) return
        await options.beforeRequest?.(child, request)
        if (!child.token) throw new Error("NATIVE_CHILD_STOPPED")
        if (request.method === "turn/start") dispatched.push({ threadId: request.params.threadId, turnId: child.turnId, clientId: request.params.clientUserMessageId })
        if (request.method === options.failedMethod) throw new Error("NATIVE_TRANSPORT_FAILED")
        if (request.method === "initialize" && initializationFailures-- > 0) {
          callbacks.onMessage(JSON.stringify({ id: request.id, error: { code: -32603, message: "initialize rejected" } }))
          return
        }
        const threadId = `thread-${child.id}`
        const nativeTurn = dispatched.find((turn) => turn.threadId === request.params?.threadId)
        if (request.method === "turn/start" && options.earlyTerminal) callbacks.onMessage(JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: child.turnId, status: options.earlyTerminal } } }))
        if (request.method === "thread/turns/list" && nativeTurn && options.earlyRecoveryTerminal) callbacks.onMessage(JSON.stringify({ method: "turn/completed", params: { threadId: nativeTurn.threadId, turn: { id: nativeTurn.turnId, status: options.earlyRecoveryTerminal } } }))
        const result = request.method === "model/list" ? { data: [{ id: "astra", model: "gpt-6-astra", hidden: false, isDefault: true }], nextCursor: null }
          : request.method === "thread/start" ? { thread: { id: threadId } }
          : request.method === "turn/start" ? { turn: { id: child.turnId, status: "inProgress" } }
          : request.method === "thread/turns/list" ? { data: nativeTurn ? [{ id: nativeTurn.turnId, status: options.historyStatus ?? "completed", items: [{ type: "userMessage", clientId: nativeTurn.clientId }] }] : [], nextCursor: null }
          : {}
        callbacks.onMessage(JSON.stringify({ id: request.id, result }))
      },
      async close() {
        child.closes++
        child.token = undefined
        activeTokens.delete(child.id)
        callbacks.onExit("NATIVE_CHILD_STOPPED")
      },
      async updateToken(token: string) {
        child.updates.push(token)
        child.token = token
        activeTokens.set(child.id, token)
      },
    }
  }
  const decision = (input: any) => ({ tenant_id: principal.tenant_id, subject_id: principal.subject_id, client_id: principal.acting_client_id, bot_id: input.botId, runtime_id: "codex", policy_id: "test", policy_display_name: "test", policy_revision: 1, capability_id: input.capabilityId, action: input.action, target: `runtime:codex:${input.capabilityId}`, decision: "ALLOW" as const, reason_code: "TEST", constraints: [], obligations: [], correlation_id: "correlation", session_id: input.sessionId, evaluated_at: now })
  const bot = { id: "bot", name: "例行工作", title: "排程 Bot", description: "執行例行工作", antiJobs: "", voice: "", updatedAt: now, modelRoute: "codex-subscription", bindings: [] }
  let issueCalls = 0
  const runner = new BotScheduleRunner({
    botSchedules: schedules,
    scheduleAuthority: { issue: async () => { issueCalls++; await options.beforeIssue?.(); return options.issueToken === undefined ? "issued-owner" : options.issueToken } },
    capabilityGate: gate,
    runtimeBroker: broker,
    createCodexRuntime: createRuntime,
    runtimePolicy: {
      authorize: async (input: any) => decision(input),
      report: async () => undefined,
      read: async (input: any) => ({ ...decision({ ...input, capabilityId: "shell.exec", action: "expose" }), decisions: input.capabilityIds.map((capabilityId: string) => decision({ ...input, capabilityId, action: "expose" })) }),
    },
    modelDirectory: { resolve: async () => [{ publicModelId: "*", displayName: "test", route: { kind: "codex-subscription" } }] },
    botToolSessions: { config: () => ({}) },
    botRegistry: {
      getOwned: () => bot,
      materialize: () => ({ root: "/tmp", skillRoots: [], plugins: [] }),
      getSession: () => null,
      rememberThread: () => undefined,
      saveSession: () => undefined,
      recordRuntimeEvent: () => undefined,
      memory: { recall: () => ({ memories: [] }), workSummary: () => ({ revision: 0, status: "active" }) },
      timeline: { hasRunningTurns: () => false, turnStatus: () => null, workContext: () => ({ turns: [] }) },
    },
  } as any)
  return {
    broker, runner, schedules, children, activeTokens, dispatched,
    issueCalls: () => issueCalls,
    nextRun() {
      now = now < Date.parse("2026-01-01T00:01:00.000Z") ? Date.parse("2026-01-01T00:01:00.000Z") : now + 86_400_000
      schedules.claimDue()
      return schedules.claimRunnable()[0]!
    },
    execute: (run: BotScheduleRun): Promise<void> => (runner as any).execute(run),
    recover: (): Promise<void> => (runner as any).reconcileUncertainRuns(),
    openInteractive: (token: string) => broker.start(principal, { onMessage() {}, onExit() {} }, (callbacks, id) => createRuntime(token, callbacks, { tenantId: principal.tenant_id, subjectId: principal.subject_id, actingClientId: principal.acting_client_id, runtimeSessionId: id }), token),
    async close() {
      await runner.stop()
      await broker.close()
      globalThis.fetch = originalFetch
      database.close()
    },
  }
}

describe("BotScheduleRunner authority runtime ownership", () => {
  for (const phase of ["issue", "verify", "capability"] as const) test(`keeps an interactive login isolated while schedule ${phase} awaits`, async () => {
    const gate = barrier()
    const testCase = scenario({ ...(phase === "issue" ? { beforeIssue: gate.wait } : phase === "verify" ? { beforeVerify: gate.wait } : { beforeCapability: gate.wait }) })
    try {
      const run = testCase.nextRun()
      const executing = testCase.execute(run)
      await gate.ready
      const interactive = await testCase.openInteractive("interactive-a")
      await testCase.broker.start(principal, { onMessage() {}, onExit() {} }, undefined, "interactive-b")
      gate.release()
      await executing
      const scheduled = testCase.children.find((child) => child.issuedToken === "issued-owner")!
      const login = testCase.children.find((child) => child.id === interactive.id)!
      expect(testCase.schedules.getRun(run.id)?.state).toBe("RUNNING")
      expect(scheduled.id).not.toBe(interactive.id)
      expect(interactive.accessToken).toBe("interactive-b")
      expect(interactive.initialized).not.toBe(true)
      expect(login.updates).toEqual(["interactive-b"])
      expect(login.methods).toEqual([])
      expect(testCase.broker.findByPrincipal(principal)).toBe(interactive)
      expect(testCase.broker.findBySubject(principal.tenant_id, principal.subject_id)).toBe(interactive)
      expect(testCase.broker.activeSessionPrincipals()).toEqual([])
      interactive.initialized = true
      expect(testCase.broker.activeSessionPrincipals()).toEqual([principal])
      await testCase.runner.stop()
      expect(testCase.activeTokens.get(interactive.id)).toBe("interactive-b")
      expect(login.closes).toBe(0)
      expect(scheduled.closes).toBe(1)
    } finally { gate.release(); await testCase.close() }
  })

  test("uses an initialized interactive owner directly without an authority exchange", async () => {
    const testCase = scenario()
    try {
      const interactive = await testCase.openInteractive("interactive-owner")
      interactive.initialized = true
      await testCase.execute(testCase.nextRun())
      expect(testCase.issueCalls()).toBe(0)
      expect(testCase.children).toHaveLength(1)
      expect(testCase.children[0]!.methods).toContain("turn/start")
      await testCase.runner.stop()
      expect(testCase.children[0]!.closes).toBe(0)
      expect(testCase.broker.findByPrincipal(principal)).toBe(interactive)
    } finally { await testCase.close() }
  })

  for (const source of ["exchange", "interactive"] as const) test(`times out a stalled ${source} identity verification and allows authorized retry`, async () => {
    const testCase = scenario()
    const originalTimeout = AbortSignal.timeout
    const scenarioFetch = globalThis.fetch
    const deadline = new AbortController()
    const timeouts: number[] = []
    try {
      const interactive = source === "interactive" ? await testCase.openInteractive("interactive-owner") : null
      if (interactive) interactive.initialized = true
      AbortSignal.timeout = (milliseconds) => {
        timeouts.push(milliseconds)
        return deadline.signal
      }
      globalThis.fetch = Object.assign(
        async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          expect(init?.signal).toBe(deadline.signal)
          return new Promise<Response>((_resolve, reject) => {
            deadline.signal.addEventListener("abort", () => reject(deadline.signal.reason), { once: true })
            queueMicrotask(() => deadline.abort(new DOMException("identity verification timed out", "TimeoutError")))
          })
        },
        { preconnect: scenarioFetch.preconnect },
      )
      const run = testCase.nextRun()
      await testCase.execute(run)
      expect(timeouts).toEqual([10_000])
      expect(testCase.schedules.getRun(run.id)).toMatchObject({ state: "AUTH_REQUIRED", error: "SCHEDULE_LOGIN_REQUIRED", threadId: null })
      expect(testCase.issueCalls()).toBe(source === "exchange" ? 1 : 0)
      expect(testCase.children).toHaveLength(interactive ? 1 : 0)
      expect(testCase.children.every((child) => child.closes === 0)).toBe(true)
      expect(testCase.dispatched).toEqual([])
      expect(testCase.broker.findByPrincipal(principal)).toBe(interactive)
      expect(testCase.activeTokens.size).toBe(interactive ? 1 : 0)
      if (interactive) expect(interactive.accessToken).toBe("interactive-owner")

      globalThis.fetch = scenarioFetch
      AbortSignal.timeout = originalTimeout
      expect(testCase.schedules.resumeAuthorized(principal)).toBe(1)
      const retry = testCase.schedules.claimRunnable()[0]!
      expect(retry.id).toBe(run.id)
      await testCase.execute(retry)
      expect(testCase.schedules.getRun(run.id)?.state).toBe("RUNNING")
      expect(testCase.issueCalls()).toBe(source === "exchange" ? 2 : 0)
      expect(testCase.children).toHaveLength(1)
      expect(testCase.dispatched).toHaveLength(1)
      expect(testCase.broker.findByPrincipal(principal)).toBe(interactive)
    } finally {
      globalThis.fetch = scenarioFetch
      AbortSignal.timeout = originalTimeout
      await testCase.close()
    }
  })

  test("retries the next schedule run after initialization fails without retaining the failed child", async () => {
    const testCase = scenario({ initializeFailures: 1 })
    try {
      const first = testCase.nextRun()
      await testCase.execute(first)
      expect(testCase.schedules.getRun(first.id)).toMatchObject({ state: "BLOCKED", error: expect.stringContaining("SCHEDULE_RUNTIME_START_FAILED") })
      expect(testCase.children[0]!.closes).toBe(1)
      expect(testCase.activeTokens.size).toBe(0)
      expect(testCase.broker.activeCount()).toBe(0)
      expect(testCase.broker.findByPrincipal(principal)).toBeNull()
      const next = testCase.nextRun()
      await testCase.execute(next)
      expect(testCase.schedules.getRun(next.id)?.state).toBe("RUNNING")
      expect(testCase.children).toHaveLength(2)
      expect(testCase.children[1]!.id).not.toBe(testCase.children[0]!.id)
      expect(testCase.children[1]!.methods).toContain("turn/start")
    } finally { await testCase.close() }
  })

  for (const status of ["completed", "failed", "interrupted"] as const) test(`stops the owned native child after ${status} without stopping the owner's login`, async () => {
    const testCase = scenario()
    try {
      const run = testCase.nextRun()
      await testCase.execute(run)
      const child = testCase.children[0]!
      const session = testCase.broker.get(child.id)!
      const interactive = await testCase.openInteractive("interactive-owner")
      interactive.initialized = true
      child.callbacks.onMessage(JSON.stringify({ method: "turn/completed", params: { threadId: testCase.schedules.getRun(run.id)!.threadId, turn: { id: child.turnId, status } } }))
      const stopping = (testCase.runner as any).scheduleRuntimes.get(run.id)?.stopping
      expect(stopping).toBeDefined()
      await stopping
      expect(testCase.schedules.getRun(run.id)?.state).toBe(status === "completed" ? "COMPLETED" : status === "failed" ? "FAILED" : "BLOCKED")
      expect(child.closes).toBe(1)
      expect(child.token).toBeUndefined()
      expect(session.accessToken).toBeUndefined()
      expect(testCase.broker.get(child.id)).toBeNull()
      expect(testCase.broker.findByPrincipal(principal)).toBe(interactive)
      expect(testCase.children[1]!.closes).toBe(0)
    } finally { await testCase.close() }
  })

  for (const status of ["completed", "failed", "interrupted"] as const) test(`binds a native ${status} notification that precedes its dispatch response`, async () => {
    const testCase = scenario({ earlyTerminal: status })
    try {
      const run = testCase.nextRun()
      await testCase.execute(run)
      expect(testCase.schedules.getRun(run.id)?.state).toBe(status === "completed" ? "COMPLETED" : status === "failed" ? "FAILED" : "BLOCKED")
      expect(testCase.children[0]!.closes).toBe(1)
      expect(testCase.activeTokens.size).toBe(0)
      expect(testCase.broker.activeCount()).toBe(0)
    } finally { await testCase.close() }
  })

  test("cleans up an owned process exit and leaves native history recovery possible", async () => {
    const testCase = scenario()
    try {
      const run = testCase.nextRun()
      await testCase.execute(run)
      const child = testCase.children[0]!
      child.callbacks.onExit("native crash")
      await (testCase.runner as any).scheduleRuntimes.get(run.id)?.stopping
      expect(testCase.schedules.getRun(run.id)).toMatchObject({ state: "UNCERTAIN", error: "SCHEDULE_RUNTIME_EXITED", threadId: expect.any(String) })
      expect(child.closes).toBe(1)
      expect(testCase.activeTokens.size).toBe(0)
      expect(testCase.broker.activeCount()).toBe(0)
    } finally { await testCase.close() }
  })

  for (const method of ["model/list", "turn/start"]) test(`stops the authority child after ${method} transport failure`, async () => {
    const testCase = scenario({ failedMethod: method })
    try {
      const run = testCase.nextRun()
      await testCase.execute(run)
      expect(testCase.schedules.getRun(run.id)?.state).toBe(method === "turn/start" ? "UNCERTAIN" : "BLOCKED")
      expect(testCase.children[0]!.closes).toBe(1)
      expect(testCase.activeTokens.size).toBe(0)
      expect(testCase.broker.findByPrincipal(principal)).toBeNull()
    } finally { await testCase.close() }
  })

  test("stops the native child and rejects pending initialization during shutdown", async () => {
    const initializing = barrier()
    const testCase = scenario({ beforeRequest: async (_child, request) => { if (request.method === "initialize") await initializing.wait() } })
    try {
      const run = testCase.nextRun()
      const executing = testCase.execute(run)
      await initializing.ready
      const interactive = await testCase.openInteractive("interactive-owner")
      await testCase.runner.stop()
      await executing
      expect(testCase.children[0]!.closes).toBe(1)
      expect(testCase.activeTokens.size).toBe(1)
      expect(testCase.broker.findByPrincipal(principal)).toBe(interactive)
      expect(testCase.children[1]!.closes).toBe(0)
      expect(testCase.schedules.getRun(run.id)?.state).toBe("BLOCKED")
    } finally { initializing.release(); await testCase.close() }
  })

  test("creates no native child when shutdown occurs during authority exchange", async () => {
    const issuing = barrier()
    const testCase = scenario({ beforeIssue: issuing.wait })
    try {
      const run = testCase.nextRun()
      const executing = testCase.execute(run)
      await issuing.ready
      await testCase.runner.stop()
      issuing.release()
      await executing
      expect(testCase.children).toEqual([])
      expect(testCase.broker.activeCount()).toBe(0)
      expect(testCase.schedules.getRun(run.id)).toMatchObject({ state: "BLOCKED", error: "SCHEDULE_RUNNER_STOPPED" })
    } finally { issuing.release(); await testCase.close() }
  })

  for (const status of ["completed", "failed", "interrupted"] as const) test(`recovers an ownerless ambiguous dispatch as ${status} without dispatching again`, async () => {
    const testCase = scenario({ failedMethod: "turn/start", historyStatus: status })
    try {
      const run = testCase.nextRun()
      await testCase.execute(run)
      expect(testCase.schedules.getRun(run.id)?.state).toBe("UNCERTAIN")
      expect(testCase.broker.findByPrincipal(principal)).toBeNull()
      expect(testCase.activeTokens.size).toBe(0)
      await testCase.recover()
      expect(testCase.schedules.getRun(run.id)).toMatchObject({ state: status === "completed" ? "COMPLETED" : status === "failed" ? "FAILED" : "BLOCKED", threadId: testCase.dispatched[0]!.threadId, turnId: testCase.dispatched[0]!.turnId, attempts: 1 })
      expect(testCase.issueCalls()).toBe(2)
      expect(testCase.dispatched).toHaveLength(1)
      expect(testCase.children[1]!.methods).toEqual(["initialize", "initialized", "thread/turns/list"])
      expect(testCase.children.map((child) => child.closes)).toEqual([1, 1])
      expect(testCase.activeTokens.size).toBe(0)
      expect(testCase.broker.activeCount()).toBe(0)
      expect(testCase.broker.findBySubject(principal.tenant_id, principal.subject_id)).toBeNull()
      expect(testCase.broker.activeSessionPrincipals()).toEqual([])
      expect(testCase.schedules.claimRunnable()).toEqual([])
    } finally { await testCase.close() }
  })

  test("polls an ownerless in-progress turn again after each history-only runtime is reclaimed", async () => {
    const options: ScenarioOptions = { failedMethod: "turn/start", historyStatus: "inProgress" }
    const testCase = scenario(options)
    try {
      const run = testCase.nextRun()
      await testCase.execute(run)
      await testCase.recover()
      expect(testCase.schedules.getRun(run.id)).toMatchObject({ state: "UNCERTAIN", error: "SCHEDULE_RECOVERY_NATIVE_TURN_IN_PROGRESS", turnId: testCase.dispatched[0]!.turnId })
      expect(testCase.broker.activeCount()).toBe(0)
      expect(testCase.activeTokens.size).toBe(0)
      expect(testCase.schedules.claimRunnable()).toEqual([])
      options.historyStatus = "completed"
      await testCase.recover()
      expect(testCase.schedules.getRun(run.id)).toMatchObject({ state: "COMPLETED", turnId: testCase.dispatched[0]!.turnId })
      expect(testCase.issueCalls()).toBe(3)
      expect(testCase.children[2]!.id).not.toBe(testCase.children[1]!.id)
      expect(testCase.children.map((child) => child.closes)).toEqual([1, 1, 1])
      expect(testCase.activeTokens.size).toBe(0)
      expect(testCase.dispatched).toHaveLength(1)
    } finally { await testCase.close() }
  })

  test("keeps a recovered in-progress turn bound to a current interactive runtime until its terminal event", async () => {
    const testCase = scenario({ failedMethod: "turn/start", historyStatus: "inProgress" })
    try {
      const run = testCase.nextRun()
      await testCase.execute(run)
      const interactive = await testCase.openInteractive("interactive-owner")
      interactive.initialized = true
      await testCase.recover()
      expect(testCase.schedules.getRun(run.id)?.state).toBe("RUNNING")
      expect(testCase.issueCalls()).toBe(1)
      const nativeTurn = testCase.dispatched[0]!
      testCase.children[1]!.callbacks.onMessage(JSON.stringify({ method: "turn/completed", params: { threadId: nativeTurn.threadId, turn: { id: nativeTurn.turnId, status: "completed" } } }))
      expect(testCase.schedules.getRun(run.id)?.state).toBe("COMPLETED")
      expect(testCase.broker.findByPrincipal(principal)).toBe(interactive)
      expect(testCase.children[1]!.closes).toBe(0)
      expect(testCase.dispatched).toHaveLength(1)
    } finally { await testCase.close() }
  })

  for (const status of ["completed", "failed", "interrupted"] as const) test(`converges a recovery ${status} event that arrives before its in-progress history response`, async () => {
    const testCase = scenario({ failedMethod: "turn/start", historyStatus: "inProgress", earlyRecoveryTerminal: status })
    try {
      const run = testCase.nextRun()
      await testCase.execute(run)
      await testCase.recover()
      expect(testCase.schedules.getRun(run.id)?.state).toBe(status === "completed" ? "COMPLETED" : status === "failed" ? "FAILED" : "BLOCKED")
      expect(testCase.children.map((child) => child.closes)).toEqual([1, 1])
      expect(testCase.activeTokens.size).toBe(0)
      expect(testCase.dispatched).toHaveLength(1)
    } finally { await testCase.close() }
  })

  for (const failure of ["missing", "exchange-rejected", "exchange-timeout", "identity-rejected", "identity-mismatch", "capability-denied"] as const) test(`keeps ambiguous recovery uncertain when authority is ${failure}`, async () => {
    const options: ScenarioOptions = { failedMethod: "turn/start" }
    const testCase = scenario(options)
    try {
      const run = testCase.nextRun()
      await testCase.execute(run)
      if (failure === "missing") options.issueToken = null
      if (failure === "exchange-rejected") options.beforeIssue = async () => { throw new Error("SCHEDULE_AUTHORITY_UNAVAILABLE") }
      if (failure === "exchange-timeout") options.beforeIssue = async () => { throw new DOMException("authority exchange timed out", "TimeoutError") }
      if (failure === "identity-rejected") options.verificationStatus = 401
      if (failure === "identity-mismatch") options.verifiedPrincipal = { ...principal, subject_id: "another-owner" }
      if (failure === "capability-denied") options.beforeCapability = async () => { throw new Error("PERSONAL_BOT_NOT_ENTITLED") }
      await testCase.recover()
      expect(testCase.schedules.getRun(run.id)).toMatchObject({ state: "UNCERTAIN", error: "SCHEDULE_RECOVERY_AUTH_REQUIRED" })
      expect(testCase.children).toHaveLength(1)
      expect(testCase.children[0]!.closes).toBe(1)
      expect(testCase.broker.activeCount()).toBe(0)
      expect(testCase.activeTokens.size).toBe(0)
      expect(testCase.dispatched).toHaveLength(1)
      expect(testCase.schedules.claimRunnable()).toEqual([])
    } finally { await testCase.close() }
  })

  test("reclaims a timed-out history query and retries recovery using another fresh authority runtime", async () => {
    const options: ScenarioOptions = { failedMethod: "turn/start" }
    const testCase = scenario(options)
    try {
      const run = testCase.nextRun()
      await testCase.execute(run)
      options.beforeRequest = async (_child, request) => { if (request.method === "thread/turns/list") throw new Error("BOT_RUNTIME_REQUEST_TIMEOUT") }
      await testCase.recover()
      expect(testCase.schedules.getRun(run.id)).toMatchObject({ state: "UNCERTAIN", error: "SCHEDULE_RECOVERY_HISTORY_UNAVAILABLE" })
      expect(testCase.children.map((child) => child.closes)).toEqual([1, 1])
      expect(testCase.activeTokens.size).toBe(0)
      options.beforeRequest = undefined
      await testCase.recover()
      expect(testCase.schedules.getRun(run.id)?.state).toBe("COMPLETED")
      expect(testCase.children.map((child) => child.closes)).toEqual([1, 1, 1])
      expect(testCase.dispatched).toHaveLength(1)
    } finally { await testCase.close() }
  })

  test("reclaims a pending history query on shutdown without stopping a concurrent interactive login", async () => {
    const querying = barrier()
    const options: ScenarioOptions = { failedMethod: "turn/start" }
    const testCase = scenario(options)
    try {
      const run = testCase.nextRun()
      await testCase.execute(run)
      options.beforeRequest = async (_child, request) => { if (request.method === "thread/turns/list") await querying.wait() }
      const recovering = testCase.recover()
      await querying.ready
      const interactive = await testCase.openInteractive("interactive-owner")
      await testCase.runner.stop()
      await recovering
      expect(testCase.schedules.getRun(run.id)).toMatchObject({ state: "UNCERTAIN", error: "SCHEDULE_RECOVERY_STOPPED" })
      expect(testCase.children.map((child) => child.closes)).toEqual([1, 1, 0])
      expect(testCase.activeTokens.size).toBe(1)
      expect(testCase.broker.findByPrincipal(principal)).toBe(interactive)
      expect(testCase.dispatched).toHaveLength(1)
    } finally { querying.release(); await testCase.close() }
  })

  for (const phase of ["issue", "verify", "capability"] as const) test(`starts no recovery child after shutdown during ${phase}`, async () => {
    const paused = barrier()
    const options: ScenarioOptions = { failedMethod: "turn/start" }
    const testCase = scenario(options)
    try {
      const run = testCase.nextRun()
      await testCase.execute(run)
      if (phase === "issue") options.beforeIssue = paused.wait
      if (phase === "verify") options.beforeVerify = paused.wait
      if (phase === "capability") options.beforeCapability = paused.wait
      const recovering = testCase.recover()
      await paused.ready
      await testCase.runner.stop()
      paused.release()
      await recovering
      expect(testCase.schedules.getRun(run.id)).toMatchObject({ state: "UNCERTAIN", error: "SCHEDULE_RECOVERY_STOPPED" })
      expect(testCase.children).toHaveLength(1)
      expect(testCase.activeTokens.size).toBe(0)
      expect(testCase.broker.activeCount()).toBe(0)
      expect(testCase.dispatched).toHaveLength(1)
    } finally { paused.release(); await testCase.close() }
  })
})
