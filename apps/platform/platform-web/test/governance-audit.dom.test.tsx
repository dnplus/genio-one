import { expect, test } from "bun:test"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import { SheetWorkspaceRoot } from "@/components/ui/sheet"
import type { ApiGatewayActivityEvent, AuditEvent, DecisionAuditEvent, GovernanceAuditEvent, InvocationAccountingRecord, OverviewSnapshot } from "@/domain/contracts"
import { createMockOverview } from "@/mocks/overview"
import { AuditQueryTable } from "@/features/activity/audit-query-table"
import { AuditDecisionSheet } from "@/features/activity/audit-decision-sheet"

const data: Pick<OverviewSnapshot, "applications" | "connections" | "identity" | "resources"> = {
  applications: [], connections: [], identity: null, resources: [],
}
const accessData = {
  applications: [],
  connections: [],
  identity: {
    tenant_id: "audit-test",
    subjects: [{
      subject_id: "person-uat-anrita",
      kind: "PERSON",
      profile: { display_name: "Anrita", email: null, department: null },
      suspended: false,
      suspended_at: null,
      suspended_by: null,
      suspension_reason: null,
    }, {
      subject_id: "person-uat-kevin",
      kind: "PERSON",
      profile: { display_name: "Kevin", email: null, department: null },
      suspended: false,
      suspended_at: null,
      suspended_by: null,
      suspension_reason: null,
    }],
    external_identity_bindings: [],
    tenant_administrators: [],
  },
  resources: [{
    resource_id: "resource-uat-access",
    display_name: "UAT Requestable Access",
    capabilities: [{ capability_id: "capability-access-request", display_name: "Request access" }],
  }],
} as unknown as Pick<OverviewSnapshot, "applications" | "connections" | "identity" | "resources">
const base = {
  tenant_id: "audit-test",
  correlation_id: "audit-query-test",
  outcome: "SUCCESS" as const,
  subject: { subject_id: "test-admin", evidence_level: "VERIFIED" as const },
  actor_subject: { subject_id: "test-admin", evidence_level: "VERIFIED" as const },
  occurred_at: 1_700_000_000,
}
const events: GovernanceAuditEvent[] = [{
  ...base,
  audit_event_id: "policy-event",
  kind: "POLICY_CHANGE",
  policy_key: "one-policy.first-party.bot-default",
  action: "PUBLISHED",
  policy_draft_version: 1,
  base_revision: 1,
  published_revision: 2,
  lifecycle: "REVIEWED",
  content_digest: "a".repeat(64),
}, {
  ...base,
  audit_event_id: "policy-disable-event",
  kind: "POLICY_CHANGE",
  policy_key: "one-policy.first-party.bot-default",
  action: "DISABLED",
  enabled: false,
  policy_draft_version: null,
  base_revision: 2,
  published_revision: 3,
  lifecycle: null,
  content_digest: "b".repeat(64),
}, {
  ...base,
  audit_event_id: "group-event",
  kind: "ACCESS_GROUP_CHANGE",
  access_group_id: "operators",
  operation: "MEMBERS_REPLACED",
  before_revision: 1,
  after_revision: 2,
}]

const accessGovernanceEvent: GovernanceAuditEvent = {
  ...base,
  audit_event_id: "access-governance-event",
  kind: "ACCESS_GOVERNANCE_CHANGE",
  subject: { subject_id: "person-uat-anrita", evidence_level: "VERIFIED" },
  actor_subject: { subject_id: "person-uat-kevin", evidence_level: "VERIFIED" },
  acting_client: { acting_client_id: "client-self-service", evidence_level: "VERIFIED" },
  resource_id: "resource-uat-access",
  capability_id: "capability-access-request",
  access_request_id: "request-uat-anrita",
  entitlement_id: null,
  operation: "APPROVE",
}

const overviewFixture = createMockOverview()
const invocationFixture = overviewFixture.auditEvents.find(
  (event): event is DecisionAuditEvent => event.kind === "INVOCATION_OUTCOME",
)!

const governedInvocationEvent: DecisionAuditEvent = {
  ...invocationFixture,
  audit_event_id: "governed-invocation-event",
  correlation_id: "governed-invocation-correlation",
  outcome: "ALLOW",
  tenant_id: "audit-test",
  subject: { subject_id: "person-uat-anrita", evidence_level: "VERIFIED" },
  actor_subject: { subject_id: "person-uat-kevin", evidence_level: "VERIFIED" },
  acting_client: { acting_client_id: "client-self-service", evidence_level: "VERIFIED" },
  resource_id: "resource-uat-access",
  capability_id: "capability-access-request",
  action: "tools/call",
  session_id: "session-uat-governed",
  routing_policy_rule_id: "allow-uat-access",
  route: "MANAGED",
  decision: {
    decision_id: "decision-uat-governed",
    correlation_id: "governed-invocation-correlation",
    policy_version: "one-policy.usage-uat-r5",
    winning_rule_id: "allow-uat-access",
    reason: "ADMITTED_BY_USAGE_POLICY",
    visibility: "VISIBLE",
    access: "ENTITLED",
    route: "MANAGED",
    obligations: [{ kind: "USAGE_ADMISSION", enforcement_point_id: "AI_GATEWAY", parameters: [["policy", "usage-uat-r5"]] }],
    entitlement_conditions: { required_verified_acting_client_id: "client-self-service", requires_device: false },
    entitlement_id: "entitlement-uat-access",
    auto_grant_valid_for: null,
    input_receipt: { mcp_method: "tools/call", mcp_tool: "request_access" },
  },
  entitlement_id: "entitlement-uat-access",
  enforcement_point_id: "AI_GATEWAY",
  obligation_kind: "USAGE_ADMISSION",
  upstream_attempted: true,
}

