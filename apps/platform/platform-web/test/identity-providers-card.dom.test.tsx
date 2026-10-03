import { expect, test } from "bun:test"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import { SheetWorkspaceRoot } from "@/components/ui/sheet"
import { IdentityProvidersCard } from "@/features/identity/identity-providers-card"
import productI18n from "@/i18n"
import type { IdentityProvider } from "@/lib/product-api"

const googleProvider: IdentityProvider = {
  alias: "google",
  preset: "google",
  display_name: "Google Workspace",
  kind: "OIDC",
  enabled: true,
  hidden_on_login_page: false,
  trust_email: false,
  client_id: "google-client",
  redirect_uri: "https://example.com/callback",
}

const locales = [
  { language: "en", copyLabel: "Copy Redirect URI", copyText: "Copy", copiedText: "Copied", errorText: "Could not copy Redirect URI. Try again or select and copy it manually." },
  { language: "zh-TW", copyLabel: "複製重新導向 URI", copyText: "複製", copiedText: "已複製", errorText: "無法複製重新導向 URI。請重試，或選取 URI 後手動複製。" },
] as const

function installEnvironment(providers: IdentityProvider[], writeText: (text: string) => Promise<void>) {
  const originalFetch = globalThis.fetch
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard")
  const requests: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = []
  let persistedProviders = [...providers]
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const method = input instanceof Request ? input.method : init?.method ?? "GET"
    const bodyText = input instanceof Request ? await input.clone().text() : String(init?.body ?? "")
    const body = bodyText ? JSON.parse(bodyText) as Record<string, unknown> : null
    const path = new URL(url, "http://localhost").pathname
    requests.push({ method, path, body })
    if (method === "POST") {
      const created = { ...googleProvider, client_id: String(body!.client_id) }
      persistedProviders = [...persistedProviders, created]
      return new Response(JSON.stringify(created), { headers: { "content-type": "application/json" } })
    }
    return new Response(JSON.stringify({ tenant_id: "test-tenant", realm: "genio-one", providers: persistedProviders }), { headers: { "content-type": "application/json" } })
  }) as typeof fetch
  return {
    requests,
    restore() {
      globalThis.fetch = originalFetch
      if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard)
      else Reflect.deleteProperty(navigator, "clipboard")
    },
  }
}

async function renderProviders(language: string) {
  const i18n = createInstance()
  await i18n.init({ lng: language, fallbackLng: "en", keySeparator: false, resources: productI18n.options.resources })
  render(
    <I18nextProvider i18n={i18n}>
      <SheetWorkspaceRoot>
        <IdentityProvidersCard tenantId="test-tenant" />
      </SheetWorkspaceRoot>
    </I18nextProvider>,
  )
  return i18n
}

