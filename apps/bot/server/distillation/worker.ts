import { hostname } from "node:os"

import {
  DISTILLATION_CLASSIFIER_VERSION,
  DISTILLATION_EXTRACTOR_VERSION,
  isDistillationTriage,
  type DistillationClassification,
} from "@genioone/protocol/distillation-triage"
import type { Database } from "bun:sqlite"

import type { BotRegistry } from "../bot-registry"
import type { Turn } from "../generated/v2/Turn"
import type { GenioPrincipal } from "../runtime-broker"
import { excerptFromTurn } from "./excerpt"
import type { DistillationBackfillResult } from "./backfill"
import { SQLiteDistillationBackfillProgressStore } from "./backfill-progress"
import { contentDigest, markerContentDigest, sourceRevision, turnReady } from "./history"
import {
  createHttpDistillationClassifier,
  createHttpDistillationPlatform,
  type DistillationClassifier,
  type DistillationCompletion,
  type DistillationPlatform,
} from "./platform"
import { emitDistillationDecision, type DistillationDecision } from "./span"

const RETRY_SECONDS = 30
const MAX_SUBMISSION_ATTEMPTS = 5
const MAX_HISTORY_EXHAUSTED_SCANS = 3
const CLASSIFIER_CACHE_VERSION = `${DISTILLATION_CLASSIFIER_VERSION}:${DISTILLATION_EXTRACTOR_VERSION}`
const MAX_DUE_BATCH = 8
const MAX_ACTIVE_CLAIM_BATCH = 8
const MAX_LOCAL_CLAIM_BATCH = 8
const MAX_IMPORTED_TURNS_PER_BOT = 1

type HistoryBackfillProgress = {
  exhaustedScans: number | null
  completeScan: boolean
}

type ClaimTargetEntry = {
  key: string
  target: DistillationClaimTarget
}

interface InboxRow {
  bot_id: string
  thread_id: string
  turn_id: string
  source_revision: string
  tenant_id: string
  owner_subject_id: string
  acting_client_id: string
  state: string
  attempts: number
  classifier_attempts: number
  classifier_triage: string | null
  classifier_source_revision: string | null
  classifier_content_digest: string | null
  classifier_version: string | null
  completion_lease_token: string | null
  completion_outcome: string | null
  completion_content_digest: string | null
  completion_error: string | null
  completion_thread_id: string | null
  completion_turn_ids: string | null
  history_exhausted_scans: number
  not_before: number
  marker_id: string | null
  workspace_id: string | null
}

export interface DistillationSessions {
  tokenFor(principal: Pick<GenioPrincipal, "tenant_id" | "subject_id" | "acting_client_id">, botId: string): string | null
  backfill?(input: {
    principal: Pick<GenioPrincipal, "tenant_id" | "subject_id" | "acting_client_id">
    botId: string
    threadId: string
    turnId: string
    turnIds?: readonly string[]
    progressKey?: string
  }): Promise<DistillationBackfillResult>
  claimTargets?(): readonly DistillationClaimTarget[]
}

export interface DistillationClaimTarget {
  principal: Pick<GenioPrincipal, "tenant_id" | "subject_id" | "acting_client_id">
  botId: string
}

export interface DistillationWorker {
  note(principal: GenioPrincipal, line: string): void
  historyImported(botId: string, threadId: string, turnIds: readonly string[]): void
  tick(now?: number): Promise<void>
  stop(): void
}

function ensureInbox(db: Database) {
  db.exec(`create table if not exists bot_distillation_inbox (
    bot_id text not null,
    thread_id text not null,
    turn_id text not null,
    source_revision text not null,
    tenant_id text not null,
    owner_subject_id text not null,
    acting_client_id text not null,
    state text not null,
    attempts integer not null,
    not_before integer not null,
    marker_id text,
    last_error text,
    classifier_attempts integer not null default 0,
    classifier_triage text,
    classifier_source_revision text,
    classifier_content_digest text,
    classifier_version text,
    completion_lease_token text,
    completion_outcome text,
    completion_content_digest text,
    completion_error text,
    completion_thread_id text,
    completion_turn_ids text,
    workspace_id text,
    history_exhausted_scans integer not null default 0,
    primary key (bot_id, thread_id, turn_id, source_revision)
  )`)
  const columns = db.query("pragma table_info(bot_distillation_inbox)").all() as Array<{ name: string }>
  for (const [name, definition] of [
    ["classifier_attempts", "integer not null default 0"],
    ["classifier_triage", "text"],
    ["classifier_source_revision", "text"],
    ["classifier_content_digest", "text"],
    ["classifier_version", "text"],
    ["completion_lease_token", "text"],
    ["completion_outcome", "text"],
    ["completion_content_digest", "text"],
    ["completion_error", "text"],
    ["completion_thread_id", "text"],
    ["completion_turn_ids", "text"],
    ["workspace_id", "text"],
    ["history_exhausted_scans", "integer not null default 0"],
  ]) {
    if (!columns.some((column) => column.name === name)) {
      db.exec(`alter table bot_distillation_inbox add column ${name} ${definition}`)
    }
  }
  db.exec("create index if not exists bot_distillation_inbox_due on bot_distillation_inbox (state, not_before)")
  db.exec("drop index if exists bot_distillation_inbox_submitted")
  db.exec("create index if not exists bot_distillation_inbox_marker on bot_distillation_inbox (marker_id)")
  db.exec(`create table if not exists bot_distillation_claim_cursor (
    singleton integer primary key check (singleton = 1),
    last_target_key text not null
  )`)
  db.exec(`create table if not exists bot_distillation_local_claim_cursor (
    scope text primary key,
    last_target_key text not null
  )`)
}

function platformFailureIsRecoverable(error: unknown): boolean {
  if (!(error instanceof Error)) return true
  const status = Number(/^DISTILLATION_PLATFORM_(\d+)$/.exec(error.message)?.[1])
  if (!Number.isInteger(status)) return true
  return status === 401 || status >= 500 || status === 408 || status === 429
}

