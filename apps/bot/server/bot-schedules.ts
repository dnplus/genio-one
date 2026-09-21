import { randomUUID } from "node:crypto"
import type { Database } from "bun:sqlite"
import { CronExpressionParser } from "cron-parser"
import type { GenioPrincipal } from "./runtime-broker"

export type BotScheduleSpec =
  | { kind: "once"; at: string }
  | { kind: "recurring"; frequency: "daily" | "weekly"; time: string; timezone: string; weekdays?: Array<"MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU"> }

export type BotScheduleRunState = "QUEUED" | "CLAIMED" | "STARTING" | "RUNNING" | "COMPLETED" | "AUTH_REQUIRED" | "BLOCKED" | "FAILED" | "UNCERTAIN"

export interface BotSchedule {
  id: string
  tenantId: string
  ownerSubjectId: string
  actingClientId: string
  botId: string
  prompt: string
  name: string
  schedule: BotScheduleSpec
  enabled: boolean
  revision: number
  nextRunAt: number | null
  createdAt: number
  updatedAt: number
}

export interface BotScheduleRun {
  id: string
  scheduleId: string
  tenantId: string
  ownerSubjectId: string
  actingClientId: string
  botId: string
  slotAt: number
  clientUserMessageId: string
  state: BotScheduleRunState
  attempts: number
  threadId: string | null
  turnId: string | null
  error: string | null
  createdAt: number
  updatedAt: number
}

export const BOT_SCHEDULE_RUN_LABELS: Record<BotScheduleRunState, string> = {
  QUEUED: "等待執行",
  CLAIMED: "準備執行",
  STARTING: "啟動中",
  RUNNING: "執行中",
  COMPLETED: "已完成",
  AUTH_REQUIRED: "需要重新登入",
  BLOCKED: "需要處理",
  FAILED: "執行失敗",
  UNCERTAIN: "等待核對執行結果",
}

const weekdays = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const
const weekdaySet = new Set<string>(weekdays)
const states = new Set<BotScheduleRunState>(["QUEUED", "CLAIMED", "STARTING", "RUNNING", "COMPLETED", "AUTH_REQUIRED", "BLOCKED", "FAILED", "UNCERTAIN"])

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T } catch { return fallback }
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null
}

function string(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= max ? value.trim() : null
}

function validTimezone(value: string) {
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true } catch { return false }
}

function parseTime(value: string) {
  const match = /^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(value)
  return match ? { hour: Number(value.slice(0, 2)), minute: Number(value.slice(3, 5)) } : null
}

export function validateBotScheduleSpec(value: unknown): BotScheduleSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("BOT_SCHEDULE_INVALID")
  const input = value as Record<string, unknown>
  if (input.kind === "once" && Object.keys(input).every((key) => key === "kind" || key === "at")) {
    const at = string(input.at, 64)
    const epoch = at && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(at) ? Date.parse(at) : NaN
    if (!at || !Number.isFinite(epoch)) throw new Error("BOT_SCHEDULE_ONCE_INVALID")
    return { kind: "once", at: new Date(epoch).toISOString() }
  }
  if (input.kind !== "recurring" || !Object.keys(input).every((key) => ["kind", "frequency", "time", "timezone", "weekdays"].includes(key))) throw new Error("BOT_SCHEDULE_INVALID")
  const frequency = input.frequency === "daily" || input.frequency === "weekly" ? input.frequency : null
  const time = string(input.time, 5)
  const timezone = string(input.timezone, 128)
  const suppliedWeekdays = input.weekdays
  if (!frequency || !time || !parseTime(time) || !timezone || !validTimezone(timezone)) throw new Error("BOT_SCHEDULE_RECURRING_INVALID")
  if (frequency === "daily" && suppliedWeekdays !== undefined) throw new Error("BOT_SCHEDULE_WEEKDAYS_INVALID")
  const days = Array.isArray(suppliedWeekdays) ? suppliedWeekdays : []
  if (frequency === "weekly" && (days.length < 1 || days.length > 7 || days.some((day) => typeof day !== "string" || !weekdaySet.has(day)) || new Set(days).size !== days.length)) throw new Error("BOT_SCHEDULE_WEEKDAYS_INVALID")
  return frequency === "weekly"
    ? { kind: "recurring", frequency, time, timezone, weekdays: days as Array<"MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU"> }
    : { kind: "recurring", frequency, time, timezone }
}

