import { expect, test } from "bun:test"
import { BotRegistry } from "./bot-registry"
import { BotSchedules } from "./bot-schedules"
import { createCapabilityGate } from "./capability-gate"
import { RuntimeBroker } from "./runtime-broker"
import { BotToolSessions } from "./bot-tool-sessions"
import { createBotModelDirectory } from "./model-directory"
import { createRuntimePolicyClient } from "./runtime-policy"
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
  const sent: Array<{ method?: string; params?: Record<string, unknown> }> = []
  const context = { botRegistry: registry, runtimeBroker: broker, botToolSessions: new BotToolSessions(), modelDirectory: createBotModelDirectory({}),
    createCodexRuntime: (_token, callbacks) => ({
      async send(line) {
        const request = JSON.parse(line)
        sent.push(request)
        if (request.method === "initialize") callbacks.onMessage(JSON.stringify({ id: request.id, result: {} }))
        if (request.method === "model/list") callbacks.onMessage(JSON.stringify({ id: request.id, result: { data: [{ id: "astra-id", model: "gpt-6-astra", hidden: false, isDefault: true }], nextCursor: null } }))
        if (request.method === "thread/start") callbacks.onMessage(JSON.stringify({ id: request.id, result: { thread: { id: "target-thread" } } }))
        if (request.method === "turn/start") throw new Error("pipe closed")
      },
      async close() { closes++; callbacks.onExit("closed") },
    }),
  } as BotServerContext
  try {
    await runApprovedBotInvocation(context, invocation.invocationId, "test-token")
    expect(sent.find((request) => request.method === "thread/start")?.params?.model).toBe("gpt-6-astra")
    expect(sent.find((request) => request.method === "turn/start")?.params?.model).toBe("gpt-6-astra")
    expect(registry.getInvocationForService(invocation.invocationId)?.decisionReason).toBe("TARGET_TURN_SEND_FAILED")
    expect(registry.getInvocationForService(invocation.invocationId)?.state).toBe("FAILED")
    expect(closes).toBe(0)
  } finally { await broker.close(); registry.close() }
  expect(closes).toBe(1)
})

