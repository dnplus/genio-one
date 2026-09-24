import { projectHandoffTimeline } from "../shared/handoff-timeline"
import type { Database } from "bun:sqlite"
import { isDeepStrictEqual } from "node:util"
import type { Turn } from "./generated/v2/Turn"
import type { ThreadItem } from "./generated/v2/ThreadItem"
import type { ChatMessage } from "../shared/bot-timeline"
import type { BotHandoffEvent } from "./bot-handoff"
import { reconstructTurnMessages } from "../shared/bot-timeline"
import { mcpHtmlArtifacts, withMcpHtmlArtifacts } from "../shared/mcp-html-artifacts"
import { validateLegacyHistory } from "../shared/legacy-history"
import type { BotWorkContext } from "../shared/bot-work-context"
import type { BotSidebarSummary } from "../shared/bot-roster"
import { createHash } from "node:crypto"

type StoredTurn = Turn & { completedItemIds?: string[] }

export class BotTimelineStore {
  private liveRevision = 0
  private readonly liveTurns = new Map<string, number>()

  revision() { return this.liveRevision }

  turnStatus(botId: string, threadId: string, turnId: string): string | null {
    const row = this.db.query("select json_extract(body_json, '$.status') as status from bot_timeline_turns where bot_id = ? and thread_id = ? and turn_id = ?").get(botId, threadId, turnId) as { status: string } | null
    return row?.status ?? null
  }

  activeTurns(botId: string): Array<{ threadId: string; turnId: string }> {
    return this.db.query("select thread_id as threadId, turn_id as turnId from bot_timeline_turns where bot_id = ? and json_extract(body_json, '$.status') = 'inProgress'").all(botId) as Array<{ threadId: string; turnId: string }>
  }

  hasRunningTurns(botId: string): boolean {
    return Boolean(this.db.query("select 1 from bot_timeline_turns where bot_id = ? and json_extract(body_json, '$.status') = 'inProgress' limit 1").get(botId))
  }

  interruptTurn(botId: string, threadId: string, turnId: string): boolean {
    const current = this.getTurn(botId, threadId, turnId)
    if (!current || current.status !== "inProgress") return false
    this.putTurn(botId, threadId, { ...current, status: "interrupted" })
    return true
  }

  latestTurnStatus(botId: string): string | null {
    const row = this.db.query(`select json_extract(body_json, '$.status') as status from bot_timeline_turns
      where bot_id = ? order by coalesce(json_extract(body_json, '$.startedAt') * 1000, first_seen_at) desc, rowid desc limit 1`).get(botId) as { status: string } | null
    return row?.status ?? null
  }

  sidebarSummary(botId: string, events: BotHandoffEvent[]): BotSidebarSummary | null {
    const row = this.db.query(`select thread_id, body_json from bot_timeline_turns t
      where bot_id = ? and exists (select 1 from json_each(t.body_json, '$.items') i
        where json_extract(i.value, '$.type') in ('userMessage', 'agentMessage'))
      order by coalesce(json_extract(body_json, '$.startedAt') * 1000, first_seen_at) desc, rowid desc limit 1`)
      .get(botId) as { thread_id: string; body_json: string } | null
    const turn = row ? JSON.parse(row.body_json) as Turn : null
    const native = row && turn ? this.project(botId, reconstructTurnMessages([turn], new Set(), row.thread_id)).reverse().find((message) => message.role !== "system") : undefined
    const timestamp = native?.role === "assistant" && typeof turn?.completedAt === "number" ? turn.completedAt * 1000 : native?.createdAt
    const handoff = [...events].sort((a, b) => b.createdAt - a.createdAt)[0]
    if (handoff && (!native || handoff.createdAt > (timestamp ?? 0))) return { preview: handoff.kind === "fyi" ? handoff.type === "handoff.read" ? "已讀取 FYI" : "收到 FYI，等待空閒時讀取" : handoff.fact.replace(/\s+/g, " ").slice(0, 120), timestamp: handoff.createdAt }
    return native ? { preview: native.text.replace(/\s+/g, " ").slice(0, 120), timestamp } : null
  }

