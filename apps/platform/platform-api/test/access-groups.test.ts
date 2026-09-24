import assert from "node:assert/strict"
import test from "node:test"

import { createManagementApi } from "../src/app"
import { accessGroupAuditEvent, type AccessGroupAuditEvent, type AccessGroupAuditWriter } from "../src/capabilities/access-groups/audit"
import type { AccessGroup } from "../src/capabilities/access-groups/contract"
import { createAccessGroupDirectory } from "../src/capabilities/access-groups/module"
import { createInMemoryAccessGroupRepository } from "../src/capabilities/access-groups/memory"
import { normalizeStoredAccessGroup } from "../src/capabilities/access-groups/postgres"
import { createInMemoryGatewayAuthorizationAuditStore } from "../src/capabilities/audit-events/memory"
import { createInMemoryIdentityDirectory } from "../src/capabilities/identity/memory"
import { createInMemoryOrganizationDirectory } from "../src/capabilities/organizations/memory"
import { createInMemoryPlatformModules } from "../src/capabilities/platform-modules"
import { createStaticPrincipalAuthenticator } from "../src/capabilities/tenancy-auth/memory"
import type { Principal } from "../src/capabilities/tenancy-auth/contract"
import type { RuntimePolicyDefinition } from "../src/capabilities/one-policy/runtime"

const tenantId = "tenant-access-groups"

test("Access Group persistence rejects legacy and malformed JSONB", () => {
  const valid = {
    tenant_id: tenantId,
    organization_id: null,
    access_group_id: "engineering",
    display_name: "Engineering",
    description: "Manual access",
    enabled: true,
    revision: 1,
    membership_sources: [{
      source_id: "manual" as const,
      kind: "MANUAL" as const,
      revision: 1,
      subject_ids: ["kevin"],
      created_at: 10,
      created_by: "admin",
      updated_at: 10,
      updated_by: "admin",
    }],
    created_at: 10,
    created_by: "admin",
    updated_at: 10,
    updated_by: "admin",
  }
  assert.deepEqual(normalizeStoredAccessGroup(JSON.stringify(valid)), valid)
  assert.throws(() => normalizeStoredAccessGroup(JSON.stringify({
    tenant_id: tenantId,
    access_group_id: "legacy-engineering",
    display_name: "Legacy Engineering",
    description: "Initial source model",
    enabled: true,
    revision: 7,
    membership_sources: [
      { source_id: "directory", kind: "EXTERNAL_GROUP", revision: 3, subject_ids: ["kevin", "nina"], valid_until: null, created_at: 10, created_by: "admin", updated_at: 20, updated_by: "admin" },
      { source_id: "import", kind: "CSV_IMPORT", revision: 5, subject_ids: ["nina", "dylan"], valid_until: null, created_at: 11, created_by: "admin", updated_at: 30, updated_by: "admin" },
    ],
    created_at: 10,
    created_by: "admin",
    updated_at: 30,
    updated_by: "admin",
  })), { code: "ACCESS_GROUP_DATA_INVALID" })
  assert.throws(() => normalizeStoredAccessGroup("not-json"), { code: "ACCESS_GROUP_DATA_INVALID" })
})

function principal(subjectId: string, tenant = tenantId): Principal {
  return {
    tenant_id: tenant,
    subject_id: subjectId,
    client_id: "genio-one-bot",
    role: subjectId === "admin" ? "TENANT_ADMINISTRATOR" : subjectId === "org-admin" ? "ORGANIZATION_ADMINISTRATOR" : "USER",
    organization_ids: subjectId === "org-admin" ? ["org-1"] : [],
    scopes: ["genioone-management", "genioone-invocation"],
  }
}

function definition(): RuntimePolicyDefinition {
  return {
    display_name: "Engineering Runtime",
    scope: { access_group_ids: ["engineering"], subject_ids: [], organization_ids: [], roles: [], client_ids: [], bot_ids: [], runtime_ids: ["codex"] },
    rules: [{ rule_id: "subscription", target: { runtime_id: "codex", capability_id: "codex.subscription" }, actions: ["use"], effect: "ALLOW", constraints: [], obligations: [{ kind: "audit", parameters: {} }] }],
  }
}

