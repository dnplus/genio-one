import assert from "node:assert/strict"
import test from "node:test"

import { PlatformApiError } from "../src/capabilities/errors"
import type { CreateDistillationMarker } from "../src/capabilities/distillation/contract"
import { createPostgresDistillationStore } from "../src/capabilities/distillation/postgres"
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
    extractor_version: "timeline-body-1",
    evidence: [{ check_id: "relevant", score: 0.9, threshold: 0.7, matched: true }],
    excerpt_truncated: false,
    ...overrides,
  }
}

type Row = Record<string, unknown>

class IdempotencyReadbackSql implements SqlAdapter, SqlTransaction {
  readonly calls: Array<{ text: string; parameters: readonly unknown[] }> = []
  private markerReads = 0

  constructor(private readonly firstMarkerReadMiss = false) {}

  readonly row: Row = {
    tenant_id: "tenant",
    marker_id: "marker-existing",
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
    evidence: "[{\"check_id\":\"relevant\",\"score\":0.9,\"threshold\":0.7,\"matched\":true}]",
    excerpt_truncated: false,
    history_state: "READY",
    processing_state: "CANDIDATE_CREATED",
    attempts: 1,
    not_before: 1_000,
    workspace_id: "workspace-1",
    last_error: null,
    created_at: 1_000,
    updated_at: 1_000,
    lease_owner: null,
    lease_token: "lease-existing",
    lease_until: null,
  }

  async query<Result extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Result>> {
    this.calls.push({ text, parameters })
    if (text.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 }
    if (text.includes("from genio_one_distillation_bot_tombstones")) return { rows: [], rowCount: 0 }
    if (text.includes("from genio_one_team_workspaces")) {
      return { rows: [{ workspace_id: parameters[1] } as unknown as Result], rowCount: 1 }
    }
    if (text.includes("insert into genio_one_distillation_markers")) return { rows: [], rowCount: 0 }
    if (text.includes("from genio_one_distillation_markers")) {
      this.markerReads += 1
      if (this.firstMarkerReadMiss && this.markerReads === 1) return { rows: [], rowCount: 0 }
      return { rows: [this.row as Result], rowCount: 1 }
    }
    throw new Error(`Unexpected query: ${text}`)
  }

  async transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
    return work(this)
  }
}

test("Postgres idempotency lookup accepts compatible cross-version replays and rejects changed raw payload", async () => {
  const sql = new IdempotencyReadbackSql()
  const before = structuredClone(sql.row)
  const store = createPostgresDistillationStore({ sql, now: () => 1_000, idFactory: () => "new" })
  const exactReplay = await store.createMarker({
    tenantId: "tenant",
    ownerSubjectId: "owner",
    contributorWorkspaceIds: ["workspace-1", "workspace-reassigned"],
    value: markerInput({ workspace_id: "workspace-1" }),
  })
  assert.equal(exactReplay.marker_id, "marker-existing")
  const workspaceReplay = await store.createMarker({
    tenantId: "tenant",
    ownerSubjectId: "owner",
    contributorWorkspaceIds: ["workspace-1", "workspace-reassigned"],
    value: markerInput({ workspace_id: "workspace-reassigned" }),
  })
  assert.equal(workspaceReplay.marker_id, "marker-existing")
  const crossVersionReplay = await store.createMarker({
    tenantId: "tenant",
    ownerSubjectId: "owner",
    contributorWorkspaceIds: ["workspace-1", "workspace-reassigned"],
    value: markerInput({
      workspace_id: "workspace-reassigned",
      extractor_version: "timeline-visible-2",
      evidence: [{ check_id: "changed", score: 0.1, threshold: 0.9, matched: false }],
    }),
  })
  assert.equal(crossVersionReplay.marker_id, "marker-existing")
  for (const value of [
    markerInput({ workspace_id: "workspace-1", content_digest: "b".repeat(64) }),
    markerInput({ workspace_id: "workspace-1", turn_ids: ["turn-2"] }),
    markerInput({ workspace_id: "workspace-1", representation: "HUMAN" }),
    markerInput({ workspace_id: "workspace-1", extractor_version: "timeline-visible-2", content_digest: "b".repeat(64) }),
    markerInput({ workspace_id: "workspace-1", extractor_version: "timeline-visible-2", turn_ids: ["turn-2"] }),
    markerInput({ workspace_id: "workspace-1", extractor_version: "timeline-visible-2", scope_hint: "customer_project" }),
    markerInput({ workspace_id: "workspace-1", extractor_version: "timeline-visible-2", sensitivity: "restricted" }),
    markerInput({ workspace_id: "workspace-1", extractor_version: "timeline-visible-2", representation: "HUMAN" }),
    markerInput({ workspace_id: "workspace-1", extractor_version: "timeline-visible-2", excerpt_truncated: true }),
    markerInput({ workspace_id: "workspace-1", extractor_version: "timeline-visible-2", knowledge_type: "FACT" }),
  ]) {
    await assert.rejects(
      () => store.createMarker({ tenantId: "tenant", ownerSubjectId: "owner", contributorWorkspaceIds: ["workspace-1", "workspace-reassigned"], value }),
      (error: unknown) => error instanceof PlatformApiError && error.code === "DISTILLATION_MARKER_CONFLICT",
    )
  }
  assert.deepEqual(sql.row, before)
  assert.equal(sql.calls.filter((call) => call.text.includes("insert into genio_one_distillation_markers")).length, 0)
  assert.equal(sql.calls.filter((call) => call.text.includes("from genio_one_distillation_markers")).length, 13)
})

test("Postgres targetless conflict falls back to the cross-version marker key", async () => {
  const sql = new IdempotencyReadbackSql(true)
  const store = createPostgresDistillationStore({ sql, now: () => 1_000, idFactory: () => "new" })
  const replay = await store.createMarker({
    tenantId: "tenant",
    ownerSubjectId: "owner",
    contributorWorkspaceIds: ["workspace-1", "workspace-reassigned"],
    value: markerInput({ workspace_id: "workspace-reassigned", extractor_version: "timeline-visible-2" }),
  })
  assert.equal(replay.marker_id, "marker-existing")
  const insert = sql.calls.find((call) => call.text.includes("insert into genio_one_distillation_markers"))
  assert.ok(insert)
  assert.match(insert.text, /on conflict do nothing/i)
  assert.equal(insert.parameters.at(-1), 1)
  assert.equal(sql.calls.filter((call) => call.text.includes("from genio_one_distillation_markers")).length, 2)
})
