import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"

import type { SharedMemory } from "../src/capabilities/memories/contract"
import { createInMemorySharedMemoryRepository } from "../src/capabilities/memories/memory"
import {
  createSharedMemoryDirectory,
  type SharedMemoryRepository,
  type VerifiedPersonalMemoryGrantor,
} from "../src/capabilities/memories/module"
import type { Principal } from "../src/capabilities/tenancy-auth/contract"

const tenantId = "tenant-memories"
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
    tenant_id: tenantId,
    subject_id: subjectId,
    client_id: clientId,
    role: "USER",
    organization_ids: [],
  }
}

function fixture() {
  let now = 1_000
  let sequence = 0
  const repository = createInMemorySharedMemoryRepository({
    now: () => now++,
    idFactory: (prefix) => `${prefix}-${++sequence}`,
  })
  return {
    repository,
    directory: createSharedMemoryDirectory({ repository, digestSecret: memoryDigestSecret }),
    grantor(actor: Principal): VerifiedPersonalMemoryGrantor {
      return {
        actor,
        management_authorized: true,
        person_subject: true,
      }
    },
  }
}

function storedMemory(input: {
  memoryId: string
  key: string
  kind: SharedMemory["kind"]
  context: SharedMemory["context"]
  content: string
  assertionOrigin: SharedMemory["assertion_origin"]
  updatedAt: number
}): SharedMemory {
  const inferred = input.assertionOrigin === "AGENT_INFERRED"
  return {
    memory_id: input.memoryId,
    tenant_id: tenantId,
    scope: "PERSONAL",
    owner_subject_id: "person-first",
    team_id: null,
    organization_id: null,
    key: input.key,
    kind: input.kind,
    context: input.context,
    content: input.content,
    assertion_origin: input.assertionOrigin,
    source: {
      actor_subject_id: "person-first",
      client_id: inferred ? "codex-mcp" : "genio-one-self-service",
      agent_id: inferred ? "codex-mcp" : null,
      agent_grant_id: inferred ? "grant-legacy" : null,
      reference_id: null,
    },
    revision: 1,
    confirmation: null,
    created_at: input.updatedAt,
    updated_at: input.updatedAt,
  }
}

function retrievalOnlyDirectory(values: readonly SharedMemory[]) {
  const repository = {
    async list(input: Parameters<SharedMemoryRepository["list"]>[0]) {
      const keys = (input as { keys?: readonly string[] | null }).keys ?? null
      const normalizedQuery = input.query?.toLocaleLowerCase() ?? null
      return values
        .filter((memory) => memory.tenant_id === input.tenantId &&
          memory.scope === input.target.scope &&
          memory.owner_subject_id === input.target.ownerSubjectId &&
          memory.team_id === input.target.teamId &&
          memory.organization_id === input.target.organizationId)
        .filter((memory) => input.contexts === null || input.contexts.some((context) => (
          memory.context.kind === context.kind && memory.context.context_id === context.context_id
        )))
        .filter((memory) => keys === null || keys.includes(memory.key))
        .filter((memory) => normalizedQuery === null || memory.key.toLocaleLowerCase().includes(normalizedQuery) || memory.content.toLocaleLowerCase().includes(normalizedQuery))
        .sort((left, right) => right.updated_at - left.updated_at || left.memory_id.localeCompare(right.memory_id))
        .filter((memory) => input.position === null ||
          memory.updated_at < input.position.updatedAt ||
          (memory.updated_at === input.position.updatedAt && memory.memory_id > input.position.memoryId))
        .slice(0, input.limit)
        .map((memory) => structuredClone(memory))
    },
  } as unknown as SharedMemoryRepository
  return createSharedMemoryDirectory({ repository, digestSecret: memoryDigestSecret })
}

function command(overrides: Partial<{
  memory_id: string
  expected_revision: number
  idempotency_key: string
  key: string
  kind: "preference" | "fact" | "decision"
  context: { kind: "GLOBAL" | "PROJECT" | "CONTEXT"; context_id: string | null }
  content: string
  source_reference_id: string
}> = {}) {
  const { idempotency_key: idempotencyKeyLabel, ...rest } = overrides
  return {
    expected_revision: 0,
    idempotency_key: idempotencyKey(idempotencyKeyLabel ?? "request-1"),
    key: "timezone",
    kind: "preference" as const,
    content: "Use Asia/Taipei for future schedules.",
    ...rest,
  }
}

