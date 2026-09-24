import assert from "node:assert/strict"
import test from "node:test"

import { DISTILLATION_EXTRACTOR_VERSION } from "@genioone/protocol/distillation-triage"

import { createManagementApi } from "../src/app"
import { PlatformApiError } from "../src/capabilities/errors"
import type { CreateDistillationMarker } from "../src/capabilities/distillation/contract"
import { createInMemoryDistillationStore } from "../src/capabilities/distillation/memory"
import { createPostgresDistillationStore } from "../src/capabilities/distillation/postgres"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"
import type { Principal } from "../src/capabilities/tenancy-auth/contract"
import type { SqlAdapter, SqlQueryResult, SqlTransaction } from "../src/persistence/sql-adapter"

const digest = "a".repeat(64)

function markerInput(overrides: Partial<CreateDistillationMarker> = {}): CreateDistillationMarker {
  return {
    bot_id: "bot-1",
    thread_id: "thread-1",
    turn_ids: ["turn-1"],
    source_revision: digest,
    content_digest: digest,
    scope_hint: "process",
    sensitivity: "standard",
    knowledge_type: "PROCEDURE",
    representation: "BOTH",
    classifier_version: "jev-distillation-1",
    extractor_version: DISTILLATION_EXTRACTOR_VERSION,
    evidence: [{ check_id: "relevant", score: 0.9, threshold: 0.7, matched: true }],
    excerpt_truncated: false,
    ...overrides,
  }
}

function principal(subjectId: string, scopes: string[]): Principal {
  return {
    tenant_id: "tenant-acme",
    subject_id: subjectId,
    client_id: "genio-one-bot",
    role: "USER",
    organization_ids: [],
    scopes,
  }
}

