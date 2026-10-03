import type { SqlTransaction } from "../../persistence/sql-adapter"
import { PlatformApiError } from "../errors"
import type { Principal } from "../tenancy-auth/contract"
import type { SharedMemoryScopeTarget } from "./module"
import type {
  SharedMemoryScopePermission,
  SharedMemoryScopeSelector,
} from "./shared-scope-access"

type Row = Record<string, unknown>

interface SharedScopeAuthorization {
  target: SharedMemoryScopeTarget
  canManage: boolean
}

interface WorkspaceRoleGroups {
  reader: string | null
  contributor: string | null
  maintainer: string | null
}

function identifier(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 256 ||
    value !== value.trim() ||
    value.includes("\u0000") ||
    value.includes("\r") ||
    value.includes("\n")
  ) {
    throw new PlatformApiError(code, 422)
  }
  return value
}

function rowIdentifier(row: Row, key: string): string | null {
  const value = row[key]
  return typeof value === "string" && value.trim() ? value : null
}

function selectorPermission(permission: SharedMemoryScopePermission): SharedMemoryScopePermission {
  if (permission === "READ" || permission === "CONTRIBUTE" || permission === "MANAGE") {
    return permission
  }
  throw new PlatformApiError("MEMORY_SCOPE_PERMISSION_INVALID", 422)
}

function notFound(): never {
  throw new PlatformApiError("SHARED_MEMORY_SCOPE_NOT_FOUND", 404)
}

function denied(): never {
  throw new PlatformApiError("SHARED_MEMORY_SCOPE_ACCESS_REQUIRED", 403)
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value !== "string") return null
  try {
    return record(JSON.parse(value))
  } catch {
    return null
  }
}

function groupIncludesSubject(input: {
  row: Row
  tenantId: string
  organizationId: string
  subjectId: string
}): boolean {
  if (rowIdentifier(input.row, "organization_id") !== input.organizationId) return false
  const value = record(input.row.value)
  if (!value || value.tenant_id !== input.tenantId || value.organization_id !== input.organizationId || value.enabled !== true) {
    return false
  }
  if (!Array.isArray(value.membership_sources)) return false
  return value.membership_sources.some((source) => {
    const memberSource = record(source)
    return Array.isArray(memberSource?.subject_ids) && memberSource.subject_ids.includes(input.subjectId)
  })
}

function roleGroupIds(workspace: Row): WorkspaceRoleGroups {
  return {
    reader: rowIdentifier(workspace, "reader_access_group_id"),
    contributor: rowIdentifier(workspace, "contributor_access_group_id"),
    maintainer: rowIdentifier(workspace, "maintainer_access_group_id"),
  }
}

async function lockOrganization(
  transaction: SqlTransaction,
  tenantId: string,
  organizationId: string,
): Promise<void> {
  const organization = await transaction.query<Row>(
    `select organization_id
       from genio_one_organizations
      where tenant_id = $1 and organization_id = $2
      for share`,
    [tenantId, organizationId],
  )
  if (!organization.rows[0]) notFound()
}

async function currentMembership(input: {
  transaction: SqlTransaction
  tenantId: string
  organizationId: string
  subjectId: string
}): Promise<"USER" | "ORGANIZATION_ADMINISTRATOR" | null> {
  const membership = await input.transaction.query<Row>(
    `select role
       from genio_one_organization_memberships
      where tenant_id = $1 and organization_id = $2 and subject_id = $3
      for share`,
    [input.tenantId, input.organizationId, input.subjectId],
  )
  const role = membership.rows[0]?.role
  if (role === "USER" || role === "ORGANIZATION_ADMINISTRATOR") return role
  return null
}

