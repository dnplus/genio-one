import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotRegistry } from "./bot-registry"
import { createCapabilityGate } from "./capability-gate"
import { BotToolSessions } from "./bot-tool-sessions"
import { RuntimeBroker } from "./runtime-broker"
import { deliverQuestionAnswers, replayDeliveredQuestionReports } from "./question-delivery"
import type { BotServerContext } from "./context"

function setup(databasePath = ":memory:", artifactStoreRoot = join(tmpdir(), "question-delivery-artifacts")) {
  const registry = new BotRegistry(databasePath, artifactStoreRoot)
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
      accessTokenForBot: (runtimeId: string, botId: string) => runtimeId === session.id && botId === bot.id ? session.accessToken : undefined,
      request: async (_id: string, method: string, params: any) => { requests.push({ method, params }); return response(method, params) },
    },
    modelDirectory: { resolve: async () => [] },
    runtimePolicy: {
      authorize: async () => ({ decision: "ALLOW", constraints: [], obligations: [], correlation_id: "question-test", capability_id: "codex.subscription", action: "use", runtime_id: "codex", target: "runtime:codex:codex.subscription" }),
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
    const reports: any[] = []
    value.context.runtimePolicy.report = async (input) => { reports.push(input) }
    value.respond(async (method) => {
      if (method === "turn/steer") throw new Error("BOT_RUNTIME_REQUEST_TIMEOUT")
      return { data: [], nextCursor: null }
    })
    await deliverQuestionAnswers(value.context)
    await deliverQuestionAnswers(value.context)
    expect(value.requests.filter((request) => request.method === "turn/steer")).toHaveLength(1)
    expect(value.registry.questions.get(value.bot.id, value.question.id).delivery).toBe("uncertain")
    await replayDeliveredQuestionReports(value.context)
    expect(reports).toHaveLength(0)
  } finally { value.registry.close() }
})

test("delivered answer replays only its report after restart without a session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "question-report-"))
  const path = join(directory, "questions.sqlite")
  const value = setup(path, directory)
  try {
    value.context.runtimePolicy.report = async () => { throw new Error("HTTP_503") }
    let savedBeforeDispatch = false
    value.respond(async (method) => {
      if (method === "turn/steer") {
        const row = value.registry.db.query("select authorization_json from bot_question_report_authorizations where bot_id = ? and question_id = ?").get(value.bot.id, value.question.id) as { authorization_json: string } | null
        savedBeforeDispatch = JSON.parse(row?.authorization_json ?? "null")?.correlationId === "question-test"
        return { turn: { id: "delivered-turn", status: "inProgress", items: [] } }
      }
      return { data: [], nextCursor: null }
    })
    await deliverQuestionAnswers(value.context)
    expect(savedBeforeDispatch).toBe(true)
    expect(value.requests.filter((request) => request.method === "turn/steer")).toHaveLength(1)
    expect(value.registry.questions.get(value.bot.id, value.question.id).delivery).toBe("delivered")
    expect(value.registry.questions.confirmedReports()).toHaveLength(1)
  } finally { value.registry.close() }

  const restored = new BotRegistry(path, directory)
  try {
    const reports: any[] = []
    const context = { botRegistry: restored, runtimePolicy: { report: async (input: any) => { reports.push(input) } }, runtimeBroker: { request: () => { throw new Error("ANSWER_REPLAYED") } } } as unknown as BotServerContext
    await replayDeliveredQuestionReports(context)
    await replayDeliveredQuestionReports(context)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ botId: value.bot.id, correlationId: "question-test", outcome: "ALLOW" })
    expect(reports[0]?.accessToken).toBeUndefined()
    expect(restored.questions.confirmedReports()).toHaveLength(0)
    expect(restored.questions.get(value.bot.id, value.question.id).delivery).toBe("delivered")
  } finally {
    restored.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
