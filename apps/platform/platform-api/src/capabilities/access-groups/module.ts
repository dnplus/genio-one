import { randomUUID } from "node:crypto"

import type { IdentityDirectory } from "../identity/module"
import type { OrganizationDirectory } from "../organizations/module"
import { PlatformApiError } from "../errors"
import type { Principal } from "../tenancy-auth/contract"
import { accessGroupAuditEvent, type AccessGroupAuditEvent, type AccessGroupAuditOperation } from "./audit"
import {
  accessGroupSubjectIds,
  type AccessGroup,
  type ReplaceAccessGroupMembers,
  type SaveAccessGroup,
} from "./contract"

export interface AccessGroupRepository {
  list(tenantId: string): Promise<AccessGroup[]>
  forSubject(tenantId: string, subjectId: string): Promise<AccessGroup[]>
  get(tenantId: string, accessGroupId: string): Promise<AccessGroup | null>
  save(value: AccessGroup, expectedRevision: number, audit: AccessGroupAuditEvent): Promise<AccessGroup>
  history(tenantId: string, accessGroupId: string): Promise<AccessGroup[]>
}

export interface AccessGroupDirectory {
  list(actor: Principal): Promise<AccessGroup[]>
  get(actor: Principal, accessGroupId: string): Promise<AccessGroup>
  assertOrganizationMembersRemainScoped(input: { tenantId: string; organizationId: string; memberSubjectIds: readonly string[] }): Promise<void>
  save(actor: Principal, accessGroupId: string, value: SaveAccessGroup, context?: { correlationId?: string }): Promise<AccessGroup>
  replaceMembers(actor: Principal, accessGroupId: string, value: ReplaceAccessGroupMembers, context?: { correlationId?: string }): Promise<AccessGroup>
  history(actor: Principal, accessGroupId: string): Promise<AccessGroup[]>
  groupsForSubject(input: { tenantId: string; subjectId: string }): Promise<AccessGroup[]>
}

function canManageGroup(actor: Principal, group: AccessGroup): boolean {
  return actor.role === "TENANT_ADMINISTRATOR" || (
    actor.role === "ORGANIZATION_ADMINISTRATOR" &&
    group.organization_id !== null &&
    actor.organization_ids.includes(group.organization_id)
  )
}

function assertCanManageGroup(actor: Principal, group: AccessGroup): void {
  if (!canManageGroup(actor, group)) {
    throw new PlatformApiError("ACCESS_GROUP_SCOPE_REQUIRED", 403)
  }
}

function normalizeOrganizationId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const normalized = value.trim()
  if (!normalized) throw new PlatformApiError("ACCESS_GROUP_ORGANIZATION_REQUIRED", 422)
  return normalized
}

async function validateOwnerOrganization(options: {
  organizations: OrganizationDirectory
}, actor: Principal, organizationId: string | null): Promise<void> {
  if (organizationId === null) {
    if (actor.role !== "TENANT_ADMINISTRATOR") {
      throw new PlatformApiError("ACCESS_GROUP_ORGANIZATION_REQUIRED", 403)
    }
    return
  }
  if (actor.role !== "TENANT_ADMINISTRATOR" && !actor.organization_ids.includes(organizationId)) {
    throw new PlatformApiError("ACCESS_GROUP_SCOPE_REQUIRED", 403)
  }
  await options.organizations.get({ tenantId: actor.tenant_id, organizationId })
}

function normalize(value: string): string {
  return value.trim()
}

function operation(current: AccessGroup | null, next: AccessGroup): AccessGroupAuditOperation {
  if (!current) return "CREATED"
  if (current.enabled !== next.enabled) return next.enabled ? "ENABLED" : "DISABLED"
  return "UPDATED"
}

function correlationId(context: { correlationId?: string } | undefined): string {
  return context?.correlationId?.trim() || `access-group-${randomUUID()}`
}