test("personal memory derives ownership from the verified actor and rejects cross-owner access", async () => {
  const f = fixture()
  const first = principal("person-first")
  const second = principal("person-second")
  const created = await f.directory.rememberPersonal(first, command())

  assert.equal(created.owner_subject_id, first.subject_id)
  assert.equal(created.scope, "PERSONAL")
  assert.equal(created.source.actor_subject_id, first.subject_id)
  assert.equal(created.source.client_id, first.client_id)
  assert.equal(created.source.agent_id, null)

  await assert.rejects(
    () => f.directory.getPersonal(second, created.memory_id),
    { code: "MEMORY_NOT_FOUND" },
  )
  assert.deepEqual(await f.directory.listPersonal(second), { memories: [], next_cursor: null })
  await assert.rejects(
    () => f.directory.deletePersonal(second, {
      memory_id: created.memory_id,
      expected_revision: 1,
      idempotency_key: idempotencyKey("other-delete"),
    }),
    { code: "MEMORY_NOT_FOUND" },
  )
})

test("personal memory uses idempotency and CAS without silently replacing a stable identity", async () => {
  const f = fixture()
  const actor = principal("person-first")
  const created = await f.directory.rememberPersonal(actor, command())
  const replay = await f.directory.rememberPersonal(actor, command())

  assert.deepEqual(replay, created)
  await assert.rejects(
    () => f.directory.rememberPersonal(actor, command({ content: "Use UTC.", idempotency_key: "request-1" })),
    { code: "MEMORY_IDEMPOTENCY_KEY_REUSED" },
  )
  await assert.rejects(
    () => f.directory.rememberPersonal(actor, command({ content: "Use UTC.", idempotency_key: "request-2" })),
    { code: "MEMORY_KEY_CONFLICT" },
  )

  const corrected = await f.directory.rememberPersonal(actor, command({
    memory_id: created.memory_id,
    expected_revision: created.revision,
    idempotency_key: "request-3",
    content: "Use Asia/Taipei and show the local date.",
  }))
  assert.equal(corrected.revision, 2)
  assert.equal(corrected.assertion_origin, "USER_EXPLICIT")
  await assert.rejects(
    () => f.directory.rememberPersonal(actor, command({
      memory_id: created.memory_id,
      expected_revision: 1,
      idempotency_key: "request-4",
      content: "Use UTC.",
    })),
    { code: "MEMORY_REVISION_CONFLICT" },
  )
  await assert.rejects(
    () => f.directory.rememberPersonal(actor, command()),
    { code: "MEMORY_IDEMPOTENCY_STATE_SUPERSEDED" },
  )
})

test("memory digest-key rotation cannot revive a deleted idempotent create", async () => {
  const repository = createInMemorySharedMemoryRepository()
  const actor = principal("person-first")
  const firstDirectory = createSharedMemoryDirectory({ repository, digestSecret: Buffer.alloc(32, 7) })
  const rotatedDirectory = createSharedMemoryDirectory({ repository, digestSecret: Buffer.alloc(32, 8) })
  const request = command({ idempotency_key: "digest-key-rotation" })
  const created = await firstDirectory.rememberPersonal(actor, request)
  await firstDirectory.deletePersonal(actor, {
    memory_id: created.memory_id,
    expected_revision: created.revision,
    idempotency_key: idempotencyKey("digest-key-rotation-delete"),
  })
  await assert.rejects(
    () => rotatedDirectory.rememberPersonal(actor, request),
    { code: "MEMORY_IDEMPOTENCY_KEY_REUSED" },
  )
})

