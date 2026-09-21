import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import { getPolicyAuthoringSettings, ProductApiError, savePolicyAuthoringSettings, type PolicyAuthoringSettings } from "@/lib/product-api"

function isSettingsConflict(error: unknown) {
  return error instanceof ProductApiError && error.status === 409 && error.message === "POLICY_AUTHORING_SETTINGS_CONFLICT"
}

export function PolicyAuthoringGovernanceCard({ tenantId, onSaved }: {
  tenantId: string
  onSaved?: () => void | Promise<void>
}) {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<PolicyAuthoringSettings | null>(null)
  const [requireDistinctReviewer, setRequireDistinctReviewer] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [conflict, setConflict] = useState(false)
  const [notice, setNotice] = useState("")

  async function load() {
    setLoading(true)
    setError("")
    setConflict(false)
    try {
      const value = await getPolicyAuthoringSettings(tenantId)
      setSettings(value)
      setRequireDistinctReviewer(value.require_distinct_reviewer)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "POLICY_AUTHORING_SETTINGS_LOAD_FAILED")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [tenantId])

  const dirty = settings !== null && requireDistinctReviewer !== settings.require_distinct_reviewer

  async function save() {
    if (!settings) return
    setSaving(true)
    setError("")
    setConflict(false)
    try {
      const value = await savePolicyAuthoringSettings(tenantId, {
        expected_revision: settings.revision,
        require_distinct_reviewer: requireDistinctReviewer,
      })
      setSettings(value)
      setRequireDistinctReviewer(value.require_distinct_reviewer)
      setNotice("Policy authoring governance saved.")
      await onSaved?.()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "POLICY_AUTHORING_SETTINGS_SAVE_FAILED")
      setConflict(isSettingsConflict(caught))
    } finally {
      setSaving(false)
    }
  }

  return <Card data-testid="policy-authoring-governance">
    <CardHeader>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>{t("Policy authoring governance")}</CardTitle>
        {settings ? <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{t("Revision")} {settings.revision}</Badge><Badge variant={settings.require_distinct_reviewer ? "secondary" : "outline"}>{t(settings.require_distinct_reviewer ? "Four-eyes required" : "CE self-review allowed")}</Badge></div> : null}
      </div>
      <CardDescription>{t("Set the review separation required before a policy draft can be published.")}</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-4">
      {error ? <Alert variant="destructive"><AlertTitle>{t(conflict ? "Policy authoring settings changed on server" : "Unable to save policy authoring governance")}</AlertTitle><AlertDescription><div className="flex flex-col items-start gap-2"><span>{t(error)}</span>{conflict ? <><span>{t("Another administrator changed this setting. Reload before saving your change.")}</span><Button disabled={saving} onClick={() => void load()} size="sm" type="button" variant="outline">{t("Reload authoring settings")}</Button></> : null}</div></AlertDescription></Alert> : null}
      {notice ? <Alert role="status"><AlertDescription>{t(notice)}</AlertDescription></Alert> : null}
      {loading && !settings ? <p className="text-sm text-muted-foreground">{t("Loading")}</p> : settings ? <>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="require-distinct-policy-reviewer">{t("Require a distinct reviewer")}</FieldLabel>
            <FieldDescription>{t(requireDistinctReviewer ? "A different Tenant Administrator must review the saved draft before it can be published." : "CE default: the draft author may review their own saved draft. Validation and review evidence remain server-persisted.")}</FieldDescription>
          </FieldContent>
          <Switch checked={requireDistinctReviewer} disabled={saving} id="require-distinct-policy-reviewer" onCheckedChange={setRequireDistinctReviewer} />
        </Field>
        <p className="text-sm text-muted-foreground">{t("This setting is checked when a saved draft moves from validated to reviewed. It does not replace validation, audit evidence, or publication controls.")}</p>
        {settings.updated_at ? <p className="text-xs text-muted-foreground">{t("Last updated")} {new Date(settings.updated_at * 1000).toLocaleString()}</p> : null}
        {dirty ? <Badge className="w-fit" variant="outline">{t("Governance changes not saved")}</Badge> : null}
      </> : null}
      {!loading && !settings ? <Button className="self-start" onClick={() => void load()} type="button" variant="outline">{t("Retry")}</Button> : null}
    </CardContent>
    {settings ? <CardFooter className="justify-end gap-2">
      <Button disabled={saving || !dirty} onClick={() => { setRequireDistinctReviewer(settings.require_distinct_reviewer); setError(""); setConflict(false) }} type="button" variant="outline">{t("Cancel")}</Button>
      <Button disabled={saving || !dirty} onClick={() => void save()} type="button">{saving ? t("Saving") : t("Save governance settings")}</Button>
    </CardFooter> : null}
  </Card>
}
