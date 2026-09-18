import { randomUUID } from "node:crypto"
import type { Database } from "bun:sqlite"
import type { BotMemory, BotMemoryKind } from "../shared/bot-memory"
import { BOT_WORK_SUMMARY_KEY, formatWorkSummary, type BotWorkSummary } from "../shared/bot-work-summary"

export class BotMemoryStore {
  constructor(private readonly db: Database, private readonly validateSources: (botId: string, ids: string[]) => boolean = () => false) {
    db.exec(`create table if not exists bot_memories (
      id text primary key, bot_id text not null, key text not null, content text not null, kind text not null,
      origin text not null, revision integer not null, forgotten integer not null default 0, updated_at integer not null,
      unique (bot_id, key)
    )`)
    const columns = db.query("pragma table_info(bot_memories)").all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === "source_message_ids_json")) db.exec("alter table bot_memories add column source_message_ids_json text not null default '[]'")
    if (!columns.some((column) => column.name === "work_summary_json")) db.exec("alter table bot_memories add column work_summary_json text")
  }

  list(botId: string, includeForgotten = false): BotMemory[] {
    const rows = this.db.query(`select * from bot_memories where bot_id = ? and (? = 1 or forgotten = 0)
      order by case kind when 'working_context' then 0 when 'preference' then 1 when 'decision' then 2 else 3 end, updated_at desc`).all(botId, includeForgotten ? 1 : 0) as any[]
    return rows.map((row) => ({ id: row.id, key: row.key, content: row.content, kind: row.kind, origin: row.origin, revision: row.revision, forgotten: Boolean(row.forgotten), updatedAt: row.updated_at, ...(row.work_summary_json ? { workSummary: JSON.parse(row.work_summary_json) } : {}), ...(JSON.parse(row.source_message_ids_json).length ? { sourceMessageIds: JSON.parse(row.source_message_ids_json) } : {}) }))
  }

  save(botId: string, input: { key?: unknown; content?: unknown; kind?: unknown; expectedRevision?: unknown; sourceMessageIds?: unknown }, origin: "user" | "bot") {
    if (origin === "bot" && typeof input.key === "string" && input.key.trim() === BOT_WORK_SUMMARY_KEY) throw new Error("BOT_WORK_SUMMARY_USE_UPDATE_TOOL")
    return this.persist(botId, input, origin)
  }

  private persist(botId: string, input: { key?: unknown; content?: unknown; kind?: unknown; expectedRevision?: unknown; sourceMessageIds?: unknown }, origin: "user" | "bot", summary?: BotWorkSummary) {
    if (typeof input.key !== "string" || !input.key.trim() || input.key.length > 80 || typeof input.content !== "string" || !input.content.trim() || input.content.length > 2000 || !["preference", "fact", "decision", "working_context"].includes(String(input.kind))) throw new Error("BOT_MEMORY_INVALID")
    const key = input.key.trim()
    const content = input.content.trim()
    const kind = input.kind as BotMemoryKind
    return this.db.transaction(() => {
      const current = this.list(botId, true).find((entry) => entry.key === key)
      if (current && (current.forgotten || current.revision !== input.expectedRevision)) throw new Error("BOT_MEMORY_CONFLICT")
      if (!current && input.expectedRevision !== undefined) throw new Error("BOT_MEMORY_CONFLICT")
      if (!current && this.list(botId, true).length >= 200) throw new Error("BOT_MEMORY_LIMIT")
      const sources = input.sourceMessageIds === undefined ? current?.sourceMessageIds ?? [] : input.sourceMessageIds
      if (!Array.isArray(sources) || sources.length > 8 || sources.some((id) => typeof id !== "string" || !id || id.length > 512) || (sources.length > 0 && !this.validateSources(botId, sources))) throw new Error("BOT_MEMORY_SOURCE_INVALID")
      const id = current?.id ?? randomUUID()
      this.db.query(`insert into bot_memories (id,bot_id,key,content,kind,origin,revision,updated_at,source_message_ids_json,work_summary_json) values (?,?,?,?,?,?,1,?,?,?)
        on conflict(bot_id,key) do update set content=excluded.content,kind=excluded.kind,origin=excluded.origin,revision=bot_memories.revision+1,updated_at=excluded.updated_at,source_message_ids_json=excluded.source_message_ids_json,work_summary_json=excluded.work_summary_json`)
        .run(id, botId, key, content, kind, origin, Date.now(), JSON.stringify([...new Set(sources)]), summary ? JSON.stringify(summary) : null)
      return this.list(botId).find((entry) => entry.id === id)!
    })()
  }

  workSummary(botId: string) {
    const entry = this.list(botId, true).find((entry) => entry.key === BOT_WORK_SUMMARY_KEY)
    return { entry: entry?.forgotten ? null : entry ?? null, expectedRevision: entry?.revision ?? 0,
      writable: !entry || (!entry.forgotten && entry.origin === "bot"),
      reason: entry?.forgotten ? "forgotten" : entry?.origin === "user" ? "user_managed" : null }
  }

  updateWorkSummary(botId: string, input: unknown): BotMemory {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("BOT_WORK_SUMMARY_INVALID")
    const args = input as Record<string, unknown>
    if (Object.keys(args).some((key) => !["goal", "status", "decisions", "progress", "nextSteps", "blockers", "sourceMessageIds", "expectedRevision"].includes(key)) || !Number.isSafeInteger(args.expectedRevision) || typeof args.goal !== "string" || !args.goal.trim() || args.goal.length > 400 || !["active", "blocked", "completed"].includes(String(args.status))) throw new Error("BOT_WORK_SUMMARY_INVALID")
    for (const key of ["decisions", "progress", "nextSteps", "blockers"]) {
      const values = args[key]
      if (!Array.isArray(values) || values.length > 6 || values.some((value) => typeof value !== "string" || !value.trim() || value.length > 300)) throw new Error("BOT_WORK_SUMMARY_INVALID")
    }
    if (!Array.isArray(args.sourceMessageIds) || args.sourceMessageIds.length === 0) throw new Error("BOT_MEMORY_SOURCE_INVALID")
    const summary: BotWorkSummary = { goal: args.goal.trim(), status: args.status as BotWorkSummary["status"],
      decisions: (args.decisions as string[]).map((value) => value.trim()), progress: (args.progress as string[]).map((value) => value.trim()),
      nextSteps: (args.nextSteps as string[]).map((value) => value.trim()), blockers: (args.blockers as string[]).map((value) => value.trim()) }
    if (summary.status === "blocked" && !summary.blockers.length || summary.status === "completed" && (summary.nextSteps.length > 0 || summary.blockers.length > 0)) throw new Error("BOT_WORK_SUMMARY_STATUS_INVALID")
    return this.db.transaction(() => {
      const current = this.workSummary(botId)
      if (!current.writable) throw new Error("BOT_WORK_SUMMARY_USER_MANAGED")
      if (args.expectedRevision !== current.expectedRevision) throw new Error("BOT_MEMORY_CONFLICT")
      const supplied = args.sourceMessageIds as unknown[]
      if (supplied.length > 8 || supplied.some((id) => typeof id !== "string" || !id || id.length > 512) || !this.validateSources(botId, supplied as string[])) throw new Error("BOT_MEMORY_SOURCE_INVALID")
      const prior = current.entry?.sourceMessageIds ?? []
      const sourceMessageIds = [...new Set([...prior.slice(0, 1), ...supplied as string[], ...prior.slice(1)])].slice(0, 8)
      return this.persist(botId, { key: BOT_WORK_SUMMARY_KEY, content: formatWorkSummary(summary), kind: "working_context", sourceMessageIds, ...(current.entry ? { expectedRevision: current.entry.revision } : {}) }, "bot", summary)
    })()
  }

  setForgotten(botId: string, id: string, forgotten: boolean, expectedRevision: unknown) {
    const changed = this.db.query("update bot_memories set forgotten=?,revision=revision+1,updated_at=? where bot_id=? and id=? and revision=?")
      .run(forgotten ? 1 : 0, Date.now(), botId, id, typeof expectedRevision === "number" ? expectedRevision : -1)
    if (changed.changes !== 1) throw new Error("BOT_MEMORY_CONFLICT")
    return this.list(botId, true).find((entry) => entry.id === id)!
  }

  recall(botId: string, query = "") {
    const needle = query.trim().toLocaleLowerCase()
    let remaining = 8000
    const memories: BotMemory[] = []
    for (const entry of this.list(botId)) {
      if (needle && !`${entry.key} ${entry.content}`.toLocaleLowerCase().includes(needle)) continue
      const size = JSON.stringify(entry).length
      if (size > remaining || memories.length >= 20) continue
      remaining -= size
      memories.push(entry)
    }
    return { memories, scope: "current_bot", completeHistory: false }
  }
}
