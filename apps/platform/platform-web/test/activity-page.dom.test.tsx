import { expect, test } from "bun:test"
import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import type { DecisionAuditEvent, OverviewSnapshot } from "@/domain/contracts"
import { ActivityPage } from "@/features/activity/activity-page"
import { createMockOverview } from "@/mocks/overview"

const runtimeEvent: DecisionAuditEvent = {
  audit_event_id: "runtime-report",
  correlation_id: "runtime-correlation",
  kind: "RUNTIME_POLICY_DECISION",
  outcome: "ALLOW",
  phase: "REPORT",
  reason_code: "RULE_ALLOW:runtime",
  report_outcome: "FAILED",
  authorization_audit_event_id: "runtime-authorization",
  tenant_id: "tenant-design-preview",
  subject: { subject_id: "agent-operations", evidence_level: "VERIFIED" },
  target_subject_id: null,
  actor_subject: { subject_id: "platform-admin", evidence_level: "VERIFIED" },
  acting_client: { acting_client_id: "genio-bot", evidence_level: "VERIFIED" },
  resource_id: null,
  capability_id: "computer_use",
  policy_id: "one-policy.runtime.capabilities",
  policy_display_name: "Agent Runtime policy",
  policy_revision: 7,
  runtime_id: "runtime-codex",
  bot_id: "genio-bot",
  target: "runtime:runtime-codex:computer_use",
  action: "invoke",
  session_id: "runtime-session",
  constraints: [],
  obligations: [],
  matched_policy_refs: [],
  device_id: null,
  endpoint_version: null,
  desired_state_revision: null,
  applied_state_revision: null,
  applied_policy_version: null,
  policy_proposal_id: null,
  proposed_policy_version: null,
  access_group_id: null,
  destination_host: null,
  routing_policy_rule_id: null,
  route: null,
  missing_deployment_capability: null,
  decision: null,
  access_request_id: null,
  entitlement_id: null,
  enforcement_point_id: "AGENT_RUNTIME",
  obligation_kind: null,
  runaway_trigger: null,
  upstream_attempted: false,
  occurred_at: 1_700_000_000,
}

const queriedRuntimeEvent: DecisionAuditEvent = {
  ...runtimeEvent,
  audit_event_id: "queried-runtime-report",
  correlation_id: "exact-query-correlation",
  outcome: "DENY",
  subject: { subject_id: "platform-admin", evidence_level: "VERIFIED" },
  resource_id: "corporate-gpt",
}

function dataWith({
  auditEvents = [runtimeEvent],
  failures = [],
}: {
  auditEvents?: OverviewSnapshot["auditEvents"]
  failures?: OverviewSnapshot["failures"]
} = {}): OverviewSnapshot {
  const data = createMockOverview()
  return {
    ...data,
    auditEvents,
    apiActivity: { events: [] },
    failures,
  }
}

async function renderActivity(
  data: OverviewSnapshot,
  search = "",
  onRefresh: (scope?: "all" | "audit") => Promise<void> = async () => {},
  mode: "activity" | "audit" = "activity",
) {
  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
  window.history.replaceState({}, "", `/management?view=${mode}`)
  const user = userEvent.setup()
  const rendered = render(
    <I18nextProvider i18n={i18n}>
      <ActivityPage tenantId="tenant-design-preview" data={data} search={search} onRefresh={onRefresh} mode={mode} />
    </I18nextProvider>,
  )
  if (mode === "activity") await user.click(screen.getByRole("tab", { name: "Agent Runtime" }))
  return { i18n, rendered, user }
}