const governedExecutionActivity: ApiGatewayActivityEvent = {
  ...overviewFixture.apiActivity.events[0]!,
  correlation_id: governedInvocationEvent.correlation_id,
  tenant_id: "audit-test",
  resource_id: "resource-uat-access",
  capability_id: "capability-access-request",
  application_id: null,
  subject_id: "person-uat-anrita",
  subject_display: { subject_id: "person-uat-anrita", display_name: "Anrita", kind: "PERSON" },
  acting_client_id: "client-self-service",
  entitlement_id: "entitlement-uat-access",
  usage_admission_id: "admission-uat-governed",
  usage_admission_disposition: "ADMIT",
  usage_admission_reason: null,
  consumer_organization_id: "consumer-uat",
  resource_owner_organization_id: "owner-uat",
  use_case_id: "access-request-uat",
  enforcement_point_id: "AI_GATEWAY",
  route: "MANAGED",
  method: "POST",
  path: "/mcp/tools/request-access",
  status_code: 200,
  outcome: "COMPLETED",
  error_code: null,
  upstream_attempted: true,
}

const governedAccounting: InvocationAccountingRecord = {
  invocation: {
    invocation_id: "invocation-uat-governed",
    correlation_id: governedInvocationEvent.correlation_id,
    tenant_id: "audit-test",
    subject_id: "person-uat-anrita",
    consumer_organization_id: "consumer-uat",
    resource_owner_organization_id: "owner-uat",
    resource_id: "resource-uat-access",
    capability_id: "capability-access-request",
    use_case_id: "access-request-uat",
    usage_policy_revisions: ["usage-uat-r5"],
    release_revision: "release-uat-r3",
    accounting_key_id: "accounting-key-uat",
    created_at: 1_700_000_001,
  },
  quantities: [{
    quantity_id: "quantity-uat-tool-call",
    invocation_id: "invocation-uat-governed",
    quantity: 1,
    unit: "TOOL_CALL",
    trusted_source: "GATEWAY_RECEIPT",
    observed_at: 1_700_000_002,
  }],
  charge: {
    charge_id: "charge-uat-governed",
    invocation_id: "invocation-uat-governed",
    correlation_id: governedInvocationEvent.correlation_id,
    accounting_key_id: "accounting-key-uat",
    created_at: 1_700_000_003,
  },
  valuations: [{
    valuation_id: "valuation-uat-governed",
    charge_id: "charge-uat-governed",
    status: "ACTUAL",
    currency: "USD",
    amount_micros: 125_000,
    pricing_source: "fixture-catalog",
    pricing_version: "2026-09",
    valued_at: 1_700_000_004,
  }],
}

function AuditJourney({
  event,
  snapshot = data,
  accounting = null,
  executionActivity = null,
}: {
  event: AuditEvent
  snapshot?: Pick<OverviewSnapshot, "applications" | "connections" | "identity" | "resources">
  accounting?: InvocationAccountingRecord | null
  executionActivity?: ApiGatewayActivityEvent | null
}) {
  const [selected, setSelected] = useState<AuditEvent | null>(null)
  return <SheetWorkspaceRoot>
    <AuditQueryTable events={[event]} onOpen={setSelected} />
    <AuditDecisionSheet event={selected} data={snapshot} open={selected !== null} onOpenChange={(open) => { if (!open) setSelected(null) }} accounting={accounting} accessRequest={null} executionActivity={executionActivity} />
  </SheetWorkspaceRoot>
}

