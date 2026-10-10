import { expect, test } from "bun:test"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

async function reviewModelDraft(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.type(screen.getByLabelText("Display name"), name)
  await user.click(screen.getByRole("button", { name: "Continue" }))
  await screen.findByText("Access control")
  await user.click(screen.getByRole("button", { name: "Continue" }))
  await screen.findByText("Review Draft")
}

test("Draft creation stays disabled through the server response and pending completion callback", async () => {
  const originalFetch = globalThis.fetch
  const response = deferred<Response>()
  const completion = deferred<void>()
  const created: string[] = []
  let posts = 0
  let cancelled = 0
  globalThis.fetch = (async () => { posts++; return response.promise }) as typeof fetch
  try {
    const user = userEvent.setup()
    await renderWizard(async (id) => { created.push(id); await completion.promise }, () => { cancelled++ })
    await reviewModelDraft(user, "Pending model")
    const create = screen.getByRole("button", { name: "Create Draft" }) as HTMLButtonElement
    await user.click(create)
    expect(create.disabled).toBe(true)
    await user.click(create)
    expect(posts).toBe(1)
    expect(created).toEqual([])
    expect(cancelled).toBe(0)
    response.resolve(json({ resource_id: "resource-pending" }))
    await waitFor(() => expect(created).toEqual(["resource-pending"]))
    expect(create.disabled).toBe(true)
    await user.click(create)
    expect(posts).toBe(1)
    expect(cancelled).toBe(0)
    completion.resolve()
    await waitFor(() => expect(cancelled).toBe(1))
    expect(created).toEqual(["resource-pending"])
    expect(posts).toBe(1)
    await waitFor(() => expect(create.disabled).toBe(false))
  } finally {
    try {
      await act(async () => {
        response.resolve(json({ resource_id: "resource-pending" }))
        completion.resolve()
        await Promise.all([response.promise, completion.promise])
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  }
})

test("failed Draft creation displays the server error, preserves input, and permits a successful retry", async () => {
  const originalFetch = globalThis.fetch
  const requests: Record<string, unknown>[] = []
  const created: string[] = []
  let cancelled = 0
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return requests.length === 1
      ? new Response(JSON.stringify({ code: "RESOURCE_SERVICE_UNAVAILABLE" }), { status: 500, headers: { "content-type": "application/json" } })
      : json({ resource_id: "resource-retry" })
  }) as typeof fetch
  try {
    const user = userEvent.setup()
    await renderWizard(async (id) => { created.push(id) }, () => { cancelled++ })
    await reviewModelDraft(user, "Preserved retry model")
    await user.click(screen.getByRole("button", { name: "Create Draft" }))
    await screen.findByText("RESOURCE_SERVICE_UNAVAILABLE")
    expect(created).toEqual([])
    expect(cancelled).toBe(0)
    expect(screen.getByText("Preserved retry model")).toBeTruthy()
    expect((screen.getByRole("button", { name: "Create Draft" }) as HTMLButtonElement).disabled).toBe(false)
    await user.click(screen.getByRole("button", { name: "Back" }))
    await user.click(screen.getByRole("button", { name: "Back" }))
    expect((screen.getByLabelText("Display name") as HTMLInputElement).value).toBe("Preserved retry model")
    await user.click(screen.getByRole("button", { name: "Continue" }))
    await user.click(screen.getByRole("button", { name: "Continue" }))
    await user.click(screen.getByRole("button", { name: "Create Draft" }))
    await waitFor(() => expect(created).toEqual(["resource-retry"]))
    expect(cancelled).toBe(1)
    expect(requests).toHaveLength(2)
    expect(requests[1]).toEqual(requests[0])
  } finally {
    globalThis.fetch = originalFetch
  }
})