test("Agent Runtime activity shows decision evidence, empty state, and audit load failure", async () => {
  const { i18n, rendered } = await renderActivity(dataWith())
  const activity = await screen.findByTestId("agent-runtime-activity")
  const row = within(activity).getByTestId("agent-runtime-activity-row-runtime-report")

  expect(within(activity).getByText("Actor")).toBeTruthy()
  expect(within(activity).getByText("Target")).toBeTruthy()
  expect(within(activity).getByText("Decision")).toBeTruthy()
  expect(within(activity).getByText("Execution result")).toBeTruthy()
  expect(within(activity).getByText("Policy version")).toBeTruthy()
  expect(within(activity).getByText("Correlation")).toBeTruthy()
  expect(within(row).getByText("Platform Admin")).toBeTruthy()
  expect(within(row).getByText(runtimeEvent.target!)).toBeTruthy()
  expect(within(row).getByText("ALLOW")).toBeTruthy()
  expect(within(row).getByText("FAILED")).toBeTruthy()
  expect(within(row).getByText("Agent Runtime policy · r7")).toBeTruthy()
  expect(within(row).getByText(runtimeEvent.correlation_id)).toBeTruthy()
  expect(within(row).queryByText("COMPLETED")).toBeNull()

  rendered.rerender(
    <I18nextProvider i18n={i18n}>
      <ActivityPage tenantId="tenant-design-preview" data={dataWith({ auditEvents: [] })} search="" onRefresh={async () => {}} />
    </I18nextProvider>,
  )
  expect(screen.getByTestId("agent-runtime-empty-state")).toBeTruthy()
  expect(screen.getByText("No Agent Runtime activity")).toBeTruthy()

  rendered.rerender(
    <I18nextProvider i18n={i18n}>
      <ActivityPage
        tenantId="tenant-design-preview"
        data={dataWith({ auditEvents: [], failures: [{ source: "Audit", code: "AUDIT_UNAVAILABLE", status: 503 }] })}
        search=""
        onRefresh={async () => {}}
      />
    </I18nextProvider>,
  )
  const loadFailure = screen.getByTestId("agent-runtime-load-failure")
  expect(loadFailure).toBeTruthy()
  expect(loadFailure.textContent).toContain("AUDIT_UNAVAILABLE")
  expect(within(loadFailure).getByRole("button", { name: "Refresh latest Audit source" })).toBeTruthy()
  expect(screen.queryByTestId("agent-runtime-empty-state")).toBeNull()
})

test("Agent Runtime Audit failure retries only Audit and preserves the search scope", async () => {
  let requestedScope: "all" | "audit" | undefined
  const onRefresh = async (scope?: "all" | "audit") => {
    requestedScope = scope
  }
  const search = runtimeEvent.correlation_id
  const failed = dataWith({
    auditEvents: [],
    failures: [{ source: "Audit", code: "AUDIT_UNAVAILABLE", status: 503 }],
  })
  const { i18n, rendered, user } = await renderActivity(failed, search, onRefresh)

  expect(within(screen.getByTestId("agent-runtime-load-failure")).getByRole("button", { name: "Refresh latest Audit source" })).toBeTruthy()
  window.history.replaceState({}, "", "/management?enforcement=AGENT_RUNTIME&table_q=runtime-correlation")
  const queryBeforeRetry = window.location.search
  await user.click(screen.getByRole("button", { name: "Refresh latest Audit source" }))
  expect(requestedScope).toBe("audit")
  expect(window.location.search).toBe(queryBeforeRetry)

  rendered.rerender(
    <I18nextProvider i18n={i18n}>
      <ActivityPage tenantId="tenant-design-preview" data={dataWith()} search={search} onRefresh={onRefresh} />
    </I18nextProvider>,
  )
  const activity = screen.getByTestId("agent-runtime-activity")
  expect(within(activity).getByTestId("agent-runtime-activity-row-runtime-report")).toBeTruthy()
  expect(within(activity).getByText(runtimeEvent.correlation_id)).toBeTruthy()
})

