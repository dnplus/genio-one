import { RuntimeCapabilityGroups } from "./runtime-capability-groups"
import { DiscardPolicyDraft } from "./discard-policy-draft"
import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { SearchableSelect, type SearchableSelectOption } from "@/components/ui/searchable-select"
import type { OverviewSnapshot } from "@/domain/contracts"
import {
  getRuntimePolicyDraft,
  listRuntimePolicyRevisions,
  publishRuntimePolicyDraft,
  runtimePolicyDraftPath,
  saveRuntimePolicyDraft,
  setRuntimePolicyEnabled,
  type PolicyDraftView,
  type RuntimePolicyConstraint,
  type RuntimePolicyDefinition,
  type RuntimePolicyObligation,
  type RuntimePolicyRevision,
  type RuntimePolicyRole,
  type RuntimePolicyScope,
} from "@/lib/product-api"

const runtimeRoles: RuntimePolicyRole[] = ["TENANT_ADMINISTRATOR", "ORGANIZATION_ADMINISTRATOR", "USER"]
const runtimeCapabilityCatalog: SearchableSelectOption[] = [
  { value: "model.invoke", label: "Model inference", description: "Models remain subject to resource access permissions" },
  { value: "codex.subscription", label: "Codex subscription", description: "Personal Codex access" },
  { value: "filesystem.read", label: "Filesystem read", description: "Read files" },
  { value: "filesystem.write", label: "Filesystem write", description: "Write files" },
  { value: "shell.exec", label: "Shell execute", description: "Run shell commands" },
  { value: "browser.open", label: "Browser open", description: "Open browser pages" },
  { value: "web_search.query", label: "Web search", description: "Search the web" },
  { value: "remote_hands.use", label: "Remote hands", description: "Operate remote hands" },
  { value: "mcp.invoke", label: "MCP invoke", description: "Invoke MCP tools" },
]
function emptyScope(): RuntimePolicyScope {
  return { subject_ids: [], organization_ids: [], roles: [], client_ids: [], bot_ids: [], runtime_ids: [] }
}

function scopeHasSelection(scope: RuntimePolicyScope): boolean {
  return Object.values(scope).some((values) => values.length > 0)
}

function cloneDefinition(value: RuntimePolicyDefinition): RuntimePolicyDefinition {
  return {
    ...(value.display_name ? { display_name: value.display_name } : {}),
    scope: {
      subject_ids: [...value.scope.subject_ids],
      organization_ids: [...value.scope.organization_ids],
      roles: [...value.scope.roles],
      client_ids: [...value.scope.client_ids],
      bot_ids: [...value.scope.bot_ids],
      runtime_ids: [...value.scope.runtime_ids],
    },
    rules: value.rules.map((rule) => ({
      ...rule,
      target: { ...rule.target },
      actions: [...rule.actions],
      constraints: rule.constraints.map((constraint) => ({ ...constraint, parameters: { ...constraint.parameters } } as RuntimePolicyConstraint)),
      obligations: rule.obligations.map((obligation) => ({ ...obligation, parameters: { ...obligation.parameters } } as RuntimePolicyObligation)),
    })),
  }
}

export function finalRuntimePolicyDefinition(value: RuntimePolicyDefinition): RuntimePolicyDefinition {
  const displayName = value.display_name?.trim()
  return {
    ...(displayName ? { display_name: displayName } : {}),
    scope: {
      subject_ids: [...new Set(value.scope.subject_ids)].sort(),
      organization_ids: [...new Set(value.scope.organization_ids)].sort(),
      roles: [...new Set(value.scope.roles)].sort(),
      client_ids: [...new Set(value.scope.client_ids)].sort(),
      bot_ids: [...new Set(value.scope.bot_ids)].sort(),
      runtime_ids: [...new Set(value.scope.runtime_ids)].sort(),
    },
    rules: value.rules.map((rule) => ({
      rule_id: rule.rule_id.trim(),
      ...(rule.group_id ? { group_id: rule.group_id } : {}),
      ...(rule.individual_settings ? { individual_settings: true } : {}),
      target: { runtime_id: rule.target.runtime_id.trim(), capability_id: rule.target.capability_id.trim() },
      actions: [...new Set(rule.actions)],
      effect: rule.effect,
      constraints: rule.constraints,
      obligations: rule.obligations,
    })),
  }
}

