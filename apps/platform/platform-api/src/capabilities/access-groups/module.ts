import { randomUUID } from "node:crypto"

import type { IdentityDirectory } from "../identity/module"
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
  save(actor: Principal, accessGroupId: string, value: SaveAccessGroup, context?: { correlationId?: string }): Promise<AccessGroup>
  replaceMembers(actor: Principal, accessGroupId: string, value: ReplaceAccessGroupMembers, context?: { correlationId?: string }): Promise<AccessGroup>
  history(actor: Principal, accessGroupId: string): Promise<AccessGroup[]>
  groupsForSubject(input: { tenantId: string; subjectId: string }): Promise<AccessGroup[]>
}

function requireTenantAdministrator(actor: Principal): void {
  if (actor.role !== "TENANT_ADMINISTRATOR") {
    throw new PlatformApiError("TENANT_ADMINISTRATOR_REQUIRED", 403)
  }
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
  now?: () => number
}): AccessGroupDirectory {
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000))

  async function get(actor: Principal, accessGroupId: string): Promise<AccessGroup> {
    const group = await options.repository.get(actor.tenant_id, accessGroupId)
    if (!group) throw new PlatformApiError("ACCESS_GROUP_NOT_FOUND", 404)
    return group
  }

  return {
    async list(actor) {
      requireTenantAdministrator(actor)
      return options.repository.list(actor.tenant_id)
    },
    async get(actor, accessGroupId) {
      requireTenantAdministrator(actor)
      return get(actor, accessGroupId)
    },
    async save(actor, accessGroupId, value, context) {
      requireTenantAdministrator(actor)
      const normalizedId = normalize(accessGroupId)
      const displayName = value.display_name.trim()
      if (!normalizedId) throw new PlatformApiError("ACCESS_GROUP_ID_REQUIRED", 422)
      if (!displayName) throw new PlatformApiError("ACCESS_GROUP_NAME_REQUIRED", 422)
      const current = await options.repository.get(actor.tenant_id, normalizedId)
      if ((current?.revision ?? 0) !== value.expected_revision) {
        throw new PlatformApiError("ACCESS_GROUP_REVISION_CONFLICT", 409)
      }
      const at = now()
      const next: AccessGroup = {
        tenant_id: actor.tenant_id,
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
      requireTenantAdministrator(actor)
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
      if (value.subject_ids.some((subjectId) => !registered.has(subjectId))) {
        throw new PlatformApiError("ACCESS_GROUP_SUBJECT_NOT_FOUND", 422)
      }
      const at = now()
      const source: AccessGroup["membership_sources"][number] = {
        source_id: "manual",
        kind: "MANUAL" as const,
        revision: value.expected_source_revision + 1,
        subject_ids: [...new Set(value.subject_ids.map(normalize))].sort(),
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
      requireTenantAdministrator(actor)
      await get(actor, accessGroupId)
      return options.repository.history(actor.tenant_id, accessGroupId)
    },
    async groupsForSubject({ tenantId, subjectId }) {
      const groups = await options.repository.forSubject(tenantId, subjectId)
      return groups
        .filter((group) => accessGroupSubjectIds(group).includes(subjectId))
        .sort((left, right) => left.access_group_id.localeCompare(right.access_group_id))
    },
  }
}
