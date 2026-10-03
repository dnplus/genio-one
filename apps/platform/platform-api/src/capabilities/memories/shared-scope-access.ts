import { accessGroupSubjectIds } from "../access-groups/contract"
import type { AccessGroupDirectory } from "../access-groups/module"
import type { DistillationStore } from "../distillation/module"
import { isPlatformApiError, PlatformApiError } from "../errors"
import type { OrganizationDirectory } from "../organizations/module"
import type { Principal } from "../tenancy-auth/contract"
import type { SharedMemoryScopeTarget } from "./module"

export type SharedMemoryScopeSelector =
  | { scope: "TEAM"; workspace_id: string }
  | { scope: "ORGANIZATION"; organization_id: string }

export type SharedMemoryScopePermission = "READ" | "CONTRIBUTE" | "MANAGE"

export interface SharedMemoryScopeResolver {
  resolve(
    actor: Principal,
    selector: SharedMemoryScopeSelector,
    permission: SharedMemoryScopePermission,
  ): Promise<SharedMemoryScopeTarget>
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

function actorIdentity(actor: Principal): { tenantId: string; subjectId: string } {
  return {
    tenantId: identifier(actor.tenant_id, "MEMORY_PRINCIPAL_INVALID"),
    subjectId: identifier(actor.subject_id, "MEMORY_PRINCIPAL_INVALID"),
  }
}

function permissionRequired(permission: SharedMemoryScopePermission): SharedMemoryScopePermission {
  if (permission === "READ" || permission === "CONTRIBUTE" || permission === "MANAGE") {
    return permission
  }
  throw new PlatformApiError("MEMORY_SCOPE_PERMISSION_INVALID", 422)
}

function denied(): never {
  throw new PlatformApiError("SHARED_MEMORY_SCOPE_ACCESS_REQUIRED", 403)
}

function workspaceTarget(workspace: {
  workspace_id: string
  organization_id: string
}): SharedMemoryScopeTarget {
  return {
    scope: "TEAM",
    ownerSubjectId: null,
    teamId: workspace.workspace_id,
    organizationId: workspace.organization_id,
  }
}

function organizationTarget(organizationId: string): SharedMemoryScopeTarget {
  return {
    scope: "ORGANIZATION",
    ownerSubjectId: null,
    teamId: null,
    organizationId,
  }
}

function allowedGroupIds(input: {
  groups: Awaited<ReturnType<AccessGroupDirectory["groupsForSubject"]>>
  tenantId: string
  organizationId: string
  subjectId: string
}): Set<string> {
  return new Set(input.groups
    .filter((group) =>
      group.tenant_id === input.tenantId &&
      group.organization_id === input.organizationId &&
      group.enabled &&
      accessGroupSubjectIds(group).includes(input.subjectId)
    )
    .map((group) => group.access_group_id))
}

export function createSharedMemoryScopeResolver(options: {
  organizations: OrganizationDirectory
  workspaces: Pick<DistillationStore, "getWorkspace">
  accessGroups: Pick<AccessGroupDirectory, "groupsForSubject">
}): SharedMemoryScopeResolver {
  async function currentOrganization(tenantId: string, organizationId: string) {
    try {
      return await options.organizations.get({ tenantId, organizationId })
    } catch (error) {
      if (isPlatformApiError(error) && error.statusCode === 404) {
        throw new PlatformApiError("SHARED_MEMORY_SCOPE_NOT_FOUND", 404)
      }
      throw error
    }
  }

  async function resolveOrganization(
    actor: Principal,
    organizationId: string,
    permission: SharedMemoryScopePermission,
  ): Promise<SharedMemoryScopeTarget> {
    const { tenantId, subjectId } = actorIdentity(actor)
    const organization = await currentOrganization(tenantId, organizationId)
    if (organization.tenant_id !== tenantId || organization.organization_id !== organizationId) {
      throw new PlatformApiError("SHARED_MEMORY_SCOPE_NOT_FOUND", 404)
    }
    if (actor.role === "TENANT_ADMINISTRATOR") {
      return organizationTarget(organization.organization_id)
    }
    if (!organization.member_subject_ids.includes(subjectId)) denied()
    if (
      permission === "MANAGE" &&
      !organization.organization_administrator_subject_ids.includes(subjectId)
    ) {
      denied()
    }
    return organizationTarget(organization.organization_id)
  }

  async function resolveTeam(
    actor: Principal,
    workspaceId: string,
    permission: SharedMemoryScopePermission,
  ): Promise<SharedMemoryScopeTarget> {
    const { tenantId, subjectId } = actorIdentity(actor)
    const workspace = await options.workspaces.getWorkspace(tenantId, workspaceId)
    if (
      !workspace ||
      workspace.tenant_id !== tenantId ||
      workspace.workspace_id !== workspaceId
    ) {
      throw new PlatformApiError("SHARED_MEMORY_SCOPE_NOT_FOUND", 404)
    }
    const organization = await currentOrganization(tenantId, workspace.organization_id)
    if (
      organization.tenant_id !== tenantId ||
      organization.organization_id !== workspace.organization_id
    ) {
      throw new PlatformApiError("SHARED_MEMORY_SCOPE_NOT_FOUND", 404)
    }
    if (actor.role === "TENANT_ADMINISTRATOR") {
      return workspaceTarget(workspace)
    }
    if (!organization.member_subject_ids.includes(subjectId)) denied()
    const groups = await options.accessGroups.groupsForSubject({ tenantId, subjectId })
    const groupIds = allowedGroupIds({
      groups,
      tenantId,
      organizationId: organization.organization_id,
      subjectId,
    })
    const permittedGroupIds = permission === "READ"
      ? [
        workspace.reader_access_group_id,
        workspace.contributor_access_group_id,
        workspace.maintainer_access_group_id,
      ]
      : permission === "CONTRIBUTE"
        ? [workspace.contributor_access_group_id, workspace.maintainer_access_group_id]
        : [workspace.maintainer_access_group_id]
    if (!permittedGroupIds.some((groupId) => groupIds.has(groupId))) denied()
    return workspaceTarget(workspace)
  }

  return {
    async resolve(actor, selector, permission) {
      const requiredPermission = permissionRequired(permission)
      if (selector.scope === "ORGANIZATION") {
        return resolveOrganization(
          actor,
          identifier(selector.organization_id, "MEMORY_SCOPE_ORGANIZATION_ID_INVALID"),
          requiredPermission,
        )
      }
      if (selector.scope === "TEAM") {
        return resolveTeam(
          actor,
          identifier(selector.workspace_id, "MEMORY_SCOPE_WORKSPACE_ID_INVALID"),
          requiredPermission,
        )
      }
      throw new PlatformApiError("MEMORY_SCOPE_SELECTOR_INVALID", 422)
    },
  }
}
