import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"

import type { CreateDistillationMarker } from "../src/capabilities/distillation/contract"
import { createPostgresDistillationStore } from "../src/capabilities/distillation/postgres"
import { runMigrations } from "../src/persistence/migration-runner"
import { createPostgresSqlAdapter } from "../src/persistence/sql-adapter"

const databaseUrl = process.env.GENIO_ONE_TEST_DATABASE_URL
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
    extractor_version: "timeline-visible-2",
    evidence: [],
    excerpt_truncated: false,
    ...overrides,
  }
}

test(
  "workspace ACL fence rejects an old marker writer and admits checked create and assignment",
  { skip: !databaseUrl, timeout: 30_000 },
  async () => {
    assert.ok(databaseUrl)
    const schema = `workspace_aclv${randomUUID().replaceAll("-", "")}`
    const options = { max: 1, onnotice: () => {} }
    const admin = createPostgresSqlAdapter({ url: databaseUrl, options })
    let sql: ReturnType<typeof createPostgresSqlAdapter> | undefined
    try {
      await admin.query(`create schema ${schema}`)
      sql = createPostgresSqlAdapter({ url: databaseUrl, options: { ...options, connection: { search_path: schema } } })
      await runMigrations(sql, { advisoryLockKey: schema })
      await sql.query(
        `insert into genio_one_organizations (tenant_id, organization_id, display_name, slug)
         values ($1, $2, $3, $4)`,
        ["tenant-fence", "organization-fence", "Fence", "fence"],
      )
      await sql.query(
        `insert into genio_one_team_workspaces
         (tenant_id, workspace_id, organization_id, display_name, reader_access_group_id,
          contributor_access_group_id, maintainer_access_group_id, created_at, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          "tenant-fence", "workspace-fence", "organization-fence", "Fence", "readers",
          "contributors", "maintainers", 100, "owner",
        ],
      )
      await assert.rejects(
        () => sql!.query(
          `insert into genio_one_distillation_markers
           (tenant_id, marker_id, owner_subject_id, bot_id, thread_id, turn_ids, source_revision,
            content_digest, scope_hint, sensitivity, knowledge_type, representation,
            classifier_version, extractor_version, evidence, excerpt_truncated, history_state,
            processing_state, attempts, not_before, workspace_id, last_error, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6::text::jsonb, $7, $8, $9, $10, $11, $12, $13, $14,
                   $15::text::jsonb, $16, $17, $18, $19, $20, $21, null, $22, $22)`,
          [
            "tenant-fence", "marker-old", "owner", "bot-1", "thread-old", JSON.stringify(["turn-old"]),
            digest, digest, "process", "standard", "PROCEDURE", "BOTH", "jev-distillation-1",
            "timeline-body-1", JSON.stringify([]), false, "READY", "PENDING", 0, 100,
            "workspace-fence", 100,
          ],
        ),
        (error: unknown) => error instanceof Error && error.message.includes("genio_one_distillation_markers_workspace_acl_check"),
      )

      const ids = ["unbound", "lease", "knowledge", "bound"]
      const store = createPostgresDistillationStore({ sql, now: () => 100, idFactory: () => ids.shift() ?? "next" })
      const unbound = await store.createMarker({
        tenantId: "tenant-fence",
        ownerSubjectId: "owner",
        contributorWorkspaceIds: [],
        value: markerInput(),
      })
      const claimed = await store.claim({ tenantId: "tenant-fence", ownerSubjectId: "owner", botId: "bot-1", leaseOwner: "worker" })
      assert.ok(claimed)
      const completed = await store.complete({
        tenantId: "tenant-fence",
        ownerSubjectId: "owner",
        markerId: unbound.marker_id,
        value: { lease_token: claimed.lease_token, outcome: "CANDIDATE_CREATED", content_digest: digest },
      })
      assert.ok(completed.candidate)
      await store.assignWorkspace({
        tenantId: "tenant-fence",
        actorSubjectId: "owner",
        knowledgeId: completed.candidate.knowledge_id,
        workspaceId: "workspace-fence",
        maintainerWorkspaceIds: ["workspace-fence"],
      })
      const assignedFence = await sql.query<{ workspace_acl_version: number | string }>(
        `select workspace_acl_version from genio_one_distillation_markers where tenant_id = $1 and marker_id = $2`,
        ["tenant-fence", unbound.marker_id],
      )
      assert.equal(Number(assignedFence.rows[0]?.workspace_acl_version), 1)

      const bound = await store.createMarker({
        tenantId: "tenant-fence",
        ownerSubjectId: "owner",
        contributorWorkspaceIds: ["workspace-fence"],
        value: markerInput({
          thread_id: "thread-bound",
          source_revision: "b".repeat(64),
          content_digest: "b".repeat(64),
          workspace_id: "workspace-fence",
        }),
      })
      const boundFence = await sql.query<{ workspace_acl_version: number | string }>(
        `select workspace_acl_version from genio_one_distillation_markers where tenant_id = $1 and marker_id = $2`,
        ["tenant-fence", bound.marker_id],
      )
      assert.equal(Number(boundFence.rows[0]?.workspace_acl_version), 1)
    } finally {
      await sql?.end()
      await admin.query(`drop schema if exists ${schema} cascade`)
      await admin.end()
    }
  },
)
