import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"

import { loadMigrations, runMigrations } from "../src/persistence/migration-runner"
import { createPostgresSqlAdapter } from "../src/persistence/sql-adapter"

const databaseUrl = process.env.GENIO_ONE_TEST_DATABASE_URL

type Scope = "PERSONAL" | "TEAM" | "ORGANIZATION"

interface Target {
  scope: Scope
  ownerSubjectId: string | null
  teamId: string | null
  organizationId: string | null
}

interface ProposalInput {
  tenantId: string
  proposalId: string
  memoryId: string
  target: Target
  status?: "PENDING" | "ACCEPTED" | "REJECTED" | "STALE"
  baseRevision?: number
  proposedContent?: string | null
  reviewerSubjectId?: string | null
  resolvedAt?: number | null
  sourceAgentId?: string | null
  sourceAgentGrantId?: string | null
  idempotencyKeyDigest?: string
  requestDigest?: string
}

function targetKey(target: Target): string {
  return JSON.stringify([
    target.scope,
    target.ownerSubjectId,
    target.teamId,
    target.organizationId,
  ])
}

function digest(character: string): string {
  return character.repeat(64)
}

async function seedOrganization(
  sql: ReturnType<typeof createPostgresSqlAdapter>,
  tenantId: string,
  organizationId: string,
): Promise<void> {
  await sql.query(
    `insert into genio_one_organizations (tenant_id, organization_id, display_name, slug)
     values ($1, $2, $3, $4)`,
    [tenantId, organizationId, organizationId, organizationId],
  )
}

async function seedTeamWorkspace(
  sql: ReturnType<typeof createPostgresSqlAdapter>,
  tenantId: string,
  organizationId: string,
  workspaceId: string,
): Promise<void> {
  const accessGroupIds = ["readers", "contributors", "maintainers"].map((role) => `${workspaceId}-${role}`)
  for (const accessGroupId of accessGroupIds) {
    await sql.query(
      `insert into genio_one_access_groups
        (tenant_id, access_group_id, organization_id, revision, value)
       values ($1, $2, $3, 1, $4::text::jsonb)`,
      [
        tenantId,
        accessGroupId,
        organizationId,
        JSON.stringify({
          tenant_id: tenantId,
          organization_id: organizationId,
          access_group_id: accessGroupId,
          revision: 1,
        }),
      ],
    )
  }
  await sql.query(
    `insert into genio_one_team_workspaces
      (tenant_id, workspace_id, organization_id, display_name, reader_access_group_id,
       contributor_access_group_id, maintainer_access_group_id, created_at, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, 100, 'person-source')`,
    [tenantId, workspaceId, organizationId, workspaceId, ...accessGroupIds],
  )
}

async function insertMemory(
  sql: ReturnType<typeof createPostgresSqlAdapter>,
  input: { tenantId: string; memoryId: string; target: Target; content?: string },
): Promise<void> {
  await sql.query(
    `insert into genio_one_shared_memories
      (tenant_id, memory_id, scope, scope_target_key, owner_subject_id, team_id,
       organization_id, memory_key, kind, context_kind, context_id, context_key,
       content, assertion_origin, source_actor_subject_id, source_client_id,
       source_agent_id, source_agent_grant_id, source_reference_id, revision,
       created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'fact', 'GLOBAL', null, $9,
             $10, 'USER_EXPLICIT', 'person-source', 'client-source', null, null,
             null, 1, 100, 100)`,
    [
      input.tenantId,
      input.memoryId,
      input.target.scope,
      targetKey(input.target),
      input.target.ownerSubjectId,
      input.target.teamId,
      input.target.organizationId,
      `key-${input.memoryId}`,
      JSON.stringify(["GLOBAL", null]),
      input.content ?? `content-${input.memoryId}`,
    ],
  )
}

