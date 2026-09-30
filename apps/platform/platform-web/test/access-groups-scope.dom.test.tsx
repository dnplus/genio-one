import { afterEach, expect, test } from "bun:test"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import { SheetWorkspaceRoot } from "@/components/ui/sheet"
import type { IdentitySession, OverviewSnapshot } from "@/domain/contracts"
import { AccessGroupsPanel } from "@/features/identity/access-groups-panel"

afterEach(cleanup)

const organizations = [
  { tenant_id: "tenant-acme", organization_id: "org-sales", display_name: "Sales", slug: "sales", member_subject_ids: ["person-uat-kevin"], organization_administrator_subject_ids: [], membership_sources: [{ kind: "MANUAL" as const, reference: "console", status: "SYNCED" as const }], created_at: 1 },
  { tenant_id: "tenant-acme", organization_id: "org-uat-access", display_name: "UAT Access", slug: "uat-access", member_subject_ids: ["person-uat-kevin"], organization_administrator_subject_ids: ["person-uat-kevin"], membership_sources: [{ kind: "MANUAL" as const, reference: "console", status: "SYNCED" as const }], created_at: 1 },
]

function accessGroup(accessGroupId: string, displayName: string, organizationId: string) {
  return {
    tenant_id: "tenant-acme",
    organization_id: organizationId,
    access_group_id: accessGroupId,
    display_name: displayName,
    description: "Scoped group",
    enabled: true,
    revision: 1,
    membership_sources: [{ source_id: "manual" as const, kind: "MANUAL" as const, revision: 1, subject_ids: [], created_at: 1, created_by: "person-uat-kevin", updated_at: 1, updated_by: "person-uat-kevin" }],
    created_at: 1,
    created_by: "person-uat-kevin",
    updated_at: 1,
    updated_by: "person-uat-kevin",
  }
}

const salesGroup = accessGroup("sales-group", "Sales group", "org-sales")
const uatAccessGroup = accessGroup("uat-access-group", "UAT Access group", "org-uat-access")

function snapshot(groups: ReturnType<typeof accessGroup>[]) {
  return {
    organizations,
    identity: {
      tenant_id: "tenant-acme",
      subjects: [],
      external_identity_bindings: [],
      tenant_administrators: [],
    },
    accessGroups: {
      tenant_id: "tenant-acme",
      groups,
      memberships: [],
    },
  } as OverviewSnapshot
}

async function renderPanel(identity: IdentitySession, groups: ReturnType<typeof accessGroup>[]) {
  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
  render(<I18nextProvider i18n={i18n}><SheetWorkspaceRoot><AccessGroupsPanel tenantId="tenant-acme" data={snapshot(groups)} identity={identity} canManage onChanged={async () => {}} /></SheetWorkspaceRoot></I18nextProvider>)
}

test("Kevin's Access Group list only includes UAT Access", async () => {
  const user = userEvent.setup()
  const kevinIdentity: IdentitySession = {
    tenant_id: "tenant-acme",
    subject_id: "person-uat-kevin",
    acting_client_id: "management-ui",
    role: "ORGANIZATION_ADMINISTRATOR",
    organization_ids: ["org-sales", "org-uat-access"],
    administrator_organization_ids: ["org-uat-access"],
    scopes: ["genioone-management"],
    acr: "oidc",
    amr: ["oidc"],
  }

  await renderPanel(kevinIdentity, [uatAccessGroup])

  expect(screen.queryByRole("row", { name: /Sales group/ })).toBeNull()
  expect(within(screen.getByRole("row", { name: /UAT Access group.*UAT Access/ })).getByRole("button", { name: "Edit" })).toBeTruthy()

  await user.click(screen.getByRole("button", { name: "Create Access Group" }))
  await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy())
  await user.click(screen.getByRole("combobox"))
  await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy())

  expect(screen.queryByRole("option", { name: "Sales" })).toBeNull()
  expect(screen.getByRole("option", { name: "UAT Access" })).toBeTruthy()
  expect(screen.queryByRole("option", { name: "Global" })).toBeNull()
})

test("Tenant Administrator can manage every organization-owned Access Group", async () => {
  const user = userEvent.setup()
  const tenantAdministrator: IdentitySession = {
    tenant_id: "tenant-acme",
    subject_id: "tenant-admin",
    acting_client_id: "management-ui",
    role: "TENANT_ADMINISTRATOR",
    organization_ids: [],
    administrator_organization_ids: [],
    scopes: ["genioone-management"],
    acr: "oidc",
    amr: ["oidc"],
  }

  await renderPanel(tenantAdministrator, [salesGroup, uatAccessGroup])

  expect(within(screen.getByRole("row", { name: /Sales group.*Sales/ })).getByRole("button", { name: "Edit" })).toBeTruthy()
  expect(within(screen.getByRole("row", { name: /UAT Access group.*UAT Access/ })).getByRole("button", { name: "Edit" })).toBeTruthy()

  await user.click(screen.getByRole("button", { name: "Create Access Group" }))
  await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy())
  await user.click(screen.getByRole("combobox"))
  await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy())

  expect(screen.getByRole("option", { name: "Global" })).toBeTruthy()
  expect(screen.getByRole("option", { name: "Sales" })).toBeTruthy()
  expect(screen.getByRole("option", { name: "UAT Access" })).toBeTruthy()
})
