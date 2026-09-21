import { describe, expect, test } from "bun:test"
import { render, screen } from "@testing-library/react"

import { TitleHelp } from "@/components/title-help"

describe("TitleHelp", () => {
  test("generates contextual aria-label from string title", () => {
    render(<TitleHelp help="Extra information">Audit logs</TitleHelp>)

    const button = screen.getByRole("button", { name: "Help for Audit logs" })
    expect(button).toBeTruthy()
  })

  test("uses custom label when provided", () => {
    render(
      <TitleHelp help="Extra information" label="Custom help text">
        Audit logs
      </TitleHelp>
    )

    const button = screen.getByRole("button", { name: "Custom help text" })
    expect(button).toBeTruthy()
  })
})
