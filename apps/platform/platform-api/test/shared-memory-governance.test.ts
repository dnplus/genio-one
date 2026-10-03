import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"

import type { MemoryScope, SharedMemory } from "../src/capabilities/memories/contract"
import {
  createInMemorySharedMemoryRepository,
  type InMemorySharedMemoryScopeAuthorizer,
} from "../src/capabilities/memories/memory"
import {
  createSharedMemoryDirectory,
  selectSharedMemoryRetrieval,
  type VerifiedPersonalMemoryGrantor,
} from "../src/capabilities/memories/module"
import type { Principal } from "../src/capabilities/tenancy-auth/contract"
import { PlatformApiError } from "../src/capabilities/errors"

const tenantId = "tenant-shared-memory-memory"
const organizationId = "organization-shared-memory-memory"
const workspaceId = "workspace-shared-memory-memory"
const digestSecret = Buffer.alloc(32, 19)

function principal(subjectId: string, clientId = "genio-one-self-service"): Principal {
  return {
    tenant_id: tenantId,
    subject_id: subjectId,
    client_id: clientId,
    role: "USER",
    organization_ids: [],
  }
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
  return {
    expected_revision: 0,
    idempotency_key: randomUUID(),
    key: "release-window",
    kind: "fact" as const,
    content: "Deploy after the Tuesday review.",
    ...overrides,
  }
}

function proposalCommand(overrides: Partial<{
  expected_revision: number
  idempotency_key: string
  content: string
  source_reference_id: string
}> = {}) {
  return {
    expected_revision: 1,
    idempotency_key: randomUUID(),
    content: "Deploy after the Wednesday review.",
    ...overrides,
  }
}

function grantor(actor: Principal): VerifiedPersonalMemoryGrantor {
  return {
    actor,
    management_authorized: true,
    person_subject: true,
  }
}

function permissions(subjectId: string): readonly string[] {
  if (subjectId === "manager") return ["READ", "CONTRIBUTE", "MANAGE"]
  if (subjectId === "contributor") return ["READ", "CONTRIBUTE"]
  if (subjectId === "reader") return ["READ"]
  return []
}

function allows(subjectId: string, permission: string): boolean {
  const values = permissions(subjectId)
  return values.includes(permission) || values.includes("MANAGE")
}

function authorizer(): InMemorySharedMemoryScopeAuthorizer {
  return {
    async authorize(input) {
      if (!allows(input.actor.subject_id, input.permission)) {
        throw new PlatformApiError("SHARED_MEMORY_SCOPE_ACCESS_REQUIRED", 403)
      }
      if (input.selector.scope === "TEAM") {
        if (input.selector.workspace_id !== workspaceId) {
          throw new PlatformApiError("SHARED_MEMORY_SCOPE_NOT_FOUND", 404)
        }
        return {
          target: {
            scope: "TEAM",
            ownerSubjectId: null,
            teamId: workspaceId,
            organizationId,
          },
          canManage: allows(input.actor.subject_id, "MANAGE"),
        }
      }
      if (input.selector.organization_id !== organizationId) {
        throw new PlatformApiError("SHARED_MEMORY_SCOPE_NOT_FOUND", 404)
      }
      return {
        target: {
          scope: "ORGANIZATION",
          ownerSubjectId: null,
          teamId: null,
          organizationId,
        },
        canManage: allows(input.actor.subject_id, "MANAGE"),
      }
    },
    async listMemoryScopes(input) {
      if (!allows(input.actor.subject_id, "READ")) return []
      const canManage = allows(input.actor.subject_id, "MANAGE")
      const canContribute = allows(input.actor.subject_id, "CONTRIBUTE")
      return [
        {
          target: { scope: "TEAM", workspace_id: workspaceId },
          display_name: "Release Team",
          can_read: true,
          can_contribute: canContribute,
          can_manage: canManage,
        },
        {
          target: { scope: "ORGANIZATION", organization_id: organizationId },
          display_name: "Acme Organization",
          can_read: true,
          can_contribute: canContribute,
          can_manage: canManage,
        },
      ] satisfies MemoryScope[]
    },
  }
}