async function insertLegacyMutation(
  sql: ReturnType<typeof createPostgresSqlAdapter>,
  input: { tenantId: string; mutationId: string; memoryId: string; target: Target },
): Promise<void> {
  await sql.query(
    `insert into genio_one_shared_memory_mutations
      (tenant_id, mutation_id, scope_target_key, memory_id, scope, owner_subject_id,
       actor_subject_id, client_id, agent_id, agent_grant_id, operation,
       previous_revision, revision, assertion_origin, occurred_at,
       idempotency_key_digest, request_digest)
     values ($1, $2, $3, $4, $5, $6, 'person-source', 'client-source', null, null,
             'CREATED', 0, 1, 'USER_EXPLICIT', 100, $7, $8)`,
    [
      input.tenantId,
      input.mutationId,
      targetKey(input.target),
      input.memoryId,
      input.target.scope,
      input.target.ownerSubjectId,
      digest("a"),
      digest("b"),
    ],
  )
}

async function insertProposal(
  sql: ReturnType<typeof createPostgresSqlAdapter>,
  input: ProposalInput,
): Promise<void> {
  const status = input.status ?? "PENDING"
  const proposedContent = input.proposedContent === undefined
    ? (status === "PENDING" ? "corrected content" : null)
    : input.proposedContent
  const resolvedAt = input.resolvedAt === undefined
    ? (status === "PENDING" ? null : 200)
    : input.resolvedAt
  const reviewerSubjectId = input.reviewerSubjectId === undefined
    ? (status === "ACCEPTED" || status === "REJECTED" ? "person-reviewer" : null)
    : input.reviewerSubjectId
  await sql.query(
    `insert into genio_one_shared_memory_correction_proposals
      (tenant_id, proposal_id, memory_id, scope_target_key, scope, owner_subject_id,
       team_id, organization_id, base_revision, proposed_kind, proposed_content,
       source_actor_subject_id, source_client_id, source_agent_id,
       source_agent_grant_id, source_reference_id, idempotency_key_digest,
       request_digest, status, reviewer_subject_id, created_at, resolved_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'fact', $10,
             'person-source', 'client-source', $11, $12, 'reference-source',
             $13, $14, $15, $16, 100, $17)`,
    [
      input.tenantId,
      input.proposalId,
      input.memoryId,
      targetKey(input.target),
      input.target.scope,
      input.target.ownerSubjectId,
      input.target.teamId,
      input.target.organizationId,
      input.baseRevision ?? 1,
      proposedContent,
      input.sourceAgentId ?? null,
      input.sourceAgentGrantId ?? null,
      input.idempotencyKeyDigest ?? digest("c"),
      input.requestDigest ?? digest("d"),
      status,
      reviewerSubjectId,
      resolvedAt,
    ],
  )
}

