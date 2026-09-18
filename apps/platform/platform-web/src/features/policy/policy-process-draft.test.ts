import { expect, test } from "bun:test"
import { executableStep, processSteps } from "./policy-process-draft"

test("editing a processing rule preserves other patterns and operational configuration", () => {
  const original = { step_id: "redact", hooks: { request: { action: "REDACT" as const, config: { patterns: [{ name: "EMAIL", expression: "old", flags: "g" }, { name: "PHONE", expression: "keep", flags: "g" }], token_ttl_seconds: 123, custom_rule: "keep" } } } }
  const source = { chain: { steps: [{ kind: "PROCESS" as const, ...original }] } }
  const draft = processSteps(source)[0]!
  expect(executableStep(draft)).toEqual(original)
  const edited = executableStep({ ...draft, changed: true, expression: "new" })
  expect(edited.hooks.request?.config?.patterns).toEqual([{ name: "EMAIL", expression: "new", flags: "g" }, { name: "PHONE", expression: "keep", flags: "g" }])
  expect(edited.hooks.request?.config?.token_ttl_seconds).toBe(123)
  expect(edited.hooks.request?.config?.custom_rule).toBe("keep")
})