test("Audit query Retry reruns the exact correlation and current filters through the client API", async () => {
  const originalFetch = globalThis.fetch
  const auditRequests: string[] = []
  let auditAttempt = 0
  const queryFrom = "2023-11-01"
  const queryTo = "2023-11-30"
  const response = {
    events: [queriedRuntimeEvent],
    source_revision: 7,
    offset: 0,
    limit: 100,
    freshness: { as_of: 1_700_000_010, latest_event_at: queriedRuntimeEvent.occurred_at, age_seconds: 10 },
    coverage: {
      requested_from: Math.floor(new Date(`${queryFrom}T00:00:00`).getTime() / 1000),
      requested_to: Math.floor(new Date(`${queryTo}T23:59:59`).getTime() / 1000),
      returned_from: queriedRuntimeEvent.occurred_at,
      returned_to: queriedRuntimeEvent.occurred_at,
      returned_count: 1,
      has_more: false,
    },
  }
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.includes("/audit-events?")) {
      return new Response(JSON.stringify({}), { headers: { "content-type": "application/json" }, status: 200 })
    }
    auditRequests.push(url)
    auditAttempt += 1
    if (auditAttempt === 1) {
      return new Response(JSON.stringify({ code: "AUDIT_QUERY_UNAVAILABLE" }), {
        headers: { "content-type": "application/json" },
        status: 503,
      })
    }
    return new Response(JSON.stringify(response), { headers: { "content-type": "application/json" }, status: 200 })
  }) as typeof fetch

  try {
    const { user } = await renderActivity(dataWith({ auditEvents: [runtimeEvent] }), "", async () => {}, "audit")
    const correlationInput = screen.getByRole("searchbox", { name: "Search audit by correlation ID" })
    const auditFilterBar = within(correlationInput.parentElement!)
    await user.type(correlationInput, queriedRuntimeEvent.correlation_id)

    await user.click(auditFilterBar.getByRole("combobox", { name: "Outcome" }))
    await user.click(await screen.findByRole("option", { name: "DENY" }))
    await user.click(screen.getByRole("combobox", { name: "Filter by enforcement point" }))
    await user.click(await screen.findByRole("option", { name: "Agent Runtime" }))

    await user.click(screen.getByRole("combobox", { name: "Audit query Resource" }))
    await user.click(await screen.findByRole("option", { name: /Corporate GPT/ }))
    await user.click(screen.getByRole("combobox", { name: "Search Subjects" }))
    await user.click(await screen.findByRole("option", { name: /Platform Admin/ }))

    fireEvent.change(document.getElementById("audit-query-from")!, { target: { value: queryFrom } })
    fireEvent.change(document.getElementById("audit-query-to")!, { target: { value: queryTo } })
    await user.selectOptions(screen.getByLabelText("Page size"), "100")
    await user.click(screen.getByRole("button", { name: "Query Audit Events" }))

    expect(await screen.findByText("AUDIT_QUERY_UNAVAILABLE")).toBeTruthy()
    expect(screen.getByTestId("audit-query-retry")).toBeTruthy()
    const policyDecisions = screen.getByTestId("audit-policy-decisions")
    expect(within(policyDecisions).queryByText(runtimeEvent.correlation_id)).toBeNull()
    expect(within(policyDecisions).queryByText("No Policy Decisions")).toBeNull()
    await user.click(screen.getByTestId("audit-query-retry"))

    expect(await screen.findByTestId("audit-query-status")).toBeTruthy()
    expect(auditRequests).toHaveLength(2)
    const first = new URL(auditRequests[0]!, "http://localhost")
    const second = new URL(auditRequests[1]!, "http://localhost")
    expect(second.search).toBe(first.search)
    expect(second.searchParams.get("metadata")).toBe("true")
    expect(second.searchParams.get("correlation_id")).toBe(queriedRuntimeEvent.correlation_id)
    expect(second.searchParams.get("correlation_id")).not.toBe("different-correlation")
    expect(second.searchParams.get("enforcement_point_id")).toBe("AGENT_RUNTIME")
    expect(second.searchParams.get("outcome")).toBe("DENY")
    expect(second.searchParams.get("resource_id")).toBe("corporate-gpt")
    expect(second.searchParams.get("subject_id")).toBe("platform-admin")
    expect(second.searchParams.get("from")).toBe(String(response.coverage.requested_from))
    expect(second.searchParams.get("to")).toBe(String(response.coverage.requested_to))
    expect(second.searchParams.get("offset")).toBe("0")
    expect(second.searchParams.get("limit")).toBe("100")
    expect(screen.getAllByText(queriedRuntimeEvent.correlation_id).length).toBeGreaterThan(0)
    expect(screen.queryByText("different-correlation")).toBeNull()
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("Audit query failure clears old results and retries the immutable failed page request", async () => {
  const originalFetch = globalThis.fetch
  const auditRequests: string[] = []
  let auditAttempt = 0
  const queryFrom = "2023-11-01"
  const queryTo = "2023-11-30"
  const changedFrom = "2024-01-01"
  const changedTo = "2024-01-31"
  const failedCorrelation = "failed-page-correlation"
  const pageZeroEvent: DecisionAuditEvent = {
    ...queriedRuntimeEvent,
    audit_event_id: "page-zero-event",
    correlation_id: failedCorrelation,
  }
  const pageFiftyEvent: DecisionAuditEvent = {
    ...pageZeroEvent,
    audit_event_id: "page-fifty-event",
  }
  const requestedFrom = Math.floor(new Date(`${queryFrom}T00:00:00`).getTime() / 1000)
  const requestedTo = Math.floor(new Date(`${queryTo}T23:59:59`).getTime() / 1000)
  const responseFor = (event: DecisionAuditEvent, offset: number, hasMore: boolean) => ({
    events: [event],
    source_revision: 7,
    offset,
    limit: 50,
    freshness: { as_of: 1_700_000_010, latest_event_at: event.occurred_at, age_seconds: 10 },
    coverage: {
      requested_from: requestedFrom,
      requested_to: requestedTo,
      returned_from: event.occurred_at,
      returned_to: event.occurred_at,
      returned_count: 1,
      has_more: hasMore,
    },
  })
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.includes("/audit-events?")) {
      return new Response(JSON.stringify({}), { headers: { "content-type": "application/json" }, status: 200 })
    }
    auditRequests.push(url)
    auditAttempt += 1
    if (auditAttempt === 1) {
      return new Response(JSON.stringify(responseFor(pageZeroEvent, 0, true)), { headers: { "content-type": "application/json" }, status: 200 })
    }
    if (auditAttempt === 2) {
      return new Response(JSON.stringify({ code: "AUDIT_PAGE_UNAVAILABLE" }), {
        headers: { "content-type": "application/json" },
        status: 503,
      })
    }
    return new Response(JSON.stringify(responseFor(pageFiftyEvent, 50, false)), { headers: { "content-type": "application/json" }, status: 200 })
  }) as typeof fetch

  try {
    const { user } = await renderActivity(dataWith({ auditEvents: [runtimeEvent] }), "", async () => {}, "audit")
    const correlationInput = screen.getByRole("searchbox", { name: "Search audit by correlation ID" })
    const auditFilterBar = within(correlationInput.parentElement!)
    await user.type(correlationInput, failedCorrelation)
    await user.click(auditFilterBar.getByRole("combobox", { name: "Outcome" }))
    await user.click(await screen.findByRole("option", { name: "DENY" }))
    await user.click(screen.getByRole("combobox", { name: "Filter by enforcement point" }))
    await user.click(await screen.findByRole("option", { name: "Agent Runtime" }))
    await user.click(screen.getByRole("combobox", { name: "Audit query Resource" }))
    await user.click(await screen.findByRole("option", { name: /Corporate GPT/ }))
    await user.click(screen.getByRole("combobox", { name: "Search Subjects" }))
    await user.click(await screen.findByRole("option", { name: /Platform Admin/ }))
    fireEvent.change(document.getElementById("audit-query-from")!, { target: { value: queryFrom } })
    fireEvent.change(document.getElementById("audit-query-to")!, { target: { value: queryTo } })

    await user.click(screen.getByRole("button", { name: "Query Audit Events" }))
    expect(await screen.findByText("page-zero-event")).toBeTruthy()
    expect(screen.getByTestId("audit-query-status")).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Next page" }))
    expect(await screen.findByText("AUDIT_PAGE_UNAVAILABLE")).toBeTruthy()
    expect(screen.queryByTestId("audit-query-status")).toBeNull()
    expect(screen.queryByText("page-zero-event")).toBeNull()
    expect(screen.queryByText("Queried Audit Events")).toBeNull()
    const policyDecisions = screen.getByTestId("audit-policy-decisions")
    expect(within(policyDecisions).queryByText(runtimeEvent.correlation_id)).toBeNull()
    expect(within(policyDecisions).queryByText("No Policy Decisions")).toBeNull()

    await user.clear(correlationInput)
    await user.type(correlationInput, "changed-correlation")
    await user.click(auditFilterBar.getByRole("combobox", { name: "Outcome" }))
    await user.click(await screen.findByRole("option", { name: "COMPLETED" }))
    await user.click(screen.getByRole("combobox", { name: "Filter by enforcement point" }))
    await user.click(await screen.findByRole("option", { name: "API Gateway" }))
    await user.click(screen.getByRole("combobox", { name: "Audit query Resource" }))
    await user.click(await screen.findByRole("option", { name: /Research Models/ }))
    await user.click(screen.getByRole("combobox", { name: "Search Subjects" }))
    await user.click(await screen.findByRole("option", { name: /AI Analyst/ }))
    fireEvent.change(document.getElementById("audit-query-from")!, { target: { value: changedFrom } })
    fireEvent.change(document.getElementById("audit-query-to")!, { target: { value: changedTo } })
    await user.selectOptions(screen.getByLabelText("Page size"), "100")
    await user.click(screen.getByTestId("audit-query-retry"))

    expect(await screen.findByText("page-fifty-event")).toBeTruthy()
    expect(auditRequests).toHaveLength(3)
    const failedRequest = new URL(auditRequests[1]!, "http://localhost")
    const retryRequest = new URL(auditRequests[2]!, "http://localhost")
    expect(retryRequest.search).toBe(failedRequest.search)
    expect(retryRequest.searchParams.get("correlation_id")).toBe(failedCorrelation)
    expect(retryRequest.searchParams.get("enforcement_point_id")).toBe("AGENT_RUNTIME")
    expect(retryRequest.searchParams.get("outcome")).toBe("DENY")
    expect(retryRequest.searchParams.get("resource_id")).toBe("corporate-gpt")
    expect(retryRequest.searchParams.get("subject_id")).toBe("platform-admin")
    expect(retryRequest.searchParams.get("from")).toBe(String(requestedFrom))
    expect(retryRequest.searchParams.get("to")).toBe(String(requestedTo))
    expect(retryRequest.searchParams.get("limit")).toBe("50")
    expect(retryRequest.searchParams.get("offset")).toBe("50")
    expect(retryRequest.search).not.toContain("changed-correlation")
    expect(retryRequest.search).not.toContain("research-models")
    expect(screen.getByTestId("audit-query-status")).toBeTruthy()
  } finally {
    globalThis.fetch = originalFetch
  }
})