async function lockTeamScope(input: {
  transaction: SqlTransaction
  actor: Principal
  workspaceId: string
  permission: SharedMemoryScopePermission
}): Promise<SharedScopeAuthorization> {
  const tenantId = identifier(input.actor.tenant_id, "MEMORY_PRINCIPAL_INVALID")
  const subjectId = identifier(input.actor.subject_id, "MEMORY_PRINCIPAL_INVALID")
  const located = await input.transaction.query<Row>(
    `select organization_id
       from genio_one_team_workspaces
      where tenant_id = $1 and workspace_id = $2`,
    [tenantId, input.workspaceId],
  )
  const locatedOrganizationId = located.rows[0] ? rowIdentifier(located.rows[0], "organization_id") : null
  if (!locatedOrganizationId) notFound()

  await lockOrganization(input.transaction, tenantId, locatedOrganizationId)

  const workspace = await input.transaction.query<Row>(
    `select organization_id, reader_access_group_id, contributor_access_group_id,
            maintainer_access_group_id
       from genio_one_team_workspaces
      where tenant_id = $1 and workspace_id = $2
      for share`,
    [tenantId, input.workspaceId],
  )
  const workspaceRow = workspace.rows[0]
  if (!workspaceRow || rowIdentifier(workspaceRow, "organization_id") !== locatedOrganizationId) notFound()

  const groups = roleGroupIds(workspaceRow)
  const groupIds = [...new Set(Object.values(groups).filter((value): value is string => value !== null))]
    .sort()
  const lockedGroups = new Map<string, Row>()
  for (const accessGroupId of groupIds) {
    const group = await input.transaction.query<Row>(
      `select access_group_id, organization_id, value
         from genio_one_access_groups
        where tenant_id = $1 and organization_id = $2 and access_group_id = $3
        for share`,
      [tenantId, locatedOrganizationId, accessGroupId],
    )
    if (group.rows[0]) lockedGroups.set(accessGroupId, group.rows[0])
  }

  const membership = await currentMembership({
    transaction: input.transaction,
    tenantId,
    organizationId: locatedOrganizationId,
    subjectId,
  })
  const tenantAdministrator = input.actor.role === "TENANT_ADMINISTRATOR"
  const groupMember = (accessGroupId: string | null): boolean => {
    if (!membership || !accessGroupId) return false
    const group = lockedGroups.get(accessGroupId)
    return group !== undefined && groupIncludesSubject({
      row: group,
      tenantId,
      organizationId: locatedOrganizationId,
      subjectId,
    })
  }
  const reader = groupMember(groups.reader)
  const contributor = groupMember(groups.contributor)
  const maintainer = groupMember(groups.maintainer)
  const permitted = tenantAdministrator || (
    input.permission === "READ"
      ? reader || contributor || maintainer
      : input.permission === "CONTRIBUTE"
        ? contributor || maintainer
        : maintainer
  )
  if (!permitted) denied()
  return {
    target: {
      scope: "TEAM",
      ownerSubjectId: null,
      teamId: input.workspaceId,
      organizationId: locatedOrganizationId,
    },
    canManage: tenantAdministrator || maintainer,
  }
}

async function lockOrganizationScope(input: {
  transaction: SqlTransaction
  actor: Principal
  organizationId: string
  permission: SharedMemoryScopePermission
}): Promise<SharedScopeAuthorization> {
  const tenantId = identifier(input.actor.tenant_id, "MEMORY_PRINCIPAL_INVALID")
  const subjectId = identifier(input.actor.subject_id, "MEMORY_PRINCIPAL_INVALID")
  await lockOrganization(input.transaction, tenantId, input.organizationId)
  const membership = await currentMembership({
    transaction: input.transaction,
    tenantId,
    organizationId: input.organizationId,
    subjectId,
  })
  const tenantAdministrator = input.actor.role === "TENANT_ADMINISTRATOR"
  const canManage = tenantAdministrator || membership === "ORGANIZATION_ADMINISTRATOR"
  const permitted = tenantAdministrator || (
    input.permission === "MANAGE" ? canManage : membership !== null
  )
  if (!permitted) denied()
  return {
    target: {
      scope: "ORGANIZATION",
      ownerSubjectId: null,
      teamId: null,
      organizationId: input.organizationId,
    },
    canManage,
  }
}

export async function lockAndAuthorizeSharedScope(
  transaction: SqlTransaction,
  actor: Principal,
  selector: SharedMemoryScopeSelector,
  permission: SharedMemoryScopePermission,
): Promise<SharedScopeAuthorization> {
  const requiredPermission = selectorPermission(permission)
  if (selector.scope === "TEAM") {
    return lockTeamScope({
      transaction,
      actor,
      workspaceId: identifier(selector.workspace_id, "MEMORY_SCOPE_WORKSPACE_ID_INVALID"),
      permission: requiredPermission,
    })
  }
  if (selector.scope === "ORGANIZATION") {
    return lockOrganizationScope({
      transaction,
      actor,
      organizationId: identifier(selector.organization_id, "MEMORY_SCOPE_ORGANIZATION_ID_INVALID"),
      permission: requiredPermission,
    })
  }
  throw new PlatformApiError("MEMORY_SCOPE_SELECTOR_INVALID", 422)
}
