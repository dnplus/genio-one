import { expect, test } from "bun:test"
import Fastify from "fastify"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotRegistry } from "./bot-registry"
import { BotWorkspaceStore } from "./bot-workspace-store"
import type { HandsPlacementGate } from "./hands-placement-gate"
import { BotSchedules } from "./bot-schedules"
import { reconcileTerminalInvocations, recoverApprovedInvocations, recoverNativeInvocationResults } from "./invocation-recovery"
import type { Turn } from "./generated/v2/Turn"
import { RuntimeBroker } from "./runtime-broker"
import { createCapabilityGate } from "./capability-gate"
import { createBotModelDirectory } from "./model-directory"
import { BotToolSessions } from "./bot-tool-sessions"
import type { BotServerContext } from "./context"
import type { BotDeletionReconciler } from "./bot-deletion-reconciler"
import { modelGatewayRelayRoutes } from "./model-gateway-relay"
import type { RuntimePolicyResolveInput } from "./runtime-policy-contract"
import { runApprovedBotInvocation } from "./routes/invocations"

test("interrupted native work recovers a failure instead of hanging or completing", () => {
  const registry = new BotRegistry(":memory:")
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  try {
    const caller = registry.create(principal, { name: "Caller", description: "Original" })
    const target = registry.create(principal, { name: "Target", description: "Delegated" })
    const handoff = registry.createHandoffs(principal, { fromBotId: caller.id, toBotId: target.id, fact: "Interrupted task" })[0]!
    registry.beginInvocation(handoff.invocationId)
    registry.timeline.putTurn(target.id, "target-thread", { id: "interrupted", status: "interrupted", items: [{ type: "userMessage", id: "input", clientId: `handoff-task:${handoff.invocationId}`, content: [] }] } as unknown as Turn)
    reconcileTerminalInvocations(registry)
    reconcileTerminalInvocations(registry)
    expect(registry.getInvocationForService(handoff.invocationId)?.state).toBe("FAILED")
    expect(registry.listHandoffEvents(principal, caller.id).filter((event) => event.type === "handoff.failed")).toHaveLength(1)
    expect(registry.listHandoffEvents(principal, caller.id).some((event) => event.type === "handoff.replied")).toBe(false)
    expect(registry.continuations.pending()[0]?.outcome).toBe("FAILED")
    const pending = registry.createHandoffs(principal, { fromBotId: caller.id, toBotId: target.id, fact: "Approval deadline" })[0]!
    registry.db.query("update bot_invocations set state = 'PENDING', expires_at = ? where request_id = ?").run(Date.now() - 1, pending.invocationId)
    registry.expirePendingInvocations()
    registry.expirePendingInvocations()
    expect(registry.continuations.pending().filter((entry) => entry.invocation_id === pending.invocationId).map((entry) => entry.outcome)).toEqual(["EXPIRED"])
  } finally { registry.close() }
})

test("native-only results recover through scoped paginated reads without starting another turn", async () => {
  const registry = new BotRegistry(":memory:")
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const broker = new RuntimeBroker({ provision: async () => { throw new Error("not used") } })
  try {
    const caller = registry.create(principal, { name: "Caller", description: "Original" })
    const target = registry.create(principal, { name: "Target", description: "Delegated" })
    registry.rememberThread(caller.id, "caller-thread")
    registry.rememberThread(target.id, "target-thread")
    const handoff = registry.createHandoffs(principal, { fromBotId: caller.id, toBotId: target.id, fact: "Find result" })[0]!
    registry.beginInvocation(handoff.invocationId)
    let completed = false
    let requests = 0
    const session = await broker.start(principal, { onMessage() {}, onExit() {} }, (callbacks) => ({
      async send(line) {
        const request = JSON.parse(line)
        expect(request.method).toBe("thread/turns/list")
        expect(request.params.threadId).toBe("target-thread")
        requests++
        const turn = { id: "native-result", status: completed ? "completed" : "inProgress", items: [
          { type: "userMessage", id: "input", clientId: `handoff-task:${handoff.invocationId}`, content: [{ type: "text", text: "Find result" }] },
          { type: "agentMessage", id: "answer", text: "Recovered native result" },
        ] }
        callbacks.onMessage(JSON.stringify({ id: request.id, result: { data: request.params.cursor ? [turn] : [], nextCursor: request.params.cursor ? null : "next" } }))
      }, close: async () => {},
    }), "current-token")
    session.initialized = true
    const context = { botRegistry: registry, runtimeBroker: broker, capabilityGate: createCapabilityGate({ mode: "open" }) } as BotServerContext
    await Promise.all([recoverNativeInvocationResults(context), recoverNativeInvocationResults(context)])
    expect(requests).toBe(2)
    const recovered = registry.getInvocationForService(handoff.invocationId)
    if (recovered?.state !== "RUNNING") throw new Error(`RECOVERY_${recovered?.state}_${recovered?.decisionReason}`)
    completed = true
    await recoverNativeInvocationResults(context)
    expect(requests).toBe(4)
    expect(registry.getInvocationForService(handoff.invocationId)?.state).toBe("COMPLETED")
    expect(registry.getInvocationForService(handoff.invocationId)?.resultSummary).toBe("Recovered native result")
    expect(registry.continuations.pending()).toHaveLength(1)
    await recoverNativeInvocationResults(context)
    expect(requests).toBe(4)
  } finally { await broker.close(); registry.close() }
})