for (const event of events) {
  test(`${event.kind} can open from audit query without fabricated acting-client evidence`, async () => {
    const user = userEvent.setup()
    const i18n = createInstance()
    await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
    render(<I18nextProvider i18n={i18n}><AuditJourney event={event} /></I18nextProvider>)

    await user.click(screen.getByRole("row", { name: "View details" }))
    const sheet = await screen.findByTestId("governance-audit-sheet")
    expect(within(sheet).getAllByText("test-admin")).toHaveLength(2)
    expect(within(sheet).getByText(event.correlation_id)).toBeTruthy()
    if (event.kind === "POLICY_CHANGE") expect(within(sheet).getByText(event.content_digest)).toBeTruthy()
    if (event.kind === "ACCESS_GROUP_CHANGE") expect(within(sheet).getByText(event.access_group_id)).toBeTruthy()
    expect(within(sheet).queryByText("Acting Client evidence")).toBeNull()
    if (event.kind === "POLICY_CHANGE" && event.enabled !== undefined) {
      expect(within(sheet).getByText("Policy state")).toBeTruthy()
      expect(within(sheet).getAllByText("DISABLED").length).toBeGreaterThan(0)
    }
    await user.click(within(sheet).getByRole("button", { name: "Close" }))
    await waitFor(() => expect(screen.queryByTestId("governance-audit-sheet")).toBeNull())
  })
}

test("ACCESS_GOVERNANCE_CHANGE keeps the access subject, actor, resource, capability, operation, and correlation visible", async () => {
  const user = userEvent.setup()
  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
  render(<I18nextProvider i18n={i18n}><AuditJourney event={accessGovernanceEvent} snapshot={accessData} /></I18nextProvider>)

  const row = screen.getByRole("row", { name: "View details" })
  expect(within(row).getByText("person-uat-anrita")).toBeTruthy()
  expect(within(row).getByText("person-uat-kevin")).toBeTruthy()
  expect(within(row).getByText("resource-uat-access")).toBeTruthy()
  expect(within(row).getByText("capability-access-request")).toBeTruthy()
  expect(within(row).getByText("APPROVE")).toBeTruthy()
  expect(within(row).getByText("SUCCESS")).toBeTruthy()
  expect(within(row).getByText("audit-query-test")).toBeTruthy()

  await user.click(row)
  const sheet = await screen.findByTestId("governance-audit-sheet")
  expect(within(sheet).getByText("Anrita")).toBeTruthy()
  expect(within(sheet).getByText("Kevin")).toBeTruthy()
  expect(within(sheet).getByText("UAT Requestable Access · resource-uat-access")).toBeTruthy()
  expect(within(sheet).getByText("Request access · capability-access-request")).toBeTruthy()
  expect(within(sheet).getByText("client-self-service")).toBeTruthy()
  expect(within(sheet).getByText("request-uat-anrita")).toBeTruthy()
})

test("ACCESS_GOVERNANCE_CHANGE opens when the client identifier is absent", async () => {
  const user = userEvent.setup()
  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
  const event = {
    ...accessGovernanceEvent,
    acting_client: { ...accessGovernanceEvent.acting_client, acting_client_id: null },
  } as unknown as GovernanceAuditEvent
  render(<I18nextProvider i18n={i18n}><AuditJourney event={event} snapshot={accessData} /></I18nextProvider>)

  await user.click(screen.getByRole("row", { name: "View details" }))
  const sheet = await screen.findByTestId("governance-audit-sheet")
  const client = within(sheet).getByText("Client")
  expect(client.parentElement?.textContent).toContain("—")
})

test("INVOCATION_OUTCOME detail resolves governed labels with execution and canonical usage evidence", async () => {
  const user = userEvent.setup()
  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
  render(
    <I18nextProvider i18n={i18n}>
      <AuditJourney
        event={governedInvocationEvent}
        snapshot={accessData}
        executionActivity={governedExecutionActivity}
        accounting={governedAccounting}
      />
    </I18nextProvider>,
  )

  await user.click(screen.getByRole("row", { name: "View details" }))
  const sheet = await screen.findByRole("dialog")
  expect(within(sheet).getByText("Anrita")).toBeTruthy()
  expect(within(sheet).getByText("Client Self Service")).toBeTruthy()
  expect(within(sheet).getByText("UAT Requestable Access")).toBeTruthy()
  expect(within(sheet).getByText("Request access")).toBeTruthy()
  expect(within(sheet).getByText("VISIBLE")).toBeTruthy()
  expect(within(sheet).getByText("ENTITLED")).toBeTruthy()
  expect(within(sheet).getAllByText("MANAGED").length).toBeGreaterThan(0)

  const execution = within(sheet).getByTestId("correlated-execution-outcome")
  expect(execution.textContent).toContain("POST /mcp/tools/request-access")
  expect(execution.textContent).toContain("Usage admission")
  expect(execution.textContent).toContain("ADMIT")
  expect(execution.textContent).toContain("admission-uat-governed")

  const usage = within(sheet).getByTestId("mcp-usage-facts")
  expect(usage.textContent).toContain("consumer-uat")
  expect(usage.textContent).toContain("usage-uat-r5")
  expect(usage.textContent).toContain("accounting-key-uat")
  expect(usage.textContent).toContain("charge-uat-governed")
  expect(usage.textContent).toContain("TOOL_CALL: 1")
  expect(usage.textContent).toContain("GATEWAY_RECEIPT")
  expect(usage.textContent).toContain("ACTUAL USD 0.125000")
  expect(usage.textContent).toContain("fixture-catalog@2026-09")
})