function fixture() {
  let now = 1_000
  let sequence = 0
  const repository = createInMemorySharedMemoryRepository({
    now: () => now++,
    idFactory: (prefix) => `${prefix}-${++sequence}`,
    sharedScopeAuthorizer: authorizer(),
  })
  return {
    repository,
    directory: createSharedMemoryDirectory({ repository, digestSecret }),
  }
}

const team = { scope: "TEAM" as const, workspace_id: workspaceId }
const organization = { scope: "ORGANIZATION" as const, organization_id: organizationId }

test("shared scopes expose capabilities and enforce contributor, manager, and proposal boundaries", async () => {
  const f = fixture()
  const contributor = principal("contributor")
  const manager = principal("manager")
  const reader = principal("reader")

  const scopes = await f.directory.listMemoryScopes(contributor)
  assert.deepEqual(scopes.map((scope) => scope.target), [
    { scope: "PERSONAL" },
    organization,
    team,
  ])
  assert.equal(scopes[1]?.can_contribute, true)
  assert.equal(scopes[1]?.can_manage, false)

  const created = await f.directory.rememberShared(contributor, team, command())
  await assert.rejects(
    () => f.directory.rememberShared(contributor, team, command({
      memory_id: created.memory_id,
      expected_revision: created.revision,
      content: "Contributor must not replace directly.",
    })),
    { code: "SHARED_MEMORY_SCOPE_ACCESS_REQUIRED" },
  )

  const firstProposal = await f.directory.createSharedCorrectionProposal(
    contributor,
    team,
    created.memory_id,
    proposalCommand({ content: "Deploy after the Wednesday review." }),
  )
  await assert.rejects(
    () => f.directory.listSharedCorrectionProposals(contributor, team, created.memory_id),
    { code: "SHARED_MEMORY_SCOPE_ACCESS_REQUIRED" },
  )
  await assert.rejects(
    () => f.directory.listSharedCorrectionProposals(reader, team, created.memory_id),
    { code: "SHARED_MEMORY_SCOPE_ACCESS_REQUIRED" },
  )

  const managerCorrection = await f.directory.rememberShared(manager, team, command({
    memory_id: created.memory_id,
    expected_revision: created.revision,
    content: "Deploy after the Thursday review.",
  }))
  assert.equal(managerCorrection.revision, 2)
  assert.equal(managerCorrection.assertion_origin, "USER_EXPLICIT")
  const afterCorrection = await f.directory.listSharedCorrectionProposals(manager, team, created.memory_id)
  assert.equal(afterCorrection.proposals[0]?.proposal_id, firstProposal.proposal_id)
  assert.equal(afterCorrection.proposals[0]?.status, "STALE")
  assert.equal(afterCorrection.proposals[0]?.proposed_content, null)

  const acceptedCandidate = await f.directory.createSharedCorrectionProposal(
    contributor,
    team,
    created.memory_id,
    proposalCommand({
      expected_revision: managerCorrection.revision,
      content: "Deploy after the Friday review.",
    }),
  )
  const staleCandidate = await f.directory.createSharedCorrectionProposal(
    contributor,
    team,
    created.memory_id,
    proposalCommand({
      expected_revision: managerCorrection.revision,
      content: "Deploy after the Monday review.",
    }),
  )
  const accepted = await f.directory.reviewSharedCorrectionProposal(
    manager,
    team,
    created.memory_id,
    acceptedCandidate.proposal_id,
    { action: "ACCEPT" },
  )
  assert.equal(accepted.proposal.status, "ACCEPTED")
  assert.equal(accepted.proposal.proposed_content, null)
  assert.equal(accepted.memory?.content, "Deploy after the Friday review.")
  assert.equal(accepted.memory?.revision, 3)

  const afterAccept = await f.directory.listSharedCorrectionProposals(manager, team, created.memory_id)
  assert.equal(afterAccept.proposals.find((proposal) => proposal.proposal_id === staleCandidate.proposal_id)?.status, "STALE")
  assert.equal(afterAccept.proposals.find((proposal) => proposal.proposal_id === staleCandidate.proposal_id)?.proposed_content, null)

  const pending = await f.directory.createSharedCorrectionProposal(
    contributor,
    team,
    created.memory_id,
    proposalCommand({
      expected_revision: accepted.memory!.revision,
      content: "Deploy after the next release review.",
    }),
  )
  const deletion = await f.directory.deleteShared(manager, team, {
    memory_id: created.memory_id,
    expected_revision: accepted.memory!.revision,
    idempotency_key: randomUUID(),
  })
  assert.equal(deletion.memory_id, created.memory_id)
  assert.equal((await f.directory.listSharedCorrectionProposals(manager, team, created.memory_id)).proposals.length, 0)
  await assert.rejects(
    () => f.directory.getShared(manager, team, created.memory_id),
    { code: "MEMORY_NOT_FOUND" },
  )
  assert.ok(pending.proposal_id)
})

