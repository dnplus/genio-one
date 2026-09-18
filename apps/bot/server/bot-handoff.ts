/**
 * UX P1-a: Bot↔Bot async handoff.
 * Send → immediate ack; recipient processes later (not same-turn dialogue).
 * User-visible handoff events; FYI may be silent; no mindless fan-out.
 */
import { randomUUID } from "node:crypto"
import type { Database } from "bun:sqlite"

import type { GenioPrincipal } from "./runtime-broker"
import type { BotRecord } from "./bot-registry"
import type { BotInvocationRequest, BotInvocationState } from "./bot-invocation-store"

export type HandoffKind = "task" | "fyi"
export type HandoffVisibility = "visible" | "silent"
export type HandoffEventType =
  | "handoff.sent"
  | "handoff.acked"
  | "handoff.queued"
  | "handoff.delivered"
  | "handoff.read"
  | "handoff.replied"
  | "handoff.failed"

export interface BotHandoffEvent {
  eventId: string
  sourceMessageId?: string
  state?: string
  fromBotId?: string
  toBotId?: string
  fromName?: string
  toName?: string
  handoffId: string
  tenantId: string
  botId: string
  peerBotId: string
  kind: HandoffKind
  visibility: HandoffVisibility
  type: HandoffEventType
  summary: string
  fact: string
  invocationId: string | null
  createdAt: number
}

export interface BotHandoffAck {
  handoffId: string
  invocationId: string
  state: "ACKED" | "QUEUED" | "PENDING_APPROVAL"
  kind: HandoffKind
  visibility: HandoffVisibility
  fromBotId: string
  toBotId: string
  fact: string
  summary: string
  /** True when HTTP returns before target processes the fact. */
  async: true
  processed: false
  events: BotHandoffEvent[]
  createdAt: number
}

export interface CreateHandoffInput {
  clientRequestId?: string
  originalMessage?: string
  sourceAuthor?: "user" | "bot"
  fromBotId: string
  /** Single target — required unless fanOutExplicit + toBotIds. */
  toBotId?: string
  /** Multi-target only when fanOutExplicit === true. */
  toBotIds?: string[]
  /** Must be true to address more than one recipient. */
  fanOutExplicit?: boolean
  fact: string
  kind?: HandoffKind
  /** FYI defaults silent; task defaults visible. Override allowed. */
  visibility?: HandoffVisibility
}

export class HandoffFanOutError extends Error {
  readonly code = "HANDOFF_FAN_OUT_REQUIRES_EXPLICIT"
  constructor(message = "Bot handoff refuses mindless fan-out; set fanOutExplicit with explicit toBotIds") {
    super(message)
    this.name = "HandoffFanOutError"
  }
}

export function resolveHandoffTargets(input: CreateHandoffInput): string[] {
  const explicitIds = [...new Set((input.toBotIds ?? []).map((id) => id.trim()).filter(Boolean))]
  const single = typeof input.toBotId === "string" ? input.toBotId.trim() : ""
  const merged = [...new Set([...(single ? [single] : []), ...explicitIds])]
  if (merged.length === 0) throw new Error("HANDOFF_TARGET_REQUIRED")
  if (merged.length > 1 && input.fanOutExplicit !== true) throw new HandoffFanOutError()
  return merged
}

export function resolveHandoffVisibility(kind: HandoffKind, visibility?: HandoffVisibility): HandoffVisibility {
  if (visibility === "visible" || visibility === "silent") return visibility
  return kind === "fyi" ? "silent" : "visible"
}

export function handoffBubbleText(event: Pick<BotHandoffEvent, "type" | "kind" | "summary" | "fact">): string {
  if (event.type === "handoff.sent") {
    return event.kind === "fyi" ? `已送出 FYI（可靜默）` : `已送出交接：${event.summary}`
  }
  if (event.type === "handoff.acked") return `已確認送出（對方稍後處理）`
  if (event.type === "handoff.queued") return `交接已排入佇列，對方稍後處理`
  if (event.type === "handoff.delivered") return `收到交接：${event.fact}`
  if (event.type === "handoff.failed") return `交接失敗：${event.summary}`
  return event.summary
}

