import { expect, test } from "bun:test"
import { BotRegistry } from "./bot-registry"
import { RuntimeBroker } from "./runtime-broker"
import { BotToolSessions } from "./bot-tool-sessions"
import { createBotModelDirectory } from "./model-directory"
import { runApprovedBotInvocation } from "./routes/invocations"
import type { BotServerContext } from "./context"
import type { Turn } from "./generated/v2/Turn"

test("turn send rejection settles failure while broker retains its runtime", async () => {
  const registry = new BotRegistry(":memory:")
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const caller = registry.create(principal, { name: "Caller", description: "Original" })
  const target = registry.create(principal, { name: "Target", description: "Delegated" })
  const invocation = registry.createHandoffs(principal, { fromBotId: caller.id, toBotId: target.id, fact: "Send failure" })[0]!
  const broker = new RuntimeBroker({ provision: async () => { throw new Error("not used") } })
  let closes = 0
  const context = { botRegistry: registry, runtimeBroker: broker, botToolSessions: new BotToolSessions(), modelDirectory: createBotModelDirectory({}),
    createCodexRuntime: (_token, callbacks) => ({
      async send(line) {
        const request = JSON.parse(line)
        if (request.method === "initialize") callbacks.onMessage(JSON.stringify({ id: request.id, result: {} }))
        if (request.method === "thread/start") callbacks.onMessage(JSON.stringify({ id: request.id, result: { thread: { id: "target-thread" } } }))
        if (request.method === "turn/start") throw new Error("pipe closed")
      },
      async close() { closes++; callbacks.onExit("closed") },
    }),
  } as BotServerContext
  try {
    await runApprovedBotInvocation(context, invocation.invocationId, "test-token")
    expect(registry.getInvocationForService(invocation.invocationId)?.decisionReason).toBe("TARGET_TURN_SEND_FAILED")
    expect(registry.getInvocationForService(invocation.invocationId)?.state).toBe("FAILED")
    expect(closes).toBe(0)
  } finally { await broker.close(); registry.close() }
  expect(closes).toBe(1)
})

test.each(["preparing", "initializing", "running"] as const)("shutdown waits for invocation runtime while %s and prevents later starts", async (phase) => {
  const registry = new BotRegistry(":memory:")
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const caller = registry.create(principal, { name: "Caller", description: "Original" })
  const target = registry.create(principal, { name: "Target", description: "Delegated" })
  const invocation = registry.createHandoffs(principal, { fromBotId: caller.id, toBotId: target.id, fact: "Wait for shutdown" })[0]!
  const broker = new RuntimeBroker({ provision: async () => { throw new Error("not used") } })
  let reached!: () => void
  let releaseSetup!: () => void
  let closeStarted!: () => void
  let releaseClose!: () => void
  const ready = new Promise<void>((resolve) => { reached = resolve })
  const setup = new Promise<void>((resolve) => { releaseSetup = resolve })
  const closing = new Promise<void>((resolve) => { closeStarted = resolve })
  const closed = new Promise<void>((resolve) => { releaseClose = resolve })
  let spawned = 0
  let closes = 0
  const sent: string[] = []
  const directory = createBotModelDirectory({})
  const context = {
    botRegistry: registry, runtimeBroker: broker, botToolSessions: new BotToolSessions(),
    modelDirectory: { ...directory, resolve: async (...args) => {
      if (phase === "preparing") { reached(); await setup }
      return directory.resolve(...args)
    } },
    createCodexRuntime: (_token, callbacks) => {
      spawned++
      return {
        async send(line) {
          const request = JSON.parse(line)
          sent.push(request.method)
          if (request.method === "skills/extraRoots/set" && phase === "initializing") { reached(); await setup }
          if (request.method === "initialize") callbacks.onMessage(JSON.stringify({ id: request.id, result: {} }))
          if (request.method === "thread/start") callbacks.onMessage(JSON.stringify({ id: request.id, result: { thread: { id: "target-thread" } } }))
          if (request.method === "turn/start") {
            callbacks.onMessage(JSON.stringify({ id: request.id, result: { turn: { id: "shutdown-turn" } } }))
            callbacks.onMessage(JSON.stringify({ method: "turn/started", params: { threadId: "target-thread", turn: { id: "shutdown-turn", status: "inProgress", items: [] } } }))
            reached()
          }
        },
        async close() { closes++; closeStarted(); callbacks.onExit("server shutdown"); await closed },
      }
    },
  } as BotServerContext
  try {
    const task = runApprovedBotInvocation(context, invocation.invocationId, "test-token")
    await ready
    let finished = false
    const shutdown = broker.close().then(() => { finished = true })
    releaseSetup()
    if (phase !== "preparing") {
      await closing
      await Promise.resolve()
      expect(finished).toBe(false)
      releaseClose()
    }
    await Promise.all([task, shutdown])
    expect(closes).toBe(phase === "preparing" ? 0 : 1)
    if (phase === "initializing") {
      expect(sent).not.toContain("plugin/list")
      expect(sent).not.toContain("thread/start")
      expect(sent).not.toContain("turn/start")
    }
    expect(registry.getInvocationForService(invocation.invocationId)?.state).toBe("FAILED")
    expect(registry.continuations.pending()[0]?.outcome).toBe("FAILED")
    if (phase === "running") {
      expect(registry.timeline.hasRunningTurns(target.id)).toBe(false)
      expect(registry.timeline.turnStatus(target.id, "target-thread", "shutdown-turn")).toBe("interrupted")
      expect(registry.getSession(target.id)?.workState).toBe("stopped")
    }
    const later = registry.createHandoffs(principal, { fromBotId: caller.id, toBotId: target.id, fact: "Wait for restart" })[0]!
    await runApprovedBotInvocation(context, later.invocationId, "test-token")
    expect(spawned).toBe(phase === "preparing" ? 0 : 1)
    expect(registry.getInvocationForService(later.invocationId)?.state).toBe("APPROVED")
  } finally { releaseSetup(); releaseClose(); await broker.close(); registry.close() }
})

