import assert from "node:assert/strict"
import test from "node:test"

import { createManagementApi } from "../src/app"
import type { KnowledgeCandidate } from "../src/capabilities/distillation/contract"
import type { BotFetch, KnowledgeEvidenceReader } from "../src/capabilities/distillation/http"
import type { DistillationStore } from "../src/capabilities/distillation/module"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import type { Principal } from "../src/capabilities/tenancy-auth/contract"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"
import { DISTILLATION_EXTRACTOR_VERSION } from "@genioone/protocol/distillation-triage"

const tenantId = "tenant-evidence"
const digest = "a".repeat(64)

function person(subjectId: string, scopes: string[]): Principal {
  return {
    tenant_id: tenantId,
    subject_id: subjectId,
    client_id: "management-ui",
    role: "USER",
    organization_ids: [],
    scopes,
  }
}

function evidenceFor(candidate: KnowledgeCandidate) {
  return {
    knowledge_id: candidate.knowledge_id,
    tenant_id: candidate.tenant_id,
    workspace_id: candidate.workspace_id,
    content_digest: candidate.content_digest,
    turns: candidate.provenance.turn_ids.map((turnId) => ({ turn_id: turnId, text: "review evidence", truncated: false })),
  }
}

async function createFixture(options: {
  evidenceReader?: KnowledgeEvidenceReader
  botFetch?: BotFetch
  configureModules?: (modules: ReturnType<typeof createInMemoryPlatformModules>) => void
} = {}) {
  const modules = createInMemoryPlatformModules({ now: () => 1_000 })
  const admin: Principal = {
    tenant_id: tenantId,
    subject_id: "admin",
    client_id: "management-ui",
    role: "TENANT_ADMINISTRATOR",
    organization_ids: [],
    scopes: ["genioone-management"],
  }
  options.configureModules?.(modules)
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    ...(options.evidenceReader ? { knowledgeEvidenceReader: options.evidenceReader } : {}),
    ...(options.botFetch ? { botServiceEndpoint: "https://bot.example/service", botFetch: options.botFetch } : {}),
    principalAuthenticator: createStaticPrincipalAuthenticator({
      admin,
      owner: person("owner", ["genioone-invocation", "genioone-management"]),
      maintainer: person("maintainer", ["genioone-management"]),
      "other-maintainer": person("other-maintainer", ["genioone-management"]),
      reader: person("reader", ["genioone-management"]),
      "invocation-maintainer": person("maintainer", ["genioone-invocation"]),
    }),
  })
  await modules.identity.bootstrap({
    tenantId,
    subjects: [
      { subject_id: "admin", kind: "PERSON", role: "TENANT_ADMINISTRATOR" },
      { subject_id: "owner", kind: "PERSON" },
      { subject_id: "maintainer", kind: "PERSON" },
      { subject_id: "other-maintainer", kind: "PERSON" },
      { subject_id: "reader", kind: "PERSON" },
    ],
  })
  const organization = await modules.organizations.create({ tenantId, display_name: "Evidence" })
  for (const [accessGroupId, displayName] of [
    ["readers", "Readers"],
    ["contributors", "Contributors"],
    ["maintainers", "Maintainers"],
    ["other-maintainers", "Other maintainers"],
  ] as const) {
    await modules.accessGroups.save(admin, accessGroupId, {
      expected_revision: 0,
      display_name: displayName,
      description: "",
      enabled: true,
    })
  }
  await modules.accessGroups.replaceMembers(admin, "readers", {
    expected_group_revision: 1,
    expected_source_revision: 0,
    subject_ids: ["reader"],
  })
  await modules.accessGroups.replaceMembers(admin, "contributors", {
    expected_group_revision: 1,
    expected_source_revision: 0,
    subject_ids: ["owner"],
  })
  await modules.accessGroups.replaceMembers(admin, "maintainers", {
    expected_group_revision: 1,
    expected_source_revision: 0,
    subject_ids: ["maintainer"],
  })
  await modules.accessGroups.replaceMembers(admin, "other-maintainers", {
    expected_group_revision: 1,
    expected_source_revision: 0,
    subject_ids: ["other-maintainer"],
  })
  const workspace = await app.inject({
    method: "POST",
    url: `/v1/tenants/${tenantId}/team-workspaces`,
    headers: { authorization: "Bearer admin" },
    payload: {
      organization_id: organization.organization_id,
      display_name: "Evidence workspace",
      reader_access_group_id: "readers",
      contributor_access_group_id: "contributors",
      maintainer_access_group_id: "maintainers",
    },
  })
  assert.equal(workspace.statusCode, 200)
  const workspaceId = (workspace.json() as { workspace_id: string }).workspace_id
  const marker = await app.inject({
    method: "POST",
    url: `/v1/tenants/${tenantId}/distillation-markers`,
    headers: { authorization: "Bearer owner" },
    payload: {
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
      evidence: [],
      excerpt_truncated: false,
      workspace_id: workspaceId,
    },
  })
  assert.equal(marker.statusCode, 200)
  const markerId = (marker.json() as { marker_id: string }).marker_id
  const claimed = await app.inject({
    method: "POST",
    url: `/v1/tenants/${tenantId}/distillation-markers/claim`,
    headers: { authorization: "Bearer owner" },
    payload: { bot_id: "bot-1", lease_owner: "bot-worker" },
  })
  assert.equal(claimed.statusCode, 200)
  const completed = await app.inject({
    method: "POST",
    url: `/v1/tenants/${tenantId}/distillation-markers/${markerId}/result`,
    headers: { authorization: "Bearer owner" },
    payload: {
      lease_token: (claimed.json() as { lease_token: string }).lease_token,
      outcome: "CANDIDATE_CREATED",
      content_digest: digest,
    },
  })
  assert.equal(completed.statusCode, 200)
  const candidateId = (completed.json() as { candidate: { knowledge_id: string } }).candidate.knowledge_id
  return { app, modules, admin, candidateId, workspaceId, organizationId: organization.organization_id }
}

