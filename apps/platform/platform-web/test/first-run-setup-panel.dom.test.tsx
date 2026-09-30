import { expect, test } from "bun:test"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import { FirstRunSetupPanel } from "@/features/overview/first-run-setup-panel"
import { createMockOverview } from "@/mocks/overview"

async function renderPanel(props: Omit<React.ComponentProps<typeof FirstRunSetupPanel>, "tenantId">) {
  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
  render(
    <I18nextProvider i18n={i18n}>
      <FirstRunSetupPanel tenantId="tenant-design-preview" {...props} />
    </I18nextProvider>,
  )
}

test("first-run verification expands missing evidence and refreshes that evidence", async () => {
  const user = userEvent.setup()
  const data = createMockOverview()
  let refreshes = 0
  data.auditEvents = []
  data.activity = { ...data.activity, recent_activity: [] }
  data.apiActivity = { events: [] }

  await renderPanel({
    data,
    description: "An attributed invocation links Activity and Audit",
    onRefresh: async () => { refreshes += 1 },
    stepId: "verify",
    title: "Verify access and audit",
  })

  const panel = screen.getByTestId("first-run-verify-panel")
  const evidence = within(panel).getByRole("button", { name: /No attributed invocation/ })
  expect(evidence.getAttribute("aria-expanded")).toBe("false")
  expect(within(panel).getByText("Needs setup")).toBeTruthy()

  await user.click(evidence)

  expect(evidence.getAttribute("aria-expanded")).toBe("true")
  expect(within(panel).getByText("This evidence is missing. Use the row action to open its setup or management page.")).toBeTruthy()

  const refreshActions = within(panel).getAllByRole("button", { name: "Refresh evidence" })
  await user.click(refreshActions.at(-1)!)
  await waitFor(() => expect(refreshes).toBe(1))
})

test("first-run Resource setup opens the Resource Draft child flow when no Resource exists", async () => {
  const data = createMockOverview()
  data.resources = []
  data.connections = []

  await renderPanel({
    data,
    description: "Governed Resource with a usable Connection",
    onRefresh: async () => {},
    stepId: "resource",
    title: "Resource and Connection",
  })

  const creator = screen.getByTestId("first-run-resource-creator")
  expect(within(creator).getByTestId("resource-onboarding-wizard")).toBeTruthy()
  expect(within(creator).getByRole("heading", { name: "Add resource" })).toBeTruthy()
  expect(within(creator).getByText("Create a Resource Draft. Connections are registered later only for types that talk to an upstream.")).toBeTruthy()
})