test("agent shared writes return canonical memory or a pending correction and serialize concurrent creates", async () => {
  const f = fixture()
  const owner = principal("contributor")
  const agent = principal("contributor", "agent-alpha")
  const agentTwo = principal("contributor", "agent-beta")
  const manager = principal("manager")
  await f.directory.enablePersonalAgent(owner, grantor(owner), { agent_id: agent.client_id })
  await f.directory.enablePersonalAgent(owner, grantor(owner), { agent_id: agentTwo.client_id })

  const created = await f.directory.rememberSharedAsAgent(agent, team, command({
    key: "agent-policy",
    content: "Keep the maintenance window on Tuesday.",
  }))
  assert.equal(created.result, "MEMORY")
  if (created.result !== "MEMORY") throw new Error("expected canonical memory")
  assert.equal(created.memory.assertion_origin, "AGENT_INFERRED")

  const sameContent = await f.directory.rememberSharedAsAgent(agent, team, command({
    key: "agent-policy",
    kind: "fact",
    content: created.memory.content,
  }))
  assert.equal(sameContent.result, "MEMORY")
  if (sameContent.result !== "MEMORY") throw new Error("expected canonical memory")
  assert.equal(sameContent.memory.memory_id, created.memory.memory_id)

  const differentKind = await f.directory.rememberSharedAsAgent(agent, team, command({
    key: "agent-policy",
    kind: "decision",
    content: created.memory.content,
  }))
  assert.equal(differentKind.result, "MEMORY")
  if (differentKind.result !== "MEMORY") throw new Error("expected distinct decision memory")
  assert.equal(differentKind.memory.kind, "decision")
  assert.notEqual(differentKind.memory.memory_id, created.memory.memory_id)
  assert.equal((await f.directory.getShared(manager, team, created.memory.memory_id)).kind, "fact")

  const conflict = await f.directory.rememberSharedAsAgent(agent, team, command({
    key: "agent-policy",
    content: "Keep the maintenance window on Wednesday.",
  }))
  assert.equal(conflict.result, "PROPOSAL")
  if (conflict.result !== "PROPOSAL") throw new Error("expected pending proposal")
  assert.equal(conflict.proposal.status, "PENDING")
  assert.equal(conflict.proposal.proposed_kind, created.memory.kind)

  const replacement = await f.directory.rememberSharedAsAgent(agent, team, command({
    memory_id: created.memory.memory_id,
    expected_revision: created.memory.revision,
    key: created.memory.key,
    kind: created.memory.kind,
    content: "Keep the maintenance window on Thursday.",
  }))
  assert.equal(replacement.result, "PROPOSAL")

  const first = f.directory.rememberSharedAsAgent(agent, team, command({
    key: "concurrent-agent-policy",
    content: "First concurrent inference.",
  }))
  const second = f.directory.rememberSharedAsAgent(agentTwo, team, command({
    key: "concurrent-agent-policy",
    content: "Second concurrent inference.",
  }))
  const concurrent = await Promise.all([first, second])
  assert.equal(concurrent.filter((value) => value.result === "MEMORY").length, 1)
  assert.equal(concurrent.filter((value) => value.result === "PROPOSAL").length, 1)
  const canonical = concurrent.find((value) => value.result === "MEMORY")
  if (!canonical || canonical.result !== "MEMORY") throw new Error("expected canonical memory")
  const corrections = await f.directory.listSharedCorrectionProposals(manager, team, canonical.memory.memory_id)
  assert.equal(corrections.proposals.filter((proposal) => proposal.status === "PENDING").length, 1)

  const sameFirst = f.directory.rememberSharedAsAgent(agent, team, command({
    key: "concurrent-same-agent-policy",
    content: "Same concurrent inference.",
  }))
  const sameSecond = f.directory.rememberSharedAsAgent(agentTwo, team, command({
    key: "concurrent-same-agent-policy",
    content: "Same concurrent inference.",
  }))
  const sameConcurrent = await Promise.all([sameFirst, sameSecond])
  assert.equal(sameConcurrent.every((value) => value.result === "MEMORY"), true)
  const sameCanonical = sameConcurrent[0]
  if (!sameCanonical || sameCanonical.result !== "MEMORY") throw new Error("expected canonical memory")
  assert.equal(new Set(sameConcurrent.map((value) => value.result === "MEMORY" ? value.memory.memory_id : null)).size, 1)
  assert.equal((await f.directory.listSharedCorrectionProposals(manager, team, sameCanonical.memory.memory_id)).proposals.length, 0)

  const legacyFact = await f.directory.rememberShared(manager, team, command({
    key: "legacy-logical-key",
    kind: "fact",
    content: "Legacy fact.",
  }))
  const legacyDecision = await f.directory.rememberShared(manager, team, command({
    key: "legacy-logical-key",
    kind: "decision",
    content: "Legacy decision.",
  }))
  const legacyCorrection = await f.directory.rememberSharedAsAgent(agent, team, command({
    key: "legacy-logical-key",
    kind: "fact",
    content: "Corrected fact must preserve the separate decision.",
  }))
  assert.equal(legacyCorrection.result, "PROPOSAL")
  if (legacyCorrection.result !== "PROPOSAL") throw new Error("expected fact correction")
  assert.equal(legacyCorrection.proposal.memory_id, legacyFact.memory_id)
  assert.equal(legacyCorrection.proposal.proposed_kind, "fact")
  const accepted = await f.directory.reviewSharedCorrectionProposal(manager, team, legacyFact.memory_id, legacyCorrection.proposal.proposal_id, { action: "ACCEPT" })
  assert.equal(accepted.memory?.kind, "fact")
  assert.equal(accepted.memory?.content, "Corrected fact must preserve the separate decision.")
  assert.deepEqual(await f.directory.getShared(manager, team, legacyDecision.memory_id), legacyDecision)

  const agentScopes = await f.directory.listMemoryScopesAsAgent(agent)
  assert.equal(agentScopes.some((scope) => scope.target.scope === "TEAM"), true)
  const fetched = await f.directory.getSharedAsAgent(agent, team, created.memory.memory_id)
  assert.equal(fetched.memory_id, created.memory.memory_id)
})