async function createRevokingFixture() {
  let fixture: Awaited<ReturnType<typeof createFixture>> | null = null
  let candidate: KnowledgeCandidate | null = null
  const evidenceReader: KnowledgeEvidenceReader = async () => {
    if (!fixture || !candidate) throw new Error("FIXTURE_UNAVAILABLE")
    const maintainers = await fixture.modules.accessGroups.get(fixture.admin, "maintainers")
    await fixture.modules.accessGroups.save(fixture.admin, "maintainers", {
      expected_revision: maintainers.revision,
      display_name: maintainers.display_name,
      description: maintainers.description,
      enabled: false,
    })
    return evidenceFor(candidate)
  }
  fixture = await createFixture({ evidenceReader })
  candidate = await fixture.modules.distillation.getCandidate({ tenantId, knowledgeId: fixture.candidateId })
  if (!candidate) throw new Error("CANDIDATE_UNAVAILABLE")
  return fixture
}

test("a current workspace Maintainer can inspect and approve another owner's evidence", async () => {
  let candidate: KnowledgeCandidate | null = null
  let evidenceReads = 0
  const fixture = await createFixture({
    evidenceReader: async ({ knowledgeId, authorization }) => {
      evidenceReads += 1
      assert.equal(knowledgeId, candidate?.knowledge_id)
      assert.equal(authorization, "Bearer maintainer")
      return evidenceFor(candidate!)
    },
  })
  candidate = await fixture.modules.distillation.getCandidate({ tenantId, knowledgeId: fixture.candidateId })
  assert.ok(candidate)

  const readByReader = await fixture.app.inject({
    method: "GET",
    url: `/v1/tenants/${tenantId}/knowledge-candidates/${fixture.candidateId}/evidence`,
    headers: { authorization: "Bearer reader" },
  })
  const readByOtherMaintainer = await fixture.app.inject({
    method: "GET",
    url: `/v1/tenants/${tenantId}/knowledge-candidates/${fixture.candidateId}/evidence`,
    headers: { authorization: "Bearer other-maintainer" },
  })
  const readByInvocationMaintainer = await fixture.app.inject({
    method: "GET",
    url: `/v1/tenants/${tenantId}/knowledge-candidates/${fixture.candidateId}/evidence`,
    headers: { authorization: "Bearer invocation-maintainer" },
  })
  const contextByInvocationMaintainer = await fixture.app.inject({
    method: "GET",
    url: `/v1/tenants/${tenantId}/knowledge-candidates/${fixture.candidateId}/review-context`,
    headers: { authorization: "Bearer invocation-maintainer" },
  })
  assert.equal(readByReader.statusCode, 403)
  assert.equal(readByOtherMaintainer.statusCode, 403)
  assert.equal(readByInvocationMaintainer.statusCode, 403)
  assert.equal(contextByInvocationMaintainer.statusCode, 403)
  assert.equal(evidenceReads, 0)

  const reviewContext = await fixture.app.inject({
    method: "GET",
    url: `/v1/tenants/${tenantId}/knowledge-candidates/${fixture.candidateId}/review-context`,
    headers: { authorization: "Bearer maintainer" },
  })
  assert.equal(reviewContext.statusCode, 200)
  assert.equal(reviewContext.headers["cache-control"], "no-store")
  assert.doesNotMatch(reviewContext.body, /review evidence/)

  const evidence = await fixture.app.inject({
    method: "GET",
    url: `/v1/tenants/${tenantId}/knowledge-candidates/${fixture.candidateId}/evidence`,
    headers: { authorization: "Bearer maintainer" },
  })
  assert.equal(evidence.statusCode, 200)
  assert.equal(evidence.headers["cache-control"], "no-store")
  assert.equal(evidence.headers.vary, "authorization")
  assert.deepEqual((evidence.json() as { turns: unknown[] }).turns, [{ turn_id: "turn-1", text: "review evidence", truncated: false }])
  assert.equal(evidenceReads, 1)

  const approved = await fixture.app.inject({
    method: "POST",
    url: `/v1/tenants/${tenantId}/knowledge-candidates/${fixture.candidateId}/review`,
    headers: { authorization: "Bearer maintainer" },
    payload: { decision: "APPROVE" },
  })
  assert.equal(approved.statusCode, 200)
  assert.equal((approved.json() as { reviewed_by: string }).reviewed_by, "maintainer")
  assert.equal((approved.json() as { review_state: string }).review_state, "APPROVED")
  assert.equal(evidenceReads, 2)

  const closed = await fixture.app.inject({
    method: "POST",
    url: `/v1/tenants/${tenantId}/knowledge-candidates/${fixture.candidateId}/review`,
    headers: { authorization: "Bearer maintainer" },
    payload: { decision: "APPROVE" },
  })
  assert.equal(closed.statusCode, 409)
  assert.equal((closed.json() as { code: string }).code, "KNOWLEDGE_REVIEW_CLOSED")
  assert.equal(evidenceReads, 2)
  await fixture.app.close()
})