test("handoff waits for native work then reuses its owner writer without closing chat", async () => {
  const registry = new BotRegistry(":memory:")
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const caller = registry.create(principal, { name: "Caller", description: "Original" })
  const target = registry.create(principal, { name: "Target", description: "Delegated" })
  registry.saveSession({ botId: target.id, appServerThreadId: "owned-thread" })
  const invocation = registry.createHandoffs(principal, { fromBotId: caller.id, toBotId: target.id, fact: "Use existing writer" })[0]!
  const broker = new RuntimeBroker({ provision: async () => { throw new Error("not used") } })
  let closes = 0
  let spawned = 0
  const sent: any[] = []
  const browserMessages: any[] = []
  const session = await broker.start(principal, { onMessage: (line) => { browserMessages.push(JSON.parse(line)) }, onExit() {} }, (events) => ({
    async send(line) {
      const request = JSON.parse(line)
      sent.push(request)
      if (request.method === "thread/resume") events.onMessage(JSON.stringify({ id: request.id, result: { thread: { id: "owned-thread" } } }))
      if (request.method === "turn/start") {
        events.onMessage(JSON.stringify({ id: request.id, result: { turn: { id: "handoff-turn" } } }))
        for (const [threadId, turnId, text] of [["other-thread", "other-turn", "unrelated"], ["owned-thread", "handoff-turn", "owned result"]]) {
          events.onMessage(JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [{ type: "agentMessage", text }] } } }))
        }
      }
    },
    async close() { closes++ },
  }))
  session.initialized = true
  const context = { botRegistry: registry, runtimeBroker: broker, botToolSessions: new BotToolSessions(), modelDirectory: createBotModelDirectory({}),
    createCodexRuntime: () => { spawned++; throw new Error("second writer forbidden") },
  } as unknown as BotServerContext
  try {
    registry.timeline.putTurn(target.id, "owned-thread", { id: "original-turn", status: "inProgress", items: [] } as unknown as Turn)
    await runApprovedBotInvocation(context, invocation.invocationId, "test-token")
    expect(registry.getInvocationForService(invocation.invocationId)?.state).toBe("APPROVED")
    expect(sent).toHaveLength(0)
    registry.timeline.putTurn(target.id, "owned-thread", { id: "original-turn", status: "completed", items: [] } as unknown as Turn)
    await runApprovedBotInvocation(context, invocation.invocationId, "test-token")
    expect(registry.getInvocationForService(invocation.invocationId)?.state).toBe("COMPLETED")
    expect(spawned).toBe(0)
    expect(closes).toBe(0)
    expect(sent.map((request) => request.method)).toEqual(["thread/resume", "turn/start"])
    expect(sent[0].params.threadId).toBe("owned-thread")
    expect(sent[1].params.approvalPolicy).toBe("on-request")
    expect(sent[1].params.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false })
    expect(browserMessages.every((message) => message.id === undefined)).toBe(true)
    expect(broker.get(session.id)).toBeDefined()
  } finally { await broker.close(); registry.close() }
  expect(closes).toBe(1)
})