export function nextBotScheduleAt(spec: BotScheduleSpec, after: number): number | null {
  if (spec.kind === "once") {
    const at = Date.parse(spec.at)
    return at > after ? at : null
  }
  const desired = parseTime(spec.time)!
  const dayOfWeek = spec.frequency === "weekly"
    ? spec.weekdays!.map((day) => weekdays.indexOf(day)).join(",")
    : "*"
  try {
    return CronExpressionParser.parse(`${desired.minute} ${desired.hour} * * ${dayOfWeek}`, { currentDate: new Date(after), tz: spec.timezone }).next().toDate().getTime()
  } catch { return null }
}

function mapSchedule(row: Record<string, unknown>): BotSchedule {
  const stored = parseJson<Record<string, unknown>>(String(row.schedule_json), {})
  const prompt = String(row.prompt)
  return {
    id: String(row.id), tenantId: String(row.tenant_id), ownerSubjectId: String(row.owner_subject_id), actingClientId: String(row.acting_client_id), botId: String(row.bot_id), prompt, name: prompt.replace(/\s+/g, " ").slice(0, 60), schedule: validateBotScheduleSpec(stored.spec), enabled: Number(row.enabled) === 1, revision: Number(row.revision), nextRunAt: row.next_run_at === null ? null : Number(row.next_run_at), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  }
}

function mapRun(row: Record<string, unknown>): BotScheduleRun {
  const state = String(row.state) as BotScheduleRunState
  if (!states.has(state)) throw new Error("BOT_SCHEDULE_RUN_INVALID")
  return { id: String(row.id), scheduleId: String(row.schedule_id), tenantId: String(row.tenant_id), ownerSubjectId: String(row.owner_subject_id), actingClientId: String(row.acting_client_id), botId: String(row.bot_id), slotAt: Number(row.slot_at), clientUserMessageId: String(row.client_user_message_id), state, attempts: Number(row.attempts), threadId: typeof row.thread_id === "string" ? row.thread_id : null, turnId: typeof row.turn_id === "string" ? row.turn_id : null, error: typeof row.error === "string" ? row.error : null, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }
}

export class BotSchedules {
  constructor(private readonly db: Database, private readonly now: () => number = () => Date.now()) {
    db.exec(`create table if not exists bot_schedules (
      id text primary key, tenant_id text not null, owner_subject_id text not null, acting_client_id text not null, bot_id text not null,
      prompt text not null, schedule_json text not null, enabled integer not null, revision integer not null, next_run_at integer,
      created_at integer not null, updated_at integer not null
    ); create index if not exists bot_schedules_due on bot_schedules(enabled, next_run_at);
    create table if not exists bot_schedule_runs (
      id text primary key, schedule_id text not null, tenant_id text not null, owner_subject_id text not null, acting_client_id text not null, bot_id text not null,
      slot_at integer not null, client_user_message_id text not null, state text not null, attempts integer not null, thread_id text, turn_id text, error text,
      created_at integer not null, updated_at integer not null, unique(schedule_id, slot_at)
    ); create index if not exists bot_schedule_runs_ready on bot_schedule_runs(state, updated_at);
    create table if not exists bot_schedule_create_receipts (
      tenant_id text not null, owner_subject_id text not null, bot_id text not null, client_request_id text not null,
      payload_json text not null, schedule_id text not null, created_at integer not null,
      primary key (tenant_id, owner_subject_id, bot_id, client_request_id)
    )`)
  }

