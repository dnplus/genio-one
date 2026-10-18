import { useEffect, useMemo, useState } from "react"
import { CheckIcon, CopyIcon, LoaderCircleIcon, RefreshCwIcon, XCircleIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { Separator } from "@/components/ui/separator"
import type { ApplicationApiCredential, ApplicationApiCredentialCreation, ApplicationRegistration, CreateApplicationApiCredentialInput, OverviewSnapshot } from "@/domain/contracts"
import { ApplicationCredentialForm, type ApplicationCredentialTarget } from "@/features/applications/application-credential-form"
import { formatEpochSeconds } from "@/lib/personal-preferences"
import { createApplicationApiCredential, listApplicationApiCredentials, revokeApplicationApiCredential, rotateApplicationApiCredential } from "@/lib/product-api"

export function ApplicationCredentialsPanel({
  tenantId,
  application,
  data,
  onChanged,
}: {
  tenantId: string
  application: ApplicationRegistration
  data: OverviewSnapshot
  onChanged: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [credentials, setCredentials] = useState<ApplicationApiCredential[]>([])
  const [issued, setIssued] = useState<ApplicationApiCredentialCreation | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const [feedback, setFeedback] = useState("")
  const [gracePeriodSeconds, setGracePeriodSeconds] = useState("5")
  const [copied, setCopied] = useState(false)
  const now = Math.floor(Date.now() / 1000)
  const grace = Number(gracePeriodSeconds)
  const graceValid = gracePeriodSeconds.trim() !== "" && Number.isInteger(grace) && grace >= 0 && grace <= 86_400
  const targets = useMemo<ApplicationCredentialTarget[]>(() => data.resources
    .filter((resource) => resource.lifecycle === "PUBLISHED" || resource.lifecycle === "DEPRECATED")
    .flatMap((resource) => resource.capabilities
      .filter((capability) => data.ownedEntitlements.some((entitlement) =>
        entitlement.subject_id === application.subject_id
        && entitlement.resource_id === resource.resource_id
        && entitlement.capability_id === capability.capability_id
        && entitlement.state === "ACTIVE"
        && entitlement.valid_from <= now
        && (entitlement.valid_until === null || entitlement.valid_until > now),
      ))
      .map((capability) => ({
        key: `${resource.resource_id}::${capability.capability_id}`,
        resourceId: resource.resource_id,
        resourceName: resource.display_name,
        capabilityId: capability.capability_id,
        capabilityName: capability.display_name ?? capability.capability_id,
        oauthEligible: resource.kind === "API" && resource.api?.inbound_security.type === "OAUTH2",
        apiKeyEligible: resource.kind === "LLM" || (resource.kind === "API" && !resource.api?.a2a),
      }))), [application.subject_id, data.ownedEntitlements, data.resources, now])

  useEffect(() => {
    let active = true
    setLoading(true)
    void listApplicationApiCredentials(tenantId, application.application_id)
      .then((next) => { if (active) setCredentials(next) })
      .catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : t("API credential load failed")) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [application.application_id, t, tenantId])

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 2000)
    return () => window.clearTimeout(timer)
  }, [copied])

  async function reloadCredentials() {
    setCredentials(await listApplicationApiCredentials(tenantId, application.application_id))
  }

  async function reload() {
    setLoading(true)
    setError("")
    try {
      await reloadCredentials()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("API credential load failed"))
    } finally {
      setLoading(false)
    }
  }

  async function changeCredential(action: string, operation: () => Promise<ApplicationApiCredentialCreation | ApplicationApiCredential>) {
    setBusy(action)
    setError("")
    setFeedback("")
    setIssued(null)
    setCopied(false)
    try {
      const result = await operation()
      const credential = "credential" in result ? result.credential : result
      if ("credential" in result) setIssued(result)
      setFeedback(credential.kind === "API_KEY" && credential.resource_id
        ? "Resource API key changes are saved. They take effect when the Gateway finishes applying them."
        : "Application credential change saved.")
      await Promise.all([reloadCredentials(), onChanged()])
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Application credential change failed"))
    } finally {
      setBusy("")
    }
  }

  function issue(input: CreateApplicationApiCredentialInput) {
    return changeCredential("issue", () => createApplicationApiCredential(tenantId, application.application_id, input))
  }

  async function copySecret(secret: string) {
    try {
      await navigator.clipboard.writeText(secret)
      setCopied(true)
    } catch {
      setError("The secret could not be copied. Select it and copy it manually before closing this panel.")
    }
  }

  const secret = issued?.api_key ?? issued?.oauth_client_secret

  return (
    <section className="flex flex-col gap-4" data-testid="application-credentials-panel">
      <ApplicationCredentialForm applicationId={application.application_id} targets={targets} activeCredentials={credentials.filter((credential) => credential.state === "ACTIVE")} busy={Boolean(busy) || loading} onIssue={issue} />
      {secret && issued ? (
        <Alert data-testid={issued.api_key ? "api-key-secret" : "oauth-client-secret"}>
          <AlertTitle>{issued.api_key ? t("Copy this API key now") : t("Copy this OAuth client secret now")}</AlertTitle>
          <AlertDescription>
            {issued.api_key
              ? t("GenioOne shows the complete secret only once. Copy it before closing this panel.")
              : t("GenioOne shows the complete client secret only once. Save it with the token endpoint before closing this panel.")}
          </AlertDescription>
          <div className="mt-3 flex flex-col gap-2 text-xs">
            {issued.api_key ? (
              <>
                {issued.credential.expires_at !== null ? <div><span className="text-muted-foreground">{t("Expires at")}: </span>{formatEpochSeconds(issued.credential.expires_at)}</div> : null}
                <div><span className="text-muted-foreground">{t("Permissions")}: </span><span className="break-all font-mono">{issued.credential.scopes.join(" ")}</span></div>
                <p>{issued.credential.resource_id ? t("Send this key in the x-api-key header for the selected Resource.") : t("Send this key as an Authorization: Bearer token to Platform APIs.")}</p>
              </>
            ) : (
              <>
                <div><span className="text-muted-foreground">{t("Client ID")}: </span><span className="font-mono">{issued.credential.oauth_client_id}</span></div>
                <div><span className="text-muted-foreground">{t("Token endpoint")}: </span><span className="break-all font-mono">{issued.oauth_token_endpoint}</span></div>
                <div><span className="text-muted-foreground">{t("Scope")}: </span><span className="font-mono">{issued.credential.oauth_scope}</span></div>
              </>
            )}
          </div>
          <InputGroup className="mt-3 h-10">
            <InputGroupInput className="font-mono" readOnly value={secret} aria-label={issued.api_key ? t("One-time API key") : t("One-time OAuth client secret")} />
            <InputGroupAddon align="inline-end">
              <InputGroupButton aria-label={issued.api_key ? t("Copy API key") : t("Copy OAuth client secret")} onClick={() => void copySecret(secret)}>
                {copied ? <CheckIcon /> : <CopyIcon />}
                {t(copied ? "Copied" : "Copy")}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </Alert>
      ) : null}
      {feedback ? <Alert><AlertDescription>{t(feedback)}</AlertDescription></Alert> : null}
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{t(error)}</AlertDescription>
          <Button type="button" variant="outline" size="sm" className="mt-3 self-start" disabled={loading || Boolean(busy)} onClick={() => void reload()}>{t("Reload credentials")}</Button>
        </Alert>
      ) : null}
      <Separator />
      <div>
        <h3 className="text-sm font-medium">{t("Issued credentials")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t("Rotate credentials with a grace period, or revoke them. Resource API key changes require Gateway application.")}</p>
      </div>
      <Field data-invalid={!graceValid}>
        <FieldLabel htmlFor={`credential-grace-${application.application_id}`}>{t("Old key grace period (seconds)")}</FieldLabel>
        <Input id={`credential-grace-${application.application_id}`} type="number" min="0" max="86400" step="1" value={gracePeriodSeconds} aria-invalid={!graceValid} onChange={(event) => setGracePeriodSeconds(event.target.value)} />
        <FieldDescription>{t("Choose zero to retire the old credential without a grace period. Maximum: 86400 seconds.")}</FieldDescription>
        {!graceValid ? <FieldError>{t("Credential grace period must be between 0 and 86400 seconds.")}</FieldError> : null}
      </Field>
      {loading ? <p role="status">{t("Loading credentials…")}</p> : credentials.length ? credentials.map((credential) => {
        const resource = data.resources.find((candidate) => candidate.resource_id === credential.resource_id)
        const capability = resource?.capabilities.find((candidate) => candidate.capability_id === credential.capability_id)
        const expired = credential.expires_at !== null && credential.expires_at <= now
        return (
          <div key={credential.credential_id} className="flex flex-col gap-3 rounded-lg border p-4" data-testid={`application-credential-${credential.credential_id}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="font-medium">{credential.display_name ?? credential.oauth_client_id ?? credential.credential_id}</div>
                <div className="break-all font-mono text-xs text-muted-foreground">{credential.credential_id} · {t("Generation")} {credential.generation}</div>
              </div>
              <div className="flex gap-2">
                <Badge variant="secondary">{credential.kind === "API_KEY" ? t("API key") : t("OAuth client")}</Badge>
                <Badge variant="outline">{expired && credential.state === "ACTIVE" ? t("Expired") : t(credential.state)}</Badge>
              </div>
            </div>
            <div className="flex flex-col gap-1 text-xs text-muted-foreground">
              <div>{credential.resource_id ? `${resource?.display_name ?? credential.resource_id} · ${capability?.display_name ?? credential.capability_id}` : t("Platform APIs")}</div>
              {credential.key_prefix ? <div className="font-mono">{t("Key prefix")}: {credential.key_prefix}</div> : null}
              {credential.expires_at !== null ? <div>{t("Expires at")}: {formatEpochSeconds(credential.expires_at)}</div> : null}
              {credential.valid_until !== null ? <div>{t("Valid until")}: {formatEpochSeconds(credential.valid_until)}</div> : null}
              <div className="break-all font-mono">{credential.scopes.join(" ")}</div>
            </div>
            {credential.state === "ACTIVE" ? (
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" disabled={Boolean(busy) || !graceValid || expired} onClick={() => void changeCredential(`rotate::${credential.credential_id}`, () => rotateApplicationApiCredential(tenantId, application.application_id, credential.credential_id, grace))}>
                  {busy === `rotate::${credential.credential_id}` ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" /> : <RefreshCwIcon data-icon="inline-start" />}
                  {credential.kind === "API_KEY" ? t("Rotate API key") : t("Rotate OAuth client")}
                </Button>
                <Button type="button" size="sm" variant="destructive" disabled={Boolean(busy)} onClick={() => void changeCredential(`revoke::${credential.credential_id}`, () => revokeApplicationApiCredential(tenantId, application.application_id, credential.credential_id))}>
                  {busy === `revoke::${credential.credential_id}` ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" /> : <XCircleIcon data-icon="inline-start" />}
                  {t("Revoke")}
                </Button>
              </div>
            ) : null}
          </div>
        )
      }) : <p className="text-sm text-muted-foreground">{t("No API credentials have been issued for this Application.")}</p>}
    </section>
  )
}
