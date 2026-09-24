import assert from "node:assert/strict"
import test from "node:test"

import { DISTILLATION_EXTRACTOR_VERSION } from "@genioone/protocol/distillation-triage"

import { createManagementApi } from "../src/app"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"
import type { Principal } from "../src/capabilities/tenancy-auth/contract"

const digest = "a".repeat(64)

function principal(subjectId: string, scopes: string[] = ["genioone-invocation"]): Principal {
  return {
    tenant_id: "tenant-acme",
    subject_id: subjectId,
    client_id: "genio-one-bot",
    role: "USER",
    organization_ids: [],
    scopes,
  }
}

function markerBody(overrides: Record<string, unknown> = {}) {
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
    extractor_version: DISTILLATION_EXTRACTOR_VERSION,
    evidence: [{ check_id: "relevant", score: 0.91, threshold: 0.7, matched: true }],
    excerpt_truncated: false,
    ...overrides,
  }
}

async function appFor(scopes?: string[]) {
  const modules = createInMemoryPlatformModules({ now: () => 1_000 })
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    knowledgeEvidenceReader: async ({ knowledgeId }) => {
      const candidate = await modules.distillation.getCandidate({ tenantId: "tenant-acme", knowledgeId })
      if (!candidate) return null
      return {
        knowledge_id: candidate.knowledge_id,
        tenant_id: candidate.tenant_id,
        workspace_id: candidate.workspace_id,
        content_digest: candidate.content_digest,
        turns: candidate.provenance.turn_ids.map((turnId) => ({ turn_id: turnId, text: "review evidence", truncated: false })),
      }
    },
    principalAuthenticator: createStaticPrincipalAuthenticator({
      owner: principal("owner", scopes),
      other: principal("other"),
    }),
  })
  return app
}