export function createDistillationWorker(input: {
  registry: BotRegistry
  sessions: DistillationSessions
  platform: DistillationPlatform
  classifier: DistillationClassifier
  leaseOwner?: string
  now?: () => number
}): DistillationWorker {
  const db = input.registry.db
  ensureInbox(db)
  const backfillProgress = new SQLiteDistillationBackfillProgressStore(db)
  const now = input.now ?? (() => Math.floor(Date.now() / 1000))
  const leaseOwner = input.leaseOwner ?? `${hostname()}:${process.pid}`
  const due = db.query(`select bot_id, thread_id, turn_id, source_revision, tenant_id, owner_subject_id,
      acting_client_id, state, attempts, classifier_attempts, classifier_triage, classifier_source_revision,
      classifier_content_digest, classifier_version, completion_lease_token, completion_outcome,
      completion_content_digest, completion_error, completion_thread_id, completion_turn_ids,
      history_exhausted_scans, not_before, marker_id, workspace_id
    from bot_distillation_inbox
    where state in ('PENDING', 'WAITING_HISTORY') and marker_id is null and not_before <= ?
    order by not_before, rowid limit ?`)
  const requeueableTerminal = db.query(`select bot_id, thread_id, turn_id, source_revision, tenant_id, owner_subject_id, acting_client_id, workspace_id
    from bot_distillation_inbox
    where bot_id = ? and thread_id = ? and turn_id = ? and (
      state in ('UNRELATED', 'CANDIDATE')
      or (state = 'FAILED' and last_error = 'DISTILLATION_HISTORY_NOT_FOUND')
    )
    order by rowid desc limit 1`)
  const untrackedReady = db.query(`select t.thread_id, t.turn_id, t.body_json, t.revision
    from bot_timeline_turns t
    join bot_session_threads s on s.bot_id = t.bot_id and s.thread_id = t.thread_id
    where t.bot_id = ?
      and json_extract(t.body_json, '$.status') in ('completed', 'failed', 'interrupted')
      and coalesce(json_extract(t.body_json, '$.itemsView'), '') not in ('summary', 'notLoaded')
      and (
        json_extract(t.body_json, '$.status') != 'completed'
        or coalesce(json_array_length(t.body_json, '$.items'), 0) > 0
      )
      and not exists (
        select 1 from bot_distillation_inbox i
        where i.bot_id = t.bot_id and i.thread_id = t.thread_id and i.turn_id = t.turn_id
      )
    order by t.first_seen_at, t.rowid limit ?`)
  const activeClaimCursor = db.query("select last_target_key from bot_distillation_claim_cursor where singleton = 1")
  const saveActiveClaimCursor = db.query(`insert into bot_distillation_claim_cursor (singleton, last_target_key)
    values (1, ?) on conflict(singleton) do update set last_target_key = excluded.last_target_key`)
  const localClaimCursor = db.query("select last_target_key from bot_distillation_local_claim_cursor where scope = ?")
  const saveLocalClaimCursor = db.query(`insert into bot_distillation_local_claim_cursor (scope, last_target_key)
    values (?, ?) on conflict(scope) do update set last_target_key = excluded.last_target_key`)
  const localTargetsAfter = db.query(`select i.* from bot_distillation_inbox i
    join (
      select min(l.rowid) as row_id from bot_distillation_inbox l
      where l.marker_id is not null and l.state in ('SUBMITTED', 'WAITING_HISTORY')
        and (l.tenant_id || char(0) || l.owner_subject_id || char(0) || l.acting_client_id || char(0) || l.bot_id) > ?
        and (
          (? = 'completion' and l.completion_lease_token is not null)
          or (
            ? = 'claim' and l.completion_lease_token is null and not exists (
              select 1 from bot_distillation_inbox c
              where c.marker_id is not null and c.state in ('SUBMITTED', 'WAITING_HISTORY')
                and c.completion_lease_token is not null
                and c.tenant_id = l.tenant_id and c.owner_subject_id = l.owner_subject_id
                and c.acting_client_id = l.acting_client_id and c.bot_id = l.bot_id
            )
          )
        )
      group by l.tenant_id, l.owner_subject_id, l.acting_client_id, l.bot_id
    ) picked on picked.row_id = i.rowid
    order by i.tenant_id || char(0) || i.owner_subject_id || char(0) || i.acting_client_id || char(0) || i.bot_id
    limit ?`)
  const localTargetsBefore = db.query(`select i.* from bot_distillation_inbox i
    join (
      select min(l.rowid) as row_id from bot_distillation_inbox l
      where l.marker_id is not null and l.state in ('SUBMITTED', 'WAITING_HISTORY')
        and (l.tenant_id || char(0) || l.owner_subject_id || char(0) || l.acting_client_id || char(0) || l.bot_id) <= ?
        and (
          (? = 'completion' and l.completion_lease_token is not null)
          or (
            ? = 'claim' and l.completion_lease_token is null and not exists (
              select 1 from bot_distillation_inbox c
              where c.marker_id is not null and c.state in ('SUBMITTED', 'WAITING_HISTORY')
                and c.completion_lease_token is not null
                and c.tenant_id = l.tenant_id and c.owner_subject_id = l.owner_subject_id
                and c.acting_client_id = l.acting_client_id and c.bot_id = l.bot_id
            )
          )
        )
      group by l.tenant_id, l.owner_subject_id, l.acting_client_id, l.bot_id
    ) picked on picked.row_id = i.rowid
    order by i.tenant_id || char(0) || i.owner_subject_id || char(0) || i.acting_client_id || char(0) || i.bot_id
    limit ?`)
  const hasLocalTarget = db.query(`select 1 from bot_distillation_inbox
    where marker_id is not null and state in ('SUBMITTED', 'WAITING_HISTORY')
      and tenant_id = ? and owner_subject_id = ? and bot_id = ?
    limit 1`)
  const localMarkerRow = db.query(`select * from bot_distillation_inbox
    where marker_id = ? and tenant_id = ? and owner_subject_id = ? and acting_client_id = ? and bot_id = ?
    order by rowid limit 1`)
  const update = db.query(`update bot_distillation_inbox
    set state = ?, attempts = ?, classifier_attempts = ?, not_before = ?, marker_id = ?, last_error = ?
    where bot_id = ? and thread_id = ? and turn_id = ? and source_revision = ?`)
  const enqueue = db.query(`insert or ignore into bot_distillation_inbox
    (bot_id, thread_id, turn_id, source_revision, tenant_id, owner_subject_id, acting_client_id, state, attempts, not_before, marker_id, last_error, workspace_id)
    values (?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, null, null, ?)`)
  const recordClaimedCandidate = db.query(`insert into bot_distillation_inbox
    (bot_id, thread_id, turn_id, source_revision, tenant_id, owner_subject_id, acting_client_id, state, attempts, not_before, marker_id, last_error, workspace_id)
    values (?, ?, ?, ?, ?, ?, ?, 'CANDIDATE', 0, ?, ?, null, ?)
    on conflict(bot_id, thread_id, turn_id, source_revision) do update set
      state = 'CANDIDATE', marker_id = excluded.marker_id, last_error = null, workspace_id = excluded.workspace_id`)
  const retarget = db.query(`update bot_distillation_inbox
    set source_revision = ?, classifier_triage = null, classifier_source_revision = null,
      classifier_content_digest = null, classifier_version = null, history_exhausted_scans = 0
    where bot_id = ? and thread_id = ? and turn_id = ? and source_revision = ?`)
  const revisionExists = db.query(`select 1 as present from bot_distillation_inbox
    where bot_id = ? and thread_id = ? and turn_id = ? and source_revision = ?`)
  const removeRevision = db.query(`delete from bot_distillation_inbox
    where bot_id = ? and thread_id = ? and turn_id = ? and source_revision = ?`)
  const cacheClassifier = db.query(`update bot_distillation_inbox
    set classifier_triage = ?, classifier_source_revision = ?, classifier_content_digest = ?, classifier_version = ?
    where bot_id = ? and thread_id = ? and turn_id = ? and source_revision = ?`)
  const clearClassifier = db.query(`update bot_distillation_inbox
    set classifier_triage = null, classifier_source_revision = null, classifier_content_digest = null, classifier_version = null
    where bot_id = ? and thread_id = ? and turn_id = ? and source_revision = ?`)
  const persistCompletion = db.query(`update bot_distillation_inbox
    set completion_lease_token = ?, completion_outcome = ?, completion_content_digest = ?, completion_error = ?,
      completion_thread_id = ?, completion_turn_ids = ?
    where bot_id = ? and thread_id = ? and turn_id = ? and source_revision = ?`)
  const clearCompletion = db.query(`update bot_distillation_inbox
    set completion_lease_token = null, completion_outcome = null, completion_content_digest = null, completion_error = null,
      completion_thread_id = null, completion_turn_ids = null
    where bot_id = ? and thread_id = ? and turn_id = ? and source_revision = ?`)
  const updateHistoryExhaustedScans = db.query(`update bot_distillation_inbox set history_exhausted_scans = ?
    where bot_id = ? and thread_id = ? and turn_id = ? and source_revision = ?`)
  const ownedBot = db.query("select 1 from bots where id = ? and tenant_id = ? and owner_subject_id = ? and archived = 0 limit 1")

  function ownsBot(
    botId: string,
    principal: Pick<GenioPrincipal, "tenant_id" | "subject_id" | "acting_client_id">,
  ) {
    return Boolean(ownedBot.get(botId, principal.tenant_id, principal.subject_id))
  }

  async function reconcileSettledMarker(token: string, row: InboxRow, at: number) {
    // An empty claim can mean the Platform just settled this marker (for example
    // attempts exhausted by abandoned leases); without a status lookup the
    // SUBMITTED row would remain a claim target forever.
    if (!row.marker_id || !input.platform.marker) return
    const status = await input.platform.marker(token, row.tenant_id, row.marker_id).catch(() => null)
    if (!status || !ownsRow(row)) return
    const localState = status.processing_state === "CANDIDATE_CREATED" ? "CANDIDATE"
      : status.processing_state === "FILTERED_OUT" ? "UNRELATED"
        : status.processing_state === "FAILED" ? "FAILED"
          : null
    if (!localState) return
    save(row, {
      state: localState,
      marker_id: row.marker_id,
      last_error: localState === "FAILED" ? status.last_error ?? "DISTILLATION_PLATFORM_FAILED" : null,
    })
    enqueueChangedRevision(row, at)
  }

  function ownsRow(row: Pick<InboxRow, "bot_id" | "tenant_id" | "owner_subject_id" | "acting_client_id">) {
    return ownsBot(row.bot_id, {
      tenant_id: row.tenant_id,
      subject_id: row.owner_subject_id,
      acting_client_id: row.acting_client_id,
    })
  }

  function adoptRevision(row: InboxRow, nextRevision: string): InboxRow | null {
    if (nextRevision === row.source_revision) return row
    if (revisionExists.get(row.bot_id, row.thread_id, row.turn_id, nextRevision)) {
      removeRevision.run(row.bot_id, row.thread_id, row.turn_id, row.source_revision)
      return null
    }
    retarget.run(nextRevision, row.bot_id, row.thread_id, row.turn_id, row.source_revision)
    return {
      ...row,
      source_revision: nextRevision,
      classifier_triage: null,
      classifier_source_revision: null,
      classifier_content_digest: null,
      classifier_version: null,
    }
  }

  function cachedTriage(row: InboxRow, digest: string): DistillationClassification | null {
    if (
      !row.classifier_triage ||
      row.classifier_source_revision !== row.source_revision ||
      row.classifier_content_digest !== digest ||
      row.classifier_version !== CLASSIFIER_CACHE_VERSION
    ) return null
    try {
      const value: unknown = JSON.parse(row.classifier_triage)
      return isDistillationTriage(value) && value.status === "CLASSIFIED" ? value : null
    } catch {
      return null
    }
  }

  function saveClassifier(row: InboxRow, digest: string, triage: DistillationClassification) {
    cacheClassifier.run(
      JSON.stringify(triage),
      row.source_revision,
      digest,
      CLASSIFIER_CACHE_VERSION,
      row.bot_id,
      row.thread_id,
      row.turn_id,
      row.source_revision,
    )
  }

  function discardClassifier(row: InboxRow) {
    clearClassifier.run(row.bot_id, row.thread_id, row.turn_id, row.source_revision)
  }

  function completionFor(row: InboxRow): DistillationCompletion | null {
    if (!row.completion_lease_token) return null
    if (row.completion_outcome === "CANDIDATE_CREATED" && row.completion_content_digest) {
      return {
        lease_token: row.completion_lease_token,
        outcome: "CANDIDATE_CREATED",
        content_digest: row.completion_content_digest,
      }
    }
    if (
      (row.completion_outcome === "WAITING_FOR_HISTORY" || row.completion_outcome === "FAILED") &&
      row.completion_error
    ) {
      return {
        lease_token: row.completion_lease_token,
        outcome: row.completion_outcome,
        error: row.completion_error,
      }
    }
    return null
  }

  function saveCompletion(
    row: InboxRow,
    completion: DistillationCompletion,
    markerContext?: { threadId: string; turnIds: readonly string[] },
  ) {
    persistCompletion.run(
      completion.lease_token,
      completion.outcome,
      completion.content_digest ?? null,
      completion.error ?? null,
      markerContext?.threadId ?? null,
      markerContext ? JSON.stringify(markerContext.turnIds) : null,
      row.bot_id,
      row.thread_id,
      row.turn_id,
      row.source_revision,
    )
  }

  function discardCompletion(row: InboxRow) {
    clearCompletion.run(row.bot_id, row.thread_id, row.turn_id, row.source_revision)
  }

  function completionContextFor(row: InboxRow): { threadId: string; turnIds: string[] } | undefined {
    if (!row.completion_thread_id || !row.completion_turn_ids) return undefined
    try {
      const turnIds: unknown = JSON.parse(row.completion_turn_ids)
      if (!Array.isArray(turnIds) || turnIds.length === 0 || !turnIds.every((turnId) => typeof turnId === "string" && turnId)) return undefined
      return { threadId: row.completion_thread_id, turnIds }
    } catch {
      return undefined
    }
  }

  function enqueueChangedRevision(
    row: InboxRow,
    at: number,
    acceptedDigest?: string,
    markerContext: { threadId: string; turnIds: readonly string[] } = { threadId: row.thread_id, turnIds: [row.turn_id] },
  ) {
    const refreshed = input.registry.timeline.storedTurn(row.bot_id, row.thread_id, row.turn_id)
    if (!refreshed) return
    const refreshedRevision = sourceRevision(row.turn_id, refreshed.revision)
    if (refreshedRevision === row.source_revision) return
    if (acceptedDigest) {
      const storedTurns = markerContext.turnIds.map((turnId) =>
        input.registry.timeline.storedTurn(row.bot_id, markerContext.threadId, turnId),
      )
      if (storedTurns.length > 0 && storedTurns.every((stored) => stored && turnReady(stored.turn))) {
        const digest = markerContentDigest(storedTurns.map((stored) => stored!.bodyJson))
        if (digest === acceptedDigest) return
      }
    }
    enqueue.run(
      row.bot_id,
      row.thread_id,
      row.turn_id,
      refreshedRevision,
      row.tenant_id,
      row.owner_subject_id,
      row.acting_client_id,
      at,
      row.workspace_id,
    )
  }

  function completeInboxRow(
    row: InboxRow,
    completion: DistillationCompletion,
    at: number,
    markerContext?: { threadId: string; turnIds: readonly string[] },
  ) {
    if (completion.outcome === "CANDIDATE_CREATED") {
      save(row, { state: "CANDIDATE", marker_id: row.marker_id, last_error: null })
      enqueueChangedRevision(row, at, completion.content_digest, markerContext)
    } else if (completion.outcome === "WAITING_FOR_HISTORY") {
      save(row, { state: "WAITING_HISTORY", marker_id: row.marker_id, not_before: at + RETRY_SECONDS, last_error: "WAITING_FOR_HISTORY" })
    } else {
      const error = completion.error ?? "SOURCE_REVISION_CHANGED"
      save(row, { state: "FAILED", marker_id: row.marker_id, last_error: error })
      if (error === "SOURCE_REVISION_CHANGED" || error === "DISTILLATION_HISTORY_NOT_FOUND") enqueueChangedRevision(row, at)
    }
    discardCompletion(row)
  }

  async function backfillClaimedTurns(
    principal: Pick<GenioPrincipal, "tenant_id" | "subject_id" | "acting_client_id">,
    botId: string,
    threadId: string,
    turnIds: readonly string[],
    progressKey = turnIds[0],
  ): Promise<HistoryBackfillProgress> {
    if (!input.sessions.backfill || !progressKey) return { exhaustedScans: null, completeScan: false }
    if (!ownsBot(botId, principal)) return { exhaustedScans: null, completeScan: false }
    const unresolved = turnIds.filter((turnId) => {
      const stored = input.registry.timeline.storedTurn(botId, threadId, turnId)
      return !stored || !turnReady(stored.turn)
    })
    if (unresolved.length === 0) return { exhaustedScans: 0, completeScan: false }
    const result = await input.sessions.backfill({
      principal,
      botId,
      threadId,
      turnId: unresolved[0]!,
      turnIds,
      progressKey,
    }).catch(() => ({ status: "TRANSIENT_FAILURE" as const, exhaustedScans: 0 }))
    const stillUnresolved = turnIds.some((turnId) => {
      const stored = input.registry.timeline.storedTurn(botId, threadId, turnId)
      return !stored || !turnReady(stored.turn)
    })
    if (!stillUnresolved) return { exhaustedScans: 0, completeScan: false }
    return {
      exhaustedScans: result.exhaustedScans,
      completeScan: result.status === "EXHAUSTED",
    }
  }

  function saveHistoryExhaustedScans(row: InboxRow, exhaustedScans: number | null) {
    if (exhaustedScans === null) return
    updateHistoryExhaustedScans.run(exhaustedScans, row.bot_id, row.thread_id, row.turn_id, row.source_revision)
  }

  function persistedHistoryExhaustedScans(botId: string, threadId: string, progressKey: string | undefined) {
    if (!progressKey) return 0
    return backfillProgress.forTurn(botId, threadId, progressKey).exhaustedScans()
  }

  function save(row: InboxRow, patch: Partial<Pick<InboxRow, "state" | "attempts" | "classifier_attempts" | "not_before" | "marker_id">> & { last_error?: string | null }) {
    update.run(
      patch.state ?? row.state,
      patch.attempts ?? row.attempts,
      patch.classifier_attempts ?? row.classifier_attempts,
      patch.not_before ?? row.not_before,
      patch.marker_id === undefined ? row.marker_id : patch.marker_id,
      patch.last_error ?? null,
      row.bot_id,
      row.thread_id,
      row.turn_id,
      row.source_revision,
    )
  }

  function waitForHistory(row: InboxRow, at: number) {
    save(row, { state: "WAITING_HISTORY", not_before: at + RETRY_SECONDS, last_error: "WAITING_FOR_HISTORY" })
  }

  function emitDecision(row: InboxRow, decision: Omit<DistillationDecision, "tenantId" | "botId" | "threadId" | "turnId">) {
    emitDistillationDecision({ tenantId: row.tenant_id, botId: row.bot_id, threadId: row.thread_id, turnId: row.turn_id, ...decision })
  }

  function markUnrelated(row: InboxRow, decision: Pick<DistillationDecision, "scope" | "sensitivity" | "classifierVersion">) {
    save(row, { state: "UNRELATED", last_error: null })
    emitDecision(row, { relevant: false, ...decision, outcome: "unrelated" })
  }

  function claimTargetKey(target: DistillationClaimTarget) {
    return `${target.principal.tenant_id}\u0000${target.principal.subject_id}\u0000${target.principal.acting_client_id}\u0000${target.botId}`
  }

  function targetForRow(row: Pick<InboxRow, "tenant_id" | "owner_subject_id" | "acting_client_id" | "bot_id">): DistillationClaimTarget {
    return {
      principal: { tenant_id: row.tenant_id, subject_id: row.owner_subject_id, acting_client_id: row.acting_client_id },
      botId: row.bot_id,
    }
  }

  function nextLocalClaimRows(scope: "completion" | "claim", limit = MAX_LOCAL_CLAIM_BATCH): InboxRow[] {
    const cursor = localClaimCursor.get(scope) as { last_target_key?: string } | null
    const lastTargetKey = cursor?.last_target_key
    const rows = localTargetsAfter.all(lastTargetKey ?? "", scope, scope, limit) as InboxRow[]
    if (typeof lastTargetKey === "string" && rows.length < limit) {
      rows.push(...localTargetsBefore.all(lastTargetKey, scope, scope, limit - rows.length) as InboxRow[])
    }
    if (rows.length > 0) saveLocalClaimCursor.run(scope, claimTargetKey(targetForRow(rows.at(-1)!)))
    return rows
  }

  function nextActiveClaimTargets(): ClaimTargetEntry[] {
    const unique = new Map<string, DistillationClaimTarget>()
    for (const target of input.sessions.claimTargets?.() ?? []) {
      if (!ownsBot(target.botId, target.principal)) continue
      const key = claimTargetKey(target)
      if (!unique.has(key)) unique.set(key, target)
    }
    const targets = [...unique].map(([key, target]) => ({ key, target })).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
    if (targets.length === 0) return []
    const cursor = activeClaimCursor.get() as { last_target_key?: string } | null
    const lastTargetKey = cursor?.last_target_key
    const start = typeof lastTargetKey === "string"
      ? Math.max(0, targets.findIndex((entry) => entry.key > lastTargetKey))
      : 0
    const selected = Array.from({ length: Math.min(MAX_ACTIVE_CLAIM_BATCH, targets.length) }, (_, index) =>
      targets[(start + index) % targets.length]!,
    )
    saveActiveClaimCursor.run(selected.at(-1)!.key)
    return selected
  }

  function enqueueFirstSeenImportedTurns(targets: readonly ClaimTargetEntry[]) {
    for (const { target } of targets) {
      const principal = { ...target.principal, scopes: [] }
      for (const row of untrackedReady.all(target.botId, MAX_IMPORTED_TURNS_PER_BOT) as Array<{ thread_id: string; turn_id: string; body_json: string; revision: number }>) {
        let turn: Turn
        try { turn = JSON.parse(row.body_json) as Turn } catch { continue }
        if (!turnReady(turn) || !input.registry.ownsThread(principal, target.botId, row.thread_id)) continue
        enqueue.run(
          target.botId,
          row.thread_id,
          row.turn_id,
          sourceRevision(row.turn_id, Number(row.revision)),
          target.principal.tenant_id,
          target.principal.subject_id,
          target.principal.acting_client_id,
          now(),
          null,
        )
      }
    }
  }

  function recordClaimedTurnCandidate(
    target: DistillationClaimTarget,
    markerId: string,
    threadId: string,
    turnId: string,
    revision: number,
    at: number,
    workspaceId: string | null,
  ) {
    recordClaimedCandidate.run(
      target.botId,
      threadId,
      turnId,
      sourceRevision(turnId, revision),
      target.principal.tenant_id,
      target.principal.subject_id,
      target.principal.acting_client_id,
      at,
      markerId,
      workspaceId,
    )
  }

  function enqueueChangedClaimedRevisions(
    target: DistillationClaimTarget,
    threadId: string,
    turnIds: readonly string[],
    sourceTurns: readonly { revision: number }[],
    acceptedDigest: string,
    at: number,
    workspaceId: string | null,
  ) {
    const refreshedTurns = turnIds.map((turnId) => input.registry.timeline.storedTurn(target.botId, threadId, turnId))
    if (
      refreshedTurns.length > 0 &&
      refreshedTurns.every((stored) => stored && turnReady(stored.turn)) &&
      markerContentDigest(refreshedTurns.map((stored) => stored!.bodyJson)) === acceptedDigest
    ) return
    for (const [index, sourceTurn] of sourceTurns.entries()) {
      const turnId = turnIds[index]
      const refreshed = refreshedTurns[index]
      if (!turnId || !refreshed || sourceRevision(turnId, refreshed.revision) === sourceRevision(turnId, sourceTurn.revision)) continue
      enqueue.run(
        target.botId,
        threadId,
        turnId,
        sourceRevision(turnId, refreshed.revision),
        target.principal.tenant_id,
        target.principal.subject_id,
        target.principal.acting_client_id,
        at,
        workspaceId,
      )
    }
  }

  function completeLinkedCandidate(
    row: InboxRow,
    target: DistillationClaimTarget,
    markerId: string,
    completion: DistillationCompletion,
    at: number,
    markerContext: { threadId: string; turnIds: readonly string[] },
    sourceTurns: readonly { revision: number; bodyJson: string; turn: Turn }[] | null,
    workspaceId: string | null,
  ) {
    completeInboxRow(row, completion, at, markerContext)
    if (completion.outcome !== "CANDIDATE_CREATED" || !completion.content_digest) return
    if (!sourceTurns) {
      for (const turnId of markerContext.turnIds) {
        if (turnId === row.turn_id) continue
        const refreshed = input.registry.timeline.storedTurn(target.botId, markerContext.threadId, turnId)
        if (!refreshed) continue
        enqueue.run(
          target.botId,
          markerContext.threadId,
          turnId,
          sourceRevision(turnId, refreshed.revision),
          target.principal.tenant_id,
          target.principal.subject_id,
          target.principal.acting_client_id,
          at,
          workspaceId,
        )
      }
      return
    }
    if (markerContentDigest(sourceTurns.map((stored) => stored.bodyJson)) !== completion.content_digest) {
      for (const [index, sourceTurn] of sourceTurns.entries()) {
        const turnId = markerContext.turnIds[index]
        if (!turnId || turnId === row.turn_id) continue
        enqueue.run(
          target.botId,
          markerContext.threadId,
          turnId,
          sourceRevision(turnId, sourceTurn.revision),
          target.principal.tenant_id,
          target.principal.subject_id,
          target.principal.acting_client_id,
          at,
          workspaceId,
        )
      }
      return
    }
    for (const [index, sourceTurn] of sourceTurns.entries()) {
      const turnId = markerContext.turnIds[index]
      if (turnId && turnId !== row.turn_id) {
        recordClaimedTurnCandidate(target, markerId, markerContext.threadId, turnId, sourceTurn.revision, at, workspaceId)
      }
    }
    enqueueChangedClaimedRevisions(
      target,
      markerContext.threadId,
      markerContext.turnIds,
      sourceTurns,
      completion.content_digest,
      at,
      workspaceId,
    )
  }

  let ticking = false
  return {
    note(principal, line) {
      let message: { method?: string; params?: { threadId?: unknown; turn?: { id?: unknown } } }
      try { message = JSON.parse(line) } catch { return }
      if (message.method !== "turn/completed") return
      const threadId = message.params?.threadId
      const turnId = message.params?.turn?.id
      if (typeof threadId !== "string" || typeof turnId !== "string") return
      const botId = input.registry.ownedBotForThread(principal, threadId)
      if (!botId) return
      const stored = input.registry.timeline.storedTurn(botId, threadId, turnId)
      if (!stored) return
      enqueue.run(
        botId,
        threadId,
        turnId,
        sourceRevision(turnId, stored.revision),
        principal.tenant_id,
        principal.subject_id,
        principal.acting_client_id,
        now(),
        input.registry.teamWorkspaceId(botId),
      )
    },
    historyImported(botId, threadId, turnIds) {
      for (const turnId of new Set(turnIds)) {
        const stored = input.registry.timeline.storedTurn(botId, threadId, turnId)
        if (!stored) continue
        const nextRevision = sourceRevision(turnId, stored.revision)
        for (const row of requeueableTerminal.all(botId, threadId, turnId) as Array<Pick<InboxRow, "bot_id" | "thread_id" | "turn_id" | "source_revision" | "tenant_id" | "owner_subject_id" | "acting_client_id" | "workspace_id">>) {
          if (!ownsRow(row) || row.source_revision === nextRevision) continue
          enqueue.run(
            row.bot_id,
            row.thread_id,
            row.turn_id,
            nextRevision,
            row.tenant_id,
            row.owner_subject_id,
            row.acting_client_id,
            now(),
            row.workspace_id,
          )
        }
      }
    },
    async tick(at = now()) {
      if (ticking) return
      ticking = true
      try {
      const activeClaimTargets = nextActiveClaimTargets()
      enqueueFirstSeenImportedTurns(activeClaimTargets)
      for (const queued of due.all(at, MAX_DUE_BATCH) as InboxRow[]) {
        let row = queued
        if (!ownsRow(row)) continue
        let stored = input.registry.timeline.storedTurn(row.bot_id, row.thread_id, row.turn_id)
        if (!stored) {
          save(row, { state: "FAILED", last_error: "SOURCE_REVISION_CHANGED" })
          continue
        }
        const adopted = adoptRevision(row, sourceRevision(row.turn_id, stored.revision))
        if (!adopted) continue
        row = adopted
        let ready = turnReady(stored.turn)
        if (!ready && input.sessions.backfill) {
          const principal = { tenant_id: row.tenant_id, subject_id: row.owner_subject_id, acting_client_id: row.acting_client_id }
          const historyProgress = await backfillClaimedTurns(principal, row.bot_id, row.thread_id, [row.turn_id])
          saveHistoryExhaustedScans(row, historyProgress.exhaustedScans)
          if (!ownsRow(row)) continue
          stored = input.registry.timeline.storedTurn(row.bot_id, row.thread_id, row.turn_id)
          ready = turnReady(stored?.turn ?? null)
          if (stored) {
            const refreshed = adoptRevision(row, sourceRevision(row.turn_id, stored.revision))
            if (!refreshed) continue
            row = refreshed
          }
          if (!ready && historyProgress.completeScan && (historyProgress.exhaustedScans ?? row.history_exhausted_scans) >= MAX_HISTORY_EXHAUSTED_SCANS) {
            save(row, { state: "FAILED", last_error: "DISTILLATION_HISTORY_NOT_FOUND" })
            continue
          }
        }
        if (!stored || !ready) {
          waitForHistory(row, at)
          continue
        }
        const current = stored
        const excerpt = excerptFromTurn(current.turn)
        if (!excerpt.text.trim()) {
          markUnrelated(row, { scope: "unrelated", sensitivity: "standard", classifierVersion: DISTILLATION_CLASSIFIER_VERSION })
          continue
        }
        const principal = { tenant_id: row.tenant_id, subject_id: row.owner_subject_id, acting_client_id: row.acting_client_id }
        const token = input.sessions.tokenFor(principal, row.bot_id)
        if (!token) {
          save(row, { not_before: at + RETRY_SECONDS, last_error: "OWNER_SESSION_OFFLINE" })
          continue
        }
        const currentDigest = contentDigest(current.bodyJson)
        const cached = cachedTriage(row, currentDigest)
        const triage = cached ?? await input.classifier.classify(row.tenant_id, excerpt.text).catch(() => ({ status: "UNAVAILABLE" as const, classifier_version: DISTILLATION_CLASSIFIER_VERSION }))
        if (triage.status !== "CLASSIFIED") {
          const classifierAttempts = row.classifier_attempts + 1
          save(row, {
            state: row.state,
            classifier_attempts: classifierAttempts,
            not_before: at + Math.min(RETRY_SECONDS * classifierAttempts, 300),
            last_error: "CLASSIFIER_UNAVAILABLE",
          })
          emitDecision(row, {
            relevant: false, scope: "unrelated", sensitivity: "standard", classifierVersion: DISTILLATION_CLASSIFIER_VERSION, outcome: "unavailable",
          })
          continue
        }
        const refreshed = input.registry.timeline.storedTurn(row.bot_id, row.thread_id, row.turn_id)
        if (!refreshed) {
          waitForHistory(row, at)
          continue
        }
        const refreshedDigest = contentDigest(refreshed.bodyJson)
        const snapshotChanged = sourceRevision(row.turn_id, refreshed.revision) !== row.source_revision
          || currentDigest !== refreshedDigest
        const refreshedRow = adoptRevision(row, sourceRevision(row.turn_id, refreshed.revision))
        if (!refreshedRow) continue
        row = refreshedRow
        if (!turnReady(refreshed.turn)) {
          waitForHistory(row, at)
          continue
        }
        if (snapshotChanged) {
          discardClassifier(row)
          continue
        }
        if (!triage.relevant) {
          markUnrelated(row, { scope: triage.scope, sensitivity: triage.sensitivity, classifierVersion: triage.classifier_version })
          continue
        }
        if (!ownsRow(row)) continue
        if (!cached) saveClassifier(row, refreshedDigest, triage)
        try {
          const submittedMarker = await input.platform.submit(token, row.tenant_id, {
            bot_id: row.bot_id,
            thread_id: row.thread_id,
            turn_ids: [row.turn_id],
            source_revision: row.source_revision,
            content_digest: refreshedDigest,
            scope_hint: triage.scope,
            sensitivity: triage.sensitivity,
            knowledge_type: triage.knowledge_type,
            representation: triage.representation,
            classifier_version: DISTILLATION_CLASSIFIER_VERSION,
            extractor_version: DISTILLATION_EXTRACTOR_VERSION,
            evidence: triage.evidence,
            excerpt_truncated: excerpt.truncated,
            workspace_id: row.workspace_id,
          })
          const localState = submittedMarker.processing_state === "CANDIDATE_CREATED" ? "CANDIDATE"
            : submittedMarker.processing_state === "FILTERED_OUT" ? "UNRELATED"
              : submittedMarker.processing_state === "FAILED" ? "FAILED"
                : "SUBMITTED"
          save(row, {
            state: localState,
            marker_id: submittedMarker.marker_id,
            last_error: localState === "FAILED" ? submittedMarker.last_error ?? "DISTILLATION_PLATFORM_FAILED" : null,
          })
          if (localState !== "SUBMITTED") enqueueChangedRevision(row, at, refreshedDigest)
          emitDecision(row, {
            relevant: true, scope: triage.scope, sensitivity: triage.sensitivity, classifierVersion: triage.classifier_version, outcome: "marker",
          })
        } catch (error) {
          const message = error instanceof Error ? error.message.slice(0, 200) : "DISTILLATION_SUBMIT_FAILED"
          if (platformFailureIsRecoverable(error)) {
            save(row, { not_before: at + RETRY_SECONDS, last_error: message })
            continue
          }
          const attempts = row.attempts + 1
          save(row, {
            state: attempts >= MAX_SUBMISSION_ATTEMPTS ? "FAILED" : row.state,
            attempts,
            not_before: at + RETRY_SECONDS * attempts,
            last_error: message,
          })
          if (attempts >= MAX_SUBMISSION_ATTEMPTS) enqueueChangedRevision(row, at, refreshedDigest)
        }
      }
      const completionRows = nextLocalClaimRows("completion")
      const pendingClaim = [
        ...completionRows,
        ...nextLocalClaimRows("claim", Math.max(0, MAX_LOCAL_CLAIM_BATCH - completionRows.length)),
      ]
      const claimedBots = new Set<string>()
      const localClaimTargets: ClaimTargetEntry[] = pendingClaim.map((row) => {
        const target = targetForRow(row)
        return { key: claimTargetKey(target), target }
      })
      const claimTargets: DistillationClaimTarget[] = [
        ...localClaimTargets.map((entry) => entry.target),
        ...activeClaimTargets.filter((entry) => !hasLocalTarget.get(
          entry.target.principal.tenant_id,
          entry.target.principal.subject_id,
          entry.target.botId,
        )).map((entry) => entry.target),
      ]
      for (const target of claimTargets) {
        const { principal, botId } = target
        if (!ownsBot(botId, principal)) continue
        const botKey = `${principal.tenant_id}\u0000${principal.subject_id}\u0000${principal.acting_client_id}\u0000${botId}`
        if (claimedBots.has(botKey)) continue
        claimedBots.add(botKey)
        const token = input.sessions.tokenFor(principal, botId)
        if (!token) continue
        const pendingCompletion = pendingClaim.find((item) =>
          `${item.tenant_id}\u0000${item.owner_subject_id}\u0000${item.acting_client_id}\u0000${item.bot_id}` === botKey &&
          completionFor(item),
        )
        if (pendingCompletion) {
          const completion = completionFor(pendingCompletion)!
          const markerContext = completionContextFor(pendingCompletion) ?? {
            threadId: pendingCompletion.thread_id,
            turnIds: [pendingCompletion.turn_id],
          }
          if (!ownsRow(pendingCompletion)) continue
          try {
            await input.platform.complete(token, principal.tenant_id, pendingCompletion.marker_id!, completion)
          } catch (error) {
            if (!platformFailureIsRecoverable(error)) discardCompletion(pendingCompletion)
            continue
          }
          const replayTurns = completion.outcome === "CANDIDATE_CREATED"
            ? markerContext.turnIds.map((turnId) => input.registry.timeline.storedTurn(pendingCompletion.bot_id, markerContext.threadId, turnId))
            : []
          completeLinkedCandidate(
            pendingCompletion,
            target,
            pendingCompletion.marker_id!,
            completion,
            at,
            markerContext,
            replayTurns.length > 0 && replayTurns.every((stored) => stored && turnReady(stored.turn)) ? replayTurns.map((stored) => stored!) : null,
            pendingCompletion.workspace_id,
          )
          if (completion.outcome === "WAITING_FOR_HISTORY") {
            const historyProgress = await backfillClaimedTurns(
              { tenant_id: pendingCompletion.tenant_id, subject_id: pendingCompletion.owner_subject_id, acting_client_id: pendingCompletion.acting_client_id },
              pendingCompletion.bot_id,
              markerContext.threadId,
              markerContext.turnIds,
              pendingCompletion.marker_id ?? undefined,
            )
            saveHistoryExhaustedScans(pendingCompletion, historyProgress.exhaustedScans)
          }
          continue
        }
        let claimed: Awaited<ReturnType<DistillationPlatform["claim"]>>
        try {
          claimed = await input.platform.claim(token, principal.tenant_id, botId, leaseOwner)
        } catch {
          continue
        }
        if (!claimed) {
          const settledRow = pendingClaim.find((item) =>
            `${item.tenant_id}\u0000${item.owner_subject_id}\u0000${item.acting_client_id}\u0000${item.bot_id}` === botKey &&
            !item.completion_lease_token,
          )
          if (settledRow) await reconcileSettledMarker(token, settledRow, at)
          continue
        }
        if (!ownsBot(botId, principal)) continue
        const ownerRow = localMarkerRow.get(
          claimed.marker_id,
          principal.tenant_id,
          principal.subject_id,
          principal.acting_client_id,
          botId,
        ) as InboxRow | null
        if (ownerRow && !ownsRow(ownerRow)) continue
        const turnIds = claimed.turn_ids.length > 0 ? claimed.turn_ids : ownerRow?.turn_id ? [ownerRow.turn_id] : []
        const threadId = claimed.thread_id || ownerRow?.thread_id || ""
        if (!input.registry.ownsThread({ ...principal, scopes: [] }, botId, threadId)) {
          const completion: DistillationCompletion = {
            lease_token: claimed.lease_token,
            outcome: "FAILED",
            error: "DISTILLATION_THREAD_NOT_OWNED",
          }
          if (ownerRow) saveCompletion(ownerRow, completion, { threadId, turnIds })
          try {
            await input.platform.complete(token, principal.tenant_id, claimed.marker_id, completion)
          } catch {
            continue
          }
          if (ownerRow) completeInboxRow(ownerRow, completion, at, { threadId, turnIds })
          continue
        }
        const storedTurns = turnIds.map((turnId) => input.registry.timeline.storedTurn(botId, threadId, turnId))
        const ready = storedTurns.length > 0 && storedTurns.every((stored) => stored && turnReady(stored.turn))
        const historyExhaustedScans = ownerRow?.history_exhausted_scans
          ?? persistedHistoryExhaustedScans(botId, threadId, claimed.marker_id)
        if (!ready && historyExhaustedScans >= MAX_HISTORY_EXHAUSTED_SCANS) {
          const completion: DistillationCompletion = {
            lease_token: claimed.lease_token,
            outcome: "FAILED",
            error: "DISTILLATION_HISTORY_NOT_FOUND",
          }
          if (ownerRow) saveCompletion(ownerRow, completion, { threadId, turnIds })
          try {
            await input.platform.complete(token, principal.tenant_id, claimed.marker_id, completion)
          } catch {
            continue
          }
          if (ownerRow) completeInboxRow(ownerRow, completion, at, { threadId, turnIds })
          continue
        }
        if (!ready) {
          const completion: DistillationCompletion = {
            lease_token: claimed.lease_token,
            outcome: "WAITING_FOR_HISTORY",
            error: "DISTILLATION_HISTORY_INCOMPLETE",
          }
          if (ownerRow) saveCompletion(ownerRow, completion, { threadId, turnIds })
          try {
            await input.platform.complete(token, principal.tenant_id, claimed.marker_id, completion)
          } catch {
            continue
          }
          if (ownerRow) completeInboxRow(ownerRow, completion, at)
          const historyProgress = await backfillClaimedTurns(principal, botId, threadId, turnIds, claimed.marker_id)
          if (ownerRow) saveHistoryExhaustedScans(ownerRow, historyProgress.exhaustedScans)
          continue
        }
        const digest = markerContentDigest(storedTurns.map((stored) => stored!.bodyJson))
        const outcome = digest !== claimed.content_digest
          ? "FAILED" as const
          : "CANDIDATE_CREATED" as const
        const completion: DistillationCompletion = outcome === "CANDIDATE_CREATED"
          ? { lease_token: claimed.lease_token, outcome, content_digest: digest }
          : { lease_token: claimed.lease_token, outcome, error: "SOURCE_REVISION_CHANGED" }
        if (ownerRow) saveCompletion(ownerRow, completion, { threadId, turnIds })
        try {
          await input.platform.complete(token, principal.tenant_id, claimed.marker_id, completion)
        } catch {
          continue
        }
        if (!ownerRow) {
          if (completion.outcome === "CANDIDATE_CREATED") {
            for (const [index, sourceTurn] of storedTurns.entries()) {
              const sourceTurnId = turnIds[index]
              if (sourceTurn && sourceTurnId) {
                recordClaimedTurnCandidate(target, claimed.marker_id, threadId, sourceTurnId, sourceTurn.revision, at, claimed.workspace_id ?? null)
              }
            }
            enqueueChangedClaimedRevisions(
              target,
              threadId,
              turnIds,
              storedTurns.map((stored) => stored!),
              digest,
              at,
              claimed.workspace_id ?? null,
            )
          }
          continue
        }
        completeLinkedCandidate(
          ownerRow,
          target,
          claimed.marker_id,
          completion,
          at,
          { threadId, turnIds },
          storedTurns.map((stored) => stored!),
          claimed.workspace_id ?? null,
        )
      }
      } finally {
        ticking = false
      }
    },
    stop() {},
  }
}