test("a second handoff remains approved while the target already has an invocation", async () => {
  const registry = new BotRegistry(":memory:")
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const caller = registry.create(principal, { name: "Caller", description: "Original" })
  const target = registry.create(principal, { name: "Target", description: "Delegated" })
  const first = registry.createHandoffs(principal, { fromBotId: caller.id, toBotId: target.id, fact: "First" })[0]!
  registry.beginInvocation(first.invocationId)
  const second = registry.createHandoffs(principal, { fromBotId: caller.id, toBotId: target.id, fact: "Second" })[0]!
  const broker = new RuntimeBroker({ provision: async () => { throw new Error("not used") } })
  try {
    await runApprovedBotInvocation({ botRegistry: registry, runtimeBroker: broker } as BotServerContext, second.invocationId, "test-token")
    expect(registry.getInvocationForService(first.invocationId)?.state).toBe("RUNNING")
    expect(registry.getInvocationForService(second.invocationId)?.state).toBe("APPROVED")
  } finally { await broker.close(); registry.close() }
})

test("browser joining an offline handoff shares the initializing process", async () => {
  const registry = new BotRegistry(":memory:")
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const caller = registry.create(principal, { name: "Caller", description: "Original" })
  const target = registry.create(principal, { name: "Target", description: "Target" })
  const invocation = registry.createHandoffs(principal, { fromBotId: caller.id, toBotId: target.id, fact: "Offline then reconnect" })[0]!
  const broker = new RuntimeBroker({ provision: async () => { throw new Error("not used") } })
  let ready!: () => void
  const initializing = new Promise<void>((resolve) => { ready = resolve })
  let completeInitialize!: () => void
  let spawned = 0
  let initializes = 0
  let closes = 0
  const received: any[] = []
  const context = { botRegistry: registry, runtimeBroker: broker, modelDirectory: createBotModelDirectory({}), botToolSessions: new BotToolSessions(), createCodexRuntime: (_token, callbacks) => {
    spawned++
    return {
      async send(line) {
        const request = JSON.parse(line)
        if (request.method === "initialize") { initializes++; completeInitialize = () => callbacks.onMessage(JSON.stringify({ id: request.id, result: { version: "native" } })); ready() }
        if (request.method === "thread/start") callbacks.onMessage(JSON.stringify({ id: request.id, result: { thread: { id: "offline-thread" } } }))
        if (request.method === "turn/start") {
          callbacks.onMessage(JSON.stringify({ id: request.id, result: { turn: { id: "offline-turn" } } }))
          callbacks.onMessage(JSON.stringify({ method: "turn/completed", params: { threadId: "offline-thread", turn: { id: "offline-turn", status: "completed", items: [] } } }))
        }
      }, async close() { closes++ },
    }
  } } as BotServerContext
  try {
    const task = runApprovedBotInvocation(context, invocation.invocationId, "owner-token")
    await initializing
    const browser = { onMessage: (line: string) => { received.push(JSON.parse(line)) }, onExit() {} }
    const session = await broker.start(principal, browser, () => { throw new Error("duplicate writer") }, "owner-token")
    const channel = broker.channel(session.id, browser)!
    await channel.send(JSON.stringify({ id: 50, method: "initialize" }))
    expect(initializes).toBe(1)
    completeInitialize()
    await task
    expect(spawned).toBe(1)
    expect(closes).toBe(0)
    expect(received).toContainEqual({ id: 50, result: { version: "native" } })
    expect(registry.getInvocationForService(invocation.invocationId)?.state).toBe("COMPLETED")
    expect(broker.get(session.id)?.initialized).toBe(true)
  } finally { await broker.close(); registry.close() }
  expect(closes).toBe(1)
})
