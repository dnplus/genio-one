import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"

import { PlatformApiError } from "../src/capabilities/errors"
import { lockAndAuthorizeSharedScope } from "../src/capabilities/memories/postgres-shared-access"
import type {
  SharedMemoryScopePermission,
  SharedMemoryScopeSelector,
} from "../src/capabilities/memories/shared-scope-access"
import type { Principal } from "../src/capabilities/tenancy-auth/contract"
import { loadMigrations, runMigrations } from "../src/persistence/migration-runner"
import { createPostgresSqlAdapter } from "../src/persistence/sql-adapter"

const databaseUrl = process.env.GENIO_ONE_TEST_DATABASE_URL
const tenantId = "tenant-shared-memory-access"
const organizationId = "organization-shared-memory-access"
const workspaceId = "workspace-shared-memory-access"

function principal(
  subjectId: string,
  role: Principal["role"] = "USER",
  overrides: Partial<Principal> = {},
): Principal {
  return {
    tenant_id: tenantId,
    subject_id: subjectId,
    client_id: "memory-test-client",
    role,
    organization_ids: ["forged-organization"],
    administrator_organization_ids: ["forged-organization"],
    ...overrides,
  }
}

function accessGroupValue(input: {
  accessGroupId: string
  subjectIds: string[]
  enabled?: boolean
  revision?: number
}) {
  const revision = input.revision ?? 1
  return {
    tenant_id: tenantId,
    organization_id: organizationId,
    access_group_id: input.accessGroupId,
    display_name: input.accessGroupId,
    description: "",
    enabled: input.enabled ?? true,
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

function scopeError(error: unknown, code: string, statusCode: number): boolean {
  return error instanceof PlatformApiError && error.code === code && error.statusCode === statusCode
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function seed(sql: ReturnType<typeof createPostgresSqlAdapter>): Promise<void> {
  await sql.query(
    `insert into genio_one_organizations (tenant_id, organization_id, display_name, slug)
     values ($1, $2, $3, $4)`,
    [tenantId, organizationId, "Shared Memory", "shared-memory"],
  )
  const subjects = [
    "person-reader",
    "person-contributor",
    "person-maintainer",
    "person-member",
    "person-organization-admin",
    "person-outsider",
    "person-forged",
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
  const roleGroups = [
    ["group-reader", ["person-reader"]],
    ["group-contributor", ["person-contributor"]],
    ["group-maintainer", ["person-maintainer"]],
  ] as const
  for (const [accessGroupId, subjectIds] of roleGroups) {
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
    [tenantId, workspaceId, organizationId, "Shared Memory", "group-reader", "group-contributor", "group-maintainer"],
  )
}

async function authorize(input: {
  sql: ReturnType<typeof createPostgresSqlAdapter>
  actor: Principal
  selector: SharedMemoryScopeSelector
  permission: SharedMemoryScopePermission
}) {
  return input.sql.transaction((transaction) =>
    lockAndAuthorizeSharedScope(transaction, input.actor, input.selector, input.permission))
}

test(
  "PostgreSQL shared memory ACL fences current organization and workspace access until commit",
  { skip: !databaseUrl, timeout: 30_000 },
  async () => {
    assert.ok(databaseUrl)
    const schema = `shared_memory_access_${randomUUID().replaceAll("-", "")}`
    const options = { max: 1, onnotice: () => {} }
    const admin = createPostgresSqlAdapter({ url: databaseUrl, options })
    const sql = createPostgresSqlAdapter({
      url: databaseUrl,
      options: { ...options, connection: { search_path: schema } },
    })
    const groupRevoker = createPostgresSqlAdapter({
      url: databaseUrl,
      options: { ...options, connection: { search_path: schema } },
    })
    const organizationRevoker = createPostgresSqlAdapter({
      url: databaseUrl,
      options: { ...options, connection: { search_path: schema } },
    })
    const team: SharedMemoryScopeSelector = { scope: "TEAM", workspace_id: workspaceId }
    const organization: SharedMemoryScopeSelector = { scope: "ORGANIZATION", organization_id: organizationId }
    let schemaCreated = false
    try {
      await admin.query(`create schema ${schema}`)
      schemaCreated = true
      const migrations = await loadMigrations()
      await runMigrations(sql, {
        migrations: migrations.filter((migration) => migration.id <= 19),
        advisoryLockKey: schema,
      })
      await seed(sql)

      const teamExpectations: Array<{ actor: Principal; permissions: readonly SharedMemoryScopePermission[] }> = [
        { actor: principal("person-reader"), permissions: ["READ"] },
        { actor: principal("person-contributor"), permissions: ["READ", "CONTRIBUTE"] },
        { actor: principal("person-maintainer"), permissions: ["READ", "CONTRIBUTE", "MANAGE"] },
        { actor: principal("person-organization-admin", "ORGANIZATION_ADMINISTRATOR"), permissions: [] },
        { actor: principal("person-outsider"), permissions: [] },
        { actor: principal("person-forged", "ORGANIZATION_ADMINISTRATOR"), permissions: [] },
        { actor: principal("person-tenant-admin", "TENANT_ADMINISTRATOR"), permissions: ["READ", "CONTRIBUTE", "MANAGE"] },
      ]
      for (const expected of teamExpectations) {
        for (const permission of ["READ", "CONTRIBUTE", "MANAGE"] as const) {
          if (expected.permissions.includes(permission)) {
            const result = await authorize({ sql, actor: expected.actor, selector: team, permission })
            assert.deepEqual(result.target, {
              scope: "TEAM",
              ownerSubjectId: null,
              teamId: workspaceId,
              organizationId,
            })
            assert.equal(
              result.canManage,
              expected.actor.role === "TENANT_ADMINISTRATOR" || expected.actor.subject_id === "person-maintainer",
            )
          } else {
            await assert.rejects(
              () => authorize({ sql, actor: expected.actor, selector: team, permission }),
              (error: unknown) => scopeError(error, "SHARED_MEMORY_SCOPE_ACCESS_REQUIRED", 403),
            )
          }
        }
      }

      const organizationExpectations: Array<{ actor: Principal; permissions: readonly SharedMemoryScopePermission[] }> = [
        { actor: principal("person-member"), permissions: ["READ", "CONTRIBUTE"] },
        { actor: principal("person-organization-admin", "ORGANIZATION_ADMINISTRATOR"), permissions: ["READ", "CONTRIBUTE", "MANAGE"] },
        { actor: principal("person-outsider"), permissions: [] },
        { actor: principal("person-forged", "ORGANIZATION_ADMINISTRATOR"), permissions: [] },
        { actor: principal("person-tenant-admin", "TENANT_ADMINISTRATOR"), permissions: ["READ", "CONTRIBUTE", "MANAGE"] },
      ]
      for (const expected of organizationExpectations) {
        for (const permission of ["READ", "CONTRIBUTE", "MANAGE"] as const) {
          if (expected.permissions.includes(permission)) {
            const result = await authorize({ sql, actor: expected.actor, selector: organization, permission })
            assert.deepEqual(result.target, {
              scope: "ORGANIZATION",
              ownerSubjectId: null,
              teamId: null,
              organizationId,
            })
            assert.equal(
              result.canManage,
              expected.actor.role === "TENANT_ADMINISTRATOR" || expected.actor.subject_id === "person-organization-admin",
            )
          } else {
            await assert.rejects(
              () => authorize({ sql, actor: expected.actor, selector: organization, permission }),
              (error: unknown) => scopeError(error, "SHARED_MEMORY_SCOPE_ACCESS_REQUIRED", 403),
            )
          }
        }
      }

      await assert.rejects(
        () => authorize({
          sql,
          actor: principal("person-reader", "USER", { tenant_id: "tenant-other" }),
          selector: team,
          permission: "READ",
        }),
        (error: unknown) => scopeError(error, "SHARED_MEMORY_SCOPE_NOT_FOUND", 404),
      )
      await assert.rejects(
        () => authorize({
          sql,
          actor: principal("person-reader"),
          selector: { scope: "ORGANIZATION", organization_id: "organization-missing" },
          permission: "READ",
        }),
        (error: unknown) => scopeError(error, "SHARED_MEMORY_SCOPE_NOT_FOUND", 404),
      )
      await assert.rejects(
        () => authorize({
          sql,
          actor: principal("person-reader"),
          selector: { scope: "TEAM", workspace_id: "workspace-missing" },
          permission: "READ",
        }),
        (error: unknown) => scopeError(error, "SHARED_MEMORY_SCOPE_NOT_FOUND", 404),
      )

      let groupFenceEnteredResolve: (() => void) | undefined
      const groupFenceEntered = new Promise<void>((resolve) => { groupFenceEnteredResolve = resolve })
      let releaseGroupFenceResolve: (() => void) | undefined
      const releaseGroupFence = new Promise<void>((resolve) => { releaseGroupFenceResolve = resolve })
      const groupAuthorization = sql.transaction(async (transaction) => {
        const result = await lockAndAuthorizeSharedScope(
          transaction,
          principal("person-contributor"),
          team,
          "CONTRIBUTE",
        )
        groupFenceEnteredResolve?.()
        await releaseGroupFence
        return result
      })
      await groupFenceEntered
      let groupRevocationStartedResolve: (() => void) | undefined
      const groupRevocationStarted = new Promise<void>((resolve) => { groupRevocationStartedResolve = resolve })
      let groupRevoked = false
      const contributorValue = accessGroupValue({
        accessGroupId: "group-contributor",
        subjectIds: [],
        revision: 2,
      })
      const revokeContributor = groupRevoker.transaction(async (transaction) => {
        groupRevocationStartedResolve?.()
        await transaction.query(
          `select revision
             from genio_one_access_groups
            where tenant_id = $1 and access_group_id = $2
            for update`,
          [tenantId, "group-contributor"],
        )
        await transaction.query(
          `update genio_one_access_groups
              set revision = $3, value = $4::text::jsonb
            where tenant_id = $1 and access_group_id = $2`,
          [tenantId, "group-contributor", contributorValue.revision, JSON.stringify(contributorValue)],
        )
        groupRevoked = true
      })
      await groupRevocationStarted
      try {
        await wait(25)
        assert.equal(groupRevoked, false)
      } finally {
        releaseGroupFenceResolve?.()
      }
      const continuedGroupAuthorization = await groupAuthorization
      assert.equal(continuedGroupAuthorization.canManage, false)
      await revokeContributor
      await assert.rejects(
        () => authorize({ sql, actor: principal("person-contributor"), selector: team, permission: "READ" }),
        (error: unknown) => scopeError(error, "SHARED_MEMORY_SCOPE_ACCESS_REQUIRED", 403),
      )

      let organizationFenceEnteredResolve: (() => void) | undefined
      const organizationFenceEntered = new Promise<void>((resolve) => { organizationFenceEnteredResolve = resolve })
      let releaseOrganizationFenceResolve: (() => void) | undefined
      const releaseOrganizationFence = new Promise<void>((resolve) => { releaseOrganizationFenceResolve = resolve })
      const organizationAuthorization = sql.transaction(async (transaction) => {
        const result = await lockAndAuthorizeSharedScope(
          transaction,
          principal("person-reader"),
          team,
          "READ",
        )
        organizationFenceEnteredResolve?.()
        await releaseOrganizationFence
        return result
      })
      await organizationFenceEntered
      let organizationRevocationStartedResolve: (() => void) | undefined
      const organizationRevocationStarted = new Promise<void>((resolve) => { organizationRevocationStartedResolve = resolve })
      let organizationRevoked = false
      const revokeMembership = organizationRevoker.transaction(async (transaction) => {
        organizationRevocationStartedResolve?.()
        await transaction.query(
          `update genio_one_organizations
              set display_name = $3
            where tenant_id = $1 and organization_id = $2`,
          [tenantId, organizationId, "Shared Memory Revoked"],
        )
        await transaction.query(
          `delete from genio_one_organization_memberships
            where tenant_id = $1 and organization_id = $2 and subject_id = $3`,
          [tenantId, organizationId, "person-reader"],
        )
        organizationRevoked = true
      })
      await organizationRevocationStarted
      try {
        await wait(25)
        assert.equal(organizationRevoked, false)
      } finally {
        releaseOrganizationFenceResolve?.()
      }
      const continuedOrganizationAuthorization = await organizationAuthorization
      assert.equal(continuedOrganizationAuthorization.canManage, false)
      await revokeMembership
      await assert.rejects(
        () => authorize({ sql, actor: principal("person-reader"), selector: team, permission: "READ" }),
        (error: unknown) => scopeError(error, "SHARED_MEMORY_SCOPE_ACCESS_REQUIRED", 403),
      )
    } finally {
      try {
        await Promise.all([sql.end(), groupRevoker.end(), organizationRevoker.end()])
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