  constructor(private readonly db: Database, private readonly inputLabel: (botId: string, clientId: string) => string | null = () => null, private readonly inputHandoff: (botId: string, clientId: string) => string | null = () => null, private readonly questionInput: (botId: string, clientId: string) => { id: string; answer: string } | null = () => null) {
    db.exec(`create table if not exists bot_product_messages (
      bot_id text not null, message_id text not null, body_json text not null, primary key (bot_id, message_id)
    )`)
    db.exec(`create table if not exists bot_timeline_turns (
      bot_id text not null,
      thread_id text not null,
      turn_id text not null,
      body_json text not null,
      first_seen_at integer not null,
      primary key (bot_id, thread_id, turn_id)
    )`)
    const columns = db.query("pragma table_info(bot_timeline_turns)").all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === "revision")) db.exec("alter table bot_timeline_turns add column revision integer not null default 1")
    db.exec("create index if not exists bot_timeline_turns_first_seen on bot_timeline_turns (bot_id, first_seen_at)")
    db.exec(`create table if not exists bot_legacy_history (
      bot_id text not null,
      source_key text not null,
      position integer not null,
      body_json text not null,
      primary key (bot_id, source_key, position)
    )`)
  }

  saveProductMessage(botId: string, message: ChatMessage) {
    this.db.query("insert into bot_product_messages (bot_id, message_id, body_json) values (?, ?, ?)").run(botId, message.id, JSON.stringify(message))
  }

  importLegacy(botId: string, input: unknown) {
    const entries = validateLegacyHistory(botId, input)
    const put = this.db.query(`insert into bot_legacy_history (bot_id, source_key, position, body_json)
      values (?, ?, ?, ?) on conflict(bot_id, source_key, position) do update set body_json = excluded.body_json`)
    this.db.transaction(() => {
      for (const entry of entries) put.run(botId, entry.sourceKey, entry.position, JSON.stringify(entry.message))
    })()
    return { imported: entries.length }
  }

  putTurn(botId: string, threadId: string, turn: StoredTurn, preserveExisting = false) {
    const storedTurn = { ...turn, items: (turn.items ?? []).map((item) => {
      const verified = mcpHtmlArtifacts(item).filter((artifact) => createHash("sha256").update(artifact.text, "utf8").digest("hex") === artifact.sha256.toLowerCase())
      return withMcpHtmlArtifacts(item, verified)
    }) }
    const existing = this.getTurn(botId, threadId, storedTurn.id)
    const items = new Map((existing?.items ?? []).map((item) => [item.id, item]))
    for (const item of storedTurn.items ?? []) if (!preserveExisting || !items.has(item.id)) items.set(item.id, item)
    const metadata = preserveExisting && existing ? { ...storedTurn, ...existing } : { ...existing, ...storedTurn }
    const merged = { ...metadata, startedAt: existing?.startedAt ?? storedTurn.startedAt ?? null, items: [...items.values()] }
    if (isDeepStrictEqual(existing, merged)) return
    this.db.query(`insert into bot_timeline_turns (bot_id, thread_id, turn_id, body_json, first_seen_at)
      values (?, ?, ?, ?, ?) on conflict(bot_id, thread_id, turn_id) do update set body_json = excluded.body_json, revision = revision + 1`)
      .run(botId, threadId, storedTurn.id, JSON.stringify(merged), Date.now())
  }

  importSnapshot(botId: string, threadId: string, turn: Turn, readRevision: number) {
    const existing = this.getTurn(botId, threadId, turn.id)
    const finalized = new Map(existing?.items.filter((item) => existing.completedItemIds?.includes(item.id)).map((item) => [item.id, item]))
    const snapshot = { ...turn, items: (turn.items ?? []).map((item) => finalized.get(item.id) ?? item) }
    this.putTurn(botId, threadId, snapshot, (this.liveTurns.get(JSON.stringify([botId, threadId, turn.id])) ?? 0) > readRevision || Boolean(existing && existing.status !== "inProgress" && turn.status === "inProgress"))
  }

  readTurn(botId: string, threadId: string, turnId: string): ChatMessage[] {
    const row = this.db.query("select body_json, revision from bot_timeline_turns where bot_id = ? and thread_id = ? and turn_id = ?").get(botId, threadId, turnId) as { body_json: string; revision: number } | null
    return row ? this.project(botId, reconstructTurnMessages([JSON.parse(row.body_json)], new Set(), threadId).map((message) => ({ ...message, timelineRevision: row.revision }))) : []
  }

  private project(botId: string, messages: ChatMessage[]): ChatMessage[] {
    const inputs = new Map(messages.filter((message) => message.clientMessageId).map((message) => [message.id, message.clientMessageId!]))
    return messages.map((message) => {
      const question = message.clientMessageId ? this.questionInput(botId, message.clientMessageId) : null
      if (question) return { ...message, text: question.answer, replyToMessageId: `question:${question.id}` }
      const label = message.clientMessageId ? this.inputLabel(botId, message.clientMessageId) : null
      const clientId = message.clientMessageId ?? (message.replyToMessageId ? inputs.get(message.replyToMessageId) : undefined)
      const handoffId = clientId ? this.inputHandoff(botId, clientId) : null
      const projected = handoffId ? { ...message, handoffId, replyToMessageId: `handoff:${handoffId}` } : message
      return label ? { ...projected, messageType: "bot_exchange", role: "system", kind: "activity", text: label } : projected
    })
  }

  storedTurn(botId: string, threadId: string, turnId: string): { bodyJson: string; turn: StoredTurn; revision: number } | null {
    const row = this.db.query("select body_json, revision from bot_timeline_turns where bot_id = ? and thread_id = ? and turn_id = ?").get(botId, threadId, turnId) as { body_json: string; revision: number } | null
    return row ? { bodyJson: row.body_json, turn: JSON.parse(row.body_json) as StoredTurn, revision: Number(row.revision) } : null
  }

  private getTurn(botId: string, threadId: string, turnId: string): StoredTurn | null {
    const row = this.db.query("select body_json from bot_timeline_turns where bot_id = ? and thread_id = ? and turn_id = ?").get(botId, threadId, turnId) as { body_json: string } | null
    return row ? JSON.parse(row.body_json) : null
  }

  record(botId: string, message: { method?: string; params?: any }) {
    const { method, params } = message
    const threadId = params?.threadId
    const turnId = params?.turnId ?? params?.turn?.id
    if (typeof threadId !== "string" || typeof turnId !== "string") return
    this.liveTurns.set(JSON.stringify([botId, threadId, turnId]), ++this.liveRevision)
    const current: StoredTurn = this.getTurn(botId, threadId, turnId) ?? {
      id: turnId, items: [], itemsView: "full", status: "inProgress", startedAt: null, completedAt: null, durationMs: null, error: null,
    } satisfies Turn
    if ((method === "turn/started" || method === "turn/completed") && params.turn) {
      if (method === "turn/started" && current.status !== "inProgress") return
      this.putTurn(botId, threadId, { ...current, ...params.turn })
    } else if ((method === "item/started" || method === "item/completed") && params.item?.id) {
      if (method === "item/started" && current.completedItemIds?.includes(params.item.id)) return
      this.putTurn(botId, threadId, { ...current, items: [params.item as ThreadItem], completedItemIds: method === "item/completed" ? [...new Set([...(current.completedItemIds ?? []), params.item.id])] : current.completedItemIds })
    } else if (method === "item/agentMessage/delta" && typeof params.itemId === "string" && typeof params.delta === "string") {
      if (current.status !== "inProgress" || current.completedItemIds?.includes(params.itemId)) return
      const previous = current.items.find((item) => item.id === params.itemId && item.type === "agentMessage")
      const item: ThreadItem = { type: "agentMessage", id: params.itemId, phase: null, memoryCitation: null, delivery: null, questions: null, ...(previous?.type === "agentMessage" ? previous : {}), text: `${previous?.type === "agentMessage" ? previous.text : ""}${params.delta}` }
      this.putTurn(botId, threadId, { ...current, items: [item] })
    }
  }

  read(botId: string, events: BotHandoffEvent[]): ChatMessage[] {
    const rows = this.db.query("select thread_id, body_json, revision from bot_timeline_turns where bot_id = ? order by first_seen_at, rowid").all(botId) as Array<{ thread_id: string; body_json: string; revision: number }>
    const native = this.project(botId, rows.flatMap((row) => reconstructTurnMessages([JSON.parse(row.body_json)], new Set(), row.thread_id).map((message) => ({ ...message, timelineRevision: row.revision }))))
    const handoffs = projectHandoffTimeline(botId, events)
    const legacyRows = this.db.query("select source_key, position, body_json from bot_legacy_history where bot_id = ? order by source_key, position").all(botId) as Array<{ source_key: string; position: number; body_json: string }>
    const nativeById = new Map(native.map((message) => [message.id, message]))
    const legacy: ChatMessage[] = legacyRows.flatMap((row): ChatMessage[] => {
      const original = JSON.parse(row.body_json)
      const candidateId = typeof original.runtimeThreadId === "string" && typeof original.id === "string"
        ? (original.id.startsWith(`${original.runtimeThreadId}:`) ? original.id : `${original.runtimeThreadId}:${original.id}`)
        : undefined
      const canonical = candidateId ? nativeById.get(candidateId) : undefined
      if (canonical && canonical.text === original.text && canonical.role === original.role) return []
      return [{
        id: `legacy:${row.source_key}:${row.position}`,
        role: "system",
        kind: "legacy",
        messageType: "legacy",
        text: original.text,
        createdAt: typeof original.createdAt === "number" && Number.isFinite(original.createdAt) ? original.createdAt : undefined,
        legacySource: { sourceKey: row.source_key, position: row.position, originalRole: original.role },
      }]
    })
    const product = (this.db.query("select body_json from bot_product_messages where bot_id = ? order by rowid").all(botId) as Array<{ body_json: string }>).map((row) => JSON.parse(row.body_json) as ChatMessage)
    return [...legacy, ...product, ...native, ...handoffs].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  }

  terminalClientTurn(botId: string, clientId: string): Turn | null {
    const row = this.db.query(`select t.body_json from bot_timeline_turns t
      where t.bot_id = ? and json_extract(t.body_json, '$.status') in ('completed', 'failed', 'interrupted')
      and exists (select 1 from json_each(t.body_json, '$.items') i
        where json_extract(i.value, '$.type') = 'userMessage'
        and json_extract(i.value, '$.clientId') = ?)
      order by t.first_seen_at limit 1`).get(botId, clientId) as { body_json: string } | null
    return row ? JSON.parse(row.body_json) : null
  }

  workContext(botId: string, currentThreadId: string): BotWorkContext {
    const rows = this.db.query(`select thread_id, body_json from bot_timeline_turns
      where bot_id = ? and thread_id != ? order by coalesce(json_extract(body_json, '$.startedAt') * 1000, first_seen_at) desc, rowid desc limit 4`)
      .all(botId, currentThreadId) as Array<{ thread_id: string; body_json: string }>
    return { completeHistory: false, turns: rows.reverse().map((row) => {
      const turn = JSON.parse(row.body_json) as Turn
      const request = turn.items.flatMap((item) => item.type === "userMessage" ? item.content.flatMap((part) => part.type === "text" ? [part.text] : []) : []).join("\n")
      const response = turn.items.flatMap((item) => item.type === "agentMessage" ? [item.text] : []).join("\n")
      const messages = reconstructTurnMessages([turn], new Set(), row.thread_id)
      return { threadId: row.thread_id, turnId: turn.id, status: turn.status, startedAt: turn.startedAt ?? null,
        request: request.slice(0, 1500), response: response.slice(0, 1500), truncated: request.length > 1500 || response.length > 1500 || messages.length > 8,
        sourceMessageIds: messages.slice(0, 8).map((message) => message.id),
        omittedAttachments: turn.items.some((item) => item.type === "userMessage" && item.content.some((part) => part.type !== "text")) }
    }) }
  }
}