export function ensureBotHandoffSchema(db: Database) {
  db.exec(`
    create table if not exists bot_handoffs (
      handoff_id text primary key,
      tenant_id text not null,
      from_bot_id text not null,
      to_bot_id text not null,
      caller_subject_id text not null,
      kind text not null,
      visibility text not null,
      fact text not null,
      summary text not null,
      invocation_id text,
      state text not null,
      processed integer not null default 0,
      created_at integer not null,
      processed_at integer
    );
    create table if not exists bot_handoff_events (
      event_id text primary key,
      handoff_id text not null,
      tenant_id text not null,
      bot_id text not null,
      peer_bot_id text not null,
      kind text not null,
      visibility text not null,
      type text not null,
      summary text not null,
      fact text not null,
      invocation_id text,
      created_at integer not null
    );
    create index if not exists bot_handoff_events_bot_idx on bot_handoff_events (tenant_id, bot_id, created_at);
    update bot_handoff_events set type = 'handoff.replied'
      where type = 'handoff.delivered' and bot_id = (
        select from_bot_id from bot_handoffs where bot_handoffs.handoff_id = bot_handoff_events.handoff_id
      );
  `)
}

export class BotHandoffStore {
  constructor(
    private readonly db: Database,
    private readonly getOwnedBot: (botId: string, principal: GenioPrincipal) => BotRecord | null,
    private readonly getBot: (botId: string, principal: GenioPrincipal) => BotRecord | null,
    private readonly createInvocation: (principal: GenioPrincipal, input: {
      callerBotId: string
      targetBotId: string
      task: string
      selectedContextRefs?: string[]
      requestedCapabilityIds?: string[]
      actionDigest: string
      expiresAt?: number
    }) => BotInvocationRequest,
    private readonly markTargetUnread?: (botId: string) => void,
  ) {
    ensureBotHandoffSchema(this.db)
    this.db.exec(`create table if not exists bot_handoff_requests (
      bot_id text not null, request_id text not null, payload text not null, ack_json text not null,
      primary key (bot_id, request_id)
    )`)
    const columns = this.db.query("pragma table_info(bot_handoffs)").all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === "source_message_id")) this.db.exec("alter table bot_handoffs add column source_message_id text")
  }

  /** Create one or more handoffs. Multi-target requires fanOutExplicit. Returns acks immediately (async). */
  createHandoffs(principal: GenioPrincipal, input: CreateHandoffInput): BotHandoffAck[] {
    const targets = resolveHandoffTargets(input)
    if (!this.getOwnedBot(input.fromBotId, principal)) throw new Error("BOT_NOT_FOUND")
    if (input.clientRequestId !== undefined && (!/^[a-zA-Z0-9:_-]{1,120}$/.test(input.clientRequestId))) throw new Error("HANDOFF_REQUEST_ID_INVALID")
    if (input.originalMessage !== undefined && (!input.originalMessage.trim() || input.originalMessage.length > 8192)) throw new Error("HANDOFF_SOURCE_INVALID")
    const payload = JSON.stringify([targets, input.fact, input.kind ?? "task", input.visibility ?? null, input.originalMessage ?? null, input.sourceAuthor ?? "bot"])
    return this.db.transaction(() => {
      if (input.clientRequestId) {
        const previous = this.db.query("select payload, ack_json from bot_handoff_requests where bot_id = ? and request_id = ?").get(input.fromBotId, input.clientRequestId) as { payload: string; ack_json: string } | null
        if (previous) {
          if (previous.payload !== payload) throw new Error("HANDOFF_REQUEST_CONFLICT")
          return JSON.parse(previous.ack_json) as BotHandoffAck[]
        }
      }
      const acks = targets.map((toBotId) => this.createOne(principal, { ...input, toBotId, toBotIds: undefined }))
      if (input.clientRequestId) this.db.query("insert into bot_handoff_requests values (?, ?, ?, ?)").run(input.fromBotId, input.clientRequestId, payload, JSON.stringify(acks))
      return acks
    })()
  }

  createHandoff(principal: GenioPrincipal, input: CreateHandoffInput): BotHandoffAck {
    const acks = this.createHandoffs(principal, input)
    if (acks.length !== 1) throw new HandoffFanOutError("use createHandoffs for explicit multi-target")
    return acks[0]!
  }

  private createOne(principal: GenioPrincipal, input: CreateHandoffInput & { toBotId: string }): BotHandoffAck {
    const toBotId = input.toBotId.trim()
    const fromBot = this.getOwnedBot(input.fromBotId, principal)
    if (!fromBot) throw new Error("BOT_NOT_FOUND")
    if (fromBot.id === toBotId) throw new Error("HANDOFF_SELF_DENIED")

    const kind: HandoffKind = input.kind === "fyi" ? "fyi" : "task"
    const visibility = resolveHandoffVisibility(kind, input.visibility)
    const fact = input.fact.trim()
    if (!fact) throw new Error("HANDOFF_FACT_REQUIRED")
    if (fact.length > 4096) throw new Error("HANDOFF_FACT_TOO_LONG")

    const sameOwnerTarget = this.getOwnedBot(toBotId, principal)
    const sharedTarget = this.getBot(toBotId, principal)
    const target = sameOwnerTarget ?? sharedTarget
    if (!target) throw new Error("BOT_NOT_FOUND")
    if (!sameOwnerTarget) {
      if (!target.sharePolicy.invocable || !target.sharePolicy.discoverable) throw new Error("BOT_NOT_SHARED")
    }

    const summary = kind === "fyi" ? `FYI → ${target.name}` : `交接 → ${target.name}`
    const actionDigest = `handoff:${kind}:${fromBot.id}:${toBotId}:${fact.slice(0, 64)}`

    // Same-owner fleet: always ack+queue without blocking on ALWAYS_ASK share approval.
    // Cross-owner still uses share-gated bot-invocation (may be PENDING_APPROVAL).
    let invocation: BotInvocationRequest
    if (sameOwnerTarget) {
      invocation = this.insertSameOwnerInvocation(principal, {
        callerBotId: fromBot.id,
        targetBotId: target.id,
        targetOwnerSubjectId: target.ownerSubjectId,
        targetAgentSubjectId: target.agentSubjectId,
        task: fact,
        actionDigest,
      })
    } else {
      invocation = this.createInvocation(principal, {
        callerBotId: fromBot.id,
        targetBotId: target.id,
        task: fact,
        selectedContextRefs: ["handoff-fact"],
        requestedCapabilityIds: [],
        actionDigest,
      })
    }

    const now = Date.now()
    const handoffId = `bot-handoff-${randomUUID()}`
    const queueState = invocation.state === "APPROVED" ? "QUEUED" : "PENDING_APPROVAL"

    this.db.query(`insert into bot_handoffs (
      handoff_id, tenant_id, from_bot_id, to_bot_id, caller_subject_id,
      kind, visibility, fact, summary, invocation_id, state, processed, created_at, processed_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, null)`).run(
      handoffId,
      principal.tenant_id,
      fromBot.id,
      target.id,
      principal.subject_id,
      kind,
      visibility,
      fact,
      summary,
      invocation.requestId,
      queueState,
      now,
    )

    if (input.clientRequestId) this.db.query("update bot_handoffs set source_message_id = ? where handoff_id = ?").run(`handoff-source:${input.clientRequestId}`, handoffId)

    const callerEvents: BotHandoffEvent[] = []
    callerEvents.push(this.insertEvent({
      handoffId,
      tenantId: principal.tenant_id,
      botId: fromBot.id,
      peerBotId: target.id,
      kind,
      visibility: "visible",
      type: "handoff.sent",
      summary,
      fact,
      invocationId: invocation.requestId,
      createdAt: now,
    }))
    callerEvents.push(this.insertEvent({
      handoffId,
      tenantId: principal.tenant_id,
      botId: fromBot.id,
      peerBotId: target.id,
      kind,
      visibility: "visible",
      type: "handoff.acked",
      summary: "已確認送出（對方稍後處理）",
      fact,
      invocationId: invocation.requestId,
      createdAt: now,
    }))
    if (queueState === "QUEUED") {
      callerEvents.push(this.insertEvent({
        handoffId,
        tenantId: principal.tenant_id,
        botId: fromBot.id,
        peerBotId: target.id,
        kind,
        visibility: "visible",
        type: "handoff.queued",
        summary: "已排入佇列",
        fact,
        invocationId: invocation.requestId,
        createdAt: now,
      }))
    }

    this.insertEvent({
      handoffId,
      tenantId: principal.tenant_id,
      botId: target.id,
      peerBotId: fromBot.id,
      kind,
      visibility,
      type: "handoff.queued",
      summary: `來自 ${fromBot.name}`,
      fact,
      invocationId: invocation.requestId,
      createdAt: now,
    })

    if (visibility === "visible") this.markTargetUnread?.(target.id)

    return {
      handoffId,
      invocationId: invocation.requestId,
      state: queueState === "PENDING_APPROVAL" ? "PENDING_APPROVAL" : "ACKED",
      kind,
      visibility,
      fromBotId: fromBot.id,
      toBotId: target.id,
      fact,
      summary,
      async: true,
      processed: false,
      events: callerEvents,
      createdAt: now,
    }
  }

  /** Later processing — not same turn as create. Delivers fact to target. */
  processHandoff(principal: GenioPrincipal, handoffId: string): {
    handoffId: string
    processed: boolean
    state: string
    invocationId: string | null
    kind: HandoffKind
    events: BotHandoffEvent[]
  } {
    const row = this.db.query(
      "select * from bot_handoffs where handoff_id = ? and tenant_id = ? and caller_subject_id = ?",
    ).get(handoffId, principal.tenant_id, principal.subject_id) as Record<string, unknown> | null
    if (!row) throw new Error("HANDOFF_NOT_FOUND")
    if (Number(row.processed) === 1) {
      return {
        handoffId,
        processed: true,
        state: String(row.state),
        invocationId: typeof row.invocation_id === "string" ? row.invocation_id : null,
        kind: String(row.kind) === "fyi" ? "fyi" : "task",
        events: this.listEventsForHandoff(handoffId, principal),
      }
    }
    if (String(row.state) === "PENDING_APPROVAL") throw new Error("HANDOFF_PENDING_APPROVAL")

    const now = Date.now()
    const fact = String(row.fact)
    const kind = row.kind === "fyi" ? "fyi" as const : "task" as const
    const visibility = row.visibility === "silent" ? "silent" as const : "visible" as const
    const fromBotId = String(row.from_bot_id)
    const toBotId = String(row.to_bot_id)
    const invocationId = typeof row.invocation_id === "string" ? row.invocation_id : null

    this.db.query(
      "update bot_handoffs set processed = 1, state = 'DELIVERED', processed_at = ? where handoff_id = ?",
    ).run(now, handoffId)

    const delivered = this.insertEvent({
      handoffId,
      tenantId: principal.tenant_id,
      botId: toBotId,
      peerBotId: fromBotId,
      kind,
      visibility,
      type: "handoff.delivered",
      summary: "交接已送達",
      fact,
      invocationId,
      createdAt: now,
    })

    if (visibility === "visible") this.markTargetUnread?.(toBotId)

    return {
      handoffId,
      processed: true,
      state: "DELIVERED",
      invocationId,
      kind,
      events: [delivered],
    }
  }

  isSilentFyi(invocationId: string): boolean {
    return Boolean(this.db.query("select 1 from bot_handoffs where invocation_id = ? and kind = 'fyi' and visibility = 'silent'").get(invocationId))
  }

  kindForInvocation(invocationId: string): HandoffKind {
    const row = this.db.query("select kind from bot_handoffs where invocation_id = ?").get(invocationId) as { kind: string } | null
    return row?.kind === "fyi" ? "fyi" : "task"
  }

  recordCallerReply(principal: GenioPrincipal, handoffId: string, reply: string, failed = false): BotHandoffEvent | null {
    const row = this.db.query(
      "select * from bot_handoffs where handoff_id = ? and tenant_id = ? and caller_subject_id = ?",
    ).get(handoffId, principal.tenant_id, principal.subject_id) as Record<string, unknown> | null
    if (!row) return null
    const type = failed ? "handoff.failed" : row.kind === "fyi" ? "handoff.read" : "handoff.replied"
    const previous = this.db.query("select * from bot_handoff_events where handoff_id = ? and bot_id = ? and type = ? limit 1").get(handoffId, String(row.from_bot_id), type) as Record<string, unknown> | null
    if (previous) return this.mapEvent(previous)
    const kind = row.kind === "fyi" ? "fyi" as const : "task" as const
    const invocationId = typeof row.invocation_id === "string" ? row.invocation_id : null
    const event = this.insertEvent({
      handoffId,
      tenantId: principal.tenant_id,
      botId: String(row.from_bot_id),
      peerBotId: String(row.to_bot_id),
      kind,
      visibility: "visible",
      type,
      summary: failed ? "對方未完成交接工作" : kind === "fyi" ? "對方已讀取 FYI" : "對方已處理並回傳",
      fact: reply.slice(0, 8_192),
      invocationId,
      createdAt: Date.now(),
    })
    if (kind === "fyi" && !failed) this.insertEvent({
      handoffId, tenantId: principal.tenant_id, botId: String(row.to_bot_id), peerBotId: String(row.from_bot_id),
      kind, visibility: row.visibility === "silent" ? "silent" : "visible", type: "handoff.read",
      summary: "已讀取 FYI", fact: String(row.fact), invocationId, createdAt: Date.now(),
    })
    return event
  }

  recordInvocationOutcome(invocationId: string, state: string, summary: string) {
    if (!["COMPLETED", "FAILED", "DENIED", "EXPIRED"].includes(state)) return
    const rows = this.db.query("select handoff_id, tenant_id, caller_subject_id from bot_handoffs where invocation_id = ?").all(invocationId) as Array<{ handoff_id: string; tenant_id: string; caller_subject_id: string }>
    for (const row of rows) {
      this.recordCallerReply({ tenant_id: row.tenant_id, subject_id: row.caller_subject_id, acting_client_id: "genio-one-bot", scopes: [] }, row.handoff_id, summary, state !== "COMPLETED")
      this.db.query("update bot_handoffs set state = ? where handoff_id = ?").run(state, row.handoff_id)
    }
  }

  deliverInvocation(invocationId: string) {
    const rows = this.db.query("select handoff_id, tenant_id, caller_subject_id from bot_handoffs where invocation_id = ? and processed = 0").all(invocationId) as Array<{ handoff_id: string; tenant_id: string; caller_subject_id: string }>
    for (const row of rows) {
      this.db.query("update bot_handoffs set state = 'QUEUED' where handoff_id = ? and state = 'PENDING_APPROVAL'").run(row.handoff_id)
      this.processHandoff({ tenant_id: row.tenant_id, subject_id: row.caller_subject_id, acting_client_id: "genio-one-bot", scopes: [] }, row.handoff_id)
    }
  }

  listEventsForBot(principal: GenioPrincipal, botId: string, opts?: { includeSilent?: boolean }): BotHandoffEvent[] {
    const owned = this.getOwnedBot(botId, principal)
    if (!owned) throw new Error("BOT_NOT_FOUND")
    const rows = this.db.query(
      "select * from bot_handoff_events where tenant_id = ? and bot_id = ? order by rowid asc",
    ).all(principal.tenant_id, botId) as Record<string, unknown>[]
    const events = rows.map((row) => this.mapEvent(row))
    if (opts?.includeSilent) return events
    return events.filter((event) => event.visibility === "visible")
  }

  listEventsForHandoff(handoffId: string, principal: GenioPrincipal): BotHandoffEvent[] {
    const rows = this.db.query(
      "select * from bot_handoff_events where handoff_id = ? and tenant_id = ? order by rowid asc",
    ).all(handoffId, principal.tenant_id) as Record<string, unknown>[]
    return rows.map((row) => this.mapEvent(row))
  }

  getHandoff(principal: GenioPrincipal, handoffId: string) {
    const row = this.db.query(
      "select * from bot_handoffs where handoff_id = ? and tenant_id = ? and caller_subject_id = ?",
    ).get(handoffId, principal.tenant_id, principal.subject_id) as Record<string, unknown> | null
    if (!row) return null
    return {
      handoffId: String(row.handoff_id),
      fromBotId: String(row.from_bot_id),
      toBotId: String(row.to_bot_id),
      kind: row.kind === "fyi" ? "fyi" as const : "task" as const,
      visibility: row.visibility === "silent" ? "silent" as const : "visible" as const,
      fact: String(row.fact),
      summary: String(row.summary),
      invocationId: typeof row.invocation_id === "string" ? row.invocation_id : null,
      state: String(row.state),
      processed: Number(row.processed) === 1,
      createdAt: Number(row.created_at),
      processedAt: row.processed_at == null ? null : Number(row.processed_at),
    }
  }

  private insertSameOwnerInvocation(principal: GenioPrincipal, input: {
    callerBotId: string
    targetBotId: string
    targetOwnerSubjectId: string
    targetAgentSubjectId: string
    task: string
    actionDigest: string
  }): BotInvocationRequest {
    const now = Date.now()
    const requestId = `bot-invocation-${randomUUID()}`
    const expiresAt = now + 15 * 60 * 1000
    const state: BotInvocationState = "APPROVED"
    this.db.query(`insert into bot_invocations (
      request_id, tenant_id, caller_subject_id, caller_bot_id, target_owner_subject_id,
      target_bot_id, target_agent_subject_id, task, selected_context_json,
      requested_capabilities_json, action_digest, state, decision_reason, expires_at,
      created_at, decided_at, result_summary, artifact_refs_json
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      requestId,
      principal.tenant_id,
      principal.subject_id,
      input.callerBotId,
      input.targetOwnerSubjectId,
      input.targetBotId,
      input.targetAgentSubjectId,
      input.task.slice(0, 4096),
      JSON.stringify(["handoff-fact"]),
      JSON.stringify([]),
      input.actionDigest,
      state,
      "SAME_OWNER_HANDOFF",
      expiresAt,
      now,
      now,
      null,
      JSON.stringify([]),
    )
    return {
      requestId,
      tenantId: principal.tenant_id,
      callerSubjectId: principal.subject_id,
      callerBotId: input.callerBotId,
      targetOwnerSubjectId: input.targetOwnerSubjectId,
      targetBotId: input.targetBotId,
      targetAgentSubjectId: input.targetAgentSubjectId,
      task: input.task.slice(0, 4096),
      selectedContextRefs: ["handoff-fact"],
      requestedCapabilityIds: [],
      actionDigest: input.actionDigest,
      state,
      decisionReason: "SAME_OWNER_HANDOFF",
      expiresAt,
      createdAt: now,
      decidedAt: now,
      resultSummary: null,
      artifactRefs: [],
    }
  }

  private insertEvent(input: Omit<BotHandoffEvent, "eventId">): BotHandoffEvent {
    const eventId = `bot-handoff-event-${randomUUID()}`
    this.db.query(`insert into bot_handoff_events (
      event_id, handoff_id, tenant_id, bot_id, peer_bot_id, kind, visibility, type,
      summary, fact, invocation_id, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      eventId,
      input.handoffId,
      input.tenantId,
      input.botId,
      input.peerBotId,
      input.kind,
      input.visibility,
      input.type,
      input.summary,
      input.fact,
      input.invocationId,
      input.createdAt,
    )
    return { eventId, ...input }
  }

  private mapEvent(row: Record<string, unknown>): BotHandoffEvent {
    const handoff = this.db.query("select from_bot_id, to_bot_id, source_message_id, state from bot_handoffs where handoff_id = ?").get(String(row.handoff_id)) as { from_bot_id: string; to_bot_id: string; source_message_id: string | null; state: string } | null
    const names = handoff ? this.db.query("select id, name from bots where tenant_id = ? and id in (?, ?)").all(String(row.tenant_id), handoff.from_bot_id, handoff.to_bot_id) as Array<{ id: string; name: string }> : []
    return {
      fromName: names.find((bot) => bot.id === handoff?.from_bot_id)?.name,
      toName: names.find((bot) => bot.id === handoff?.to_bot_id)?.name,
      state: handoff?.state,
      sourceMessageId: handoff?.source_message_id ?? undefined,
      fromBotId: handoff?.from_bot_id,
      toBotId: handoff?.to_bot_id,
      eventId: String(row.event_id),
      handoffId: String(row.handoff_id),
      tenantId: String(row.tenant_id),
      botId: String(row.bot_id),
      peerBotId: String(row.peer_bot_id),
      kind: row.kind === "fyi" ? "fyi" : "task",
      visibility: row.visibility === "silent" ? "silent" : "visible",
      type: String(row.type) as HandoffEventType,
      summary: String(row.summary),
      fact: String(row.fact),
      invocationId: typeof row.invocation_id === "string" ? row.invocation_id : null,
      createdAt: Number(row.created_at),
    }
  }
}

export function projectHandoffMessages(
  events: BotHandoffEvent[],
  opts?: { includeSilent?: boolean },
): Array<{
  id: string
  role: "system"
  kind: "handoff"
  handoffEventType: HandoffEventType
  text: string
  visibility: HandoffVisibility
  createdAt: number
  handoffId: string
  peerBotId: string
}> {
  return events
    .filter((event) => opts?.includeSilent || event.visibility === "visible")
    .filter((event) =>
      event.type === "handoff.sent"
      || event.type === "handoff.acked"
      || event.type === "handoff.delivered"
      || event.type === "handoff.failed")
    .map((event) => ({
      id: event.eventId,
      role: "system" as const,
      kind: "handoff" as const,
      handoffEventType: event.type,
      text: handoffBubbleText(event),
      visibility: event.visibility,
      createdAt: event.createdAt,
      handoffId: event.handoffId,
      peerBotId: event.peerBotId,
    }))
}
