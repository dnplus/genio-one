import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldLabel } from "@/components/ui/field"
import { SearchableSelect, type SearchableSelectOption } from "@/components/ui/searchable-select"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { RuntimePolicyRule } from "@/lib/product-api"
import { runtimeCapabilityActions } from "@genioone/protocol/runtime-capability-actions"
import { groupRuntimeRules, updateSharedRuleSettings } from "./runtime-rule-groups"

function RuntimeChoice({ disabled, ...props }: Parameters<typeof SearchableSelect>[0] & { disabled: boolean }) {
  if (disabled) return <p className="text-sm">{props.options.find((option) => option.value === props.value)?.label ?? props.value}</p>
  return <SearchableSelect {...props} />
}

function Settings({ rule, disabled, onChange }: { rule: RuntimePolicyRule; disabled: boolean; onChange: (rule: RuntimePolicyRule) => void }) {
  const { t } = useTranslation()
  return <div className="space-y-4">
    <Field><FieldLabel>{t("Effect")}</FieldLabel><Select disabled={disabled} value={rule.effect} onValueChange={(effect) => onChange({ ...rule, effect: effect as RuntimePolicyRule["effect"] })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ALLOW">{t("ALLOW")}</SelectItem><SelectItem value="DENY">{t("DENY")}</SelectItem></SelectContent></Select></Field>
    <label className="flex items-center gap-2 text-sm"><Checkbox disabled={disabled} checked={rule.obligations.some((value) => value.kind === "audit")} onCheckedChange={(checked) => onChange({ ...rule, obligations: checked === true ? rule.obligations.some((value) => value.kind === "audit") ? rule.obligations : [...rule.obligations, { kind: "audit", parameters: {} }] : rule.obligations.filter((value) => value.kind !== "audit") })} />{t("Record usage activity")}</label>
  </div>
}

export function RuntimeCapabilityGroups({ rules, scopeRuntimeIds, runtimeOptions, capabilityOptions, disabled, onChange }: {
  rules: RuntimePolicyRule[]
  scopeRuntimeIds: string[]
  runtimeOptions: SearchableSelectOption[]
  capabilityOptions: SearchableSelectOption[]
  disabled: boolean
  onChange: (rules: RuntimePolicyRule[]) => void
}) {
  const { t } = useTranslation()
  const groups = groupRuntimeRules(rules)
  const scopedRuntimeOptions = scopeRuntimeIds.length ? runtimeOptions.filter((option) => scopeRuntimeIds.includes(option.value)) : runtimeOptions
  const exceptions = rules.filter((rule) => rule.individual_settings).map((rule) => rule.rule_id)
  function emit(next: RuntimePolicyRule[]) {
    onChange(next.map((rule) => ({ ...rule, group_id: rule.group_id ?? groups.find((group) => group.includes(rule.rule_id))?.[0] ?? rule.rule_id })))
  }
  function updateGroup(ids: string[], value: RuntimePolicyRule) {
    emit(updateSharedRuleSettings(rules, ids, value))
  }
  function addGroup() {
    const rule: RuntimePolicyRule = { rule_id: crypto.randomUUID(), target: { runtime_id: scopeRuntimeIds.length === 1 ? scopeRuntimeIds[0]! : runtimeOptions[0]?.value ?? "codex", capability_id: "" }, actions: [], effect: "DENY", constraints: [], obligations: [{ kind: "audit", parameters: {} }] }
    emit([...rules, rule])
  }
  return <div className="space-y-4">
    <div className="flex items-center justify-between"><h3 className="font-medium">{t("Capability groups")}</h3><Button disabled={disabled} variant="outline" onClick={addGroup}>{t("Add capability group")}</Button></div>
    {!groups.length ? <p className="rounded border border-dashed p-4 text-sm text-muted-foreground">{t("Select capabilities, then configure their shared permissions.")}</p> : null}
    {groups.map((ids, groupIndex) => {
      const members = ids.map((id) => rules.find((rule) => rule.rule_id === id)).filter((rule): rule is RuntimePolicyRule => Boolean(rule))
      const common = members.find((rule) => !exceptions.includes(rule.rule_id)) ?? members[0]!
      const commonMembers = members.filter((rule) => !exceptions.includes(rule.rule_id))
      return <section key={ids[0]} className="space-y-4 rounded-lg border p-4">
        <div className="flex items-center justify-between"><h4 className="font-medium">{t("Capability group")} {groupIndex + 1}</h4><Button disabled={disabled} variant="ghost" onClick={() => { emit(rules.filter((rule) => !ids.includes(rule.rule_id))) }}>{t("Remove")}</Button></div>
        <p className="text-sm">{t("Runtime")}: {runtimeOptions.find((option) => option.value === common.target.runtime_id)?.label ?? common.target.runtime_id}{scopeRuntimeIds.length === 1 && common.target.runtime_id === scopeRuntimeIds[0] ? ` · ${t("Inherited from scope")}` : ""}</p>
        <Field><FieldLabel>{t("Capabilities")}</FieldLabel><div className="grid max-h-64 gap-2 overflow-y-auto rounded border p-3 sm:grid-cols-2">{capabilityOptions.map((option) => <label key={option.value} className="flex items-center gap-2 text-sm"><Checkbox disabled={disabled} checked={members.some((rule) => rule.target.capability_id === option.value)} onCheckedChange={(checked) => {
          if (checked === true) {
            const empty = members.find((rule) => !rule.target.capability_id)
            const value: RuntimePolicyRule = { ...structuredClone(common), rule_id: empty?.rule_id ?? crypto.randomUUID(), group_id: common.group_id ?? ids[0], individual_settings: false, target: { ...common.target, capability_id: option.value }, actions: [] }
            emit(empty ? rules.map((rule) => rule === empty ? value : rule) : [...rules, value])
          } else {
            emit(rules.filter((rule) => !ids.includes(rule.rule_id) || rule.target.capability_id !== option.value))
          }
        }} />{option.label}</label>)}</div></Field>
        <Field><FieldLabel>{t("Actions")}</FieldLabel><p className="text-sm text-muted-foreground">{t("Discovery and invocation are separate permissions.")}</p><div className="space-y-3">{members.filter((rule) => rule.target.capability_id).map((rule) => <div key={rule.rule_id} className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded border p-3 text-sm"><span className="min-w-32 font-medium">{capabilityOptions.find((option) => option.value === rule.target.capability_id)?.label ?? rule.target.capability_id}</span>{(runtimeCapabilityActions(rule.target.capability_id) ?? []).map((action) => <label key={action} className="flex items-center gap-2"><Checkbox disabled={disabled} checked={rule.actions.includes(action)} onCheckedChange={(checked) => emit(rules.map((current) => current === rule ? { ...rule, actions: checked === true ? [...rule.actions, action] : rule.actions.filter((value) => value !== action) } : current))} />{t(action === "expose" ? "Discover capability" : action)}</label>)}</div>)}</div></Field>
        <h5 className="text-sm font-medium">{t("Shared settings")}</h5>
        <Settings rule={common} disabled={disabled || !commonMembers.length} onChange={(value) => updateGroup(ids, value)} />
        <details open={members.some((rule) => rule.individual_settings) ? true : undefined}><summary className="cursor-pointer text-sm">{t("Individual settings and technical details")}</summary><div className="mt-3 space-y-3">
          {members.map((rule) => <div key={rule.rule_id} className="space-y-3 rounded border p-3"><div className="flex items-center justify-between"><span className="text-sm font-medium">{capabilityOptions.find((option) => option.value === rule.target.capability_id)?.label ?? rule.target.capability_id}</span><label className="flex items-center gap-2 text-sm"><Checkbox disabled={disabled} checked={exceptions.includes(rule.rule_id)} onCheckedChange={(checked) => {
            emit(rules.map((current) => current === rule ? checked === true ? { ...rule, individual_settings: true } : { ...structuredClone(common), individual_settings: false, rule_id: rule.rule_id, target: { ...rule.target, runtime_id: common.target.runtime_id }, actions: rule.actions } : current))
          }} />{t("Individual settings")}</label></div>
          <p className="break-all font-mono text-xs text-muted-foreground">{t("Rule ID")}: {rule.rule_id}</p>
          {exceptions.includes(rule.rule_id) ? <><RuntimeChoice disabled={disabled} value={rule.target.runtime_id} options={scopedRuntimeOptions} onValueChange={(runtimeId) => { if (disabled) return; emit(rules.map((current) => current === rule ? { ...rule, target: { ...rule.target, runtime_id: runtimeId } } : current)) }} placeholder={t("Runtime")} searchPlaceholder={t("Search runtimes")} emptyLabel={t("No results.")} /><Settings rule={rule} disabled={disabled} onChange={(value) => { emit(rules.map((current) => current === rule ? value : current)) }} /></> : null}
          </div>)}
          {scopeRuntimeIds.length !== 1 ? <Field><FieldLabel>{t("Group runtime")}</FieldLabel><RuntimeChoice disabled={disabled} value={common.target.runtime_id} options={scopedRuntimeOptions} onValueChange={(runtimeId) => { if (disabled) return; emit(rules.map((rule) => ids.includes(rule.rule_id) && !exceptions.includes(rule.rule_id) ? { ...rule, target: { ...rule.target, runtime_id: runtimeId } } : rule)) }} placeholder={t("Runtime")} searchPlaceholder={t("Search runtimes")} emptyLabel={t("No results.")} /></Field> : null}
        </div></details>
      </section>
    })}
  </div>
}