test("bot cancellation accepts either owner scope and preserves other owners and terminal candidates", async () => {
  const modules = createInMemoryPlatformModules({ now: () => 1_000 })
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      owner: principal("owner", ["genioone-invocation"]),
      console: principal("owner", ["genioone-management"]),
      other: principal("other", ["genioone-invocation"]),
      denied: principal("owner", []),
    }),
  })
  const ownerHeaders = { authorization: "Bearer owner" }
  const terminal = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers",
    headers: ownerHeaders,
    payload: markerInput({ thread_id: "terminal" }),
  })
  assert.equal(terminal.statusCode, 200)
  const terminalClaim = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers/claim",
    headers: ownerHeaders,
    payload: { bot_id: "bot-1", lease_owner: "worker" },
  })
  assert.equal(terminalClaim.statusCode, 200)
  const terminalCompletion = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-acme/distillation-markers/${terminal.json().marker_id}/result`,
    headers: ownerHeaders,
    payload: {
      lease_token: terminalClaim.json().lease_token,
      outcome: "CANDIDATE_CREATED",
      content_digest: digest,
    },
  })
  assert.equal(terminalCompletion.statusCode, 200)
  const active = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers",
    headers: ownerHeaders,
    payload: markerInput({ thread_id: "active" }),
  })
  assert.equal(active.statusCode, 200)
  const otherMarker = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers",
    headers: { authorization: "Bearer other" },
    payload: markerInput({ thread_id: "other" }),
  })
  assert.equal(otherMarker.statusCode, 200)

  const denied = await app.inject({
    method: "DELETE",
    url: "/v1/tenants/tenant-acme/distillation-markers/bots/bot-1",
    headers: { authorization: "Bearer denied" },
  })
  assert.equal(denied.statusCode, 403)
  const cancelledOther = await app.inject({
    method: "DELETE",
    url: "/v1/tenants/tenant-acme/distillation-markers/bots/bot-1",
    headers: { authorization: "Bearer other" },
  })
  assert.equal(cancelledOther.statusCode, 200)
  assert.deepEqual(cancelledOther.json(), { bot_id: "bot-1", cancelled_count: 1 })
  const ownerBefore = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/distillation-markers",
    headers: ownerHeaders,
  })
  assert.equal(ownerBefore.json().markers.find((item: { marker_id: string }) => item.marker_id === active.json().marker_id)?.processing_state, "PENDING")

  const cancelledOwner = await app.inject({
    method: "DELETE",
    url: "/v1/tenants/tenant-acme/distillation-markers/bots/bot-1",
    headers: { authorization: "Bearer console" },
  })
  assert.equal(cancelledOwner.statusCode, 200)
  assert.deepEqual(cancelledOwner.json(), { bot_id: "bot-1", cancelled_count: 1 })
  const retry = await app.inject({
    method: "DELETE",
    url: "/v1/tenants/tenant-acme/distillation-markers/bots/bot-1",
    headers: ownerHeaders,
  })
  assert.deepEqual(retry.json(), { bot_id: "bot-1", cancelled_count: 0 })
  const markers = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/distillation-markers",
    headers: ownerHeaders,
  })
  const activeMarker = markers.json().markers.find((item: { marker_id: string }) => item.marker_id === active.json().marker_id)
  const terminalMarker = markers.json().markers.find((item: { marker_id: string }) => item.marker_id === terminal.json().marker_id)
  assert.deepEqual(activeMarker && { processing_state: activeMarker.processing_state, last_error: activeMarker.last_error }, { processing_state: "FAILED", last_error: "BOT_DELETED" })
  assert.equal(terminalMarker?.processing_state, "CANDIDATE_CREATED")
  const candidates = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/knowledge-candidates",
    headers: ownerHeaders,
  })
  assert.equal(candidates.json().candidates.length, 1)
  const recreate = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers",
    headers: ownerHeaders,
    payload: markerInput({ thread_id: "active" }),
  })
  assert.equal(recreate.statusCode, 409)
  assert.equal(recreate.json().code, "DISTILLATION_BOT_DELETED")
  await app.close()
})

test("memory cancellation is idempotent, clears active leases, and preserves terminal markers", async () => {
  let nextId = 0
  const store = createInMemoryDistillationStore({ now: () => 1_000, idFactory: () => String(++nextId) })
  const waiting = await store.createMarker({ tenantId: "tenant", ownerSubjectId: "owner", contributorWorkspaceIds: [], value: markerInput({ thread_id: "waiting" }) })
  const waitingLease = await store.claim({ tenantId: "tenant", ownerSubjectId: "owner", botId: "bot-1", leaseOwner: "worker" })
  assert.ok(waitingLease)
  await store.complete({
    tenantId: "tenant",
    ownerSubjectId: "owner",
    markerId: waiting.marker_id,
    value: { lease_token: waitingLease.lease_token, outcome: "WAITING_FOR_HISTORY" },
  })
  const processing = await store.createMarker({ tenantId: "tenant", ownerSubjectId: "owner", contributorWorkspaceIds: [], value: markerInput({ thread_id: "processing" }) })
  const processingLease = await store.claim({ tenantId: "tenant", ownerSubjectId: "owner", botId: "bot-1", leaseOwner: "worker" })
  assert.equal(processingLease?.marker_id, processing.marker_id)
  const terminal = await store.createMarker({ tenantId: "tenant", ownerSubjectId: "owner", contributorWorkspaceIds: [], value: markerInput({ thread_id: "terminal" }) })
  const terminalLease = await store.claim({ tenantId: "tenant", ownerSubjectId: "owner", botId: "bot-1", leaseOwner: "worker" })
  assert.equal(terminalLease?.marker_id, terminal.marker_id)
  await store.complete({
    tenantId: "tenant",
    ownerSubjectId: "owner",
    markerId: terminal.marker_id,
    value: { lease_token: terminalLease!.lease_token, outcome: "CANDIDATE_CREATED", content_digest: digest },
  })
  const failed = await store.createMarker({ tenantId: "tenant", ownerSubjectId: "owner", contributorWorkspaceIds: [], value: markerInput({ thread_id: "failed" }) })
  const failedLease = await store.claim({ tenantId: "tenant", ownerSubjectId: "owner", botId: "bot-1", leaseOwner: "worker" })
  assert.equal(failedLease?.marker_id, failed.marker_id)
  await store.complete({
    tenantId: "tenant",
    ownerSubjectId: "owner",
    markerId: failed.marker_id,
    value: { lease_token: failedLease!.lease_token, outcome: "FAILED", error: "SOURCE_REVISION_CHANGED" },
  })
  const pending = await store.createMarker({ tenantId: "tenant", ownerSubjectId: "owner", contributorWorkspaceIds: [], value: markerInput({ thread_id: "pending" }) })

  const first = await store.cancelBot({ tenantId: "tenant", ownerSubjectId: "owner", botId: "bot-1" })
  const second = await store.cancelBot({ tenantId: "tenant", ownerSubjectId: "owner", botId: "bot-1" })
  assert.deepEqual(first, { bot_id: "bot-1", cancelled_count: 3 })
  assert.deepEqual(second, { bot_id: "bot-1", cancelled_count: 0 })
  const markers = await store.listMarkers({ tenantId: "tenant", ownerSubjectId: "owner", limit: 10 })
  const storedMarker = (markerId: string) => {
    const stored = markers.markers.find((item) => item.marker_id === markerId)
    assert.ok(stored)
    return stored
  }
  for (const markerId of [waiting.marker_id, processing.marker_id, pending.marker_id]) {
    const stored = storedMarker(markerId)
    assert.deepEqual({ processing_state: stored.processing_state, last_error: stored.last_error }, { processing_state: "FAILED", last_error: "BOT_DELETED" })
  }
  assert.equal(storedMarker(terminal.marker_id).processing_state, "CANDIDATE_CREATED")
  assert.deepEqual(
    {
      processing_state: storedMarker(failed.marker_id).processing_state,
      last_error: storedMarker(failed.marker_id).last_error,
    },
    { processing_state: "FAILED", last_error: "SOURCE_REVISION_CHANGED" },
  )
  assert.equal((await store.listCandidates({ tenantId: "tenant", ownerSubjectId: "owner", workspaceIds: [] })).candidates.length, 1)
  await assert.rejects(
    () => store.complete({
      tenantId: "tenant",
      ownerSubjectId: "owner",
      markerId: processing.marker_id,
      value: { lease_token: processingLease!.lease_token, outcome: "CANDIDATE_CREATED", content_digest: digest },
    }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "DISTILLATION_LEASE_CONFLICT",
  )
  await assert.rejects(
    () => store.createMarker({ tenantId: "tenant", ownerSubjectId: "owner", contributorWorkspaceIds: [], value: markerInput({ thread_id: "pending" }) }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "DISTILLATION_BOT_DELETED",
  )
})

test("memory serializes submission and cancellation in invocation order", async () => {
  const submittedFirst = createInMemoryDistillationStore({ now: () => 1_000, idFactory: () => "one" })
  const submission = submittedFirst.createMarker({ tenantId: "tenant", ownerSubjectId: "owner", contributorWorkspaceIds: [], value: markerInput() })
  const cancellation = submittedFirst.cancelBot({ tenantId: "tenant", ownerSubjectId: "owner", botId: "bot-1" })
  const marker = await submission
  assert.deepEqual(await cancellation, { bot_id: "bot-1", cancelled_count: 1 })
  const stored = (await submittedFirst.listMarkers({ tenantId: "tenant", ownerSubjectId: "owner" })).markers[0]
  assert.ok(stored)
  assert.deepEqual({ marker_id: stored.marker_id, processing_state: stored.processing_state }, { marker_id: marker.marker_id, processing_state: "FAILED" })

  const cancelledFirst = createInMemoryDistillationStore({ now: () => 1_000, idFactory: () => "two" })
  const deletion = cancelledFirst.cancelBot({ tenantId: "tenant", ownerSubjectId: "owner", botId: "bot-1" })
  const rejectedSubmission = cancelledFirst.createMarker({ tenantId: "tenant", ownerSubjectId: "owner", contributorWorkspaceIds: [], value: markerInput() })
  assert.deepEqual(await deletion, { bot_id: "bot-1", cancelled_count: 0 })
  await assert.rejects(
    () => rejectedSubmission,
    (error: unknown) => error instanceof PlatformApiError && error.code === "DISTILLATION_BOT_DELETED",
  )
})

test("memory serializes cancellation and leased completion in invocation order", async () => {
  let nextId = 0
  const completeFirst = createInMemoryDistillationStore({ now: () => 1_000, idFactory: () => String(++nextId) })
  const completedMarker = await completeFirst.createMarker({ tenantId: "tenant", ownerSubjectId: "owner", contributorWorkspaceIds: [], value: markerInput() })
  const completedLease = await completeFirst.claim({ tenantId: "tenant", ownerSubjectId: "owner", botId: "bot-1", leaseOwner: "worker" })
  assert.ok(completedLease)
  const completion = completeFirst.complete({
    tenantId: "tenant",
    ownerSubjectId: "owner",
    markerId: completedMarker.marker_id,
    value: { lease_token: completedLease.lease_token, outcome: "CANDIDATE_CREATED", content_digest: digest },
  })
  const cancellation = completeFirst.cancelBot({ tenantId: "tenant", ownerSubjectId: "owner", botId: "bot-1" })
  const [completed, cancelled] = await Promise.all([completion, cancellation])
  assert.ok(completed.candidate)
  assert.deepEqual(cancelled, { bot_id: "bot-1", cancelled_count: 0 })
  const replay = await completeFirst.complete({
    tenantId: "tenant",
    ownerSubjectId: "owner",
    markerId: completedMarker.marker_id,
    value: { lease_token: completedLease.lease_token, outcome: "CANDIDATE_CREATED", content_digest: digest },
  })
  assert.equal(replay.candidate?.knowledge_id, completed.candidate.knowledge_id)

  const cancelFirst = createInMemoryDistillationStore({ now: () => 1_000, idFactory: () => String(++nextId) })
  const cancelledMarker = await cancelFirst.createMarker({ tenantId: "tenant", ownerSubjectId: "owner", contributorWorkspaceIds: [], value: markerInput() })
  const cancelledLease = await cancelFirst.claim({ tenantId: "tenant", ownerSubjectId: "owner", botId: "bot-1", leaseOwner: "worker" })
  assert.ok(cancelledLease)
  const deletion = cancelFirst.cancelBot({ tenantId: "tenant", ownerSubjectId: "owner", botId: "bot-1" })
  const rejectedCompletion = cancelFirst.complete({
    tenantId: "tenant",
    ownerSubjectId: "owner",
    markerId: cancelledMarker.marker_id,
    value: { lease_token: cancelledLease.lease_token, outcome: "CANDIDATE_CREATED", content_digest: digest },
  })
  assert.deepEqual(await deletion, { bot_id: "bot-1", cancelled_count: 1 })
  await assert.rejects(
    () => rejectedCompletion,
    (error: unknown) => error instanceof PlatformApiError && error.code === "DISTILLATION_LEASE_CONFLICT",
  )
  assert.equal((await cancelFirst.listCandidates({ tenantId: "tenant", ownerSubjectId: "owner", workspaceIds: [] })).candidates.length, 0)
})

type Row = Record<string, unknown>

class DistillationBotCancellationSql implements SqlAdapter, SqlTransaction {
  readonly calls: Array<{ text: string; parameters: readonly unknown[] }> = []
  readonly markers = new Map<string, Row>()
  readonly candidates = new Map<string, Row>()
  readonly tombstones = new Set<string>()

  private tombstoneKey(tenantId: unknown, ownerSubjectId: unknown, botId: unknown): string {
    return [tenantId, ownerSubjectId, botId].map(String).join("\u0000")
  }

  private candidateKey(tenantId: unknown, markerId: unknown): string {
    return [tenantId, markerId].map(String).join("\u0000")
  }

  seed(markerId: string, processingState: string, lastError: string | null): void {
    this.markers.set(markerId, {
      tenant_id: "tenant",
      marker_id: markerId,
      owner_subject_id: "owner",
      bot_id: "bot-1",
      thread_id: markerId,
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
      processing_state: processingState,
      attempts: 0,
      not_before: 1_000,
      workspace_id: null,
      last_error: lastError,
      created_at: 1_000,
      updated_at: 1_000,
      lease_owner: processingState === "PROCESSING" ? "worker" : null,
      lease_token: processingState === "PROCESSING" ? "lease" : null,
      lease_until: processingState === "PROCESSING" ? 1_060 : null,
    })
  }

  async query<Result extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Result>> {
    this.calls.push({ text, parameters })
    if (text.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 }
    if (text.includes("select bot_id from genio_one_distillation_markers")) {
      const row = this.markers.get(String(parameters[1]))
      return row ? { rows: [{ bot_id: row.bot_id } as unknown as Result], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (text.includes("from genio_one_distillation_markers") && text.includes("for update")) {
      const row = this.markers.get(String(parameters[1]))
      return row ? { rows: [row as Result], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (text.includes("from genio_one_distillation_bot_tombstones")) {
      const key = this.tombstoneKey(parameters[0], parameters[1], parameters[2])
      return this.tombstones.has(key)
        ? { rows: [{ exists: 1 } as unknown as Result], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    }
    if (text.includes("insert into genio_one_distillation_bot_tombstones")) {
      const key = this.tombstoneKey(parameters[0], parameters[1], parameters[2])
      const existed = this.tombstones.has(key)
      this.tombstones.add(key)
      return { rows: [], rowCount: existed ? 0 : 1 }
    }
    if (text.includes("from genio_one_distillation_markers") && text.includes("source_revision = $5")) {
      const matching = [...this.markers.values()].find((row) =>
        row.tenant_id === parameters[0] &&
        row.owner_subject_id === parameters[1] &&
        row.bot_id === parameters[2] &&
        row.thread_id === parameters[3] &&
        row.source_revision === parameters[4] &&
        row.extractor_version === parameters[5],
      )
      return matching ? { rows: [matching as Result], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (text.includes("insert into genio_one_distillation_markers")) {
      if (this.markers.has(String(parameters[1]))) return { rows: [], rowCount: 0 }
      const row: Row = {
        tenant_id: parameters[0],
        marker_id: parameters[1],
        owner_subject_id: parameters[2],
        bot_id: parameters[3],
        thread_id: parameters[4],
        turn_ids: parameters[5],
        source_revision: parameters[6],
        content_digest: parameters[7],
        scope_hint: parameters[8],
        sensitivity: parameters[9],
        knowledge_type: parameters[10],
        representation: parameters[11],
        classifier_version: parameters[12],
        extractor_version: parameters[13],
        evidence: parameters[14],
        excerpt_truncated: parameters[15],
        history_state: "READY",
        processing_state: "PENDING",
        attempts: 0,
        not_before: parameters[16],
        workspace_id: parameters[17],
        last_error: null,
        created_at: parameters[16],
        updated_at: parameters[16],
        lease_owner: null,
        lease_token: null,
        lease_until: null,
      }
      this.markers.set(String(parameters[1]), row)
      return { rows: [row as Result], rowCount: 1 }
    }
    if (text.includes("update genio_one_distillation_markers") && text.includes("set processing_state = $4")) {
      const row = this.markers.get(String(parameters[1]))
      if (!row) return { rows: [], rowCount: 0 }
      row.processing_state = parameters[3]
      row.history_state = parameters[4]
      row.not_before = parameters[5]
      row.last_error = parameters[6]
      row.lease_owner = null
      row.lease_until = null
      row.updated_at = parameters[7]
      return { rows: [row as Result], rowCount: 1 }
    }
    if (text.includes("last_error = 'BOT_DELETED'")) {
      let rowCount = 0
      for (const row of this.markers.values()) {
        if (
          row.tenant_id !== parameters[0] ||
          row.owner_subject_id !== parameters[1] ||
          row.bot_id !== parameters[2] ||
          !["PENDING", "WAITING_FOR_HISTORY", "PROCESSING"].includes(String(row.processing_state))
        ) continue
        row.processing_state = "FAILED"
        row.last_error = "BOT_DELETED"
        row.lease_owner = null
        row.lease_token = null
        row.lease_until = null
        row.updated_at = parameters[3]
        rowCount += 1
      }
      return { rows: [], rowCount }
    }
    if (text.includes("insert into genio_one_knowledge_candidates")) {
      const key = this.candidateKey(parameters[0], parameters[2])
      const existing = this.candidates.get(key)
      if (existing) return { rows: [existing as Result], rowCount: 1 }
      const row: Row = {
        tenant_id: parameters[0],
        knowledge_id: parameters[1],
        marker_id: parameters[2],
        owner_subject_id: parameters[3],
        workspace_id: parameters[4],
        scope: parameters[5],
        knowledge_type: parameters[6],
        representation: parameters[7],
        sensitivity: parameters[8],
        review_state: "PENDING_REVIEW",
        content_digest: parameters[9],
        provenance: parameters[10],
        reviewed_by: null,
        reviewed_at: null,
        created_at: parameters[11],
        updated_at: parameters[11],
      }
      this.candidates.set(key, row)
      return { rows: [row as Result], rowCount: 1 }
    }
    if (text.includes("from genio_one_knowledge_candidates")) {
      const row = this.candidates.get(this.candidateKey(parameters[0], parameters[1]))
      return row ? { rows: [row as Result], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    throw new Error(`Unexpected query: ${text}`)
  }

  async transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
    return work(this)
  }
}

test("Postgres serializes cancellation with submission under one bot lock", async () => {
  const sql = new DistillationBotCancellationSql()
  const store = createPostgresDistillationStore({ sql, now: () => 1_000, idFactory: () => "created" })
  const submitted = await store.createMarker({ tenantId: "tenant", ownerSubjectId: "owner", contributorWorkspaceIds: [], value: markerInput() })
  assert.equal(submitted.processing_state, "PENDING")
  sql.seed("candidate", "CANDIDATE_CREATED", null)
  sql.seed("failed", "FAILED", "SOURCE_REVISION_CHANGED")
  sql.seed("filtered", "FILTERED_OUT", null)
  const cancelled = await store.cancelBot({ tenantId: "tenant", ownerSubjectId: "owner", botId: "bot-1" })
  assert.deepEqual(cancelled, { bot_id: "bot-1", cancelled_count: 1 })
  assert.deepEqual(
    sql.markers.get(submitted.marker_id) && {
      processing_state: sql.markers.get(submitted.marker_id)!.processing_state,
      last_error: sql.markers.get(submitted.marker_id)!.last_error,
      lease_token: sql.markers.get(submitted.marker_id)!.lease_token,
    },
    { processing_state: "FAILED", last_error: "BOT_DELETED", lease_token: null },
  )
  assert.equal(sql.markers.get("candidate")?.processing_state, "CANDIDATE_CREATED")
  assert.equal(sql.markers.get("failed")?.last_error, "SOURCE_REVISION_CHANGED")
  assert.equal(sql.markers.get("filtered")?.processing_state, "FILTERED_OUT")
  await assert.rejects(
    () => store.createMarker({ tenantId: "tenant", ownerSubjectId: "owner", contributorWorkspaceIds: [], value: markerInput() }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "DISTILLATION_BOT_DELETED",
  )
  const locks = sql.calls.filter((call) => call.text.includes("pg_advisory_xact_lock"))
  assert.equal(locks.length, 3)
  assert.ok(locks.every((call) => call.parameters[0] === locks[0]!.parameters[0]))
  const cancellationUpdate = sql.calls.find((call) => call.text.includes("last_error = 'BOT_DELETED'"))
  assert.ok(cancellationUpdate)
  assert.match(cancellationUpdate.text, /processing_state in \('PENDING', 'WAITING_FOR_HISTORY', 'PROCESSING'\)/)
  assert.match(cancellationUpdate.text, /lease_token = null/)
})

test("Postgres serializes cancellation and leased completion before locking the marker row", async () => {
  const completeFirstSql = new DistillationBotCancellationSql()
  completeFirstSql.seed("marker-1", "PROCESSING", null)
  const completeFirst = createPostgresDistillationStore({ sql: completeFirstSql, now: () => 1_000, idFactory: () => "candidate" })
  const completed = await completeFirst.complete({
    tenantId: "tenant",
    ownerSubjectId: "owner",
    markerId: "marker-1",
    value: { lease_token: "lease", outcome: "CANDIDATE_CREATED", content_digest: digest },
  })
  assert.ok(completed.candidate)
  assert.deepEqual(
    await completeFirst.cancelBot({ tenantId: "tenant", ownerSubjectId: "owner", botId: "bot-1" }),
    { bot_id: "bot-1", cancelled_count: 0 },
  )
  const replay = await completeFirst.complete({
    tenantId: "tenant",
    ownerSubjectId: "owner",
    markerId: "marker-1",
    value: { lease_token: "lease", outcome: "CANDIDATE_CREATED", content_digest: digest },
  })
  assert.equal(replay.candidate?.knowledge_id, completed.candidate.knowledge_id)

  const cancelFirstSql = new DistillationBotCancellationSql()
  cancelFirstSql.seed("marker-1", "PROCESSING", null)
  const cancelFirst = createPostgresDistillationStore({ sql: cancelFirstSql, now: () => 1_000, idFactory: () => "candidate" })
  assert.deepEqual(
    await cancelFirst.cancelBot({ tenantId: "tenant", ownerSubjectId: "owner", botId: "bot-1" }),
    { bot_id: "bot-1", cancelled_count: 1 },
  )
  await assert.rejects(
    () => cancelFirst.complete({
      tenantId: "tenant",
      ownerSubjectId: "owner",
      markerId: "marker-1",
      value: { lease_token: "lease", outcome: "CANDIDATE_CREATED", content_digest: digest },
    }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "DISTILLATION_LEASE_CONFLICT",
  )
  assert.equal(cancelFirstSql.candidates.size, 0)
  assert.equal(cancelFirstSql.tombstones.size, 1)
  const botLookup = cancelFirstSql.calls.findIndex((call) => call.text.includes("select bot_id from genio_one_distillation_markers"))
  const botLock = cancelFirstSql.calls.findIndex((call, index) => index > botLookup && call.text.includes("pg_advisory_xact_lock"))
  const markerLock = cancelFirstSql.calls.findIndex((call, index) => index > botLock && call.text.includes("for update"))
  assert.ok(botLookup >= 0)
  assert.ok(botLock > botLookup)
  assert.ok(markerLock > botLock)
})