test("a workspace move after evidence verification conflicts instead of approving the old evidence", async () => {
  let candidate: KnowledgeCandidate | null = null
  let moveDuringReview: (() => Promise<void>) | null = null
  let backingStore: DistillationStore | null = null
  const fixture = await createFixture({
    evidenceReader: async () => evidenceFor(candidate!),
    configureModules(modules) {
      const store = modules.distillation
      backingStore = store
      modules.distillation = {
        ...store,
        async reviewCandidate(input) {
          const move = moveDuringReview
          moveDuringReview = null
          if (move) await move()
          return store.reviewCandidate(input)
        },
      }
    },
  })
  candidate = await fixture.modules.distillation.getCandidate({ tenantId, knowledgeId: fixture.candidateId })
  assert.ok(candidate)
  const destination = await fixture.app.inject({
    method: "POST",
    url: `/v1/tenants/${tenantId}/team-workspaces`,
    headers: { authorization: "Bearer admin" },
    payload: {
      organization_id: fixture.organizationId,
      display_name: "Destination workspace",
      reader_access_group_id: "readers",
      contributor_access_group_id: "contributors",
      maintainer_access_group_id: "maintainers",
    },
  })
  assert.equal(destination.statusCode, 200)
  const destinationWorkspaceId = (destination.json() as { workspace_id: string }).workspace_id
  moveDuringReview = async () => {
    await backingStore!.assignWorkspace({
      tenantId,
      actorSubjectId: "maintainer",
      knowledgeId: fixture.candidateId,
      workspaceId: destinationWorkspaceId,
      maintainerWorkspaceIds: [fixture.workspaceId, destinationWorkspaceId],
    })
  }

  const review = await fixture.app.inject({
    method: "POST",
    url: `/v1/tenants/${tenantId}/knowledge-candidates/${fixture.candidateId}/review`,
    headers: { authorization: "Bearer maintainer" },
    payload: { decision: "APPROVE" },
  })
  assert.equal(review.statusCode, 409)
  assert.equal((review.json() as { code: string }).code, "KNOWLEDGE_EVIDENCE_CHANGED")
  const current = await fixture.modules.distillation.getCandidate({ tenantId, knowledgeId: fixture.candidateId })
  assert.equal(current?.workspace_id, destinationWorkspaceId)
  assert.equal(current?.review_state, "PENDING_REVIEW")
  await fixture.app.close()
})