test("explicit agent corrections keep the requested revision while inferred corrections use the observed revision", async () => {
  const f = fixture()
  const owner = principal("contributor")
  const agent = principal("contributor", "agent-stale-revision")
  const manager = principal("manager")
  await f.directory.enablePersonalAgent(owner, grantor(owner), { agent_id: agent.client_id })

  const created = await f.directory.rememberShared(manager, team, command({
    key: "revision-guarded-policy",
    content: "Initial policy.",
  }))
  const advanced = await f.directory.rememberShared(manager, team, command({
    memory_id: created.memory_id,
    expected_revision: created.revision,
    key: created.key,
    kind: created.kind,
    content: "Current policy.",
  }))
  assert.equal(advanced.revision, created.revision + 1)

  await assert.rejects(
    () => f.directory.rememberSharedAsAgent(agent, team, command({
      memory_id: created.memory_id,
      expected_revision: created.revision,
      key: created.key,
      kind: created.kind,
      content: "Stale agent correction.",
    })),
    { code: "MEMORY_REVISION_CONFLICT" },
  )
  assert.equal((await f.directory.listSharedCorrectionProposals(manager, team, created.memory_id)).proposals.length, 0)

  const explicit = await f.directory.rememberSharedAsAgent(agent, team, command({
    memory_id: created.memory_id,
    expected_revision: advanced.revision,
    key: created.key,
    kind: created.kind,
    content: "Proposed explicit correction.",
  }))
  assert.equal(explicit.result, "PROPOSAL")
  if (explicit.result !== "PROPOSAL") throw new Error("expected explicit correction proposal")
  assert.equal(explicit.proposal.base_revision, advanced.revision)

  const latest = await f.directory.rememberShared(manager, team, command({
    memory_id: created.memory_id,
    expected_revision: advanced.revision,
    key: created.key,
    kind: created.kind,
    content: "Latest manager policy.",
  }))
  const afterManagerUpdate = await f.directory.listSharedCorrectionProposals(manager, team, created.memory_id)
  const staleExplicit = afterManagerUpdate.proposals.find((proposal) => proposal.proposal_id === explicit.proposal.proposal_id)
  assert.equal(staleExplicit?.status, "STALE")
  assert.equal(staleExplicit?.proposed_content, null)

  const inferred = await f.directory.rememberSharedAsAgent(agent, team, command({
    key: created.key,
    kind: created.kind,
    content: "Proposed inferred correction.",
  }))
  assert.equal(inferred.result, "PROPOSAL")
  if (inferred.result !== "PROPOSAL") throw new Error("expected inferred correction proposal")
  assert.equal(inferred.proposal.base_revision, latest.revision)
})

