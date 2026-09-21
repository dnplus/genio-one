import { expect, test } from "bun:test"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import type { ConnectionSummary, ResourceRegistration } from "@/domain/contracts"
import { ResourceEnforcementChainCard } from "@/features/resources/resource-enforcement-chain-card"
import type { EnforcementChainRevisionView, PolicyDraftView } from "@/lib/product-api"

const resource: ResourceRegistration = {
  tenant_id: "tenant-acme",
  resource_id: "resource-context7",
  display_name: "Context7",
  kind: "MCP",
  owner_organization_id: "organization-acme",
  authentication_strategy: "NONE",
  environment_id: "environment-production",
  version: "1.0.0",
  lifecycle: "PUBLISHED",
  operational_state: "HEALTHY",
  capabilities: [{ capability_id: "docs.query", display_name: "Query documentation" }],
  enforcement_point_id: "gateway-acme",
  created_at: 1,
}

function draft(lifecycle: PolicyDraftView["lifecycle"] = "DRAFT"): PolicyDraftView {
  return {
    policy_key: '["resource-context7","docs.query"]',
    version: 2,
    base_revision: 0,
    lifecycle,
    content_digest: "b".repeat(64),
    created_by_subject_id: "subject-admin",
    created_at: 100,
    updated_by_subject_id: "subject-admin",
    updated_at: 100,
    validation: lifecycle === "DRAFT" ? null : {
      actor_subject_id: "subject-admin",
      at: 110,
      content_digest: "b".repeat(64),
      correlation_id: "validation-1",
    },
    review: lifecycle === "REVIEWED" ? {
      actor_subject_id: "subject-admin",
      at: 120,
      content_digest: "b".repeat(64),
      correlation_id: "review-1",
    } : null,
    content: {
      kind: "RESOURCE_CAPABILITY",
      definition: {
        one_policy_revision: 1,
        eligible_connection_ids: [],
        steps: [
          { step_id: "authenticate", kind: "AUTHENTICATE" },
          { step_id: "authorize", kind: "AUTHORIZE", config: { required_obligations: [] } },
          { step_id: "route", kind: "ROUTE" },
        ],
      },
    },
  }
}

function revision(): EnforcementChainRevisionView {
  return {
    tenant_id: "tenant-acme",
    resource_id: "resource-context7",
    capability_id: "docs.query",
    one_policy_revision: 1,
    chain: {
      eligible_connection_ids: [],
      steps: [
        { step_id: "authenticate", kind: "AUTHENTICATE" },
        { step_id: "authorize", kind: "AUTHORIZE", config: { required_obligations: [] } },
        { step_id: "route", kind: "ROUTE" },
      ],
      request_filter_order: [],
      response_filter_order: [],
    },
    chain_digest: "chain-digest",
    created_at: 100,
    updated_at: 100,
  }
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
}

test("Resource policy only preselects READY connections and prevents selecting degraded candidates", async () => {
  const originalFetch = globalThis.fetch
  const user = userEvent.setup()
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).endsWith("/policy-draft")) return json(null)
    return json({ code: "ENFORCEMENT_CHAIN_NOT_FOUND" }, 404)
  }) as typeof fetch
  const connections: ConnectionSummary[] = (["READY", "DEGRADED"] as const).map((status) => ({
    status,
    connection_id: `connection-${status}`,
    display_name: `${status} connection`,
    kind: "MCP",
    endpoint_url: "https://mcp.example.test",
    mcp_selected_tools: [],
    mcp_tool_selection_operation_id: null,
    credential_configured: false,
    downstream_identity: { mode: "NONE" },
    resource_id: resource.resource_id,
    enforcement_point_id: resource.enforcement_point_id,
    lifecycle: "ENABLED",
    configuration_revision: 1,
    verification_state: "VERIFIED",
    health_state: "HEALTHY",
    health_observed_at: 1,
    health_source_revision: 1,
    routing_priority: 1,
    region: null,
    supported_obligations: [],
  }))
  try {
    const i18n = createInstance()
    await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
    render(
      <I18nextProvider i18n={i18n}>
        <ResourceEnforcementChainCard canEdit connections={connections} onSaved={async () => {}} resource={resource} tenantId="tenant-acme" />
      </I18nextProvider>,
    )
    await waitFor(() => expect(screen.queryByText("Loading")).toBeNull())
    await user.click(screen.getByRole("button", { name: "Edit policy" }))
    const card = within(screen.getByTestId("resource-enforcement-chain"))
    const candidates = card.getAllByRole("checkbox")
    const candidate = (status: string) => candidates.find((element) => element.closest("label")?.textContent?.startsWith(`${status} connection`))!
    const ready = candidate("READY")
    expect(ready.getAttribute("aria-checked")).toBe("true")
    expect(ready.getAttribute("aria-disabled")).not.toBe("true")
    const unavailable = candidate("DEGRADED")
    expect(unavailable.getAttribute("aria-checked")).toBe("false")
    expect(unavailable.getAttribute("aria-disabled")).toBe("true")
    await user.click(unavailable)
    expect(unavailable.getAttribute("aria-checked")).toBe("false")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("Resource policy draft uses server validation and review before publication", async () => {
  const originalFetch = globalThis.fetch
  const user = userEvent.setup()
  const urls: string[] = []
  let current = draft()
  let saved = 0
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    urls.push(url)
    if (url.endsWith("/policy-draft/validate")) {
      current = draft("VALIDATED")
      return json(current)
    }
    if (url.endsWith("/policy-draft/review")) {
      current = draft("REVIEWED")
      return json(current)
    }
    if (url.endsWith("/policy-draft/publish")) return json(revision())
    if (url.endsWith("/policy-draft")) return json(current)
    if (url.endsWith("/enforcement-chain")) return json({ code: "ENFORCEMENT_CHAIN_NOT_FOUND" }, 404)
    return json({})
  }) as typeof fetch

  try {
    const i18n = createInstance()
    await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
    render(
      <I18nextProvider i18n={i18n}>
        <ResourceEnforcementChainCard canEdit onSaved={async () => { saved += 1 }} resource={resource} tenantId="tenant-acme" />
      </I18nextProvider>,
    )

    await screen.findByTestId("resource-policy-draft-lifecycle")
    const validate = screen.getByRole("button", { name: "Validate saved draft" })
    const review = screen.getByRole("button", { name: "Review saved draft" })
    const publish = screen.getByRole("button", { name: "Publish saved draft" })
    expect(validate.hasAttribute("disabled")).toBeFalse()
    expect(review.hasAttribute("disabled")).toBeTrue()
    expect(publish.hasAttribute("disabled")).toBeTrue()

    await user.click(validate)
    await waitFor(() => expect(screen.getByText(/Validated by subject-admin/)).toBeTruthy())
    expect(review.hasAttribute("disabled")).toBeFalse()

    await user.click(review)
    await waitFor(() => expect(screen.getByText(/Reviewed by subject-admin/)).toBeTruthy())
    expect(publish.hasAttribute("disabled")).toBeFalse()

    await user.click(publish)
    await waitFor(() => expect(saved).toBe(1))
    await waitFor(() => expect(screen.queryByTestId("resource-policy-draft-lifecycle")).toBeNull())
    expect(urls.some((url) => url.includes("/ai-gateway/enforcement-chain/preview"))).toBeFalse()
  } finally {
    globalThis.fetch = originalFetch
  }
})
