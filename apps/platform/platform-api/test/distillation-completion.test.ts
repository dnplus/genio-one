import assert from "node:assert/strict"
import test from "node:test"

import { DISTILLATION_EXTRACTOR_VERSION } from "@genioone/protocol/distillation-triage"

import { PlatformApiError } from "../src/capabilities/errors"
import type { CreateDistillationMarker } from "../src/capabilities/distillation/contract"
import { createInMemoryDistillationStore } from "../src/capabilities/distillation/memory"
import { createPostgresDistillationStore } from "../src/capabilities/distillation/postgres"
import type { SqlAdapter, SqlQueryResult, SqlTransaction } from "../src/persistence/sql-adapter"

const digest = "a".repeat(64)

function markerInput(threadId: string): CreateDistillationMarker {
  return {
    bot_id: "bot-1",
    thread_id: threadId,
    turn_ids: ["turn-1"],
    source_revision: digest,
    content_digest: digest,
    scope_hint: "process" as const,
    sensitivity: "standard" as const,
    knowledge_type: "PROCEDURE" as const,
    representation: "BOTH" as const,
    classifier_version: "jev-distillation-1" as const,
    extractor_version: DISTILLATION_EXTRACTOR_VERSION as CreateDistillationMarker["extractor_version"],
    evidence: [{ check_id: "relevant", score: 0.9, threshold: 0.7, matched: true }],
    excerpt_truncated: false,
  }
}

test("memory store retries terminal completion only with the retained lease payload", async () => {
  const completions = [
    { outcome: "CANDIDATE_CREATED" as const, content_digest: digest },
    { outcome: "WAITING_FOR_HISTORY" as const, error: "DISTILLATION_HISTORY_INCOMPLETE" },
    { outcome: "FAILED" as const, error: "SOURCE_REVISION_CHANGED" },
  ]
  for (const [index, completion] of completions.entries()) {
    const store = createInMemoryDistillationStore({ now: () => 1_000, idFactory: () => `${index}` })
    const marker = await store.createMarker({ tenantId: "tenant", ownerSubjectId: "owner", value: markerInput(`thread-${index}`), contributorWorkspaceIds: [] })
    const claimed = await store.claim({ tenantId: "tenant", ownerSubjectId: "owner", botId: "bot-1", leaseOwner: "worker" })
    assert.ok(claimed)
    const body = { lease_token: claimed.lease_token, ...completion }
    const first = await store.complete({ tenantId: "tenant", ownerSubjectId: "owner", markerId: marker.marker_id, value: body })
    const replay = await store.complete({ tenantId: "tenant", ownerSubjectId: "owner", markerId: marker.marker_id, value: body })
    assert.equal(replay.marker.processing_state, first.marker.processing_state)
    await assert.rejects(
      () => store.complete({ tenantId: "tenant", ownerSubjectId: "owner", markerId: marker.marker_id, value: { ...body, lease_token: "other-lease" } }),
      (error: unknown) => error instanceof PlatformApiError && error.code === "DISTILLATION_LEASE_CONFLICT",
    )
  }
})

test("memory completion clears a history wait after a terminal failure", async () => {
  let clock = 1_000
  const store = createInMemoryDistillationStore({ now: () => clock, idFactory: (() => {
    let next = 0
    return () => String(++next)
  })() })
  const marker = await store.createMarker({ tenantId: "tenant", ownerSubjectId: "owner", contributorWorkspaceIds: [], value: markerInput("thread-history-failure") })
  const initialLease = await store.claim({ tenantId: "tenant", ownerSubjectId: "owner", botId: "bot-1", leaseOwner: "worker-a" })
  assert.ok(initialLease)
  await store.complete({
    tenantId: "tenant",
    ownerSubjectId: "owner",
    markerId: marker.marker_id,
    value: { lease_token: initialLease.lease_token, outcome: "WAITING_FOR_HISTORY" },
  })
  clock += 60
  const historyLease = await store.claim({ tenantId: "tenant", ownerSubjectId: "owner", botId: "bot-1", leaseOwner: "worker-b" })
  assert.ok(historyLease)
  const failed = await store.complete({
    tenantId: "tenant",
    ownerSubjectId: "owner",
    markerId: marker.marker_id,
    value: { lease_token: historyLease.lease_token, outcome: "FAILED", error: "SOURCE_REVISION_CHANGED" },
  })
  assert.equal(failed.marker.history_state, "READY")
})

