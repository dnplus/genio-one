import type { RuntimePolicyRule } from "@/lib/product-api"

export function groupRuntimeRules(rules: RuntimePolicyRule[]): string[][] {
  const groups = new Map<string, string[]>()
  for (const rule of rules) {
    const key = rule.group_id ?? JSON.stringify([rule.target.runtime_id, rule.effect, rule.constraints, rule.obligations])
    groups.set(key, [...(groups.get(key) ?? []), rule.rule_id])
  }
  return [...groups.values()]
}

export function sharedConstraintsForRuntimeRule(source: RuntimePolicyRule, target: RuntimePolicyRule): RuntimePolicyRule["constraints"] {
  return [
    ...structuredClone(source.constraints.filter((constraint) => constraint.kind !== "execution_placement")),
    ...structuredClone(target.constraints.filter((constraint) => constraint.kind === "execution_placement")),
  ]
}

export function hasHandsPlacement(rule: RuntimePolicyRule): boolean {
  return rule.constraints.some((constraint) => constraint.kind === "execution_placement")
}

export function canEditHandsPlacement(rule: RuntimePolicyRule): boolean {
  return rule.target.runtime_id === "codex" && rule.target.capability_id === "remote_hands.use" &&
    rule.effect === "ALLOW" && rule.actions.length === 1 && rule.actions[0] === "use"
}

export function updateSharedRuleSettings(rules: RuntimePolicyRule[], ids: string[], settings: RuntimePolicyRule): RuntimePolicyRule[] {
  return rules.map((rule) => ids.includes(rule.rule_id) && !rule.individual_settings
    ? { ...rule, effect: settings.effect, constraints: sharedConstraintsForRuntimeRule(settings, rule), obligations: structuredClone(settings.obligations) }
    : rule)
}