  create(principal: GenioPrincipal, botId: string, input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("BOT_SCHEDULE_INVALID")
    const value = input as Record<string, unknown>
    if (!Object.keys(value).every((key) => ["clientRequestId", "prompt", "schedule"].includes(key))) throw new Error("BOT_SCHEDULE_INVALID")
    const clientRequestId = string(value.clientRequestId, 128)
    const prompt = string(value.prompt, 8_000)
    if (!clientRequestId || !prompt) throw new Error("BOT_SCHEDULE_INVALID")
    const schedule = validateBotScheduleSpec(value.schedule)
    const payload = JSON.stringify({ prompt, schedule })
    const receipt = this.db.query("select payload_json, schedule_id from bot_schedule_create_receipts where tenant_id = ? and owner_subject_id = ? and bot_id = ? and client_request_id = ?").get(principal.tenant_id, principal.subject_id, botId, clientRequestId) as { payload_json: string; schedule_id: string } | null
    if (receipt) {
      if (receipt.payload_json !== payload) throw new Error("BOT_SCHEDULE_IDEMPOTENCY_CONFLICT")
      const existing = this.getById(receipt.schedule_id)
      return existing
        ? { schedule: existing, created: false }
        : { schedule: null, scheduleId: receipt.schedule_id, created: false, deleted: true }
    }
    const now = this.now()
    const nextRunAt = nextBotScheduleAt(schedule, now - 1)
    if (nextRunAt === null) throw new Error("BOT_SCHEDULE_TIME_IN_PAST")
    const id = randomUUID()
    const stored = JSON.stringify({ spec: schedule })
    this.db.transaction(() => {
      this.db.query("insert into bot_schedules (id, tenant_id, owner_subject_id, acting_client_id, bot_id, prompt, schedule_json, enabled, revision, next_run_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)")
        .run(id, principal.tenant_id, principal.subject_id, principal.acting_client_id, botId, prompt, stored, nextRunAt, now, now)
      this.db.query("insert into bot_schedule_create_receipts (tenant_id, owner_subject_id, bot_id, client_request_id, payload_json, schedule_id, created_at) values (?, ?, ?, ?, ?, ?, ?)")
        .run(principal.tenant_id, principal.subject_id, botId, clientRequestId, payload, id, now)
    })()
    return { schedule: this.getById(id)!, created: true }
  }

  list(principal: GenioPrincipal, botId: string) {
    return this.db.query("select * from bot_schedules where tenant_id = ? and owner_subject_id = ? and bot_id = ? order by created_at desc").all(principal.tenant_id, principal.subject_id, botId).map((row) => mapSchedule(row as Record<string, unknown>))
  }

  listActive() {
    return this.db.query("select * from bot_schedules where enabled = 1 and next_run_at is not null").all().map((row) => mapSchedule(row as Record<string, unknown>))
  }

  recoveryCandidates(limit = 100, offset = 0) {
    const safeLimit = Math.max(1, Math.min(100, limit))
    const safeOffset = Number.isSafeInteger(offset) && offset > 0 ? offset : 0
    return this.db.query("select * from bot_schedule_runs where state = 'UNCERTAIN' order by updated_at, id limit ? offset ?").all(safeLimit, safeOffset).map((row) => mapRun(row as Record<string, unknown>))
  }

  retainedOwnerPrincipals() {
    return this.db.query("select distinct tenant_id, owner_subject_id, acting_client_id from bot_schedule_runs where state in ('CLAIMED', 'STARTING', 'RUNNING', 'UNCERTAIN')").all().map((row) => {
      const value = row as Record<string, unknown>
      return { tenant_id: String(value.tenant_id), subject_id: String(value.owner_subject_id), acting_client_id: String(value.acting_client_id) }
    })
  }

  get(principal: GenioPrincipal, botId: string, scheduleId: string) {
    const row = this.db.query("select * from bot_schedules where id = ? and tenant_id = ? and owner_subject_id = ? and bot_id = ?").get(scheduleId, principal.tenant_id, principal.subject_id, botId) as Record<string, unknown> | null
    return row ? mapSchedule(row) : null
  }

  update(principal: GenioPrincipal, botId: string, scheduleId: string, input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("BOT_SCHEDULE_INVALID")
    const value = input as Record<string, unknown>
    if (!Object.keys(value).every((key) => ["expectedRevision", "prompt", "schedule", "enabled"].includes(key))) throw new Error("BOT_SCHEDULE_INVALID")
    const expectedRevision = integer(value.expectedRevision)
    const current = this.get(principal, botId, scheduleId)
    if (!current) throw new Error("BOT_SCHEDULE_NOT_FOUND")
    if (expectedRevision === null || expectedRevision !== current.revision) throw new Error("BOT_SCHEDULE_CHANGED")
    const prompt = value.prompt === undefined ? current.prompt : string(value.prompt, 8_000)
    const schedule = value.schedule === undefined ? current.schedule : validateBotScheduleSpec(value.schedule)
    const enabled = value.enabled === undefined ? current.enabled : value.enabled === true
    if (!prompt || (value.enabled !== undefined && typeof value.enabled !== "boolean")) throw new Error("BOT_SCHEDULE_INVALID")
    const now = this.now()
    const nextRunAt = enabled ? nextBotScheduleAt(schedule, now - 1) : null
    if (enabled && nextRunAt === null) throw new Error("BOT_SCHEDULE_TIME_IN_PAST")
    const storedRow = this.db.query("select schedule_json from bot_schedules where id = ?").get(scheduleId) as { schedule_json: string } | null
    const stored = parseJson<Record<string, unknown>>(storedRow?.schedule_json ?? "{}", {})
    const updated = this.db.query("update bot_schedules set prompt = ?, schedule_json = ?, enabled = ?, revision = revision + 1, next_run_at = ?, updated_at = ? where id = ? and revision = ?").run(prompt, JSON.stringify({ ...stored, spec: schedule }), enabled ? 1 : 0, nextRunAt, now, scheduleId, expectedRevision)
    if (updated.changes !== 1) throw new Error("BOT_SCHEDULE_CHANGED")
    return this.get(principal, botId, scheduleId)!
  }