test("handoff binds a company model thread to its target Bot relay URL", async () => {
  const registry = new BotRegistry(":memory:")
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const caller = registry.create(principal, { name: "Caller", description: "Original" })
  const target = registry.create(principal, { name: "Target", description: "Delegated", modelRoute: "genio-gateway" })
  const invocation = registry.createHandoffs(principal, { fromBotId: caller.id, toBotId: target.id, fact: "Use the target route" })[0]!
  const broker = new RuntimeBroker({ provision: async () => { throw new Error("not used") } })
  const originalRelayOrigin = process.env.GENIO_ONE_MODEL_GATEWAY_RELAY_ORIGIN
  const sent: Array<{ method?: string; params?: Record<string, unknown> }> = []
  let runtimeSessionId = ""
  let runtimeRelaySecret = ""
  process.env.GENIO_ONE_MODEL_GATEWAY_RELAY_ORIGIN = "https://relay.example"
  const modelDirectory = {
    availableRoutes: () => ["genio-gateway" as const],
    supports: () => true,
    async resolve() {
      return [{ publicModelId: "company-model", displayName: "Company Model", route: { kind: "genio-gateway" as const, modelProvider: "genio_one" } }]
    },
  }
  const context: BotServerContext = {
    botRegistry: registry,
    botSchedules: new BotSchedules(registry.db),
    capabilityGate: createCapabilityGate({ mode: "open" }),
    runtimeBroker: broker,
    botToolSessions: new BotToolSessions(),
    modelDirectory,
    runtimePolicy: createRuntimePolicyClient(),
    createCodexRuntime: (_token, callbacks, namespace, relaySecret) => {
      runtimeSessionId = namespace?.runtimeSessionId ?? ""
      runtimeRelaySecret = relaySecret ?? ""
      return {
        async send(line: string) {
          const request = JSON.parse(line)
          sent.push(request)
          if (request.method === "initialize") callbacks.onMessage(JSON.stringify({ id: request.id, result: {} }))
          if (request.method === "thread/start") callbacks.onMessage(JSON.stringify({ id: request.id, result: { thread: { id: "target-thread" } } }))
          if (request.method === "turn/start") {
            callbacks.onMessage(JSON.stringify({ id: request.id, result: { turn: { id: "target-turn" } } }))
            callbacks.onMessage(JSON.stringify({ method: "turn/completed", params: { threadId: "target-thread", turn: { id: "target-turn", status: "completed", items: [{ type: "agentMessage", text: "done" }] } } }))
          }
        },
        async close() {},
      }
    },
  }
  try {
    await runApprovedBotInvocation(context, invocation.invocationId, "test-token")
    const threadStart = sent.find((request) => request.method === "thread/start")
    const turnStart = sent.find((request) => request.method === "turn/start")
    expect(threadStart?.params?.config).toMatchObject({
      "mcp_servers.genio_discovery": {
        url: `https://relay.example/api/discovery-mcp/${encodeURIComponent(runtimeSessionId)}/bots/${encodeURIComponent(target.id)}/mcp`,
        bearer_token_env_var: "GENIO_ONE_MCP_BEARER_TOKEN",
      },
      "model_providers.genio_one.base_url": `https://relay.example/api/model-gateway/${encodeURIComponent(runtimeSessionId)}/bots/${encodeURIComponent(target.id)}/v1`,
    })
    expect(threadStart?.params?.model).toBe("company-model")
    expect(turnStart?.params?.model).toBe("company-model")
    const runtimeSession = broker.get(runtimeSessionId)
    if (!runtimeSession) throw new Error("RUNTIME_SESSION_NOT_FOUND")
    expect(runtimeRelaySecret).toBe(runtimeSession.relaySecret)
    expect(registry.getInvocationForService(invocation.invocationId)?.state).toBe("COMPLETED")
  } finally {
    if (originalRelayOrigin === undefined) delete process.env.GENIO_ONE_MODEL_GATEWAY_RELAY_ORIGIN
    else process.env.GENIO_ONE_MODEL_GATEWAY_RELAY_ORIGIN = originalRelayOrigin
    await broker.close()
    registry.close()
  }
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
  const context = {
    botRegistry: registry, runtimeBroker: broker, botToolSessions: new BotToolSessions(),
    modelDirectory: createBotModelDirectory({}),
    createCodexRuntime: (_token, callbacks) => {
      spawned++
      return {
        async send(line) {
          const request = JSON.parse(line)
          sent.push(request.method)
          if (request.method === "skills/extraRoots/set" && phase === "initializing") { reached(); await setup }
          if (request.method === "initialize") callbacks.onMessage(JSON.stringify({ id: request.id, result: {} }))
          if (request.method === "model/list") {
            if (phase === "preparing") { reached(); await setup }
            callbacks.onMessage(JSON.stringify({ id: request.id, result: { data: [{ id: "astra-id", model: "gpt-6-astra", hidden: false, isDefault: true }], nextCursor: null } }))
          }
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
    await closing
    await Promise.resolve()
    expect(finished).toBe(false)
    releaseClose()
    await Promise.all([task, shutdown])
    expect(closes).toBe(1)
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
    expect(spawned).toBe(1)
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
      if (request.method === "model/list") events.onMessage(JSON.stringify({ id: request.id, result: { data: [{ id: "astra-id", model: "gpt-6-astra", hidden: false, isDefault: true }], nextCursor: null } }))
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
    expect(sent.map((request) => request.method)).toEqual(["model/list", "thread/resume", "turn/start"])
    expect(sent[1].params.threadId).toBe("owned-thread")
    expect(sent[1].params.model).toBe("gpt-6-astra")
    expect(sent[2].params.model).toBe("gpt-6-astra")
    expect(sent[2].params.approvalPolicy).toBe("on-request")
    expect(sent[2].params.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false })
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
        if (request.method === "model/list") callbacks.onMessage(JSON.stringify({ id: request.id, result: { data: [{ id: "astra-id", model: "gpt-6-astra", hidden: false, isDefault: true }], nextCursor: null } }))
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