test("a workspace move while Maintainer access resolves blocks the stale review context", async () => {
  // The Bot trusts review-context as the final authorization; returning the pre-move snapshot would let
  // an A Maintainer receive evidence for a candidate that now belongs to B.
  let moveDuringAcl: (() => Promise<void>) | null = null
  let backingStore: DistillationStore | null = null
  const fixture = await createFixture({
    configureModules(modules) {
      const store = modules.distillation
      backingStore = store
      modules.distillation = {
        ...store,
        async listWorkspaces(tenant) {
          const workspaces = await store.listWorkspaces(tenant)
          const move = moveDuringAcl
          moveDuringAcl = null
          if (move) await move()
          return workspaces
        },
      }
    },
  })
  const destination = await fixture.app.inject({
    method: "POST",
    url: `/v1/tenants/${tenantId}/team-workspaces`,
    headers: { authorization: "Bearer admin" },
    payload: {
      organization_id: fixture.organizationId,
      display_name: "Other destination workspace",
      reader_access_group_id: "readers",
      contributor_access_group_id: "contributors",
      maintainer_access_group_id: "other-maintainers",
    },
  })
  assert.equal(destination.statusCode, 200)
  const destinationWorkspaceId = (destination.json() as { workspace_id: string }).workspace_id
  moveDuringAcl = async () => {
    await backingStore!.assignWorkspace({
      tenantId,
      actorSubjectId: "admin",
      knowledgeId: fixture.candidateId,
      workspaceId: destinationWorkspaceId,
      maintainerWorkspaceIds: [fixture.workspaceId, destinationWorkspaceId],
    })
  }

  const context = await fixture.app.inject({
    method: "GET",
    url: `/v1/tenants/${tenantId}/knowledge-candidates/${fixture.candidateId}/review-context`,
    headers: { authorization: "Bearer maintainer" },
  })
  assert.equal(moveDuringAcl, null)
  assert.equal(context.statusCode, 409)
  assert.equal((context.json() as { code: string }).code, "KNOWLEDGE_EVIDENCE_CHANGED")
  const current = await fixture.modules.distillation.getCandidate({ tenantId, knowledgeId: fixture.candidateId })
  assert.equal(current?.workspace_id, destinationWorkspaceId)
  await fixture.app.close()
})

