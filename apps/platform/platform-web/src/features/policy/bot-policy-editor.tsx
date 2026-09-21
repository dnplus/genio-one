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
import { getPolicyDraft, listBotPolicyRevisions, policyDraftPath, ProductApiError, publishPolicyDraft, reviewPolicyDraft, savePolicyDraft, validatePolicyDraft, type BotPolicyRevisionView, type BotPolicyRules, type PolicyDraftView } from "@/lib/product-api"

function isPolicyDraftConflict(error: unknown) {
  return error instanceof ProductApiError && error.status === 409 && ["POLICY_DRAFT_CONFLICT", "POLICY_REVISION_CONFLICT", "STALE_DRAFT"].includes(error.message)
}

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
  const [conflict, setConflict] = useState(false)
  const [reloadNonce, setReloadNonce] = useState(0)
  const [notice, setNotice] = useState("")
  const path = policyDraftPath(tenantId)
  useEffect(() => {
    let active = true
    void Promise.all([getPolicyDraft(path), listBotPolicyRevisions(tenantId)]).then(([value, revisions]) => {
      if (active) setHistory(revisions)
      if (!active) return
      setDraft(value)
      setRules(value?.content.kind === "BOT_ACCESS" ? value.content.definition : policy.rules)
      setConflict(false)
    }).catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : "POLICY_LOAD_FAILED") })
    return () => { active = false }
  }, [path, policy.policy_revision, refreshKey, reloadNonce])
  const savedRules = draft?.content.kind === "BOT_ACCESS" ? draft.content.definition : policy.rules
  const dirty = editing && JSON.stringify(rules) !== JSON.stringify(savedRules)

  function restoreDraftInputs(sourceDraft = draft) {
    setRules(sourceDraft?.content.kind === "BOT_ACCESS" ? sourceDraft.content.definition : policy.rules)
  }

  function reloadSavedDraft() {
    setError("")
    setConflict(false)
    setReloadNonce((current) => current + 1)
  }

  async function save() {
    setBusy(true)
    setError("")
    setConflict(false)
    try {
      setDraft(await savePolicyDraft(path, { expected_version: draft?.version ?? 0, base_revision: policy.policy_revision, content: { kind: "BOT_ACCESS", definition: rules } }))
      setNotice("Draft saved. Validate the saved draft before review.")
      await onDraftSaved?.()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "POLICY_SAVE_FAILED")
      setConflict(isPolicyDraftConflict(caught))
    }
    finally { setBusy(false) }
  }

  async function transitionDraft(action: "validate" | "review" | "publish") {
    if (!draft) return
    setBusy(true)
    setError("")
    setConflict(false)
    try {
      if (action === "validate") {
        setDraft(await validatePolicyDraft(path, draft.version, draft.content_digest))
        setNotice("Draft validation saved. Review the validated draft before publishing.")
      } else if (action === "review") {
        setDraft(await reviewPolicyDraft(path, draft.version, draft.content_digest))
        setNotice("Draft review saved. Publish the reviewed draft when ready.")
      } else {
        await publishPolicyDraft(path, draft.version, draft.content_digest)
        setDraft(null)
        setEditing(false)
        setNotice("Bot policy published. New access decisions use this revision.")
        await onPublished()
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "POLICY_PUBLISH_FAILED")
      setConflict(isPolicyDraftConflict(caught))
    }
    finally { setBusy(false) }
  }

  const subjectLabel = (subjectId: string | null) => subjectId
    ? data.identity?.subjects.find((subject) => subject.subject_id === subjectId)?.profile.display_name ?? subjectId
    : t("Installation")
  const validated = Boolean(
    draft &&
    draft.lifecycle !== "DRAFT" &&
    draft.validation?.content_digest === draft.content_digest,
  )
  const reviewed = Boolean(
    draft?.lifecycle === "REVIEWED" &&
    draft.review?.content_digest === draft.content_digest,
  )
  const lifecycleSteps = draft ? [
    { label: t("Save draft"), state: "complete" },
    { label: t("Validate"), state: validated ? "complete" : "current" },
    { label: t("Review"), state: reviewed ? "complete" : validated ? "current" : "pending" },
    { label: t("Publish"), state: reviewed ? "current" : "pending" },
  ] : []

  return <Card data-testid="bot-policy-editor">
    <CardHeader>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>{t("Bot access policy")}</CardTitle>
        <Badge>{t("Published revision")} {policy.policy_revision}</Badge>
        {draft ? <Badge variant="outline">{t("Draft preview")} {draft.version}</Badge> : null}
        {canEdit && !editing ? <Button variant="outline" onClick={() => { restoreDraftInputs(); setEditing(true) }}>{t("Edit policy")}</Button> : null}
      </div>
      <CardDescription>{t("Allow selected roles or people to use Genio Bot. The verified Bot client and Codex subscription route remain required.")}</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-5">
      {error ? <Alert variant="destructive"><AlertDescription><div className="flex flex-col items-start gap-2"><span>{t(error)}</span>{conflict ? <><span>{t("This draft changed on the server. Reload it before continuing.")}</span><Button disabled={busy} onClick={reloadSavedDraft} size="sm" type="button" variant="outline">{t("Reload saved draft")}</Button></> : null}</div></AlertDescription></Alert> : null}
      {notice ? <Alert><AlertDescription>{t(notice)}</AlertDescription></Alert> : null}
      <details className="rounded-lg border p-4"><summary className="cursor-pointer font-medium">{t("Revision history")}</summary>
        <div className="mt-3 flex flex-col gap-3">{history.map((item) => <div key={item.policy_revision} className="text-sm">
          <span className="font-medium">{t("Revision")} {item.policy_revision}</span> · {new Date(item.published_at * 1000).toLocaleString()} · {item.published_by ? data.identity?.subjects.find((subject) => subject.subject_id === item.published_by)?.profile.display_name ?? item.published_by : t("Installation")}
          <div className="text-muted-foreground">{item.rules.allowed_roles.map((role) => t(role)).join(", ")} {item.rules.allowed_subject_ids.map((id) => data.identity?.subjects.find((subject) => subject.subject_id === id)?.profile.display_name ?? id).join(", ")} · {item.rules.computer_use_enabled ? t("Computer environment enabled") : t("Computer environment disabled")}</div>
        </div>)}</div>
      </details>
      <FieldGroup>
        <Field><FieldLabel>{t("Allowed roles")}</FieldLabel>
          {(["TENANT_ADMINISTRATOR", "ORGANIZATION_ADMINISTRATOR", "USER"] as const).map((role) => <Field key={role} orientation="horizontal">
            <Checkbox id={`policy-role-${role}`} disabled={!editing || busy} checked={rules.allowed_roles.includes(role)} onCheckedChange={(checked) => { setRules((value) => ({ ...value, allowed_roles: checked ? [...value.allowed_roles, role] : value.allowed_roles.filter((item) => item !== role) })) }} />
            <FieldLabel htmlFor={`policy-role-${role}`}>{t(role)}</FieldLabel>
          </Field>)}
        </Field>
        <Field><FieldLabel>{t("Additional people")}</FieldLabel>
          {rules.allowed_subject_ids.map((id) => <div className="flex items-center justify-between gap-3" key={id}>
            <span>{data.identity?.subjects.find((subject) => subject.subject_id === id)?.profile.display_name ?? t("Unresolved reference")}</span>
            {editing ? <Button variant="ghost" onClick={() => { setRules((value) => ({ ...value, allowed_subject_ids: value.allowed_subject_ids.filter((item) => item !== id) })) }}>{t("Remove")}</Button> : null}
          </div>)}
          {editing ? <SearchableSelect value="" options={(data.identity?.subjects ?? []).filter((subject) => subject.kind === "PERSON" && !rules.allowed_subject_ids.includes(subject.subject_id)).map((subject) => ({ value: subject.subject_id, label: subject.profile.display_name ?? subject.profile.email ?? subject.subject_id, description: subject.profile.email ?? undefined }))} onValueChange={(id) => { if (id) { setRules((value) => ({ ...value, allowed_subject_ids: [...value.allowed_subject_ids, id] })) } }} placeholder={t("Select a person")} searchPlaceholder={t("Search people")} emptyLabel={t("No results.")} /> : null}
        </Field>
        <Field orientation="horizontal">
          <Checkbox id="policy-computer-use" disabled={!editing || busy} checked={rules.computer_use_enabled === true} onCheckedChange={(checked) => { setRules((value) => ({ ...value, computer_use_enabled: checked === true })) }} />
          <div className="grid gap-1"><FieldLabel htmlFor="policy-computer-use">{t("Allow use of a computer environment")}</FieldLabel><p className="text-sm text-muted-foreground">{t("Computer use still checks Bot execution permissions and environment policy.")}</p></div>
        </Field>
      </FieldGroup>
      <p className="text-sm text-muted-foreground">{t("No selected role or person means Bot access is denied.")}</p>
      {editing ? <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" disabled={busy} onClick={() => { restoreDraftInputs(); setEditing(false); setError(""); setConflict(false) }}>{t("Cancel")}</Button>
        <Button disabled={busy} onClick={() => void save()}>{t("Save draft")}</Button>
      </div> : null}
      {draft && canEdit ? <div className="flex flex-col gap-3 rounded-lg border p-4" data-testid="bot-policy-draft-lifecycle">
        <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{t("Draft")} {draft.version}</Badge><span>{t("Based on revision")} {draft.base_revision}</span>{dirty ? <Badge variant="outline">{t("Draft changes not saved")}</Badge> : null}</div>
        <div className="flex flex-wrap gap-2">{lifecycleSteps.map((step, index) => <Badge aria-current={step.state === "current" ? "step" : undefined} data-state={step.state} key={step.label} variant={step.state === "complete" ? "secondary" : "outline"}>{index + 1}. {step.label}</Badge>)}</div>
        <div className="grid gap-1 text-sm text-muted-foreground">
          <span>{t("Content digest")}: <code className="font-mono text-foreground" title={draft.content_digest}>{draft.content_digest.slice(0, 12)}</code></span>
          {draft.validation ? <span>{t("Validated by")} {subjectLabel(draft.validation.actor_subject_id)} · {new Date(draft.validation.at * 1000).toLocaleString()}</span> : <span>{t("Not validated")}</span>}
          {draft.review ? <span>{t("Reviewed by")} {subjectLabel(draft.review.actor_subject_id)} · {new Date(draft.review.at * 1000).toLocaleString()} {draft.review.actor_subject_id === draft.created_by_subject_id ? <Badge className="ml-1" variant="outline">{t("Self-reviewed")}</Badge> : null}</span> : <span>{t("Not reviewed")}</span>}
        </div>
        <p className="text-sm">{t("Review the selected roles and people before publishing. Changes affect subsequent Bot access decisions.")}</p>
        <div className="flex flex-wrap gap-2"><DiscardPolicyDraft path={path} version={draft.version} onDiscarded={async () => { setDraft(null); setRules(policy.rules); setEditing(false); setError(""); setConflict(false); await onDraftSaved?.() }} /><Button disabled={busy || dirty || draft.lifecycle !== "DRAFT"} variant="outline" onClick={() => void transitionDraft("validate")}>{t("Validate saved draft")}</Button><Button disabled={busy || dirty || draft.lifecycle !== "VALIDATED" || !validated} variant="outline" onClick={() => void transitionDraft("review")}>{t("Review saved draft")}</Button><Button disabled={busy || dirty || !reviewed} onClick={() => void transitionDraft("publish")}>{t("Publish saved draft")}</Button></div>
      </div> : null}
    </CardContent>
  </Card>
}
