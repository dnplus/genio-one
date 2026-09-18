import assert from "node:assert/strict"
import test from "node:test"

import { CE_DEMO_PROJECT_BRIEF, CE_DEMO_PROMPTS } from "./ce-demo"

test("the product brief starter explicitly attaches the installed write-spec skill", () => {
  const prompt = CE_DEMO_PROMPTS.find((entry) => entry.id === "spec-and-diagram")
  assert.ok(prompt)
  assert.ok(prompt.text.startsWith("@product-management:write-spec\n"))
  assert.ok(prompt.text.includes(CE_DEMO_PROJECT_BRIEF))
  assert.match(prompt.text, /If the skill content is unavailable, stop/)
})
