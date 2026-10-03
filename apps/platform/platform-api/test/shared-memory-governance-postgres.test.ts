import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import test from "node:test"

import { PlatformApiError } from "../src/capabilities/errors"
import { createPostgresSharedMemoryRepository } from "../src/capabilities/memories/postgres"
import {
  createSharedMemoryDirectory,
  type SharedMemoryCorrectionProposalCreateInput,
  type SharedMemoryRepository,
  type SharedMemoryScopeTarget,
  type SharedMemoryWriteInput,
} from "../src/capabilities/memories/module"
import type { SharedMemoryScopeSelector } from "../src/capabilities/memories/shared-scope-access"
import type { Principal } from "../src/capabilities/tenancy-auth/contract"
import { loadMigrations, runMigrations } from "../src/persistence/migration-runner"
import { createPostgresSqlAdapter } from "../src/persistence/sql-adapter"

const databaseUrl = process.env.GENIO_ONE_TEST_DATABASE_URL
const tenantId = "tenant-shared-memory-governance"
const organizationId = "organization-shared-memory-governance"
const workspaceId = "workspace-shared-memory-governance"

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function principal(
  subjectId: string,
  role: Principal["role"] = "USER",
  clientId = "memory-shared-test-client",
  overrides: Partial<Principal> = {},
): Principal {
  return {
    tenant_id: tenantId,
    subject_id: subjectId,
    client_id: clientId,
    role,
    organization_ids: [],
    administrator_organization_ids: [],
    ...overrides,
  }
}

function accessGroupValue(input: {
  accessGroupId: string
  subjectIds: string[]
  revision?: number
}) {
  const revision = input.revision ?? 1
  return {
    tenant_id: tenantId,
    organization_id: organizationId,
    access_group_id: input.accessGroupId,
    display_name: input.accessGroupId,
    description: "",
    enabled: true,
    revision,
    membership_sources: [{
      source_id: "manual",
      kind: "MANUAL",
      revision,
      subject_ids: input.subjectIds,
      created_at: 100,
      created_by: "person-seed",
      updated_at: 100,
      updated_by: "person-seed",
    }],
    created_at: 100,
    created_by: "person-seed",
    updated_at: 100,
    updated_by: "person-seed",
  }
}

async function seed(sql: ReturnType<typeof createPostgresSqlAdapter>): Promise<void> {
  await sql.query(
    `insert into genio_one_organizations (tenant_id, organization_id, display_name, slug)
     values ($1, $2, $3, $4)`,
    [tenantId, organizationId, "Shared Memory Governance", "shared-memory-governance"],
  )
  const subjects = [
    "person-reader",
    "person-contributor",
    "person-maintainer",
    "person-member",
    "person-organization-admin",
    "person-outsider",
    "person-tenant-admin",
  ]
  for (const subjectId of subjects) {
    await sql.query(
      `insert into genio_one_subjects (tenant_id, subject_id, kind)
       values ($1, $2, 'PERSON')`,
      [tenantId, subjectId],
    )
  }
  await sql.query(
    `insert into genio_one_subject_roles (tenant_id, subject_id, role)
     values ($1, $2, 'TENANT_ADMINISTRATOR')`,
    [tenantId, "person-tenant-admin"],
  )
  for (const [subjectId, role] of [
    ["person-reader", "USER"],
    ["person-contributor", "USER"],
    ["person-maintainer", "USER"],
    ["person-member", "USER"],
    ["person-organization-admin", "ORGANIZATION_ADMINISTRATOR"],
  ] as const) {
    await sql.query(
      `insert into genio_one_organization_memberships (tenant_id, organization_id, subject_id, role)
       values ($1, $2, $3, $4)`,
      [tenantId, organizationId, subjectId, role],
    )
  }
  const groups = [
    ["group-reader", ["person-reader"]],
    ["group-contributor", ["person-contributor"]],
    ["group-maintainer", ["person-maintainer"]],
  ] as const
  for (const [accessGroupId, subjectIds] of groups) {
    const value = accessGroupValue({ accessGroupId, subjectIds: [...subjectIds] })
    await sql.query(
      `insert into genio_one_access_groups
        (tenant_id, access_group_id, organization_id, revision, value)
       values ($1, $2, $3, $4, $5::text::jsonb)`,
      [tenantId, accessGroupId, organizationId, value.revision, JSON.stringify(value)],
    )
  }
  await sql.query(
    `insert into genio_one_team_workspaces
      (tenant_id, workspace_id, organization_id, display_name, reader_access_group_id,
       contributor_access_group_id, maintainer_access_group_id, created_at, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, 100, 'person-seed')`,
    [tenantId, workspaceId, organizationId, "Shared Memory Team", "group-reader", "group-contributor", "group-maintainer"],
  )
}

