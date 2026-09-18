import { expect, test } from "bun:test"
import { preservePolicySteps } from "./policy-steps"

test("policy edits preserve authentication, unrelated obligations and observation placement", () => {
  const original = [
    { step_id: "authenticate", kind: "AUTHENTICATE", config: { issuer: "existing" } },
    { step_id: "authorize", kind: "AUTHORIZE", config: { required_obligations: ["custom", "execution.confirmation"], preserved: true } },
    { step_id: "observe", kind: "OBSERVE", hooks: { request: { action: "AUDIT" } } },
    { step_id: "route", kind: "ROUTE" },
  ]
  const result = preservePolicySteps(original.filter((step) => step.kind !== "OBSERVE"), original, false)
  expect(result.map((step) => step.step_id)).toEqual(["authenticate", "authorize", "observe", "route"])
  expect(result[0]?.config).toEqual({ issuer: "existing" })
  expect(result[1]?.config).toEqual({ required_obligations: ["custom"], preserved: true })
  expect(result[2]).toEqual(original[2])
})