test("agent memory requires an active per-agent grant and cannot overwrite a conflicting inference", async () => {
  const f = fixture()
  const owner = principal("person-first")
  const agent = principal("person-first", "codex-mcp")

  await assert.rejects(
    () => f.directory.rememberPersonalAsAgent(agent, command({ idempotency_key: "agent-1" })),
    { code: "MEMORY_AGENT_GRANT_INVALID" },
  )
  const grant = await f.directory.enablePersonalAgent(owner, f.grantor(owner), { agent_id: agent.client_id })
  assert.equal(grant.agent_id, agent.client_id)
  const created = await f.directory.rememberPersonalAsAgent(agent, command({ idempotency_key: "agent-1" }))
  assert.equal(created.assertion_origin, "AGENT_INFERRED")
  assert.equal(created.source.agent_id, agent.client_id)
  assert.equal(created.source.agent_grant_id, grant.grant_id)

  await assert.rejects(
    () => f.directory.rememberPersonalAsAgent(agent, command({
      idempotency_key: "agent-2",
      content: "Use UTC.",
    })),
    { code: "MEMORY_AGENT_INFERENCE_CONFLICT" },
  )
  await assert.rejects(
    () => f.directory.rememberPersonalAsAgent(agent, command({
      idempotency_key: "agent-cross-kind",
      kind: "decision",
      content: "Use Asia/Taipei.",
    })),
    { code: "MEMORY_AGENT_INFERENCE_CONFLICT" },
  )
  const corrected = await f.directory.rememberPersonal(owner, command({
    memory_id: created.memory_id,
    expected_revision: created.revision,
    idempotency_key: "owner-correction",
    content: "Use Asia/Taipei with a 24-hour clock.",
  }))
  assert.equal(corrected.assertion_origin, "USER_EXPLICIT")
  await f.directory.revokePersonalAgent(owner, f.grantor(owner), { agent_id: agent.client_id })
  await assert.rejects(
    () => f.directory.retrievePersonalAsAgent(agent, { max_context_chars: 100 }),
    { code: "MEMORY_AGENT_GRANT_INVALID" },
  )
})

test("personal retrieval and pagination are bounded, and deletion removes the content while retaining an idempotent deletion result", async () => {
  const f = fixture()
  const actor = principal("person-first")
  const first = await f.directory.rememberPersonal(actor, command({
    key: "first",
    idempotency_key: "first",
    content: "a".repeat(1_024),
  }))
  await f.directory.rememberPersonal(actor, command({
    key: "second",
    idempotency_key: "second",
    content: "second content",
  }))
  await f.directory.rememberPersonal(actor, command({
    key: "third",
    idempotency_key: "third",
    content: "third content",
  }))

  const pageOne = await f.directory.listPersonal(actor, { limit: 1 })
  const pageTwo = await f.directory.listPersonal(actor, { limit: 1, cursor: pageOne.next_cursor! })
  assert.equal(pageOne.memories.length, 1)
  assert.equal(pageTwo.memories.length, 1)
  assert.notEqual(pageOne.memories[0]?.memory_id, pageTwo.memories[0]?.memory_id)

  const context = await f.directory.retrievePersonal(actor, {
    query: "first",
    max_context_chars: 400,
  })
  const contextEntry = JSON.parse(context.context) as { key: string; content: string; content_truncated: boolean }
  assert.equal(contextEntry.key, "first")
  assert.ok(contextEntry.content.length < first.content.length)
  assert.equal(contextEntry.content_truncated, true)
  assert.equal(context.memories[0]?.content_truncated, true)
  assert.ok(context.context.length <= 400)

  const deletion = await f.directory.deletePersonal(actor, {
    memory_id: first.memory_id,
    expected_revision: first.revision,
    idempotency_key: idempotencyKey("forget-first"),
  })
  assert.equal(deletion.memory_id, first.memory_id)
  await assert.rejects(
    () => f.directory.getPersonal(actor, first.memory_id),
    { code: "MEMORY_NOT_FOUND" },
  )
  const replay = await f.directory.deletePersonal(actor, {
    memory_id: first.memory_id,
    expected_revision: first.revision,
    idempotency_key: idempotencyKey("forget-first"),
  })
  assert.deepEqual(replay, deletion)
})

