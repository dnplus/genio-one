import { describe, expect, test } from "bun:test"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { GuidedSetupSteps, type GuidedSetupStep } from "@/components/guided-setup-steps"

describe("GuidedSetupSteps", () => {
  const mockSteps: GuidedSetupStep[] = [
    { id: "step-1", label: "Select Connector", status: "complete" },
    { id: "step-2", label: "Configure Credentials", description: "Provide API key and endpoint URL", status: "current" },
    { id: "step-3", label: "Verify Connection", status: "upcoming" },
  ]

  test("renders buttons with accessible aria-label formatting step index and title", () => {
    render(<GuidedSetupSteps activeStepId="step-2" onSelect={() => {}} steps={mockSteps} />)

    const step1Button = screen.getByRole("button", { name: "1. Select Connector" })
    const step2Button = screen.getByRole("button", { name: "2. Configure Credentials" })
    const step3Button = screen.getByRole("button", { name: "3. Verify Connection" })

    expect(step1Button).toBeTruthy()
    expect(step2Button).toBeTruthy()
    expect(step3Button).toBeTruthy()
  })

  test("keeps a short visible label for each step in narrow layouts", () => {
    render(<GuidedSetupSteps activeStepId="step-2" onSelect={() => {}} steps={mockSteps} />)

    for (const [index, step] of mockSteps.entries()) {
      const stepButton = screen.getByRole("button", { name: `${index + 1}. ${step.label}` })
      const label = stepButton.querySelector('[data-slot="item-title"]')
      const labelContainer = label?.closest('[data-slot="item-content"]')

      expect(label?.textContent).toBe(step.label)
      expect(label?.className).toContain("w-full")
      expect(label?.className).toContain("text-xs")
      expect(labelContainer?.className).toContain("min-w-0")
      expect(labelContainer?.className).not.toContain("hidden")
    }
  })

  test("sets aria-current='step' only on active step button", () => {
    render(<GuidedSetupSteps activeStepId="step-2" onSelect={() => {}} steps={mockSteps} />)

    const step1Button = screen.getByRole("button", { name: "1. Select Connector" })
    const step2Button = screen.getByRole("button", { name: "2. Configure Credentials" })

    expect(step1Button.getAttribute("aria-current")).toBeNull()
    expect(step2Button.getAttribute("aria-current")).toBe("step")
  })

  test("calls onSelect with step id when step button is clicked", async () => {
    let selectedId = ""
    const user = userEvent.setup()

    render(
      <GuidedSetupSteps
        activeStepId="step-1"
        onSelect={(id) => {
          selectedId = id
        }}
        steps={mockSteps}
      />
    )

    const step3Button = screen.getByRole("button", { name: "3. Verify Connection" })
    await user.click(step3Button)

    expect(selectedId).toBe("step-3")
  })
})
