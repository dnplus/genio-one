import { expect, test } from "bun:test"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import { ProductDocumentationPage } from "@/features/product-docs/product-documentation-page"

async function renderDocumentation() {
  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
  render(<I18nextProvider i18n={i18n}><ProductDocumentationPage /></I18nextProvider>)
}

test("Product documentation switches documents, filters the index, and renders Markdown diagrams", async () => {
  const user = userEvent.setup()
  const originalUrl = window.location.href
  window.history.replaceState({}, "", "/management?view=product-docs&doc=overview")

  try {
    await renderDocumentation()

    expect(screen.getByRole("heading", { name: "Product documentation" })).toBeTruthy()
    expect(screen.getByRole("heading", { name: "GenioOne product concept" })).toBeTruthy()
    expect(screen.getByRole("columnheader", { name: "Component" })).toBeTruthy()
    await waitFor(() => expect(screen.getAllByRole("img", { name: "Product diagram" }).length).toBe(2))

    await user.click(screen.getByRole("button", { name: /Initial setup/ }))
    await waitFor(() => expect(screen.getByRole("heading", { name: "Initial setup" })).toBeTruthy())
    expect(new URL(window.location.href).searchParams.get("doc")).toBe("initial-setup")

    const search = screen.getByRole("searchbox", { name: "Search documentation" })
    await user.clear(search)
    await user.type(search, "Daily review")
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Operations guide/ })).toBeTruthy()
      expect(screen.queryByRole("button", { name: /Product concept/ })).toBeNull()
    })

    await user.clear(search)
    await user.type(search, "no matching guide")
    await waitFor(() => expect(screen.getByText("No matching documents")).toBeTruthy())
  } finally {
    window.history.replaceState({}, "", originalUrl)
  }
})
