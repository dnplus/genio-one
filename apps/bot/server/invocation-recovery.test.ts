import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotRegistry } from "./bot-registry"
import { reconcileTerminalInvocations, recoverApprovedInvocations, recoverNativeInvocationResults } from "./invocation-recovery"
import type { Turn } from "./generated/v2/Turn"
import { RuntimeBroker } from "./runtime-broker"
import { createCapabilityGate } from "./capability-gate"
import { createBotModelDirectory } from "./model-directory"
import { BotToolSessions } from "./bot-tool-sessions"
import type { BotServerContext } from "./context"

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
    expect(registry.getInvocationForService(handoff.invocationId)?.state).toBe("RUNNING")
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