type Row = Record<string, unknown>

class FailedCompletionSql implements SqlAdapter, SqlTransaction {
  readonly calls: Array<{ text: string; parameters: readonly unknown[] }> = []
  row: Row = {
    tenant_id: "tenant",
    marker_id: "marker-1",
    owner_subject_id: "owner",
    bot_id: "bot-1",
    thread_id: "thread-1",
    turn_ids: "[\"turn-1\"]",
    source_revision: digest,
    content_digest: digest,
    scope_hint: "process",
    sensitivity: "standard",
    knowledge_type: "PROCEDURE",
    representation: "BOTH",
    classifier_version: "jev-distillation-1",
    extractor_version: "timeline-body-1",
    evidence: "[]",
    excerpt_truncated: false,
    history_state: "READY",
    processing_state: "PROCESSING",
    attempts: 1,
    not_before: 1_000,
    workspace_id: null,
    last_error: null,
    created_at: 1_000,
    updated_at: 1_000,
    lease_owner: "worker",
    lease_token: "lease-1",
    lease_until: 1_060,
  }

  async query<Result extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Result>> {
    this.calls.push({ text, parameters })
    if (text.includes("select bot_id from genio_one_distillation_markers")) {
      return { rows: [{ bot_id: this.row.bot_id } as unknown as Result], rowCount: 1 }
    }
    if (text.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 }
    if (text.includes("for update")) return { rows: [this.row as Result], rowCount: 1 }
    if (text.includes("update genio_one_distillation_markers")) {
      this.row = {
        ...this.row,
        processing_state: parameters[3],
        history_state: parameters[4],
        not_before: parameters[5],
        last_error: parameters[6],
        lease_owner: null,
        lease_until: null,
        updated_at: parameters[7],
      }
      return { rows: [this.row as Result], rowCount: 1 }
    }
    throw new Error(`Unexpected query: ${text}`)
  }

  async transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
    return work(this)
  }
}

test("Postgres store accepts only the same retained FAILED completion", async () => {
  const sql = new FailedCompletionSql()
  const store = createPostgresDistillationStore({ sql, now: () => 1_000 })
  const value = { lease_token: "lease-1", outcome: "FAILED" as const, error: "SOURCE_REVISION_CHANGED" }
  const first = await store.complete({ tenantId: "tenant", ownerSubjectId: "owner", markerId: "marker-1", value })
  const replay = await store.complete({ tenantId: "tenant", ownerSubjectId: "owner", markerId: "marker-1", value })
  assert.equal(first.marker.processing_state, "FAILED")
  assert.equal(replay.marker.processing_state, "FAILED")
  const updates = sql.calls.filter((call) => call.text.includes("update genio_one_distillation_markers"))
  assert.equal(updates.length, 1)
  assert.doesNotMatch(updates[0]!.text, /lease_token\s*=\s*null/i)
  const botLookup = sql.calls.findIndex((call) => call.text.includes("select bot_id from genio_one_distillation_markers"))
  const botLock = sql.calls.findIndex((call) => call.text.includes("pg_advisory_xact_lock"))
  const markerLock = sql.calls.findIndex((call) => call.text.includes("for update"))
  assert.ok(botLookup >= 0)
  assert.ok(botLock > botLookup)
  assert.ok(markerLock > botLock)
  await assert.rejects(
    () => store.complete({ tenantId: "tenant", ownerSubjectId: "owner", markerId: "marker-1", value: { ...value, lease_token: "other-lease" } }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "DISTILLATION_LEASE_CONFLICT",
  )
})

class ClaimSql implements SqlAdapter, SqlTransaction {
  readonly calls: Array<{ text: string; parameters: readonly unknown[] }> = []
  row: Row = {
    tenant_id: "tenant",
    marker_id: "marker-1",
    owner_subject_id: "owner",
    bot_id: "bot-1",
    thread_id: "thread-1",
    turn_ids: "[\"turn-1\"]",
    source_revision: digest,
    content_digest: digest,
    scope_hint: "process",
    sensitivity: "standard",
    knowledge_type: "PROCEDURE",
    representation: "BOTH",
    classifier_version: "jev-distillation-1",
    extractor_version: "timeline-body-1",
    evidence: "[]",
    excerpt_truncated: false,
    history_state: "READY",
    processing_state: "PENDING",
    attempts: 0,
    not_before: 0,
    workspace_id: null,
    last_error: null,
    created_at: 1,
    updated_at: 1,
    lease_owner: null,
    lease_token: null,
    lease_until: null,
  }

  async query<Result extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Result>> {
    this.calls.push({ text, parameters })
    if (text.includes("set processing_state = 'FAILED'")) return { rows: [], rowCount: 0 }
    if (text.includes("select marker_id from genio_one_distillation_markers")) {
      return { rows: [{ marker_id: this.row.marker_id } as unknown as Result], rowCount: 1 }
    }
    if (text.includes("set processing_state = 'PROCESSING'")) {
      const consumesAttempt = this.row.history_state !== "WAITING_FOR_HISTORY"
      this.row = {
        ...this.row,
        processing_state: "PROCESSING",
        attempts: Number(this.row.attempts) + (consumesAttempt ? 1 : 0),
        lease_owner: parameters[3],
        lease_token: parameters[4],
        lease_until: parameters[5],
        updated_at: parameters[6],
      }
      return { rows: [this.row as Result], rowCount: 1 }
    }
    throw new Error(`Unexpected query: ${text}`)
  }

  async transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
    return work(this)
  }
}

