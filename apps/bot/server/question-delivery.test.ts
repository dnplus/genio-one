import { expect, test } from "bun:test"
import { BotRegistry } from "./bot-registry"
import { createCapabilityGate } from "./capability-gate"
import { BotToolSessions } from "./bot-tool-sessions"
import { RuntimeBroker } from "./runtime-broker"
import { deliverQuestionAnswers } from "./question-delivery"
import type { BotServerContext } from "./context"

function setup() {
  const registry = new BotRegistry(":memory:")
  const principal = { tenant_id: "question-test", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }
  const bot = registry.create(principal, { name: "Questions" })
  registry.saveSession({ botId: bot.id, appServerThreadId: "thread" })
  const requests: Array<{ method: string; params: any }> = []
  let response: (method: string, params: any) => Promise<any> = async (method) => method === "thread/read" ? { thread: { status: { type: "idle" } } } : method === "thread/turns/list" ? { data: [], nextCursor: null } : { turn: { id: "delivered-turn", status: "inProgress", items: [] } }
  const gate = new RuntimeBroker({ provision: async () => { throw new Error("UNUSED") } })
  const session = { id: "session", principal, initialized: true, accessToken: "test", details: { cwd: "/tmp" }, runtimeDetails: {} }
  const context = {
    botRegistry: registry,
    capabilityGate: createCapabilityGate({ mode: "open" }),
    botToolSessions: new BotToolSessions(),
    runtimeBroker: {
      claimBotTurn: (id: string) => gate.claimBotTurn(id),
      findByPrincipal: () => session,
      request: async (_id: string, method: string, params: any) => { requests.push({ method, params }); return response(method, params) },
    },
    modelDirectory: { resolve: async () => [] },
    runtimePolicy: {
      authorize: async () => ({ decision: "ALLOW", constraints: [], obligations: [], correlation_id: "question-test", capability_id: "codex.subscription", action: "use" }),
      report: async () => {},
      read: async () => ({ decisions: [] }),
    },
  } as unknown as BotServerContext
  const observe = (id: string, status: "inProgress" | "completed") => registry.recordRuntimeEvent(principal, JSON.stringify({ method: status === "inProgress" ? "turn/started" : "turn/completed", params: { threadId: "thread", turn: { id, status, items: [] } } }))
  observe("source", "inProgress")
  const question = registry.questions.create(bot.id, "thread", "source", [{ title: "哪個版本？" }])[0]!
  registry.questions.answer(bot.id, question.id, 1, "answer", "A")
  return { registry, bot, requests, context, question, observe, respond: (handler: typeof response) => { response = handler } }
}

test("answer steers only its original active turn", async () => {
  const value = setup()
  try {
    await deliverQuestionAnswers(value.context)
    const steer = value.requests.find((request) => request.method === "turn/steer")
    expect(steer?.params.expectedTurnId).toBe("source")
    expect(value.requests.some((request) => request.method === "turn/start")).toBe(false)
    expect(value.registry.questions.get(value.bot.id, value.question.id).delivery).toBe("delivered")
  } finally { value.registry.close() }
})

test("late answer waits for new work, then starts once on current segment", async () => {
  const value = setup()
  try {
    value.observe("source", "completed")
    value.observe("new-work", "inProgress")
    await deliverQuestionAnswers(value.context)
    expect(value.requests).toHaveLength(0)
    expect(value.registry.questions.get(value.bot.id, value.question.id).delivery).toBe("queued")
    value.observe("new-work", "completed")
    await deliverQuestionAnswers(value.context)
    await deliverQuestionAnswers(value.context)
    expect(value.requests.filter((request) => request.method === "turn/start")).toHaveLength(1)
    expect(value.requests.some((request) => request.method === "turn/steer")).toBe(false)
  } finally { value.registry.close() }
})

test("uncertain transport is not resent after recovery scans", async () => {
  const value = setup()
  try {
    value.respond(async (method) => {
      if (method === "turn/steer") throw new Error("BOT_RUNTIME_REQUEST_TIMEOUT")
      return { data: [], nextCursor: null }
    })
    await deliverQuestionAnswers(value.context)
    await deliverQuestionAnswers(value.context)
    expect(value.requests.filter((request) => request.method === "turn/steer")).toHaveLength(1)
    expect(value.registry.questions.get(value.bot.id, value.question.id).delivery).toBe("uncertain")
  } finally { value.registry.close() }
})