test(
  "PostgreSQL shared memory governance enforces target ownership and proposal retention boundaries",
  { skip: !databaseUrl, timeout: 30_000 },
  async () => {
    assert.ok(databaseUrl)
    const schema = `shared_memory_governance_${randomUUID().replaceAll("-", "")}`
    const options = { max: 1, onnotice: () => {} }
    const admin = createPostgresSqlAdapter({ url: databaseUrl, options })
    const sql = createPostgresSqlAdapter({
      url: databaseUrl,
      options: { ...options, connection: { search_path: schema } },
    })
    const tenantId = "tenant-governance"
    const organizationA = "organization-a"
    const organizationB = "organization-b"
    const teamTarget: Target = {
      scope: "TEAM",
      ownerSubjectId: null,
      teamId: "workspace-a",
      organizationId: organizationA,
    }
    const organizationTarget: Target = {
      scope: "ORGANIZATION",
      ownerSubjectId: null,
      teamId: null,
      organizationId: organizationA,
    }
    let schemaCreated = false
    try {
      await admin.query(`create schema ${schema}`)
      schemaCreated = true
      const migrations = await loadMigrations()
      await runMigrations(sql, {
        migrations: migrations.filter((migration) => migration.id <= 19),
        advisoryLockKey: schema,
      })
      await seedOrganization(sql, tenantId, organizationA)
      await seedOrganization(sql, tenantId, organizationB)
      await seedTeamWorkspace(sql, tenantId, organizationA, teamTarget.teamId!)
      await insertMemory(sql, { tenantId, memoryId: "memory-legacy-team", target: teamTarget })
      await insertLegacyMutation(sql, {
        tenantId,
        mutationId: "mutation-legacy-team",
        memoryId: "memory-legacy-team",
        target: teamTarget,
      })
      await insertMemory(sql, { tenantId, memoryId: "memory-legacy-organization", target: organizationTarget })
      await insertLegacyMutation(sql, {
        tenantId,
        mutationId: "mutation-legacy-organization",
        memoryId: "memory-legacy-organization",
        target: organizationTarget,
      })
      await sql.query(
        `delete from genio_one_shared_memories
          where tenant_id = $1
            and memory_id in ('memory-legacy-team', 'memory-legacy-organization')`,
        [tenantId],
      )
      await runMigrations(sql, {
        migrations: migrations.filter((migration) => migration.id <= 20),
        advisoryLockKey: schema,
      })

      const mutationTargets = await sql.query<{ mutation_id: string; team_id: string | null; organization_id: string }>(
        `select mutation_id, team_id, organization_id
           from genio_one_shared_memory_mutations
          where tenant_id = $1
            and mutation_id in ('mutation-legacy-team', 'mutation-legacy-organization')
          order by mutation_id asc`,
        [tenantId],
      )
      assert.deepEqual(mutationTargets.rows, [
        { mutation_id: "mutation-legacy-organization", team_id: null, organization_id: organizationA },
        { mutation_id: "mutation-legacy-team", team_id: "workspace-a", organization_id: organizationA },
      ])
      const mutationContentColumn = await sql.query<{ count: string | number }>(
        `select count(*) as count
           from information_schema.columns
          where table_schema = $1
            and table_name = 'genio_one_shared_memory_mutations'
            and column_name = 'content'`,
        [schema],
      )
      assert.equal(Number(mutationContentColumn.rows[0]?.count), 0)

      await insertMemory(sql, { tenantId, memoryId: "memory-current", target: teamTarget })
      const confirmationMigration = await runMigrations(sql, { migrations, advisoryLockKey: schema })
      assert.deepEqual(confirmationMigration.applied, [21])
      const unconfirmedMemory = await sql.query<{ content: string; confirmed_at: string | number | null }>(
        `select content, confirmed_at from genio_one_shared_memories where tenant_id = $1 and memory_id = $2`,
        [tenantId, "memory-current"],
      )
      assert.deepEqual(unconfirmedMemory.rows, [{ content: "content-memory-current", confirmed_at: null }])
      const unconfirmedMutations = await sql.query<{
        reviewer_subject_id: string | null
        reviewer_client_id: string | null
        reviewed_at: string | number | null
      }>(
        `select reviewer_subject_id, reviewer_client_id, reviewed_at
           from genio_one_shared_memory_mutations where tenant_id = $1`,
        [tenantId],
      )
      assert.equal(unconfirmedMutations.rows.length, 2)
      assert.equal(unconfirmedMutations.rows.every((row) => row.reviewer_subject_id === null && row.reviewer_client_id === null && row.reviewed_at === null), true)
      await assert.rejects(
        () => sql.query(`update genio_one_shared_memories set confirmed_at = updated_at + 1 where tenant_id = $1`, [tenantId]),
        (error: unknown) => error instanceof Error && error.message.includes("genio_one_shared_memories_confirmation_check"),
      )
      await assert.rejects(
        () => sql.query(`update genio_one_shared_memory_mutations set reviewer_subject_id = 'person-reviewer' where tenant_id = $1`, [tenantId]),
        (error: unknown) => error instanceof Error && error.message.includes("genio_one_shared_memory_mutations_confirmation_check"),
      )
      assert.deepEqual((await runMigrations(sql, { migrations, advisoryLockKey: schema })).applied, [])
      await assert.rejects(
        () => insertMemory(sql, {
          tenantId,
          memoryId: "memory-cross-workspace",
          target: { ...teamTarget, organizationId: organizationB },
        }),
        (error: unknown) => error instanceof Error && error.message.includes("genio_one_shared_memories_team_workspace_fkey"),
      )
      await assert.rejects(
        () => insertMemory(sql, {
          tenantId,
          memoryId: "memory-missing-organization",
          target: { scope: "ORGANIZATION", ownerSubjectId: null, teamId: null, organizationId: "organization-missing" },
        }),
        (error: unknown) => error instanceof Error && error.message.includes("genio_one_shared_memories_organization_fkey"),
      )
      await assert.rejects(
        () => insertMemory(sql, {
          tenantId,
          memoryId: "memory-invalid-team-target",
          target: { scope: "TEAM", ownerSubjectId: null, teamId: null, organizationId: organizationA },
        }),
        (error: unknown) => error instanceof Error && error.message.includes("genio_one_shared_memories_scope_check"),
      )

      await insertProposal(sql, {
        tenantId,
        proposalId: "proposal-pending",
        memoryId: "memory-current",
        target: teamTarget,
      })
      await insertProposal(sql, {
        tenantId,
        proposalId: "proposal-stale",
        memoryId: "memory-current",
        target: teamTarget,
        status: "STALE",
        idempotencyKeyDigest: digest("e"),
        requestDigest: digest("f"),
      })
      await assert.rejects(
        () => insertProposal(sql, {
          tenantId,
          proposalId: "proposal-agent-grant-mismatch",
          memoryId: "memory-current",
          target: teamTarget,
          sourceAgentId: "agent-source",
          idempotencyKeyDigest: digest("a"),
        }),
        (error: unknown) => error instanceof Error && error.message.includes("genio_one_memory_correction_proposals_source_agent_grant_check"),
      )
      await assert.rejects(
        () => insertProposal(sql, {
          tenantId,
          proposalId: "proposal-pending-without-content",
          memoryId: "memory-current",
          target: teamTarget,
          proposedContent: null,
          idempotencyKeyDigest: digest("b"),
        }),
        (error: unknown) => error instanceof Error && error.message.includes("genio_one_memory_correction_proposals_resolution_check"),
      )
      await assert.rejects(
        () => insertProposal(sql, {
          tenantId,
          proposalId: "proposal-accepted-without-reviewer",
          memoryId: "memory-current",
          target: teamTarget,
          status: "ACCEPTED",
          reviewerSubjectId: null,
          idempotencyKeyDigest: digest("d"),
        }),
        (error: unknown) => error instanceof Error && error.message.includes("genio_one_memory_correction_proposals_resolution_check"),
      )
      await assert.rejects(
        () => insertProposal(sql, {
          tenantId,
          proposalId: "proposal-rejected-with-content",
          memoryId: "memory-current",
          target: teamTarget,
          status: "REJECTED",
          proposedContent: "must be cleared",
          idempotencyKeyDigest: digest("f"),
        }),
        (error: unknown) => error instanceof Error && error.message.includes("genio_one_memory_correction_proposals_resolution_check"),
      )
      await assert.rejects(
        () => insertProposal(sql, {
          tenantId,
          proposalId: "proposal-bad-digest",
          memoryId: "memory-current",
          target: teamTarget,
          idempotencyKeyDigest: "g".repeat(64),
        }),
        (error: unknown) => error instanceof Error && error.message.includes("genio_one_memory_correction_proposals_idempotency_digest_check"),
      )
      await assert.rejects(
        () => insertProposal(sql, {
          tenantId,
          proposalId: "proposal-duplicate-request",
          memoryId: "memory-current",
          target: teamTarget,
        }),
        (error: unknown) => error instanceof Error && error.message.includes("genio_one_memory_correction_proposals_idempotency_digest_unique"),
      )
      await assert.rejects(
        () => insertProposal(sql, {
          tenantId,
          proposalId: "proposal-wrong-target",
          memoryId: "memory-current",
          target: { scope: "ORGANIZATION", ownerSubjectId: null, teamId: null, organizationId: organizationA },
          idempotencyKeyDigest: digest("b"),
        }),
        (error: unknown) => error instanceof Error && error.message.includes("genio_one_memory_correction_proposals_memory_target_fkey"),
      )
      await sql.query(
        `delete from genio_one_shared_memories where tenant_id = $1 and memory_id = $2`,
        [tenantId, "memory-current"],
      )
      const proposals = await sql.query<{ count: string | number }>(
        `select count(*) as count
           from genio_one_shared_memory_correction_proposals
          where tenant_id = $1 and memory_id = $2`,
        [tenantId, "memory-current"],
      )
      assert.equal(Number(proposals.rows[0]?.count), 0)
    } finally {
      try {
        await sql.end()
      } finally {
        try {
          if (schemaCreated) await admin.query(`drop schema if exists ${schema} cascade`)
        } finally {
          await admin.end()
        }
      }
    }
  },
)

