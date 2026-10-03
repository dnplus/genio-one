import assert from "node:assert/strict"
import test from "node:test"

import { createAccessGroupDirectory } from "../src/capabilities/access-groups/module"
import { createInMemoryAccessGroupRepository } from "../src/capabilities/access-groups/memory"
import { createInMemoryGatewayAuthorizationAuditStore } from "../src/capabilities/audit-events/memory"
import { createInMemoryDistillationStore } from "../src/capabilities/distillation/memory"
import { PlatformApiError } from "../src/capabilities/errors"
import {
  createSharedMemoryScopeResolver,
  type SharedMemoryScopePermission,
  type SharedMemoryScopeSelector,
} from "../src/capabilities/memories/shared-scope-access"
import { createInMemoryIdentityDirectory } from "../src/capabilities/identity/memory"
import { createInMemoryOrganizationDirectory } from "../src/capabilities/organizations/memory"
import type { Principal, PrincipalRole } from "../src/capabilities/tenancy-auth/contract"

const tenantId = "tenant-shared-memory"

function principal(
  subjectId: string,
  role: PrincipalRole = "USER",
  organizationIds: string[] = [],
  administratorOrganizationIds?: string[],
): Principal {
  return {
    tenant_id: tenantId,
    subject_id: subjectId,
    client_id: "genio-one-bot",
    role,
    organization_ids: organizationIds,
    ...(administratorOrganizationIds === undefined
      ? {}
      : { administrator_organization_ids: administratorOrganizationIds }),
  }
}

async function rejectsAccess(operation: () => Promise<unknown>): Promise<void> {
  await assert.rejects(
    operation,
    (error: unknown) => error instanceof PlatformApiError && error.code === "SHARED_MEMORY_SCOPE_ACCESS_REQUIRED",
  )
}

async function fixture() {
  const organizations = createInMemoryOrganizationDirectory({
    now: () => 1_000,
    idFactory: (sequence) => `organization-${sequence}`,
  })
  const identity = createInMemoryIdentityDirectory()
  await identity.bootstrap({
    tenantId,
    subjects: [
      "tenant-admin",
      "reader",
      "contributor",
      "maintainer",
      "organization-member",
      "organization-admin",
      "outsider",
    ].map((subject_id) => ({
      subject_id,
      kind: "PERSON" as const,
      role: subject_id === "tenant-admin" ? "TENANT_ADMINISTRATOR" as const : "USER" as const,
    })),
  })
  const accessGroups = createAccessGroupDirectory({
    repository: createInMemoryAccessGroupRepository({
      audit: createInMemoryGatewayAuthorizationAuditStore(),
    }),
    identity,
    organizations,
    now: () => 1_000,
  })
  const admin = principal("tenant-admin", "TENANT_ADMINISTRATOR")
  const organization = await organizations.create({
    tenantId,
    display_name: "Shared Memory",
    member_subject_ids: [
      "reader",
      "contributor",
      "maintainer",
      "organization-member",
      "organization-admin",
    ],
  })
  const currentOrganization = await organizations.update({
    tenantId,
    organizationId: organization.organization_id,
    value: {
      display_name: organization.display_name,
      member_subject_ids: organization.member_subject_ids,
      organization_administrator_subject_ids: ["organization-admin"],
      membership_sources: organization.membership_sources,
    },
  })
  for (const [accessGroupId, displayName] of [
    ["readers", "Readers"],
    ["contributors", "Contributors"],
    ["maintainers", "Maintainers"],
  ] as const) {
    await accessGroups.save(admin, accessGroupId, {
      expected_revision: 0,
      organization_id: currentOrganization.organization_id,
      display_name: displayName,
      description: "",
      enabled: true,
    })
  }
  await accessGroups.replaceMembers(admin, "readers", {
    expected_group_revision: 1,
    expected_source_revision: 0,
    subject_ids: ["reader"],
  })
  await accessGroups.replaceMembers(admin, "contributors", {
    expected_group_revision: 1,
    expected_source_revision: 0,
    subject_ids: ["contributor"],
  })
  await accessGroups.replaceMembers(admin, "maintainers", {
    expected_group_revision: 1,
    expected_source_revision: 0,
    subject_ids: ["maintainer"],
  })
  let workspaceSequence = 0
  const workspaces = createInMemoryDistillationStore({
    now: () => 1_000,
    idFactory: () => `shared-memory-${++workspaceSequence}`,
  })
  const workspace = await workspaces.createWorkspace({
    tenantId,
    createdBy: admin.subject_id,
    value: {
      organization_id: currentOrganization.organization_id,
      display_name: "Shared Memory Workspace",
      reader_access_group_id: "readers",
      contributor_access_group_id: "contributors",
      maintainer_access_group_id: "maintainers",
    },
  })
  return {
    organizations,
    accessGroups,
    workspaces,
    organization: currentOrganization,
    workspace,
    admin,
    resolver: createSharedMemoryScopeResolver({ organizations, accessGroups, workspaces }),
  }
}

