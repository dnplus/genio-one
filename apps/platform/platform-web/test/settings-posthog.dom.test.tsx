import { expect, test } from "bun:test"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import type { IdentitySession, OverviewSnapshot, PostHogTelemetrySettings } from "@/domain/contracts"
import { SettingsPage } from "@/features/settings/settings-page"

const tenantId = "tenant-acme"

function identity(role: NonNullable<IdentitySession["role"]>): IdentitySession {
  return {
    tenant_id: tenantId,
    subject_id: "person-admin",
    acting_client_id: "management-ui",
    role,
    organization_ids: [],
    scopes: ["genioone-management"],
    acr: "oidc",
    amr: ["oidc"],
  }
}

function data(): OverviewSnapshot {
  return {
    organizations: [],
    siemDestination: null,
    siemDeliveries: [],
  } as OverviewSnapshot
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
}

async function renderSettings(input: {
  identity: IdentitySession
  onReload?: () => Promise<void>
}) {
  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
  render(
    <I18nextProvider i18n={i18n}>
      <SettingsPage data={data()} identity={input.identity} onReload={input.onReload ?? (async () => {})} tenantId={tenantId} />
    </I18nextProvider>,
  )
}

test("Tenant Administrator binds a PostHog project while disabled, then enables and disables it", async () => {
  const originalFetch = globalThis.fetch
  const user = userEvent.setup()
  const requests: Array<{ url: string; method: string; body: unknown }> = []
  let reloads = 0
  let postHog: PostHogTelemetrySettings = {
    enabled: false,
    host: null,
    project_id: null,
    project_token: null,
    configured_by: null,
    configured_at: null,
  }
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const method = input instanceof Request ? input.method : init?.method ?? "GET"
    const text = input instanceof Request
      ? await input.clone().text()
      : typeof init?.body === "string"
        ? init.body
        : ""
    requests.push({ url, method, body: text ? JSON.parse(text) : null })
    if (url.endsWith("/telemetry/posthog") && method === "GET") {
      return json(postHog)
    }
    if (url.endsWith("/telemetry/posthog") && method === "PUT") {
      const body = text ? JSON.parse(text) : {}
      postHog = {
        enabled: body.enabled === true,
        host: body.host ?? postHog.host,
        project_id: body.project_id ?? postHog.project_id,
        project_token: body.project_token ?? postHog.project_token,
        configured_by: "person-admin",
        configured_at: 100,
      }
      return json(postHog)
    }
    return json([])
  }) as typeof fetch

  try {
    await renderSettings({
      identity: identity("TENANT_ADMINISTRATOR"),
      onReload: async () => {
        reloads += 1
      },
    })

    await user.click(screen.getByText("PostHog integration", { selector: "summary" }))
    const enabled = screen.getByRole("switch", { name: "Enable PostHog integration" })
    await screen.findByText("Not configured")
    expect(enabled.getAttribute("aria-checked")).toBe("false")
    expect(screen.getByText("Disabled")).toBeTruthy()
    expect(screen.getByLabelText("Public project token").getAttribute("type")).toBe("password")
    expect(screen.getAllByText("Project binding")).toHaveLength(2)
    expect(screen.getByText("Bind this tenant to a PostHog project for browser telemetry and available Gateway AI/MCP activity summaries.")).toBeTruthy()
    expect(screen.getByText("Gateway activity summaries include only tenant, resource, model, provider, tool, status, duration, and token counts; they do not include request or response content.")).toBeTruthy()

    await user.type(screen.getByLabelText("Project ID"), "630618")
    await user.type(screen.getByLabelText("Public project token"), "phc_public_project_token")
    await user.click(screen.getByRole("button", { name: "Save PostHog settings" }))

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("PostHog settings saved. Newly loaded sessions follow this setting."))
    expect(requests.at(-1)).toEqual({
      url: `/v1/tenants/${tenantId}/telemetry/posthog`,
      method: "PUT",
      body: {
        enabled: false,
        host: "https://us.i.posthog.com",
        project_id: 630618,
        project_token: "phc_public_project_token",
      },
    })
    expect(screen.getByText("Configured")).toBeTruthy()
    expect(screen.getByText("Disabled")).toBeTruthy()
    expect(screen.getByRole("link", { name: "Open PostHog project" }).getAttribute("href")).toBe("https://us.posthog.com/project/630618")
    expect(reloads).toBe(1)

    await user.click(enabled)
    await user.click(screen.getByRole("button", { name: "Save PostHog settings" }))
    await waitFor(() => expect(requests.filter((request) => request.url.endsWith("/telemetry/posthog") && request.method === "PUT")).toHaveLength(2))
    expect(requests.at(-1)).toEqual({
      url: `/v1/tenants/${tenantId}/telemetry/posthog`,
      method: "PUT",
      body: {
        enabled: true,
        host: "https://us.i.posthog.com",
        project_id: 630618,
        project_token: "phc_public_project_token",
      },
    })
    expect(screen.getByText("Configured")).toBeTruthy()
    expect(screen.getByText("Enabled")).toBeTruthy()
    expect(screen.getByRole("link", { name: "Open PostHog project" }).getAttribute("href")).toBe("https://us.posthog.com/project/630618")
    expect(reloads).toBe(2)

    await user.click(enabled)
    await user.click(screen.getByRole("button", { name: "Save PostHog settings" }))
    await waitFor(() => expect(requests.filter((request) => request.url.endsWith("/telemetry/posthog") && request.method === "PUT")).toHaveLength(3))
    expect(requests.at(-1)).toEqual({
      url: `/v1/tenants/${tenantId}/telemetry/posthog`,
      method: "PUT",
      body: {
        enabled: false,
      },
    })
    expect(screen.getByText("Disabled")).toBeTruthy()
    expect(reloads).toBe(3)
  } finally {
    globalThis.fetch = originalFetch
    cleanup()
  }
})

