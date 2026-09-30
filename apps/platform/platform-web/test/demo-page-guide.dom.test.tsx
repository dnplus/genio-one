import { expect, test } from "bun:test"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import { DemoPageGuide } from "@/components/demo-page-guide"

async function renderGuide(props: React.ComponentProps<typeof DemoPageGuide>) {
  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
  render(<I18nextProvider i18n={i18n}><DemoPageGuide {...props} /></I18nextProvider>)
}

test("T1 demo guide shows the active step and navigates to adjacent pages", async () => {
  const user = userEvent.setup()
  const navigated: string[] = []
  await renderGuide({
    activePage: "resources",
    tier: "T1",
    onDismiss: () => {},
    onNavigate: (page) => navigated.push(page),
  })

  expect(screen.getByText("Demo guide: Resources")).toBeTruthy()
  expect(screen.getByText("Demo T1")).toBeTruthy()
  expect(screen.getByText("Step 2 of 21")).toBeTruthy()
  expect(screen.getByRole("progressbar", { name: "Demo guide progress" })).toBeTruthy()

  await user.click(screen.getByRole("button", { name: "Previous" }))
  await user.click(screen.getByRole("button", { name: "Next" }))
  expect(navigated).toEqual(["overview", "connections"])
})

test("T2 demo guide keeps its adjacent navigation and can be dismissed", async () => {
  const user = userEvent.setup()
  const navigated: string[] = []
  let dismissed = false
  await renderGuide({
    activePage: "product-docs",
    tier: "T2",
    onDismiss: () => { dismissed = true },
    onNavigate: (page) => navigated.push(page),
  })

  expect(screen.getByText("Demo guide: Product documentation")).toBeTruthy()
  expect(screen.getByText("Demo T2")).toBeTruthy()
  expect(screen.getByText("Step 20 of 21")).toBeTruthy()

  await user.click(screen.getByRole("button", { name: "Previous" }))
  await user.click(screen.getByRole("button", { name: "Next" }))
  await user.click(screen.getByRole("button", { name: "Hide guide" }))
  expect(navigated).toEqual(["personal-settings", "api-docs"])
  expect(dismissed).toBe(true)
})