test("TEAM resolves its target from the current workspace and applies the reader contributor maintainer matrix", async () => {
  const f = await fixture()
  const selector = {
    scope: "TEAM" as const,
    workspace_id: f.workspace.workspace_id,
    organization_id: "caller-controlled-organization",
  } as unknown as SharedMemoryScopeSelector
  const expected = {
    scope: "TEAM" as const,
    ownerSubjectId: null,
    teamId: f.workspace.workspace_id,
    organizationId: f.organization.organization_id,
  }
  const cases: Array<[string, SharedMemoryScopePermission, boolean]> = [
    ["reader", "READ", true],
    ["reader", "CONTRIBUTE", false],
    ["reader", "MANAGE", false],
    ["contributor", "READ", true],
    ["contributor", "CONTRIBUTE", true],
    ["contributor", "MANAGE", false],
    ["maintainer", "READ", true],
    ["maintainer", "CONTRIBUTE", true],
    ["maintainer", "MANAGE", true],
  ]
  for (const [subjectId, permission, allowed] of cases) {
    const operation = () => f.resolver.resolve(principal(subjectId), selector, permission)
    if (allowed) {
      assert.deepEqual(await operation(), expected)
    } else {
      await rejectsAccess(operation)
    }
  }
  for (const permission of ["READ", "CONTRIBUTE", "MANAGE"] as const) {
    assert.deepEqual(
      await f.resolver.resolve(principal("tenant-admin", "TENANT_ADMINISTRATOR"), selector, permission),
      expected,
    )
  }
})

test("ORGANIZATION resolves membership and administrator access from current directory state", async () => {
  const f = await fixture()
  const selector = { scope: "ORGANIZATION" as const, organization_id: f.organization.organization_id }
  const expected = {
    scope: "ORGANIZATION" as const,
    ownerSubjectId: null,
    teamId: null,
    organizationId: f.organization.organization_id,
  }
  assert.deepEqual(await f.resolver.resolve(principal("organization-member"), selector, "READ"), expected)
  assert.deepEqual(await f.resolver.resolve(principal("organization-member"), selector, "CONTRIBUTE"), expected)
  await rejectsAccess(() => f.resolver.resolve(principal("organization-member"), selector, "MANAGE"))
  assert.deepEqual(await f.resolver.resolve(principal("organization-admin"), selector, "MANAGE"), expected)
  for (const permission of ["READ", "CONTRIBUTE", "MANAGE"] as const) {
    assert.deepEqual(
      await f.resolver.resolve(principal("tenant-admin", "TENANT_ADMINISTRATOR"), selector, permission),
      expected,
    )
  }
  await rejectsAccess(() => f.resolver.resolve(principal(
    "outsider",
    "ORGANIZATION_ADMINISTRATOR",
    [f.organization.organization_id],
    [f.organization.organization_id],
  ), selector, "READ"))
  await rejectsAccess(() => f.resolver.resolve(principal(
    "outsider",
    "ORGANIZATION_ADMINISTRATOR",
    [f.organization.organization_id],
    [f.organization.organization_id],
  ), selector, "MANAGE"))
})

