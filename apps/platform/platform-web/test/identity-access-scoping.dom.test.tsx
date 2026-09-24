import { expect, test } from "bun:test"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import { SheetWorkspaceRoot } from "@/components/ui/sheet"
import type { IdentitySession, OverviewSnapshot } from "@/domain/contracts"
import { AccessGroupsPanel } from "@/features/identity/access-groups-panel"
import { OrganizationPage } from "@/features/identity/organization-page"

const organizationIdentity: IdentitySession = {
  tenant_id: "tenant-acme",
  subject_id: "org-admin",
  acting_client_id: "management-ui",
  role: "ORGANIZATION_ADMINISTRATOR",
  organization_ids: ["org-ai"],
  scopes: ["genioone-management"],
  acr: "oidc",
  amr: ["oidc"],
}

const identityInventory = {
  tenant_id: "tenant-acme",
  subjects: [
    { subject_id: "org-admin", kind: "PERSON" as const, profile: { display_name: "Fiona", email: "fiona@example.test", department: null }, suspended: false, suspended_at: null, suspended_by: null, suspension_reason: null },
    { subject_id: "org-user", kind: "PERSON" as const, profile: { display_name: "Sophie", email: "sophie@example.test", department: null }, suspended: false, suspended_at: null, suspended_by: null, suspension_reason: null },
    { subject_id: "other-user", kind: "PERSON" as const, profile: { display_name: "Other User", email: "other@example.test", department: null }, suspended: false, suspended_at: null, suspended_by: null, suspension_reason: null },
  ],
  external_identity_bindings: [],
  tenant_administrators: [],
}

const organizations = [
  { tenant_id: "tenant-acme", organization_id: "org-ai", display_name: "AI Platform", slug: "ai-platform", member_subject_ids: ["org-admin", "org-user"], organization_administrator_subject_ids: ["org-admin"], membership_sources: [{ kind: "MANUAL" as const, reference: "console", status: "SYNCED" as const }], created_at: 1 },
  { tenant_id: "tenant-acme", organization_id: "org-other", display_name: "Security", slug: "security", member_subject_ids: ["other-user"], organization_administrator_subject_ids: [], membership_sources: [{ kind: "MANUAL" as const, reference: "console", status: "SYNCED" as const }], created_at: 1 },
]

function accessGroup(organizationId: string | null) {
  return {
    tenant_id: "tenant-acme",
    organization_id: organizationId,
    access_group_id: "engineering",
    display_name: "Engineering",
    description: "Scoped group",
    enabled: true,
    revision: 1,
    membership_sources: [{ source_id: "manual" as const, kind: "MANUAL" as const, revision: 1, subject_ids: [], created_at: 1, created_by: "org-admin", updated_at: 1, updated_by: "org-admin" }],
    created_at: 1,
    created_by: "org-admin",
    updated_at: 1,
    updated_by: "org-admin",
  }
}

function data(group = accessGroup("org-ai")) {
  return {
    identity: identityInventory,
    organizations,
    accessGroups: { tenant_id: "tenant-acme", groups: [group], memberships: [] },
  } as OverviewSnapshot
}

async function withI18n(ui: React.ReactNode) {
  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
  render(<I18nextProvider i18n={i18n}><SheetWorkspaceRoot>{ui}</SheetWorkspaceRoot></I18nextProvider>)
}

test("Organization Administrator sees Manage only for organizations in canonical scope", async () => {
  await withI18n(<OrganizationPage tenantId="tenant-acme" identity={organizationIdentity} data={{ ...data(), auditEvents: [], failures: [] } as OverviewSnapshot} onReload={async () => {}} />)

  expect(screen.getAllByRole("button", { name: "Manage" })).toHaveLength(1)
  expect(screen.queryByRole("button", { name: "Create Organization" })).toBeNull()
  expect(screen.queryByText("Administrators")).toBeNull()
  expect(screen.getByText("AI Platform")).toBeTruthy()
  expect(screen.getByText("Security")).toBeTruthy()
})

test("Organization-owned Access Group editor limits members and owner choices to canonical scope", async () => {
  const user = userEvent.setup()
  await withI18n(<AccessGroupsPanel tenantId="tenant-acme" data={data()} identity={organizationIdentity} canManage onChanged={async () => {}} />)

  expect(screen.getByText("AI Platform")).toBeTruthy()
  expect(screen.queryByText("Global")).toBeNull()
  await user.click(screen.getByRole("button", { name: "Edit" }))
  await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy())

  await user.click(screen.getByRole("combobox", { name: "Search people" }))
  await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy())
  expect(screen.getByRole("option", { name: /Sophie/ })).toBeTruthy()
  expect(screen.queryByRole("option", { name: /Other User/ })).toBeNull()
})
