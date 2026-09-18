import { describe, expect, test } from "bun:test"
import { render, screen } from "@testing-library/react"

import { Button } from "@/components/ui/button"

/**
 * DESIGN.md states 「控制列高度 44px…互動控制本身仍維持 44px 命中區」 and
 * 「密度由留白與資料列調整」: 44px is a hit-target floor every control keeps,
 * and density comes from padding and type rather than from a shorter button.
 */
describe("Button sizes", () => {
  const sizes = ["xs", "sm", "default", "lg"] as const

  test("every size keeps the 44px hit target", () => {
    render(
      <>
        {sizes.map((size) => (
          <Button key={size} size={size}>{size}</Button>
        ))}
      </>,
    )

    for (const size of sizes) {
      const className = screen.getByRole("button", { name: size }).className
      // A per-size height would override the floor and shrink the touch target.
      expect(className).toContain("min-h-11")
      expect(className).not.toMatch(/\bh-(?!11\b)\d+\b/)
    }
  })

  test("sizes still differ, through padding rather than height", () => {
    render(
      <>
        {sizes.map((size) => (
          <Button key={size} size={size}>{size}</Button>
        ))}
      </>,
    )

    const padding = sizes.map(
      (size) => screen.getByRole("button", { name: size }).className.match(/\bpx-[\d.]+\b/)?.[0],
    )
    // Collapsing these to one value is what makes the size prop meaningless.
    expect(new Set(padding).size).toBe(sizes.length)
  })
})