test("TEAM rejects groups that are disabled or no longer include the actor", async () => {
  const f = await fixture()
  const selector = { scope: "TEAM" as const, workspace_id: f.workspace.workspace_id }
  assert.equal((await f.resolver.resolve(principal("reader"), selector, "READ")).teamId, f.workspace.workspace_id)
  await f.accessGroups.save(f.admin, "readers", {
    expected_revision: 2,
    organization_id: f.organization.organization_id,
    display_name: "Readers",
    description: "",
    enabled: false,
  })
  await rejectsAccess(() => f.resolver.resolve(principal("reader"), selector, "READ"))
  await f.accessGroups.save(f.admin, "readers", {
    expected_revision: 3,
    organization_id: f.organization.organization_id,
    display_name: "Readers",
    description: "",
    enabled: true,
  })
  await f.accessGroups.replaceMembers(f.admin, "readers", {
    expected_group_revision: 4,
    expected_source_revision: 1,
    subject_ids: [],
  })
  await rejectsAccess(() => f.resolver.resolve(principal("reader"), selector, "READ"))
})

test("TEAM rejects foreign workspace groups and tenant-scoped selectors", async () => {
  const f = await fixture()
  const otherOrganization = await f.organizations.create({
    tenantId,
    display_name: "Other",
    member_subject_ids: ["reader"],
  })
  await f.accessGroups.save(f.admin, "foreign-readers", {
    expected_revision: 0,
    organization_id: otherOrganization.organization_id,
    display_name: "Foreign readers",
    description: "",
    enabled: true,
  })
  await f.accessGroups.replaceMembers(f.admin, "foreign-readers", {
    expected_group_revision: 1,
    expected_source_revision: 0,
    subject_ids: ["reader"],
  })
  const mismatched = await f.workspaces.createWorkspace({
    tenantId,
    createdBy: f.admin.subject_id,
    value: {
      organization_id: f.organization.organization_id,
      display_name: "Mismatched group workspace",
      reader_access_group_id: "foreign-readers",
      contributor_access_group_id: "contributors",
      maintainer_access_group_id: "maintainers",
    },
  })
  await rejectsAccess(() => f.resolver.resolve(principal("reader"), {
    scope: "TEAM",
    workspace_id: mismatched.workspace_id,
  }, "READ"))
  const otherTenantOrganization = await f.organizations.create({
    tenantId: "tenant-other",
    display_name: "Other tenant",
    member_subject_ids: ["reader"],
  })
  const otherTenantWorkspace = await f.workspaces.createWorkspace({
    tenantId: "tenant-other",
    createdBy: "other-admin",
    value: {
      organization_id: otherTenantOrganization.organization_id,
      display_name: "Other tenant workspace",
      reader_access_group_id: "readers",
      contributor_access_group_id: "contributors",
      maintainer_access_group_id: "maintainers",
    },
  })
  await assert.rejects(
    () => f.resolver.resolve(principal("reader"), {
      scope: "TEAM",
      workspace_id: otherTenantWorkspace.workspace_id,
    }, "READ"),
    (error: unknown) => error instanceof PlatformApiError && error.code === "SHARED_MEMORY_SCOPE_NOT_FOUND",
  )
  await assert.rejects(
    () => f.resolver.resolve(principal("tenant-admin", "TENANT_ADMINISTRATOR"), {
      scope: "TEAM",
      workspace_id: otherTenantWorkspace.workspace_id,
    }, "MANAGE"),
    (error: unknown) => error instanceof PlatformApiError && error.code === "SHARED_MEMORY_SCOPE_NOT_FOUND",
  )
  await assert.rejects(
    () => f.resolver.resolve(principal("reader"), {
      scope: "ORGANIZATION",
      organization_id: otherTenantOrganization.organization_id,
    }, "READ"),
    (error: unknown) => error instanceof PlatformApiError && error.code === "SHARED_MEMORY_SCOPE_NOT_FOUND",
  )
  await assert.rejects(
    () => f.resolver.resolve(principal("tenant-admin", "TENANT_ADMINISTRATOR"), {
      scope: "ORGANIZATION",
      organization_id: otherTenantOrganization.organization_id,
    }, "MANAGE"),
    (error: unknown) => error instanceof PlatformApiError && error.code === "SHARED_MEMORY_SCOPE_NOT_FOUND",
  )
})