  delete(principal: GenioPrincipal, botId: string, scheduleId: string, expectedRevision: unknown) {
    const revision = integer(expectedRevision)
    if (revision === null) throw new Error("BOT_SCHEDULE_INVALID")
    const deleted = this.db.query("delete from bot_schedules where id = ? and tenant_id = ? and owner_subject_id = ? and bot_id = ? and revision = ?").run(scheduleId, principal.tenant_id, principal.subject_id, botId, revision)
    if (deleted.changes !== 1) throw new Error("BOT_SCHEDULE_CHANGED")
    return { deleted: true, scheduleId }
  }

  cancelBot(principal: GenioPrincipal, botId: string) {
    const now = this.now()
    let schedules = 0
    let runs = 0
    this.db.transaction(() => {
      runs = this.db.query("update bot_schedule_runs set state = 'BLOCKED', error = 'BOT_DELETED', updated_at = ? where tenant_id = ? and owner_subject_id = ? and bot_id = ? and (state in ('QUEUED', 'AUTH_REQUIRED') or (state in ('CLAIMED', 'STARTING') and thread_id is null))")
        .run(now, principal.tenant_id, principal.subject_id, botId).changes
      schedules = this.db.query("delete from bot_schedules where tenant_id = ? and owner_subject_id = ? and bot_id = ?")
        .run(principal.tenant_id, principal.subject_id, botId).changes
    })()
    return { schedules, runs }
  }

  listRuns(principal: GenioPrincipal, botId: string, scheduleId?: string, limit = 50) {
    const safeLimit = Math.max(1, Math.min(100, limit))
    const rows = scheduleId
      ? this.db.query("select * from bot_schedule_runs where tenant_id = ? and owner_subject_id = ? and bot_id = ? and schedule_id = ? order by created_at desc limit ?").all(principal.tenant_id, principal.subject_id, botId, scheduleId, safeLimit)
      : this.db.query("select * from bot_schedule_runs where tenant_id = ? and owner_subject_id = ? and bot_id = ? order by created_at desc limit ?").all(principal.tenant_id, principal.subject_id, botId, safeLimit)
    return rows.map((row) => mapRun(row as Record<string, unknown>))
  }

  claimDue(limit = 20) {
    const now = this.now()
    const due = this.db.query("select * from bot_schedules where enabled = 1 and next_run_at is not null and next_run_at <= ? order by next_run_at limit ?").all(now, Math.max(1, Math.min(100, limit))) as Array<Record<string, unknown>>
    const runs: BotScheduleRun[] = []
    this.db.transaction(() => {
      for (const row of due) {
        const schedule = mapSchedule(row)
        const slotAt = schedule.nextRunAt!
        const nextRunAt = nextBotScheduleAt(schedule.schedule, now)
        const advanced = this.db.query("update bot_schedules set next_run_at = ?, revision = revision + 1, updated_at = ? where id = ? and enabled = 1 and next_run_at = ?").run(nextRunAt, now, schedule.id, slotAt)
        if (advanced.changes !== 1) continue
        const id = randomUUID()
        const clientUserMessageId = `schedule:${schedule.id}:${slotAt}`
        this.db.query("insert or ignore into bot_schedule_runs (id, schedule_id, tenant_id, owner_subject_id, acting_client_id, bot_id, slot_at, client_user_message_id, state, attempts, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', 0, ?, ?)")
          .run(id, schedule.id, schedule.tenantId, schedule.ownerSubjectId, schedule.actingClientId, schedule.botId, slotAt, clientUserMessageId, now, now)
        const created = this.db.query("select * from bot_schedule_runs where schedule_id = ? and slot_at = ?").get(schedule.id, slotAt) as Record<string, unknown>
        runs.push(mapRun(created))
      }
      this.coalescePendingRuns(now)
    })()
    return runs
  }

