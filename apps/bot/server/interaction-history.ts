import type { Database } from "bun:sqlite"
import type { ChatMessage } from "../shared/bot-timeline"
import { interactionMethods } from "./pending-interactions"

export class InteractionHistory {
  constructor(private readonly db: Database) {
    db.exec(`create table if not exists bot_interaction_history (
      bot_id text not null, runtime_id text not null, request_id text not null,
      thread_id text not null, turn_id text, method text not null,
      created_at integer not null, resolved integer not null default 0,
      primary key (bot_id, runtime_id, request_id)
    )`)
  }

  record(botId: string, runtimeId: string, message: any) {
    const params = message.params
    if (interactionMethods.has(message.method) && ["number", "string"].includes(typeof message.id) && typeof params?.threadId === "string") {
      this.db.query(`insert or ignore into bot_interaction_history
        (bot_id, runtime_id, request_id, thread_id, turn_id, method, created_at)
        values (?, ?, ?, ?, ?, ?, ?)`)
        .run(botId, runtimeId, JSON.stringify(message.id), params.threadId, params.turnId ?? null, message.method, Date.now())
    }
    if (message.method === "serverRequest/resolved") {
      this.db.query("update bot_interaction_history set resolved = 1 where bot_id = ? and runtime_id = ? and request_id = ?")
        .run(botId, runtimeId, JSON.stringify(params?.requestId))
    }
    if (message.method === "turn/completed") {
      this.db.query("update bot_interaction_history set resolved = 1 where bot_id = ? and runtime_id = ? and thread_id = ? and turn_id = ?")
        .run(botId, runtimeId, params?.threadId, params?.turn?.id ?? params?.turnId)
    }
  }

  expired(botId: string, isRuntimeLive: (id: string) => boolean): ChatMessage[] {
    const rows = this.db.query("select * from bot_interaction_history where bot_id = ? and resolved = 0 order by created_at").all(botId) as Array<{ runtime_id: string; request_id: string; thread_id: string; turn_id: string | null; method: string; created_at: number }>
    return rows.filter((row) => !isRuntimeLive(row.runtime_id)).map((row) => ({
      id: `interaction:${row.runtime_id}:${row.request_id}`,
      role: "system",
      text: row.method === "item/tool/requestUserInput"
        ? "先前等待回答的問題已因執行環境結束而失效。請在下方告訴 Bot 接續原工作，重新確認需要回答的問題。"
        : "先前等待確認的操作已因執行環境結束而失效，沒有沿用舊核准。請在下方告訴 Bot 接續原工作；需要授權時會重新詢問。",
      createdAt: row.created_at,
      runtimeThreadId: row.thread_id,
      runtimeTurnId: row.turn_id ?? undefined,
    }))
  }
}