export function attachDistillation(input: {
  registry: BotRegistry
  sessions: DistillationSessions
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
}): DistillationWorker {
  const env = input.env ?? process.env
  const origin = env.GENIO_ONE_PLATFORM_ORIGIN?.trim()
  const triageUrl = env.GENIO_ONE_DISTILLATION_TRIAGE_URL?.trim()
  const triageToken = env.GENIO_ONE_DISTILLATION_TRIAGE_TOKEN?.trim()
  const adapterId = env.GENIO_ONE_DISTILLATION_ADAPTER_ID?.trim()
  if (!origin || !triageUrl || !triageToken || !adapterId) {
    return { note() {}, historyImported() {}, async tick() {}, stop() {} }
  }
  const worker = createDistillationWorker({
    registry: input.registry,
    sessions: input.sessions,
    platform: createHttpDistillationPlatform(origin, input.fetchImpl),
    classifier: createHttpDistillationClassifier({ url: triageUrl, token: triageToken, adapterId, fetchImpl: input.fetchImpl }),
  })
  const stopHistoryImportObserving = input.registry.observeHistoryImport((event) => {
    worker.historyImported(event.botId, event.threadId, event.turnIds)
  })
  const timer = setInterval(() => { void worker.tick().catch(() => undefined) }, 15_000)
  timer.unref()
  return {
    note: worker.note,
    historyImported: worker.historyImported,
    tick: worker.tick,
    stop() { clearInterval(timer); stopHistoryImportObserving() },
  }
}
