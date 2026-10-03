import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"

import { createSharedMemoryDirectory, type VerifiedPersonalMemoryGrantor } from "../src/capabilities/memories/module"
import { createPostgresSharedMemoryRepository } from "../src/capabilities/memories/postgres"
import { loadMigrations, runMigrations } from "../src/persistence/migration-runner"
import { createPostgresSqlAdapter } from "../src/persistence/sql-adapter"
import type { Principal } from "../src/capabilities/tenancy-auth/contract"

const databaseUrl = process.env.GENIO_ONE_TEST_DATABASE_URL
const memoryDigestSecret = Buffer.alloc(32, 7)
const idempotencyKeys = new Map<string, string>()

function idempotencyKey(label: string): string {
  const existing = idempotencyKeys.get(label)
  if (existing) return existing
  const value = randomUUID()
  idempotencyKeys.set(label, value)
  return value
}

function principal(subjectId: string, clientId = "genio-one-self-service"): Principal {
  return {
    tenant_id: "tenant-memory-live",
    subject_id: subjectId,
    client_id: clientId,
    role: "USER",
    organization_ids: [],
  }
}

function grantor(actor: Principal): VerifiedPersonalMemoryGrantor {
  return {
    actor,
    management_authorized: true,
    person_subject: true,
  }
}