function initialDefinition(policy: RuntimePolicyRevision | null, policyId: string, displayName?: string): RuntimePolicyDefinition {
  if (policy) return cloneDefinition({ display_name: policy.display_name, scope: policy.scope, rules: policy.rules })
  return {
    display_name: displayName?.trim() || policyId,
    scope: emptyScope(),
    rules: [],
  }
}

function referenceOptions(
  values: string[],
  options: SearchableSelectOption[],
): SearchableSelectOption[] {
  return options.filter((option) => !values.includes(option.value))
}

function ReferenceField({
  label,
  values,
  options,
  placeholder,
  searchPlaceholder,
  onAdd,
  onRemove,
  disabled,
}: {
  label: string
  values: string[]
  options: SearchableSelectOption[]
  placeholder: string
  searchPlaceholder: string
  onAdd: (value: string) => void
  onRemove: (value: string) => void
  disabled: boolean
}) {
  const { t } = useTranslation()
  return <Field>
    <FieldLabel>{t(label)}</FieldLabel>
    <div className="flex flex-wrap gap-2">
      {values.map((value) => {
        const option = options.find((candidate) => candidate.value === value)
        return <Badge key={value} variant="secondary" className="gap-1">
          {option?.label ?? value}
          {!disabled ? <Button type="button" variant="ghost" size="icon-xs" aria-label={t("Remove")} onClick={() => onRemove(value)}>×</Button> : null}
        </Badge>
      })}
    </div>
    {!disabled ? <SearchableSelect value="" options={referenceOptions(values, options)} onValueChange={onAdd} placeholder={t(placeholder)} searchPlaceholder={t(searchPlaceholder)} emptyLabel={t("No results.")} /> : null}
  </Field>
}

function RevisionSummary({
  revision,
  subjectLabel,
  runtimeOptions,
  capabilityOptions,
}: {
  revision: RuntimePolicyRevision
  subjectLabel: (id: string | null) => string
  runtimeOptions: SearchableSelectOption[]
  capabilityOptions: SearchableSelectOption[]
}) {
  const { t } = useTranslation()
  return <div className="flex flex-col gap-2 text-sm">
    <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{t("Revision")} {revision.revision}</Badge><Badge variant="outline">{t(revision.provenance)}</Badge><Badge variant={revision.enabled ? "secondary" : "outline"}>{t(revision.enabled ? "Enabled" : "Disabled")}</Badge></div>
    <div className="text-muted-foreground">{subjectLabel(revision.published_by_subject_id)} · {new Date(revision.published_at * 1000).toLocaleString()}</div>
    <div>{t("Scope")}: {revision.scope.subject_ids.length} {t("people")}, {revision.scope.organization_ids.length} {t("organizations")}, {revision.scope.client_ids.length} {t("clients")}, {revision.scope.runtime_ids.length} {t("runtimes")}</div>
    <div>{t("Rules")}: {revision.rules.length}</div>
    {revision.rules.map((rule) => {
      const runtime = runtimeOptions.find((option) => option.value === rule.target.runtime_id)
      const capability = capabilityOptions.find((option) => option.value === rule.target.capability_id)
      return <div className="rounded-md border p-2" key={rule.rule_id}>
        <div className="font-medium">{runtime?.label ?? rule.target.runtime_id} / {capability?.label ?? rule.target.capability_id}</div>
        <div className="font-mono text-xs text-muted-foreground">{t("Technical ID")}: {rule.target.runtime_id} / {rule.target.capability_id}</div>
        <div>{t(rule.effect)} · {rule.actions.map((action) => `${t(action)} (${action})`).join(", ")}</div>
      </div>
    })}
  </div>
}