  claimRunnable(limit = 20) {
    const now = this.now()
    const claimed: BotScheduleRun[] = []
    this.db.transaction(() => {
      this.coalescePendingRuns(now)
      const candidates = this.db.query("select * from bot_schedule_runs where state = 'QUEUED' order by updated_at, created_at, id limit ?").all(Math.max(1, Math.min(100, limit))) as Array<Record<string, unknown>>
      for (const candidate of candidates) {
        const updated = this.db.query("update bot_schedule_runs set state = 'CLAIMED', attempts = attempts + 1, error = null, updated_at = ? where id = ? and state = 'QUEUED'").run(now, String(candidate.id))
        if (updated.changes === 1) claimed.push(this.getRun(String(candidate.id))!)
      }
    })()
    return claimed
  }

  markRun(id: string, state: BotScheduleRunState, input: { threadId?: string | null; turnId?: string | null; error?: string | null } = {}) {
    if (!states.has(state)) throw new Error("BOT_SCHEDULE_RUN_INVALID")
    const result = this.db.query("update bot_schedule_runs set state = ?, thread_id = coalesce(?, thread_id), turn_id = coalesce(?, turn_id), error = ?, updated_at = ? where id = ?").run(state, input.threadId ?? null, input.turnId ?? null, input.error ?? null, this.now(), id)
    if (result.changes !== 1) throw new Error("BOT_SCHEDULE_RUN_NOT_FOUND")
    return this.getRun(id)!
  }

  getRun(id: string) {
    const row = this.db.query("select * from bot_schedule_runs where id = ?").get(id) as Record<string, unknown> | null
    return row ? mapRun(row) : null
  }

  recoverInterrupted() {
    const now = this.now()
    this.db.query("update bot_schedule_runs set state = 'QUEUED', error = null, updated_at = ? where state in ('CLAIMED', 'STARTING') and thread_id is null").run(now)
    this.db.query("update bot_schedule_runs set state = 'UNCERTAIN', error = 'SCHEDULE_RECOVERY_REQUIRES_NATIVE_HISTORY', updated_at = ? where state in ('CLAIMED', 'STARTING', 'RUNNING') and thread_id is not null").run(now)
  }

  resumeAuthorized(principal: Pick<GenioPrincipal, "tenant_id" | "subject_id" | "acting_client_id">) {
    const now = this.now()
    const candidates = this.db.query("select id, schedule_id, slot_at, state from bot_schedule_runs where tenant_id = ? and owner_subject_id = ? and acting_client_id = ? and state in ('QUEUED', 'AUTH_REQUIRED') order by schedule_id, slot_at desc")
      .all(principal.tenant_id, principal.subject_id, principal.acting_client_id) as Array<{ id: string; schedule_id: string; slot_at: number; state: BotScheduleRunState }>
    const retained = new Set<string>()
    let changes = 0
    this.db.transaction(() => {
      for (const candidate of candidates) {
        if (!retained.has(candidate.schedule_id)) {
          retained.add(candidate.schedule_id)
          if (candidate.state === "AUTH_REQUIRED") changes += this.db.query("update bot_schedule_runs set state = 'QUEUED', error = null, updated_at = ? where id = ? and state = 'AUTH_REQUIRED'").run(now, candidate.id).changes
          continue
        }
        changes += this.db.query("update bot_schedule_runs set state = 'BLOCKED', error = 'SCHEDULE_SUPERSEDED', updated_at = ? where id = ? and state in ('QUEUED', 'AUTH_REQUIRED')").run(now, candidate.id).changes
      }
    })()
    return changes
  }

  private coalescePendingRuns(now: number) {
    const candidates = this.db.query("select id, schedule_id from bot_schedule_runs where state in ('QUEUED', 'AUTH_REQUIRED') order by schedule_id, slot_at desc")
      .all() as Array<{ id: string; schedule_id: string }>
    const retained = new Set<string>()
    for (const candidate of candidates) {
      if (!retained.has(candidate.schedule_id)) {
        retained.add(candidate.schedule_id)
        continue
      }
      this.db.query("update bot_schedule_runs set state = 'BLOCKED', error = 'SCHEDULE_SUPERSEDED', updated_at = ? where id = ? and state in ('QUEUED', 'AUTH_REQUIRED')")
        .run(now, candidate.id)
    }
  }

  private getById(id: string) {
    const row = this.db.query("select * from bot_schedules where id = ?").get(id) as Record<string, unknown> | null
    return row ? mapSchedule(row) : null
  }
}
