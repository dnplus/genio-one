import { expect, test } from "bun:test"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import { SheetWorkspaceRoot } from "@/components/ui/sheet"
import type { AuditEvent, GovernanceAuditEvent, OverviewSnapshot } from "@/domain/contracts"
import { AuditQueryTable } from "@/features/activity/audit-query-table"
import { AuditDecisionSheet } from "@/features/activity/audit-decision-sheet"

const data: Pick<OverviewSnapshot, "applications" | "connections" | "identity" | "resources"> = {
  applications: [], connections: [], identity: null, resources: [],
}
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

function AuditJourney({ event }: { event: GovernanceAuditEvent }) {
  const [selected, setSelected] = useState<AuditEvent | null>(null)
  return <SheetWorkspaceRoot>
    <AuditQueryTable events={[event]} onOpen={setSelected} />
    <AuditDecisionSheet event={selected} data={data} open={selected !== null} onOpenChange={(open) => { if (!open) setSelected(null) }} accounting={null} accessRequest={null} executionActivity={null} />
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
    expect(within(sheet).getByText("test-admin")).toBeTruthy()
    expect(within(sheet).getByText(event.correlation_id)).toBeTruthy()
    expect(within(sheet).getByText(event.kind === "POLICY_CHANGE" ? event.content_digest : event.access_group_id)).toBeTruthy()
    expect(within(sheet).queryByText("Acting Client evidence")).toBeNull()
    if (event.kind === "POLICY_CHANGE" && event.enabled !== undefined) {
      expect(within(sheet).getByText("Policy state")).toBeTruthy()
      expect(within(sheet).getAllByText("DISABLED").length).toBeGreaterThan(0)
    }
    await user.click(within(sheet).getByRole("button", { name: "Close" }))
    await waitFor(() => expect(screen.queryByTestId("governance-audit-sheet")).toBeNull())
  })
}