test("PostHog settings do not claim disabled state while loading or after the GET fails", async () => {
  const originalFetch = globalThis.fetch
  const user = userEvent.setup()
  let resolvePostHogLoad: ((response: Response) => void) | null = null
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.endsWith("/telemetry/posthog")) {
      return new Promise<Response>((resolve) => {
        resolvePostHogLoad = resolve
      })
    }
    return json([])
  }) as typeof fetch

  try {
    await renderSettings({ identity: identity("TENANT_ADMINISTRATOR") })
    await user.click(screen.getByText("PostHog integration", { selector: "summary" }))
    expect(screen.getByText("Loading PostHog settings…")).toBeTruthy()
    expect(screen.queryByText("Not configured")).toBeNull()
    expect(screen.queryByText("Disabled")).toBeNull()
    expect(screen.getByRole("button", { name: "Save PostHog settings" }).hasAttribute("disabled")).toBe(true)
    await waitFor(() => expect(resolvePostHogLoad).not.toBeNull())
    resolvePostHogLoad!(json({ code: "POSTHOG_LOAD_FAILED" }, 500))

    expect((await screen.findByRole("alert")).textContent).toContain("POSTHOG_LOAD_FAILED")
    expect(screen.getByText("PostHog settings unavailable")).toBeTruthy()
    expect(screen.queryByText("Not configured")).toBeNull()
    expect(screen.queryByText("Disabled")).toBeNull()
    expect(screen.getByRole("button", { name: "Save PostHog settings" }).hasAttribute("disabled")).toBe(true)
  } finally {
    globalThis.fetch = originalFetch
    cleanup()
  }
})

test("PostHog does not submit a malformed public project token", async () => {
  const originalFetch = globalThis.fetch
  const user = userEvent.setup()
  const requests: Array<{ url: string; method: string }> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const method = input instanceof Request ? input.method : init?.method ?? "GET"
    requests.push({ url, method })
    if (url.endsWith("/telemetry/posthog") && method === "GET") {
      return json({
        enabled: false,
        host: null,
        project_id: null,
        project_token: null,
        configured_by: null,
        configured_at: null,
      })
    }
    return json([])
  }) as typeof fetch

  try {
    await renderSettings({ identity: identity("TENANT_ADMINISTRATOR") })
    await user.click(screen.getByText("PostHog integration", { selector: "summary" }))
    await screen.findByText("Not configured")
    await user.click(screen.getByRole("switch", { name: "Enable PostHog integration" }))
    await user.type(screen.getByLabelText("Project ID"), "630618")
    await user.type(screen.getByLabelText("Public project token"), "phc_invalid token")
    await user.click(screen.getByRole("button", { name: "Save PostHog settings" }))

    expect(screen.getByRole("alert").textContent).toContain("Enter a positive project ID and a valid public project token")
    expect(requests.filter((request) => request.url.endsWith("/telemetry/posthog") && request.method === "PUT")).toHaveLength(0)
  } finally {
    globalThis.fetch = originalFetch
    cleanup()
  }
})

test("Organization Administrator and USER do not see or load PostHog integration settings", async () => {
  const originalFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(input instanceof Request ? input.url : String(input))
    return json([])
  }) as typeof fetch

  try {
    for (const role of ["ORGANIZATION_ADMINISTRATOR", "USER"] as const) {
      urls.length = 0
      await renderSettings({ identity: identity(role) })
      expect(screen.queryByText("PostHog integration", { selector: "summary" })).toBeNull()
      await waitFor(() => expect(urls.length).toBeGreaterThan(0))
      expect(urls.some((url) => url.endsWith("/telemetry/posthog"))).toBe(false)
      cleanup()
    }
  } finally {
    globalThis.fetch = originalFetch
    cleanup()
  }
})
