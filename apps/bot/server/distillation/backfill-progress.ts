import type { Database } from "bun:sqlite"

import type { DistillationBackfillProgress } from "./backfill"

export class SQLiteDistillationBackfillProgressStore {
  constructor(private readonly db: Database) {
    db.exec(`create table if not exists bot_distillation_backfill_progress (
      bot_id text not null,
      thread_id text not null,
      turn_id text not null,
      cursor text not null,
      seen_cursors_json text not null default '[]',
      exhausted_scans integer not null default 0,
      primary key (bot_id, thread_id, turn_id)
    )`)
    const columns = db.query("pragma table_info(bot_distillation_backfill_progress)").all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === "seen_cursors_json")) {
      db.exec("alter table bot_distillation_backfill_progress add column seen_cursors_json text not null default '[]'")
    }
    if (!columns.some((column) => column.name === "exhausted_scans")) {
      db.exec("alter table bot_distillation_backfill_progress add column exhausted_scans integer not null default 0")
    }
  }

  forTurn(botId: string, threadId: string, turnId: string): DistillationBackfillProgress {
    const botExists = () => {
      const table = this.db.query("select 1 from sqlite_master where type = 'table' and name = 'bots'").get()
      return !table || Boolean(this.db.query("select 1 from bots where id = ?").get(botId))
    }
    const clear = () => {
      this.db.query(`delete from bot_distillation_backfill_progress
        where bot_id = ? and thread_id = ? and turn_id = ?`).run(botId, threadId, turnId)
    }
    return {
      cursor: () => {
        const row = this.db.query(`select cursor from bot_distillation_backfill_progress
          where bot_id = ? and thread_id = ? and turn_id = ?`).get(botId, threadId, turnId) as { cursor: string } | null
        return row?.cursor || null
      },
      seen: () => {
        const row = this.db.query(`select seen_cursors_json from bot_distillation_backfill_progress
          where bot_id = ? and thread_id = ? and turn_id = ?`).get(botId, threadId, turnId) as { seen_cursors_json: string } | null
        try {
          const cursors: unknown = JSON.parse(row?.seen_cursors_json ?? "[]")
          return Array.isArray(cursors) && cursors.every((cursor) => typeof cursor === "string" && cursor) ? cursors : []
        } catch {
          return []
        }
      },
      exhaustedScans: () => {
        const row = this.db.query(`select exhausted_scans from bot_distillation_backfill_progress
          where bot_id = ? and thread_id = ? and turn_id = ?`).get(botId, threadId, turnId) as { exhausted_scans: number } | null
        return Math.max(0, Number(row?.exhausted_scans ?? 0))
      },
      save: (cursor, seen) => {
        if (!botExists()) {
          clear()
          return
        }
        this.db.query(`insert into bot_distillation_backfill_progress (bot_id, thread_id, turn_id, cursor, seen_cursors_json)
          values (?, ?, ?, ?, ?)
          on conflict(bot_id, thread_id, turn_id) do update set cursor = excluded.cursor, seen_cursors_json = excluded.seen_cursors_json`).run(
          botId,
          threadId,
          turnId,
          cursor,
          JSON.stringify(seen),
        )
      },
      resetCursor: () => {
        if (!botExists()) {
          clear()
          return
        }
        this.db.query(`update bot_distillation_backfill_progress set cursor = '', seen_cursors_json = '[]', exhausted_scans = 0
          where bot_id = ? and thread_id = ? and turn_id = ?`).run(botId, threadId, turnId)
      },
      recordExhaustedScan: () => {
        if (!botExists()) {
          clear()
          return 0
        }
        this.db.query(`insert into bot_distillation_backfill_progress (bot_id, thread_id, turn_id, cursor, seen_cursors_json, exhausted_scans)
          values (?, ?, ?, '', '[]', 1)
          on conflict(bot_id, thread_id, turn_id) do update set cursor = '', seen_cursors_json = '[]', exhausted_scans = exhausted_scans + 1`).run(botId, threadId, turnId)
        const row = this.db.query(`select exhausted_scans from bot_distillation_backfill_progress
          where bot_id = ? and thread_id = ? and turn_id = ?`).get(botId, threadId, turnId) as { exhausted_scans: number }
        return Number(row.exhausted_scans)
      },
      clear,
    }
  }
}
