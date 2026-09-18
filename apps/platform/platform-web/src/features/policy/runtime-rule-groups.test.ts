import { expect, test } from "bun:test"
import type { RuntimePolicyRule } from "@/lib/product-api"
import { groupRuntimeRules, updateSharedRuleSettings } from "./runtime-rule-groups"

const model: RuntimePolicyRule = { rule_id: "model", target: { runtime_id: "codex", capability_id: "model.invoke" }, actions: ["invoke"], effect: "ALLOW", constraints: [], obligations: [{ kind: "audit", parameters: {} }] }
const subscription: RuntimePolicyRule = { ...model, rule_id: "subscription", target: { runtime_id: "codex", capability_id: "codex.subscription" }, actions: ["use"] }

test("different explicit operations share limits without granting discovery or losing actions", () => {
  const rules = [model, subscription]
  const groups = groupRuntimeRules(rules)
  expect(groups).toEqual([["model", "subscription"]])
  const next = updateSharedRuleSettings(rules, groups[0]!, { ...model, constraints: [{ kind: "approval_required", parameters: { enabled: true } }], obligations: [] })
  expect(next.map((rule) => rule.actions)).toEqual([["invoke"], ["use"]])
  expect(next.every((rule) => rule.constraints[0]?.kind === "approval_required")).toBe(true)
  expect(next.every((rule) => rule.obligations.length === 0)).toBe(true)
  expect(rules[0]!.obligations).toHaveLength(1)
})

test("explicit individual settings stay in the group and survive shared edits", () => {
  const exception: RuntimePolicyRule = { ...subscription, group_id: "team", individual_settings: true, effect: "DENY" }
  const rules: RuntimePolicyRule[] = [{ ...model, group_id: "team" }, exception]
  expect(groupRuntimeRules(rules)).toEqual([["model", "subscription"]])
  const next = updateSharedRuleSettings(rules, ["model", "subscription"], { ...model, effect: "DENY", obligations: [] })
  expect(next[0]!.effect).toBe("DENY")
  expect(next[1]).toEqual(exception)
})