test("PostgreSQL shared memory persists only live content and payload-free mutation metadata", { skip: !databaseUrl, timeout: 30_000 }, async () => {
  assert.ok(databaseUrl)
  const schema = `shared_memory_${randomUUID().replaceAll("-", "")}`
  const admin = createPostgresSqlAdapter({ url: databaseUrl, options: { max: 1, onnotice: () => {} } })
  const sql = createPostgresSqlAdapter({
    url: databaseUrl,
    options: { max: 1, connection: { search_path: schema }, onnotice: () => {} },
  })
  let sequence = 0
  let schemaCreated = false
  try {
    await admin.query(`create schema ${schema}`)
    schemaCreated = true
    await runMigrations(sql, { advisoryLockKey: schema })
    const directory = createSharedMemoryDirectory({
      repository: createPostgresSharedMemoryRepository({
        sql,
        now: () => 1_000,
        idFactory: (prefix) => `${prefix}-${++sequence}`,
      }),
      digestSecret: memoryDigestSecret,
    })
    const owner = principal("person-owner")
    const agent = principal("person-owner", "codex-mcp")
    await directory.enablePersonalAgent(owner, grantor(owner), { agent_id: agent.client_id })
    const created = await directory.rememberPersonalAsAgent(agent, {
      expected_revision: 0,
      idempotency_key: idempotencyKey("agent-create"),
      key: "timezone",
      kind: "preference",
      content: "Use Asia/Taipei.",
    })
    const replay = await directory.rememberPersonalAsAgent(agent, {
      expected_revision: 0,
      idempotency_key: idempotencyKey("agent-create"),
      key: "timezone",
      kind: "preference",
      content: "Use Asia/Taipei.",
    })
    assert.deepEqual(replay, created)
    const corrected = await directory.rememberPersonal(owner, {
      memory_id: created.memory_id,
      expected_revision: created.revision,
      idempotency_key: idempotencyKey("owner-correction"),
      key: "timezone",
      kind: "preference",
      content: "Use Asia/Taipei and a 24-hour clock.",
    })
    assert.equal(corrected.revision, 2)
    await assert.rejects(
      () => directory.rememberPersonalAsAgent(agent, {
        expected_revision: 0,
        idempotency_key: idempotencyKey("agent-cross-kind"),
        key: "timezone",
        kind: "fact",
        content: "Use UTC.",
      }),
      { code: "MEMORY_AGENT_INFERENCE_CONFLICT" },
    )
    await assert.rejects(
      () => directory.rememberPersonalAsAgent(agent, {
        expected_revision: 0,
        idempotency_key: idempotencyKey("agent-create"),
        key: "timezone",
        kind: "preference",
        content: "Use Asia/Taipei.",
      }),
      { code: "MEMORY_IDEMPOTENCY_STATE_SUPERSEDED" },
    )
    await assert.rejects(
      () => directory.rememberPersonalAsAgent(agent, {
        memory_id: created.memory_id,
        expected_revision: corrected.revision,
        idempotency_key: idempotencyKey("agent-conflict"),
        key: "timezone",
        kind: "preference",
        content: "Use UTC.",
      }),
      { code: "MEMORY_AGENT_INFERENCE_CONFLICT" },
    )
    const deleteKey = idempotencyKey("owner-delete")
    const deleted = await directory.deletePersonal(owner, {
      memory_id: created.memory_id,
      expected_revision: corrected.revision,
      idempotency_key: deleteKey,
    })
    assert.equal(deleted.deleted_revision, corrected.revision)
    const rows = await sql.query<{ count: string | number }>(
      "select count(*) as count from genio_one_shared_memories where tenant_id = $1 and memory_id = $2",
      [owner.tenant_id, created.memory_id],
    )
    assert.equal(Number(rows.rows[0]?.count), 0)
    const mutationColumns = await sql.query<{ count: string | number }>(
      `select count(*) as count
         from information_schema.columns
        where table_schema = $1 and table_name = 'genio_one_shared_memory_mutations'
          and column_name = 'content'`,
      [schema],
    )
    assert.equal(Number(mutationColumns.rows[0]?.count), 0)
    const rawKeyColumns = await sql.query<{ count: string | number }>(
      `select count(*) as count
         from information_schema.columns
        where table_schema = $1 and table_name = 'genio_one_shared_memory_mutations'
          and column_name = 'idempotency_key'`,
      [schema],
    )
    assert.equal(Number(rawKeyColumns.rows[0]?.count), 0)
    const mutationDigests = await sql.query<{ idempotency_key_digest: string; request_digest: string }>(
      `select idempotency_key_digest, request_digest
         from genio_one_shared_memory_mutations
        where tenant_id = $1 and memory_id = $2 and operation = 'DELETED'`,
      [owner.tenant_id, created.memory_id],
    )
    assert.equal(mutationDigests.rows.length, 1)
    assert.notEqual(mutationDigests.rows[0]?.idempotency_key_digest, deleteKey)
    assert.notEqual(mutationDigests.rows[0]?.request_digest, deleteKey)
    const replayedDeletion = await directory.deletePersonal(owner, {
      memory_id: created.memory_id,
      expected_revision: corrected.revision,
      idempotency_key: deleteKey,
    })
    assert.deepEqual(replayedDeletion, deleted)
    await directory.revokePersonalAgent(owner, grantor(owner), { agent_id: agent.client_id })
    const agents = await directory.listPersonalAgents(owner, { limit: 1 })
    assert.equal(agents.agents.length, 1)
    assert.equal(agents.agents[0]?.agent_id, agent.client_id)
    assert.notEqual(agents.agents[0]?.revoked_at, null)
    await assert.rejects(
      () => directory.listPersonalAsAgent(agent),
      { code: "MEMORY_AGENT_GRANT_INVALID" },
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
})

test("PostgreSQL serializes an active agent read and write with revoke", { skip: !databaseUrl, timeout: 30_000 }, async () => {
  assert.ok(databaseUrl)
  const schema = `shared_memory_race_${randomUUID().replaceAll("-", "")}`
  const admin = createPostgresSqlAdapter({ url: databaseUrl, options: { max: 1, onnotice: () => {} } })
  const sql = createPostgresSqlAdapter({
    url: databaseUrl,
    options: { max: 4, connection: { search_path: schema }, onnotice: () => {} },
  })
  let schemaCreated = false
  try {
    await admin.query(`create schema ${schema}`)
    schemaCreated = true
    await runMigrations(sql, { advisoryLockKey: schema })
    const repository = createPostgresSharedMemoryRepository({ sql, now: () => 1_000 })
    const directory = createSharedMemoryDirectory({ repository, digestSecret: memoryDigestSecret })
    const owner = principal("person-owner")
    const agent = principal("person-owner", "codex-mcp")
    await directory.enablePersonalAgent(owner, grantor(owner), { agent_id: agent.client_id })
    let enteredResolve: (() => void) | undefined
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve })
    let releaseResolve: (() => void) | undefined
    const release = new Promise<void>((resolve) => { releaseResolve = resolve })
    const operation = repository.withActivePersonalAgent({
      tenantId: owner.tenant_id,
      ownerSubjectId: owner.subject_id,
      agentId: agent.client_id,
    }, async (grant, activeRepository) => {
      const reads = await activeRepository.list({
        tenantId: owner.tenant_id,
        target: { scope: "PERSONAL", ownerSubjectId: owner.subject_id, teamId: null, organizationId: null },
        limit: 1,
        position: null,
        contexts: null,
        query: null,
      })
      assert.deepEqual(reads, [])
      enteredResolve?.()
      await release
      return activeRepository.remember({
        tenantId: owner.tenant_id,
        target: { scope: "PERSONAL", ownerSubjectId: owner.subject_id, teamId: null, organizationId: null },
        memoryId: null,
        expectedRevision: 0,
        idempotencyKeyDigest: "a".repeat(64),
        requestDigest: "b".repeat(64),
        key: "race-write",
        kind: "fact",
        context: { kind: "GLOBAL", context_id: null },
        content: "serialized write",
        assertionOrigin: "AGENT_INFERRED",
        source: {
          actor_subject_id: owner.subject_id,
          client_id: agent.client_id,
          agent_id: agent.client_id,
          agent_grant_id: grant.grant_id,
          reference_id: null,
        },
      })
    })
    await entered
    let revoked = false
    const revocation = directory.revokePersonalAgent(owner, grantor(owner), { agent_id: agent.client_id }).then((value) => {
      revoked = true
      return value
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(revoked, false)
    releaseResolve?.()
    await operation
    await revocation
    await assert.rejects(
      () => directory.retrievePersonalAsAgent(agent, { max_context_chars: 16_000 }),
      { code: "MEMORY_AGENT_GRANT_INVALID" },
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
})

test("PostgreSQL hardens legacy mutation keys without retaining the old key or request digest", { skip: !databaseUrl, timeout: 30_000 }, async () => {
  assert.ok(databaseUrl)
  const schema = `shared_memory_legacy_${randomUUID().replaceAll("-", "")}`
  const admin = createPostgresSqlAdapter({ url: databaseUrl, options: { max: 1, onnotice: () => {} } })
  const sql = createPostgresSqlAdapter({
    url: databaseUrl,
    options: { max: 1, connection: { search_path: schema }, onnotice: () => {} },
  })
  let schemaCreated = false
  try {
    await admin.query(`create schema ${schema}`)
    schemaCreated = true
    const migrations = await loadMigrations()
    await runMigrations(sql, { migrations: migrations.filter((migration) => migration.id <= 17), advisoryLockKey: schema })
    const legacyKey = "b6c7ff2a-0b71-4b6b-804f-25a7c88e670e"
    const legacyRequestDigest = "c".repeat(64)
    await sql.query(
      `insert into genio_one_shared_memory_mutations
        (tenant_id, mutation_id, scope_target_key, memory_id, scope, owner_subject_id,
         actor_subject_id, client_id, agent_id, agent_grant_id, operation,
         previous_revision, revision, assertion_origin, occurred_at, idempotency_key,
         request_digest)
       values ($1,$2,$3,$4,'PERSONAL',$5,$5,'genio-one-self-service',null,null,
               'CREATED',0,1,'USER_EXPLICIT',1000,$6,$7)`,
      ["tenant-memory-live", "legacy-mutation", JSON.stringify(["PERSONAL", "person-owner", null, null]), "legacy-memory", "person-owner", legacyKey, legacyRequestDigest],
    )
    await runMigrations(sql, { advisoryLockKey: schema })
    const columns = await sql.query<{ column_name: string }>(
      `select column_name
         from information_schema.columns
        where table_schema = $1 and table_name = 'genio_one_shared_memory_mutations'`,
      [schema],
    )
    assert.equal(columns.rows.some((row) => row.column_name === "idempotency_key"), false)
    const hardened = await sql.query<{ idempotency_key_digest: string; request_digest: string }>(
      `select idempotency_key_digest, request_digest
         from genio_one_shared_memory_mutations
        where tenant_id = $1 and mutation_id = $2`,
      ["tenant-memory-live", "legacy-mutation"],
    )
    assert.equal(hardened.rows.length, 1)
    assert.match(hardened.rows[0]?.idempotency_key_digest ?? "", /^[a-f0-9]{64}$/)
    assert.match(hardened.rows[0]?.request_digest ?? "", /^[a-f0-9]{64}$/)
    assert.notEqual(hardened.rows[0]?.idempotency_key_digest, legacyKey)
    assert.notEqual(hardened.rows[0]?.request_digest, legacyRequestDigest)
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
})
