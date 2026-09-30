import { expect, test } from "bun:test"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import { SheetWorkspaceRoot } from "@/components/ui/sheet"
import type { IdentitySession, OverviewFailure } from "@/domain/contracts"
import { AccessPage } from "@/features/access/access-page"
import { createMockOverview } from "@/mocks/overview"

const tenantAdministrator: IdentitySession = {
  tenant_id: "tenant-design-preview",
  subject_id: "tenant-admin",
  acting_client_id: "management-ui",
  role: "TENANT_ADMINISTRATOR",
  scopes: ["genioone-management"],
  acr: "oidc",
  amr: ["oidc"],
}

const organizationAdministrator: IdentitySession = {
  ...tenantAdministrator,
  role: "ORGANIZATION_ADMINISTRATOR",
  organization_ids: ["ai-platform"],
}

async function renderAccessPage(identity: IdentitySession, failures: OverviewFailure[] = []) {
  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
  const data = createMockOverview()
  data.failures = failures
  render(
    <I18nextProvider i18n={i18n}>
      <SheetWorkspaceRoot>
        <AccessPage tenantId={identity.tenant_id} actorIdentity={identity} data={data} onRefresh={async () => {}} />
      </SheetWorkspaceRoot>
    </I18nextProvider>,
  )
}

test("Organization Administrator keeps the Access workspace without Tenant grant controls", async () => {
  await renderAccessPage(organizationAdministrator)

  expect(screen.getByText("Request inventory")).toBeTruthy()
  expect(screen.queryByRole("button", { name: "Grant Entitlement" })).toBeNull()
})

test("Tenant Administrator sees the Grant Entitlement control", async () => {
  await renderAccessPage(tenantAdministrator)

  expect(screen.getByRole("button", { name: "Grant Entitlement" })).toBeTruthy()
})

test("Access keeps approved Request history separate from the active Entitlement and opens its readback", async () => {
  const user = userEvent.setup()
  const data = createMockOverview()
  const resource = data.resources.find((candidate) => candidate.resource_id === "corporate-gpt")!
  const capability = resource.capabilities[0]!
  const request = {
    access_request_id: "request-ai-user-model",
    request_correlation_id: "request-correlation-ai-user-model",
    decision_correlation_id: "decision-correlation-ai-user-model",
    requester: "ai-owner",
    target_subject: "ai-user",
    acting_client: { acting_client_id: null, evidence_level: "VERIFIED" as const },
    resource_id: resource.resource_id,
    capability_id: capability.capability_id,
    justification: "Prepare the quarterly planning analysis.",
    requested_valid_for: 7_200,
    configuration_revision: "resource-revision-8",
    approval_workflow_version: "workflow-3",
    approver: "ai-platform",
    state: "APPROVED" as const,
    created_at: 1_700_000_000,
    expires_at: 1_700_086_400,
    resolved_at: 1_700_000_100,
    resolution_reason: null,
    policy_version_at_creation: "policy-12",
    approval_stages: [{
      stage_id: "owner-approval",
      approver: { kind: "ORGANIZATION" as const, organization_id: "ai-platform" },
      primary_approver: "ai-owner",
      assigned_approver: "ai-owner",
      state: "APPROVED" as const,
      decided_by: { subject_id: "ai-owner", evidence_level: "VERIFIED" as const },
      decided_at: 1_700_000_100,
    }],
    current_approval_stage: 0,
  }
  data.accessRequests = [request]
  data.ownedEntitlements = [{
    entitlement_id: "entitlement-ai-user-model",
    subject_id: request.target_subject,
    resource_id: request.resource_id,
    capability_id: request.capability_id,
    state: "ACTIVE",
    valid_from: 1_700_000_100,
    valid_until: 1_700_604_900,
    revocation_reason: null,
  }]

  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
  render(
    <I18nextProvider i18n={i18n}>
      <SheetWorkspaceRoot>
        <AccessPage tenantId={tenantAdministrator.tenant_id} actorIdentity={tenantAdministrator} data={data} onRefresh={async () => {}} />
      </SheetWorkspaceRoot>
    </I18nextProvider>,
  )

  const entitlements = screen.getByTestId("access-entitlements")
  const entitlementRow = within(entitlements).getByTestId("entitlement-row-entitlement-ai-user-model")
  expect(within(entitlementRow).getByTestId("entitlement-state-entitlement-ai-user-model").textContent).toBe("ACTIVE")
  expect(within(entitlementRow).getByRole("button", { name: "APPROVED" })).toBeTruthy()

  const requests = screen.getByTestId("access-requests")
  const requestRow = within(requests).getByTestId("access-request-row-request-ai-user-model")
  expect(within(requestRow).getByText("APPROVED")).toBeTruthy()
  expect(within(requestRow).getByText("AI Analyst")).toBeTruthy()

  await user.click(requestRow)

  await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy())
  const detail = screen.getByRole("dialog")
  expect(within(detail).getByText("Access Request details")).toBeTruthy()
  expect(within(detail).getByText("request-ai-user-model")).toBeTruthy()
  expect(within(detail).getAllByText("APPROVED")).toHaveLength(2)
  expect(within(detail).getByText("Prepare the quarterly planning analysis.")).toBeTruthy()
  expect(within(detail).getByText("resource-revision-8")).toBeTruthy()
})

test("Access request authorization failures are not rendered as an empty request list", async () => {
  await renderAccessPage(tenantAdministrator, [{ source: "Access requests", code: "ACCESS_MANAGEMENT_REQUIRED", status: 403 }])

  expect(screen.getByText("Access management data is unavailable")).toBeTruthy()
  expect(screen.getByText("The Access request inventory could not be loaded. Refresh to try again.")).toBeTruthy()
  expect(screen.queryByText("No Access Requests")).toBeNull()
})

test("Identity failures are not rendered as empty Access management data", async () => {
  await renderAccessPage(tenantAdministrator, [{ source: "Identity", code: "IDENTITY_DIRECTORY_UNAVAILABLE", status: 503 }])

  expect(screen.getByText("Access management data is unavailable")).toBeTruthy()
  expect(screen.getByText("The canonical identity directory could not be loaded. Refresh to try again.")).toBeTruthy()
  expect(screen.queryByText("No Entitlements")).toBeNull()
})

for (const { source, description, emptyState } of [
  {
    source: "Owned Entitlements",
    description: "The entitlement inventory could not be loaded. Refresh to try again.",
    emptyState: "No Entitlements",
  },
  {
    source: "Access notifications",
    description: "The Access notification inventory could not be loaded. Refresh to try again.",
    emptyState: "No access updates require your attention.",
  },
]) {
  test(`${source} failures are not rendered as empty Access management data`, async () => {
    await renderAccessPage(organizationAdministrator, [{ source, code: "ACCESS_MANAGEMENT_UNAVAILABLE", status: 503 }])

    expect(screen.getByText("Access management data is unavailable")).toBeTruthy()
    expect(screen.getByText(description)).toBeTruthy()
    expect(screen.queryByText(emptyState)).toBeNull()
  })
}