test("accepted agent corrections expose confirmation state without reviewer identity and direct corrections clear it", async () => {
  const f = fixture()
  const owner = principal("contributor")
  const agent = principal("contributor", "agent-confirmed")
  const manager = principal("manager")
  await f.directory.enablePersonalAgent(owner, grantor(owner), { agent_id: agent.client_id })

  const created = await f.directory.rememberSharedAsAgent(agent, team, command({
    key: "confirmed-agent-policy",
    content: "Initial agent policy.",
  }))
  if (created.result !== "MEMORY") throw new Error("expected canonical memory")
  const proposed = await f.directory.rememberSharedAsAgent(agent, team, command({
    key: created.memory.key,
    kind: created.memory.kind,
    content: "Confirmed agent policy.",
  }))
  if (proposed.result !== "PROPOSAL") throw new Error("expected pending proposal")
  const accepted = await f.directory.reviewSharedCorrectionProposal(
    manager,
    team,
    created.memory.memory_id,
    proposed.proposal.proposal_id,
    { action: "ACCEPT" },
  )
  if (!accepted.memory) throw new Error("expected accepted memory")
  assert.equal(accepted.memory.assertion_origin, "AGENT_INFERRED")
  assert.equal(accepted.memory.source.agent_id, agent.client_id)
  assert.deepEqual(accepted.memory.confirmation, {
    confirmed: true,
    reviewed_at: accepted.memory.updated_at,
  })
  assert.equal("reviewer_subject_id" in accepted.memory.confirmation!, false)
  assert.equal("reviewer_client_id" in accepted.memory.confirmation!, false)

  const confirmedResult = await f.directory.retrieveMemoryTargets(manager, {
    targets: [team],
    limit: 20,
    max_context_chars: 16_000,
  })
  const retrieved = confirmedResult.memories.find((memory) => memory.memory_id === accepted.memory!.memory_id)
  assert.equal(retrieved?.confirmed, true)
  assert.equal("confirmation" in (retrieved ?? {}), false)
  const contextEntry = confirmedResult.context.split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((entry) => entry.memory_id === accepted.memory!.memory_id)
  assert.equal(contextEntry?.confirmed, true)
  assert.equal("reviewer_subject_id" in (contextEntry ?? {}), false)
  assert.equal("reviewer_client_id" in (contextEntry ?? {}), false)

  const corrected = await f.directory.rememberShared(manager, team, command({
    memory_id: accepted.memory.memory_id,
    expected_revision: accepted.memory.revision,
    key: accepted.memory.key,
    kind: accepted.memory.kind,
    content: "Manager correction clears confirmation.",
  }))
  assert.equal(corrected.assertion_origin, "USER_EXPLICIT")
  assert.equal(corrected.confirmation, null)
  const correctedResult = await f.directory.retrieveMemoryTargets(manager, {
    targets: [team],
    limit: 20,
    max_context_chars: 16_000,
  })
  assert.equal(correctedResult.memories.find((memory) => memory.memory_id === corrected.memory_id)?.confirmed, false)
})

