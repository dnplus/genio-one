import type { Organization, UpdateOrganizationInput } from "@/domain/contracts"

const organizationOverrides = new Map<string, Organization>()

export function applyMockOrganizationOverrides(organizations: Organization[]) {
  const merged = organizations.map((organization) => organizationOverrides.get(organization.organization_id) ?? organization)
  const existing = new Set(organizations.map((organization) => organization.organization_id))
  return [...merged, ...[...organizationOverrides.values()].filter((organization) => !existing.has(organization.organization_id))]
}

export function createMockOrganization(tenantId: string, input: { displayName: string; memberSubjectIds: string[] }) {
  const organization: Organization = {
    tenant_id: tenantId,
    organization_id: `organization-${crypto.randomUUID()}`,
    display_name: input.displayName,
    slug: input.displayName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "organization",
    member_subject_ids: input.memberSubjectIds,
    organization_administrator_subject_ids: input.memberSubjectIds.slice(0, 1),
    membership_sources: [{ kind: "MANUAL", reference: "console", status: "SYNCED" }],
    created_at: Math.floor(Date.now() / 1000),
  }
  organizationOverrides.set(organization.organization_id, organization)
  return organization
}

export function updateMockOrganization(organization: Organization, input: UpdateOrganizationInput) {
  const next: Organization = {
    ...organization,
    display_name: input.displayName,
    member_subject_ids: input.memberSubjectIds,
    organization_administrator_subject_ids: input.organizationAdministratorSubjectIds,
    membership_sources: input.membershipSources,
  }
  organizationOverrides.set(organization.organization_id, next)
  return next
}
