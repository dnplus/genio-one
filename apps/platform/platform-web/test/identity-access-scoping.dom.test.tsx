import { expect, test } from "bun:test"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import { SheetWorkspaceRoot } from "@/components/ui/sheet"
import type { IdentitySession, OverviewSnapshot } from "@/domain/contracts"
import { AccessGroupsPanel } from "@/features/identity/access-groups-panel"
import { OrganizationPage } from "@/features/identity/organization-page"
import { CreateOrganizationSheet } from "@/features/identity/create-organization-sheet"
import { ResourceCatalogPage } from "@/features/resources/resource-catalog-page"
import productI18n from "@/i18n"

const organizationIdentity: IdentitySession = {
  tenant_id: "tenant-acme",
  subject_id: "org-admin",
  acting_client_id: "management-ui",
  role: "ORGANIZATION_ADMINISTRATOR",
  organization_ids: ["org-ai"],
  administrator_organization_ids: ["org-ai"],
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

async function withI18n(ui: React.ReactNode, language = "en") {
  const i18n = createInstance()
  await i18n.init({ lng: language, fallbackLng: "en", keySeparator: false, resources: productI18n.options.resources })
  render(<I18nextProvider i18n={i18n}><SheetWorkspaceRoot>{ui}</SheetWorkspaceRoot></I18nextProvider>)
  return i18n
}

test("Kevin can manage only UAT Access even though Sales membership remains visible", async () => {
  const kevinIdentity: IdentitySession = {
    ...organizationIdentity,
    subject_id: "person-uat-kevin",
    organization_ids: ["org-sales", "org-uat-access"],
    administrator_organization_ids: ["org-uat-access"],
  }
  const kevinOrganizations = [
    { tenant_id: "tenant-acme", organization_id: "org-sales", display_name: "Sales", slug: "sales", member_subject_ids: ["person-uat-kevin"], organization_administrator_subject_ids: [], membership_sources: [{ kind: "MANUAL" as const, reference: "console", status: "SYNCED" as const }], created_at: 1 },
    { tenant_id: "tenant-acme", organization_id: "org-uat-access", display_name: "UAT Access", slug: "uat-access", member_subject_ids: ["person-uat-kevin"], organization_administrator_subject_ids: ["person-uat-kevin"], membership_sources: [{ kind: "MANUAL" as const, reference: "console", status: "SYNCED" as const }], created_at: 1 },
  ]

  await withI18n(<OrganizationPage tenantId="tenant-acme" identity={kevinIdentity} data={{ ...data(), organizations: kevinOrganizations, auditEvents: [], failures: [] } as OverviewSnapshot} onReload={async () => {}} />)

  expect(within(screen.getByRole("row", { name: /Sales/ })).queryByRole("button", { name: "Manage" })).toBeNull()
  expect(within(screen.getByRole("row", { name: /UAT Access/ })).getByRole("button", { name: "Manage" })).toBeTruthy()
  expect(screen.getByText("Sales")).toBeTruthy()
  expect(screen.getByText("UAT Access")).toBeTruthy()
})

for (const locale of [
  { language: "en", membershipLabel: "Toggle membership for Fiona", roleLabel: "Select role for Fiona" },
  { language: "zh-TW", membershipLabel: "切換 Fiona 的成員資格", roleLabel: "選擇 Fiona 的角色" },
]) {
  test("Tenant Administrator can manage every visible organization in " + locale.language, async () => {
    const user = userEvent.setup()
    const tenantAdministrator: IdentitySession = {
      ...organizationIdentity,
      subject_id: "tenant-admin",
      role: "TENANT_ADMINISTRATOR",
      organization_ids: [],
      administrator_organization_ids: [],
    }

    const i18n = await withI18n(<OrganizationPage tenantId="tenant-acme" identity={tenantAdministrator} data={{ ...data(), auditEvents: [], failures: [] } as OverviewSnapshot} onReload={async () => {}} />, locale.language)

    expect(within(screen.getByRole("row", { name: /AI Platform/ })).getByRole("button", { name: i18n.t("Manage") })).toBeTruthy()
    expect(within(screen.getByRole("row", { name: /Security/ })).getByRole("button", { name: i18n.t("Manage") })).toBeTruthy()
    expect(screen.getByRole("button", { name: i18n.t("Create Organization") })).toBeTruthy()
    expect(screen.getByText(i18n.t("Administrators"))).toBeTruthy()

    await user.click(within(screen.getByRole("row", { name: /AI Platform/ })).getByRole("button", { name: i18n.t("Manage") }))
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy())
    expect(screen.getByRole("checkbox", { name: locale.membershipLabel })).toBeTruthy()
    expect(screen.getByRole("combobox", { name: locale.roleLabel })).toBeTruthy()
  })

  test("Create Organization identifies each member in " + locale.language, async () => {
    const user = userEvent.setup()
    const i18n = await withI18n(<CreateOrganizationSheet tenantId="tenant-acme" identity={identityInventory} onCreated={async () => {}} />, locale.language)

    await user.click(screen.getByRole("button", { name: i18n.t("Create Organization") }))
    expect(await screen.findByRole("checkbox", { name: locale.membershipLabel })).toBeTruthy()
  })
}

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