test("approved work survives reopen, waits for current authority, and dispatches only once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "approved-recovery-"))
  const path = join(dir, "registry.sqlite")
  let registry = new BotRegistry(path)
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const broker = new RuntimeBroker({ provision: async () => { throw new Error("not used") } })
  let turns = 0
  let release!: () => void
  let started!: () => void
  const didStart = new Promise<void>((resolve) => { started = resolve })
  try {
    const caller = registry.create(principal, { name: "Caller", description: "Original" })
    const target = registry.create(principal, { name: "Target", description: "Delegated" })
    const handoff = registry.createHandoffs(principal, { fromBotId: caller.id, toBotId: target.id, fact: "Recover approved" })[0]!
    registry.db.query("update bot_handoffs set state = 'PENDING_APPROVAL' where handoff_id = ?").run(handoff.handoffId)
    registry.close()
    registry = new BotRegistry(path)
    const context = {
      botRegistry: registry, runtimeBroker: broker, capabilityGate: createCapabilityGate({ mode: "open" }),
      modelDirectory: createBotModelDirectory({}), botToolSessions: new BotToolSessions(),
      createCodexRuntime: (_token, callbacks) => ({
        async send(line) {
          const request = JSON.parse(line)
          if (request.method === "initialize") callbacks.onMessage(JSON.stringify({ id: request.id, result: {} }))
          if (request.method === "model/list") callbacks.onMessage(JSON.stringify({ id: request.id, result: { data: [{ id: "astra-id", model: "gpt-6-astra", hidden: false, isDefault: true }], nextCursor: null } }))
          if (request.method === "thread/start") callbacks.onMessage(JSON.stringify({ id: request.id, result: { thread: { id: "target" } } }))
          if (request.method === "turn/start") {
            turns++
            callbacks.onMessage(JSON.stringify({ id: request.id, result: { turn: { id: "result" } } }))
            expect(request.params.clientUserMessageId).toBe(`handoff-task:${handoff.invocationId}`)
            release = () => callbacks.onMessage(JSON.stringify({ method: "turn/completed", params: { threadId: "target", turn: { id: "result", status: "completed", items: [] } } }))
            started()
          }
        },
        async close() {},
      }),
    } as BotServerContext
    await recoverApprovedInvocations(context)
    expect(turns).toBe(0)
    const session = await broker.start(principal, { onMessage() {}, onExit() {} }, undefined, "current-token")
    session.initialized = true
    const gate = context.capabilityGate
    context.capabilityGate = { ...gate, resolve: async () => { throw new Error("policy denied") } }
    await recoverApprovedInvocations(context)
    expect(registry.getInvocationForService(handoff.invocationId)?.state).toBe("APPROVED")
    expect(turns).toBe(0)
    context.capabilityGate = gate
    const dispatch = recoverApprovedInvocations(context)
    await didStart
    await recoverApprovedInvocations(context)
    expect(turns).toBe(1)
    release()
    await dispatch
    await recoverApprovedInvocations(context)
    expect(turns).toBe(1)
    expect(registry.getInvocationForService(handoff.invocationId)?.state).toBe("COMPLETED")
    expect(registry.continuations.pending()).toHaveLength(1)
    expect(registry.listHandoffEvents(principal, target.id).filter((event) => event.type === "handoff.delivered")).toHaveLength(1)
    const expired = registry.createHandoffs(principal, { fromBotId: caller.id, toBotId: target.id, fact: "Expired approval" })[0]!
    registry.db.query("update bot_invocations set expires_at = ? where request_id = ?").run(Date.now() - 1, expired.invocationId)
    await broker.stop(session.id)
    await recoverApprovedInvocations(context)
    expect(registry.getInvocationForService(expired.invocationId)?.state).toBe("EXPIRED")
    expect(registry.listHandoffEvents(principal, caller.id).filter((event) => event.handoffId === expired.handoffId && event.type === "handoff.failed")).toHaveLength(1)
    expect(turns).toBe(1)
  } finally { await broker.close(); registry.close(); rmSync(dir, { recursive: true, force: true }) }
})

