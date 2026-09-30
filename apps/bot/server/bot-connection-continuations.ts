import type { Database } from "bun:sqlite"
import type { Turn } from "./generated/v2/Turn"

export type BotConnectionContinuationState = "queued" | "awaiting_mcp" | "starting" | "retrying" | "running" | "guarded" | "completed" | "failed" | "cancelled"

export type BotConnectionContinuation = {
  requestToken: string
  botId: string
  tenantId: string
  ownerSubjectId: string
  sourceThreadId: string
  sourceTurnId: string
  resourceId: string
  resourceName: string
  capabilityId: string
  clientId: string
  state: BotConnectionContinuationState
  serverNames: string[]
  continuationThreadId?: string
  continuationTurnId?: string
  error?: string
  createdAt: number
}

type EnqueueInput = Omit<BotConnectionContinuation, "clientId" | "state" | "serverNames" | "createdAt">

function terminal(state: BotConnectionContinuationState) {
  return state === "completed" || state === "failed" || state === "cancelled"
}

export class BotConnectionContinuations {
  constructor(private readonly db: Database) {
    db.exec(`create table if not exists bot_connection_continuations (
      request_token text primary key,
      bot_id text not null,
      body_json text not null
    )`)
  }

  enqueue(input: EnqueueInput) {
    const continuation: BotConnectionContinuation = {
      ...input,
      clientId: `connection-resume:${input.requestToken}`,
      state: "queued",
      serverNames: [],
      createdAt: Date.now(),
    }
    this.db.query("insert or ignore into bot_connection_continuations (request_token, bot_id, body_json) values (?, ?, ?)")
      .run(continuation.requestToken, continuation.botId, JSON.stringify(continuation))
    return this.get(input.requestToken)
  }

  get(requestToken: string) {
    const row = this.db.query("select body_json from bot_connection_continuations where request_token = ?").get(requestToken) as { body_json: string } | null
    if (!row) throw new Error("BOT_CONNECTION_CONTINUATION_NOT_FOUND")
    return JSON.parse(row.body_json) as BotConnectionContinuation
  }

  pending() {
    return (this.db.query(`select body_json from bot_connection_continuations
      where json_extract(body_json, '$.state') in ('queued', 'awaiting_mcp', 'starting', 'retrying', 'running', 'guarded') order by rowid`).all() as Array<{ body_json: string }>)
      .map((row) => JSON.parse(row.body_json) as BotConnectionContinuation)
  }

  inputLabel(botId: string, clientId: string) {
    return this.db.query("select 1 from bot_connection_continuations where bot_id = ? and json_extract(body_json, '$.clientId') = ?")
      .get(botId, clientId)
      ? "個人連線已完成，接續工作"
      : null
  }

  markMcpReloaded(requestToken: string, serverNames: string[]) {
    const current = this.get(requestToken)
    if (current.state !== "queued") return current
    return this.save({ ...current, state: "awaiting_mcp", serverNames: [...new Set(serverNames)], error: undefined })
  }

  claim(requestToken: string) {
    return this.db.query(`update bot_connection_continuations
      set body_json = json_set(body_json, '$.state', 'starting')
      where request_token = ? and json_extract(body_json, '$.state') in ('awaiting_mcp', 'retrying')`)
      .run(requestToken).changes === 1
  }

  started(requestToken: string, continuationThreadId: string, continuationTurnId: string) {
    const current = this.get(requestToken)
    if (current.state !== "starting") return current
    return this.save({ ...current, state: "running", continuationThreadId, continuationTurnId, error: undefined })
  }

  retryStarting(requestToken: string) {
    const current = this.get(requestToken)
    if (current.state !== "starting") return current
    return this.save({ ...current, state: "retrying", error: undefined })
  }

  readOnlyGuard(botId: string, resourceId: string) {
    return this.pending().find((entry) => entry.botId === botId && entry.resourceId === resourceId && (entry.state === "starting" || entry.state === "retrying" || entry.state === "running" || entry.state === "guarded")) ?? null
  }

  isReadOnlyBotTurn(botId: string) {
    return this.pending().some((entry) => entry.botId === botId && (entry.state === "starting" || entry.state === "retrying" || entry.state === "running" || entry.state === "guarded"))
  }

  fail(requestToken: string, error: string) {
    const current = this.get(requestToken)
    if (terminal(current.state)) return current
    return this.save({ ...current, state: "failed", error })
  }

  releaseGuarded(botId: string, error: string) {
    const released = this.pending().filter((entry) => entry.botId === botId && entry.state === "guarded")
    for (const entry of released) this.save({ ...entry, state: "failed", error })
    return released
  }

  cancel(requestToken: string, error: string) {
    const current = this.get(requestToken)
    if (terminal(current.state)) return current
    if (current.state === "starting" || current.state === "retrying" || current.state === "running") return this.save({ ...current, state: "guarded", error })
    return this.save({ ...current, state: "cancelled", error })
  }

  observe(botId: string, threadId: string, method: string, params: Record<string, unknown>) {
    const entries = this.pending().filter((entry) => entry.botId === botId && entry.continuationThreadId === threadId)
    for (const entry of entries) {
      const item = params.item as Record<string, unknown> | undefined
      if ((method === "item/started" || method === "item/completed") && item?.type === "userMessage" && item.clientId === entry.clientId && typeof params.turnId === "string" && entry.state === "starting") {
        this.save({ ...entry, state: "running", continuationTurnId: params.turnId })
        continue
      }
      const turn = params.turn as { id?: unknown; status?: unknown } | undefined
      const turnId = typeof turn?.id === "string" ? turn.id : typeof params.turnId === "string" ? params.turnId : null
      if (method === "turn/completed" && turnId === entry.continuationTurnId) {
        this.save({ ...entry, state: turn?.status === "completed" ? "completed" : "failed", error: turn?.status === "completed" ? undefined : "CONNECTION_CONTINUATION_STOPPED" })
      }
    }
  }

  reconcile(entry: BotConnectionContinuation, turns: Turn[]) {
    const turn = turns.find((candidate) => candidate.items.some((item) => item.type === "userMessage" && item.clientId === entry.clientId))
    if (!turn) return false
    this.save({
      ...entry,
      state: turn.status === "inProgress" ? "running" : turn.status === "completed" ? "completed" : "failed",
      continuationTurnId: turn.id,
      error: turn.status === "inProgress" || turn.status === "completed" ? undefined : "CONNECTION_CONTINUATION_STOPPED",
    })
    return true
  }

  private save(continuation: BotConnectionContinuation) {
    this.db.query("update bot_connection_continuations set body_json = ? where request_token = ?")
      .run(JSON.stringify(continuation), continuation.requestToken)
    return continuation
  }
}
