import { useEffect, useState } from "react"
import { KeyRoundIcon, LoaderCircleIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle,
} from "@/components/ui/sheet"
import {
  createIdentityProvider, deleteIdentityProvider, listIdentityProviders, updateIdentityProvider,
  type IdentityProvider, type IdentityProviderPreset,
} from "@/lib/product-api"

interface PresetOption {
  preset: IdentityProviderPreset
  label: string
  /** Shown under the discovery field so operators know what to paste. */
  discoveryHint?: string
  requiresDiscoveryUrl: boolean
}

const presetOptions: PresetOption[] = [
  { preset: "google", label: "Google", requiresDiscoveryUrl: false },
  { preset: "github", label: "GitHub", requiresDiscoveryUrl: false },
  {
    preset: "entra-id",
    label: "Microsoft Entra ID",
    discoveryHint: "https://login.microsoftonline.com/<tenant>/v2.0/.well-known/openid-configuration",
    requiresDiscoveryUrl: true,
  },
  {
    preset: "okta",
    label: "Okta",
    discoveryHint: "https://<domain>.okta.com/.well-known/openid-configuration",
    requiresDiscoveryUrl: true,
  },
  {
    preset: "oidc",
    label: "OpenID Connect",
    discoveryHint: "https://<issuer>/.well-known/openid-configuration",
    requiresDiscoveryUrl: true,
  },
]