test("a relevant marker is idempotent, claimed by its owner, and becomes an evidence candidate", async () => {
  const app = await appFor()
  const created = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers",
    headers: { authorization: "Bearer owner" },
    payload: markerBody({ extractor_version: "timeline-body-1" }),
  })
  assert.equal(created.statusCode, 200)
  const duplicate = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers",
    headers: { authorization: "Bearer owner" },
    payload: markerBody({ extractor_version: "timeline-body-1" }),
  })
  assert.equal(duplicate.statusCode, 200)
  assert.equal(duplicate.json().marker_id, created.json().marker_id)
  assert.equal(duplicate.json().scope_hint, "process")
  const crossVersionReplay = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers",
    headers: { authorization: "Bearer owner" },
    payload: markerBody({
      extractor_version: "timeline-visible-2",
      evidence: [{ check_id: "changed", score: 0.1, threshold: 0.9, matched: false }],
    }),
  })
  assert.equal(crossVersionReplay.statusCode, 200)
  assert.equal(crossVersionReplay.json().marker_id, created.json().marker_id)
  assert.equal(crossVersionReplay.json().extractor_version, "timeline-body-1")
  for (const payload of [
    markerBody({ extractor_version: "timeline-visible-2", scope_hint: "customer_project" }),
    markerBody({ extractor_version: "timeline-visible-2", sensitivity: "restricted" }),
    markerBody({ extractor_version: "timeline-visible-2", representation: "HUMAN" }),
    markerBody({ extractor_version: "timeline-visible-2", excerpt_truncated: true }),
    markerBody({ extractor_version: "timeline-visible-2", knowledge_type: "FACT" }),
    markerBody({ extractor_version: "timeline-visible-2", content_digest: "b".repeat(64) }),
    markerBody({ extractor_version: "timeline-visible-2", turn_ids: ["turn-2"] }),
    markerBody({ extractor_version: "timeline-body-1", content_digest: "b".repeat(64) }),
    markerBody({ extractor_version: "timeline-body-1", turn_ids: ["turn-2"] }),
    markerBody({ extractor_version: "timeline-body-1", knowledge_type: "FACT" }),
  ]) {
    const conflicting = await app.inject({
      method: "POST",
      url: "/v1/tenants/tenant-acme/distillation-markers",
      headers: { authorization: "Bearer owner" },
      payload,
    })
    assert.equal(conflicting.statusCode, 409)
    assert.equal(conflicting.json().code, "DISTILLATION_MARKER_CONFLICT")
  }

  const hidden = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers/claim",
    headers: { authorization: "Bearer other" },
    payload: { bot_id: "bot-1", lease_owner: "other-pod" },
  })
  assert.equal(hidden.statusCode, 200)
  assert.equal(hidden.json(), null)

  const claimed = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers/claim",
    headers: { authorization: "Bearer owner" },
    payload: { bot_id: "bot-1", lease_owner: "bot-pod" },
  })
  assert.equal(claimed.statusCode, 200)
  assert.equal(claimed.json().marker_id, created.json().marker_id)
  assert.equal(typeof claimed.json().lease_token, "string")
  assert.equal(JSON.stringify(claimed.json()).includes("客戶合約"), false)

  const completed = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-acme/distillation-markers/${created.json().marker_id}/result`,
    headers: { authorization: "Bearer owner" },
    payload: { lease_token: claimed.json().lease_token, outcome: "CANDIDATE_CREATED", content_digest: digest },
  })
  assert.equal(completed.statusCode, 200)
  assert.equal(completed.json().marker.processing_state, "CANDIDATE_CREATED")
  assert.equal(completed.json().candidate.review_state, "PENDING_REVIEW")
  assert.deepEqual(completed.json().candidate.provenance.turn_ids, ["turn-1"])
  assert.equal(Object.hasOwn(completed.json().candidate, "text"), false)
  const safetyEscalation = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers",
    headers: { authorization: "Bearer owner" },
    payload: markerBody({ extractor_version: "timeline-visible-2", excerpt_truncated: true }),
  })
  assert.equal(safetyEscalation.statusCode, 409)
  assert.equal(safetyEscalation.json().code, "DISTILLATION_MARKER_CONFLICT")
  const candidateConflict = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers",
    headers: { authorization: "Bearer owner" },
    payload: markerBody({ extractor_version: "timeline-body-1", evidence: [{ check_id: "relevant", score: 0.8, threshold: 0.7, matched: true }] }),
  })
  assert.equal(candidateConflict.statusCode, 409)
  assert.equal(candidateConflict.json().code, "DISTILLATION_MARKER_CONFLICT")
  const candidates = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/knowledge-candidates",
    headers: { authorization: "Bearer owner" },
  })
  assert.equal(candidates.json().candidates.length, 1)
  assert.equal(candidates.json().candidates[0].content_digest, digest)

  const denied = await app.inject({
    method: "POST",
    url: "/v1/tenants/other-tenant/distillation-markers",
    headers: { authorization: "Bearer owner" },
    payload: markerBody(),
  })
  assert.equal(denied.statusCode, 403)
  await app.close()
})

test("customer project content and a truncated excerpt cannot be stored as ordinary prose", async () => {
  const app = await appFor()
  const payload = markerBody({ scope_hint: "customer_project", sensitivity: "standard", representation: "HUMAN", excerpt_truncated: true, thread_id: "thread-2" })
  const created = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers",
    headers: { authorization: "Bearer owner" },
    payload,
  })
  assert.equal(created.statusCode, 200)
  assert.equal(created.json().sensitivity, "restricted")
  assert.equal(created.json().representation, "EVIDENCE_ONLY")
  const duplicate = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers",
    headers: { authorization: "Bearer owner" },
    payload,
  })
  assert.equal(duplicate.statusCode, 200)
  assert.equal(duplicate.json().marker_id, created.json().marker_id)
  await app.close()
})

test("marker creation, claims, and candidate provenance accept both extractor versions", async () => {
  const app = await appFor()
  for (const extractorVersion of ["timeline-body-1", "timeline-visible-2"]) {
    const created = await app.inject({
      method: "POST",
      url: "/v1/tenants/tenant-acme/distillation-markers",
      headers: { authorization: "Bearer owner" },
      payload: markerBody({ thread_id: `thread-${extractorVersion}`, extractor_version: extractorVersion }),
    })
    assert.equal(created.statusCode, 200)
    assert.equal(created.json().extractor_version, extractorVersion)
    const claimed = await app.inject({
      method: "POST",
      url: "/v1/tenants/tenant-acme/distillation-markers/claim",
      headers: { authorization: "Bearer owner" },
      payload: { bot_id: "bot-1", lease_owner: "bot-pod" },
    })
    assert.equal(claimed.statusCode, 200)
    assert.equal(claimed.json().extractor_version, extractorVersion)
    const completed = await app.inject({
      method: "POST",
      url: `/v1/tenants/tenant-acme/distillation-markers/${created.json().marker_id}/result`,
      headers: { authorization: "Bearer owner" },
      payload: { lease_token: claimed.json().lease_token, outcome: "CANDIDATE_CREATED", content_digest: digest },
    })
    assert.equal(completed.statusCode, 200)
    assert.equal(completed.json().candidate.provenance.extractor_version, extractorVersion)
  }
  await app.close()
})

test("an expired processing lease can be claimed again", async () => {
  let clock = 1_000
  const modules = createInMemoryPlatformModules({ now: () => clock })
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({ owner: principal("owner") }),
  })
  const created = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers",
    headers: { authorization: "Bearer owner" },
    payload: markerBody({ thread_id: "thread-lease" }),
  })
  const first = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers/claim",
    headers: { authorization: "Bearer owner" },
    payload: { bot_id: "bot-1", lease_owner: "pod-a" },
  })
  clock = 1_061
  const second = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers/claim",
    headers: { authorization: "Bearer owner" },
    payload: { bot_id: "bot-1", lease_owner: "pod-b" },
  })
  assert.equal(second.statusCode, 200)
  assert.equal(second.json().marker_id, created.json().marker_id)
  assert.notEqual(second.json().lease_token, first.json().lease_token)
  const mismatched = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-acme/distillation-markers/${created.json().marker_id}/result`,
    headers: { authorization: "Bearer owner" },
    payload: { lease_token: second.json().lease_token, outcome: "CANDIDATE_CREATED", content_digest: "b".repeat(64) },
  })
  assert.equal(mismatched.statusCode, 409)
  const completed = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-acme/distillation-markers/${created.json().marker_id}/result`,
    headers: { authorization: "Bearer owner" },
    payload: { lease_token: second.json().lease_token, outcome: "CANDIDATE_CREATED", content_digest: digest },
  })
  assert.equal(completed.statusCode, 200)
  await app.close()
})

test("a marker whose leases are abandoned until attempts run out stays visible as a terminal status", async () => {
  // The claim that exhausts the last attempt returns null, so a Bot holding a
  // SUBMITTED inbox row needs a per-marker lookup to learn the terminal FAILED
  // state; otherwise it keeps polling claim forever.
  let clock = 1_000
  const modules = createInMemoryPlatformModules({ now: () => clock })
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({ owner: principal("owner"), other: principal("other") }),
  })
  const headers = { authorization: "Bearer owner" }
  const created = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers",
    headers,
    payload: markerBody({ thread_id: "thread-exhausted" }),
  })
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const claimed = await app.inject({
      method: "POST",
      url: "/v1/tenants/tenant-acme/distillation-markers/claim",
      headers,
      payload: { bot_id: "bot-1", lease_owner: `pod-${attempt}` },
    })
    assert.equal(claimed.json().marker_id, created.json().marker_id)
    clock += 61
  }
  const exhausted = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers/claim",
    headers,
    payload: { bot_id: "bot-1", lease_owner: "pod-6" },
  })
  assert.equal(exhausted.statusCode, 200)
  assert.equal(exhausted.json(), null)
  const status = await app.inject({
    method: "GET",
    url: `/v1/tenants/tenant-acme/distillation-markers/${created.json().marker_id}`,
    headers,
  })
  assert.equal(status.statusCode, 200)
  assert.equal(status.json().processing_state, "FAILED")
  assert.equal(status.json().last_error, "DISTILLATION_ATTEMPTS_EXHAUSTED")
  const hidden = await app.inject({
    method: "GET",
    url: `/v1/tenants/tenant-acme/distillation-markers/${created.json().marker_id}`,
    headers: { authorization: "Bearer other" },
  })
  assert.equal(hidden.statusCode, 404)
  await app.close()
})

test("marker and candidate lists are bounded pages", async () => {
  const app = await appFor()
  const headers = { authorization: "Bearer owner" }
  const first = await app.inject({ method: "POST", url: "/v1/tenants/tenant-acme/distillation-markers", headers, payload: markerBody({ thread_id: "thread-a" }) })
  const second = await app.inject({ method: "POST", url: "/v1/tenants/tenant-acme/distillation-markers", headers, payload: markerBody({ thread_id: "thread-b" }) })
  assert.equal(first.statusCode, 200)
  assert.equal(second.statusCode, 200)
  const page = await app.inject({ method: "GET", url: "/v1/tenants/tenant-acme/distillation-markers?limit=1", headers })
  assert.equal(page.statusCode, 200)
  assert.equal(page.json().markers.length, 1)
  assert.equal(typeof page.json().next_cursor, "string")
  const rest = await app.inject({
    method: "GET",
    url: `/v1/tenants/tenant-acme/distillation-markers?limit=1&cursor=${encodeURIComponent(page.json().next_cursor)}`,
    headers,
  })
  assert.equal(rest.statusCode, 200)
  assert.equal(rest.json().markers.length, 1)
  assert.equal(rest.json().next_cursor, null)
  assert.deepEqual([page.json().markers[0].marker_id, rest.json().markers[0].marker_id].sort(), [first.json().marker_id, second.json().marker_id].sort())
  const invalid = await app.inject({ method: "GET", url: "/v1/tenants/tenant-acme/distillation-markers?cursor=not-a-cursor", headers })
  assert.equal(invalid.statusCode, 400)
  for (let index = 0; index < 2; index += 1) {
    const claimed = await app.inject({
      method: "POST",
      url: "/v1/tenants/tenant-acme/distillation-markers/claim",
      headers,
      payload: { bot_id: "bot-1", lease_owner: "bot-pod" },
    })
    assert.equal(claimed.statusCode, 200)
    const completed = await app.inject({
      method: "POST",
      url: `/v1/tenants/tenant-acme/distillation-markers/${claimed.json().marker_id}/result`,
      headers,
      payload: { lease_token: claimed.json().lease_token, outcome: "CANDIDATE_CREATED", content_digest: digest },
    })
    assert.equal(completed.statusCode, 200)
  }
  const candidates = await app.inject({ method: "GET", url: "/v1/tenants/tenant-acme/knowledge-candidates?limit=1", headers })
  assert.equal(candidates.statusCode, 200)
  assert.equal(candidates.json().candidates.length, 1)
  assert.equal(typeof candidates.json().next_cursor, "string")
  const candidateRest = await app.inject({
    method: "GET",
    url: `/v1/tenants/tenant-acme/knowledge-candidates?limit=1&cursor=${encodeURIComponent(candidates.json().next_cursor)}`,
    headers,
  })
  assert.equal(candidateRest.json().candidates.length, 1)
  assert.equal(candidateRest.json().next_cursor, null)
  await app.close()
})

test("only a current workspace maintainer can approve a candidate", async () => {
  const modules = createInMemoryPlatformModules({ now: () => 2_000 })
  const admin: Principal = {
    tenant_id: "tenant-acme",
    subject_id: "admin",
    client_id: "management-ui",
    role: "TENANT_ADMINISTRATOR",
    organization_ids: [],
    scopes: ["genioone-management"],
  }
  const botAdmin: Principal = {
    ...admin,
    subject_id: "bot-admin",
    client_id: "genio-one-bot",
    scopes: ["genioone-invocation"],
  }
  const legacyAdmin: Principal = {
    tenant_id: "tenant-acme",
    subject_id: "legacy-admin",
    client_id: "legacy-management",
    role: "TENANT_ADMINISTRATOR",
    organization_ids: [],
  }
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    knowledgeEvidenceReader: async ({ knowledgeId }) => {
      const candidate = await modules.distillation.getCandidate({ tenantId: "tenant-acme", knowledgeId })
      if (!candidate) return null
      return {
        knowledge_id: candidate.knowledge_id,
        tenant_id: candidate.tenant_id,
        workspace_id: candidate.workspace_id,
        content_digest: candidate.content_digest,
        turns: candidate.provenance.turn_ids.map((turnId) => ({ turn_id: turnId, text: "review evidence", truncated: false })),
      }
    },
    principalAuthenticator: createStaticPrincipalAuthenticator({
      admin,
      "bot-admin": botAdmin,
      "legacy-admin": legacyAdmin,
      owner: principal("owner", ["genioone-invocation", "genioone-management"]),
      maintainer: principal("maintainer", ["genioone-management"]),
      "other-maintainer": principal("other-maintainer", ["genioone-management"]),
      "bot-maintainer": principal("maintainer"),
      reader: principal("reader"),
      stranger: principal("stranger"),
    }),
  })
  await modules.identity.bootstrap({
    tenantId: "tenant-acme",
    subjects: [
      { subject_id: "admin", kind: "PERSON", role: "TENANT_ADMINISTRATOR" },
      { subject_id: "bot-admin", kind: "PERSON", role: "TENANT_ADMINISTRATOR" },
      { subject_id: "legacy-admin", kind: "PERSON", role: "TENANT_ADMINISTRATOR" },
      { subject_id: "owner", kind: "PERSON" },
      { subject_id: "maintainer", kind: "PERSON" },
      { subject_id: "other-maintainer", kind: "PERSON" },
      { subject_id: "reader", kind: "PERSON" },
    ],
  })
  const organization = await modules.organizations.create({ tenantId: "tenant-acme", display_name: "SE" })
  for (const [id, name] of [["readers", "Readers"], ["other-readers", "Other readers"], ["contributors", "Contributors"], ["maintainers", "Maintainers"]] as const) {
    await modules.accessGroups.save(admin, id, { expected_revision: 0, display_name: name, description: "", enabled: true })
  }
  await modules.accessGroups.replaceMembers(admin, "readers", { expected_group_revision: 1, expected_source_revision: 0, subject_ids: ["reader", "bot-admin"] })
  await modules.accessGroups.replaceMembers(admin, "contributors", { expected_group_revision: 1, expected_source_revision: 0, subject_ids: ["owner"] })
  await modules.accessGroups.replaceMembers(admin, "maintainers", { expected_group_revision: 1, expected_source_revision: 0, subject_ids: ["maintainer"] })
  const workspace = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/team-workspaces",
    headers: { authorization: "Bearer admin" },
    payload: {
      organization_id: organization.organization_id,
      display_name: "SE workspace",
      reader_access_group_id: "readers",
      contributor_access_group_id: "contributors",
      maintainer_access_group_id: "maintainers",
    },
  })
  assert.equal(workspace.statusCode, 200)
  const workspaceId = workspace.json().workspace_id
  const listedBy = async (token: string) => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/tenants/tenant-acme/team-workspaces",
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(response.statusCode, 200)
    return response.json().some((item: { workspace_id: string }) => item.workspace_id === workspaceId)
  }
  assert.equal(await listedBy("admin"), true)
  assert.equal(await listedBy("owner"), true)
  assert.equal(await listedBy("reader"), true)
  assert.equal(await listedBy("stranger"), false)
  const blankName = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/team-workspaces",
    headers: { authorization: "Bearer admin" },
    payload: {
      organization_id: organization.organization_id,
      display_name: " ",
      reader_access_group_id: "readers",
      contributor_access_group_id: "contributors",
      maintainer_access_group_id: "maintainers",
    },
  })
  assert.equal(blankName.statusCode, 422)
  const readerMarker = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers",
    headers: { authorization: "Bearer reader" },
    payload: markerBody({ thread_id: "thread-reader", workspace_id: workspace.json().workspace_id }),
  })
  assert.equal(readerMarker.statusCode, 403)
  const readerWorkspace = await app.inject({
    method: "GET",
    url: `/v1/tenants/tenant-acme/team-workspaces/${workspace.json().workspace_id}`,
    headers: { authorization: "Bearer reader" },
  })
  assert.equal(readerWorkspace.statusCode, 200)
  assert.equal(readerWorkspace.json().workspace_id, workspace.json().workspace_id)
  const readerContributorWorkspace = await app.inject({
    method: "GET",
    url: `/v1/tenants/tenant-acme/team-workspaces/${workspace.json().workspace_id}?access=contributor`,
    headers: { authorization: "Bearer reader" },
  })
  assert.equal(readerContributorWorkspace.statusCode, 403)
  assert.equal(readerContributorWorkspace.json().code, "TEAM_WORKSPACE_CONTRIBUTOR_REQUIRED")
  const botAdminWorkspace = await app.inject({
    method: "GET",
    url: `/v1/tenants/tenant-acme/team-workspaces/${workspace.json().workspace_id}`,
    headers: { authorization: "Bearer bot-admin" },
  })
  assert.equal(botAdminWorkspace.statusCode, 200)
  const botAdminContributorWorkspace = await app.inject({
    method: "GET",
    url: `/v1/tenants/tenant-acme/team-workspaces/${workspace.json().workspace_id}?access=contributor`,
    headers: { authorization: "Bearer bot-admin" },
  })
  assert.equal(botAdminContributorWorkspace.statusCode, 403)
  const managementWorkspace = await app.inject({
    method: "GET",
    url: `/v1/tenants/tenant-acme/team-workspaces/${workspace.json().workspace_id}`,
    headers: { authorization: "Bearer admin" },
  })
  assert.equal(managementWorkspace.statusCode, 200)
  assert.equal(managementWorkspace.json().workspace_id, workspace.json().workspace_id)
  const managementContributorWorkspace = await app.inject({
    method: "GET",
    url: `/v1/tenants/tenant-acme/team-workspaces/${workspace.json().workspace_id}?access=contributor`,
    headers: { authorization: "Bearer admin" },
  })
  assert.equal(managementContributorWorkspace.statusCode, 403)
  const legacyWorkspace = await app.inject({
    method: "GET",
    url: `/v1/tenants/tenant-acme/team-workspaces/${workspace.json().workspace_id}`,
    headers: { authorization: "Bearer legacy-admin" },
  })
  assert.equal(legacyWorkspace.statusCode, 200)
  assert.equal(legacyWorkspace.json().workspace_id, workspace.json().workspace_id)
  const legacyContributorWorkspace = await app.inject({
    method: "GET",
    url: `/v1/tenants/tenant-acme/team-workspaces/${workspace.json().workspace_id}?access=contributor`,
    headers: { authorization: "Bearer legacy-admin" },
  })
  assert.equal(legacyContributorWorkspace.statusCode, 403)
  const contributorWorkspace = await app.inject({
    method: "GET",
    url: `/v1/tenants/tenant-acme/team-workspaces/${workspace.json().workspace_id}`,
    headers: { authorization: "Bearer owner" },
  })
  assert.equal(contributorWorkspace.statusCode, 200)
  assert.equal(contributorWorkspace.json().workspace_id, workspace.json().workspace_id)
  const strictContributorWorkspace = await app.inject({
    method: "GET",
    url: `/v1/tenants/tenant-acme/team-workspaces/${workspace.json().workspace_id}?access=contributor`,
    headers: { authorization: "Bearer owner" },
  })
  assert.equal(strictContributorWorkspace.statusCode, 200)
  assert.equal(strictContributorWorkspace.json().workspace_id, workspace.json().workspace_id)
  const missingWorkspace = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/team-workspaces/missing-workspace",
    headers: { authorization: "Bearer owner" },
  })
  assert.equal(missingWorkspace.statusCode, 404)
  await modules.accessGroups.save(admin, "others", { expected_revision: 0, display_name: "Others", description: "", enabled: true })
  await modules.accessGroups.replaceMembers(admin, "others", { expected_group_revision: 1, expected_source_revision: 0, subject_ids: ["reader", "owner", "other-maintainer"] })
  const otherWorkspace = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/team-workspaces",
    headers: { authorization: "Bearer admin" },
    payload: {
      organization_id: organization.organization_id,
      display_name: "Other workspace",
      reader_access_group_id: "other-readers",
      contributor_access_group_id: "contributors",
      maintainer_access_group_id: "others",
    },
  })
  assert.equal(otherWorkspace.statusCode, 200)
  const managementWorkspaces = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/team-workspaces",
    headers: { authorization: "Bearer admin" },
  })
  assert.equal(managementWorkspaces.statusCode, 200)
  assert.equal(managementWorkspaces.json().some((item: { workspace_id: string }) => item.workspace_id === workspace.json().workspace_id), true)
  assert.equal(managementWorkspaces.json().some((item: { workspace_id: string }) => item.workspace_id === otherWorkspace.json().workspace_id), true)
  const legacyWorkspaces = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/team-workspaces",
    headers: { authorization: "Bearer legacy-admin" },
  })
  assert.equal(legacyWorkspaces.statusCode, 200)
  assert.equal(legacyWorkspaces.json().some((item: { workspace_id: string }) => item.workspace_id === workspace.json().workspace_id), true)
  assert.equal(legacyWorkspaces.json().some((item: { workspace_id: string }) => item.workspace_id === otherWorkspace.json().workspace_id), true)
  const botAdminWorkspaces = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/team-workspaces",
    headers: { authorization: "Bearer bot-admin" },
  })
  assert.equal(botAdminWorkspaces.statusCode, 200)
  assert.deepEqual(
    botAdminWorkspaces.json().map((item: { workspace_id: string }) => item.workspace_id),
    [workspace.json().workspace_id],
  )
  const unboundMarker = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers",
    headers: { authorization: "Bearer owner" },
    payload: markerBody({ thread_id: "thread-unbound" }),
  })
  assert.equal(unboundMarker.statusCode, 200)
  const unboundClaim = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers/claim",
    headers: { authorization: "Bearer owner" },
    payload: { bot_id: "bot-1", lease_owner: "bot-pod" },
  })
  assert.equal(unboundClaim.statusCode, 200)
  const unboundCompleted = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-acme/distillation-markers/${unboundMarker.json().marker_id}/result`,
    headers: { authorization: "Bearer owner" },
    payload: { lease_token: unboundClaim.json().lease_token, outcome: "CANDIDATE_CREATED", content_digest: digest },
  })
  assert.equal(unboundCompleted.statusCode, 200)
  const unboundKnowledgeId = unboundCompleted.json().candidate.knowledge_id
  const unboundDenied = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-acme/knowledge-candidates/${unboundKnowledgeId}/workspace`,
    headers: { authorization: "Bearer other-maintainer" },
    payload: { workspace_id: otherWorkspace.json().workspace_id },
  })
  assert.equal(unboundDenied.statusCode, 403)
  assert.equal(unboundDenied.json().code, "KNOWLEDGE_CANDIDATE_OWNER_REQUIRED")
  const unboundAssigned = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-acme/knowledge-candidates/${unboundKnowledgeId}/workspace`,
    headers: { authorization: "Bearer owner" },
    payload: { workspace_id: otherWorkspace.json().workspace_id },
  })
  assert.equal(unboundAssigned.statusCode, 200)
  assert.equal(unboundAssigned.json().workspace_id, otherWorkspace.json().workspace_id)
  const deniedCreate = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/team-workspaces",
    headers: { authorization: "Bearer owner" },
    payload: workspace.json(),
  })
  assert.equal(deniedCreate.statusCode, 403)

  const reviewMarker = markerBody({
    thread_id: "thread-review",
    workspace_id: workspace.json().workspace_id,
    scope_hint: "customer_project",
    representation: "HUMAN",
  })
  const created = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers",
    headers: { authorization: "Bearer owner" },
    payload: reviewMarker,
  })
  assert.equal(created.statusCode, 200)
  assert.equal(created.json().representation, "EVIDENCE_ONLY")
  await modules.accessGroups.save(admin, "contributors", {
    expected_revision: 2,
    display_name: "Contributors",
    description: "",
    enabled: false,
  })
  const retried = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers",
    headers: { authorization: "Bearer owner" },
    payload: reviewMarker,
  })
  assert.equal(retried.statusCode, 200)
  assert.equal(retried.json().marker_id, created.json().marker_id)
  const freshDenied = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers",
    headers: { authorization: "Bearer owner" },
    payload: markerBody({ thread_id: "thread-new", workspace_id: workspace.json().workspace_id }),
  })
  assert.equal(freshDenied.statusCode, 403)
  await modules.accessGroups.save(admin, "contributors", {
    expected_revision: 3,
    display_name: "Contributors",
    description: "",
    enabled: true,
  })
  const claimed = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers/claim",
    headers: { authorization: "Bearer owner" },
    payload: { bot_id: "bot-1", lease_owner: "bot-pod" },
  })
  const completed = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-acme/distillation-markers/${created.json().marker_id}/result`,
    headers: { authorization: "Bearer owner" },
    payload: { lease_token: claimed.json().lease_token, outcome: "CANDIDATE_CREATED", content_digest: digest },
  })
  const knowledgeId = completed.json().candidate.knowledge_id
  const sourceMaintainerDenied = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-acme/knowledge-candidates/${knowledgeId}/workspace`,
    headers: { authorization: "Bearer other-maintainer" },
    payload: { workspace_id: otherWorkspace.json().workspace_id },
  })
  assert.equal(sourceMaintainerDenied.statusCode, 403)
  assert.equal(sourceMaintainerDenied.json().code, "TEAM_WORKSPACE_MAINTAINER_REQUIRED")
  const moved = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-acme/knowledge-candidates/${knowledgeId}/workspace`,
    headers: { authorization: "Bearer reader" },
    payload: { workspace_id: otherWorkspace.json().workspace_id },
  })
  assert.equal(moved.statusCode, 403)
  const readerDenied = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-acme/knowledge-candidates/${knowledgeId}/review`,
    headers: { authorization: "Bearer reader" },
    payload: { decision: "APPROVE" },
  })
  assert.equal(readerDenied.statusCode, 403)
  const invocationReview = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-acme/knowledge-candidates/${knowledgeId}/review`,
    headers: { authorization: "Bearer bot-maintainer" },
    payload: { decision: "APPROVE" },
  })
  assert.equal(invocationReview.statusCode, 403)
  const invocationMove = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-acme/knowledge-candidates/${knowledgeId}/workspace`,
    headers: { authorization: "Bearer bot-maintainer" },
    payload: { workspace_id: otherWorkspace.json().workspace_id },
  })
  assert.equal(invocationMove.statusCode, 403)
  const approved = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-acme/knowledge-candidates/${knowledgeId}/review`,
    headers: { authorization: "Bearer maintainer" },
    payload: { decision: "APPROVE" },
  })
  assert.equal(approved.statusCode, 200)
  assert.equal(approved.json().review_state, "APPROVED")
  assert.equal(approved.json().reviewed_by, "maintainer")
  assert.equal(approved.json().representation, "EVIDENCE_ONLY")
  const closedByOtherMaintainer = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-acme/knowledge-candidates/${knowledgeId}/review`,
    headers: { authorization: "Bearer other-maintainer" },
    payload: { decision: "APPROVE" },
  })
  assert.equal(closedByOtherMaintainer.statusCode, 403)
  assert.equal(closedByOtherMaintainer.json().code, "TEAM_WORKSPACE_MAINTAINER_REQUIRED")
  const closedByMaintainer = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-acme/knowledge-candidates/${knowledgeId}/review`,
    headers: { authorization: "Bearer maintainer" },
    payload: { decision: "APPROVE" },
  })
  assert.equal(closedByMaintainer.statusCode, 409)
  assert.equal(closedByMaintainer.json().code, "KNOWLEDGE_REVIEW_CLOSED")
  const readerList = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/knowledge-candidates",
    headers: { authorization: "Bearer reader" },
  })
  assert.equal(readerList.statusCode, 200)
  assert.equal(readerList.json().candidates.some((item: { knowledge_id: string }) => item.knowledge_id === knowledgeId), true)
  await modules.accessGroups.save(admin, "readers", {
    expected_revision: 2,
    display_name: "Readers",
    description: "",
    enabled: false,
  })
  const disabledReaderList = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/knowledge-candidates",
    headers: { authorization: "Bearer reader" },
  })
  assert.equal(disabledReaderList.statusCode, 200)
  assert.equal(disabledReaderList.json().candidates.some((item: { knowledge_id: string }) => item.knowledge_id === knowledgeId), false)
  const hiddenWorkspaces = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/team-workspaces",
    headers: { authorization: "Bearer reader" },
  })
  assert.equal(hiddenWorkspaces.json().some((item: { workspace_id: string }) => item.workspace_id === workspace.json().workspace_id), false)

  await modules.accessGroups.save(admin, "maintainers", {
    expected_revision: 2,
    display_name: "Maintainers",
    description: "",
    enabled: false,
  })
  const disabledMarker = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers",
    headers: { authorization: "Bearer owner" },
    payload: markerBody({ thread_id: "thread-disabled" }),
  })
  const disabledClaim = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers/claim",
    headers: { authorization: "Bearer owner" },
    payload: { bot_id: "bot-1", lease_owner: "bot-pod" },
  })
  const disabledCompleted = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-acme/distillation-markers/${disabledMarker.json().marker_id}/result`,
    headers: { authorization: "Bearer owner" },
    payload: { lease_token: disabledClaim.json().lease_token, outcome: "CANDIDATE_CREATED", content_digest: digest },
  })
  const disabledAssigned = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-acme/knowledge-candidates/${disabledCompleted.json().candidate.knowledge_id}/workspace`,
    headers: { authorization: "Bearer maintainer" },
    payload: { workspace_id: workspace.json().workspace_id },
  })
  assert.equal(disabledAssigned.statusCode, 403)
  await modules.accessGroups.save(admin, "maintainers", {
    expected_revision: 3,
    display_name: "Maintainers",
    description: "",
    enabled: true,
  })

  const secondMarker = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers",
    headers: { authorization: "Bearer owner" },
    payload: markerBody({ thread_id: "thread-revoked" }),
  })
  const secondClaim = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers/claim",
    headers: { authorization: "Bearer owner" },
    payload: { bot_id: "bot-1", lease_owner: "bot-pod" },
  })
  const secondCompleted = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-acme/distillation-markers/${secondMarker.json().marker_id}/result`,
    headers: { authorization: "Bearer owner" },
    payload: { lease_token: secondClaim.json().lease_token, outcome: "CANDIDATE_CREATED", content_digest: digest },
  })
  await modules.accessGroups.replaceMembers(admin, "maintainers", { expected_group_revision: 4, expected_source_revision: 1, subject_ids: [] })
  const revoked = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-acme/knowledge-candidates/${secondCompleted.json().candidate.knowledge_id}/workspace`,
    headers: { authorization: "Bearer maintainer" },
    payload: { workspace_id: workspace.json().workspace_id },
  })
  assert.equal(revoked.statusCode, 403)
  await app.close()
})

test("a token without invocation scope cannot create a marker", async () => {
  const app = await appFor([])
  const created = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers",
    headers: { authorization: "Bearer owner" },
    payload: markerBody(),
  })
  assert.equal(created.statusCode, 403)
  await app.close()
})

test("marker mutations require invocation scope while lists allow management", async () => {
  const modules = createInMemoryPlatformModules({ now: () => 1_000 })
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      owner: principal("owner"),
      console: principal("owner", ["genioone-management"]),
    }),
  })
  const created = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers",
    headers: { authorization: "Bearer owner" },
    payload: markerBody(),
  })
  assert.equal(created.statusCode, 200)
  const managementHeaders = { authorization: "Bearer console" }
  const deniedCreate = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers",
    headers: managementHeaders,
    payload: markerBody({ thread_id: "thread-management" }),
  })
  assert.equal(deniedCreate.statusCode, 403)
  const listed = await app.inject({
    method: "GET",
    url: "/v1/tenants/tenant-acme/distillation-markers",
    headers: managementHeaders,
  })
  assert.equal(listed.statusCode, 200)
  assert.equal(listed.json().markers.length, 1)
  const deniedClaim = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers/claim",
    headers: managementHeaders,
    payload: { bot_id: "bot-1", lease_owner: "console" },
  })
  assert.equal(deniedClaim.statusCode, 403)
  const claimed = await app.inject({
    method: "POST",
    url: "/v1/tenants/tenant-acme/distillation-markers/claim",
    headers: { authorization: "Bearer owner" },
    payload: { bot_id: "bot-1", lease_owner: "bot-pod" },
  })
  const deniedComplete = await app.inject({
    method: "POST",
    url: `/v1/tenants/tenant-acme/distillation-markers/${created.json().marker_id}/result`,
    headers: managementHeaders,
    payload: { lease_token: claimed.json().lease_token, outcome: "CANDIDATE_CREATED", content_digest: digest },
  })
  assert.equal(deniedComplete.statusCode, 403)
  await app.close()
})
