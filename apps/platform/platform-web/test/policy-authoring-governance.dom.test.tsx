import { expect, test } from "bun:test"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import { PolicyAuthoringGovernanceCard } from "@/features/policy/policy-authoring-governance-card"

function settings(revision: number, requireDistinctReviewer: boolean) {
  return {
    tenant_id: "tenant-acme",
    revision,
    require_distinct_reviewer: requireDistinctReviewer,
    updated_at: 100 + revision,
  }
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
}

async function renderCard(onSaved = async () => {}) {
  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
  render(
    <I18nextProvider i18n={i18n}>
      <PolicyAuthoringGovernanceCard onSaved={onSaved} tenantId="tenant-acme" />
    </I18nextProvider>,
  )
}

test("policy authoring governance persists the CE default override through the tenant settings endpoint", async () => {
  const originalFetch = globalThis.fetch
  const user = userEvent.setup()
  const writes: Array<Record<string, unknown>> = []
  let saved = 0
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (!url.endsWith("/authoring-settings")) return json({})
    if (init?.method === "PUT") {
      writes.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return json(settings(1, true))
    }
    return json(settings(0, false))
  }) as typeof fetch

  try {
    await renderCard(async () => { saved += 1 })

    await screen.findByTestId("policy-authoring-governance")
    expect(screen.getByText("CE self-review allowed")).toBeTruthy()
    const distinctReviewer = screen.getByRole("switch", { name: "Require a distinct reviewer" })
    expect(distinctReviewer.getAttribute("aria-checked")).toBe("false")

    await user.click(distinctReviewer)
    expect(screen.getByText("Governance changes not saved")).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Save governance settings" }))

    await waitFor(() => expect(saved).toBe(1))
    expect(writes).toEqual([{ expected_revision: 0, require_distinct_reviewer: true }])
    expect(screen.getByText("Four-eyes required")).toBeTruthy()
    expect(screen.queryByText("Governance changes not saved")).toBeNull()
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("policy authoring governance preserves an unsaved toggle after a server conflict", async () => {
  const originalFetch = globalThis.fetch
  const user = userEvent.setup()
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (!url.endsWith("/authoring-settings")) return json({})
    if (init?.method === "PUT") return json({ code: "POLICY_AUTHORING_SETTINGS_CONFLICT" }, 409)
    return json(settings(2, false))
  }) as typeof fetch

  try {
    await renderCard()

    await screen.findByTestId("policy-authoring-governance")
    const distinctReviewer = screen.getByRole("switch", { name: "Require a distinct reviewer" })
    await user.click(distinctReviewer)
    await user.click(screen.getByRole("button", { name: "Save governance settings" }))

    await waitFor(() => expect(screen.getByText("Another administrator changed this setting. Reload before saving your change.")).toBeTruthy())
    expect(distinctReviewer.getAttribute("aria-checked")).toBe("true")
    expect(screen.getByRole("button", { name: "Reload authoring settings" })).toBeTruthy()
  } finally {
    globalThis.fetch = originalFetch
  }
})