export function createAccessGroupDirectory(options: {
  repository: AccessGroupRepository
  identity: IdentityDirectory
  organizations: OrganizationDirectory
  now?: () => number
}): AccessGroupDirectory {
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000))

  async function get(actor: Principal, accessGroupId: string): Promise<AccessGroup> {
    const group = await options.repository.get(actor.tenant_id, accessGroupId)
    if (!group) throw new PlatformApiError("ACCESS_GROUP_NOT_FOUND", 404)
    assertCanManageGroup(actor, group)
    return group
  }

  async function assertOrganizationMembersRemainScoped(input: {
    tenantId: string
    organizationId: string
    memberSubjectIds: readonly string[]
  }): Promise<void> {
    const organizationMembers = new Set(input.memberSubjectIds)
    const groups = await options.repository.list(input.tenantId)
    const orphaned = groups.filter((group) =>
      group.organization_id === input.organizationId &&
      accessGroupSubjectIds(group).some((subjectId) => !organizationMembers.has(subjectId))
    )
    if (orphaned.length) {
      throw new PlatformApiError(
        "ACCESS_GROUP_ORGANIZATION_MEMBERSHIP_CONFLICT",
        409,
        "Remove each person from Organization-owned Access Groups before changing Organization membership.",
        orphaned.map((group) => ({
          code: "ACCESS_GROUP_MEMBER_STILL_ASSIGNED",
          message: group.display_name,
          field: group.access_group_id,
        })),
      )
    }
  }

  return {
    assertOrganizationMembersRemainScoped,
    async list(actor) {
      if (actor.role === "USER") throw new PlatformApiError("ACCESS_GROUP_SCOPE_REQUIRED", 403)
      const groups = await options.repository.list(actor.tenant_id)
      return groups.filter((group) => canManageGroup(actor, group))
    },
    async get(actor, accessGroupId) {
      return get(actor, accessGroupId)
    },
    async save(actor, accessGroupId, value, context) {
      const normalizedId = normalize(accessGroupId)
      const displayName = value.display_name.trim()
      if (!normalizedId) throw new PlatformApiError("ACCESS_GROUP_ID_REQUIRED", 422)
      if (!displayName) throw new PlatformApiError("ACCESS_GROUP_NAME_REQUIRED", 422)
      const current = await options.repository.get(actor.tenant_id, normalizedId)
      if (current) assertCanManageGroup(actor, current)
      if ((current?.revision ?? 0) !== value.expected_revision) {
        throw new PlatformApiError("ACCESS_GROUP_REVISION_CONFLICT", 409)
      }
      const organizationId = normalizeOrganizationId(
        value.organization_id === undefined ? current?.organization_id : value.organization_id,
      )
      if (current && organizationId !== current.organization_id) {
        throw new PlatformApiError("ACCESS_GROUP_OWNER_IMMUTABLE", 409)
      }
      await validateOwnerOrganization(options, actor, organizationId)
      const at = now()
      const next: AccessGroup = {
        tenant_id: actor.tenant_id,
        organization_id: organizationId,
        access_group_id: normalizedId,
        display_name: displayName,
        description: value.description.trim(),
        enabled: value.enabled,
        revision: value.expected_revision + 1,
        membership_sources: current?.membership_sources ?? [],
        created_at: current?.created_at ?? at,
        created_by: current?.created_by ?? actor.subject_id,
        updated_at: at,
        updated_by: actor.subject_id,
      }
      return options.repository.save(next, value.expected_revision, accessGroupAuditEvent({
        tenantId: actor.tenant_id,
        accessGroupId: normalizedId,
        actorSubjectId: actor.subject_id,
        correlationId: correlationId(context),
        operation: operation(current, next),
        beforeRevision: current?.revision ?? 0,
        afterRevision: next.revision,
        occurredAt: at,
      }))
    },
    async replaceMembers(actor, accessGroupId, value, context) {
      const current = await get(actor, accessGroupId)
      if (current.revision !== value.expected_group_revision) {
        throw new PlatformApiError("ACCESS_GROUP_REVISION_CONFLICT", 409)
      }
      const existing = current.membership_sources[0]
      if ((existing?.revision ?? 0) !== value.expected_source_revision) {
        throw new PlatformApiError("ACCESS_GROUP_SOURCE_REVISION_CONFLICT", 409)
      }
      const inventory = await options.identity.inventory({ tenantId: actor.tenant_id })
      const registered = new Set(inventory.subjects.map((subject) => subject.subject_id))
      const subjectIds = [...new Set(value.subject_ids.map(normalize))].sort()
      if (subjectIds.some((subjectId) => !registered.has(subjectId))) {
        throw new PlatformApiError("ACCESS_GROUP_SUBJECT_NOT_FOUND", 422)
      }
      if (current.organization_id !== null) {
        const organization = await options.organizations.get({
          tenantId: actor.tenant_id,
          organizationId: current.organization_id,
        })
        const members = new Set(organization.member_subject_ids)
        if (subjectIds.some((subjectId) => !members.has(subjectId))) {
          throw new PlatformApiError("ACCESS_GROUP_MEMBER_ORGANIZATION_REQUIRED", 422)
        }
      }
      const at = now()
      const source: AccessGroup["membership_sources"][number] = {
        source_id: "manual",
        kind: "MANUAL" as const,
        revision: value.expected_source_revision + 1,
        subject_ids: subjectIds,
        created_at: existing?.created_at ?? at,
        created_by: existing?.created_by ?? actor.subject_id,
        updated_at: at,
        updated_by: actor.subject_id,
      }
      const next: AccessGroup = {
        ...current,
        revision: current.revision + 1,
        membership_sources: [source],
        updated_at: at,
        updated_by: actor.subject_id,
      }
      return options.repository.save(next, current.revision, accessGroupAuditEvent({
        tenantId: actor.tenant_id,
        accessGroupId: current.access_group_id,
        actorSubjectId: actor.subject_id,
        correlationId: correlationId(context),
        operation: "MEMBERS_REPLACED",
        beforeRevision: current.revision,
        afterRevision: next.revision,
        occurredAt: at,
      }))
    },
    async history(actor, accessGroupId) {
      await get(actor, accessGroupId)
      return options.repository.history(actor.tenant_id, accessGroupId)
    },
    async groupsForSubject({ tenantId, subjectId }) {
      const groups = await options.repository.forSubject(tenantId, subjectId)
      const effective = await Promise.all(groups
        .filter((group) => accessGroupSubjectIds(group).includes(subjectId))
        .map(async (group) => {
          if (group.organization_id === null) return group
          try {
            const organization = await options.organizations.get({
              tenantId,
              organizationId: group.organization_id,
            })
            return organization.member_subject_ids.includes(subjectId) ? group : null
          } catch (error) {
            if (error instanceof PlatformApiError && error.code === "ORGANIZATION_NOT_FOUND") return null
            throw error
          }
        }))
      return effective
        .filter((group): group is AccessGroup => group !== null)
        .sort((left, right) => left.access_group_id.localeCompare(right.access_group_id))
    },
  }
}
