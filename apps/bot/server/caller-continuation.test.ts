import { expect, test } from "bun:test"
import { BotRegistry } from "./bot-registry"
import { RuntimeBroker } from "./runtime-broker"
import { createCapabilityGate } from "./capability-gate"
import { continueCallers } from "./caller-continuation"
import type { BotServerContext } from "./context"
import { BotToolSessions } from "./bot-tool-sessions"

test.each(["COMPLETED", "FAILED"] as const)("handoff %s waits for caller idle and starts exactly one continuation with system provenance", async (outcome) => {
  const principal = { tenant_id: "tenant-test", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const registry = new BotRegistry(":memory:")
  const caller = registry.create(principal, { name: "Caller", description: "Continue existing work" })
  const target = registry.create(principal, { name: "Target", description: "Return a result" })
  registry.rememberThread(caller.id, "caller-thread")
  registry.saveSession({ botId: caller.id, appServerThreadId: "caller-thread" })
  const handoff = registry.createHandoffs(principal, { fromBotId: caller.id, toBotId: target.id, fact: "Review input" })[0]!
  registry.beginInvocation(handoff.invocationId)
  if (outcome === "COMPLETED") registry.completeInvocation(handoff.invocationId, "Reviewed result")
  else registry.failInvocation(handoff.invocationId, "TARGET_INTERRUPTED", "Reviewed result")
  registry.completeInvocation(handoff.invocationId, "Duplicate terminal report")
  expect(registry.continuations.pending()).toHaveLength(1)
  let busy = true
  let turns = 0
  const broker = new RuntimeBroker({ provision: async () => { throw new Error("not needed") } })
  broker.observe((owner, line) => registry.recordRuntimeEvent(owner, line))
  const session = await broker.start(principal, { onMessage() {}, onExit() {} }, (callbacks) => ({
    async send(line) {
      const request = JSON.parse(line)
      if (request.method === "thread/read") callbacks.onMessage(JSON.stringify({ id: request.id, result: { thread: { id: "caller-thread", status: { type: busy ? "active" : "idle" } } } }))
      if (request.method === "thread/resume") callbacks.onMessage(JSON.stringify({ id: request.id, result: { thread: { id: "caller-thread" } } }))
      if (request.method === "turn/start") {
        turns++
        expect(request.params.threadId).toBe("caller-thread")
        expect(request.params.input[0].text).toContain("Reviewed result")
        expect(request.params.input[0].text).toContain(`terminal outcome ${outcome}`)
        if (outcome === "FAILED") expect(request.params.input[0].text).toContain("Do not claim successful effects, bypass a denial, or automatically retry/redelegate")
        callbacks.onMessage(JSON.stringify({ method: "item/completed", params: { threadId: "caller-thread", turnId: "continuation-turn", item: { id: "input", type: "userMessage", clientId: request.params.clientUserMessageId, content: request.params.input } } }))
        callbacks.onMessage(JSON.stringify({ method: "turn/completed", params: { threadId: "caller-thread", turn: { id: "continuation-turn", status: "completed", items: [] } } }))
        callbacks.onMessage(JSON.stringify({ id: request.id, result: { turn: { id: "continuation-turn" } } }))
      }
    },
    async close() {},
  }), "test-token")
  session.initialized = true
  const context = { botRegistry: registry, runtimeBroker: broker, capabilityGate: createCapabilityGate({ mode: "open" }), botToolSessions: new BotToolSessions() } as BotServerContext
  try {
    await continueCallers(context)
    expect(turns).toBe(0)
    busy = false
    await continueCallers(context)
    await continueCallers(context)
    expect(turns).toBe(1)
    expect(registry.continuations.pending()).toHaveLength(0)
    expect(registry.readTimeline(principal, caller.id).some((message) => message.text === "收到隊友結果，接續處理" && message.role === "system")).toBe(true)
    expect(registry.readTimeline(principal, caller.id).some((message) => message.role === "user")).toBe(false)
  } finally { await broker.stop(session.id); registry.close() }
})
