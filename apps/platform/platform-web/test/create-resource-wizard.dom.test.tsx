import { expect, test } from "bun:test"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import { CreateResourceWizard } from "@/features/resources/create-resource-wizard"
import productI18n from "@/i18n"
import { createMockOverview } from "@/mocks/overview"

function json(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })
}

async function renderWizard(onCreated: (resourceId: string) => Promise<void>, onCancel: () => void, language = "en") {
  const i18n = createInstance()
  await i18n.init({ lng: language, fallbackLng: "en", keySeparator: false, resources: productI18n.options.resources })
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
  return i18n
}

for (const language of ["en", "zh-TW"]) {
  test("API onboarding can distinguish and remove empty or duplicate rules in " + language, async () => {
    const user = userEvent.setup()
    const i18n = await renderWizard(async () => {}, () => {}, language)
    fireEvent.change(screen.getByLabelText(i18n.t("Display name")), { target: { value: "Incident API" } })
    const typeField = screen.getByText(i18n.t("Resource type")).closest('[data-slot="field"]') as HTMLElement
    await user.click(within(typeField).getByRole("combobox"))
    await user.click(await screen.findByRole("option", { name: i18n.t("API Product") }))
    const sourceField = screen.getByText(i18n.t("Import source")).closest('[data-slot="field"]') as HTMLElement
    await user.click(within(sourceField).getByRole("combobox"))
    await user.click(await screen.findByRole("option", { name: i18n.t("Paste document") }))
    fireEvent.change(screen.getByLabelText(i18n.t("OpenAPI document")), { target: { value: JSON.stringify({ openapi: "3.0.3", info: { title: "Incident API", version: "1.0" }, paths: { "/incidents": { get: { operationId: "incident.list", responses: { "200": { description: "ok" } } } } } }) } })
    await user.click(screen.getByRole("button", { name: i18n.t("Continue") }))
    await user.click(await screen.findByRole("button", { name: i18n.t("Add rule") }))
    await user.click(screen.getByRole("button", { name: i18n.t("Add rule") }))

    const firstEmpty = language === "en" ? "Remove rule 1: unnamed" : "移除第 1 列規則：未命名"
    const secondEmpty = language === "en" ? "Remove rule 2: unnamed" : "移除第 2 列規則：未命名"
    expect(screen.getByRole("button", { name: firstEmpty })).toBeTruthy()
    expect(screen.getByRole("button", { name: secondEmpty })).toBeTruthy()
    fireEvent.change(screen.getAllByRole("textbox", { name: i18n.t("Provider-specific parameter") })[0]!, { target: { value: "x-region" } })
    fireEvent.change(screen.getAllByRole("textbox", { name: i18n.t("Provider-specific parameter") })[1]!, { target: { value: "x-region" } })
    const firstNamed = language === "en" ? "Remove rule 1: x-region" : "移除第 1 列規則：x-region"
    const secondNamed = language === "en" ? "Remove rule 2: x-region" : "移除第 2 列規則：x-region"
    expect(screen.getByRole("button", { name: firstNamed })).toBeTruthy()
    await user.click(screen.getByRole("button", { name: secondNamed }))
    expect(screen.queryByRole("button", { name: secondNamed })).toBeNull()
    expect(screen.getAllByRole("textbox", { name: i18n.t("Provider-specific parameter") })).toHaveLength(1)
    expect(screen.getByRole("button", { name: firstNamed })).toBeTruthy()
  })
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
