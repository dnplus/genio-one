import { expect, test } from "bun:test"
import { render, screen } from "@testing-library/react"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import "./dom-setup"
import { IdentityProvidersCard } from "@/features/identity/identity-providers-card"

test("IdentityProvidersCard renders remove button with contextual ARIA label", async () => {
  const i18n = createInstance()
  await i18n.init({
    lng: "en",
    resources: {
      en: {
        translation: {
          "Remove {{name}}": "Remove {{name}}",
        },
      },
    },
  })

  // Mock fetch for listIdentityProviders
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string) => {
    if (url.includes("/identity-providers")) {
      return new Response(
        JSON.stringify({
          providers: [
            {
              alias: "google",
              preset: "google",
              display_name: "Google Workspace",
              kind: "OIDC",
              enabled: true,
              hidden_on_login_page: false,
              redirect_uri: "https://example.com/callback",
            },
          ],
        }),
        { headers: { "Content-Type": "application/json" } },
      )
    }
    return new Response(JSON.stringify({}), { headers: { "Content-Type": "application/json" } })
  }) as typeof globalThis.fetch

  try {
    render(
      <I18nextProvider i18n={i18n}>
        <IdentityProvidersCard tenantId="test-tenant" />
      </I18nextProvider>
    )
    const removeButton = await screen.findByRole("button", { name: "Remove Google Workspace" })
    expect(removeButton).toBeTruthy()
  } finally {
    globalThis.fetch = originalFetch
  }
})