test("cross-owner recovery supplies its exchanged target credential to the bound Gateway relay", async () => {
  const registry = new BotRegistry(":memory:")
  const broker = new RuntimeBroker({ provision: async () => { throw new Error("not used") } })
  const owner = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const caller = { ...owner, subject_id: "caller" }
  const originalFetch = globalThis.fetch
  const originalExchangeUrl = process.env.GENIO_ONE_AGENT_TOKEN_EXCHANGE_URL
  const originalExchangeToken = process.env.GENIO_ONE_AGENT_TOKEN_EXCHANGE_TOKEN
  const originalGateway = process.env.GENIO_ONE_MODEL_GATEWAY_BASE_URL
  process.env.GENIO_ONE_AGENT_TOKEN_EXCHANGE_URL = "https://identity.example/agent-exchange"
  process.env.GENIO_ONE_AGENT_TOKEN_EXCHANGE_TOKEN = "exchange-service-token"
  process.env.GENIO_ONE_MODEL_GATEWAY_BASE_URL = "https://gateway.example/v1"
  let runtimeSessionId = ""
  let runtimeCredential = ""
  let catalogCredential = ""
  let upstreamCredential = ""
  let started!: () => void
  const nativeStarted = new Promise<void>((resolve) => { started = resolve })
  const allow = (input: RuntimePolicyResolveInput) => ({
      tenant_id: input.principal.tenant_id,
      subject_id: input.principal.subject_id,
      client_id: input.principal.acting_client_id,
      bot_id: input.botId,
      runtime_id: input.runtimeId ?? "codex",
      policy_id: "test",
      policy_display_name: "test",
      policy_revision: 1,
      capability_id: input.capabilityId,
      action: input.action,
      target: `runtime:codex:${input.capabilityId}`,
      decision: "ALLOW" as const,
      reason_code: "TEST",
      constraints: [],
      obligations: [],
      correlation_id: input.correlationId ?? null,
      session_id: input.sessionId ?? null,
      evaluated_at: Date.now(),
    })
  const runtimePolicy: BotServerContext["runtimePolicy"] = {
    resolve: async (input) => allow(input),
    authorize: async (input) => allow(input),
    read: async () => { throw new Error("RUNTIME_POLICY_READ_UNUSED") },
    report: async () => undefined,
  }
  const context: BotServerContext = {
    botRegistry: registry,
    workspaces: new BotWorkspaceStore(registry.db, (botId, owner) => registry.getOwned(botId, owner)),
    handsPlacement: {} as HandsPlacementGate,
    botSchedules: new BotSchedules(registry.db),
    botDeletionReconciler: {} as BotDeletionReconciler,
    runtimeBroker: broker,
    capabilityGate: createCapabilityGate({ mode: "open" }),
    modelDirectory: {
      availableRoutes: () => ["genio-gateway" as const],
      supports: () => true,
      resolve: async (_principal: unknown, _botId: unknown, _route: unknown, accessToken?: string) => {
        catalogCredential = accessToken ?? ""
        return [{ publicModelId: "company-model", displayName: "Company Model", route: { kind: "genio-gateway" as const, modelProvider: "genio_one" } }]
      },
    },
    botToolSessions: new BotToolSessions(),
    runtimePolicy,
    createCodexRuntime: (token: string, callbacks: any, namespace?: { runtimeSessionId?: string }) => {
      runtimeCredential = token
      runtimeSessionId = namespace?.runtimeSessionId ?? ""
      return {
        async send(line: string) {
          const request = JSON.parse(line)
          if (request.method === "initialize") callbacks.onMessage(JSON.stringify({ id: request.id, result: {} }))
          if (request.method === "thread/start") callbacks.onMessage(JSON.stringify({ id: request.id, result: { thread: { id: "target-thread" } } }))
          if (request.method === "turn/start") {
            callbacks.onMessage(JSON.stringify({ id: request.id, result: { turn: { id: "target-turn" } } }))
            started()
          }
        },
        async close() { callbacks.onExit("closed") },
      }
    },
  }
  try {
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      if (url === process.env.GENIO_ONE_AGENT_TOKEN_EXCHANGE_URL) return Response.json({ access_token: "agent-token", expires_at: Date.now() + 60_000 })
      if (url.includes("/v1/identity/session")) return Response.json(caller)
      if (url === "https://gateway.example/v1/chat/completions") {
        upstreamCredential = new Headers(init?.headers).get("authorization") ?? ""
        return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\n", { status: 200 })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch
    const callerBot = registry.create(caller, { name: "Caller", description: "Origin" })
    const targetBot = registry.create(owner, { name: "Target", description: "Gateway target", modelRoute: "genio-gateway", ownerOrganizationId: "org-owner", useCaseId: "case-owner" })
    registry.update(targetBot.id, owner, { sharePolicy: { visibility: "ORG", discoverable: true, invocable: true, approval: "ALWAYS_ASK", audienceIds: [] } })
    const handoff = registry.createHandoffs(caller, { fromBotId: callerBot.id, toBotId: targetBot.id, fact: "Recover through the target credential" })[0]!
    registry.decideInvocation(owner, handoff.invocationId, "APPROVE")
    const callerSession = await broker.start(caller, { onMessage() {}, onExit() {} }, undefined, "caller-token")
    callerSession.initialized = true
    await recoverApprovedInvocations(context)
    await nativeStarted
    expect(registry.getInvocationForService(handoff.invocationId)?.state).toBe("RUNNING")
    const targetSession = broker.get(runtimeSessionId)
    if (!targetSession) throw new Error("TARGET_RUNTIME_NOT_FOUND")
    expect(targetSession.accessToken).toBeUndefined()
    expect(broker.accessTokenForBot(runtimeSessionId, targetBot.id)).toBe("agent-token")
    expect(runtimeCredential).toBe("agent-token")
    expect(catalogCredential).toBe("agent-token")
    targetSession.usageContext = { consumerOrganizationId: "org-owner", useCaseId: "case-owner" }
    let relayHandler: ((request: unknown, reply: { code(statusCode: number): unknown; header(name: string, value: string): unknown; send(body: unknown): unknown }) => Promise<unknown>) | null = null
    await modelGatewayRelayRoutes({
      post: (path: string, handler: typeof relayHandler) => { if (path.includes("/bots/")) relayHandler = handler },
      all() {},
    } as never, context)
    const reply = {
      statusCode: 200,
      body: undefined as unknown,
      code(statusCode: number) { this.statusCode = statusCode; return this },
      header() { return this },
      send(body: unknown) { this.body = body; return body },
    }
    await relayHandler!({
      params: { runtimeSessionId, botId: targetBot.id },
      headers: { authorization: `Bearer ${targetSession.relaySecret}` },
      body: { model: "company-model", input: "continue" },
    }, reply)
    for await (const _chunk of reply.body as AsyncIterable<unknown>) {}
    expect(reply.statusCode).toBe(200)
    expect(upstreamCredential).toBe("Bearer agent-token")
  } finally {
    await broker.close()
    registry.close()
    globalThis.fetch = originalFetch
    if (originalExchangeUrl === undefined) delete process.env.GENIO_ONE_AGENT_TOKEN_EXCHANGE_URL
    else process.env.GENIO_ONE_AGENT_TOKEN_EXCHANGE_URL = originalExchangeUrl
    if (originalExchangeToken === undefined) delete process.env.GENIO_ONE_AGENT_TOKEN_EXCHANGE_TOKEN
    else process.env.GENIO_ONE_AGENT_TOKEN_EXCHANGE_TOKEN = originalExchangeToken
    if (originalGateway === undefined) delete process.env.GENIO_ONE_MODEL_GATEWAY_BASE_URL
    else process.env.GENIO_ONE_MODEL_GATEWAY_BASE_URL = originalGateway
  }
})

test("reopened registry recovers a completed target result exactly once without running the task again", () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-recovery-"))
  const path = join(dir, "registry.sqlite")
  let registry = new BotRegistry(path)
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  try {
    const caller = registry.create(principal, { name: "Caller", description: "Original task" })
    const target = registry.create(principal, { name: "Target", description: "Delegated task" })
    const handoff = registry.createHandoffs(principal, { fromBotId: caller.id, toBotId: target.id, fact: "Review" })[0]!
    registry.beginInvocation(handoff.invocationId)
    const turn = { id: "turn", status: "completed", items: [
      { type: "userMessage", id: "input", clientId: `handoff-task:${handoff.invocationId}`, content: [{ type: "text", text: "Review" }] },
      { type: "agentMessage", id: "result", text: "Review complete" },
    ], startedAt: 1, completedAt: 2, error: null } as Turn
    registry.timeline.putTurn(caller.id, "wrong-bot", turn)
    reconcileTerminalInvocations(registry)
    expect(registry.getInvocationForService(handoff.invocationId)?.state).toBe("RUNNING")
    registry.timeline.putTurn(target.id, "target-thread", { ...turn, status: "inProgress" })
    reconcileTerminalInvocations(registry)
    expect(registry.getInvocationForService(handoff.invocationId)?.state).toBe("RUNNING")
    registry.timeline.putTurn(target.id, "target-thread", turn)
    registry.close()
    registry = new BotRegistry(path)
    reconcileTerminalInvocations(registry)
    reconcileTerminalInvocations(registry)
    expect(registry.getInvocationForService(handoff.invocationId)?.state).toBe("COMPLETED")
    expect(registry.getInvocationForService(handoff.invocationId)?.resultSummary).toBe("Review complete")
    expect(registry.continuations.pending()).toHaveLength(1)
    expect(registry.listHandoffEvents(principal, caller.id).filter((event) => event.type === "handoff.replied")).toHaveLength(1)
  } finally { registry.close(); rmSync(dir, { recursive: true, force: true }) }
})