export function IdentityProvidersCard({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation()
  const [providers, setProviders] = useState<IdentityProvider[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [selected, setSelected] = useState<PresetOption | null>(null)
  const [editing, setEditing] = useState<IdentityProvider | null>(null)

  async function reload() {
    setLoading(true)
    try {
      setProviders((await listIdentityProviders(tenantId)).providers)
      setError("")
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void reload() }, [tenantId])

  async function remove(alias: string) {
    try {
      await deleteIdentityProvider(tenantId, alias)
      await reload()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const configured = new Set(providers.map((provider) => provider.preset))

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Login methods")}</CardTitle>
        <CardDescription>
          {t("Identity providers people can sign in with. These apply to every Organization in this tenant.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        {error ? <p className="text-sm text-destructive" role="alert">{t(error)}</p> : null}

        {loading ? (
          <p className="text-sm text-muted-foreground">
            <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />{t("Loading")}
          </p>
        ) : providers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("No identity provider is connected. People sign in with their GenioOne account only.")}
          </p>
        ) : (
          <ul className="grid gap-2">
            {providers.map((provider) => (
              <li key={provider.alias} className="flex items-center justify-between gap-3 rounded-md border px-4 py-3">
                <div className="grid gap-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{provider.display_name}</span>
                    <Badge variant={provider.enabled ? "default" : "outline"}>
                      {provider.enabled ? t("Enabled") : t("Disabled")}
                    </Badge>
                    {provider.hidden_on_login_page
                      ? <Badge variant="outline">{t("Hidden on login page")}</Badge>
                      : null}
                  </div>
                  <span className="text-xs text-muted-foreground">{provider.alias} · {provider.kind}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => setEditing(provider)}>{t("Edit")}</Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t("Remove")}
                    onClick={() => void remove(provider.alias)}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="grid gap-2">
          <p className="text-sm font-medium">{t("Add a login method")}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {presetOptions.map((option) => (
              <Button
                key={option.preset}
                variant="outline"
                className="justify-start"
                // A preset already in use is not offered again; the operator
                // edits the existing method instead of creating a duplicate.
                disabled={configured.has(option.preset) && option.preset !== "oidc"}
                onClick={() => setSelected(option)}
              >
                <KeyRoundIcon data-icon="inline-start" />
                {option.label}
                {configured.has(option.preset) && option.preset !== "oidc"
                  ? <span className="ml-auto text-xs text-muted-foreground">{t("Added")}</span>
                  : null}
              </Button>
            ))}
          </div>
        </div>
      </CardContent>

      <AddIdentityProviderSheet
        tenantId={tenantId}
        option={selected}
        onClose={() => setSelected(null)}
        onSaved={reload}
      />
      <EditIdentityProviderSheet
        tenantId={tenantId}
        provider={editing}
        onClose={() => setEditing(null)}
        onSaved={reload}
      />
    </Card>
  )
}

function AddIdentityProviderSheet({ tenantId, option, onClose, onSaved }: {
  tenantId: string
  option: PresetOption | null
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")
  const [discoveryUrl, setDiscoveryUrl] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [created, setCreated] = useState<IdentityProvider | null>(null)

  useEffect(() => {
    setClientId("")
    setClientSecret("")
    setDiscoveryUrl("")
    setError("")
    setCreated(null)
  }, [option])

  if (!option) return null
  const complete = clientId.trim() && clientSecret.trim() &&
    (!option.requiresDiscoveryUrl || discoveryUrl.trim())

  async function submit() {
    setBusy(true)
    setError("")
    try {
      setCreated(await createIdentityProvider(tenantId, {
        preset: option!.preset,
        client_id: clientId.trim(),
        client_secret: clientSecret,
        ...(discoveryUrl.trim() ? { discovery_url: discoveryUrl.trim() } : {}),
      }))
      await onSaved()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open onOpenChange={(next) => { if (!next) onClose() }}>
      <SheetContent className="w-full sm:max-w-lg">
        <SheetHeader className="border-b px-6 py-5">
          <SheetTitle>{option.label}</SheetTitle>
          <SheetDescription>
            {t("Register the application you created with this provider, then allow its redirect URI.")}
          </SheetDescription>
        </SheetHeader>
        {created ? (
          <FieldGroup className="p-6">
            <p className="text-sm">{t("Added. Allow this redirect URI with the provider:")}</p>
            <code className="block break-all rounded-md bg-muted px-3 py-2 text-xs">{created.redirect_uri}</code>
            <p className="text-sm text-muted-foreground">
              {t("Sign-in through this provider fails until the provider accepts that URI.")}
            </p>
          </FieldGroup>
        ) : (
          <FieldGroup className="p-6">
            {option.requiresDiscoveryUrl ? (
              <Field>
                <FieldLabel htmlFor="idp-discovery">{t("Discovery URL")}</FieldLabel>
                <Input
                  id="idp-discovery"
                  value={discoveryUrl}
                  placeholder={option.discoveryHint}
                  onChange={(event) => setDiscoveryUrl(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {t("The OpenID Connect metadata document. Endpoints are read from it.")}
                </p>
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor="idp-client-id">{t("Client ID")}</FieldLabel>
              <Input id="idp-client-id" value={clientId} onChange={(event) => setClientId(event.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="idp-client-secret">{t("Client secret")}</FieldLabel>
              <Input
                id="idp-client-secret"
                type="password"
                value={clientSecret}
                onChange={(event) => setClientSecret(event.target.value)}
              />
            </Field>
            {error ? <p className="text-sm text-destructive" role="alert">{t(error)}</p> : null}
          </FieldGroup>
        )}
        <SheetFooter className="mt-auto border-t bg-background px-6 py-4">
          <Button variant="outline" onClick={onClose}>{created ? t("Close") : t("Cancel")}</Button>
          {created ? null : (
            <Button disabled={busy || !complete} onClick={() => void submit()}>
              {busy ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" /> : <PlusIcon data-icon="inline-start" />}
              {t("Add")}
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function EditIdentityProviderSheet({ tenantId, provider, onClose, onSaved }: {
  tenantId: string
  provider: IdentityProvider | null
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useState(true)
  const [hidden, setHidden] = useState(false)
  const [clientSecret, setClientSecret] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!provider) return
    setEnabled(provider.enabled)
    setHidden(provider.hidden_on_login_page)
    setClientSecret("")
    setError("")
  }, [provider])

  if (!provider) return null

  async function submit() {
    setBusy(true)
    setError("")
    try {
      await updateIdentityProvider(tenantId, provider!.alias, {
        enabled,
        hidden_on_login_page: hidden,
        // An empty field leaves the stored secret untouched.
        ...(clientSecret ? { client_secret: clientSecret } : {}),
      })
      await onSaved()
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open onOpenChange={(next) => { if (!next) onClose() }}>
      <SheetContent className="w-full sm:max-w-lg">
        <SheetHeader className="border-b px-6 py-5">
          <SheetTitle>{provider.display_name}</SheetTitle>
          <SheetDescription>{t("Change how this login method behaves.")}</SheetDescription>
        </SheetHeader>
        <FieldGroup className="p-6">
          <Field>
            <FieldLabel htmlFor="idp-redirect">{t("Redirect URI")}</FieldLabel>
            <code id="idp-redirect" className="block break-all rounded-md bg-muted px-3 py-2 text-xs">
              {provider.redirect_uri}
            </code>
          </Field>
          <div className="flex items-center justify-between gap-3">
            <FieldLabel htmlFor="idp-enabled">{t("Enabled")}</FieldLabel>
            <Switch id="idp-enabled" checked={enabled} onCheckedChange={setEnabled} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <FieldLabel htmlFor="idp-hidden">{t("Hidden on login page")}</FieldLabel>
            <Switch id="idp-hidden" checked={hidden} onCheckedChange={setHidden} />
          </div>
          <Field>
            <FieldLabel htmlFor="idp-rotate-secret">{t("Replace client secret")}</FieldLabel>
            <Input
              id="idp-rotate-secret"
              type="password"
              value={clientSecret}
              placeholder={t("Leave empty to keep the current secret")}
              onChange={(event) => setClientSecret(event.target.value)}
            />
          </Field>
          {error ? <p className="text-sm text-destructive" role="alert">{t(error)}</p> : null}
        </FieldGroup>
        <SheetFooter className="mt-auto border-t bg-background px-6 py-4">
          <Button variant="outline" onClick={onClose}>{t("Cancel")}</Button>
          <Button disabled={busy} onClick={() => void submit()}>
            {busy ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" /> : null}
            {t("Save")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
