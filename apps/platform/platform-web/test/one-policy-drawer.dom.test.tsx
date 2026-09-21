import { expect, test } from "bun:test"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import { SheetWorkspaceRoot } from "@/components/ui/sheet"
import type { IdentitySession, OnePolicyBotSeed, OverviewSnapshot } from "@/domain/contracts"
import { OnePolicyPage } from "@/features/policy/one-policy-page"

const tenantId = "tenant-acme"
const identity = {
  tenant_id: tenantId,
  subject_id: "subject-admin",
  acting_client_id: "console",
  scopes: ["genioone-management"],
  acr: "test",
  amr: ["test"],
} as IdentitySession
const data = {
  resources: [],
  connections: [],
  organizations: [],
  identity: {
    subjects: [{
      subject_id: "subject-admin",
      kind: "PERSON",
      profile: { display_name: "Admin", email: "admin@example.test", department: null },
      suspended: false,
      suspended_at: null,
      suspended_by: null,
      suspension_reason: null,
    }],
    external_identity_bindings: [],
    tenant_administrators: ["subject-admin"],
  },
} as unknown as OverviewSnapshot
const seed: OnePolicyBotSeed = {
  tenant_id: tenantId,
  policy_id: "one-policy.first-party.bot-default",
  policy_revision: 1,
  rules: { allowed_roles: ["TENANT_ADMINISTRATOR"], allowed_subject_ids: [] },
  seed: true,
  enabled: true,
  created_at: 1,
  updated_at: 1,
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } })
}

test("policy details open as a wide workspace drawer and close back to the preserved list", async () => {
  const originalFetch = globalThis.fetch
  const originalUrl = window.location.href
  const user = userEvent.setup()
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith("/one-policy/first-party-bot/draft")) return json(null)
    if (url.endsWith("/one-policy/first-party-bot/revisions")) return json([])
    if (url.endsWith("/one-policy/first-party-bot")) return json(seed)
    if (url.endsWith("/one-policy/authoring-settings")) return json({ tenant_id: tenantId, revision: 0, require_distinct_reviewer: false, updated_at: 1 })
    if (url.endsWith("/one-policy/runtime-policies")) return json([])
    if (url.endsWith("/one-policy/drafts")) return json([])
    if (url.endsWith("/enforcement-chains")) return json([])
    return json({})
  }) as typeof fetch
  window.history.replaceState({}, "", "/management?view=policy")
  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: {} } } })

  try {
    render(
      <I18nextProvider i18n={i18n}>
        <SheetWorkspaceRoot>
          <OnePolicyPage canManageFirstPartyBotSeed data={data} identity={identity} tenantId={tenantId} />
        </SheetWorkspaceRoot>
      </I18nextProvider>,
    )

    await screen.findByText("Genio Bot access")
    await user.click(screen.getByRole("button", { name: "Open policy" }))

    const drawer = await waitFor(() => screen.getByTestId("policy-detail-sheet"))
    expect(drawer.getAttribute("data-presentation")).toBe("workspace-panel")
    expect(new URL(window.location.href).searchParams.get("policy")).toBe(seed.policy_id)
    expect(screen.getByText("Policies")).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "Close" }))
    await waitFor(() => expect(screen.queryByTestId("policy-detail-sheet")).toBeNull())
    expect(new URL(window.location.href).searchParams.get("policy")).toBeNull()
    expect(screen.getByText("Policies")).toBeTruthy()
  } finally {
    globalThis.fetch = originalFetch
    window.history.replaceState({}, "", originalUrl)
  }
})
