import { describe, expect, test } from "bun:test"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"

function ExampleDialog() {
  return (
    <Dialog>
      {/* asChild is the spelling every call site uses; it must survive Base UI. */}
      <DialogTrigger asChild>
        <Button>Open</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Suspend access</DialogTitle>
          <DialogDescription>This person stops being able to sign in.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button>Confirm</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

describe("Dialog", () => {
  test("renders the trigger as its child rather than nesting a second button", async () => {
    render(<ExampleDialog />)

    const triggers = screen.getAllByRole("button", { name: "Open" })
    expect(triggers).toHaveLength(1)
    // Composition, not wrapping: the Button is the trigger.
    expect(triggers[0]!.tagName).toBe("BUTTON")
    expect(triggers[0]!.querySelector("button")).toBeNull()
  })

  test("opens on click and names itself from its title and description", async () => {
    const user = userEvent.setup()
    render(<ExampleDialog />)

    await user.click(screen.getByRole("button", { name: "Open" }))

    const dialog = await waitFor(() => screen.getByRole("dialog"))
    const labelledBy = dialog.getAttribute("aria-labelledby")
    const describedBy = dialog.getAttribute("aria-describedby")
    expect(labelledBy).toBeTruthy()
    expect(document.getElementById(labelledBy!)?.textContent).toBe("Suspend access")
    expect(document.getElementById(describedBy!)?.textContent)
      .toBe("This person stops being able to sign in.")
  })

  test("moves focus into the dialog and restores it to the trigger on Escape", async () => {
    const user = userEvent.setup()
    render(<ExampleDialog />)

    const trigger = screen.getByRole("button", { name: "Open" })
    await user.click(trigger)

    const dialog = await waitFor(() => screen.getByRole("dialog"))
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))

    await user.keyboard("{Escape}")

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    // Losing the trigger on close strands keyboard users, so this is asserted.
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  test("keeps Tab inside the dialog while it is open", async () => {
    const user = userEvent.setup()
    render(<ExampleDialog />)

    await user.click(screen.getByRole("button", { name: "Open" }))
    const dialog = await waitFor(() => screen.getByRole("dialog"))

    for (let press = 0; press < 5; press += 1) {
      await user.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
  })
})
