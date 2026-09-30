import { expect, test } from "bun:test"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import { CreateResourceWizard } from "@/features/resources/create-resource-wizard"
import { createMockOverview } from "@/mocks/overview"

function json(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })
}

async function renderWizard(onCreated: (resourceId: string) => Promise<void>, onCancel: () => void) {
  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
  const data = createMockOverview()
  render(
    <I18nextProvider i18n={i18n}>
      <CreateResourceWizard
        agents={data.identity!.subjects}
        onCancel={onCancel}
        onCreated={onCreated}
        organizations={data.organizations}
        resources={data.resources}
        tenantId="tenant-design-preview"
      />
    </I18nextProvider>,
  )
}

test("Resource onboarding creates a Draft through the visible review step and returns its resource ID", async () => {
  const originalFetch = globalThis.fetch
  const user = userEvent.setup()
  const requests: Array<{ path: string; body: Record<string, unknown> }> = []
  const created: string[] = []
  let cancelled = 0
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const path = new URL(url, "http://localhost").pathname
    const bodyText = input instanceof Request ? await input.clone().text() : String(init?.body ?? "")
    requests.push({ path, body: JSON.parse(bodyText) as Record<string, unknown> })
    return json({ resource_id: "resource-quarterly-analysis" })
  }) as typeof fetch

  try {
    await renderWizard(async (resourceId) => { created.push(resourceId) }, () => { cancelled += 1 })

    await user.type(screen.getByLabelText("Display name"), "Quarterly analysis model")
    await user.click(screen.getByRole("button", { name: "Continue" }))
    await screen.findByText("Access control")
    await user.click(screen.getByRole("button", { name: "Continue" }))
    await screen.findByText("Review Draft")

    expect(screen.getByText("Quarterly analysis model")).toBeTruthy()
    expect(screen.getByText("Register later")).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "Create Draft" }))

    await waitFor(() => expect(created).toEqual(["resource-quarterly-analysis"]))
    expect(cancelled).toBe(1)
    expect(requests).toEqual([{
      path: "/v1/tenants/tenant-design-preview/resources",
      body: {
        display_name: "Quarterly analysis model",
        kind: "LLM",
        authentication_strategy: "OAUTH",
        environment_id: "production",
        version: "v1",
        capabilities: [{ capability_id: "model.invoke", display_name: "Invoke model" }],
        enforcement_point_id: "genio-ai-mcp-gateway",
        owner_organization_id: "ai-platform",
      },
    }])
  } finally {
    globalThis.fetch = originalFetch
  }
})
