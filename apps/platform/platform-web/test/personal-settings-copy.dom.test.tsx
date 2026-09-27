import { expect, test } from "bun:test"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import { PersonalSettingsPage } from "@/features/personal-settings/personal-settings-page"

test("copy feedback follows the issued key, not a revoked key", async () => {
  const user = userEvent.setup()
  const clipboard = navigator.clipboard
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async () => {} },
  })
  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: {} } } })

  try {
    render(
      <I18nextProvider i18n={i18n}>
        <PersonalSettingsPage
          identity={{ tenant_id: "tenant-acme", subject_id: "person-admin", acting_client_id: "management-ui", role: "TENANT_ADMINISTRATOR", scopes: [], acr: null, amr: [] }}
          mockMode
        />
      </I18nextProvider>,
    )

    await user.click(screen.getByRole("button", { name: "Revoke" }))
    await user.click(screen.getByRole("button", { name: "Revoke API key" }))
    await user.click(screen.getByRole("button", { name: "Create API key" }))
    const firstSecret = (screen.getByRole("textbox", { name: "One-time API key" }) as HTMLInputElement).value
    await user.click(screen.getByRole("button", { name: "Copy" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy())

    await user.click(screen.getByRole("button", { name: "Revoke" }))
    await user.click(screen.getByRole("button", { name: "Revoke API key" }))
    await user.click(screen.getByRole("button", { name: "Create API key" }))

    expect((screen.getByRole("textbox", { name: "One-time API key" }) as HTMLInputElement).value).not.toBe(firstSecret)
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull()
  } finally {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard })
  }
})
