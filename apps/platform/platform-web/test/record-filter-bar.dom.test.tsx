import { expect, test } from "bun:test"
import { useState } from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createInstance } from "i18next"
import { I18nextProvider } from "react-i18next"

import { RecordFilterBar } from "@/components/data-table/record-filter-bar"

test("record filters show readable labels before opening and after changing or clearing a selection", async () => {
  const i18n = createInstance()
  await i18n.init({ lng: "en", resources: { en: { translation: {} } } })
  const selected: string[] = []
  function Filters() {
    const [value, setValue] = useState("ACTIVE")
    return <RecordFilterBar filters={[{
      id: "visibility",
      label: "Visibility",
      allLabel: "All visibility",
      value,
      options: [{ value: "ACTIVE", label: "In use" }, { value: "ARCHIVED", label: "Archived" }],
      onValueChange: (next) => { selected.push(next); setValue(next) },
    }]} />
  }
  render(<I18nextProvider i18n={i18n}><Filters /></I18nextProvider>)
  const trigger = screen.getByRole("combobox", { name: "Visibility" })
  expect(trigger.textContent).toContain("In use")
  expect(trigger.textContent).not.toContain("ACTIVE")

  const user = userEvent.setup()
  await user.click(trigger)
  await user.click(await screen.findByRole("option", { name: "Archived" }))
  await waitFor(() => expect(trigger.textContent).toContain("Archived"))
  expect(selected).toEqual(["ARCHIVED"])

  await user.click(screen.getByRole("button", { name: "Clear filters" }))
  await waitFor(() => expect(trigger.textContent).toContain("All visibility"))
  expect(selected).toEqual(["ARCHIVED", "ALL"])
})
