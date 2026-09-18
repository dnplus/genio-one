import type { Organization } from "@/domain/contracts"

export function organizationAdministratorSubjectIds(organization: Organization) {
  return [...new Set(organization.organization_administrator_subject_ids)]
}