test("completion and caller outbox commit atomically", () => {
  const registry = new BotRegistry(":memory:")
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  try {
    const caller = registry.create(principal, { name: "Caller", description: "Original" })
    const target = registry.create(principal, { name: "Target", description: "Delegated" })
    const handoff = registry.createHandoffs(principal, { fromBotId: caller.id, toBotId: target.id, fact: "Review" })[0]!
    registry.beginInvocation(handoff.invocationId)
    registry.db.exec("create trigger reject_outbox before insert on bot_continuations begin select raise(abort, 'storage failure'); end")
    expect(() => registry.completeInvocation(handoff.invocationId, "Done")).toThrow("storage failure")
    expect(registry.getInvocationForService(handoff.invocationId)?.state).toBe("RUNNING")
    expect(registry.listHandoffEvents(principal, caller.id).filter((event) => event.type === "handoff.replied")).toHaveLength(0)
    registry.db.exec("drop trigger reject_outbox")
    registry.completeInvocation(handoff.invocationId, "Done")
    expect(registry.continuations.pending()).toHaveLength(1)
  } finally { registry.close() }
})

test("one long handoff does not block another target or the next recovery scan", async () => {
  const registry = new BotRegistry(":memory:")
  const principal = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const broker = new RuntimeBroker({ provision: async () => { throw new Error("not used") } })
  const releases: Array<() => void> = []
  const finishByInvocation = new Map<string, () => void>()
  let started!: () => void
  const bothStarted = new Promise<void>((resolve) => { started = resolve })
  try {
    const caller = registry.create(principal, { name: "Caller", description: "Original" })
    const targets = ["A", "B"].map((name) => registry.create(principal, { name, description: "Target" }))
    const first = registry.createHandoffs(principal, { fromBotId: caller.id, toBotId: targets[0]!.id, fact: "Long work" })[0]!
    const session = await broker.start(principal, { onMessage() {}, onExit() {} }, undefined, "current-token")
    session.initialized = true
    const context = { botRegistry: registry, runtimeBroker: broker, capabilityGate: createCapabilityGate({ mode: "open" }), modelDirectory: createBotModelDirectory({}), botToolSessions: new BotToolSessions(),
      createCodexRuntime: (_token, callbacks) => {
        return {
          async send(line) {
            const request = JSON.parse(line)
            if (request.method === "initialize") callbacks.onMessage(JSON.stringify({ id: request.id, result: {} }))
            if (request.method === "model/list") callbacks.onMessage(JSON.stringify({ id: request.id, result: { data: [{ id: "astra-id", model: "gpt-6-astra", hidden: false, isDefault: true }], nextCursor: null } }))
            if (request.method === "thread/start") callbacks.onMessage(JSON.stringify({ id: request.id, result: { thread: { id: `thread-${crypto.randomUUID()}` } } }))
            if (request.method === "turn/start") {
              const thread = request.params.threadId
              callbacks.onMessage(JSON.stringify({ id: request.id, result: { turn: { id: thread } } }))
              releases.push(() => callbacks.onMessage(JSON.stringify({ method: "turn/completed", params: { threadId: thread, turn: { id: thread, status: "completed", items: [] } } })))
              finishByInvocation.set(request.params.clientUserMessageId, releases.at(-1)!)
              if (releases.length === 2) started()
            }
          },
          async close() { callbacks.onExit("closed") },
        }
      },
    } as BotServerContext
    await recoverApprovedInvocations(context)
    expect(registry.getInvocationForService(first.invocationId)?.state).toBe("RUNNING")
    const second = registry.createHandoffs(principal, { fromBotId: caller.id, toBotId: targets[1]!.id, fact: "Independent work" })[0]!
    await recoverApprovedInvocations(context)
    await bothStarted
    expect(registry.getInvocationForService(first.invocationId)?.state).toBe("RUNNING")
    expect(registry.getInvocationForService(second.invocationId)?.state).toBe("RUNNING")
    finishByInvocation.get(`handoff-task:${second.invocationId}`)!()
    expect(registry.getInvocationForService(second.invocationId)?.state).toBe("COMPLETED")
    expect(registry.getInvocationForService(first.invocationId)?.state).toBe("RUNNING")
    finishByInvocation.get(`handoff-task:${first.invocationId}`)!()
    expect(registry.getInvocationForService(first.invocationId)?.state).toBe("COMPLETED")
  } finally { for (const release of releases) release(); await broker.close(); registry.close() }
})