function source(actor: Principal, agentId: string | null = null, agentGrantId: string | null = null) {
  return {
    actor_subject_id: actor.subject_id,
    client_id: actor.client_id,
    agent_id: agentId,
    agent_grant_id: agentGrantId,
    reference_id: null,
  }
}

function memoryWrite(input: {
  target: SharedMemoryScopeTarget
  actor: Principal
  id: string
  key: string
  content: string
  memoryId?: string | null
  expectedRevision?: number
}): SharedMemoryWriteInput {
  return {
    tenantId,
    target: input.target,
    memoryId: input.memoryId ?? null,
    expectedRevision: input.expectedRevision ?? 0,
    idempotencyKeyDigest: digest(`idempotency:${input.id}`),
    requestDigest: digest(`request:${input.id}`),
    key: input.key,
    kind: "fact",
    context: { kind: "GLOBAL", context_id: null },
    content: input.content,
    assertionOrigin: "USER_EXPLICIT",
    source: source(input.actor),
  }
}

function proposalWrite(input: {
  target: SharedMemoryScopeTarget
  actor: Principal
  id: string
  memoryId: string
  baseRevision: number
  content: string
}): SharedMemoryCorrectionProposalCreateInput {
  return {
    tenantId,
    target: input.target,
    memoryId: input.memoryId,
    baseRevision: input.baseRevision,
    proposedKind: "fact",
    proposedContent: input.content,
    idempotencyKeyDigest: digest(`idempotency:${input.id}`),
    requestDigest: digest(`request:${input.id}`),
    source: source(input.actor),
  }
}

function hasError(error: unknown, code: string, statusCode: number): boolean {
  return error instanceof PlatformApiError && error.code === code && error.statusCode === statusCode
}

