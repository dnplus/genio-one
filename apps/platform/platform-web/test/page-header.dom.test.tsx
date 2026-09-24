import { describe, expect, test } from "bun:test"
import { render, screen } from "@testing-library/react"
import { createInstance } from "i18next"
import type { ReactNode } from "react"
import { I18nextProvider } from "react-i18next"

import { PageHeader } from "@/components/page-header"

// An icon-only back button has no visible text, so its aria-label is the only
// thing a screen reader announces. Every onBack header must name its target.
async function renderHeader(node: ReactNode, language: "en" | "zh-TW" = "en") {
  const i18n = createInstance()
  await i18n.init({
    lng: language,
    fallbackLng: "en",
    keySeparator: false,
    interpolation: { escapeValue: false },
    resources: {
      en: { translation: {} },
      "zh-TW": { translation: { "Go back": "返回上一頁", "Go back to {{title}}": "返回「{{title}}」" } },
    },
  })
  render(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>)
}

describe("PageHeader", () => {
  test("uses custom backLabel when provided", async () => {
    await renderHeader(<PageHeader title="Settings" onBack={() => {}} backLabel="Back to Dashboard" />)
    expect(screen.getByRole("button", { name: "Back to Dashboard" })).toBeTruthy()
  })

  test("derives default back label from string title when backLabel is omitted", async () => {
    await renderHeader(<PageHeader title="Settings" onBack={() => {}} />)
    expect(screen.getByRole("button", { name: "Go back to Settings" })).toBeTruthy()
  })

  test("falls back to generic 'Go back' when title is ReactNode and backLabel is omitted", async () => {
    await renderHeader(<PageHeader title={<span>Settings</span>} onBack={() => {}} />)
    expect(screen.getByRole("button", { name: "Go back" })).toBeTruthy()
  })

  test("translates the derived back label", async () => {
    await renderHeader(<PageHeader title="設定" onBack={() => {}} />, "zh-TW")
    expect(screen.getByRole("button", { name: "返回「設定」" })).toBeTruthy()
  })

  test("renders no back button without onBack", async () => {
    await renderHeader(<PageHeader title="Settings" />)
    expect(screen.queryByRole("button")).toBeNull()
  })
})