test("personal retrieval returns GLOBAL alone by default and GLOBAL with its requested context", async () => {
  const f = fixture()
  const actor = principal("person-first")
  const global = await f.directory.rememberPersonal(actor, command({
    key: "global",
    idempotency_key: "global",
    content: "global memory",
  }))
  const projectA = await f.directory.rememberPersonal(actor, command({
    key: "project-a",
    idempotency_key: "project-a",
    context: { kind: "PROJECT", context_id: "project-a" },
    content: "project a memory",
  }))
  const projectB = await f.directory.rememberPersonal(actor, command({
    key: "project-b",
    idempotency_key: "project-b",
    context: { kind: "PROJECT", context_id: "project-b" },
    content: "project b memory",
  }))
  const contextA = await f.directory.rememberPersonal(actor, command({
    key: "context-a",
    idempotency_key: "context-a",
    context: { kind: "CONTEXT", context_id: "context-a" },
    content: "context a memory",
  }))
  const contextB = await f.directory.rememberPersonal(actor, command({
    key: "context-b",
    idempotency_key: "context-b",
    context: { kind: "CONTEXT", context_id: "context-b" },
    content: "context b memory",
  }))

  const defaultResult = await f.directory.retrievePersonal(actor, { max_context_chars: 16_000 })
  assert.deepEqual(defaultResult.memories.map((value) => value.memory_id), [global.memory_id])

  const projectResult = await f.directory.retrievePersonal(actor, {
    context: { kind: "PROJECT", context_id: "project-a" },
    max_context_chars: 16_000,
  })
  assert.deepEqual(new Set(projectResult.memories.map((value) => value.memory_id)), new Set([global.memory_id, projectA.memory_id]))
  assert.equal(projectResult.memories.some((value) => value.memory_id === projectB.memory_id), false)
  assert.equal(projectResult.memories.some((value) => value.memory_id === contextA.memory_id), false)
  assert.equal(projectResult.memories.some((value) => value.memory_id === contextB.memory_id), false)

  const contextResult = await f.directory.retrievePersonal(actor, {
    context: { kind: "CONTEXT", context_id: "context-a" },
    max_context_chars: 16_000,
  })
  assert.deepEqual(new Set(contextResult.memories.map((value) => value.memory_id)), new Set([global.memory_id, contextA.memory_id]))
  assert.equal(contextResult.memories.some((value) => value.memory_id === projectA.memory_id), false)
  assert.equal(contextResult.memories.some((value) => value.memory_id === contextB.memory_id), false)
})

test("retrieval retains GLOBAL and labels cross-context content conflicts beyond twenty PROJECT candidates", async () => {
  const f = fixture()
  const owner = principal("person-first")
  const agent = principal("person-first", "codex-mcp")
  const global = await f.directory.rememberPersonal(owner, command({
    key: "timezone",
    idempotency_key: "global-timezone",
    content: "Use Asia/Taipei.",
  }))
  await f.directory.enablePersonalAgent(owner, f.grantor(owner), { agent_id: agent.client_id })
  for (let index = 0; index < 20; index += 1) {
    await f.directory.rememberPersonal(owner, command({
      key: "project-memory-" + index,
      idempotency_key: "project-memory-" + index,
      context: { kind: "PROJECT", context_id: "project-a" },
      content: "project memory " + index,
    }))
  }
  const project = await f.directory.rememberPersonalAsAgent(agent, command({
    key: "timezone",
    idempotency_key: "project-timezone",
    context: { kind: "PROJECT", context_id: "project-a" },
    content: "Use UTC.",
  }))

  const result = await f.directory.retrievePersonal(owner, {
    context: { kind: "PROJECT", context_id: "project-a" },
    limit: 20,
    max_context_chars: 16_000,
  })
  const timezone = result.memories.filter((memory) => memory.key === "timezone")
  assert.deepEqual(timezone.map((memory) => memory.memory_id), [global.memory_id, project.memory_id])
  assert.ok(timezone.every((memory) => memory.conflict))
  assert.deepEqual(timezone.map((memory) => memory.assertion_origin), ["USER_EXPLICIT", "AGENT_INFERRED"])
  const entries = result.context.split("\n").map((value) => JSON.parse(value) as { key: string; conflict: boolean; source: { agent_id: string | null } })
  const timezoneEntries = entries.filter((entry) => entry.key === "timezone")
  assert.ok(timezoneEntries.every((entry) => entry.conflict))
  assert.deepEqual(timezoneEntries.map((entry) => entry.source.agent_id), [null, agent.client_id])
})

