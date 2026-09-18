import type { RuntimePolicyRule } from "@/lib/product-api"

export function groupRuntimeRules(rules: RuntimePolicyRule[]): string[][] {
  const groups = new Map<string, string[]>()
  for (const rule of rules) {
    const key = rule.group_id ?? JSON.stringify([rule.target.runtime_id, rule.effect, rule.constraints, rule.obligations])
    groups.set(key, [...(groups.get(key) ?? []), rule.rule_id])
  }
  return [...groups.values()]
}

export function updateSharedRuleSettings(rules: RuntimePolicyRule[], ids: string[], settings: RuntimePolicyRule): RuntimePolicyRule[] {
  return rules.map((rule) => ids.includes(rule.rule_id) && !rule.individual_settings
    ? { ...rule, effect: settings.effect, constraints: structuredClone(settings.constraints), obligations: structuredClone(settings.obligations) }
    : rule)
}