test(
  "PostgreSQL shared memory keeps authorization, proposals, mutations, and agent revoke in one durable boundary",
  { skip: !databaseUrl, timeout: 30_000 },
  async () => {
    assert.ok(databaseUrl)
    const schema = `shared_memory_store_${randomUUID().replaceAll("-", "")}`
    const options = { max: 4, onnotice: () => {} }
    const admin = createPostgresSqlAdapter({ url: databaseUrl, options })
    const sql = createPostgresSqlAdapter({
      url: databaseUrl,
      options: { ...options, connection: { search_path: schema } },
    })
    let now = 1_000
    let sequence = 0
    let schemaCreated = false
    try {
      await admin.query(`create schema ${schema}`)
      schemaCreated = true
      await runMigrations(sql, { advisoryLockKey: schema })
      await seed(sql)
      const repository = createPostgresSharedMemoryRepository({
        sql,
        now: () => ++now,
        idFactory: (prefix) => `${prefix}-${++sequence}`,
      })
      const reader = principal("person-reader")
      const contributor = principal("person-contributor")
      const maintainer = principal("person-maintainer")
      const member = principal("person-member")
      const organizationAdmin = principal("person-organization-admin", "ORGANIZATION_ADMINISTRATOR")
      const outsider = principal("person-outsider")
      const team: SharedMemoryScopeSelector = { scope: "TEAM", workspace_id: workspaceId }
      const organization: SharedMemoryScopeSelector = { scope: "ORGANIZATION", organization_id: organizationId }

      await assert.rejects(
        () => repository.withAuthorizedSharedScope({
          actor: reader,
          selector: team,
          permission: "CONTRIBUTE",
        }, async () => undefined),
        (error: unknown) => hasError(error, "SHARED_MEMORY_SCOPE_ACCESS_REQUIRED", 403),
      )
      await assert.rejects(
        () => repository.withAuthorizedSharedScope({
          actor: principal("person-reader", "USER", "memory-shared-test-client", { tenant_id: "tenant-other" }),
          selector: team,
          permission: "READ",
        }, async () => undefined),
        (error: unknown) => hasError(error, "SHARED_MEMORY_SCOPE_NOT_FOUND", 404),
      )
      await assert.rejects(
        () => repository.withAuthorizedSharedScope({
          actor: outsider,
          selector: organization,
          permission: "READ",
        }, async () => undefined),
        (error: unknown) => hasError(error, "SHARED_MEMORY_SCOPE_ACCESS_REQUIRED", 403),
      )

      const created = await repository.withAuthorizedSharedScope({
        actor: contributor,
        selector: team,
        permission: "CONTRIBUTE",
      }, async (scope, scoped) => scoped.remember(memoryWrite({
        target: scope.target,
        actor: contributor,
        id: "team-create",
        key: "deployment-window",
        content: "Deploy after Tuesday review.",
      })))
      assert.equal(created.scope, "TEAM")
      assert.equal(created.team_id, workspaceId)
      assert.equal(created.organization_id, organizationId)

      const readerRead = await repository.withAuthorizedSharedScope({
        actor: reader,
        selector: team,
        permission: "READ",
      }, async (scope, scoped) => scoped.get({
        tenantId,
        target: scope.target,
        memoryId: created.memory_id,
      }))
      assert.deepEqual(readerRead?.memory_id, created.memory_id)

      const initialProposal = await repository.withAuthorizedSharedScope({
        actor: contributor,
        selector: team,
        permission: "CONTRIBUTE",
      }, async (scope, scoped) => scoped.createCorrectionProposal(proposalWrite({
        target: scope.target,
        actor: contributor,
        id: "team-proposal-one",
        memoryId: created.memory_id,
        baseRevision: created.revision,
        content: "Deploy after the Wednesday review.",
      })))
      const proposalReplay = await repository.withAuthorizedSharedScope({
        actor: contributor,
        selector: team,
        permission: "CONTRIBUTE",
      }, async (scope, scoped) => scoped.createCorrectionProposal(proposalWrite({
        target: scope.target,
        actor: contributor,
        id: "team-proposal-one",
        memoryId: created.memory_id,
        baseRevision: created.revision,
        content: "Deploy after the Wednesday review.",
      })))
      assert.deepEqual(proposalReplay, initialProposal)
      await assert.rejects(
        () => repository.withAuthorizedSharedScope({
          actor: contributor,
          selector: team,
          permission: "CONTRIBUTE",
        }, async (scope, scoped) => scoped.createCorrectionProposal({
          ...proposalWrite({
            target: scope.target,
            actor: contributor,
            id: "team-proposal-one",
            memoryId: created.memory_id,
            baseRevision: created.revision,
            content: "Deploy after the Wednesday review.",
          }),
          requestDigest: digest("request:team-proposal-one-reused"),
        })),
        (error: unknown) => hasError(error, "MEMORY_IDEMPOTENCY_KEY_REUSED", 409),
      )
      await assert.rejects(
        () => repository.withAuthorizedSharedScope({
          actor: contributor,
          selector: team,
          permission: "CONTRIBUTE",
        }, async (scope, scoped) => scoped.remember(memoryWrite({
          target: scope.target,
          actor: contributor,
          id: "team-contributor-replace",
          memoryId: created.memory_id,
          expectedRevision: created.revision,
          key: created.key,
          content: "Contributor cannot replace directly.",
        }))),
        (error: unknown) => hasError(error, "SHARED_MEMORY_SCOPE_ACCESS_REQUIRED", 403),
      )

      const corrected = await repository.withAuthorizedSharedScope({
        actor: maintainer,
        selector: team,
        permission: "MANAGE",
      }, async (scope, scoped) => scoped.remember(memoryWrite({
        target: scope.target,
        actor: maintainer,
        id: "team-maintainer-replace",
        memoryId: created.memory_id,
        expectedRevision: created.revision,
        key: created.key,
        content: "Deploy after Thursday review.",
      })))
      assert.equal(corrected.revision, 2)
      const staleAfterDirectReplace = await repository.withAuthorizedSharedScope({
        actor: reader,
        selector: team,
        permission: "READ",
      }, async (scope, scoped) => scoped.listCorrectionProposals({
        tenantId,
        target: scope.target,
        memoryId: created.memory_id,
        limit: 10,
        position: null,
        status: null,
      }))
      assert.equal(staleAfterDirectReplace.length, 1)
      assert.equal(staleAfterDirectReplace[0]?.status, "STALE")
      assert.equal(staleAfterDirectReplace[0]?.proposed_content, null)
      await assert.rejects(
        () => repository.withAuthorizedSharedScope({
          actor: maintainer,
          selector: team,
          permission: "MANAGE",
        }, async (scope, scoped) => scoped.reviewCorrectionProposal({
          tenantId,
          target: scope.target,
          memoryId: created.memory_id,
          proposalId: initialProposal.proposal_id,
          reviewerSubjectId: maintainer.subject_id,
          reviewerClientId: maintainer.client_id,
          action: "ACCEPT",
        })),
        (error: unknown) => hasError(error, "MEMORY_CORRECTION_PROPOSAL_NOT_PENDING", 409),
      )

      const acceptedCandidate = await repository.withAuthorizedSharedScope({
        actor: contributor,
        selector: team,
        permission: "CONTRIBUTE",
      }, async (scope, scoped) => scoped.createCorrectionProposal(proposalWrite({
        target: scope.target,
        actor: contributor,
        id: "team-proposal-accept",
        memoryId: created.memory_id,
        baseRevision: corrected.revision,
        content: "Deploy after Friday review.",
      })))
      const staleCandidate = await repository.withAuthorizedSharedScope({
        actor: contributor,
        selector: team,
        permission: "CONTRIBUTE",
      }, async (scope, scoped) => scoped.createCorrectionProposal(proposalWrite({
        target: scope.target,
        actor: contributor,
        id: "team-proposal-stale",
        memoryId: created.memory_id,
        baseRevision: corrected.revision,
        content: "Deploy after Monday review.",
      })))
      const reviewed = await repository.withAuthorizedSharedScope({
        actor: maintainer,
        selector: team,
        permission: "MANAGE",
      }, async (scope, scoped) => scoped.reviewCorrectionProposal({
        tenantId,
        target: scope.target,
        memoryId: created.memory_id,
        proposalId: acceptedCandidate.proposal_id,
        reviewerSubjectId: maintainer.subject_id,
        reviewerClientId: maintainer.client_id,
        action: "ACCEPT",
      }))
      assert.equal(reviewed.proposal.status, "ACCEPTED")
      assert.equal(reviewed.memory?.content, "Deploy after Friday review.")
      assert.equal(reviewed.memory?.revision, 3)
      const proposalsAfterAccept = await repository.withAuthorizedSharedScope({
        actor: reader,
        selector: team,
        permission: "READ",
      }, async (scope, scoped) => scoped.listCorrectionProposals({
        tenantId,
        target: scope.target,
        memoryId: created.memory_id,
        limit: 10,
        position: null,
        status: null,
      }))
      const staleProposal = proposalsAfterAccept.find((proposal) => proposal.proposal_id === staleCandidate.proposal_id)
      assert.equal(staleProposal?.status, "STALE")
      assert.equal(staleProposal?.proposed_content, null)

      const organizationMemory = await repository.withAuthorizedSharedScope({
        actor: member,
        selector: organization,
        permission: "CONTRIBUTE",
      }, async (scope, scoped) => scoped.remember(memoryWrite({
        target: scope.target,
        actor: member,
        id: "organization-create",
        key: "organization-language",
        content: "Use Taiwan Traditional Chinese.",
      })))
      const organizationCorrected = await repository.withAuthorizedSharedScope({
        actor: organizationAdmin,
        selector: organization,
        permission: "MANAGE",
      }, async (scope, scoped) => scoped.remember(memoryWrite({
        target: scope.target,
        actor: organizationAdmin,
        id: "organization-replace",
        memoryId: organizationMemory.memory_id,
        expectedRevision: organizationMemory.revision,
        key: organizationMemory.key,
        content: "Use 台灣繁體中文.",
      })))
      assert.equal(organizationCorrected.organization_id, organizationId)

      const finalProposal = await repository.withAuthorizedSharedScope({
        actor: contributor,
        selector: team,
        permission: "CONTRIBUTE",
      }, async (scope, scoped) => scoped.createCorrectionProposal(proposalWrite({
        target: scope.target,
        actor: contributor,
        id: "team-proposal-before-delete",
        memoryId: created.memory_id,
        baseRevision: reviewed.memory!.revision,
        content: "This proposal is cleared by delete.",
      })))
      assert.equal(finalProposal.status, "PENDING")
      const deleted = await repository.withAuthorizedSharedScope({
        actor: maintainer,
        selector: team,
        permission: "MANAGE",
      }, async (scope, scoped) => scoped.delete({
        tenantId,
        target: scope.target,
        memoryId: created.memory_id,
        expectedRevision: reviewed.memory!.revision,
        idempotencyKeyDigest: digest("idempotency:team-delete"),
        requestDigest: digest("request:team-delete"),
        actorSubjectId: maintainer.subject_id,
        clientId: maintainer.client_id,
        agentId: null,
        agentGrantId: null,
        assertionOrigin: "USER_EXPLICIT",
      }))
      const deletionReplay = await repository.withAuthorizedSharedScope({
        actor: maintainer,
        selector: team,
        permission: "MANAGE",
      }, async (scope, scoped) => scoped.delete({
        tenantId,
        target: scope.target,
        memoryId: created.memory_id,
        expectedRevision: reviewed.memory!.revision,
        idempotencyKeyDigest: digest("idempotency:team-delete"),
        requestDigest: digest("request:team-delete"),
        actorSubjectId: maintainer.subject_id,
        clientId: maintainer.client_id,
        agentId: null,
        agentGrantId: null,
        assertionOrigin: "USER_EXPLICIT",
      }))
      assert.deepEqual(deletionReplay, deleted)
      const retainedProposals = await sql.query<{ count: string | number }>(
        `select count(*) as count
           from genio_one_shared_memory_correction_proposals
          where tenant_id = $1 and memory_id = $2`,
        [tenantId, created.memory_id],
      )
      assert.equal(Number(retainedProposals.rows[0]?.count), 0)
      const deletionMutation = await sql.query<{ team_id: string; organization_id: string }>(
        `select team_id, organization_id
           from genio_one_shared_memory_mutations
          where tenant_id = $1 and memory_id = $2 and operation = 'DELETED'`,
        [tenantId, created.memory_id],
      )
      assert.deepEqual(deletionMutation.rows, [{ team_id: workspaceId, organization_id: organizationId }])

      const readerScopes = await repository.listMemoryScopes({ actor: reader })
      const readerTeam = readerScopes.find((scope) => scope.target.scope === "TEAM" && scope.target.workspace_id === workspaceId)
      assert.equal(readerTeam?.can_read, true)
      assert.equal(readerTeam?.can_contribute, false)
      const maintainerScopes = await repository.listMemoryScopes({ actor: maintainer })
      const maintainerTeam = maintainerScopes.find((scope) => scope.target.scope === "TEAM" && scope.target.workspace_id === workspaceId)
      assert.equal(maintainerTeam?.can_manage, true)

      const agent = principal("person-maintainer", "USER", "memory-agent-client")
      await repository.enablePersonalAgent({
        tenantId,
        ownerSubjectId: agent.subject_id,
        agentId: agent.client_id,
      })
      let enteredResolve: (() => void) | undefined
      const entered = new Promise<void>((resolve) => { enteredResolve = resolve })
      let releaseResolve: (() => void) | undefined
      const release = new Promise<void>((resolve) => { releaseResolve = resolve })
      const agentOperation = repository.withActivePersonalAgent({
        tenantId,
        ownerSubjectId: agent.subject_id,
        agentId: agent.client_id,
      }, async (_grant, activeRepository) => activeRepository.withAuthorizedSharedScope({
        actor: agent,
        selector: organization,
        permission: "READ",
      }, async (_scope, scoped) => {
        const scopes = await scoped.listMemoryScopes({ actor: agent })
        assert.ok(scopes.some((scope) => scope.target.scope === "ORGANIZATION" && scope.target.organization_id === organizationId))
        enteredResolve?.()
        await release
        return scoped.get({
          tenantId,
          target: {
            scope: "ORGANIZATION",
            ownerSubjectId: null,
            teamId: null,
            organizationId,
          },
          memoryId: organizationMemory.memory_id,
        })
      }))
      await entered
      let revoked = false
      const revocation = repository.revokePersonalAgent({
        tenantId,
        ownerSubjectId: agent.subject_id,
        agentId: agent.client_id,
      }).then((value) => {
        revoked = true
        return value
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(revoked, false)
      releaseResolve?.()
      const agentMemory = await agentOperation
      assert.equal(agentMemory?.memory_id, organizationMemory.memory_id)
      await revocation
      await assert.rejects(
        () => repository.withActivePersonalAgent({
          tenantId,
          ownerSubjectId: agent.subject_id,
          agentId: agent.client_id,
        }, async () => undefined),
        (error: unknown) => hasError(error, "MEMORY_AGENT_GRANT_INVALID", 403),
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
  "PostgreSQL retains a valid legacy create idempotency fence after hard delete and key rotation",
  { skip: !databaseUrl, timeout: 30_000 },
  async () => {
    assert.ok(databaseUrl)
    const schema = `shared_memory_legacy_replay_${randomUUID().replaceAll("-", "")}`
    const options = { max: 1, onnotice: () => {} }
    const admin = createPostgresSqlAdapter({ url: databaseUrl, options })
    const sql = createPostgresSqlAdapter({
      url: databaseUrl,
      options: { ...options, connection: { search_path: schema } },
    })
    const legacyKey = "b6c7ff2a-0b71-4b6b-804f-25a7c88e670e"
    const invalidLegacyKey = "legacy-non-uuid-idempotency-key"
    const legacyTenant = "tenant-legacy-replay"
    const ownerSubjectId = "person-legacy-owner"
    const invalidOwnerSubjectId = "person-legacy-invalid-owner"
    let schemaCreated = false
    try {
      await admin.query(`create schema ${schema}`)
      schemaCreated = true
      const migrations = await loadMigrations()
      await runMigrations(sql, {
        migrations: migrations.filter((migration) => migration.id <= 17),
        advisoryLockKey: schema,
      })
      await sql.query(
        `insert into genio_one_shared_memory_mutations
          (tenant_id, mutation_id, scope_target_key, memory_id, scope, owner_subject_id,
           actor_subject_id, client_id, agent_id, agent_grant_id, operation,
           previous_revision, revision, assertion_origin, occurred_at, idempotency_key,
           request_digest)
         values ($1,$2,$3,$4,'PERSONAL',$5,$5,'legacy-client',null,null,
                 'CREATED',0,1,'USER_EXPLICIT',100,$6,$7)`,
        [
          legacyTenant,
          "legacy-create",
          JSON.stringify(["PERSONAL", ownerSubjectId, null, null]),
          "legacy-hard-deleted-memory",
          ownerSubjectId,
          legacyKey,
          digest("legacy-request"),
        ],
      )
      await sql.query(
        `insert into genio_one_shared_memory_mutations
          (tenant_id, mutation_id, scope_target_key, memory_id, scope, owner_subject_id,
           actor_subject_id, client_id, agent_id, agent_grant_id, operation,
           previous_revision, revision, assertion_origin, occurred_at, idempotency_key,
           request_digest)
         values ($1,$2,$3,$4,'PERSONAL',$5,$5,'legacy-client',null,null,
                 'CREATED',0,1,'USER_EXPLICIT',100,$6,$7)`,
        [
          legacyTenant,
          "legacy-invalid-create",
          JSON.stringify(["PERSONAL", invalidOwnerSubjectId, null, null]),
          "legacy-invalid-memory",
          invalidOwnerSubjectId,
          invalidLegacyKey,
          digest("legacy-invalid-request"),
        ],
      )
      await runMigrations(sql, { advisoryLockKey: schema })
      const migratedMutations = await sql.query<{
        memory_id: string
        idempotency_key_digest: string
        request_digest: string
      }>(
        `select memory_id, idempotency_key_digest, request_digest
           from genio_one_shared_memory_mutations
          where tenant_id = $1
          order by memory_id asc`,
        [legacyTenant],
      )
      const migratedValid = migratedMutations.rows.find((row) => row.memory_id === "legacy-hard-deleted-memory")
      const migratedInvalid = migratedMutations.rows.find((row) => row.memory_id === "legacy-invalid-memory")
      assert.equal(migratedValid?.idempotency_key_digest, digest(legacyKey))
      assert.notEqual(migratedValid?.request_digest, digest("legacy-request"))
      assert.match(migratedInvalid?.idempotency_key_digest ?? "", /^[a-f0-9]{64}$/)
      assert.notEqual(migratedInvalid?.idempotency_key_digest, invalidLegacyKey)
      assert.notEqual(migratedInvalid?.idempotency_key_digest, digest(invalidLegacyKey))
      assert.match(migratedInvalid?.request_digest ?? "", /^[a-f0-9]{64}$/)
      assert.notEqual(migratedInvalid?.request_digest, digest("legacy-invalid-request"))
      const rawIdempotencyColumn = await sql.query<{ count: string | number }>(
        `select count(*) as count
           from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'genio_one_shared_memory_mutations'
            and column_name = 'idempotency_key'`,
      )
      assert.equal(Number(rawIdempotencyColumn.rows[0]?.count), 0)
      const repository = createPostgresSharedMemoryRepository({ sql, now: () => 2_000 })
      await assert.rejects(
        () => repository.remember({
          tenantId: legacyTenant,
          target: { scope: "PERSONAL", ownerSubjectId, teamId: null, organizationId: null },
          memoryId: null,
          expectedRevision: 0,
          idempotencyKeyDigest: digest(legacyKey),
          requestDigest: digest("request-after-key-rotation"),
          key: "legacy-create-retry",
          kind: "fact",
          context: { kind: "GLOBAL", context_id: null },
          content: "Must not resurrect after hard delete.",
          assertionOrigin: "USER_EXPLICIT",
          source: {
            actor_subject_id: ownerSubjectId,
            client_id: "legacy-client",
            agent_id: null,
            agent_grant_id: null,
            reference_id: null,
          },
        }),
        (error: unknown) => error instanceof PlatformApiError && error.statusCode === 409,
      )
      const memories = await sql.query<{ count: string | number }>(
        `select count(*) as count
           from genio_one_shared_memories
          where tenant_id = $1 and memory_id = $2`,
        [legacyTenant, "legacy-hard-deleted-memory"],
      )
      assert.equal(Number(memories.rows[0]?.count), 0)
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
  "PostgreSQL serializes concurrent agent inferences into one memory and one proposal",
  { skip: !databaseUrl, timeout: 30_000 },
  async () => {
    assert.ok(databaseUrl)
    const schema = `shared_memory_agent_race_${randomUUID().replaceAll("-", "")}`
    const options = { max: 4, onnotice: () => {} }
    const admin = createPostgresSqlAdapter({ url: databaseUrl, options })
    const sql = createPostgresSqlAdapter({
      url: databaseUrl,
      options: { ...options, connection: { search_path: schema } },
    })
    let now = 3_000
    let sequence = 0
    let schemaCreated = false
    try {
      await admin.query(`create schema ${schema}`)
      schemaCreated = true
      await runMigrations(sql, { advisoryLockKey: schema })
      await seed(sql)
      const repository = createPostgresSharedMemoryRepository({
        sql,
        now: () => ++now,
        idFactory: (prefix) => `${prefix}-${++sequence}`,
      })
      const team: SharedMemoryScopeSelector = { scope: "TEAM", workspace_id: workspaceId }
      const agentOne = principal("person-contributor", "USER", "memory-agent-one")
      const agentTwo = principal("person-contributor", "USER", "memory-agent-two")
      const maintainer = principal("person-maintainer")
      await repository.enablePersonalAgent({
        tenantId,
        ownerSubjectId: agentOne.subject_id,
        agentId: agentOne.client_id,
      })
      await repository.enablePersonalAgent({
        tenantId,
        ownerSubjectId: agentTwo.subject_id,
        agentId: agentTwo.client_id,
      })
      const key = "concurrent-agent-inference"
      let listed = 0
      let releaseLists: (() => void) | undefined
      const allInitialListsComplete = new Promise<void>((resolve) => { releaseLists = resolve })
      const gatedRepository: SharedMemoryRepository = {
        ...repository,
        async withActivePersonalAgent(input, operation) {
          return repository.withActivePersonalAgent(input, async (grant, activeRepository) => operation(grant, {
            ...activeRepository,
            async withAuthorizedSharedScope(scopeInput, scopeOperation) {
              return activeRepository.withAuthorizedSharedScope(scopeInput, async (scope, authorizedRepository) => (
                scopeOperation(scope, {
                  ...authorizedRepository,
                  async list(listInput) {
                    const values = await authorizedRepository.list(listInput)
                    if (listInput.keys?.includes(key)) {
                      listed += 1
                      if (listed === 2) releaseLists?.()
                      await allInitialListsComplete
                    }
                    return values
                  },
                })
              ))
            },
          }))
        },
      }
      const directory = createSharedMemoryDirectory({
        repository: gatedRepository,
        digestSecret: new Uint8Array(32).fill(7),
      })
      const [first, second] = await Promise.all([
        directory.rememberSharedAsAgent(agentOne, team, {
          expected_revision: 0,
          idempotency_key: randomUUID(),
          key,
          kind: "fact",
          context: { kind: "GLOBAL", context_id: null },
          content: "First concurrent inference.",
        }),
        directory.rememberSharedAsAgent(agentTwo, team, {
          expected_revision: 0,
          idempotency_key: randomUUID(),
          key,
          kind: "fact",
          context: { kind: "GLOBAL", context_id: null },
          content: "Second concurrent inference.",
        }),
      ])
      const results = [first, second]
      const memories = results.filter((result) => result.result === "MEMORY")
      const proposals = results.filter((result) => result.result === "PROPOSAL")
      assert.equal(memories.length, 1)
      assert.equal(proposals.length, 1)
      const canonical = memories[0]?.memory
      assert.ok(canonical)
      assert.equal(canonical.assertion_origin, "AGENT_INFERRED")
      const persisted = await repository.withAuthorizedSharedScope({
        actor: agentOne,
        selector: team,
        permission: "READ",
      }, async (scope, scoped) => scoped.list({
        tenantId,
        target: scope.target,
        limit: 10,
        position: null,
        contexts: [{ kind: "GLOBAL", context_id: null }],
        query: null,
        keys: [key],
      }))
      assert.equal(persisted.length, 1)
      assert.equal(persisted[0]?.memory_id, canonical.memory_id)
      const differentKind = await directory.rememberSharedAsAgent(agentOne, team, {
        expected_revision: 0,
        idempotency_key: randomUUID(),
        key,
        kind: "decision",
        context: canonical.context,
        content: canonical.content,
      })
      assert.equal(differentKind.result, "MEMORY")
      if (differentKind.result !== "MEMORY") throw new Error("expected distinct decision memory")
      assert.equal(differentKind.memory.kind, "decision")
      assert.notEqual(differentKind.memory.memory_id, canonical.memory_id)
      assert.deepEqual(await directory.getShared(maintainer, team, canonical.memory_id), canonical)
      const pending = await repository.withAuthorizedSharedScope({
        actor: agentOne,
        selector: team,
        permission: "READ",
      }, async (scope, scoped) => scoped.listCorrectionProposals({
        tenantId,
        target: scope.target,
        memoryId: canonical.memory_id,
        limit: 10,
        position: null,
        status: "PENDING",
      }))
      assert.equal(pending.length, 1)
      const pendingProposal = pending[0]
      assert.ok(pendingProposal)
      assert.equal(
        pendingProposal.source.agent_id === agentOne.client_id || pendingProposal.source.agent_id === agentTwo.client_id,
        true,
      )
      const reviewed = await directory.reviewSharedCorrectionProposal(maintainer, team, canonical.memory_id, pendingProposal.proposal_id, { action: "ACCEPT" })
      assert.equal(reviewed.proposal.status, "ACCEPTED")
      assert.equal(reviewed.memory?.assertion_origin, "AGENT_INFERRED")
      assert.equal(reviewed.memory?.source.agent_id, pendingProposal.source.agent_id)
      assert.ok(reviewed.memory)
      assert.deepEqual(await directory.getShared(maintainer, team, differentKind.memory.memory_id), differentKind.memory)
      assert.deepEqual(reviewed.memory.confirmation, { confirmed: true, reviewed_at: reviewed.memory.updated_at })
      assert.equal("reviewer_subject_id" in reviewed.memory.confirmation!, false)
      assert.equal("reviewer_client_id" in reviewed.memory.confirmation!, false)
      const reopenedSql = createPostgresSqlAdapter({ url: databaseUrl, options: { ...options, connection: { search_path: schema } } })
      try {
        const reopenedRepository = createPostgresSharedMemoryRepository({ sql: reopenedSql })
        const persistedAfterReopen = await reopenedRepository.withAuthorizedSharedScope({ actor: maintainer, selector: team, permission: "READ" }, async (scope, scoped) => scoped.get({ tenantId, target: scope.target, memoryId: canonical.memory_id }))
        assert.deepEqual(persistedAfterReopen, reviewed.memory)
      } finally {
        await reopenedSql.end()
      }
      const confirmedResult = await directory.retrieveMemoryTargets(maintainer, { targets: [team], limit: 20, max_context_chars: 16_000 })
      assert.equal(confirmedResult.memories.find((memory) => memory.memory_id === canonical.memory_id)?.confirmed, true)
      assert.equal(confirmedResult.context.includes("reviewer_subject_id"), false)
      assert.equal(confirmedResult.context.includes("reviewer_client_id"), false)
      const acceptedMutation = await sql.query<{
        agent_id: string | null
        client_id: string
        assertion_origin: string
        reviewer_subject_id: string | null
        reviewer_client_id: string | null
        reviewed_at: string | number | null
      }>(
        `select agent_id, client_id, assertion_origin, reviewer_subject_id, reviewer_client_id, reviewed_at
           from genio_one_shared_memory_mutations
          where tenant_id = $1 and memory_id = $2 and operation = 'REPLACED'`,
        [tenantId, canonical.memory_id],
      )
      assert.deepEqual(acceptedMutation.rows.map((row) => ({ ...row, reviewed_at: Number(row.reviewed_at) })), [{
        agent_id: pendingProposal.source.agent_id,
        client_id: pendingProposal.source.client_id,
        assertion_origin: "AGENT_INFERRED",
        reviewer_subject_id: maintainer.subject_id,
        reviewer_client_id: maintainer.client_id,
        reviewed_at: reviewed.memory.updated_at,
      }])
      const rejectedCandidate = await directory.createSharedCorrectionProposal(principal("person-contributor"), team, canonical.memory_id, {
        expected_revision: reviewed.memory.revision,
        idempotency_key: randomUUID(),
        content: "Rejected correction must not replace the confirmed memory.",
      })
      const rejected = await directory.reviewSharedCorrectionProposal(maintainer, team, canonical.memory_id, rejectedCandidate.proposal_id, { action: "REJECT" })
      assert.equal(rejected.proposal.status, "REJECTED")
      assert.equal(rejected.memory, null)
      const afterReject = await repository.withAuthorizedSharedScope({ actor: maintainer, selector: team, permission: "READ" }, async (scope, scoped) => scoped.get({ tenantId, target: scope.target, memoryId: canonical.memory_id }))
      assert.deepEqual(afterReject, reviewed.memory)
      const corrected = await directory.rememberShared(maintainer, team, {
        memory_id: canonical.memory_id,
        expected_revision: reviewed.memory.revision,
        idempotency_key: randomUUID(),
        key,
        kind: reviewed.memory.kind,
        context: reviewed.memory.context,
        content: "Manager correction clears the prior confirmation.",
      })
      assert.equal(corrected.confirmation, null)
      assert.equal(corrected.assertion_origin, "USER_EXPLICIT")
      const correctedResult = await directory.retrieveMemoryTargets(maintainer, { targets: [team], limit: 20, max_context_chars: 16_000 })
      assert.equal(correctedResult.memories.find((memory) => memory.memory_id === canonical.memory_id)?.confirmed, false)
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
