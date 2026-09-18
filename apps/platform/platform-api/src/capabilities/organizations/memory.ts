import { PlatformApiError } from "../errors"
import type { OrganizationDirectory } from "./module"
import type { CreateOrganizationCommand } from "./module"
import type { Organization } from "./contract"

export interface OrganizationMemoryOptions {
  now?: () => number
  idFactory?: (sequence: number) => string
}

export function createInMemoryOrganizationDirectory(
  options: OrganizationMemoryOptions = {},
): OrganizationDirectory {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const idFactory = options.idFactory ?? ((sequence) => `org-${sequence}`)
  const organizations = new Map<string, Organization>()
  let sequence = 0

  return {
    async list(input) {
      return [...organizations.values()]
        .filter((organization) => organization.tenant_id === input.tenantId)
        .sort((left, right) => left.display_name.localeCompare(right.display_name))
    },

    async create(input: CreateOrganizationCommand) {
      const slug = (input.slug ?? input.display_name)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
      if (!slug) {
        throw new PlatformApiError("INVALID_ORGANIZATION_SLUG", 400)
      }
      const duplicate = [...organizations.values()].some(
        (organization) =>
          organization.tenant_id === input.tenantId && organization.slug === slug,
      )
      if (duplicate) {
        throw new PlatformApiError("ORGANIZATION_SLUG_EXISTS", 409)
      }
      sequence += 1
      const organization: Organization = {
        tenant_id: input.tenantId,
        organization_id: idFactory(sequence),
        display_name: input.display_name.trim(),
        slug,
        member_subject_ids: [...new Set(input.member_subject_ids ?? [])],
        organization_administrator_subject_ids: [],
        membership_sources: [{ kind: "MANUAL", reference: "console", status: "SYNCED" }],
        created_at: now(),
      }
      organizations.set(`${organization.tenant_id}:${organization.organization_id}`, organization)
      return organization
    },

    async get(input) {
      const organization = organizations.get(`${input.tenantId}:${input.organizationId}`)
      if (!organization) {
        throw new PlatformApiError("ORGANIZATION_NOT_FOUND", 404)
      }
      return organization
    },

    async update(input) {
      const mapKey = `${input.tenantId}:${input.organizationId}`
      const current = organizations.get(mapKey)
      if (!current) throw new PlatformApiError("ORGANIZATION_NOT_FOUND", 404)
      const members = [...new Set(input.value.member_subject_ids)]
      const administrators = [...new Set(input.value.organization_administrator_subject_ids)]
      if (administrators.some((subjectId) => !members.includes(subjectId))) {
        throw new PlatformApiError(
          "ORGANIZATION_ADMINISTRATOR_MEMBERSHIP_REQUIRED",
          422,
          "Organization Administrators must be Organization members",
        )
      }
      const updated: Organization = {
        ...current,
        display_name: input.value.display_name.trim(),
        member_subject_ids: members,
        organization_administrator_subject_ids: administrators,
        membership_sources: input.value.membership_sources.map((source) => ({ ...source })),
      }
      organizations.set(mapKey, updated)
      return structuredClone(updated)
    },

    async accessForSubject(input) {
      const memberOrganizations = [...organizations.values()].filter(
        (organization) => organization.tenant_id === input.tenantId &&
          organization.member_subject_ids.includes(input.subjectId),
      )
      return {
        organization_ids: memberOrganizations.map((organization) => organization.organization_id).sort(),
        administrator_organization_ids: memberOrganizations
          .filter((organization) => organization.organization_administrator_subject_ids.includes(input.subjectId))
          .map((organization) => organization.organization_id)
          .sort(),
      }
    },
  }
}