test("retrieval keeps an explicit assertion ahead of a later inference and labels the conflict", async () => {
  const explicit = storedMemory({
    memoryId: "ordered-explicit",
    key: "timezone",
    kind: "preference",
    context: { kind: "GLOBAL", context_id: null },
    content: "Use Asia/Taipei.",
    assertionOrigin: "USER_EXPLICIT",
    updatedAt: 1,
  })
  const inferred = storedMemory({
    memoryId: "ordered-inferred",
    key: "timezone",
    kind: "fact",
    context: { kind: "GLOBAL", context_id: null },
    content: "Use UTC.",
    assertionOrigin: "AGENT_INFERRED",
    updatedAt: 100,
  })

  const result = await retrievalOnlyDirectory([explicit, inferred]).retrievePersonal(
    principal("person-first"),
    { max_context_chars: 16_000 },
  )
  assert.deepEqual(result.memories.map((value) => value.memory_id), [explicit.memory_id, inferred.memory_id])
  assert.deepEqual(result.memories.map((value) => value.conflict), [true, true])
  const entries = result.context.split("\n").map((value) => JSON.parse(value) as {
    key: string
    context: { kind: string; context_id: string | null }
    source: { actor_subject_id: string; client_id: string; agent_id: string | null }
    assertion_origin: string
    conflict: boolean
  })
  assert.deepEqual(entries.map((value) => value.assertion_origin), ["USER_EXPLICIT", "AGENT_INFERRED"])
  assert.ok(entries.every((value) => value.key === "timezone" && value.context.kind === "GLOBAL" && value.conflict))
  assert.equal(entries[1]?.source.agent_id, "codex-mcp")
})

test("retrieval recovers an older explicit counterpart from legacy same-context inferred conflicts", async () => {
  const explicit = storedMemory({
    memoryId: "legacy-explicit",
    key: "timezone",
    kind: "preference",
    context: { kind: "GLOBAL", context_id: null },
    content: "Use Asia/Taipei.",
    assertionOrigin: "USER_EXPLICIT",
    updatedAt: 1,
  })
  const inferred = storedMemory({
    memoryId: "legacy-inferred",
    key: "timezone",
    kind: "fact",
    context: { kind: "GLOBAL", context_id: null },
    content: "Use UTC.",
    assertionOrigin: "AGENT_INFERRED",
    updatedAt: 100,
  })
  const filler = Array.from({ length: 20 }, (_, index) => storedMemory({
    memoryId: "legacy-filler-" + index,
    key: "filler-" + index,
    kind: "fact",
    context: { kind: "GLOBAL", context_id: null },
    content: "filler " + index,
    assertionOrigin: "USER_EXPLICIT",
    updatedAt: index + 2,
  }))
  const directory = retrievalOnlyDirectory([explicit, inferred, ...filler])
  const result = await directory.retrievePersonal(principal("person-first"), { limit: 20, max_context_chars: 16_000 })
  const timezone = result.memories.filter((memory) => memory.key === "timezone")
  assert.deepEqual(timezone.map((memory) => memory.memory_id), [explicit.memory_id, inferred.memory_id])
  assert.ok(timezone.every((memory) => memory.conflict))
  assert.deepEqual(timezone.map((memory) => memory.assertion_origin), ["USER_EXPLICIT", "AGENT_INFERRED"])
})

test("an active agent read and write hold the grant lock until revoke can run", async () => {
  const f = fixture()
  const owner = principal("person-first")
  const agent = principal("person-first", "codex-mcp")
  await f.directory.enablePersonalAgent(owner, f.grantor(owner), { agent_id: agent.client_id })
  let enteredResolve: (() => void) | undefined
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve })
  let releaseResolve: (() => void) | undefined
  const release = new Promise<void>((resolve) => { releaseResolve = resolve })
  const operation = f.repository.withActivePersonalAgent({
    tenantId,
    ownerSubjectId: owner.subject_id,
    agentId: agent.client_id,
  }, async (grant, activeRepository) => {
    const reads = await activeRepository.list({
      tenantId,
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
      tenantId,
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
  const revocation = f.directory.revokePersonalAgent(owner, f.grantor(owner), { agent_id: agent.client_id }).then((value) => {
    revoked = true
    return value
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(revoked, false)
  releaseResolve?.()
  const created = await operation
  assert.equal(created.source.agent_grant_id, (await f.directory.getPersonalAgent(owner, agent.client_id))?.grant_id)
  await revocation
  await assert.rejects(
    () => f.directory.listPersonalAsAgent(agent),
    { code: "MEMORY_AGENT_GRANT_INVALID" },
  )
})