test("Resource deep links outside an Organization Administrator's inventory show a generic unavailable state", async () => {
  const user = userEvent.setup()
  const inaccessibleResourceId = "resource-c5a8149e-a059-4018-97b2-b0b6499a1b76"
  window.history.replaceState({}, "", `/management?view=resources&resource=${inaccessibleResourceId}`)
  const snapshot = {
    ...data(),
    resources: [{
      tenant_id: "tenant-acme",
      resource_id: "resource-sales",
      display_name: "Sales Resource",
      kind: "MCP" as const,
      owner_organization_id: "org-ai",
      authentication_strategy: "NONE" as const,
      environment_id: "environment-production",
      version: "1.0.0",
      lifecycle: "PUBLISHED" as const,
      operational_state: "HEALTHY" as const,
      capabilities: [],
      enforcement_point_id: "gateway-sales",
      created_at: 1,
    }],
    connections: [],
    ownedEntitlements: [],
    auditEvents: [],
    activity: { recent_activity: [] },
    apiActivity: { events: [] },
  } as OverviewSnapshot

  await withI18n(<ResourceCatalogPage tenantId="tenant-acme" identity={organizationIdentity} data={snapshot} initialResourceId={inaccessibleResourceId} search="" onRefresh={async () => {}} />)

  expect(screen.getByText("Resource unavailable")).toBeTruthy()
  expect(screen.getByText("This Resource may have been removed or is outside your current scope.")).toBeTruthy()
  expect(screen.queryByText(inaccessibleResourceId)).toBeNull()
  expect(screen.queryByText("Security")).toBeNull()

  await user.click(screen.getByRole("button", { name: "Back to Resources" }))

  await waitFor(() => expect(screen.getByText("Sales Resource")).toBeTruthy())
  expect(new URL(window.location.href).searchParams.get("resource")).toBeNull()
})

test("Unknown Resource deep links use the same generic unavailable state", async () => {
  const unknownResourceId = "resource-unknown"
  window.history.replaceState({}, "", `/management?view=resources&resource=${unknownResourceId}`)
  const snapshot = {
    ...data(),
    resources: [],
    connections: [],
    ownedEntitlements: [],
    auditEvents: [],
    activity: { recent_activity: [] },
    apiActivity: { events: [] },
  } as OverviewSnapshot

  await withI18n(<ResourceCatalogPage tenantId="tenant-acme" identity={organizationIdentity} data={snapshot} initialResourceId={unknownResourceId} search="" onRefresh={async () => {}} />)

  expect(screen.getByText("Resource unavailable")).toBeTruthy()
  expect(screen.getByText("This Resource may have been removed or is outside your current scope.")).toBeTruthy()
  expect(screen.queryByText(unknownResourceId)).toBeNull()
})
