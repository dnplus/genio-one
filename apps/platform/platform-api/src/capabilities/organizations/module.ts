import type { CreateOrganizationInput, Organization, UpdateOrganizationInput } from "./contract"

export interface ListOrganizationsInput {
  tenantId: string
}

export interface CreateOrganizationCommand extends CreateOrganizationInput {
  tenantId: string
}

export interface OrganizationDirectory {
  list(input: ListOrganizationsInput): Promise<Organization[]>
  create(input: CreateOrganizationCommand): Promise<Organization>
  get(input: { tenantId: string; organizationId: string }): Promise<Organization>
  update(input: {
    tenantId: string
    organizationId: string
    value: UpdateOrganizationInput
  }): Promise<Organization>
  accessForSubject(input: { tenantId: string; subjectId: string }): Promise<{
    organization_ids: string[]
    administrator_organization_ids: string[]
  }>
}
