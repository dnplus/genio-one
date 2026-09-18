import { expect, test } from "bun:test"
import Fastify from "fastify"
import { BotRegistry } from "../bot-registry"
import { botQuestionRoutes } from "./bot-questions"
import type { BotServerContext } from "../context"

const owner = { tenant_id: "questions-http", subject_id: "owner", acting_client_id: "genio-one-bot", scopes: [] }

test("question HTTP enforces ownership and concurrent answers save one revision", async () => {
  const registry = new BotRegistry(":memory:")
  const app = Fastify()
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_url, init) => {
    const auth = new Headers(init?.headers).get("authorization")
    return Response.json({ ...owner, subject_id: auth === "Bearer owner" ? "owner" : "stranger" })
  }) as typeof fetch
  try {
    const bot = registry.create(owner, { name: "Questions" })
    const question = registry.questions.create(bot.id, "source-thread", "source-turn", [{ title: "哪個？" }])[0]!
    await botQuestionRoutes(app, { botRegistry: registry } as BotServerContext)
    const url = `/api/bots/${bot.id}/questions/${question.id}/answer`
    const unauthorized = await app.inject({ method: "POST", url, headers: { authorization: "Bearer stranger" }, payload: { questionRevision: 1, clientAnswerId: "foreign", answer: "X" } })
    expect(unauthorized.statusCode).toBe(404)
    const answers = await Promise.all(["A", "B"].map((answer) => app.inject({ method: "POST", url, headers: { authorization: "Bearer owner" }, payload: { questionRevision: 1, clientAnswerId: answer, answer } })))
    expect(answers.map((response) => response.statusCode).sort()).toEqual([200, 409])
    const stored = registry.questions.get(bot.id, question.id)
    expect(stored.revision).toBe(2)
    expect(registry.questions.pending()).toHaveLength(1)
    const repeated = await app.inject({ method: "POST", url, headers: { authorization: "Bearer owner" }, payload: { questionRevision: 1, clientAnswerId: stored.clientAnswerId, answer: stored.answer } })
    expect(repeated.statusCode).toBe(200)
  } finally { globalThis.fetch = originalFetch; await app.close(); registry.close() }
})

test("native async items share durable question projection while approvals remain separate", () => {
  const registry = new BotRegistry(":memory:")
  try {
    const bot = registry.create(owner, { name: "Native questions" })
    registry.saveSession({ botId: bot.id, appServerThreadId: "native-thread" })
    const item = { id: "native-item", type: "agentMessage", text: "請選擇", phase: "commentary", delivery: "async", questions: [{ title: "自由回答？", options: null }] }
    registry.recordRuntimeEvent(owner, JSON.stringify({ method: "item/completed", params: { threadId: "native-thread", turnId: "native-turn", item } }))
    registry.importRuntimeHistory(bot.id, "native-thread", [{ id: "native-turn", status: "completed", items: [item] }] as any, registry.timeline.revision())
    expect(registry.questions.list(bot.id)).toHaveLength(1)
    expect(registry.readTimeline(owner, bot.id).filter((message) => message.question)).toHaveLength(1)
    registry.recordRuntimeEvent(owner, JSON.stringify({ method: "item/autoApprovalReview/completed", params: { threadId: "native-thread", turnId: "native-turn", review: { status: "approved" } } }))
    expect(registry.questions.list(bot.id)[0]?.state).toBe("pending")
  } finally { registry.close() }
})