test("concurrent offline cross-owner handoffs keep each Bot's credential across model, Discovery, and default tools", async () => {
  const registry = new BotRegistry(":memory:")
  const broker = new RuntimeBroker({ provision: async () => { throw new Error("not used") } })
  const app = Fastify()
  const owner = { tenant_id: "tenant", subject_id: "owner", acting_client_id: "genio-one-bot", organization_ids: ["org-a", "org-b"], scopes: [] }
  const caller = { ...owner, subject_id: "caller" }
  const originalFetch = globalThis.fetch
  const originalExchangeUrl = process.env.GENIO_ONE_AGENT_TOKEN_EXCHANGE_URL
  const originalExchangeToken = process.env.GENIO_ONE_AGENT_TOKEN_EXCHANGE_TOKEN
  const originalGateway = process.env.GENIO_ONE_MODEL_GATEWAY_BASE_URL
  const originalPlatform = process.env.GENIO_ONE_PLATFORM_ORIGIN
  const exchangeTokens = new Map<string, string>()
  const catalogTokens = new Map<string, string>()
  const threadConfigs = new Map<string, Record<string, any>>()
  const finishByInvocation = new Map<string, () => void>()
  const policyTokens: string[] = []
  const modelUpstream: Array<{ authorization: string | null; organizationId: string | null; useCaseId: string | null }> = []
  const discoveryUpstream: Array<{ authorization: string | null; organizationId: string | null; useCaseId: string | null }> = []
  let bothStarted!: () => void
  const started = new Promise<void>((resolve) => { bothStarted = resolve })
  let startedTurns = 0
  process.env.GENIO_ONE_AGENT_TOKEN_EXCHANGE_URL = "https://identity.example/agent-exchange"
  process.env.GENIO_ONE_AGENT_TOKEN_EXCHANGE_TOKEN = "exchange-service-token"
  process.env.GENIO_ONE_MODEL_GATEWAY_BASE_URL = "https://gateway.example/v1"
  process.env.GENIO_ONE_PLATFORM_ORIGIN = "https://platform.example"
  const runtimePolicy: BotServerContext["runtimePolicy"] = {
    resolve: async (input) => ({
      tenant_id: input.principal.tenant_id,
      subject_id: input.principal.subject_id,
      client_id: input.principal.acting_client_id,
      bot_id: input.botId,
      runtime_id: input.runtimeId ?? "codex",
      policy_id: "test",
      policy_display_name: "test",
      policy_revision: 1,
      capability_id: input.capabilityId,
      action: input.action,
      target: `runtime:codex:${input.capabilityId}`,
      decision: "ALLOW",
      reason_code: "TEST",
      constraints: [],
      obligations: [],
      correlation_id: input.correlationId ?? null,
      session_id: input.sessionId ?? null,
      evaluated_at: Date.now(),
    }),
    authorize: async (input) => {
      policyTokens.push(input.accessToken ?? "")
      return {
        tenant_id: input.principal.tenant_id,
        subject_id: input.principal.subject_id,
        client_id: input.principal.acting_client_id,
        bot_id: input.botId,
        runtime_id: input.runtimeId ?? "codex",
        policy_id: "test",
        policy_display_name: "test",
        policy_revision: 1,
        capability_id: input.capabilityId,
        action: input.action,
        target: `runtime:codex:${input.capabilityId}`,
        decision: "ALLOW" as const,
        reason_code: "TEST",
        constraints: [],
        obligations: [],
        correlation_id: input.correlationId ?? null,
        session_id: input.sessionId ?? null,
        evaluated_at: Date.now(),
      }
    },
    read: async () => { throw new Error("RUNTIME_POLICY_READ_UNUSED") },
    report: async () => undefined,
  }
  const context: BotServerContext = {
    botRegistry: registry,
    workspaces: new BotWorkspaceStore(registry.db, (botId, owner) => registry.getOwned(botId, owner)),
    handsPlacement: {} as HandsPlacementGate,
    botSchedules: new BotSchedules(registry.db),
    botDeletionReconciler: {} as BotDeletionReconciler,
    runtimeBroker: broker,
    capabilityGate: createCapabilityGate({ mode: "open" }),
    modelDirectory: {
      availableRoutes: () => ["genio-gateway" as const],
      supports: () => true,
      resolve: async (_principal: unknown, botId: string, _route: unknown, accessToken?: string) => {
        catalogTokens.set(botId, accessToken ?? "")
        return [{ publicModelId: "company-model", displayName: "Company Model", route: { kind: "genio-gateway" as const, modelProvider: "genio_one" } }]
      },
    },
    botToolSessions: new BotToolSessions(),
    runtimePolicy,
    createCodexRuntime: (_token, callbacks) => ({
      async send(line: string) {
        const request = JSON.parse(line)
        if (request.method === "initialize") callbacks.onMessage(JSON.stringify({ id: request.id, result: {} }))
        if (request.method === "model/list") callbacks.onMessage(JSON.stringify({ id: request.id, result: { data: [{ id: "company-model", model: "company-model", hidden: false, isDefault: true }], nextCursor: null } }))
        if (request.method === "thread/start") {
          const discovery = request.params.config["mcp_servers.genio_discovery"]
          const botId = decodeURIComponent(String(discovery.url).split("/").at(-2) ?? "")
          threadConfigs.set(botId, request.params.config)
          callbacks.onMessage(JSON.stringify({ id: request.id, result: { thread: { id: `thread-${botId}` } } }))
        }
        if (request.method === "turn/start") {
          const threadId = request.params.threadId as string
          callbacks.onMessage(JSON.stringify({ id: request.id, result: { turn: { id: `turn-${threadId}` } } }))
          finishByInvocation.set(request.params.clientUserMessageId, () => callbacks.onMessage(JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: `turn-${threadId}`, status: "completed", items: [] } } })))
          startedTurns++
          if (startedTurns === 2) bothStarted()
        }
      },
      async close() { callbacks.onExit("closed") },
    }),
  }
  try {
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      if (url === process.env.GENIO_ONE_AGENT_TOKEN_EXCHANGE_URL) {
        const invocationId = (JSON.parse(String(init?.body)) as { invocation_id: string }).invocation_id
        const token = `agent-${invocationId}`
        exchangeTokens.set(invocationId, token)
        return Response.json({ access_token: token, expires_at: Date.now() + 60_000 })
      }
      if (url.includes("/v1/identity/session")) return Response.json(caller)
      if (url === "https://platform.example/v1/tenants/tenant/organizations/org-a/use-cases") {
        return Response.json([{ tenant_id: "tenant", organization_id: "org-a", use_case_id: "case-a", display_name: "A", state: "ACTIVE" }])
      }
      if (url === "https://platform.example/v1/tenants/tenant/organizations/org-b/use-cases") {
        return Response.json([{ tenant_id: "tenant", organization_id: "org-b", use_case_id: "case-b", display_name: "B", state: "ACTIVE" }])
      }
      if (url === "https://gateway.example/v1/chat/completions") {
        modelUpstream.push({ authorization: headers.get("authorization"), organizationId: headers.get("x-genio-organization-id"), useCaseId: headers.get("x-genio-use-case-id") })
        return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\n", { status: 200 })
      }
      if (url === "https://platform.example/v1/tenants/tenant/discovery/mcp") {
        discoveryUpstream.push({ authorization: headers.get("authorization"), organizationId: headers.get("x-genio-organization-id"), useCaseId: headers.get("x-genio-use-case-id") })
        return Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch
    const callerBot = registry.create(caller, { name: "Caller", description: "Origin" })
    const targetA = registry.create(owner, { name: "Target A", description: "Gateway A", modelRoute: "genio-gateway", ownerOrganizationId: "org-a", useCaseId: "case-a" })
    const targetB = registry.create(owner, { name: "Target B", description: "Gateway B", modelRoute: "genio-gateway", ownerOrganizationId: "org-b", useCaseId: "case-b" })
    for (const target of [targetA, targetB]) registry.update(target.id, owner, { sharePolicy: { visibility: "ORG", discoverable: true, invocable: true, approval: "ALWAYS_ASK", audienceIds: [] } })
    const handoffA = registry.createHandoffs(caller, { fromBotId: callerBot.id, toBotId: targetA.id, fact: "Run A" })[0]!
    const handoffB = registry.createHandoffs(caller, { fromBotId: callerBot.id, toBotId: targetB.id, fact: "Run B" })[0]!
    registry.decideInvocation(owner, handoffA.invocationId, "APPROVE")
    registry.decideInvocation(owner, handoffB.invocationId, "APPROVE")
    const ownerSession = await broker.start(owner, { onMessage() {}, onExit() {} })
    ownerSession.initialized = true
    const tasks = [
      runApprovedBotInvocation(context, handoffA.invocationId, "caller-token"),
      runApprovedBotInvocation(context, handoffB.invocationId, "caller-token"),
    ]
    await started
    expect(ownerSession.accessToken).toBeUndefined()
    expect(broker.accessTokenForBot(ownerSession.id, targetA.id)).toBe(exchangeTokens.get(handoffA.invocationId))
    expect(broker.accessTokenForBot(ownerSession.id, targetB.id)).toBe(exchangeTokens.get(handoffB.invocationId))
    expect(catalogTokens).toEqual(new Map([
      [targetA.id, exchangeTokens.get(handoffA.invocationId)!],
      [targetB.id, exchangeTokens.get(handoffB.invocationId)!],
    ]))
    for (const target of [targetA, targetB]) {
      const config = threadConfigs.get(target.id)
      const toolAuthorization = config?.["mcp_servers.genio_bot"]?.http_headers?.Authorization
      expect(context.botToolSessions.resolve(toolAuthorization)?.accessToken).toBe(exchangeTokens.get(target.id === targetA.id ? handoffA.invocationId : handoffB.invocationId))
      expect(config?.["mcp_servers.genio_discovery"]?.url).toContain(`/bots/${encodeURIComponent(target.id)}/mcp`)
    }
    await modelGatewayRelayRoutes(app, context)
    const relayHeaders = { authorization: `Bearer ${ownerSession.relaySecret}` }
    const [modelA, modelB, discoveryA, discoveryB] = await Promise.all([
      app.inject({ method: "POST", url: `/api/model-gateway/${ownerSession.id}/bots/${targetA.id}/v1/responses`, headers: relayHeaders, payload: { model: "company-model", input: "A" } }),
      app.inject({ method: "POST", url: `/api/model-gateway/${ownerSession.id}/bots/${targetB.id}/v1/responses`, headers: relayHeaders, payload: { model: "company-model", input: "B" } }),
      app.inject({ method: "POST", url: `/api/discovery-mcp/${ownerSession.id}/bots/${targetA.id}/mcp`, headers: relayHeaders, payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } }),
      app.inject({ method: "POST", url: `/api/discovery-mcp/${ownerSession.id}/bots/${targetB.id}/mcp`, headers: relayHeaders, payload: { jsonrpc: "2.0", id: 2, method: "tools/list" } }),
    ])
    for (const response of [modelA, modelB, discoveryA, discoveryB]) expect(response.statusCode).toBe(200)
    expect(modelUpstream).toEqual(expect.arrayContaining([
      { authorization: `Bearer ${exchangeTokens.get(handoffA.invocationId)}`, organizationId: "org-a", useCaseId: "case-a" },
      { authorization: `Bearer ${exchangeTokens.get(handoffB.invocationId)}`, organizationId: "org-b", useCaseId: "case-b" },
    ]))
    expect(discoveryUpstream).toEqual(expect.arrayContaining([
      { authorization: `Bearer ${exchangeTokens.get(handoffA.invocationId)}`, organizationId: null, useCaseId: null },
      { authorization: `Bearer ${exchangeTokens.get(handoffB.invocationId)}`, organizationId: null, useCaseId: null },
    ]))
    expect(policyTokens).toEqual(expect.arrayContaining([
      exchangeTokens.get(handoffA.invocationId)!,
      exchangeTokens.get(handoffB.invocationId)!,
    ]))
    finishByInvocation.get(`handoff-task:${handoffA.invocationId}`)!()
    finishByInvocation.get(`handoff-task:${handoffB.invocationId}`)!()
    await Promise.all(tasks)
    expect(broker.accessTokenForBot(ownerSession.id, targetA.id)).toBeUndefined()
    expect(broker.accessTokenForBot(ownerSession.id, targetB.id)).toBeUndefined()
  } finally {
    await app.close()
    await broker.close()
    registry.close()
    globalThis.fetch = originalFetch
    if (originalExchangeUrl === undefined) delete process.env.GENIO_ONE_AGENT_TOKEN_EXCHANGE_URL
    else process.env.GENIO_ONE_AGENT_TOKEN_EXCHANGE_URL = originalExchangeUrl
    if (originalExchangeToken === undefined) delete process.env.GENIO_ONE_AGENT_TOKEN_EXCHANGE_TOKEN
    else process.env.GENIO_ONE_AGENT_TOKEN_EXCHANGE_TOKEN = originalExchangeToken
    if (originalGateway === undefined) delete process.env.GENIO_ONE_MODEL_GATEWAY_BASE_URL
    else process.env.GENIO_ONE_MODEL_GATEWAY_BASE_URL = originalGateway
    if (originalPlatform === undefined) delete process.env.GENIO_ONE_PLATFORM_ORIGIN
    else process.env.GENIO_ONE_PLATFORM_ORIGIN = originalPlatform
  }
})
