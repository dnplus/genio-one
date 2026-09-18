import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BotQuestions } from "./bot-questions"

test("question retry, two-tab answers, revision conflicts and dismissal preserve one delivery", () => {
  const db = new Database(":memory:")
  try {
    const store = new BotQuestions(db)
    const input = [{ title: "管理員？", options: ["甲", "乙"] }, { title: "語言？" }]
    const questions = store.create("bot", "thread", "turn", input)
    expect(store.create("bot", "thread", "turn", input)).toEqual(questions)
    expect(store.list("bot")).toHaveLength(2)
    const first = store.answer("bot", questions[0]!.id, 1, "answer-1", "乙")
    expect(first.delivery).toBe("queued")
    expect(store.answer("bot", questions[0]!.id, 1, "answer-1", "乙")).toEqual(first)
    expect(() => store.answer("bot", questions[0]!.id, 1, "answer-2", "甲")).toThrow("BOT_QUESTION_CONFLICT")
    expect(() => store.answer("other", questions[0]!.id, 1, "answer-1", "乙")).toThrow("BOT_QUESTION_NOT_FOUND")
    expect(store.dismiss("bot", questions[1]!.id, 1).state).toBe("dismissed")
    expect(store.pending()).toHaveLength(1)
    const reopened = new BotQuestions(db)
    expect(reopened.pending()[0]).toEqual(first)
    expect(() => reopened.create("bot", "thread", "turn", [{ title: "" }])).toThrow("BOT_QUESTIONS_INVALID")
  } finally { db.close() }
})

test("uncertain answers reconcile by exact client ID and cannot overwrite delivery", () => {
  const db = new Database(":memory:")
  try {
    const store = new BotQuestions(db)
    const question = store.create("bot", "thread", "turn", [{ title: "下一步？" }])[0]!
    store.answer("bot", question.id, 1, "reply", "A")
    store.mark("bot", question.id, "uncertain", { deliveryThreadId: "new-thread" })
    store.reconcile("bot", "new-thread", [{ id: "new-turn", items: [{ type: "userMessage", clientId: `question-answer:${question.id}:reply`, id: "answer-item", content: [] }] } as any])
    expect(store.get("bot", question.id).delivery).toBe("delivered")
    expect(store.mark("bot", question.id, "queued").delivery).toBe("delivered")
    expect(store.pending()).toHaveLength(0)
  } finally { db.close() }
})

test("explicit replacement supersedes only pending questions in the same Bot", () => {
  const db = new Database(":memory:")
  try {
    const store = new BotQuestions(db)
    const original = store.create("bot", "thread", "turn", [{ title: "舊問題" }])[0]!
    const replacement = store.create("bot", "thread", "turn", [{ title: "修正問題" }], undefined, [original.id])[0]!
    expect(store.get("bot", original.id).state).toBe("superseded")
    expect(() => store.answer("bot", original.id, 1, "late", "A")).toThrow("BOT_QUESTION_CONFLICT")
    expect(replacement.state).toBe("pending")
    expect(() => store.create("other", "thread", "turn", [{ title: "偷換" }], undefined, [replacement.id])).toThrow("BOT_QUESTION_NOT_FOUND")
    expect(store.list("other")).toHaveLength(0)
  } finally { db.close() }
})