function inMemoryAccessGroup(accessGroupId: string, revision: number, displayName: string): AccessGroup {
  return {
    tenant_id: tenantId,
    organization_id: null,
    access_group_id: accessGroupId,
    display_name: displayName,
    description: "Manual access",
    enabled: true,
    revision,
    membership_sources: [],
    created_at: 1_000,
    created_by: "admin",
    updated_at: 1_000,
    updated_by: "admin",
  }
}

function inMemoryAccessGroupAudit(accessGroupId: string, beforeRevision: number, afterRevision: number, correlationId: string): AccessGroupAuditEvent {
  return accessGroupAuditEvent({
    tenantId,
    accessGroupId,
    actorSubjectId: "admin",
    correlationId,
    operation: beforeRevision === 0 ? "CREATED" : "UPDATED",
    beforeRevision,
    afterRevision,
    occurredAt: 1_000,
  })
}

async function fixture() {
  const modules = createInMemoryPlatformModules({ now: () => 1_000, connectionEnabled: () => true })
  await modules.identity.bootstrap({ tenantId, subjects: [
    { subject_id: "admin", kind: "PERSON", role: "TENANT_ADMINISTRATOR" },
    { subject_id: "org-admin", kind: "PERSON", role: "USER" },
    { subject_id: "kevin", kind: "PERSON", role: "USER" },
    { subject_id: "nina", kind: "PERSON", role: "USER" },
  ] })
  await modules.botAccessPolicy.publishRuntimePolicy({
    tenantId,
    policyId: "engineering-runtime",
    baseRevision: 0,
    definition: definition(),
    publishedBy: "admin",
  })
  const app = await createManagementApi({
    modules,
    resourceCatalog: modules.resources,
    principalAuthenticator: createStaticPrincipalAuthenticator({
      admin: principal("admin"),
      "org-admin": principal("org-admin"),
      kevin: { ...principal("kevin"), access_group_ids: ["engineering"] } as Principal,
      nina: principal("nina"),
    }),
  })
  const headers = (actor: string) => ({ authorization: `Bearer ${actor}` })
  const effective = async (actor: string) => app.inject({
    method: "GET",
    url: `/v1/tenants/${tenantId}/one-policy/runtime-effective?bot_id=genio.personal-bot&runtime_id=codex&capability_id=codex.subscription&action=use`,
    headers: headers(actor),
  })
  return { app, modules, headers, effective }
}

