import { describe, expect, test } from "bun:test"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  SheetWorkspaceRoot,
} from "@/components/ui/sheet"

/**
 * The default workspace presentation portals into the SheetWorkspaceRoot the
 * app provides, so the tests render inside one as the app does.
 */
function ExampleSheet({
  presentation = "workspace",
}: { presentation?: "workspace" | "side" } = {}) {
  return (
    <SheetWorkspaceRoot>
    <Sheet>
      <SheetTrigger asChild>
        <Button>Register</Button>
      </SheetTrigger>
      <SheetContent presentation={presentation}>
        <SheetHeader>
          <SheetTitle>Register Gateway</SheetTitle>
          <SheetDescription>Give the runtime a display name.</SheetDescription>
        </SheetHeader>
        <Button>Save</Button>
      </SheetContent>
    </Sheet>
    </SheetWorkspaceRoot>
  )
}

describe("Sheet", () => {
  test("opens on click and names itself from its title and description", async () => {
    const user = userEvent.setup()
    render(<ExampleSheet />)

    await user.click(screen.getByRole("button", { name: "Register" }))

    const dialog = await waitFor(() => screen.getByRole("dialog"))
    const labelledBy = dialog.getAttribute("aria-labelledby")
    const describedBy = dialog.getAttribute("aria-describedby")
    expect(document.getElementById(labelledBy!)?.textContent).toBe("Register Gateway")
    expect(document.getElementById(describedBy!)?.textContent).toBe("Give the runtime a display name.")
  })

  test("renders its close affordance as a real button", async () => {
    const user = userEvent.setup()
    render(<ExampleSheet />)

    await user.click(screen.getByRole("button", { name: "Register" }))
    await waitFor(() => screen.getByRole("dialog"))

    // Composing Close onto a non-button element would strip native button
    // semantics from the only way to dismiss the sheet.
    const close = screen.getByRole("button", { name: "Close" })
    expect(close.tagName).toBe("BUTTON")
  })

  test("closes from its close button and restores focus to the trigger", async () => {
    const user = userEvent.setup()
    render(<ExampleSheet />)

    const trigger = screen.getByRole("button", { name: "Register" })
    await user.click(trigger)
    await waitFor(() => screen.getByRole("dialog"))

    await user.click(screen.getByRole("button", { name: "Close" }))

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  test("closes on Escape", async () => {
    const user = userEvent.setup()
    render(<ExampleSheet />)

    await user.click(screen.getByRole("button", { name: "Register" }))
    await waitFor(() => screen.getByRole("dialog"))

    await user.keyboard("{Escape}")

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  test("the side presentation opens outside a workspace root", async () => {
    const user = userEvent.setup()
    render(<ExampleSheet presentation="side" />)

    await user.click(screen.getByRole("button", { name: "Register" }))

    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy())
  })
})
