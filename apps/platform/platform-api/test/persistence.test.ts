import assert from "node:assert/strict"
import test from "node:test"

import { DISTILLATION_EXTRACTOR_VERSION } from "@genioone/protocol/distillation-triage"

import { PlatformApiError } from "../src/capabilities/errors"
import type { CreateDistillationMarker } from "../src/capabilities/distillation/contract"
import { createInMemoryDistillationStore } from "../src/capabilities/distillation/memory"
import { createPostgresDistillationStore } from "../src/capabilities/distillation/postgres"
import type { SqlAdapter, SqlQueryResult, SqlTransaction } from "../src/persistence/sql-adapter"
import {
  createMigration,
  loadMigrations,
  MigrationChecksumDriftError,
  runMigrations,
} from "../src/persistence/migration-runner"

type MigrationRow = { migration_id: number; name: string; checksum: string }

class FakeMigrationTransaction implements SqlTransaction {
  readonly queries: string[] = []
  readonly parameters: unknown[][] = []
  history: MigrationRow[]

  constructor(history: MigrationRow[] = []) {
    this.history = [...history]
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    parameters?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>> {
    this.queries.push(text)
    if (parameters) this.parameters.push([...parameters])
    if (text.includes("from schema_migrations")) {
      return { rows: this.history as unknown as Row[], rowCount: this.history.length }
    }
    if (text.trimStart().startsWith("insert into schema_migrations")) {
      const [migrationId, name, migrationChecksum] = parameters ?? []
      this.history.push({
        migration_id: Number(migrationId),
        name: String(name),
        checksum: String(migrationChecksum),
      })
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  }
}

class FakeMigrationAdapter implements SqlAdapter {
  readonly transactions: FakeMigrationTransaction[] = []
  readonly history: MigrationRow[]

  constructor(history: MigrationRow[] = []) {
    this.history = history
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    _text: string,
    _parameters?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>> {
    return { rows: [], rowCount: 0 }
  }

  async transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
    const transaction = new FakeMigrationTransaction(this.history)
    this.transactions.push(transaction)
    const value = await work(transaction)
    this.history.splice(0, this.history.length, ...transaction.history)
    return value
  }
}

const unboundCandidateRow: Record<string, unknown> = {
  tenant_id: "tenant-acme",
  knowledge_id: "knowledge-unbound",
  marker_id: "marker-unbound",
  owner_subject_id: "owner",
  workspace_id: null,
  scope: "process",
  knowledge_type: "PROCEDURE",
  representation: "BOTH",
  sensitivity: "standard",
  review_state: "PENDING_REVIEW",
  content_digest: "a".repeat(64),
  provenance: {
    bot_id: "bot-1",
    thread_id: "thread-1",
    turn_ids: ["turn-1"],
    source_revision: "a".repeat(64),
    classifier_version: "jev-distillation-1",
    extractor_version: DISTILLATION_EXTRACTOR_VERSION,
    evidence: [],
    excerpt_truncated: false,
  },
  reviewed_by: null,
  reviewed_at: null,
  created_at: 1_000,
  updated_at: 1_000,
}

class FakeDistillationAdapter implements SqlAdapter, SqlTransaction {
  readonly calls: Array<{ text: string; parameters: readonly unknown[] }> = []

  constructor(
    private readonly workspaceIds: readonly string[] = ["workspace-b"],
    private readonly candidateRow: Record<string, unknown> = unboundCandidateRow,
  ) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Row>> {
    this.calls.push({ text, parameters })
    if (text.includes("from genio_one_knowledge_candidates")) {
      return { rows: [this.candidateRow] as Row[], rowCount: 1 }
    }
    if (text.includes("from genio_one_team_workspaces")) {
      const workspaceId = String(parameters[1] ?? "")
      const rows = this.workspaceIds.includes(workspaceId)
        ? [{ workspace_id: workspaceId } as unknown as Row]
        : []
      return { rows, rowCount: rows.length }
    }
    return { rows: [], rowCount: 0 }
  }

  async transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
    return work(this)
  }
}

class FakeReviewConflictAdapter implements SqlAdapter {
  readonly calls: Array<{ text: string; parameters: readonly unknown[] }> = []

