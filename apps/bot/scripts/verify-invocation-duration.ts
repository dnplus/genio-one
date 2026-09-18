import assert from "node:assert/strict"
import { BotRegistry } from "../server/bot-registry"
import { RuntimeBroker } from "../server/runtime-broker"
import { BotToolSessions } from "../server/bot-tool-sessions"
import { createBotModelDirectory } from "../server/model-directory"
import { runApprovedBotInvocation } from "../server/routes/invocations"
import type { BotServerContext } from "../server/context"

const registry = new BotRegistry(":memory:")
const principal = { tenant_id: "duration-test", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
const caller = registry.create(principal, { name: "Caller", description: "Duration check" })
const target = registry.create(principal, { name: "Target", description: "Duration check" })
const invocation = registry.createHandoffs(principal, { fromBotId: caller.id, toBotId: target.id, fact: "Controlled duration check" })[0]!
const broker = new RuntimeBroker({ provision: async () => { throw new Error("not used") } })
let accepted!: () => void
let finish: (() => void) | undefined
const started = new Promise<void>((resolve) => { accepted = resolve })
let closes = 0
const context = { botRegistry: registry, runtimeBroker: broker, botToolSessions: new BotToolSessions(), modelDirectory: createBotModelDirectory({}),
  createCodexRuntime: (_token, callbacks) => ({
    async send(line) {
      const request = JSON.parse(line)
      if (request.method === "initialize") callbacks.onMessage(JSON.stringify({ id: request.id, result: {} }))
      if (request.method === "thread/start") callbacks.onMessage(JSON.stringify({ id: request.id, result: { thread: { id: "duration-thread" } } }))
      if (request.method === "turn/start") {
        callbacks.onMessage(JSON.stringify({ id: request.id, result: { turn: { id: "duration-turn" } } }))
        finish = () => callbacks.onMessage(JSON.stringify({ method: "turn/completed", params: { threadId: "duration-thread", turn: { id: "duration-turn", status: "completed", items: [{ id: "answer", type: "agentMessage", text: "Duration check complete" }] } } }))
        accepted()
      }
    },
    async close() { closes++ },
  }),
} as BotServerContext

const task = runApprovedBotInvocation(context, invocation.invocationId, "duration-test-token")
try {
  await started
  const began = performance.now()
  console.info(JSON.stringify({ event: "duration-check.accepted", wait_ms: 121_000 }))
  await new Promise((resolve) => setTimeout(resolve, 121_000))
  assert.equal(registry.getInvocationForService(invocation.invocationId)?.state, "RUNNING")
  assert.equal(closes, 0)
  finish!()
  await task
  assert.equal(registry.getInvocationForService(invocation.invocationId)?.state, "COMPLETED")
  assert.equal(registry.continuations.pending().length, 1)
  assert.equal(closes, 0)
  console.info(JSON.stringify({ event: "duration-check.passed", elapsed_ms: Math.round(performance.now() - began), invocations: 1, continuations: 1 }))
} finally {
  finish?.()
  await task.catch(() => {})
  await broker.close()
  assert.equal(closes, 1)
  registry.close()
}
