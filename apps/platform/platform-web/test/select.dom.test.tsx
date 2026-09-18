import { describe, expect, test } from "bun:test"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

function ControlledSelect({ onChange }: { onChange?: (value: string) => void } = {}) {
  return (
    <Select defaultValue="alpha" onValueChange={onChange}>
      <SelectTrigger aria-label="Environment">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="alpha">Alpha</SelectItem>
        <SelectItem value="beta">Beta</SelectItem>
        <SelectItem value="gamma">Gamma</SelectItem>
      </SelectContent>
    </Select>
  )
}

describe("Select", () => {
  test("opens from the keyboard and exposes the listbox to assistive technology", async () => {
    const user = userEvent.setup()
    render(<ControlledSelect />)

    const trigger = screen.getByRole("combobox", { name: "Environment" })
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox")

    trigger.focus()
    await user.keyboard("{Enter}")

    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy())
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
  })

  test("reports the chosen value as a string to the caller", async () => {
    const user = userEvent.setup()
    let selected: string | undefined
    render(<ControlledSelect onChange={(value) => { selected = value }} />)

    await user.click(screen.getByRole("combobox", { name: "Environment" }))
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy())
    await user.click(screen.getByRole("option", { name: "Beta" }))

    // The wrapper pins Base UI's unknown value to a string for every call site.
    await waitFor(() => expect(selected).toBe("beta"))
    expect(typeof selected).toBe("string")
  })

  test("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup()
    render(<ControlledSelect />)

    const trigger = screen.getByRole("combobox", { name: "Environment" })
    await user.click(trigger)
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy())

    await user.keyboard("{Escape}")

    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })
})