test("multi-target retrieval preserves shared differences and matches contexts exactly", async () => {
  const f = fixture()
  const manager = principal("manager")
  const personal = await f.directory.rememberPersonal(manager, command({
    key: "release-policy",
    content: "Personal release policy.",
  }))
  const teamMemory = await f.directory.rememberShared(manager, team, command({
    key: "release-policy",
    content: "Team release policy.",
  }))
  const organizationMemory = await f.directory.rememberShared(manager, organization, command({
    key: "release-policy",
    content: "Organization release policy.",
  }))

  const result = await f.directory.retrieveMemoryTargets(manager, {
    targets: [{ scope: "PERSONAL" }, team, organization],
    limit: 20,
    max_context_chars: 16_000,
  })
  assert.equal(result.precedence, "NONE")
  const shared = result.memories.filter((memory) => memory.key === "release-policy")
  assert.deepEqual(new Set(shared.map((memory) => memory.memory_id)), new Set([
    personal.memory_id,
    teamMemory.memory_id,
    organizationMemory.memory_id,
  ]))
  assert.ok(shared.every((memory) => memory.conflict))
  const contextEntries = result.context.split("\n").map((line) => JSON.parse(line) as {
    scope: string
    owner_subject_id: string | null
    team_id: string | null
    organization_id: string | null
  })
  assert.ok(contextEntries.every((entry) => "scope" in entry && "owner_subject_id" in entry && "team_id" in entry && "organization_id" in entry))

  const projectA = await f.directory.rememberShared(manager, team, command({
    key: "project-policy",
    context: { kind: "PROJECT", context_id: "project-a" },
    content: "Project A policy.",
  }))
  const projectB = await f.directory.rememberShared(manager, team, command({
    key: "project-policy",
    context: { kind: "PROJECT", context_id: "project-b" },
    content: "Project B policy.",
  }))
  const projectResult = await f.directory.retrieveMemoryTargets(manager, {
    targets: [team],
    context: { kind: "PROJECT", context_id: "project-a" },
    limit: 20,
    max_context_chars: 16_000,
  })
  assert.equal(projectResult.memories.some((memory) => memory.memory_id === projectA.memory_id), true)
  assert.equal(projectResult.memories.some((memory) => memory.memory_id === projectB.memory_id), false)
})

test("multi-target retrieval retains an older explicit companion beyond one hundred target rows", async () => {
  const f = fixture()
  const manager = principal("manager")
  const kinds = ["fact", "preference", "decision"] as const
  const correctionKey = "older-explicit-correction"
  const personalKeys = Array.from({ length: 19 }, (_, index) => `personal-candidate-${index}`)
  const teamKeys = Array.from({ length: 14 }, (_, index) => `team-candidate-${index}`)
  const olderExplicit = await f.directory.rememberShared(manager, team, command({
    key: correctionKey,
    kind: "fact",
    content: "Older explicit correction.",
  }))

  for (const key of personalKeys) {
    for (const kind of kinds) {
      await f.directory.rememberShared(manager, team, command({
        key,
        kind,
        content: `${key} ${kind}.`,
      }))
    }
  }
  for (const kind of ["preference", "decision"] as const) {
    await f.directory.rememberShared(manager, team, command({
      key: correctionKey,
      kind,
      content: `${correctionKey} ${kind}.`,
    }))
  }
  for (const [index, key] of teamKeys.entries()) {
    const earlyKinds = index < 6 ? ["fact"] as const : ["fact", "preference"] as const
    for (const kind of earlyKinds) {
      await f.directory.rememberShared(manager, team, command({
        key,
        kind,
        content: `${key} ${kind}.`,
      }))
    }
  }
  for (const [index, key] of teamKeys.entries()) {
    const lateKinds = index < 6 ? ["preference", "decision"] as const : ["decision"] as const
    for (const kind of lateKinds) {
      await f.directory.rememberShared(manager, team, command({
        key,
        kind,
        content: `${key} ${kind}.`,
      }))
    }
  }
  for (const key of personalKeys) {
    await f.directory.rememberPersonal(manager, command({
      key,
      content: `Personal ${key}.`,
    }))
  }
  await f.directory.rememberPersonal(manager, command({
    key: correctionKey,
    content: "Newest personal correction.",
  }))

  const firstPage = await f.directory.listShared(manager, team, { limit: 100 })
  const secondPage = await f.directory.listShared(manager, team, { limit: 100, cursor: firstPage.next_cursor! })
  assert.equal(firstPage.memories.length + secondPage.memories.length, 102)

  const result = await f.directory.retrieveMemoryTargets(manager, {
    targets: [{ scope: "PERSONAL" }, team],
    limit: 20,
    max_context_chars: 16_000,
  })
  assert.equal(result.memories.some((memory) => memory.memory_id === olderExplicit.memory_id), true)
  const recovered = result.memories.find((memory) => memory.memory_id === olderExplicit.memory_id)
  assert.equal(recovered?.scope, "TEAM")
  assert.equal(recovered?.assertion_origin, "USER_EXPLICIT")
  assert.equal(recovered?.conflict, true)
})

