import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"

import type { CreateDistillationMarker } from "../src/capabilities/distillation/contract"
import { createPostgresDistillationStore } from "../src/capabilities/distillation/postgres"
import { runMigrations } from "../src/persistence/migration-runner"
import { createPostgresSqlAdapter } from "../src/persistence/sql-adapter"

const databaseUrl = process.env.GENIO_ONE_TEST_DATABASE_URL
const digest = "a".repeat(64)

function markerInput(): CreateDistillationMarker {
  return {
    bot_id: "bot-jsonb",
    thread_id: "thread-jsonb",
    turn_ids: ["turn-1", "turn-2"],
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
  }
}

test("PostgreSQL distillation persists marker arrays and candidate provenance as JSON values", { skip: !databaseUrl, timeout: 30_000 }, async () => {
  assert.ok(databaseUrl)
  const schema = `distillation_jsonb_${randomUUID().replaceAll("-", "")}`
  const admin = createPostgresSqlAdapter({ url: databaseUrl, options: { max: 1, onnotice: () => {} } })
  const sql = createPostgresSqlAdapter({
    url: databaseUrl,
    options: { max: 1, connection: { search_path: schema }, onnotice: () => {} },
  })
  let nextId = 0
  try {
    await admin.query(`create schema ${schema}`)
    await runMigrations(sql, { advisoryLockKey: schema })
    const store = createPostgresDistillationStore({
      sql,
      now: () => 1_000,
      idFactory: () => String(++nextId),
    })
    const marker = await store.createMarker({
      tenantId: "tenant-jsonb",
      ownerSubjectId: "owner-jsonb",
      contributorWorkspaceIds: [],
      value: markerInput(),
    })
    const markerKinds = await sql.query<{ turn_kind: string; evidence_kind: string }>(
      `select jsonb_typeof(turn_ids) as turn_kind, jsonb_typeof(evidence) as evidence_kind
        from genio_one_distillation_markers
        where tenant_id = $1 and marker_id = $2`,
      [marker.tenant_id, marker.marker_id],
    )
    assert.deepEqual(markerKinds.rows[0], { turn_kind: "array", evidence_kind: "array" })
    const claimed = await store.claim({
      tenantId: marker.tenant_id,
      ownerSubjectId: marker.owner_subject_id,
      botId: marker.bot_id,
      leaseOwner: "worker-jsonb",
    })
    assert.ok(claimed)
    const completed = await store.complete({
      tenantId: marker.tenant_id,
      ownerSubjectId: marker.owner_subject_id,
      markerId: marker.marker_id,
      value: {
        lease_token: claimed.lease_token,
        outcome: "CANDIDATE_CREATED",
        content_digest: marker.content_digest,
      },
    })
    assert.ok(completed.candidate)
    const candidateKinds = await sql.query<{ provenance_kind: string }>(
      `select jsonb_typeof(provenance) as provenance_kind
        from genio_one_knowledge_candidates
        where tenant_id = $1 and knowledge_id = $2`,
      [marker.tenant_id, completed.candidate.knowledge_id],
    )
    assert.deepEqual(candidateKinds.rows[0], { provenance_kind: "object" })
  } finally {
    await sql.end()
    await admin.query(`drop schema if exists ${schema} cascade`)
    await admin.end()
  }
})

test("PostgreSQL exposes a marker exhausted by abandoned leases as a terminal status", { skip: !databaseUrl, timeout: 30_000 }, async () => {
  assert.ok(databaseUrl)
  const schema = `distillation_exhausted_${randomUUID().replaceAll("-", "")}`
  const admin = createPostgresSqlAdapter({ url: databaseUrl, options: { max: 1, onnotice: () => {} } })
  const sql = createPostgresSqlAdapter({
    url: databaseUrl,
    options: { max: 1, connection: { search_path: schema }, onnotice: () => {} },
  })
  let clock = 1_000
  let nextId = 0
  try {
    await admin.query(`create schema ${schema}`)
    await runMigrations(sql, { advisoryLockKey: schema })
    const store = createPostgresDistillationStore({ sql, now: () => clock, idFactory: () => String(++nextId) })
    const marker = await store.createMarker({ tenantId: "tenant-jsonb", ownerSubjectId: "owner-jsonb", value: markerInput(), contributorWorkspaceIds: [] })
    const claimInput = { tenantId: marker.tenant_id, ownerSubjectId: marker.owner_subject_id, botId: marker.bot_id, leaseOwner: "worker" }
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      assert.equal((await store.claim(claimInput))?.marker_id, marker.marker_id)
      clock += 61
    }
    assert.equal(await store.claim(claimInput), null)
    const status = await store.getMarker({ tenantId: marker.tenant_id, ownerSubjectId: marker.owner_subject_id, markerId: marker.marker_id })
    assert.equal(status.processing_state, "FAILED")
    assert.equal(status.last_error, "DISTILLATION_ATTEMPTS_EXHAUSTED")
    await assert.rejects(
      store.getMarker({ tenantId: marker.tenant_id, ownerSubjectId: "someone-else", markerId: marker.marker_id }),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 404,
    )
  } finally {
    await sql.end()
    await admin.query(`drop schema if exists ${schema} cascade`)
    await admin.end()
  }
})