test("the configured Bot proxy preserves typed failures and prevents an outage approval", async () => {
  let candidate: KnowledgeCandidate | null = null
  let responseStatus = 200
  const calls: Array<{ url: string; authorization: string | null }> = []
  const fixture = await createFixture({
    botFetch: async (input, init) => {
      calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") })
      if (responseStatus === 200) return Response.json(evidenceFor(candidate!))
      return new Response(null, { status: responseStatus })
    },
  })
  candidate = await fixture.modules.distillation.getCandidate({ tenantId, knowledgeId: fixture.candidateId })
  assert.ok(candidate)

  const success = await fixture.app.inject({
    method: "GET",
    url: `/v1/tenants/${tenantId}/knowledge-candidates/${fixture.candidateId}/evidence`,
    headers: { authorization: "Bearer maintainer" },
  })
  assert.equal(success.statusCode, 200)
  assert.deepEqual(calls[0], {
    url: `https://bot.example/api/knowledge-candidates/${fixture.candidateId}/evidence`,
    authorization: "Bearer maintainer",
  })

  for (const [statusCode, code] of [
    [401, "KNOWLEDGE_EVIDENCE_AUTH_REQUIRED"],
    [403, "KNOWLEDGE_EVIDENCE_FORBIDDEN"],
    [404, "KNOWLEDGE_EVIDENCE_NOT_FOUND"],
    [409, "KNOWLEDGE_EVIDENCE_CHANGED"],
  ] as const) {
    responseStatus = statusCode
    const response = await fixture.app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/knowledge-candidates/${fixture.candidateId}/evidence`,
      headers: { authorization: "Bearer maintainer" },
    })
    assert.equal(response.statusCode, statusCode)
    assert.equal((response.json() as { code: string }).code, code)
  }

  responseStatus = 503
  const outage = await fixture.app.inject({
    method: "POST",
    url: `/v1/tenants/${tenantId}/knowledge-candidates/${fixture.candidateId}/review`,
    headers: { authorization: "Bearer maintainer" },
    payload: { decision: "APPROVE" },
  })
  assert.equal(outage.statusCode, 503)
  assert.equal((await fixture.modules.distillation.getCandidate({ tenantId, knowledgeId: fixture.candidateId }))?.review_state, "PENDING_REVIEW")
  await fixture.app.close()
})

test("changed or malformed evidence blocks review and a revocation during evidence prevents disclosure", async () => {
  let mismatchCandidate: KnowledgeCandidate | null = null
  let mode: "changed" | "malformed" = "changed"
  const mismatchFixture = await createFixture({
    evidenceReader: async () => {
      const evidence = evidenceFor(mismatchCandidate!)
      return mode === "changed"
        ? { ...evidence, content_digest: "b".repeat(64) }
        : { ...evidence, unexpected: true }
    },
  })
  mismatchCandidate = await mismatchFixture.modules.distillation.getCandidate({ tenantId, knowledgeId: mismatchFixture.candidateId })
  assert.ok(mismatchCandidate)
  const changed = await mismatchFixture.app.inject({
    method: "POST",
    url: `/v1/tenants/${tenantId}/knowledge-candidates/${mismatchFixture.candidateId}/review`,
    headers: { authorization: "Bearer maintainer" },
    payload: { decision: "APPROVE" },
  })
  assert.equal(changed.statusCode, 409)
  assert.equal((changed.json() as { code: string }).code, "KNOWLEDGE_EVIDENCE_CHANGED")
  assert.equal((await mismatchFixture.modules.distillation.getCandidate({ tenantId, knowledgeId: mismatchFixture.candidateId }))?.review_state, "PENDING_REVIEW")
  mode = "malformed"
  const malformed = await mismatchFixture.app.inject({
    method: "GET",
    url: `/v1/tenants/${tenantId}/knowledge-candidates/${mismatchFixture.candidateId}/evidence`,
    headers: { authorization: "Bearer maintainer" },
  })
  assert.equal(malformed.statusCode, 503)
  await mismatchFixture.app.close()

  const disclosureFixture = await createRevokingFixture()
  const disclosureRevoked = await disclosureFixture.app.inject({
    method: "GET",
    url: `/v1/tenants/${tenantId}/knowledge-candidates/${disclosureFixture.candidateId}/evidence`,
    headers: { authorization: "Bearer maintainer" },
  })
  assert.equal(disclosureRevoked.statusCode, 403)
  assert.doesNotMatch(disclosureRevoked.body, /review evidence/)
  await disclosureFixture.app.close()

  const reviewFixture = await createRevokingFixture()
  const revoked = await reviewFixture.app.inject({
    method: "POST",
    url: `/v1/tenants/${tenantId}/knowledge-candidates/${reviewFixture.candidateId}/review`,
    headers: { authorization: "Bearer maintainer" },
    payload: { decision: "APPROVE" },
  })
  assert.equal(revoked.statusCode, 403)
  assert.equal((await reviewFixture.modules.distillation.getCandidate({ tenantId, knowledgeId: reviewFixture.candidateId }))?.review_state, "PENDING_REVIEW")
  await reviewFixture.app.close()
})

test("a current Maintainer can reject unavailable evidence without approving it", async () => {
  let evidenceReads = 0
  const unavailableEvidence: KnowledgeEvidenceReader = async () => {
    evidenceReads += 1
    throw new Error("EVIDENCE_UNAVAILABLE")
  }
  const rejectedFixture = await createFixture({ evidenceReader: unavailableEvidence })
  try {
    const forbidden = await rejectedFixture.app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/knowledge-candidates/${rejectedFixture.candidateId}/review`,
      headers: { authorization: "Bearer reader" },
      payload: { decision: "REJECT" },
    })
    assert.equal(forbidden.statusCode, 403)
    const rejected = await rejectedFixture.app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/knowledge-candidates/${rejectedFixture.candidateId}/review`,
      headers: { authorization: "Bearer maintainer" },
      payload: { decision: "REJECT" },
    })
    assert.equal(rejected.statusCode, 200, rejected.body)
    assert.equal((rejected.json() as { review_state: string }).review_state, "REJECTED")
    assert.equal(evidenceReads, 0)
  } finally {
    await rejectedFixture.app.close()
  }

  const approvalFixture = await createFixture({ evidenceReader: unavailableEvidence })
  try {
    const approved = await approvalFixture.app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/knowledge-candidates/${approvalFixture.candidateId}/review`,
      headers: { authorization: "Bearer maintainer" },
      payload: { decision: "APPROVE" },
    })
    assert.notEqual(approved.statusCode, 200)
    assert.equal((await approvalFixture.modules.distillation.getCandidate({ tenantId, knowledgeId: approvalFixture.candidateId }))?.review_state, "PENDING_REVIEW")
    assert.equal(evidenceReads, 1)
  } finally {
    await approvalFixture.app.close()
  }
})
