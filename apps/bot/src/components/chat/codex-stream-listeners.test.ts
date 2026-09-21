import { afterEach, describe, expect, test } from "bun:test"

import { CodexClient } from "../../lib/codex-client"
import type { BotInstance } from "../../bots-storage"
import { GOOGLE_GEMINI_PREPAYMENT_DEPLETED_MESSAGE, MODEL_PROVIDER_RATE_LIMITED_MESSAGE } from "../../lib/model-route"
import { registerCodexStreamListeners, type PendingExecution } from "./codex-stream-listeners"

function harness(options: { deferTimeout?: boolean; isPendingExecutionCurrent?: () => boolean } = {}) {
  const client = new CodexClient()
  const timeouts: Array<() => void> = []
  const pendingTasks: string[] = []
  const restoredTasks: string[] = []
  const messages: Array<{ id: string; text: string }> = []
  const pendingExecutionRef = { current: null as PendingExecution | null }
  const state = {
    runtimeState: "就緒",
    agentState: "idle",
    threadReady: true,
    channelReady: true,
    turnRunning: true,
    signedOut: false,
  }
  const bot = {
    id: "bot-dylan",
    name: "Dylan",
    role: "工程代理",
    description: "工程代理",
    title: "工程代理",
    workspacePath: "/srv/genio",
    modelRoute: "codex-subscription",
    skills: [],
    bindings: [],
  } as unknown as BotInstance
  const activeBotRef = { current: bot }
  const set = <Key extends keyof typeof state>(key: Key) => (value: (typeof state)[Key] | ((current: (typeof state)[Key]) => (typeof state)[Key])) => {
    state[key] = typeof value === "function"
      ? (value as (current: (typeof state)[Key]) => (typeof state)[Key])(state[key])
      : value
  }
  const unsubscribe = registerCodexStreamListeners({
    isMounted: () => true,
    safeTimeout: (fn: () => void) => {
      if (options.deferTimeout) {
        timeouts.push(fn)
        return 0 as unknown as ReturnType<typeof setTimeout>
      }
      return setTimeout(fn, 0)
    },
    client,
    tokenRef: { current: "token" },
    activeBotRef,
    threadRef: { current: "thread-dylan" },
    threadBotIdRef: { current: "bot-dylan" },
    runtimeDetailsRef: { current: null },
    completedItemIdsRef: { current: new Set() },
    pendingArtifactRef: { current: null },
    pendingExecutionRef,
    modelDirectoryModelsRef: { current: [] },
    loggedInRef: { current: false },
    isTurnRunningRef: { current: true },
    setRuntime: () => {},
    setRuntimeTiers: () => {},
    setRuntimeState: set("runtimeState"),
    setModelDirectory: () => {},
    setModels: () => {},
    setSelectedModel: () => {},
    setCodexLogin: () => {},
    setAgentState: set("agentState"),
    setMessages: (next: Array<{ id: string; text: string }> | ((current: Array<{ id: string; text: string }>) => Array<{ id: string; text: string }>)) => {
      const resolved = typeof next === "function" ? next(messages) : next
      messages.splice(0, messages.length, ...resolved)
    },
    setArtifacts: () => {},
    setActivities: () => {},
    setThreadReady: set("threadReady"),
    setChannelReady: set("channelReady"),
    setApproval: () => {},
    setUserInputRequest: () => {},
    setElicitationRequest: () => {},
    setMcpStatus: () => {},
    setDynamicSkills: () => {},
    setTurnRunning: (running: boolean) => { state.turnRunning = running },
    prepareCodexSession: async () => {},
    attachRuntimeDesktop: async () => {},
    isPendingExecutionCurrent: options.isPendingExecutionCurrent ? () => options.isPendingExecutionCurrent!() : undefined,
    onPendingExecutionReady: (task: string) => { pendingTasks.push(task) },
    onSignOut: () => { state.signedOut = true },
    focusInput: () => {},
    startThread: async () => {},
  } as never)
  const receive = (message: Record<string, unknown>) => {
    (client as unknown as { receive(raw: string): void }).receive(JSON.stringify(message))
  }
  const status = (value: "connecting" | "connected" | "disconnected" | "reconnecting") => {
    const handlers = (client as unknown as { statusHandlers: Set<(status: string) => void> }).statusHandlers
    for (const handler of handlers) handler(value)
  }
  const close = (code: number, reason: string) => {
    const handlers = (client as unknown as { closeHandlers: Set<(event: { code: number; reason: string }) => void> }).closeHandlers
    for (const handler of handlers) handler({ code, reason })
  }
  return { client, state, receive, status, close, unsubscribe, activeBotRef, pendingExecutionRef, pendingTasks, restoredTasks, timeouts, messages }
}

