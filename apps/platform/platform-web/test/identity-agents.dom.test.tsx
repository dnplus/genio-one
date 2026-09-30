import { expect, test } from "bun:test"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import type { EndpointActivityEvent } from "@/domain/contracts"
import { IdentityPage } from "@/features/identity/identity-page"
import { createMockOverview } from "@/mocks/overview"

function agentSnapshot() {
  const data = createMockOverview()
  const resource = data.resources[0]!
  const activity = (
    activityId: string,
    client: EndpointActivityEvent["client"],
    requestCount: number,
    observedAt: number,
  ): EndpointActivityEvent => ({
    activity_id: activityId,
    correlation_id: `${activityId}-correlation`,
    kind: "USAGE",
    subject_id: "person-1",
    device_id: "endpoint-1",
    destination_host: "agent-inventory.example.test",
    resource_id: resource.resource_id,
    resource_class: "KNOWN",
    client,
    client_compliance: { state: "COMPLIANT", issues: [] },
    route: "MANAGED",
    request_count: requestCount,
    observed_at: observedAt,
  })

  data.identity = {
    tenant_id: "tenant-acme",
    subjects: [{
      subject_id: "agent-registered",
      kind: "AGENT",
      profile: { display_name: "Registered Agent", email: null, department: null },
      suspended: false,
      suspended_at: null,
      suspended_by: null,
      suspension_reason: null,
    }],
    external_identity_bindings: [],
    tenant_administrators: [],
  }
  data.activity = {
    resources: [],
    recent_activity: [
      activity("activity-registered", { status: "VERIFIED", acting_client_id: "agent-registered" }, 3, 1_700_000_000),
      activity("activity-observed", { status: "VERIFIED", acting_client_id: "observed-runtime-client" }, 2, 1_700_000_100),
      activity("activity-unknown", { status: "UNKNOWN" }, 1, 1_700_000_200),
    ],
  }
  return data
}

async function renderAgents() {
  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
  render(
    <I18nextProvider i18n={i18n}>
      <IdentityPage tenantId="tenant-acme" identity={null} data={agentSnapshot()} mode="agents" onRefresh={async () => {}} />
    </I18nextProvider>,
  )
}

test("Agent inventory shows registered, observed, and unknown clients in their own classifications", async () => {
  const user = userEvent.setup()
  await renderAgents()

  const registeredRow = screen.getByRole("row", { name: /Registered Agent/ })
  expect(within(registeredRow).getAllByText("REGISTERED").length).toBeGreaterThan(0)
  expect(within(registeredRow).getByText("VERIFIED")).toBeTruthy()
  expect(screen.getByRole("row", { name: /observed-runtime-client/ })).toBeTruthy()
  expect(screen.getByRole("row", { name: /Unknown/ })).toBeTruthy()

  await user.click(screen.getByRole("tab", { name: /OBSERVED/ }))
  await waitFor(() => {
    expect(screen.getByRole("row", { name: /observed-runtime-client/ })).toBeTruthy()
    expect(screen.queryByText("Registered Agent")).toBeNull()
    expect(screen.queryByText("Unknown")).toBeNull()
  })

  await user.click(screen.getByRole("tab", { name: /UNKNOWN/ }))
  await waitFor(() => {
    expect(screen.getByRole("row", { name: /Unknown/ })).toBeTruthy()
    expect(screen.queryByText("observed-runtime-client")).toBeNull()
  })
})