  constructor(private readonly candidateRow: Record<string, unknown>) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Row>> {
    this.calls.push({ text, parameters })
    if (text.trimStart().startsWith("update genio_one_knowledge_candidates")) {
      const workspaceIds = parameters[4]
      const matches = parameters[2] === this.candidateRow.workspace_id &&
        parameters[3] === this.candidateRow.updated_at &&
        Array.isArray(workspaceIds) &&
        workspaceIds.includes(this.candidateRow.workspace_id) &&
        this.candidateRow.review_state === "PENDING_REVIEW"
      return matches
        ? { rows: [this.candidateRow] as Row[], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    }
    if (text.includes("from genio_one_knowledge_candidates")) {
      return { rows: [this.candidateRow] as Row[], rowCount: 1 }
    }
    throw new Error(`Unexpected query: ${text}`)
  }

  async transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
    return work(this)
  }
}

function markerValue(workspaceId?: string): CreateDistillationMarker {
  return {
    bot_id: "bot-1",
    thread_id: "thread-1",
    turn_ids: ["turn-1"],
    source_revision: "a".repeat(64),
    content_digest: "a".repeat(64),
    scope_hint: "process",
    sensitivity: "standard",
    knowledge_type: "PROCEDURE",
    representation: "BOTH",
    classifier_version: "jev-distillation-1",
    extractor_version: "timeline-body-1",
    evidence: [],
    excerpt_truncated: false,
    ...(workspaceId ? { workspace_id: workspaceId } : {}),
  }
}

class FakeMarkerCreationAdapter implements SqlAdapter {
  readonly calls: Array<{ text: string; parameters: readonly unknown[] }> = []

  constructor(private readonly workspaceIds: readonly string[]) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Row>> {
    this.calls.push({ text, parameters })
    if (text.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 }
    if (text.includes("from genio_one_distillation_bot_tombstones")) return { rows: [], rowCount: 0 }
    if (text.includes("from genio_one_distillation_markers")) return { rows: [], rowCount: 0 }
    if (text.includes("from genio_one_team_workspaces")) {
      const workspaceId = String(parameters[1] ?? "")
      const rows = this.workspaceIds.includes(workspaceId)
        ? [{ workspace_id: workspaceId } as unknown as Row]
        : []
      return { rows, rowCount: rows.length }
    }
    throw new Error(`Unexpected query: ${text}`)
  }

  async transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
    return work(this)
  }
}

const crossVersionMarkerRow: Record<string, unknown> = {
  tenant_id: "tenant-acme",
  marker_id: "marker-v1",
  owner_subject_id: "owner",
  bot_id: "bot-1",
  thread_id: "thread-1",
  turn_ids: ["turn-1"],
  source_revision: "a".repeat(64),
  content_digest: "a".repeat(64),
  scope_hint: "process",
  sensitivity: "standard",
  knowledge_type: "PROCEDURE",
  representation: "BOTH",
  classifier_version: "jev-distillation-1",
  extractor_version: "timeline-body-1",
  evidence: [{ check_id: "retained", score: 0.9, threshold: 0.5, matched: true }],
  excerpt_truncated: false,
  history_state: "READY",
  processing_state: "PENDING",
  attempts: 0,
  not_before: 1_000,
  workspace_id: null,
  last_error: null,
  created_at: 1_000,
  updated_at: 1_000,
  lease_owner: null,
  lease_token: null,
  lease_until: null,
}

class FakeCrossVersionMarkerAdapter implements SqlAdapter {
  readonly calls: Array<{ text: string; parameters: readonly unknown[] }> = []
  private markerReads = 0

  constructor(private readonly deferExistingMarkerUntilAfterInsert: boolean) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Row>> {
    this.calls.push({ text, parameters })
    if (text.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 }
    if (text.includes("from genio_one_distillation_bot_tombstones")) return { rows: [], rowCount: 0 }
    if (text.trimStart().startsWith("select") && text.includes("from genio_one_distillation_markers")) {
      this.markerReads += 1
      const rows = this.deferExistingMarkerUntilAfterInsert && this.markerReads === 1
        ? []
        : [crossVersionMarkerRow as Row]
      return { rows, rowCount: rows.length }
    }
    if (text.trimStart().startsWith("insert into genio_one_distillation_markers")) {
      return { rows: [], rowCount: 0 }
    }
    throw new Error(`Unexpected query: ${text}`)
  }

  async transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
    return work(this)
  }
}