test("Access Groups use a manual source, canonical membership, and immutable change audit", async () => {
  const f = await fixture()
  try {
    assert.equal((await f.effective("kevin")).json().decision, "DENY")

    const created = await f.app.inject({
      method: "PUT",
      url: `/v1/tenants/${tenantId}/access-groups/engineering`,
      headers: f.headers("admin"),
      payload: { expected_revision: 0, display_name: "Engineering", description: "Runtime engineering access", enabled: true },
    })
    assert.equal(created.statusCode, 200, created.body)
    const manual = await f.app.inject({
      method: "PUT",
      url: `/v1/tenants/${tenantId}/access-groups/engineering/members`,
      headers: f.headers("admin"),
      payload: { expected_group_revision: 1, expected_source_revision: 0, subject_ids: ["kevin"] },
    })
    assert.equal(manual.statusCode, 200, manual.body)
    assert.equal(manual.json().membership_sources[0].kind, "MANUAL")
    assert.equal(manual.json().membership_sources[0].source_id, "manual")
    assert.equal((await f.effective("kevin")).json().decision, "ALLOW")

    const replaced = await f.app.inject({
      method: "PUT",
      url: `/v1/tenants/${tenantId}/access-groups/engineering/members`,
      headers: f.headers("admin"),
      payload: { expected_group_revision: 2, expected_source_revision: 1, subject_ids: ["nina"] },
    })
    assert.equal(replaced.statusCode, 200, replaced.body)
    assert.equal((await f.effective("kevin")).json().decision, "DENY")
    assert.equal((await f.effective("nina")).json().decision, "ALLOW")

    const updated = await f.app.inject({
      method: "PUT",
      url: `/v1/tenants/${tenantId}/access-groups/engineering`,
      headers: f.headers("admin"),
      payload: { expected_revision: 3, display_name: "Engineering Runtime", description: "Runtime engineering access", enabled: true },
    })
    assert.equal(updated.statusCode, 200, updated.body)
    const disabled = await f.app.inject({
      method: "PUT",
      url: `/v1/tenants/${tenantId}/access-groups/engineering`,
      headers: f.headers("admin"),
      payload: { expected_revision: 4, display_name: "Engineering Runtime", description: "Runtime engineering access", enabled: false },
    })
    assert.equal(disabled.statusCode, 200, disabled.body)
    assert.equal((await f.effective("nina")).json().decision, "DENY")
    const enabled = await f.app.inject({
      method: "PUT",
      url: `/v1/tenants/${tenantId}/access-groups/engineering`,
      headers: f.headers("admin"),
      payload: { expected_revision: 5, display_name: "Engineering Runtime", description: "Runtime engineering access", enabled: true },
    })
    assert.equal(enabled.statusCode, 200, enabled.body)
    assert.equal((await f.effective("nina")).json().decision, "ALLOW")

    const history = await f.app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/access-groups/engineering/revisions`, headers: f.headers("admin") })
    assert.equal(history.statusCode, 200, history.body)
    assert.deepEqual(history.json().map((group: { revision: number }) => group.revision), [1, 2, 3, 4, 5, 6])

    const audit = await f.modules.auditEvents.query({ tenantId, kind: "ACCESS_GROUP_CHANGE", offset: 0, limit: 20 })
    const changes = [...audit.events].sort((left: any, right: any) => left.after_revision - right.after_revision)
    assert.deepEqual(changes.map((event: any) => [event.operation, event.before_revision, event.after_revision]), [
      ["CREATED", 0, 1],
      ["MEMBERS_REPLACED", 1, 2],
      ["MEMBERS_REPLACED", 2, 3],
      ["UPDATED", 3, 4],
      ["DISABLED", 4, 5],
      ["ENABLED", 5, 6],
    ])
    assert.ok(changes.every((event: any) => event.actor_subject.subject_id === "admin" && event.subject.subject_id === "admin" && event.correlation_id))
    const auditResponse = await f.app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/audit-events?kind=ACCESS_GROUP_CHANGE&limit=20`, headers: f.headers("admin") })
    assert.equal(auditResponse.statusCode, 200, auditResponse.body)
    assert.equal((auditResponse.json() as unknown[]).length, 6)

    const preview = await f.app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/one-policy/permission-preview`,
      headers: f.headers("admin"),
      payload: { subject_id: "nina", runtime_id: "codex", client_id: "genio-one-bot", bot_id: "genio.personal-bot" },
    })
    assert.equal(preview.statusCode, 200, preview.body)
    assert.deepEqual(preview.json().access_group_ids, ["engineering"])
    assert.equal(preview.json().runtime_decisions.find((decision: { capability_id: string; action: string }) => decision.capability_id === "codex.subscription" && decision.action === "use").decision, "ALLOW")
  } finally {
    await f.app.close()
  }
})

test("Access Group exposes only manual membership updates and rejects stale revisions", async () => {
  const f = await fixture()
  try {
    const created = await f.app.inject({
      method: "PUT",
      url: `/v1/tenants/${tenantId}/access-groups/engineering`,
      headers: f.headers("admin"),
      payload: { expected_revision: 0, display_name: "Engineering", description: "Runtime engineering access", enabled: true },
    })
    assert.equal(created.statusCode, 200, created.body)
    const removedSourceRoute = await f.app.inject({
      method: "PUT",
      url: `/v1/tenants/${tenantId}/access-groups/engineering/membership-sources/import-1`,
      headers: f.headers("admin"),
      payload: { expected_group_revision: 1, expected_source_revision: 0, subject_ids: ["kevin"] },
    })
    assert.equal(removedSourceRoute.statusCode, 404, removedSourceRoute.body)
    const first = await f.app.inject({
      method: "PUT",
      url: `/v1/tenants/${tenantId}/access-groups/engineering/members`,
      headers: f.headers("admin"),
      payload: { expected_group_revision: 1, expected_source_revision: 0, subject_ids: ["kevin"] },
    })
    assert.equal(first.statusCode, 200, first.body)
    const stale = await f.app.inject({
      method: "PUT",
      url: `/v1/tenants/${tenantId}/access-groups/engineering/members`,
      headers: f.headers("admin"),
      payload: { expected_group_revision: 1, expected_source_revision: 0, subject_ids: ["nina"] },
    })
    assert.equal(stale.statusCode, 409, stale.body)

    const otherTenant = "tenant-access-groups-other"
    await f.modules.identity.bootstrap({ tenantId: otherTenant, subjects: [
      { subject_id: "admin", kind: "PERSON", role: "TENANT_ADMINISTRATOR" },
      { subject_id: "kevin", kind: "PERSON", role: "USER" },
    ] })
    const otherGroup = await f.modules.accessGroups.save(principal("admin", otherTenant), "engineering", {
      expected_revision: 0,
      display_name: "Other tenant Engineering",
      description: "Other tenant",
      enabled: true,
    })
    await f.modules.accessGroups.replaceMembers(principal("admin", otherTenant), "engineering", {
      expected_group_revision: otherGroup.revision,
      expected_source_revision: 0,
      subject_ids: ["kevin"],
    })
    assert.deepEqual((await f.modules.accessGroups.groupsForSubject({ tenantId, subjectId: "kevin" })).map((group) => group.tenant_id), [tenantId])
    assert.deepEqual((await f.modules.accessGroups.groupsForSubject({ tenantId: otherTenant, subjectId: "kevin" })).map((group) => group.tenant_id), [otherTenant])
  } finally {
    await f.app.close()
  }
})

test("Access Group memory persistence serializes concurrent same-revision saves", async () => {
  let signalAuditStarted!: () => void
  const auditStarted = new Promise<void>((resolve) => {
    signalAuditStarted = resolve
  })
  let releaseAudit!: () => void
  const auditMayFinish = new Promise<void>((resolve) => {
    releaseAudit = resolve
  })
  const recorded: AccessGroupAuditEvent[] = []
  const repository = createInMemoryAccessGroupRepository({
    audit: {
      async record({ event }) {
        recorded.push(structuredClone(event))
        signalAuditStarted()
        await auditMayFinish
      },
    },
  })
  const first = repository.save(
    inMemoryAccessGroup("concurrent", 1, "First writer"),
    0,
    inMemoryAccessGroupAudit("concurrent", 0, 1, "concurrent-first"),
  )
  await auditStarted
  const second = repository.save(
    inMemoryAccessGroup("concurrent", 1, "Second writer"),
    0,
    inMemoryAccessGroupAudit("concurrent", 0, 1, "concurrent-second"),
  )
  releaseAudit()
  const [firstOutcome, secondOutcome] = await Promise.allSettled([first, second])

  assert.equal(firstOutcome.status, "fulfilled")
  assert.equal(secondOutcome.status, "rejected")
  if (firstOutcome.status === "fulfilled") assert.equal(firstOutcome.value.display_name, "First writer")
  if (secondOutcome.status === "rejected") {
    assert.equal((secondOutcome.reason as { code?: string }).code, "ACCESS_GROUP_REVISION_CONFLICT")
  }
  assert.deepEqual((await repository.history(tenantId, "concurrent")).map((group) => [group.revision, group.display_name]), [[1, "First writer"]])
  assert.deepEqual(recorded.map((event) => [event.before_revision, event.after_revision, event.correlation_id]), [[0, 1, "concurrent-first"]])
})

test("Access Group organization scope protects management and effective membership", async () => {
  const f = await fixture()
  try {
    const organization = await f.modules.organizations.create({
      tenantId,
      display_name: "AI Platform",
      member_subject_ids: ["org-admin", "kevin"],
    })
    await f.modules.organizations.update({
      tenantId,
      organizationId: organization.organization_id,
      value: {
        display_name: organization.display_name,
        member_subject_ids: organization.member_subject_ids,
        organization_administrator_subject_ids: ["org-admin"],
        membership_sources: organization.membership_sources,
      },
    })
    const otherOrganization = await f.modules.organizations.create({
      tenantId,
      display_name: "Security",
      member_subject_ids: ["nina"],
    })

    const created = await f.app.inject({
      method: "PUT",
      url: `/v1/tenants/${tenantId}/access-groups/engineering-org`,
      headers: f.headers("org-admin"),
      payload: {
        expected_revision: 0,
        organization_id: organization.organization_id,
        display_name: "Engineering Organization",
        description: "Organization-scoped access",
        enabled: true,
      },
    })
    assert.equal(created.statusCode, 200, created.body)
    assert.equal(created.json().organization_id, organization.organization_id)

    const ownMembers = await f.app.inject({
      method: "PUT",
      url: `/v1/tenants/${tenantId}/access-groups/engineering-org/members`,
      headers: f.headers("org-admin"),
      payload: { expected_group_revision: 1, expected_source_revision: 0, subject_ids: ["kevin"] },
    })
    assert.equal(ownMembers.statusCode, 200, ownMembers.body)
    assert.deepEqual((await f.modules.accessGroups.groupsForSubject({ tenantId, subjectId: "kevin" })).map((group) => group.access_group_id), ["engineering-org"])

    const crossOrganizationMember = await f.app.inject({
      method: "PUT",
      url: `/v1/tenants/${tenantId}/access-groups/engineering-org/members`,
      headers: f.headers("org-admin"),
      payload: { expected_group_revision: 2, expected_source_revision: 1, subject_ids: ["nina"] },
    })
    assert.equal(crossOrganizationMember.statusCode, 422, crossOrganizationMember.body)

    const global = await f.app.inject({
      method: "PUT",
      url: `/v1/tenants/${tenantId}/access-groups/global`,
      headers: f.headers("admin"),
      payload: { expected_revision: 0, display_name: "Global", description: "Tenant-wide", enabled: true },
    })
    assert.equal(global.statusCode, 200, global.body)
    assert.equal(global.json().organization_id, null)

    const scopedList = await f.app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/access-groups`, headers: f.headers("org-admin") })
    assert.equal(scopedList.statusCode, 200, scopedList.body)
    assert.deepEqual(scopedList.json().map((group: { access_group_id: string }) => group.access_group_id), ["engineering-org"])
    const globalRead = await f.app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/access-groups/global`, headers: f.headers("org-admin") })
    assert.equal(globalRead.statusCode, 403, globalRead.body)
    const userRead = await f.app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/access-groups`, headers: f.headers("kevin") })
    assert.equal(userRead.statusCode, 403, userRead.body)

    const organizationUpdate = await f.app.inject({
      method: "PUT",
      url: `/v1/tenants/${tenantId}/organizations/${organization.organization_id}`,
      headers: f.headers("org-admin"),
      payload: {
        display_name: organization.display_name,
        member_subject_ids: ["org-admin", "kevin"],
        organization_administrator_subject_ids: ["org-admin"],
        membership_sources: organization.membership_sources,
      },
    })
    assert.equal(organizationUpdate.statusCode, 200, organizationUpdate.body)

    const injectedSubject = await f.app.inject({
      method: "PUT",
      url: `/v1/tenants/${tenantId}/organizations/${organization.organization_id}`,
      headers: f.headers("org-admin"),
      payload: {
        display_name: organization.display_name,
        member_subject_ids: ["nina"],
        organization_administrator_subject_ids: [],
        membership_sources: organization.membership_sources,
      },
    })
    assert.equal(injectedSubject.statusCode, 422, injectedSubject.body)

    const otherOrganizationUpdate = await f.app.inject({
      method: "PUT",
      url: `/v1/tenants/${tenantId}/organizations/${otherOrganization.organization_id}`,
      headers: f.headers("org-admin"),
      payload: {
        display_name: otherOrganization.display_name,
        member_subject_ids: otherOrganization.member_subject_ids,
        organization_administrator_subject_ids: [],
        membership_sources: otherOrganization.membership_sources,
      },
    })
    assert.equal(otherOrganizationUpdate.statusCode, 403, otherOrganizationUpdate.body)

    const removed = await f.app.inject({
      method: "PUT",
      url: `/v1/tenants/${tenantId}/organizations/${organization.organization_id}`,
      headers: f.headers("org-admin"),
      payload: {
        display_name: organization.display_name,
        member_subject_ids: ["org-admin"],
        organization_administrator_subject_ids: ["org-admin"],
        membership_sources: organization.membership_sources,
      },
    })
    assert.equal(removed.statusCode, 409, removed.body)
    assert.equal(removed.json().code, "ACCESS_GROUP_ORGANIZATION_MEMBERSHIP_CONFLICT")

    const removeFromGroup = await f.app.inject({
      method: "PUT",
      url: `/v1/tenants/${tenantId}/access-groups/engineering-org/members`,
      headers: f.headers("org-admin"),
      payload: { expected_group_revision: 2, expected_source_revision: 1, subject_ids: [] },
    })
    assert.equal(removeFromGroup.statusCode, 200, removeFromGroup.body)

    const removedAfterGroup = await f.app.inject({
      method: "PUT",
      url: `/v1/tenants/${tenantId}/organizations/${organization.organization_id}`,
      headers: f.headers("org-admin"),
      payload: {
        display_name: organization.display_name,
        member_subject_ids: ["org-admin"],
        organization_administrator_subject_ids: ["org-admin"],
        membership_sources: organization.membership_sources,
      },
    })
    assert.equal(removedAfterGroup.statusCode, 200, removedAfterGroup.body)
    assert.deepEqual(await f.modules.accessGroups.groupsForSubject({ tenantId, subjectId: "kevin" }), [])
    const scopedListAfterRemoval = await f.app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/access-groups`,
      headers: f.headers("org-admin"),
    })
    assert.equal(scopedListAfterRemoval.statusCode, 200, scopedListAfterRemoval.body)
    assert.deepEqual(scopedListAfterRemoval.json().map((group: { access_group_id: string; membership_sources: Array<{ subject_ids: string[] }> }) => ({
      access_group_id: group.access_group_id,
      subject_ids: group.membership_sources.flatMap((source) => source.subject_ids),
    })), [{ access_group_id: "engineering-org", subject_ids: [] }])
  } finally {
    await f.app.close()
  }
})

test("Access Group memory persistence retries after audit failure without committing", async () => {
  let attempts = 0
  const recorded: AccessGroupAuditEvent[] = []
  const repository = createInMemoryAccessGroupRepository({
    audit: {
      async record({ event }) {
        attempts += 1
        if (attempts === 1) throw new Error("AUDIT_UNAVAILABLE")
        recorded.push(structuredClone(event))
      },
    },
  })
  const value = inMemoryAccessGroup("retry", 1, "Retry")
  const audit = inMemoryAccessGroupAudit("retry", 0, 1, "retry")

  await assert.rejects(repository.save(value, 0, audit), /AUDIT_UNAVAILABLE/)
  assert.deepEqual(await repository.history(tenantId, "retry"), [])

  const retried = await repository.save(value, 0, audit)
  assert.equal(retried.revision, 1)
  assert.deepEqual((await repository.history(tenantId, "retry")).map((group) => group.revision), [1])
  assert.equal(attempts, 2)
  assert.deepEqual(recorded.map((event) => [event.before_revision, event.after_revision]), [[0, 1]])
})

test("Access Group audit failure prevents the memory mutation and durable state restarts cleanly", async () => {
  const identity = createInMemoryIdentityDirectory()
  const organizations = createInMemoryOrganizationDirectory()
  await identity.bootstrap({ tenantId, subjects: [
    { subject_id: "admin", kind: "PERSON", role: "TENANT_ADMINISTRATOR" },
    { subject_id: "kevin", kind: "PERSON", role: "USER" },
  ] })
  const failingAudit: AccessGroupAuditWriter = {
    async record() {
      throw new Error("AUDIT_UNAVAILABLE")
    },
  }
  const failedDirectory = createAccessGroupDirectory({
    repository: createInMemoryAccessGroupRepository({ audit: failingAudit }),
    identity,
    organizations,
    now: () => 1_000,
  })
  await assert.rejects(
    failedDirectory.save(principal("admin"), "restart", {
      expected_revision: 0,
      display_name: "Restart",
      description: "Restart coverage",
      enabled: true,
    }),
    /AUDIT_UNAVAILABLE/,
  )
  assert.equal(await failedDirectory.groupsForSubject({ tenantId, subjectId: "kevin" }).then((groups) => groups.length), 0)

  const audit = createInMemoryGatewayAuthorizationAuditStore()
  const repository = createInMemoryAccessGroupRepository({ audit })
  const first = createAccessGroupDirectory({ repository, identity, organizations, now: () => 1_000 })
  const created = await first.save(principal("admin"), "restart", {
    expected_revision: 0,
    display_name: "Restart",
    description: "Restart coverage",
    enabled: true,
  })
  await first.replaceMembers(principal("admin"), "restart", {
    expected_group_revision: created.revision,
    expected_source_revision: 0,
    subject_ids: ["kevin"],
  })
  const restarted = createAccessGroupDirectory({ repository, identity, organizations, now: () => 1_000 })
  const group = (await restarted.groupsForSubject({ tenantId, subjectId: "kevin" }))[0]
  assert.equal(group?.access_group_id, "restart")
  assert.equal(group?.membership_sources[0]?.revision, 1)
})
