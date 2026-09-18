import { expect, test } from "bun:test"

import { cn } from "@/lib/utils"

test("keeps text-ui alongside a text color and lets explicit font sizes replace it", () => {
  expect(cn("text-ui", "text-primary-foreground")).toBe("text-ui text-primary-foreground")
  expect(cn("text-ui", "text-xs")).toBe("text-xs")
})