export function RuntimePolicyEditor({
  tenantId,
  policy,
  policyId,
  initialDisplayName,
  canEdit,
  data,
  onDraftSaved,
  onPublished,
  refreshKey = 0,
}: {
  tenantId: string
  policy: RuntimePolicyRevision | null
  policyId: string
  initialDisplayName?: string
  canEdit: boolean
  data: OverviewSnapshot
  onDraftSaved?: () => Promise<void>
  onPublished: () => Promise<void>
  refreshKey?: number
}) {
  const { t } = useTranslation()
  const [definition, setDefinition] = useState<RuntimePolicyDefinition>(() => initialDefinition(policy, policyId, initialDisplayName))
  const [enabled, setEnabled] = useState(policy?.enabled ?? true)
  const [history, setHistory] = useState<RuntimePolicyRevision[]>([])
  const [draft, setDraft] = useState<PolicyDraftView | null>(null)
  const [editing, setEditing] = useState(false)
  const [reviewed, setReviewed] = useState(false)
  const [compareRevision, setCompareRevision] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [unrestrictedScopeConfirmed, setUnrestrictedScopeConfirmed] = useState(false)
  const draftPath = runtimePolicyDraftPath(tenantId, policyId)

  const subjectOptions = useMemo<SearchableSelectOption[]>(() => (data.identity?.subjects ?? []).map((subject) => ({ value: subject.subject_id, label: subject.profile.display_name ?? subject.profile.email ?? subject.subject_id, description: `${subject.kind}${subject.profile.email ? ` · ${subject.profile.email}` : ""}` })), [data.identity?.subjects])
  const organizationOptions = useMemo<SearchableSelectOption[]>(() => data.organizations.map((organization) => ({ value: organization.organization_id, label: organization.display_name, description: organization.slug })), [data.organizations])
  const clientOptions = useMemo<SearchableSelectOption[]>(() => {
    const values = new Map<string, SearchableSelectOption>()
    for (const application of data.applications) values.set(application.subject_id, { value: application.subject_id, label: application.display_name, description: application.application_id })
    for (const subject of data.identity?.subjects ?? []) if (subject.kind === "APPLICATION") values.set(subject.subject_id, { value: subject.subject_id, label: subject.profile.display_name ?? subject.subject_id, description: "Application subject" })
    return [...values.values()].sort((left, right) => left.label.localeCompare(right.label))
  }, [data.applications, data.identity?.subjects])
  const botOptions = useMemo<SearchableSelectOption[]>(() => {
    const values = new Map<string, SearchableSelectOption>()
    for (const subject of data.identity?.subjects ?? []) if (subject.kind === "AGENT") values.set(subject.subject_id, { value: subject.subject_id, label: subject.profile.display_name ?? subject.subject_id, description: "Agent subject" })
    for (const resource of data.resources.filter((candidate) => candidate.service_kind === "GENIO_BOT")) values.set(resource.resource_id, { value: resource.resource_id, label: resource.display_name, description: resource.kind })
    return [...values.values()].sort((left, right) => left.label.localeCompare(right.label))
  }, [data.identity?.subjects, data.resources])
  const runtimeOptions = useMemo<SearchableSelectOption[]>(() => {
    const values = new Map<string, SearchableSelectOption>([["codex", { value: "codex", label: t("Codex"), description: t("Personal Codex runtime"), searchText: "codex" }]])
    for (const runtime of data.runtimes) {
      if (runtime.runtime_id === "codex") continue
      values.set(runtime.runtime_id, { value: runtime.runtime_id, label: runtime.runtime_id, description: `${runtime.runtime_kind} · ${runtime.operator_state}`, searchText: runtime.runtime_id })
    }
    return [...values.values()].sort((left, right) => left.label.localeCompare(right.label))
  }, [data.runtimes, t])
  const capabilityOptions = useMemo<SearchableSelectOption[]>(() => {
    const values = new Map<string, SearchableSelectOption>()
    for (const option of runtimeCapabilityCatalog) values.set(option.value, { ...option, label: t(option.label), description: option.description ? t(option.description) : undefined, searchText: option.value })
    for (const resource of data.resources) for (const capability of resource.capabilities) {
      if (values.has(capability.capability_id)) continue
      values.set(capability.capability_id, { value: capability.capability_id, label: capability.display_name, description: `${t("Resource")} · ${resource.display_name}`, searchText: capability.capability_id })
    }
    return [...values.values()].sort((left, right) => left.label.localeCompare(right.label))
  }, [data.resources, t])

  useEffect(() => {
    let active = true
    void Promise.all([getRuntimePolicyDraft(tenantId, policyId), listRuntimePolicyRevisions(tenantId, policyId)]).then(([savedDraft, revisions]) => {
      if (!active) return
      setHistory(revisions)
      setCompareRevision((revisions[0] ? String(revisions[0].revision) : ""))
      setDraft(savedDraft)
      const base = savedDraft?.content.kind === "RUNTIME_CAPABILITY"
        ? savedDraft.content.definition
        : initialDefinition(policy, policyId, initialDisplayName)
      setDefinition(cloneDefinition(base))
      setEnabled(policy?.enabled ?? true)
      setUnrestrictedScopeConfirmed(!scopeHasSelection(base.scope) && base.rules.some((rule) => rule.effect === "ALLOW"))
      setReviewed(false)
      setEditing(canEdit && Boolean(savedDraft || !policy))
      setError("")
    }).catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : "RUNTIME_POLICY_LOAD_FAILED") })
    return () => { active = false }
  }, [tenantId, policyId, policy?.revision, refreshKey, initialDisplayName, canEdit])

  const effectiveEnabled = enabled
  const dirty = draft?.content.kind === "RUNTIME_CAPABILITY" && JSON.stringify(finalRuntimePolicyDefinition(definition)) !== JSON.stringify(finalRuntimePolicyDefinition(draft.content.definition))
  const selectedComparison = history.find((revision) => String(revision.revision) === compareRevision)
  const subjectLabel = (subjectId: string | null) => subjectId ? subjectOptions.find((option) => option.value === subjectId)?.label ?? subjectId : t("Installation")

  function updateScope<Key extends keyof RuntimePolicyScope>(key: Key, value: RuntimePolicyScope[Key]) {
    setReviewed(false)
    if (!scopeHasSelection({ ...definition.scope, [key]: value })) setUnrestrictedScopeConfirmed(false)
    setDefinition((current) => ({ ...current, scope: { ...current.scope, [key]: value }, rules: key === "runtime_ids" && current.scope.runtime_ids.length === 1 && value.length === 1
      ? current.rules.map((rule) => rule.target.runtime_id === current.scope.runtime_ids[0] ? { ...rule, target: { ...rule.target, runtime_id: value[0]! } } : rule)
      : current.rules }))
  }

  function addScopeValue(key: keyof RuntimePolicyScope, value: string) {
    if (!value) return
    const current = definition.scope[key] as string[]
    updateScope(key, [...current, value] as RuntimePolicyScope[typeof key])
  }

  function removeScopeValue(key: keyof RuntimePolicyScope, value: string) {
    const current = definition.scope[key] as string[]
    updateScope(key, current.filter((item) => item !== value) as RuntimePolicyScope[typeof key])
  }

  function checkDefinition() {
    const value = finalRuntimePolicyDefinition(definition)
    const problems: string[] = []
    if (!value.display_name) problems.push(t("A policy name is required."))
    const hasAllowRule = value.rules.some((rule) => rule.effect === "ALLOW")
    if (hasAllowRule && !scopeHasSelection(value.scope) && !unrestrictedScopeConfirmed) problems.push(t("An ALLOW rule with no scope applies to everyone in this Tenant. Confirm this explicitly before checking the policy."))
    const ids = new Set<string>()
    value.rules.forEach((rule) => {
      if (!rule.rule_id || !rule.target.runtime_id || !rule.target.capability_id || rule.actions.length === 0) problems.push(t("Each rule needs an ID, runtime, capability, and action."))
      if (value.scope.runtime_ids.length && !value.scope.runtime_ids.includes(rule.target.runtime_id)) problems.push(t("Rule runtime must be included in policy scope."))
      if (ids.has(rule.rule_id)) problems.push(t("Rule IDs must be unique."))
      ids.add(rule.rule_id)
    })
    if (problems.length) {
      setReviewed(false)
      setError(problems[0]!)
      return false
    }
    setError("")
    setReviewed(true)
    const savedDraftIsCurrent = draft?.content.kind === "RUNTIME_CAPABILITY" &&
      JSON.stringify(value) === JSON.stringify(finalRuntimePolicyDefinition(draft.content.definition))
    setNotice(savedDraftIsCurrent
      ? t("Draft {{version}} checked and ready to publish.", { version: draft.version })
      : t("Policy check passed. Save the draft to review and publish it."))
    return true
  }

  async function save() {
    if (!checkDefinition()) return
    setBusy(true)
    setError("")
    try {
      const saved = await saveRuntimePolicyDraft(tenantId, policyId, { expected_version: draft?.version ?? 0, base_revision: policy?.revision ?? 0, content: { kind: "RUNTIME_CAPABILITY", definition: finalRuntimePolicyDefinition(definition) } })
      setDraft(saved)
      setDefinition(cloneDefinition(saved.content.kind === "RUNTIME_CAPABILITY" ? saved.content.definition : definition))
      setNotice(t("Draft saved. The published runtime policy is unchanged."))
      await onDraftSaved?.()
    } catch (caught) { setError(caught instanceof Error ? caught.message : "RUNTIME_POLICY_SAVE_FAILED") }
    finally { setBusy(false) }
  }

  async function publish() {
    if (!draft || draft.content.kind !== "RUNTIME_CAPABILITY" || dirty || !reviewed) return
    setBusy(true)
    setError("")
    try {
      await publishRuntimePolicyDraft(tenantId, policyId, draft.version)
      setDraft(null)
      setEditing(false)
      setReviewed(false)
      setNotice(t("Runtime policy published. New runtime decisions use this revision."))
      await onPublished()
    } catch (caught) { setError(caught instanceof Error ? caught.message : "RUNTIME_POLICY_PUBLISH_FAILED") }
    finally { setBusy(false) }
  }

  async function toggleEnabled() {
    if (!policy) return
    setBusy(true)
    setError("")
    try {
      await setRuntimePolicyEnabled(tenantId, policyId, policy.revision, !policy.enabled)
      setNotice(t(!policy.enabled ? "Runtime policy enabled. New runtime decisions use this revision." : "Runtime policy disabled. New runtime decisions are denied."))
      await onPublished()
    } catch (caught) { setError(caught instanceof Error ? caught.message : "RUNTIME_POLICY_LIFECYCLE_FAILED") }
    finally { setBusy(false) }
  }

  async function resetAfterDiscard() {
    if (!draft) return
    setDraft(null)
    setDefinition(initialDefinition(policy, policyId, initialDisplayName))
    setEditing(false)
    setReviewed(false)
    await onDraftSaved?.()
  }

  const scopeFields: Array<{ key: keyof RuntimePolicyScope; label: string; options: SearchableSelectOption[]; placeholder: string; searchPlaceholder: string }> = [
    { key: "subject_ids", label: "People and subjects", options: subjectOptions, placeholder: "Select a person or subject", searchPlaceholder: "Search people and subjects" },
    { key: "organization_ids", label: "Organizations", options: organizationOptions, placeholder: "Select an organization", searchPlaceholder: "Search organizations" },
    { key: "client_ids", label: "Acting clients", options: clientOptions, placeholder: "Select an acting client", searchPlaceholder: "Search clients" },
    { key: "bot_ids", label: "Bots", options: botOptions, placeholder: "Select a bot", searchPlaceholder: "Search bots" },
    { key: "runtime_ids", label: "Runtimes", options: runtimeOptions, placeholder: "Select a runtime", searchPlaceholder: "Search runtimes" },
  ]

  return <Card data-testid="runtime-policy-editor">
    <CardHeader>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><CardTitle>{t("Runtime capability policy")}</CardTitle><CardDescription>{t("Control which people, organizations, clients, and bots may use each runtime capability.")}</CardDescription></div>
        <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{policy ? `${t("Published revision")} ${policy.revision}` : t("New policy")}</Badge><Badge variant={effectiveEnabled ? "secondary" : "outline"}>{t(effectiveEnabled ? "Enabled" : "Disabled")}</Badge>{canEdit && !editing ? <Button variant="outline" onClick={() => setEditing(true)}>{t("Edit policy")}</Button> : null}</div>
      </div>
    </CardHeader>
    <CardContent className="flex flex-col gap-6">
      {error ? <Alert variant="destructive"><AlertDescription>{t(error)}</AlertDescription></Alert> : null}
      {notice ? <Alert><AlertDescription>{notice}</AlertDescription></Alert> : null}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3"><span className="text-sm text-muted-foreground">{t("Policy source")}</span><Badge variant="outline">{t(policy?.provenance ?? "TENANT_AUTHORED")}</Badge><details><summary className="cursor-pointer text-sm text-muted-foreground">{t("Technical ID")}</summary><p className="break-all font-mono text-xs">{policyId}</p></details>{canEdit && policy ? <Button disabled={busy} variant="outline" size="sm" onClick={() => void toggleEnabled()}>{t(effectiveEnabled ? "Disable policy" : "Enable policy")}</Button> : null}</div>
      <FieldGroup>
        <Field><FieldLabel htmlFor={`runtime-policy-name-${policyId}`}>{t("Policy name")}</FieldLabel><Input id={`runtime-policy-name-${policyId}`} disabled={!editing || busy} value={definition.display_name ?? ""} onChange={(event) => { setReviewed(false); setDefinition((current) => ({ ...current, display_name: event.target.value })) }} /><FieldDescription>{t("A published revision keeps this name and its source history.")}</FieldDescription></Field>
        {scopeFields.map((field) => <ReferenceField key={field.key} label={field.label} values={definition.scope[field.key] as string[]} options={field.options} placeholder={field.placeholder} searchPlaceholder={field.searchPlaceholder} disabled={!editing || busy} onAdd={(value) => addScopeValue(field.key, value)} onRemove={(value) => removeScopeValue(field.key, value)} />)}
        <Field><FieldLabel>{t("Roles")}</FieldLabel><div className="grid gap-2 sm:grid-cols-3">{runtimeRoles.map((role) => <Field key={role} orientation="horizontal"><Checkbox disabled={!editing || busy} checked={definition.scope.roles.includes(role)} onCheckedChange={(checked) => updateScope("roles", checked ? [...definition.scope.roles, role] : definition.scope.roles.filter((item) => item !== role))} /><FieldLabel>{t(role)}</FieldLabel></Field>)}</div><FieldDescription>{t("A scope matches when every populated dimension matches. Empty dimensions match every value in that dimension; populated dimensions must all match.")}</FieldDescription></Field>
        {!scopeHasSelection(definition.scope) ? <div className="flex flex-col gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm"><p>{t("No scope selected: this policy is tenant-wide unless a populated dimension narrows it.")}</p>{definition.rules.some((rule) => rule.effect === "ALLOW") ? <Field orientation="horizontal"><Checkbox disabled={!editing || busy} checked={unrestrictedScopeConfirmed} onCheckedChange={(checked) => { setUnrestrictedScopeConfirmed(checked === true); setReviewed(false) }} /><FieldLabel>{t("I understand this ALLOW applies to everyone in this Tenant.")}</FieldLabel></Field> : <p className="text-muted-foreground">{t("No scope selected: DENY rules still apply to every matching request.")}</p>}</div> : null}
      </FieldGroup>
      <RuntimeCapabilityGroups rules={definition.rules} scopeRuntimeIds={definition.scope.runtime_ids} runtimeOptions={runtimeOptions} capabilityOptions={capabilityOptions} capabilityKinds={Object.fromEntries(data.resources.flatMap((resource) => resource.capabilities.map((capability) => [capability.capability_id, resource.kind])))} disabled={!editing || busy} onChange={(rules) => { setReviewed(false); setDefinition((current) => ({ ...current, rules })) }} />
      {reviewed ? <div className="rounded-lg border p-4"><h3 className="font-medium">{t("Actual permissions to publish")}</h3><p className="text-sm text-muted-foreground">{t("Discovery and invocation are separate permissions.")}</p><ul className="mt-3 space-y-2 text-sm">{definition.rules.map((rule) => <li key={rule.rule_id}>{capabilityOptions.find((option) => option.value === rule.target.capability_id)?.label ?? rule.target.capability_id} · {runtimeOptions.find((option) => option.value === rule.target.runtime_id)?.label ?? rule.target.runtime_id} · {t(rule.effect)} · {rule.actions.map((action) => t(action)).join("、")} · {rule.constraints.length} {t("Constraints")} · {rule.obligations.map((value) => t(value.kind)).join("、")}</li>)}</ul></div> : null}
      {editing ? <div className="flex flex-wrap justify-end gap-2 border-t pt-4"><Button variant="outline" disabled={busy} onClick={() => { setDefinition(initialDefinition(policy, policyId, initialDisplayName)); setEditing(false); setReviewed(false) }}>{t("Cancel")}</Button><Button variant="outline" disabled={busy} onClick={() => void checkDefinition()}>{t("Check policy")}</Button><Button disabled={busy} onClick={() => void save()}>{t("Save draft")}</Button></div> : null}
      {draft && canEdit ? <div className="flex flex-col gap-3 rounded-lg border p-4"><div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{t("Draft")} {draft.version}</Badge><span>{t("Based on revision")} {draft.base_revision}</span></div><p className="text-sm">{t("Check the scope, target, effect, and obligations before publishing. Publishing creates the next immutable runtime revision.")}</p><div className="flex flex-wrap gap-2"><DiscardPolicyDraft path={draftPath} version={draft.version} onDiscarded={resetAfterDiscard} /><Button disabled={busy || Boolean(dirty)} variant="outline" onClick={() => void checkDefinition()}>{t("Check saved draft")}</Button><Button disabled={busy || Boolean(dirty) || !reviewed} onClick={() => void publish()}>{t("Publish revision")}</Button></div></div> : null}
      <details className="rounded-lg border p-4"><summary className="cursor-pointer font-medium">{t("Revision history and source comparison")}</summary><div className="mt-4 flex flex-col gap-4">{history.length ? <><Field><FieldLabel>{t("Compare source revision")}</FieldLabel><SearchableSelect value={compareRevision} options={history.map((revision) => ({ value: String(revision.revision), label: `${t("Revision")} ${revision.revision}`, description: `${revision.enabled ? t("Enabled") : t("Disabled")} · ${t(revision.provenance)}` }))} onValueChange={setCompareRevision} placeholder={t("Select a revision")} searchPlaceholder={t("Search revisions")} emptyLabel={t("No revisions available.")} /></Field>{selectedComparison ? <RevisionSummary revision={selectedComparison} subjectLabel={subjectLabel} runtimeOptions={runtimeOptions} capabilityOptions={capabilityOptions} /> : null}</> : <p className="text-sm text-muted-foreground">{t("No published runtime revisions yet.")}</p>}</div></details>
    </CardContent>
  </Card>
}
