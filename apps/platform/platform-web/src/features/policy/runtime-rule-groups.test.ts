import { expect, test } from "bun:test"
import type { RuntimePolicyRule } from "@/lib/product-api"
import { canEditHandsPlacement, groupRuntimeRules, hasHandsPlacement, sharedConstraintsForRuntimeRule, updateSharedRuleSettings } from "./runtime-rule-groups"

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

test("shared edits retain placement only on the Hands rule", () => {
  const hands: RuntimePolicyRule = { ...subscription, rule_id: "hands", target: { runtime_id: "codex", capability_id: "remote_hands.use" }, constraints: [{ kind: "execution_placement", parameters: { execution_domain: "MANAGED_CLOUD" } }] }
  const next = updateSharedRuleSettings([hands, model], ["hands", "model"], { ...hands, obligations: [] })
  expect(next[0]?.constraints).toEqual(hands.constraints)
  expect(next[1]?.constraints).toEqual([])
  expect(sharedConstraintsForRuntimeRule(hands, model)).toEqual([])
  expect(sharedConstraintsForRuntimeRule(model, hands)).toEqual(hands.constraints)
})

test("placement editing requires a standalone ALLOW use rule", () => {
  const useRule: RuntimePolicyRule = { ...subscription, target: { runtime_id: "codex", capability_id: "remote_hands.use" } }
  expect(canEditHandsPlacement(useRule)).toBe(true)
  expect(canEditHandsPlacement({ ...useRule, actions: ["expose", "use"] })).toBe(false)
  expect(canEditHandsPlacement({ ...useRule, effect: "DENY" })).toBe(false)
  expect(canEditHandsPlacement({ ...useRule, actions: ["expose"] })).toBe(false)
  expect(hasHandsPlacement({ ...useRule, constraints: [{ kind: "execution_placement", parameters: { execution_domain: "ON_PREM" } }] })).toBe(true)
})