test(
  "PostgreSQL shared memory governance rejects legacy Team target mismatches",
  { skip: !databaseUrl, timeout: 30_000 },
  async () => {
    assert.ok(databaseUrl)
    const schema = `shared_memory_target_mismatch_${randomUUID().replaceAll("-", "")}`
    const options = { max: 1, onnotice: () => {} }
    const admin = createPostgresSqlAdapter({ url: databaseUrl, options })
    const sql = createPostgresSqlAdapter({
      url: databaseUrl,
      options: { ...options, connection: { search_path: schema } },
    })
    const tenantId = "tenant-target-mismatch"
    let schemaCreated = false
    try {
      await admin.query(`create schema ${schema}`)
      schemaCreated = true
      const migrations = await loadMigrations()
      await runMigrations(sql, {
        migrations: migrations.filter((migration) => migration.id <= 19),
        advisoryLockKey: schema,
      })
      await seedOrganization(sql, tenantId, "organization-a")
      await seedOrganization(sql, tenantId, "organization-b")
      await seedTeamWorkspace(sql, tenantId, "organization-a", "workspace-a")
      await insertMemory(sql, {
        tenantId,
        memoryId: "memory-target-mismatch",
        target: {
          scope: "TEAM",
          ownerSubjectId: null,
          teamId: "workspace-a",
          organizationId: "organization-b",
        },
      })
      await assert.rejects(
        () => runMigrations(sql, {
          migrations: migrations.filter((migration) => migration.id <= 20),
          advisoryLockKey: schema,
        }),
        (error: unknown) => error instanceof Error && error.message.includes("Cannot add Shared Memory governance constraints"),
      )
    } finally {
      try {
        await sql.end()
      } finally {
        try {
          if (schemaCreated) await admin.query(`drop schema if exists ${schema} cascade`)
        } finally {
          await admin.end()
        }
      }
    }
  },
)

