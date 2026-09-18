import { DiscardPolicyDraft } from "./discard-policy-draft"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { SearchableSelect } from "@/components/ui/searchable-select"
import type { OnePolicyBotSeed, OverviewSnapshot } from "@/domain/contracts"
import { listBotPolicyRevisions, type BotPolicyRevisionView, getPolicyDraft, policyDraftPath, publishPolicyDraft, savePolicyDraft, type BotPolicyRules, type PolicyDraftView } from "@/lib/product-api"

export function BotPolicyEditor({ tenantId, policy, canEdit, data, onPublished, onDraftSaved, refreshKey = 0 }: {
  tenantId: string
  refreshKey?: number
  policy: OnePolicyBotSeed
  canEdit: boolean
  data: OverviewSnapshot
  onDraftSaved?: () => Promise<void>
  onPublished: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [history, setHistory] = useState<BotPolicyRevisionView[]>([])
  const [rules, setRules] = useState<BotPolicyRules>(policy.rules)
  const [draft, setDraft] = useState<PolicyDraftView | null>(null)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [reviewed, setReviewed] = useState(false)
  const path = policyDraftPath(tenantId)
  useEffect(() => {
    let active = true
    void Promise.all([getPolicyDraft(path), listBotPolicyRevisions(tenantId)]).then(([value, revisions]) => {
      if (active) setHistory(revisions)
      if (!active) return
      setReviewed(false)
      setDraft(value)
      setRules(value?.content.kind === "BOT_ACCESS" ? value.content.definition : policy.rules)
    }).catch((caught) => { if (active) setError(String(caught)) })
    return () => { active = false }
  }, [path, policy.policy_revision, refreshKey])
  const dirty = draft?.content.kind === "BOT_ACCESS" && JSON.stringify(rules) !== JSON.stringify(draft.content.definition)
  async function save() {
    setBusy(true)
    setError("")
    try {
      setDraft(await savePolicyDraft(path, { expected_version: draft?.version ?? 0, base_revision: policy.policy_revision, content: { kind: "BOT_ACCESS", definition: rules } }))
      setReviewed(false)
      setNotice("Draft saved. Published policy is unchanged.")
      await onDraftSaved?.()
    } catch (caught) { setError(caught instanceof Error ? caught.message : "POLICY_SAVE_FAILED") }
    finally { setBusy(false) }
  }
  async function publish() {
    if (!draft) return
    setBusy(true)
    setError("")
    try {
      await publishPolicyDraft(path, draft.version)
      setDraft(null)
      setReviewed(false)
      setEditing(false)
      setNotice("Bot policy published. New access decisions use this revision.")
      await onPublished()
    } catch (caught) { setError(caught instanceof Error ? caught.message : "POLICY_PUBLISH_FAILED") }
    finally { setBusy(false) }
  }
  return <Card data-testid="bot-policy-editor">
    <CardHeader>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>{t("Bot access policy")}</CardTitle>
        <Badge>{t("Published revision")} {policy.policy_revision}</Badge>
        {draft ? <Badge variant="outline">{t("Draft preview")} {draft.version}</Badge> : null}
        {canEdit && !editing ? <Button variant="outline" onClick={() => setEditing(true)}>{t("Edit policy")}</Button> : null}
      </div>
      <CardDescription>{t("Allow selected roles or people to use Genio Bot. The verified Bot client and Codex subscription route remain required.")}</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-5">
      {error ? <Alert variant="destructive"><AlertDescription>{t(error)}</AlertDescription></Alert> : null}
      {notice ? <Alert><AlertDescription>{t(notice)}</AlertDescription></Alert> : null}
      <details className="rounded-lg border p-4"><summary className="cursor-pointer font-medium">{t("Revision history")}</summary>
        <div className="mt-3 flex flex-col gap-3">{history.map((item) => <div key={item.policy_revision} className="text-sm">
          <span className="font-medium">{t("Revision")} {item.policy_revision}</span> · {new Date(item.published_at * 1000).toLocaleString()} · {item.published_by ? data.identity?.subjects.find((subject) => subject.subject_id === item.published_by)?.profile.display_name ?? item.published_by : t("Installation")}
          <div className="text-muted-foreground">{item.rules.allowed_roles.map((role) => t(role)).join(", ")} {item.rules.allowed_subject_ids.map((id) => data.identity?.subjects.find((subject) => subject.subject_id === id)?.profile.display_name ?? id).join(", ")}</div>
        </div>)}</div>
      </details>
      <FieldGroup>
        <Field><FieldLabel>{t("Allowed roles")}</FieldLabel>
          {(["TENANT_ADMINISTRATOR", "ORGANIZATION_ADMINISTRATOR", "USER"] as const).map((role) => <Field key={role} orientation="horizontal">
            <Checkbox id={`policy-role-${role}`} disabled={!editing || busy} checked={rules.allowed_roles.includes(role)} onCheckedChange={(checked) => { setReviewed(false); setRules((value) => ({ ...value, allowed_roles: checked ? [...value.allowed_roles, role] : value.allowed_roles.filter((item) => item !== role) })) }} />
            <FieldLabel htmlFor={`policy-role-${role}`}>{t(role)}</FieldLabel>
          </Field>)}
        </Field>
        <Field><FieldLabel>{t("Additional people")}</FieldLabel>
          {rules.allowed_subject_ids.map((id) => <div className="flex items-center justify-between gap-3" key={id}>
            <span>{data.identity?.subjects.find((subject) => subject.subject_id === id)?.profile.display_name ?? t("Unresolved reference")}</span>
            {editing ? <Button variant="ghost" onClick={() => { setReviewed(false); setRules((value) => ({ ...value, allowed_subject_ids: value.allowed_subject_ids.filter((item) => item !== id) })) }}>{t("Remove")}</Button> : null}
          </div>)}
          {editing ? <SearchableSelect value="" options={(data.identity?.subjects ?? []).filter((subject) => subject.kind === "PERSON" && !rules.allowed_subject_ids.includes(subject.subject_id)).map((subject) => ({ value: subject.subject_id, label: subject.profile.display_name ?? subject.profile.email ?? subject.subject_id, description: subject.profile.email ?? undefined }))} onValueChange={(id) => { if (id) { setReviewed(false); setRules((value) => ({ ...value, allowed_subject_ids: [...value.allowed_subject_ids, id] })) } }} placeholder={t("Select a person")} searchPlaceholder={t("Search people")} emptyLabel={t("No results.")} /> : null}
        </Field>
      </FieldGroup>
      <p className="text-sm text-muted-foreground">{t("Computer use is not granted by this policy. No selected role or person means access is denied.")}</p>
      {editing ? <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" disabled={busy} onClick={() => { setRules(policy.rules); setEditing(false); setReviewed(false) }}>{t("Cancel")}</Button>
        <Button disabled={busy} onClick={() => void save()}>{t("Save draft")}</Button>
      </div> : null}
      {draft && canEdit ? <div className="flex flex-col gap-3 rounded-lg border p-4">
        <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{t("Draft")} {draft.version}</Badge><span>{t("Based on revision")} {draft.base_revision}</span></div>
        <p className="text-sm">{t("Review the selected roles and people before publishing. Changes affect subsequent Bot access decisions.")}</p>
        <div className="flex flex-wrap gap-2"><DiscardPolicyDraft path={path} version={draft.version} onDiscarded={async () => { setDraft(null); setRules(policy.rules); setEditing(false); setReviewed(false); await onDraftSaved?.() }} /><Button disabled={busy || Boolean(dirty)} variant="outline" onClick={() => setReviewed(true)}>{t("Review saved draft")}</Button><Button disabled={busy || !reviewed || Boolean(dirty)} onClick={() => void publish()}>{t("Publish saved draft")}</Button></div>
      </div> : null}
    </CardContent>
  </Card>
}
