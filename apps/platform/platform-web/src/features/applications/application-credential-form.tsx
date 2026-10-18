import { useState, type FormEvent } from "react"
import { GENIOONE_SCOPE_CATALOG, GENIOONE_SCOPES } from "@genioone/protocol/authorization-scopes"
import { KeyRoundIcon, LoaderCircleIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { ApplicationApiCredential, CreateApplicationApiCredentialInput } from "@/domain/contracts"

export type ApplicationCredentialTarget = {
  key: string
  resourceId: string
  resourceName: string
  capabilityId: string
  capabilityName: string
  oauthEligible: boolean
  apiKeyEligible: boolean
}

function localDateTime(epochMilliseconds: number) {
  const date = new Date(epochMilliseconds)
  return new Date(epochMilliseconds - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

export function ApplicationCredentialForm({
  applicationId,
  targets,
  activeCredentials,
  busy,
  onIssue,
}: {
  applicationId: string
  targets: ApplicationCredentialTarget[]
  activeCredentials: ReadonlyArray<Pick<ApplicationApiCredential, "kind" | "resource_id" | "capability_id">>
  busy: boolean
  onIssue: (input: CreateApplicationApiCredentialInput) => Promise<void>
}) {
  const { t } = useTranslation()
  const [kind, setKind] = useState<"API_KEY" | "OAUTH2">("API_KEY")
  const [targetScope, setTargetScope] = useState<"PLATFORM" | "RESOURCE">("PLATFORM")
  const [selection, setSelection] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [expiry, setExpiry] = useState(() => localDateTime(Date.now() + 30 * 86_400_000))
  const [scopes, setScopes] = useState<string[]>([GENIOONE_SCOPES.read])
  const availableTargets = targets.filter((target) => kind === "API_KEY" ? target.apiKeyEligible : target.oauthEligible)
  const selected = availableTargets.find((target) => target.key === selection)
  const needsResource = kind === "OAUTH2" || targetScope === "RESOURCE"
  const hasActiveCredential = activeCredentials.some((credential) => credential.kind === kind
    && credential.resource_id === (needsResource ? selected?.resourceId : null)
    && credential.capability_id === (needsResource ? selected?.capabilityId : null))
  const now = Math.floor(Date.now() / 1000)
  const expiresAt = Math.floor(new Date(expiry).getTime() / 1000)
  const expiryValid = Number.isInteger(expiresAt) && expiresAt > now && expiresAt <= now + 365 * 86_400
  const valid = (!needsResource || Boolean(selected))
    && (kind === "OAUTH2" || (Boolean(displayName.trim()) && expiryValid && scopes.length > 0))
    && !hasActiveCredential
  const basicScopes = GENIOONE_SCOPE_CATALOG.filter((entry) => entry.kind === "RESOURCE"
    && (targetScope === "RESOURCE" || entry.scope !== GENIOONE_SCOPES.invoke))
  const managementScopes = GENIOONE_SCOPE_CATALOG.filter((entry) => entry.kind === "MANAGEMENT")

  function selectKind(value: string) {
    if (value !== "API_KEY" && value !== "OAUTH2") return
    setKind(value)
    setSelection("")
  }

  function selectTargetScope(value: string) {
    if (value !== "PLATFORM" && value !== "RESOURCE") return
    setTargetScope(value)
    setSelection("")
    setScopes([GENIOONE_SCOPES.read])
  }

  function toggleScope(scope: string, checked: boolean) {
    setScopes((current) => checked ? [...current, scope] : current.filter((value) => value !== scope))
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!valid || busy) return
    if (kind === "OAUTH2" && selected) {
      void onIssue({ kind, resourceId: selected.resourceId, capabilityId: selected.capabilityId })
      return
    }
    const input = {
      kind: "API_KEY" as const,
      displayName: displayName.trim(),
      expiresAt,
      scopes,
    }
    void onIssue(targetScope === "RESOURCE" && selected
      ? { ...input, resourceId: selected.resourceId, capabilityId: selected.capabilityId }
      : input)
  }

  return (
    <form onSubmit={submit} data-testid="application-credential-form">
      <FieldGroup>
        <div>
          <h3 className="text-sm font-medium">{t("Issue an Application credential")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("API keys use this Application's current permissions. Grant the Application access or an administrator role before requesting additional rights.")}
          </p>
        </div>
        <Field data-disabled={busy}>
          <FieldLabel id={`credential-kind-${applicationId}`}>{t("Credential type")}</FieldLabel>
          <ToggleGroup variant="outline" value={kind} onValueChange={selectKind} aria-labelledby={`credential-kind-${applicationId}`} disabled={busy}>
            <ToggleGroupItem value="API_KEY">{t("API key")}</ToggleGroupItem>
            <ToggleGroupItem value="OAUTH2">{t("OAuth client")}</ToggleGroupItem>
          </ToggleGroup>
        </Field>
        {kind === "API_KEY" ? (
          <>
            <Field data-disabled={busy}>
              <FieldLabel htmlFor={`credential-name-${applicationId}`}>{t("Key name")}</FieldLabel>
              <Input id={`credential-name-${applicationId}`} value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={256} required disabled={busy} />
            </Field>
            <Field data-disabled={busy}>
              <FieldLabel id={`credential-target-scope-${applicationId}`}>{t("Key access scope")}</FieldLabel>
              <ToggleGroup variant="outline" value={targetScope} onValueChange={selectTargetScope} aria-labelledby={`credential-target-scope-${applicationId}`} disabled={busy}>
                <ToggleGroupItem value="PLATFORM">{t("Platform APIs")}</ToggleGroupItem>
                <ToggleGroupItem value="RESOURCE">{t("One Resource Capability")}</ToggleGroupItem>
              </ToggleGroup>
              <FieldDescription>
                {targetScope === "PLATFORM"
                  ? t("Use Platform APIs within the Application's current role and organization.")
                  : t("Use one authorized API or model Capability. MCP and Agent resources do not accept Application API keys.")}
              </FieldDescription>
            </Field>
          </>
        ) : null}
        {needsResource ? (
          <Field data-disabled={busy || availableTargets.length === 0}>
            <FieldLabel htmlFor={`credential-target-${applicationId}`}>{t("Authorized Resource / Capability")}</FieldLabel>
            <Select value={selection} onValueChange={setSelection} required disabled={busy || availableTargets.length === 0}>
              <SelectTrigger id={`credential-target-${applicationId}`} className="w-full"><SelectValue placeholder={t("Select an authorized Capability")}>{selected ? `${selected.resourceName} · ${selected.capabilityName}` : undefined}</SelectValue></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {availableTargets.map((target) => (
                    <SelectItem key={target.key} value={target.key}>
                      {target.resourceName} · {target.capabilityName}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>
              {availableTargets.length
                ? t("Only current active Application Entitlements are available.")
                : t("No active Application access is available. Request access above or grant an Entitlement first.")}
            </FieldDescription>
          </Field>
        ) : null}
        {kind === "API_KEY" ? (
          <>
            <Field data-invalid={!expiryValid} data-disabled={busy}>
              <FieldLabel htmlFor={`credential-expiry-${applicationId}`}>{t("Expires at")}</FieldLabel>
              <Input
                id={`credential-expiry-${applicationId}`}
                type="datetime-local"
                value={expiry}
                min={localDateTime(Date.now() + 60_000)}
                max={localDateTime(Date.now() + 365 * 86_400_000)}
                onChange={(event) => setExpiry(event.target.value)}
                aria-invalid={!expiryValid}
                required
                disabled={busy}
              />
              <FieldDescription>{t("Choose an expiry within one year. Rotation preserves this expiry and the selected permissions.")}</FieldDescription>
              {!expiryValid ? <FieldError>{t("API_KEY_EXPIRY_INVALID")}</FieldError> : null}
            </Field>
            <FieldSet data-disabled={busy}>
              <FieldLegend variant="label">{t("Permissions")}</FieldLegend>
              <FieldGroup className="gap-3">
                {basicScopes.map((entry) => (
                  <Field key={entry.scope} orientation="horizontal" data-disabled={busy}>
                    <Checkbox id={`credential-scope-${applicationId}-${entry.scope}`} checked={scopes.includes(entry.scope)} onCheckedChange={(checked) => toggleScope(entry.scope, checked)} disabled={busy} aria-invalid={scopes.length === 0} />
                    <FieldContent>
                      <FieldLabel htmlFor={`credential-scope-${applicationId}-${entry.scope}`}>{t(entry.name.en)}</FieldLabel>
                      <FieldDescription>{t(entry.description.en)}</FieldDescription>
                    </FieldContent>
                  </Field>
                ))}
              </FieldGroup>
              {scopes.length === 0 ? <FieldError>{t("Select at least one permission.")}</FieldError> : null}
            </FieldSet>
            {targetScope === "PLATFORM" ? (
              <details>
                <summary className="cursor-pointer text-sm font-medium">{t("Fine-grained management permissions")}</summary>
                <FieldSet className="mt-4" data-disabled={busy}>
                  <FieldLegend variant="label">{t("Management permissions")}</FieldLegend>
                  <FieldDescription>{t("Management permissions still require the Application's administrator role and organization access.")}</FieldDescription>
                  <FieldGroup className="gap-3">
                    {managementScopes.map((entry) => (
                      <Field key={entry.scope} orientation="horizontal" data-disabled={busy}>
                        <Checkbox id={`credential-scope-${applicationId}-${entry.scope}`} checked={scopes.includes(entry.scope)} onCheckedChange={(checked) => toggleScope(entry.scope, checked)} disabled={busy} />
                        <FieldLabel htmlFor={`credential-scope-${applicationId}-${entry.scope}`}>{t(entry.name.en)}</FieldLabel>
                      </Field>
                    ))}
                  </FieldGroup>
                </FieldSet>
              </details>
            ) : null}
          </>
        ) : null}
        {hasActiveCredential ? (
          <FieldDescription role="status">{t("This target already has an active credential of this type. Rotate or revoke it before issuing another.")}</FieldDescription>
        ) : null}
        <Button type="submit" className="self-start" disabled={!valid || busy}>
          {busy ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" /> : <KeyRoundIcon data-icon="inline-start" />}
          {kind === "API_KEY" ? t("Issue API key") : t("Issue OAuth client")}
        </Button>
      </FieldGroup>
    </form>
  )
}