function storedMemory(input: {
  memoryId: string
  content: string
  assertionOrigin: SharedMemory["assertion_origin"]
  updatedAt: number
  confirmation?: SharedMemory["confirmation"]
}): SharedMemory {
  const inferred = input.assertionOrigin === "AGENT_INFERRED"
  return {
    memory_id: input.memoryId,
    tenant_id: tenantId,
    scope: "PERSONAL",
    owner_subject_id: "manager",
    team_id: null,
    organization_id: null,
    key: "priority-conflict",
    kind: inferred ? "fact" : "preference",
    context: { kind: "GLOBAL", context_id: null },
    content: input.content,
    assertion_origin: input.assertionOrigin,
    source: {
      actor_subject_id: "manager",
      client_id: inferred ? "agent-priority" : "genio-one-self-service",
      agent_id: inferred ? "agent-priority" : null,
      agent_grant_id: inferred ? "grant-priority" : null,
      reference_id: null,
    },
    confirmation: input.confirmation ?? null,
    revision: 1,
    created_at: input.updatedAt,
    updated_at: input.updatedAt,
  }
}

test("confirmed agent inference receives human ordering only within one scope", () => {
  const confirmed = storedMemory({
    memoryId: "confirmed-same-scope",
    content: "Confirmed inference.",
    assertionOrigin: "AGENT_INFERRED",
    confirmation: { confirmed: true, reviewed_at: 1 },
    updatedAt: 1,
  })
  const newerInference = storedMemory({
    memoryId: "newer-unconfirmed-same-scope",
    content: "Newer inference.",
    assertionOrigin: "AGENT_INFERRED",
    updatedAt: 100,
  })
  const sameScope = selectSharedMemoryRetrieval([confirmed, newerInference], { limit: 1 })
  assert.deepEqual(sameScope[0]?.entries.map((entry) => entry.memory.memory_id), [confirmed.memory_id])

  const crossScopeConfirmed = {
    ...confirmed,
    memory_id: "confirmed-cross-scope",
    updated_at: 100,
    created_at: 100,
  }
  const olderExplicitElsewhere: SharedMemory = {
    ...storedMemory({
      memoryId: "explicit-cross-scope",
      content: "Older explicit assertion.",
      assertionOrigin: "USER_EXPLICIT",
      updatedAt: 1,
    }),
    scope: "TEAM",
    owner_subject_id: null,
    team_id: "other-team",
    organization_id: "other-organization",
  }
  const crossScope = selectSharedMemoryRetrieval([crossScopeConfirmed, olderExplicitElsewhere], { limit: 1 })
  assert.deepEqual(crossScope[0]?.entries.map((entry) => entry.memory.memory_id), [crossScopeConfirmed.memory_id])
})

test("retrieval limit retains the explicit entry from a conflict group", () => {
  const explicit = storedMemory({
    memoryId: "explicit-priority",
    content: "Use Asia/Taipei.",
    assertionOrigin: "USER_EXPLICIT",
    updatedAt: 1,
  })
  const inferred = storedMemory({
    memoryId: "inferred-priority",
    content: "Use UTC.",
    assertionOrigin: "AGENT_INFERRED",
    updatedAt: 100,
  })
  const units = selectSharedMemoryRetrieval([explicit, inferred], { limit: 1 })
  assert.equal(units.length, 1)
  assert.deepEqual(units[0]?.entries.map((entry) => entry.memory.memory_id), [explicit.memory_id])
  assert.equal(units[0]?.entries[0]?.conflict, true)
})
