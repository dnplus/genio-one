import { createHash } from "node:crypto"
import type { Database } from "bun:sqlite"
import type { BotQuestion } from "../shared/bot-question"
import type { Turn } from "./generated/v2/Turn"

export class BotQuestions {
  constructor(private readonly db: Database) {
    db.exec(`create table if not exists bot_questions (
      bot_id text not null, question_id text not null, body_json text not null,
      primary key (bot_id, question_id)
    )`)
  }

  list(botId: string): BotQuestion[] {
    return (this.db.query("select body_json from bot_questions where bot_id = ? order by rowid").all(botId) as Array<{ body_json: string }>).map((row) => JSON.parse(row.body_json))
  }

  get(botId: string, id: string): BotQuestion {
    const row = this.db.query("select body_json from bot_questions where bot_id = ? and question_id = ?").get(botId, id) as { body_json: string } | null
    if (!row) throw new Error("BOT_QUESTION_NOT_FOUND")
    return JSON.parse(row.body_json)
  }

  private save(question: BotQuestion) {
    this.db.query("update bot_questions set body_json = ? where bot_id = ? and question_id = ?").run(JSON.stringify(question), question.botId, question.id)
    return question
  }

  create(botId: string, sourceThreadId: string, sourceTurnId: string, input: unknown, sourceItemId?: string, replaceQuestionIds: string[] = []): BotQuestion[] {
    if (!Array.isArray(input) || input.length < 1 || input.length > 3) throw new Error("BOT_QUESTIONS_INVALID: pass questions as [{title: string, options: string[]}]; options are plain strings, not objects")
    if (!Array.isArray(replaceQuestionIds) || replaceQuestionIds.length > 3 || replaceQuestionIds.some((id) => typeof id !== "string")) throw new Error("BOT_QUESTIONS_INVALID")
    const questions = input.map((entry) => {
      if (!entry || typeof entry.title !== "string" || !entry.title.trim() || entry.title.length > 1000 || (entry.options != null && (!Array.isArray(entry.options) || entry.options.length > 6 || entry.options.some((value: unknown) => typeof value !== "string" || !value.trim() || value.length > 300)))) throw new Error("BOT_QUESTIONS_INVALID: pass questions as [{title: string, options: string[]}]; options are plain strings, not objects")
      return { title: entry.title.trim(), options: entry.options ?? [] }
    })
    const source = sourceItemId ?? createHash("sha256").update(JSON.stringify(questions)).digest("hex")
    return this.db.transaction(() => {
      const replaced = replaceQuestionIds.map((id) => this.get(botId, id))
      if (replaced.some((question) => question.state !== "pending" && question.state !== "superseded")) throw new Error("BOT_QUESTION_CONFLICT")
      const created = questions.map((question, index) => {
      const id = createHash("sha256").update(JSON.stringify([botId, sourceThreadId, sourceTurnId, source, index])).digest("hex")
      const record: BotQuestion = { id, botId, sourceThreadId, sourceTurnId, sourceItemId, ...question, revision: 1, state: "pending", createdAt: Date.now(), delivery: "none" }
      this.db.query("insert or ignore into bot_questions values (?, ?, ?)").run(botId, id, JSON.stringify(record))
      return this.get(botId, id)
      })
      for (const question of replaced) {
        if (created.some((value) => value.id === question.id)) throw new Error("BOT_QUESTION_REPLACEMENT_INVALID")
        if (question.state === "pending") this.save({ ...question, state: "superseded", revision: question.revision + 1 })
      }
      return created
    })()
  }

  answer(botId: string, id: string, revision: number, clientAnswerId: string, answer: string) {
    if (!/^[a-zA-Z0-9:_-]{1,120}$/.test(clientAnswerId) || typeof answer !== "string" || !answer.trim() || answer.length > 8192) throw new Error("BOT_ANSWER_INVALID")
    return this.db.transaction(() => {
      const current = this.get(botId, id)
      if (current.clientAnswerId === clientAnswerId && current.answer === answer.trim()) return current
      if (current.revision !== revision || current.state !== "pending") throw new Error("BOT_QUESTION_CONFLICT")
      return this.save({ ...current, state: "answered", revision: current.revision + 1, answer: answer.trim(), clientAnswerId, delivery: "queued" })
    })()
  }

  dismiss(botId: string, id: string, revision: number) {
    return this.db.transaction(() => {
      const current = this.get(botId, id)
      if (current.state === "dismissed" && current.revision === revision + 1) return current
      if (current.revision !== revision || current.state !== "pending") throw new Error("BOT_QUESTION_CONFLICT")
      return this.save({ ...current, state: "dismissed", revision: current.revision + 1 })
    })()
  }

  pending(): BotQuestion[] {
    return (this.db.query("select body_json from bot_questions where json_extract(body_json, '$.delivery') in ('queued', 'sending') order by rowid").all() as Array<{ body_json: string }>).map((row) => JSON.parse(row.body_json))
  }

  mark(botId: string, id: string, delivery: BotQuestion["delivery"], details: Partial<Pick<BotQuestion, "deliveryThreadId" | "deliveryTurnId" | "error">> = {}) {
    return this.db.transaction(() => {
      const current = this.get(botId, id)
      if (current.delivery === "delivered") return current
      return this.save({ ...current, ...details, delivery })
    })()
  }

  reconcile(botId: string, threadId: string, turns: Turn[]) {
    for (const question of this.list(botId)) {
      if (!question.clientAnswerId || question.delivery === "delivered") continue
      const turn = turns.find((turn) => turn.items.some((item) => item.type === "userMessage" && item.clientId === `question-answer:${question.id}:${question.clientAnswerId}`))
      if (turn) this.mark(botId, question.id, "delivered", { deliveryThreadId: threadId, deliveryTurnId: turn.id, error: undefined })
    }
  }
}