test("the clean-install baseline and ordered migrations encode the current Platform schema", async () => {
  const migrations = await loadMigrations()
  assert.deepEqual(migrations.map((migration) => migration.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  assert.equal(migrations[1].name, "gateway_activity_safety_decisions")
  assert.equal(migrations[2].name, "distillation_markers")
  assert.match(migrations[2].sql, /create table genio_one_distillation_markers/i)
  assert.equal(migrations[3].name, "team_workspaces")
  assert.match(migrations[3].sql, /create table genio_one_team_workspaces/i)
  assert.match(migrations[3].sql, /update genio_one_distillation_markers/i)
  assert.match(migrations[3].sql, /update genio_one_knowledge_candidates/i)
  assert.match(migrations[3].sql, /set workspace_id = null/i)
  assert.equal(migrations[4].name, "distillation_page_indexes")
  assert.match(
    migrations[4].sql,
    /create index genio_one_knowledge_candidates_owner_page_idx\s+on genio_one_knowledge_candidates \(tenant_id, owner_subject_id, created_at desc, knowledge_id asc\)/i,
  )
  assert.match(
    migrations[4].sql,
    /create index genio_one_distillation_markers_owner_page_idx\s+on genio_one_distillation_markers \(tenant_id, owner_subject_id, created_at desc, marker_id asc\)/i,
  )
  assert.equal(migrations[5].name, "knowledge_candidate_workspace_page_index")
  assert.match(
    migrations[5].sql,
    /create index genio_one_knowledge_candidates_workspace_page_idx\s+on genio_one_knowledge_candidates \(tenant_id, workspace_id, created_at desc, knowledge_id asc\)\s+where workspace_id is not null/i,
  )
  assert.match(migrations[1].sql, /add column if not exists safety_decisions jsonb/i)
  assert.equal(migrations[6].name, "distillation_bot_tombstones")
  assert.match(migrations[6].sql, /create table genio_one_distillation_bot_tombstones/i)
  assert.equal(migrations[7].name, "distillation_extractor_versions")
  assert.match(migrations[7].sql, /drop constraint genio_one_distillation_markers_classifier_check/i)
  assert.match(migrations[7].sql, /extractor_version in \('timeline-body-1', 'timeline-visible-2'\)/i)
  assert.equal(migrations[8].name, "distillation_cross_version_idempotency")
  const crossVersionUnique = migrations[8].sql
  assert.match(crossVersionUnique, /duplicate_count bigint/i)
  assert.match(crossVersionUnique, /having count\(\*\) > 1/i)
  assert.match(crossVersionUnique, /lock table genio_one_distillation_markers in share row exclusive mode/i)
  assert.match(
    crossVersionUnique,
    /unique \(tenant_id, owner_subject_id, bot_id, thread_id, source_revision\)/i,
  )
  assert.doesNotMatch(crossVersionUnique, /\b(update|delete|genio_one_knowledge_candidates)\b/i)
  assert.equal(migrations[9].name, "team_workspace_foreign_keys")
  const workspaceForeignKeys = migrations[9]
  assert.equal(workspaceForeignKeys.name, "team_workspace_foreign_keys")
  const workspaceIntegrity = workspaceForeignKeys.sql
  const lock = workspaceIntegrity.indexOf("lock table")
  const markerCleanup = workspaceIntegrity.indexOf("update genio_one_distillation_markers")
  const candidateCleanup = workspaceIntegrity.indexOf("update genio_one_knowledge_candidates")
  const markerWorkspaceFkey = workspaceIntegrity.indexOf("genio_one_distillation_markers_workspace_fkey")
  assert.ok(lock >= 0 && lock < markerCleanup && markerCleanup < candidateCleanup && candidateCleanup < markerWorkspaceFkey)
  assert.match(
    workspaceIntegrity,
    /lock table genio_one_distillation_markers, genio_one_knowledge_candidates, genio_one_team_workspaces\s+in share row exclusive mode/i,
  )
  assert.match(workspaceIntegrity, /update genio_one_distillation_markers[\s\S]*set workspace_id = null/i)
  assert.match(workspaceIntegrity, /update genio_one_knowledge_candidates[\s\S]*set workspace_id = null/i)
  assert.match(
    workspaceIntegrity,
    /add constraint genio_one_distillation_markers_workspace_fkey\s+foreign key \(tenant_id, workspace_id\)\s+references genio_one_team_workspaces \(tenant_id, workspace_id\)/i,
  )
  assert.match(
    workspaceIntegrity,
    /add constraint genio_one_knowledge_candidates_workspace_fkey\s+foreign key \(tenant_id, workspace_id\)\s+references genio_one_team_workspaces \(tenant_id, workspace_id\)/i,
  )
  assert.doesNotMatch(workspaceIntegrity, /cross_version_idempotency/i)
  assert.doesNotMatch(workspaceIntegrity, /delete from genio_one_(distillation_markers|knowledge_candidates)/i)
  assert.equal(migrations[10].name, "workspace_marker_acl_fence")
  const workspaceAclFence = migrations[10].sql
  assert.match(workspaceAclFence, /lock table genio_one_distillation_markers in share row exclusive mode/i)
  assert.match(workspaceAclFence, /add column workspace_acl_version integer not null default 0/i)
  assert.match(workspaceAclFence, /update genio_one_distillation_markers\s+set workspace_acl_version = 1\s+where workspace_id is not null/i)
  assert.match(
    workspaceAclFence,
    /add constraint genio_one_distillation_markers_workspace_acl_check\s+check \(workspace_id is null or workspace_acl_version = 1\)/i,
  )
  assert.doesNotMatch(workspaceAclFence, /genio_one_knowledge_candidates|genio_one_team_workspaces/i)
  assert.equal(migrations[0].id, 1)
  assert.equal(migrations[0].name, "platform_baseline")
  assert.match(migrations[0].checksum, /^[a-f0-9]{64}$/)

  const baseline = migrations[0].sql
  assert.equal(baseline.match(/^CREATE TABLE /gm)?.length, 75)
  assert.equal(baseline.match(/\bFOREIGN KEY \(/g)?.length, 87)
  assert.doesNotMatch(baseline, /^\s*(INSERT INTO|UPDATE|DELETE FROM|DROP TABLE|DROP COLUMN)\b/im)
  assert.doesNotMatch(baseline, /tenant_control_plane_authority/i)
  assert.doesNotMatch(
    baseline,
    /CREATE TABLE genio_one_platform_runtime_(commands|observed_states|report_history)\b/i,
  )

  for (const table of [
    "genio_one_organizations",
    "genio_one_subjects",
    "genio_one_resources",
    "genio_one_resource_connections",
    "genio_one_public_models",
    "genio_one_publications",
    "genio_one_gateway_policy_releases",
    "genio_one_platform_runtime_aggregate_commands",
    "genio_one_access_groups",
    "genio_one_access_group_revisions",
    "genio_one_policy_authoring_settings",
    "genio_one_policy_revisions",
    "genio_one_personal_password_credentials",
  ]) {
    assert.match(baseline, new RegExp(`CREATE TABLE ${table}\\b`))
  }

  assert.match(baseline, /grant_idempotency_key text/i)
  assert.match(baseline, /genio_one_entitlement_grant_idempotency_key_unique/i)
  assert.match(baseline, /require_distinct_reviewer boolean/i)
  assert.match(baseline, /published_by_subject_id text/i)
  assert.match(baseline, /provenance text not null/i)
  assert.match(baseline, /genio_one_gateway_authorization_audit_append_only/i)
})

test("migration runner applies once, skips matching history, and takes a transaction advisory lock", async () => {
  const migrations = [
    createMigration({ id: 1, name: "first", sql: "create table first (id integer);" }),
    createMigration({ id: 2, name: "second", sql: "create table second (id integer);" }),
  ]
  const adapter = new FakeMigrationAdapter()
  const first = await runMigrations(adapter, { migrations, advisoryLockKey: "test-lock" })
  assert.deepEqual(first, { applied: [1, 2], skipped: [] })
  assert.equal(adapter.transactions.length, 1)
  assert.ok(adapter.transactions[0].queries.some((query) => query.includes("pg_advisory_xact_lock")))
  assert.deepEqual(adapter.transactions[0].parameters[0], ["test-lock"])

  const second = await runMigrations(adapter, { migrations, advisoryLockKey: "test-lock" })
  assert.deepEqual(second, { applied: [], skipped: [1, 2] })
  assert.equal(adapter.transactions.length, 2)
})

test("migration runner rejects any applied migration byte or name drift", async () => {
  const migration = createMigration({ id: 1, name: "first", sql: "create table first (id integer);\n" })
  for (const history of [
    { migration_id: 1, name: "first", checksum: "not-the-file-checksum" },
    {
      migration_id: 1,
      name: "first",
      checksum: createMigration({ id: 1, name: "first", sql: `${migration.sql}\n` }).checksum,
    },
    { migration_id: 1, name: "legacy_first", checksum: migration.checksum },
  ]) {
    const adapter = new FakeMigrationAdapter([history])
    await assert.rejects(
      () => runMigrations(adapter, { migrations: [migration] }),
      (error: unknown) =>
        error instanceof MigrationChecksumDriftError &&
        error.migrationId === 1 &&
        error.expectedChecksum === history.checksum &&
        error.actualChecksum === migration.checksum,
    )
  }
})

test("Postgres assignment keeps an unbound candidate with its owner", async () => {
  const sql = new FakeDistillationAdapter()
  const store = createPostgresDistillationStore({ sql, now: () => 1_000 })
  await assert.rejects(
    () => store.assignWorkspace({
      tenantId: "tenant-acme",
      actorSubjectId: "other-maintainer",
      knowledgeId: "knowledge-unbound",
      workspaceId: "workspace-b",
      maintainerWorkspaceIds: ["workspace-b"],
    }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "KNOWLEDGE_CANDIDATE_OWNER_REQUIRED",
  )
  assert.equal(sql.calls.some((call) => call.text.includes("genio_one_team_workspaces")), true)
  assert.equal(sql.calls.some((call) => call.text.includes("update genio_one_knowledge_candidates")), false)
})

test("Postgres assignment preserves source authorization after a candidate closes", async () => {
  const closedCandidate = {
    ...unboundCandidateRow,
    workspace_id: "workspace-a",
    review_state: "APPROVED",
  }
  const unauthorizedSql = new FakeDistillationAdapter(["workspace-b"], closedCandidate)
  const unauthorizedStore = createPostgresDistillationStore({ sql: unauthorizedSql, now: () => 1_000 })
  await assert.rejects(
    () => unauthorizedStore.assignWorkspace({
      tenantId: "tenant-acme",
      actorSubjectId: "other-maintainer",
      knowledgeId: "knowledge-unbound",
      workspaceId: "workspace-b",
      maintainerWorkspaceIds: ["workspace-b"],
    }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "TEAM_WORKSPACE_MAINTAINER_REQUIRED" && error.statusCode === 403,
  )

  const authorizedSql = new FakeDistillationAdapter(["workspace-b"], closedCandidate)
  const authorizedStore = createPostgresDistillationStore({ sql: authorizedSql, now: () => 1_000 })
  await assert.rejects(
    () => authorizedStore.assignWorkspace({
      tenantId: "tenant-acme",
      actorSubjectId: "maintainer",
      knowledgeId: "knowledge-unbound",
      workspaceId: "workspace-b",
      maintainerWorkspaceIds: ["workspace-a", "workspace-b"],
    }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "KNOWLEDGE_REVIEW_CLOSED" && error.statusCode === 409,
  )
})

test("memory assignment preserves source authorization after a candidate closes", async () => {
  let sequence = 0
  const store = createInMemoryDistillationStore({ now: () => 1_000, idFactory: () => `${++sequence}` })
  const sourceWorkspace = await store.createWorkspace({
    tenantId: "tenant-acme",
    createdBy: "admin",
    value: {
      organization_id: "organization-1",
      display_name: "Source",
      reader_access_group_id: "source-readers",
      contributor_access_group_id: "source-contributors",
      maintainer_access_group_id: "source-maintainers",
    },
  })
  const destinationWorkspace = await store.createWorkspace({
    tenantId: "tenant-acme",
    createdBy: "admin",
    value: {
      organization_id: "organization-1",
      display_name: "Destination",
      reader_access_group_id: "destination-readers",
      contributor_access_group_id: "destination-contributors",
      maintainer_access_group_id: "destination-maintainers",
    },
  })
  const marker = await store.createMarker({
    tenantId: "tenant-acme",
    ownerSubjectId: "owner",
    value: markerValue(sourceWorkspace.workspace_id),
    contributorWorkspaceIds: [sourceWorkspace.workspace_id],
  })
  const claimed = await store.claim({
    tenantId: "tenant-acme",
    ownerSubjectId: "owner",
    botId: "bot-1",
    leaseOwner: "worker",
  })
  assert.ok(claimed)
  const completed = await store.complete({
    tenantId: "tenant-acme",
    ownerSubjectId: "owner",
    markerId: marker.marker_id,
    value: { lease_token: claimed.lease_token, outcome: "CANDIDATE_CREATED", content_digest: "a".repeat(64) },
  })
  assert.ok(completed.candidate)
  await store.reviewCandidate({
    tenantId: "tenant-acme",
    reviewerId: "source-maintainer",
    knowledgeId: completed.candidate.knowledge_id,
    decision: "APPROVE",
    maintainerWorkspaceIds: [sourceWorkspace.workspace_id],
    expectedWorkspaceId: sourceWorkspace.workspace_id,
    expectedUpdatedAt: completed.candidate.updated_at,
  })
  await assert.rejects(
    () => store.assignWorkspace({
      tenantId: "tenant-acme",
      actorSubjectId: "other-maintainer",
      knowledgeId: completed.candidate!.knowledge_id,
      workspaceId: destinationWorkspace.workspace_id,
      maintainerWorkspaceIds: [destinationWorkspace.workspace_id],
    }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "TEAM_WORKSPACE_MAINTAINER_REQUIRED" && error.statusCode === 403,
  )
  await assert.rejects(
    () => store.assignWorkspace({
      tenantId: "tenant-acme",
      actorSubjectId: "source-maintainer",
      knowledgeId: completed.candidate!.knowledge_id,
      workspaceId: destinationWorkspace.workspace_id,
      maintainerWorkspaceIds: [sourceWorkspace.workspace_id, destinationWorkspace.workspace_id],
    }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "KNOWLEDGE_REVIEW_CLOSED" && error.statusCode === 409,
  )
})

test("Postgres review preserves maintainer authorization after a candidate closes", async () => {
  const closedCandidate = {
    ...unboundCandidateRow,
    workspace_id: "workspace-a",
    review_state: "APPROVED",
  }
  const unauthorizedSql = new FakeDistillationAdapter([], closedCandidate)
  const unauthorizedStore = createPostgresDistillationStore({ sql: unauthorizedSql, now: () => 1_000 })
  await assert.rejects(
    () => unauthorizedStore.reviewCandidate({
      tenantId: "tenant-acme",
      reviewerId: "other-maintainer",
      knowledgeId: "knowledge-unbound",
      decision: "APPROVE",
      maintainerWorkspaceIds: [],
      expectedWorkspaceId: "workspace-a",
      expectedUpdatedAt: 1_000,
    }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "TEAM_WORKSPACE_MAINTAINER_REQUIRED" && error.statusCode === 403,
  )

  const authorizedSql = new FakeDistillationAdapter([], closedCandidate)
  const authorizedStore = createPostgresDistillationStore({ sql: authorizedSql, now: () => 1_000 })
  await assert.rejects(
    () => authorizedStore.reviewCandidate({
      tenantId: "tenant-acme",
      reviewerId: "maintainer",
      knowledgeId: "knowledge-unbound",
      decision: "APPROVE",
      maintainerWorkspaceIds: ["workspace-a"],
      expectedWorkspaceId: "workspace-a",
      expectedUpdatedAt: 1_000,
    }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "KNOWLEDGE_REVIEW_CLOSED" && error.statusCode === 409,
  )
})

test("memory and Postgres reject a review when its verified workspace version changes", async () => {
  let clock = 1_000
  let sequence = 0
  const memory = createInMemoryDistillationStore({ now: () => clock, idFactory: () => `${++sequence}` })
  const source = await memory.createWorkspace({
    tenantId: "tenant-acme",
    createdBy: "admin",
    value: {
      organization_id: "organization-1",
      display_name: "Source",
      reader_access_group_id: "source-readers",
      contributor_access_group_id: "source-contributors",
      maintainer_access_group_id: "source-maintainers",
    },
  })
  const destination = await memory.createWorkspace({
    tenantId: "tenant-acme",
    createdBy: "admin",
    value: {
      organization_id: "organization-1",
      display_name: "Destination",
      reader_access_group_id: "destination-readers",
      contributor_access_group_id: "destination-contributors",
      maintainer_access_group_id: "destination-maintainers",
    },
  })
  const marker = await memory.createMarker({
    tenantId: "tenant-acme",
    ownerSubjectId: "owner",
    value: markerValue(source.workspace_id),
    contributorWorkspaceIds: [source.workspace_id],
  })
  const claimed = await memory.claim({
    tenantId: "tenant-acme",
    ownerSubjectId: "owner",
    botId: "bot-1",
    leaseOwner: "worker",
  })
  assert.ok(claimed)
  const completed = await memory.complete({
    tenantId: "tenant-acme",
    ownerSubjectId: "owner",
    markerId: marker.marker_id,
    value: { lease_token: claimed.lease_token, outcome: "CANDIDATE_CREATED", content_digest: "a".repeat(64) },
  })
  assert.ok(completed.candidate)
  const verified = completed.candidate
  clock = 1_001
  await memory.assignWorkspace({
    tenantId: "tenant-acme",
    actorSubjectId: "maintainer",
    knowledgeId: verified.knowledge_id,
    workspaceId: destination.workspace_id,
    maintainerWorkspaceIds: [source.workspace_id, destination.workspace_id],
  })
  clock = 1_002
  const reassigned = await memory.assignWorkspace({
    tenantId: "tenant-acme",
    actorSubjectId: "maintainer",
    knowledgeId: verified.knowledge_id,
    workspaceId: source.workspace_id,
    maintainerWorkspaceIds: [source.workspace_id, destination.workspace_id],
  })
  assert.equal(reassigned.workspace_id, source.workspace_id)
  assert.equal(reassigned.updated_at, 1_002)
  await assert.rejects(
    () => memory.reviewCandidate({
      tenantId: "tenant-acme",
      reviewerId: "maintainer",
      knowledgeId: verified.knowledge_id,
      decision: "APPROVE",
      maintainerWorkspaceIds: [source.workspace_id, destination.workspace_id],
      expectedWorkspaceId: verified.workspace_id!,
      expectedUpdatedAt: verified.updated_at,
    }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "KNOWLEDGE_EVIDENCE_CHANGED" && error.statusCode === 409,
  )

  const postgresSql = new FakeReviewConflictAdapter({
    ...unboundCandidateRow,
    workspace_id: source.workspace_id,
    updated_at: 1_002,
  })
  const postgres = createPostgresDistillationStore({ sql: postgresSql, now: () => 1_003 })
  await assert.rejects(
    () => postgres.reviewCandidate({
      tenantId: "tenant-acme",
      reviewerId: "maintainer",
      knowledgeId: "knowledge-unbound",
      decision: "APPROVE",
      maintainerWorkspaceIds: [source.workspace_id, destination.workspace_id],
      expectedWorkspaceId: source.workspace_id,
      expectedUpdatedAt: 1_000,
    }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "KNOWLEDGE_EVIDENCE_CHANGED" && error.statusCode === 409,
  )
  const update = postgresSql.calls.find((call) => call.text.trimStart().startsWith("update genio_one_knowledge_candidates"))
  assert.ok(update)
  assert.match(update.text, /workspace_id = \$3/i)
  assert.match(update.text, /updated_at = \$4/i)
  assert.deepEqual(update.parameters.slice(2, 5), [source.workspace_id, 1_000, [source.workspace_id, destination.workspace_id]])
})

test("memory assignment distinguishes missing destinations from denied maintainers", async () => {
  let sequence = 0
  const store = createInMemoryDistillationStore({ now: () => 1_000, idFactory: () => `${++sequence}` })
  const workspace = await store.createWorkspace({
    tenantId: "tenant-acme",
    createdBy: "admin",
    value: {
      organization_id: "organization-1",
      display_name: "Destination",
      reader_access_group_id: "readers",
      contributor_access_group_id: "contributors",
      maintainer_access_group_id: "maintainers",
    },
  })
  const marker = await store.createMarker({
    tenantId: "tenant-acme",
    ownerSubjectId: "owner",
    value: markerValue(),
    contributorWorkspaceIds: [],
  })
  const claimed = await store.claim({
    tenantId: "tenant-acme",
    ownerSubjectId: "owner",
    botId: "bot-1",
    leaseOwner: "worker",
  })
  assert.ok(claimed)
  const completed = await store.complete({
    tenantId: "tenant-acme",
    ownerSubjectId: "owner",
    markerId: marker.marker_id,
    value: { lease_token: claimed.lease_token, outcome: "CANDIDATE_CREATED", content_digest: "a".repeat(64) },
  })
  assert.ok(completed.candidate)
  await assert.rejects(
    () => store.assignWorkspace({
      tenantId: "tenant-acme",
      actorSubjectId: "owner",
      knowledgeId: completed.candidate!.knowledge_id,
      workspaceId: "workspace-missing",
      maintainerWorkspaceIds: [],
    }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "TEAM_WORKSPACE_NOT_FOUND" && error.statusCode === 422,
  )
  await assert.rejects(
    () => store.assignWorkspace({
      tenantId: "tenant-acme",
      actorSubjectId: "owner",
      knowledgeId: completed.candidate!.knowledge_id,
      workspaceId: workspace.workspace_id,
      maintainerWorkspaceIds: [],
    }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "TEAM_WORKSPACE_MAINTAINER_REQUIRED" && error.statusCode === 403,
  )
})

test("Postgres assignment distinguishes missing destinations from denied maintainers", async () => {
  const missingSql = new FakeDistillationAdapter([])
  const missingStore = createPostgresDistillationStore({ sql: missingSql, now: () => 1_000 })
  await assert.rejects(
    () => missingStore.assignWorkspace({
      tenantId: "tenant-acme",
      actorSubjectId: "owner",
      knowledgeId: "knowledge-unbound",
      workspaceId: "workspace-missing",
      maintainerWorkspaceIds: [],
    }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "TEAM_WORKSPACE_NOT_FOUND" && error.statusCode === 422,
  )
  assert.match(missingSql.calls[0]!.text, /from genio_one_team_workspaces/i)
  assert.equal(missingSql.calls.some((call) => call.text.includes("genio_one_knowledge_candidates")), false)
  assert.equal(missingSql.calls.some((call) => call.text.includes("update genio_one_knowledge_candidates")), false)

  const unauthorizedSql = new FakeDistillationAdapter(["workspace-b"])
  const unauthorizedStore = createPostgresDistillationStore({ sql: unauthorizedSql, now: () => 1_000 })
  await assert.rejects(
    () => unauthorizedStore.assignWorkspace({
      tenantId: "tenant-acme",
      actorSubjectId: "owner",
      knowledgeId: "knowledge-unbound",
      workspaceId: "workspace-b",
      maintainerWorkspaceIds: [],
    }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "TEAM_WORKSPACE_MAINTAINER_REQUIRED" && error.statusCode === 403,
  )
  assert.match(unauthorizedSql.calls[0]!.text, /from genio_one_team_workspaces/i)
  assert.equal(unauthorizedSql.calls.some((call) => call.text.includes("genio_one_knowledge_candidates")), false)
  assert.equal(unauthorizedSql.calls.some((call) => call.text.includes("update genio_one_knowledge_candidates")), false)
})

test("Postgres marker creation checks workspace existence before contributor access", async () => {
  const missingSql = new FakeMarkerCreationAdapter([])
  const missingStore = createPostgresDistillationStore({ sql: missingSql, now: () => 1_000 })
  await assert.rejects(
    () => missingStore.createMarker({
      tenantId: "tenant-acme",
      ownerSubjectId: "owner",
      value: markerValue("workspace-missing"),
      contributorWorkspaceIds: [],
    }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "TEAM_WORKSPACE_NOT_FOUND",
  )
  assert.match(missingSql.calls[0]!.text, /pg_advisory_xact_lock/i)
  assert.match(missingSql.calls[1]!.text, /from genio_one_distillation_bot_tombstones/i)
  assert.match(missingSql.calls[2]!.text, /from genio_one_distillation_markers/i)
  assert.match(missingSql.calls[3]!.text, /from genio_one_team_workspaces/i)

  const unauthorizedSql = new FakeMarkerCreationAdapter(["workspace-existing"])
  const unauthorizedStore = createPostgresDistillationStore({ sql: unauthorizedSql, now: () => 1_000 })
  await assert.rejects(
    () => unauthorizedStore.createMarker({
      tenantId: "tenant-acme",
      ownerSubjectId: "owner",
      value: markerValue("workspace-existing"),
      contributorWorkspaceIds: [],
    }),
    (error: unknown) => error instanceof PlatformApiError && error.code === "TEAM_WORKSPACE_CONTRIBUTOR_REQUIRED",
  )
  assert.match(unauthorizedSql.calls[0]!.text, /pg_advisory_xact_lock/i)
  assert.match(unauthorizedSql.calls[1]!.text, /from genio_one_distillation_bot_tombstones/i)
  assert.match(unauthorizedSql.calls[2]!.text, /from genio_one_distillation_markers/i)
  assert.match(unauthorizedSql.calls[3]!.text, /from genio_one_team_workspaces/i)
  assert.equal(unauthorizedSql.calls.some((call) => call.text.includes("insert into genio_one_distillation_markers")), false)
})

test("memory and Postgres marker creation retain v1 evidence across a v2 retry", async () => {
  const v1: CreateDistillationMarker = {
    ...markerValue(),
    evidence: [{ check_id: "retained", score: 0.9, threshold: 0.5, matched: true }],
  }
  const v2: CreateDistillationMarker = { ...v1, extractor_version: "timeline-visible-2", evidence: [] }
  const memory = createInMemoryDistillationStore({ now: () => 1_000, idFactory: () => "memory" })
  const memoryFirst = await memory.createMarker({
    tenantId: "tenant-acme",
    ownerSubjectId: "owner",
    value: v1,
    contributorWorkspaceIds: [],
  })
  const memoryRetry = await memory.createMarker({
    tenantId: "tenant-acme",
    ownerSubjectId: "owner",
    value: v2,
    contributorWorkspaceIds: [],
  })
  assert.equal(memoryRetry.marker_id, memoryFirst.marker_id)
  assert.equal(memoryRetry.extractor_version, "timeline-body-1")
  assert.deepEqual(memoryRetry.evidence, v1.evidence)

  const sql = new FakeCrossVersionMarkerAdapter(true)
  const postgres = createPostgresDistillationStore({ sql, now: () => 1_000 })
  const postgresRetry = await postgres.createMarker({
    tenantId: "tenant-acme",
    ownerSubjectId: "owner",
    value: v2,
    contributorWorkspaceIds: [],
  })
  assert.equal(postgresRetry.marker_id, "marker-v1")
  assert.equal(postgresRetry.extractor_version, "timeline-body-1")
  assert.deepEqual(postgresRetry.evidence, v1.evidence)

  const reads = sql.calls.filter((call) =>
    call.text.trimStart().startsWith("select") && call.text.includes("from genio_one_distillation_markers"),
  )
  assert.equal(reads.length, 2)
  for (const read of reads) {
    assert.doesNotMatch(read.text, /extractor_version\s*=/i)
    assert.deepEqual(read.parameters, ["tenant-acme", "owner", "bot-1", "thread-1", "a".repeat(64)])
  }
  const insert = sql.calls.find((call) => call.text.trimStart().startsWith("insert into genio_one_distillation_markers"))
  assert.ok(insert)
  assert.match(insert.text, /on conflict\s+do nothing/i)
  assert.doesNotMatch(insert.text, /on conflict\s*\(/i)
})
