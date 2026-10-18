import { expect, test } from "bun:test"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import { PersonalSettingsPage } from "@/features/personal-settings/personal-settings-page"
import { adminEnglish } from "@/i18n/admin-governance"

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
}

async function renderSettings(mockMode = false) {
  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: adminEnglish } } })
  return render(
    <I18nextProvider i18n={i18n}>
      <PersonalSettingsPage identity={{ tenant_id: "tenant-acme", subject_id: "person-admin", acting_client_id: "management-ui", role: "TENANT_ADMINISTRATOR", scopes: [], acr: null, amr: [] }} mockMode={mockMode} />
    </I18nextProvider>,
  )
}

test("connected applications show loading before exposing the configured native account link", async () => {
  const originalFetch = globalThis.fetch
  let finish: ((response: Response) => void) | undefined
  globalThis.fetch = (() => new Promise<Response>((resolve) => { finish = resolve })) as typeof fetch
  try {
    await renderSettings()
    expect(screen.getByRole("status").textContent).toBe("Loading connected-application access…")
    expect(screen.queryByRole("link", { name: "Manage connected applications" })).toBeNull()
    finish!(json({ account_management_endpoint: "https://identity.example.test/realms/acme/account/" }))

    const link = await screen.findByRole("link", { name: "Manage connected applications" })
    expect(link.getAttribute("href")).toBe("https://identity.example.test/realms/acme/account/")
    expect(link.getAttribute("target")).toBe("_blank")
    expect(link.getAttribute("rel")).toBe("noopener noreferrer")
  } finally { globalThis.fetch = originalFetch }
})

test("generic OIDC and mock mode do not manufacture a connected-application management link", async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return json({ issuer: "https://generic-identity.example.test" })
  }) as typeof fetch
  try {
    const view = await renderSettings()
    await screen.findByText("This deployment does not provide a connected-application management page.")
    expect(screen.queryByRole("link", { name: "Manage connected applications" })).toBeNull()
    expect(calls).toBe(1)
    view.unmount()
    await renderSettings(true)
    expect(screen.queryByRole("link", { name: "Manage connected applications" })).toBeNull()
    expect(calls).toBe(1)
  } finally { globalThis.fetch = originalFetch }
})

test("a failed account configuration load can be retried without losing personal settings", async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return calls === 1 ? json({}, 503) : json({ account_management_endpoint: "http://127.0.0.1:58080/realms/genio-one/account/" })
  }) as typeof fetch
  try {
    const user = userEvent.setup()
    await renderSettings()
    await screen.findByText("Connected-application access could not be loaded. Retry to open your identity account.")
    await user.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(screen.getByRole("link", { name: "Manage connected applications" })).toBeTruthy())
    expect(screen.getByRole("button", { name: "Save personal settings" })).toBeTruthy()
    expect(calls).toBe(2)
  } finally { globalThis.fetch = originalFetch }
})

test("connected-application links accept only an explicit web account endpoint", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => json({ account_management_endpoint: "javascript:alert(1)" })) as typeof fetch
  try {
    await renderSettings()
    await screen.findByText("This deployment does not provide a connected-application management page.")
    expect(screen.queryByRole("link", { name: "Manage connected applications" })).toBeNull()
  } finally { globalThis.fetch = originalFetch }
})