test(
  "PostgreSQL shared memory governance rejects malformed historical mutation target keys",
  { skip: !databaseUrl, timeout: 30_000 },
  async () => {
    assert.ok(databaseUrl)
    const schema = `shared_memory_mutation_mismatch_${randomUUID().replaceAll("-", "")}`
    const options = { max: 1, onnotice: () => {} }
    const admin = createPostgresSqlAdapter({ url: databaseUrl, options })
    const sql = createPostgresSqlAdapter({
      url: databaseUrl,
      options: { ...options, connection: { search_path: schema } },
    })
    const tenantId = "tenant-mutation-mismatch"
    const target: Target = {
      scope: "TEAM",
      ownerSubjectId: null,
      teamId: "workspace-removed",
      organizationId: "organization-removed",
    }
    let schemaCreated = false
    try {
      await admin.query(`create schema ${schema}`)
      schemaCreated = true
      const migrations = await loadMigrations()
      await runMigrations(sql, {
        migrations: migrations.filter((migration) => migration.id <= 19),
        advisoryLockKey: schema,
      })
      await insertLegacyMutation(sql, {
        tenantId,
        mutationId: "mutation-without-memory",
        memoryId: "memory-removed",
        target,
      })
      await sql.query(
        `update genio_one_shared_memory_mutations
            set scope_target_key = $3
          where tenant_id = $1 and mutation_id = $2`,
        [tenantId, "mutation-without-memory", "not-json"],
      )
      await assert.rejects(
        () => runMigrations(sql, {
          migrations: migrations.filter((migration) => migration.id <= 20),
          advisoryLockKey: schema,
        }),
        (error: unknown) => error instanceof Error && error.message.includes("malformed scope target key"),
      )
    } finally {
      try {
        await sql.end()
      } finally {
        try {
          if (schemaCreated) await admin.query(`drop schema if exists ${schema} cascade`)
        } finally {
          await admin.end()
        }
      }
    }
  },
)