test("PostgreSQL candidate pages merge owner and workspace access without duplicates or omissions", { skip: !databaseUrl, timeout: 30_000 }, async () => {
  assert.ok(databaseUrl)
  const schema = `distillation_pages_${randomUUID().replaceAll("-", "")}`
  const admin = createPostgresSqlAdapter({ url: databaseUrl, options: { max: 1, onnotice: () => {} } })
  const sql = createPostgresSqlAdapter({
    url: databaseUrl,
    options: { max: 1, connection: { search_path: schema }, onnotice: () => {} },
  })
  let clock = 1_000
  let nextId = 0
  try {
    await admin.query(`create schema ${schema}`)
    await runMigrations(sql, { advisoryLockKey: schema })
    const store = createPostgresDistillationStore({ sql, now: () => clock, idFactory: () => String(++nextId).padStart(4, "0") })
    for (const tenantId of ["tenant-pages", "tenant-other"]) {
      await sql.query(
        `insert into genio_one_organizations (tenant_id, organization_id, display_name, slug)
          values ($1, 'organization-pages', 'Pages', 'pages')`,
        [tenantId],
      )
      for (const accessGroupId of ["readers", "contributors", "maintainers"]) {
        await sql.query(
          `insert into genio_one_access_groups (tenant_id, access_group_id, organization_id, revision, value)
            values ($1, $2, 'organization-pages', 1, $3::text::jsonb)`,
          [tenantId, accessGroupId, JSON.stringify({ tenant_id: tenantId, access_group_id: accessGroupId, organization_id: "organization-pages", revision: 1 })],
        )
      }
      for (const workspaceId of ["workspace-a", "workspace-b", "workspace-private"]) {
        await sql.query(
          `insert into genio_one_team_workspaces
            (tenant_id, workspace_id, organization_id, display_name, reader_access_group_id,
             contributor_access_group_id, maintainer_access_group_id, created_at, created_by)
            values ($1, $2, 'organization-pages', $2, 'readers', 'contributors', 'maintainers', 1000, 'owner')`,
          [tenantId, workspaceId],
        )
      }
      for (let index = 0; index < 36; index += 1) {
        clock = 1_000 + Math.floor(index / 6)
        const ownerSubjectId = index % 3 === 0 ? "owner-pages" : "someone-else"
        const workspaceId = [null, "workspace-a", "workspace-b", "workspace-private"][index % 4]!
        const marker = await store.createMarker({
          tenantId,
          ownerSubjectId,
          contributorWorkspaceIds: workspaceId ? [workspaceId] : [],
          value: { ...markerInput(), thread_id: `thread-${index}`, workspace_id: workspaceId ?? undefined },
        })
        const claimed = await store.claim({ tenantId, ownerSubjectId, botId: marker.bot_id, leaseOwner: "worker-pages" })
        assert.ok(claimed)
        await store.complete({
          tenantId,
          ownerSubjectId,
          markerId: marker.marker_id,
          value: { lease_token: claimed.lease_token, outcome: "CANDIDATE_CREATED", content_digest: digest },
        })
      }
    }
    for (const ownerSubjectId of ["owner-pages", "absent-owner"]) {
      for (const workspaceIds of [[], ["workspace-a"], ["workspace-a", "workspace-b", "workspace-a"], ["missing-workspace"]]) {
        const expected = await sql.query<{ knowledge_id: string }>(
          `select knowledge_id from genio_one_knowledge_candidates
            where tenant_id = $1 and (owner_subject_id = $2 or workspace_id = any($3::text[]))
            order by created_at desc, knowledge_id asc`,
          ["tenant-pages", ownerSubjectId, workspaceIds],
        )
        for (const limit of [1, 2, 4, 7, 100]) {
          const ids: string[] = []
          let cursor: string | undefined
          do {
            const page = await store.listCandidates({ tenantId: "tenant-pages", ownerSubjectId, workspaceIds, limit, cursor })
            assert.ok(page.candidates.length <= limit)
            assert.ok(page.candidates.every((candidate) => candidate.tenant_id === "tenant-pages"))
            ids.push(...page.candidates.map((candidate) => candidate.knowledge_id))
            assert.ok(ids.length <= expected.rows.length)
            cursor = page.next_cursor ?? undefined
          } while (cursor)
          assert.deepEqual(ids, expected.rows.map((candidate) => candidate.knowledge_id), JSON.stringify({ ownerSubjectId, workspaceIds, limit }))
          assert.equal(new Set(ids).size, ids.length)
        }
      }
    }
  } finally {
    await sql.end()
    await admin.query(`drop schema if exists ${schema} cascade`)
    await admin.end()
  }
})