describe("Codex stream runtime errors", () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  test("runtime policy denial preserves conversation and identifies the execution environment", () => {
    const value = harness()
    cleanups.push(value.unsubscribe)
    value.receive({ method: "genio/runtime/error", params: { tier: "headless", message: "DEFAULT_DENY" } })

    expect(value.state.threadReady).toBe(true)
    expect(value.state.channelReady).toBe(true)
    expect(value.state.turnRunning).toBe(true)
    expect(value.state.agentState).toBe("exclaim")
    expect(value.state.runtimeState).toBe("Headless：公司政策不允許啟動執行環境。 [DEFAULT_DENY]")
    expect(value.state.signedOut).toBe(false)
  })

  test("keeps the tier-specific runtime denial when the legacy event follows", () => {
    const value = harness()
    cleanups.push(value.unsubscribe)
    value.receive({ method: "genio/runtime/error", params: { tier: "headless", message: "DEFAULT_DENY" } })
    value.receive({ method: "genio/runtimeError", params: { message: "DEFAULT_DENY" } })

    expect(value.state.runtimeState).toBe("Headless：公司政策不允許啟動執行環境。 [DEFAULT_DENY]")
  })

  test("disabled connection survives a 1008 close without sign-out and preserves the reason", () => {
    const value = harness()
    cleanups.push(value.unsubscribe)
    value.receive({ method: "genio/runtime/error", params: { message: "BOT_CONNECTION_DISABLED" } })
    value.close(1008, "BOT_CONNECTION_DISABLED")
    value.status("disconnected")

    expect(value.state.signedOut).toBe(false)
    expect(value.state.agentState).toBe("exclaim")
    expect(value.state.runtimeState).toBe("Genio Bot 服務已停用，請聯絡管理員。 [BOT_CONNECTION_DISABLED]")
  })

  test("session expiry still signs out while a later connection clears the terminal error", () => {
    const expired = harness()
    cleanups.push(expired.unsubscribe)
    expired.close(1008, "GENIO_ONE_SESSION_REJECTED")
    expect(expired.state.signedOut).toBe(true)

    const reconnected = harness()
    cleanups.push(reconnected.unsubscribe)
    reconnected.receive({ method: "genio/runtime/error", params: { message: "BOT_CONNECTION_DISABLED" } })
    reconnected.status("connecting")
    reconnected.status("disconnected")
    expect(reconnected.state.runtimeState).toBe("連線中斷")
    expect(reconnected.state.agentState).toBe("sleep")
  })

  test("a failed turn turns the native Gemini quota response into a safe recovery message", () => {
    const value = harness()
    cleanups.push(value.unsubscribe)
    value.receive({
      method: "turn/completed",
      params: {
        threadId: "thread-dylan",
        turn: {
          status: "failed",
          error: {
            message: "Google API error 429 RESOURCE_EXHAUSTED: Your prepayment credits are depleted. https://generativelanguage.googleapis.com/v1beta/models?key=not-for-display",
          },
        },
      },
    })

    expect(value.state.turnRunning).toBe(false)
    expect(value.state.agentState).toBe("exclaim")
    expect(value.state.runtimeState).toBe(GOOGLE_GEMINI_PREPAYMENT_DEPLETED_MESSAGE)
    expect(value.state.runtimeState).not.toContain("not-for-display")
  })

  test("a failed turn maps the retry-limited 429 without attributing a provider-specific cause", () => {
    const value = harness()
    cleanups.push(value.unsubscribe)
    value.receive({
      method: "turn/completed",
      params: {
        threadId: "thread-dylan",
        turn: { status: "failed", error: { message: "exceeded retry limit, last status: 429 Too Many Requests" } },
      },
    })

    expect(value.state.agentState).toBe("exclaim")
    expect(value.state.runtimeState).toBe(MODEL_PROVIDER_RATE_LIMITED_MESSAGE)
    expect(value.state.runtimeState).not.toContain("Google Gemini")
  })

  test("does not dispatch a replaced pending task after runtime preparation", async () => {
    const value = harness({ deferTimeout: true })
    cleanups.push(value.unsubscribe)
    const pending = {
      task: "建立報表",
      progressId: "runtime-provisioning-1",
      botId: "bot-dylan",
      connectionGeneration: 0,
      modelRoute: "codex-subscription" as const,
      restoreDraft: () => { value.restoredTasks.push("建立報表") },
    }
    value.pendingExecutionRef.current = pending
    value.receive({ method: "genio/runtime/ready", params: { tier: "headless", environmentId: "env-1", execReady: true } })
    await Promise.resolve()
    value.pendingExecutionRef.current = {
      ...pending,
      task: "新 Bot 的工作",
      progressId: "runtime-provisioning-2",
    }

    for (const timeout of value.timeouts) timeout()

    expect(value.pendingTasks).toEqual([])
    expect(value.pendingExecutionRef.current?.task).toBe("新 Bot 的工作")
  })

  test("cancels a stale pending task with recoverable text", async () => {
    const value = harness({ deferTimeout: true, isPendingExecutionCurrent: () => false })
    cleanups.push(value.unsubscribe)
    value.pendingExecutionRef.current = {
      task: "建立報表",
      progressId: "runtime-provisioning-1",
      botId: "bot-dylan",
      connectionGeneration: 0,
      modelRoute: "codex-subscription",
      restoreDraft: () => { value.restoredTasks.push("建立報表") },
    }
    value.receive({ method: "genio/runtime/ready", params: { tier: "headless", environmentId: "env-1", execReady: true } })
    await Promise.resolve()

    for (const timeout of value.timeouts) timeout()

    expect(value.pendingTasks).toEqual([])
    expect(value.pendingExecutionRef.current).toBeNull()
    expect(value.restoredTasks).toEqual(["建立報表"])
    expect(value.messages.at(-1)?.text).toContain("建立報表")
  })

  test("does not write a stale task into a different Bot transcript", async () => {
    const value = harness({ deferTimeout: true, isPendingExecutionCurrent: () => false })
    cleanups.push(value.unsubscribe)
    value.pendingExecutionRef.current = {
      task: "建立報表",
      progressId: "runtime-provisioning-1",
      botId: "bot-dylan",
      connectionGeneration: 0,
      modelRoute: "codex-subscription",
      restoreDraft: () => { value.restoredTasks.push("建立報表") },
    }
    value.receive({ method: "genio/runtime/ready", params: { tier: "headless", environmentId: "env-1", execReady: true } })
    await Promise.resolve()
    value.activeBotRef.current = { ...value.activeBotRef.current, id: "bot-new" }

    for (const timeout of value.timeouts) timeout()

    expect(value.pendingTasks).toEqual([])
    expect(value.pendingExecutionRef.current).toBeNull()
    expect(value.restoredTasks).toEqual(["建立報表"])
    expect(value.messages).toEqual([])
  })
})