for (const locale of locales) {
  test("an existing provider reports copy success only after the clipboard accepts its URI in " + locale.language, async () => {
    let resolveCopy: () => void = () => {}
    const pendingCopy = new Promise<void>((resolve) => { resolveCopy = resolve })
    const copied: string[] = []
    const environment = installEnvironment([googleProvider], async (text) => { copied.push(text); await pendingCopy })

    try {
      const i18n = await renderProviders(locale.language)
      expect(await screen.findByRole("button", { name: i18n.t("Remove {{name}}", { name: googleProvider.display_name }) })).toBeTruthy()
      fireEvent.click(await screen.findByRole("button", { name: i18n.t("Edit") }))
      const copyButton = await screen.findByRole("button", { name: locale.copyLabel })
      fireEvent.click(copyButton)

      expect(copyButton.textContent).toBe(locale.copyText)
      expect(copied).toEqual([googleProvider.redirect_uri])
      await act(async () => { resolveCopy() })
      await waitFor(() => expect(copyButton.textContent).toBe(locale.copiedText))
      expect(screen.queryByRole("alert")).toBeNull()
      expect(environment.requests.filter((request) => request.method !== "GET")).toEqual([])

      fireEvent.click(screen.getByRole("button", { name: i18n.t("Cancel") }))
      fireEvent.click(await screen.findByRole("button", { name: i18n.t("Edit") }))
      expect((await screen.findByRole("button", { name: locale.copyLabel })).textContent).toBe(locale.copyText)
    } finally {
      environment.restore()
    }
  })

  test("an existing provider preserves unsaved edits after copy rejection and can retry in " + locale.language, async () => {
    const copied: string[] = []
    let attempts = 0
    const environment = installEnvironment([googleProvider], async (text) => {
      attempts += 1
      if (attempts === 1) throw new DOMException("Clipboard permission denied", "NotAllowedError")
      copied.push(text)
    })

    try {
      const i18n = await renderProviders(locale.language)
      fireEvent.click(await screen.findByRole("button", { name: i18n.t("Edit") }))
      const secretInput = await screen.findByLabelText(i18n.t("Replace client secret")) as HTMLInputElement
      fireEvent.change(secretInput, { target: { value: "pending-secret" } })
      fireEvent.click(screen.getByRole("switch", { name: i18n.t("Enabled") }))
      const copyButton = screen.getByRole("button", { name: locale.copyLabel })
      fireEvent.click(copyButton)

      expect((await screen.findByRole("alert")).textContent).toBe(locale.errorText)
      expect(copyButton.textContent).toBe(locale.copyText)
      expect(secretInput.value).toBe("pending-secret")
      expect(screen.getByRole("switch", { name: i18n.t("Enabled") }).getAttribute("aria-checked")).toBe("false")
      const uriInput = screen.getByRole("textbox", { name: i18n.t("Redirect URI") }) as HTMLInputElement
      expect(uriInput.value).toBe(googleProvider.redirect_uri)
      expect(uriInput.readOnly).toBe(true)
      expect(environment.requests.filter((request) => request.method !== "GET")).toEqual([])

      fireEvent.click(copyButton)
      await waitFor(() => expect(copyButton.textContent).toBe(locale.copiedText))
      expect(screen.queryByRole("alert")).toBeNull()
      expect(secretInput.value).toBe("pending-secret")
      expect(copied).toEqual([googleProvider.redirect_uri])
      expect(attempts).toBe(2)
    } finally {
      environment.restore()
    }
  })

  test("a newly added provider remains saved when copy fails and allows retry in " + locale.language, async () => {
    const copied: string[] = []
    let attempts = 0
    const environment = installEnvironment([], async (text) => {
      attempts += 1
      if (attempts === 1) throw new DOMException("Clipboard permission denied", "NotAllowedError")
      copied.push(text)
    })

    try {
      const i18n = await renderProviders(locale.language)
      await screen.findByText(i18n.t("No identity provider is connected. People sign in with their GenioOne account only."))
      fireEvent.click(screen.getByRole("button", { name: "Google" }))
      fireEvent.change(await screen.findByLabelText(i18n.t("Client ID")), { target: { value: "new-google-client" } })
      fireEvent.change(screen.getByLabelText(i18n.t("Client secret")), { target: { value: "new-google-secret" } })
      fireEvent.click(screen.getByRole("button", { name: i18n.t("Add") }))
      const copyButton = await screen.findByRole("button", { name: locale.copyLabel })
      fireEvent.click(copyButton)

      expect((await screen.findByRole("alert")).textContent).toBe(locale.errorText)
      expect(copyButton.textContent).toBe(locale.copyText)
      expect((screen.getByRole("textbox", { name: i18n.t("Redirect URI") }) as HTMLInputElement).value).toBe(googleProvider.redirect_uri)
      expect(screen.getByText(i18n.t("Added. Allow this redirect URI with the provider:"))).toBeTruthy()
      expect(environment.requests.filter((request) => request.method === "POST")).toEqual([{
        method: "POST",
        path: "/v1/tenants/test-tenant/identity-providers",
        body: { preset: "google", client_id: "new-google-client", client_secret: "new-google-secret" },
      }])

      fireEvent.click(copyButton)
      await waitFor(() => expect(copyButton.textContent).toBe(locale.copiedText))
      expect(screen.queryByRole("alert")).toBeNull()
      expect(copied).toEqual([googleProvider.redirect_uri])
      expect(environment.requests.filter((request) => request.method === "POST")).toHaveLength(1)
      const footer = screen.getByRole("dialog").querySelector('[data-slot="sheet-footer"]') as HTMLElement
      fireEvent.click(within(footer).getByRole("button", { name: i18n.t("Close") }))
      await waitFor(() => expect(screen.queryByRole("button", { name: locale.copyLabel })).toBeNull())
      expect(await screen.findByText(googleProvider.display_name)).toBeTruthy()
      fireEvent.click(screen.getByRole("button", { name: "GitHub" }))
      expect(await screen.findByLabelText(i18n.t("Client ID"))).toBeTruthy()
      expect(screen.queryByRole("button", { name: locale.copyLabel })).toBeNull()
      expect(screen.queryByRole("alert")).toBeNull()
    } finally {
      environment.restore()
    }
  })
}

test("closing and reopening an edit sheet ignores an earlier pending copy result", async () => {
  let resolveCopy: () => void = () => {}
  const pendingCopy = new Promise<void>((resolve) => { resolveCopy = resolve })
  const environment = installEnvironment([googleProvider], async () => { await pendingCopy })

  try {
    const i18n = await renderProviders("en")
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("Edit") }))
    fireEvent.click(await screen.findByRole("button", { name: "Copy Redirect URI" }))
    fireEvent.click(screen.getByRole("button", { name: i18n.t("Cancel") }))
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("Edit") }))
    const copyButton = await screen.findByRole("button", { name: "Copy Redirect URI" })
    await act(async () => { resolveCopy() })
    expect(copyButton.textContent).toBe("Copy")
    expect(screen.queryByRole("alert")).toBeNull()
  } finally {
    environment.restore()
  }
})