test("memory and Postgres claims preserve attempts across history waits", async () => {
  let memoryClock = 1_000
  const memory = createInMemoryDistillationStore({ now: () => memoryClock, idFactory: (() => {
    let next = 0
    return () => String(++next)
  })() })
  const waitingMarker = await memory.createMarker({ tenantId: "tenant", ownerSubjectId: "owner", value: markerInput("thread-wait"), contributorWorkspaceIds: [] })
  const firstMemoryClaim = await memory.claim({ tenantId: "tenant", ownerSubjectId: "owner", botId: "bot-1", leaseOwner: "worker" })
  assert.equal(firstMemoryClaim?.attempts, 1)
  await memory.complete({
    tenantId: "tenant",
    ownerSubjectId: "owner",
    markerId: waitingMarker.marker_id,
    value: { lease_token: firstMemoryClaim!.lease_token, outcome: "WAITING_FOR_HISTORY", error: "DISTILLATION_HISTORY_INCOMPLETE" },
  })
  memoryClock = 1_060
  const waitingMemoryClaim = await memory.claim({ tenantId: "tenant", ownerSubjectId: "owner", botId: "bot-1", leaseOwner: "worker" })
  assert.equal(waitingMemoryClaim?.attempts, 1)

  let crashClock = 1_000
  const crashed = createInMemoryDistillationStore({ now: () => crashClock, idFactory: () => "crash" })
  await crashed.createMarker({ tenantId: "tenant", ownerSubjectId: "owner", value: markerInput("thread-crash"), contributorWorkspaceIds: [] })
  const firstCrashClaim = await crashed.claim({ tenantId: "tenant", ownerSubjectId: "owner", botId: "bot-1", leaseOwner: "worker-a" })
  assert.equal(firstCrashClaim?.attempts, 1)
  crashClock = 1_061
  const reclaimedCrash = await crashed.claim({ tenantId: "tenant", ownerSubjectId: "owner", botId: "bot-1", leaseOwner: "worker-b" })
  assert.equal(reclaimedCrash?.attempts, 2)

  let cappedClock = 1_000
  const capped = createInMemoryDistillationStore({ now: () => cappedClock, idFactory: (() => {
    let next = 0
    return () => String(++next)
  })() })
  const cappedMarker = await capped.createMarker({ tenantId: "tenant", ownerSubjectId: "owner", value: markerInput("thread-capped"), contributorWorkspaceIds: [] })
  let cappedClaim
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    cappedClaim = await capped.claim({ tenantId: "tenant", ownerSubjectId: "owner", botId: "bot-1", leaseOwner: `worker-${attempt}` })
    assert.equal(cappedClaim?.attempts, attempt)
    if (attempt < 5) cappedClock += 61
  }
  await capped.complete({
    tenantId: "tenant",
    ownerSubjectId: "owner",
    markerId: cappedMarker.marker_id,
    value: { lease_token: cappedClaim!.lease_token, outcome: "WAITING_FOR_HISTORY", error: "DISTILLATION_HISTORY_INCOMPLETE" },
  })
  cappedClock += 60
  const cappedWaitingClaim = await capped.claim({ tenantId: "tenant", ownerSubjectId: "owner", botId: "bot-1", leaseOwner: "worker-wait" })
  assert.equal(cappedWaitingClaim?.attempts, 5)
  assert.equal(cappedWaitingClaim?.history_state, "WAITING_FOR_HISTORY")
  cappedClock += 61
  const reclaimedWaitingClaim = await capped.claim({ tenantId: "tenant", ownerSubjectId: "owner", botId: "bot-1", leaseOwner: "worker-restarted" })
  assert.equal(reclaimedWaitingClaim?.attempts, 5)
  const completedWaitingClaim = await capped.complete({
    tenantId: "tenant",
    ownerSubjectId: "owner",
    markerId: cappedMarker.marker_id,
    value: { lease_token: reclaimedWaitingClaim!.lease_token, outcome: "CANDIDATE_CREATED", content_digest: digest },
  })
  assert.equal(completedWaitingClaim.marker.history_state, "READY")

  const sql = new ClaimSql()
  const postgres = createPostgresDistillationStore({ sql, now: () => 1_000, idFactory: (() => {
    let next = 0
    return () => String(++next)
  })() })
  const firstPostgresClaim = await postgres.claim({ tenantId: "tenant", ownerSubjectId: "owner", botId: "bot-1", leaseOwner: "worker-a" })
  assert.equal(firstPostgresClaim?.attempts, 1)
  sql.row = { ...sql.row, processing_state: "PROCESSING", lease_until: 999 }
  const reclaimedPostgres = await postgres.claim({ tenantId: "tenant", ownerSubjectId: "owner", botId: "bot-1", leaseOwner: "worker-b" })
  assert.equal(reclaimedPostgres?.attempts, 2)
  sql.row = {
    ...sql.row,
    history_state: "WAITING_FOR_HISTORY",
    processing_state: "WAITING_FOR_HISTORY",
    attempts: 1,
    lease_until: null,
  }
  const waitingPostgresClaim = await postgres.claim({ tenantId: "tenant", ownerSubjectId: "owner", botId: "bot-1", leaseOwner: "worker-c" })
  assert.equal(waitingPostgresClaim?.attempts, 1)
  sql.row = { ...sql.row, processing_state: "PROCESSING", lease_until: 999 }
  const reclaimedPostgresHistoryWait = await postgres.claim({ tenantId: "tenant", ownerSubjectId: "owner", botId: "bot-1", leaseOwner: "worker-d" })
  assert.equal(reclaimedPostgresHistoryWait?.attempts, 1)
  sql.row = {
    ...sql.row,
    history_state: "WAITING_FOR_HISTORY",
    processing_state: "WAITING_FOR_HISTORY",
    attempts: 5,
    lease_until: null,
  }
  const cappedPostgresClaim = await postgres.claim({ tenantId: "tenant", ownerSubjectId: "owner", botId: "bot-1", leaseOwner: "worker-wait" })
  assert.equal(cappedPostgresClaim?.attempts, 5)
  assert.equal(cappedPostgresClaim?.history_state, "WAITING_FOR_HISTORY")
  sql.row = { ...sql.row, processing_state: "PROCESSING", lease_until: 999 }
  const reclaimedPostgresWaitingClaim = await postgres.claim({ tenantId: "tenant", ownerSubjectId: "owner", botId: "bot-1", leaseOwner: "worker-restarted" })
  assert.equal(reclaimedPostgresWaitingClaim?.attempts, 5)
  const exhaustion = sql.calls.find((call) => call.text.includes("set processing_state = 'FAILED'"))
  const claimUpdate = sql.calls.find((call) => call.text.includes("set processing_state = 'PROCESSING'"))
  assert.ok(exhaustion)
  assert.ok(claimUpdate)
  assert.match(exhaustion.text, /history_state = 'READY'/i)
  assert.match(claimUpdate.text, /case when history_state = 'WAITING_FOR_HISTORY' then 0 else 1 end/i)
})
