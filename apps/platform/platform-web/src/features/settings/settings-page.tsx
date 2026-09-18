import { } from "@/components/relation-value"
import { PageHeader } from "@/components/page-header"
import { } from "@tanstack/react-table"
import {
  SaveIcon,
  ShieldCheckIcon,
  BellIcon,
  Settings2Icon,
} from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import genioOneIconLightLogo from "../../../../../../packages/brand/assets/logos/genioone-icon-color-light.svg"
import genioOneLightLogo from "../../../../../../packages/brand/assets/logos/genioone-horizontal-color-light.svg"

import { } from "@/components/data-table/data-table"
import { } from "@/components/data-table/record-filter-bar"
import { DataEmpty } from "@/components/data-empty"
import { } from "@/components/ui/searchable-select"
import { } from "@/components/route-badge"
import { TitleHelp } from "@/components/title-help"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { } from "@/components/ui/checkbox"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { IdentitySession, OverviewSnapshot, TenantConfiguration, TenantConfigurationRevision, TenantLoginBranding, NotificationSubscription, NotificationChannel, NotificationType } from "@/domain/contracts"
import { ProviderCredentialProfilesPanel } from "@/features/provider-credentials/provider-credential-profiles-panel"
import { } from "@/features/access/access-request-sheet"
import { } from "@/features/access/grant-entitlement-sheet"
import { } from "@/features/access/execution-grant-requests-card"
import { } from "@/features/access/revoke-entitlement-sheet"
import { } from "@/features/activity/audit-decision-sheet"
import { } from "@/features/activity/ai-usage-dashboard"
import { } from "@/features/activity/usage-governance-panel"
import { } from "@/features/activity/activity-evidence"
import { } from "@/features/activity/activity-display"
import { } from "@/features/activity/api-gateway-transaction-sheet"
import { } from "@/features/activity/classify-discoveries-sheet"
import { } from "@/features/self-service/access-lifecycle"
export { ResourceCatalogPage as ResourcesPage } from "@/features/resources/resource-catalog-page"
import { } from "@/features/runtimes/register-gateway-sheet"
import { } from "@/features/runtimes/gateway-diagnostics-sheet"
import { } from "@/features/identity/create-organization-sheet"
import { } from "@/features/identity/manage-organization-sheet"
import { } from "@/features/identity/register-agent-sheet"
import { } from "@/features/identity/agent-delegations-card"
import { } from "@/features/identity/identity-providers-card"
import { } from "@/features/identity/suspend-person-action"
import { } from "@/domain/organization-roles"
import { relativeTime } from "@/lib/format"
import { } from "@/lib/personal-preferences"
import {
  configureSiemDestination,
  cancelNotificationSubscription,
  createConfigurationRevision,
  listConfigurationRevisions,
  listNotificationSubscriptions,
  retryConfigurationProjection,
  transitionConfigurationRevision,
  upsertNotificationSubscription,
} from "@/lib/product-api"

function latestConfigurationRevision(
  revisions: TenantConfigurationRevision[],
): TenantConfigurationRevision | null {
  return revisions.reduce<TenantConfigurationRevision | null>((latest, revision) => {
    if (!latest) return revision
    if (revision.created_at !== latest.created_at) {
      return revision.created_at > latest.created_at ? revision : latest
    }
    return revision.revision > latest.revision ? revision : latest
  }, null)
}

const defaultTenantLoginBranding: TenantLoginBranding = {
  tagline: "企業 AI 存取治理控制平面",
  logo_url: "",
  primary_color: "#425fea",
  page_color: "#f7f8fa",
  custom_css: "",
}

const loginLogoPlaceholder = "https://cdn.example.com/logo.svg"

function previewColor(value: string, fallback: string): string {
  return /^#[0-9A-Fa-f]{6}$/.test(value) ? value : fallback
}

function LoginBrandingPreview({
  brandName,
  branding,
}: {
  brandName: string
  branding: TenantLoginBranding
}) {
  const { t } = useTranslation()
  const previewBrandName = brandName.trim() || "GenioOne"
  const primaryColor = previewColor(branding.primary_color, defaultTenantLoginBranding.primary_color)
  const pageColor = previewColor(branding.page_color, defaultTenantLoginBranding.page_color)
  const tagline = branding.tagline.trim() || t("Add a tagline to show it here.")
  const customLogo = branding.logo_url.trim()
  const useDefaultWordmark = !customLogo && previewBrandName === "GenioOne"

  return (
    <div className="min-w-0 rounded-xl border bg-muted/20 p-4">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="font-medium">{t("Login page preview")}</div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("Preview updates as you edit; publish to apply it to the next sign-in.")}</p>
        </div>
        <Badge variant="outline">{t("Live")}</Badge>
      </div>
      <div className="border bg-[#f7f8fa] p-4 sm:p-6" style={{ backgroundColor: pageColor }}>
        <div className="mx-auto max-w-[300px] overflow-hidden rounded-lg border bg-background shadow-sm">
          <div className="border-b p-5">
            <div className="flex min-w-0 items-center gap-2.5">
              <img src={customLogo || (useDefaultWordmark ? genioOneLightLogo : genioOneIconLightLogo)} alt={useDefaultWordmark ? previewBrandName : ""} aria-hidden={useDefaultWordmark ? undefined : true} className={useDefaultWordmark ? "h-8 max-w-[160px] object-contain object-left" : "size-8 shrink-0 object-contain"} />
              {!useDefaultWordmark ? <span className="min-w-0 break-words text-sm font-semibold">{previewBrandName}</span> : null}
            </div>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">{tagline}</p>
          </div>
          <div className="space-y-4 p-5">
            <div>
              <div className="text-lg font-semibold tracking-tight">{t("Sign in")}</div>
              <div className="mt-1 text-xs text-muted-foreground">{t("Use your enterprise account")}</div>
            </div>
            <div className="space-y-3">
              <div><div className="mb-1.5 text-[0.65rem] font-medium text-muted-foreground">{t("Username or email")}</div><div className="h-9 rounded-md border bg-background" /></div>
              <div><div className="mb-1.5 text-[0.65rem] font-medium text-muted-foreground">{t("Password")}</div><div className="h-9 rounded-md border bg-background" /></div>
              <div className="flex h-11 items-center justify-center rounded-md text-xs font-semibold text-white" style={{ backgroundColor: primaryColor }}>{t("Sign in")}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}


export function SettingsPage({
  tenantId,
  identity,
  data,
  onReload,
}: {
  tenantId: string
  identity: IdentitySession
  data: OverviewSnapshot
  onReload: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [destinationId, setDestinationId] = useState(data.siemDestination?.destination_id ?? "primary")
  const [endpointUrl, setEndpointUrl] = useState(data.siemDestination?.endpoint_url ?? "")
  const [eventKinds, setEventKinds] = useState(data.siemDestination?.event_kinds.join(", ") ?? "")
  const [siemEnabled, setSiemEnabled] = useState(data.siemDestination?.enabled ?? true)
  const [siemBusy, setSiemBusy] = useState(false)
  const [siemResult, setSiemResult] = useState<string | null>(null)
  const [configurationRevisions, setConfigurationRevisions] = useState<TenantConfigurationRevision[]>([])
  const [notificationSubscriptions, setNotificationSubscriptions] = useState<NotificationSubscription[]>([])
  const [configurationBusy, setConfigurationBusy] = useState(false)
  const [configurationResult, setConfigurationResult] = useState<string | null>(null)
  const [brandName, setBrandName] = useState("GenioOne")
  const [loginTagline, setLoginTagline] = useState(defaultTenantLoginBranding.tagline)
  const [loginLogoUrl, setLoginLogoUrl] = useState(defaultTenantLoginBranding.logo_url)
  const [loginPrimaryColor, setLoginPrimaryColor] = useState(defaultTenantLoginBranding.primary_color)
  const [loginPageColor, setLoginPageColor] = useState(defaultTenantLoginBranding.page_color)
  const [loginCustomCss, setLoginCustomCss] = useState(defaultTenantLoginBranding.custom_css)
  const [language, setLanguage] = useState("zh-TW")
  const [catalogVisibility, setCatalogVisibility] = useState("ENTITLED_AND_REQUESTABLE")
  const [defaultTtlSeconds, setDefaultTtlSeconds] = useState("28800")
  const [notificationType, setNotificationType] = useState<NotificationType>("ACCESS_REQUEST")
  const notificationChannel: NotificationChannel = "IN_APP"

  async function loadConfigurationData() {
    const [revisions, subscriptions] = await Promise.allSettled([
      listConfigurationRevisions(tenantId),
      listNotificationSubscriptions(tenantId),
    ])
    const revisionValues = revisions.status === "fulfilled" ? revisions.value : []
    setConfigurationRevisions(revisionValues)
    if (subscriptions.status === "rejected") throw subscriptions.reason
    setNotificationSubscriptions(subscriptions.value)
    const latest = latestConfigurationRevision(revisionValues)
    if (latest) {
      setBrandName(latest.settings.brand_name)
      const branding = latest.settings.login_branding ?? defaultTenantLoginBranding
      setLoginTagline(branding.tagline)
      setLoginLogoUrl(branding.logo_url)
      setLoginPrimaryColor(branding.primary_color)
      setLoginPageColor(branding.page_color)
      setLoginCustomCss(branding.custom_css)
      setLanguage(latest.settings.language)
      setCatalogVisibility(latest.settings.catalog_visibility)
      setDefaultTtlSeconds(String(latest.settings.request_form.default_ttl_seconds))
    }
  }

  useEffect(() => {
    void loadConfigurationData().catch((error) => {
      setConfigurationResult(error instanceof Error ? error.message : t("Configuration could not be loaded."))
    })
  }, [tenantId, t])

  async function createDraft() {
    setConfigurationBusy(true)
    setConfigurationResult(null)
    try {
      const settings: TenantConfiguration = {
        brand_name: brandName.trim() || "GenioOne",
        login_branding: {
          tagline: loginTagline.trim(),
          logo_url: loginLogoUrl.trim(),
          primary_color: loginPrimaryColor,
          page_color: loginPageColor,
          custom_css: loginCustomCss,
        },
        language: language.trim() || "en",
        catalog_visibility: catalogVisibility.trim() || "ENTITLED_AND_REQUESTABLE",
        request_form: {
          enabled: true,
          required_fields: ["justification", "requested_ttl"],
          default_ttl_seconds: Number(defaultTtlSeconds) || 28_800,
        },
        ttl_options_seconds: [3_600, 28_800, 86_400],
        approval_workflow_version: "v1.1-default",
        notification_channels: ["IN_APP"],
      }
      await createConfigurationRevision(tenantId, settings)
      await loadConfigurationData()
      setConfigurationResult(t("Draft created. Validate, preview, review, then publish to apply the login branding."))
    } catch (error) {
      setConfigurationResult(error instanceof Error ? error.message : t("Configuration draft could not be created."))
    } finally {
      setConfigurationBusy(false)
    }
  }

  async function transitionLatest(transition: "validate" | "preview" | "review" | "publish") {
    const latest = latestConfigurationRevision(configurationRevisions)
    if (!latest) return
    setConfigurationBusy(true)
    setConfigurationResult(null)
    try {
      await transitionConfigurationRevision(tenantId, latest.revision, transition)
      await loadConfigurationData()
      setConfigurationResult(t({
        validate: "Configuration validated.",
        preview: "Configuration previewed.",
        review: "Configuration reviewed.",
        publish: "Configuration published. The login page will use it on the next sign-in.",
      }[transition]))
    } catch (error) {
      setConfigurationResult(error instanceof Error ? error.message : t("Configuration transition failed."))
    } finally {
      setConfigurationBusy(false)
    }
  }

  async function retryLatestProjection() {
    const latest = configurationRevisions.at(-1)
    if (!latest) return
    setConfigurationBusy(true)
    try {
      await retryConfigurationProjection(tenantId, latest.revision)
      await loadConfigurationData()
      setConfigurationResult(t("Projection retry converged."))
    } catch (error) {
      setConfigurationResult(error instanceof Error ? error.message : t("Projection retry failed."))
    } finally {
      setConfigurationBusy(false)
    }
  }

  async function saveNotificationSubscription(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setConfigurationBusy(true)
    try {
      await upsertNotificationSubscription(tenantId, {
        notificationType,
        channel: notificationChannel,
        enabled: true,
      })
      await loadConfigurationData()
      setConfigurationResult(t("Notification subscription saved."))
    } catch (error) {
      setConfigurationResult(error instanceof Error ? error.message : t("Notification subscription could not be saved."))
    } finally {
      setConfigurationBusy(false)
    }
  }

  async function disableNotificationSubscription(subscriptionId: string) {
    setConfigurationBusy(true)
    try {
      await cancelNotificationSubscription(tenantId, subscriptionId)
      await loadConfigurationData()
      setConfigurationResult(t("Notification subscription disabled."))
    } catch (error) {
      setConfigurationResult(error instanceof Error ? error.message : t("Notification subscription could not be disabled."))
    } finally {
      setConfigurationBusy(false)
    }
  }

  useEffect(() => {
    setDestinationId(data.siemDestination?.destination_id ?? "primary")
    setEndpointUrl(data.siemDestination?.endpoint_url ?? "")
    setEventKinds(data.siemDestination?.event_kinds.join(", ") ?? "")
    setSiemEnabled(data.siemDestination?.enabled ?? true)
  }, [data.siemDestination])

  async function saveSiemDestination(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSiemBusy(true)
    setSiemResult(null)
    try {
      await configureSiemDestination(tenantId, {
        destinationId: destinationId.trim(),
        endpointUrl: endpointUrl.trim(),
        eventKinds: eventKinds
          .split(/[\s,]+/)
          .map((kind) => kind.trim().toUpperCase())
          .filter(Boolean),
        enabled: siemEnabled,
      })
      await onReload()
      setSiemResult(t("SIEM destination saved. Matching Audit Events now use durable delivery."))
    } catch (error) {
      setSiemResult(error instanceof Error ? error.message : t("SIEM destination could not be saved."))
    } finally {
      setSiemBusy(false)
    }
  }

  const latestConfiguration = latestConfigurationRevision(configurationRevisions)

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t("Settings")}
        description={t("System integrations, notifications, and tenant configuration.")}
      />
      <details className="rounded-xl border p-4"><summary className="cursor-pointer font-medium">{t("Provider credentials")}</summary><div className="mt-4">      <ProviderCredentialProfilesPanel tenantId={tenantId} organizations={data.organizations} />
</div></details>
      <details className="rounded-xl border p-4"><summary className="cursor-pointer font-medium">{t("OIDC management session")}</summary><div className="mt-4">      <Card className="max-w-2xl">
        <CardHeader className="border-b">
          <CardTitle><TitleHelp help={t("This session was issued by the configured OIDC provider; bearer tokens are not entered in the product UI.")}>{t("OIDC management session")}</TitleHelp></CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="settings-tenant">{t("Tenant")}</FieldLabel>
              <Input id="settings-tenant" value={tenantId} readOnly aria-readonly="true" />
            </Field>
            <Field>
              <FieldLabel htmlFor="settings-subject">{t("Authenticated Subject")}</FieldLabel>
              <Input id="settings-subject" value={identity.subject_id} readOnly aria-readonly="true" />
            </Field>
            <Field>
              <FieldLabel htmlFor="settings-client">{t("Acting Client")}</FieldLabel>
              <Input id="settings-client" value={identity.acting_client_id} readOnly aria-readonly="true" />
              <FieldDescription>{t("Scopes")}: {identity.scopes.join(", ")}</FieldDescription>
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>
</div></details>
      <details className="rounded-xl border p-4"><summary className="cursor-pointer font-medium">{t("SIEM forwarding")}</summary><div className="mt-4">      <Card>
        <CardHeader className="border-b">
          <CardTitle><TitleHelp help={t("Matching canonical Audit Events are committed to a durable outbox and delivered outside the invocation path.")}>{t("SIEM forwarding")}</TitleHelp></CardTitle>
        </CardHeader>
        <CardContent className="grid gap-6 xl:grid-cols-[minmax(20rem,0.8fr)_minmax(32rem,1.2fr)]">
          <form onSubmit={(event) => void saveSiemDestination(event)}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="siem-destination-id">{t("Destination ID")}</FieldLabel>
                <Input
                  id="siem-destination-id"
                  value={destinationId}
                  onChange={(event) => setDestinationId(event.target.value)}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="siem-endpoint-url">{t("Webhook URL")}</FieldLabel>
                <Input
                  id="siem-endpoint-url"
                  type="url"
                  value={endpointUrl}
                  onChange={(event) => setEndpointUrl(event.target.value)}
                  placeholder={t("https://siem.example/events")}
                  required
                />
                <FieldDescription>{t("Production destinations require HTTPS. HTTP is accepted only for loopback validation.")}</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="siem-event-kinds">{t("Audit Event filter")}</FieldLabel>
                <Input
                  id="siem-event-kinds"
                  value={eventKinds}
                  onChange={(event) => setEventKinds(event.target.value)}
                  placeholder={t("Blank forwards every Audit Event")}
                />
                <FieldDescription>{t("Enter comma-separated Audit Event kinds, or leave blank for all events.")}</FieldDescription>
              </Field>
              <label className="flex items-center gap-3 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={siemEnabled}
                  onChange={(event) => setSiemEnabled(event.target.checked)}
                  className="size-4 rounded border-input accent-primary"
                />
                {t("Enable forwarding")}
              </label>
              <Button type="submit" className="self-start" disabled={siemBusy}>
                <ShieldCheckIcon data-icon="inline-start" />
                {siemBusy ? t("Saving…") : t("Save SIEM destination")}
              </Button>
              {siemResult ? <p role="status" className="text-sm text-muted-foreground">{siemResult}</p> : null}
            </FieldGroup>
          </form>
          <div className="min-w-0 rounded-lg border">
            <div className="border-b px-4 py-3">
              <div className="font-medium">{t("Recent deliveries")}</div>
              <div className="text-xs text-muted-foreground">{t("Retry and final delivery state remain queryable after restart.")}</div>
            </div>
            {data.siemDeliveries.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Audit Event")}</TableHead>
                    <TableHead>{t("State")}</TableHead>
                    <TableHead>{t("Attempts")}</TableHead>
                    <TableHead>{t("Last error")}</TableHead>
                    <TableHead>{t("Delivered")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.siemDeliveries.slice(0, 10).map((delivery) => (
                    <TableRow key={`${delivery.destination_id}-${delivery.audit_event_id}`}>
                      <TableCell>
                        <div className="font-mono text-xs">{delivery.audit_event_id}</div>
                        <div className="text-xs text-muted-foreground">{delivery.event.kind}</div>
                      </TableCell>
                      <TableCell><Badge variant={delivery.status === "DELIVERED" ? "secondary" : "outline"}>{t(delivery.status)}</Badge></TableCell>
                      <TableCell className="tabular-nums">{delivery.attempt_count}</TableCell>
                      <TableCell className="font-mono text-xs">{delivery.last_error_code ?? "—"}</TableCell>
                      <TableCell>{delivery.delivered_at ? relativeTime(delivery.delivered_at) : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <DataEmpty
                icon={ShieldCheckIcon}
                title={t("No SIEM deliveries")}
                description={t("Matching Audit Events will appear after forwarding is enabled.")}
              />
            )}
          </div>
        </CardContent>
      </Card>
</div></details>
      <details className="rounded-xl border p-4"><summary className="cursor-pointer font-medium">{t("Tenant configuration")}</summary><div className="mt-4">      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2"><Settings2Icon className="size-4" /><TitleHelp help={t("Draft → Validate → Preview → Review → Publish. Published revisions expose desired, observed, drift, retry and rollback evidence.")}>{t("Tenant configuration")}</TitleHelp></CardTitle>
          <CardDescription>{t("Set the tenant defaults and customize the enterprise login page from one managed revision.")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(20rem,0.9fr)]">
            <div className="rounded-xl border bg-muted/20 p-5">
              <div className="mb-5 flex items-start justify-between gap-3">
                <div>
                  <div className="font-medium">{t("Login page branding")}</div>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">{t("Choose the name, logo, colors, and trusted CSS shown before employees sign in.")}</p>
                </div>
                <Badge variant="outline">{t("Tenant-wide")}</Badge>
              </div>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="config-brand">{t("Brand")}</FieldLabel>
                  <Input id="config-brand" value={brandName} onChange={(event) => setBrandName(event.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="config-login-tagline">{t("Login tagline")}</FieldLabel>
                  <Input id="config-login-tagline" value={loginTagline} onChange={(event) => setLoginTagline(event.target.value)} placeholder={t("Enterprise AI access governance")} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="config-login-logo">{t("Logo URL")}</FieldLabel>
                  <Input id="config-login-logo" type="url" value={loginLogoUrl} onChange={(event) => setLoginLogoUrl(event.target.value)} placeholder={loginLogoPlaceholder} />
                  <FieldDescription>{t("Use an HTTPS logo hosted by your enterprise or a same-origin path.")}</FieldDescription>
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="config-login-primary">{t("Primary color")}</FieldLabel>
                    <div className="flex gap-2">
                      <Input type="color" aria-label={t("Primary color picker")} value={previewColor(loginPrimaryColor, defaultTenantLoginBranding.primary_color)} onChange={(event) => setLoginPrimaryColor(event.target.value)} className="h-10 w-12 shrink-0 cursor-pointer p-1" />
                      <Input id="config-login-primary" value={loginPrimaryColor} onChange={(event) => setLoginPrimaryColor(event.target.value)} className="font-mono" />
                    </div>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="config-login-page">{t("Page color")}</FieldLabel>
                    <div className="flex gap-2">
                      <Input type="color" aria-label={t("Page color picker")} value={previewColor(loginPageColor, defaultTenantLoginBranding.page_color)} onChange={(event) => setLoginPageColor(event.target.value)} className="h-10 w-12 shrink-0 cursor-pointer p-1" />
                      <Input id="config-login-page" value={loginPageColor} onChange={(event) => setLoginPageColor(event.target.value)} className="font-mono" />
                    </div>
                  </Field>
                </div>
                <Field>
                  <FieldLabel htmlFor="config-login-css">{t("Custom CSS")}</FieldLabel>
                  <Textarea id="config-login-css" rows={5} maxLength={16_384} value={loginCustomCss} onChange={(event) => setLoginCustomCss(event.target.value)} placeholder={t(".genio-brand__tagline { letter-spacing: -0.02em; }")} className="font-mono text-xs" />
                  <FieldDescription>{t("Applied only to the login page after this revision is published. CSS is limited to 16 KiB and is treated as trusted administrator input.")}</FieldDescription>
                </Field>
                <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span>{t("Preview updates as you edit.")}</span>
                  <span className="tabular-nums">{loginCustomCss.length.toLocaleString()} / 16,384</span>
                </div>
              </FieldGroup>
            </div>
            <LoginBrandingPreview
              brandName={brandName}
              branding={{
                tagline: loginTagline,
                logo_url: loginLogoUrl,
                primary_color: loginPrimaryColor,
                page_color: loginPageColor,
                custom_css: loginCustomCss,
              }}
            />
          </div>
          <div className="grid gap-6 xl:grid-cols-[minmax(20rem,0.8fr)_minmax(32rem,1.2fr)]">
            <div className="rounded-xl border p-5">
              <div className="mb-5">
                <div className="font-medium">{t("Tenant access defaults")}</div>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{t("These values control the tenant catalog and access request behavior.")}</p>
              </div>
              <FieldGroup>
                <Field><FieldLabel htmlFor="config-language">{t("Language")}</FieldLabel><select id="config-language" className="h-9 rounded-md border bg-background px-3" value={language} onChange={(event) => setLanguage(event.target.value)}><option value="zh-TW">{t("Traditional Chinese (Taiwan)")}</option><option value="en">{t("English")}</option>{!["zh-TW", "en"].includes(language) ? <option value={language}>{language}</option> : null}</select></Field>
                <Field><FieldLabel htmlFor="config-catalog">{t("Catalog visibility")}</FieldLabel><select id="config-catalog" className="h-9 rounded-md border bg-background px-3" value={catalogVisibility} onChange={(event) => setCatalogVisibility(event.target.value)}><option value="ENTITLED_AND_REQUESTABLE">{t("Entitled and requestable resources")}</option>{catalogVisibility !== "ENTITLED_AND_REQUESTABLE" ? <option value={catalogVisibility}>{catalogVisibility}</option> : null}</select></Field>
                <Field><FieldLabel htmlFor="config-ttl">{t("Default request TTL (seconds)")}</FieldLabel><Input id="config-ttl" inputMode="numeric" value={defaultTtlSeconds} onChange={(event) => setDefaultTtlSeconds(event.target.value)} /></Field>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" onClick={() => void createDraft()} disabled={configurationBusy}><SaveIcon data-icon="inline-start" />{configurationBusy ? t("Saving…") : t("Create Draft")}</Button>
                  {latestConfiguration?.state === "DRAFT" ? <Button type="button" variant="outline" onClick={() => void transitionLatest("validate")} disabled={configurationBusy}>{t("Validate")}</Button> : null}
                  {latestConfiguration?.state === "VALIDATED" && latestConfiguration.previewed_at == null ? <Button type="button" variant="outline" onClick={() => void transitionLatest("preview")} disabled={configurationBusy}>{t("Preview")}</Button> : null}
                  {latestConfiguration?.state === "VALIDATED" && latestConfiguration.previewed_at != null ? <Button type="button" variant="outline" onClick={() => void transitionLatest("review")} disabled={configurationBusy}>{t("Review")}</Button> : null}
                  {latestConfiguration?.state === "REVIEWED" ? <Button type="button" onClick={() => void transitionLatest("publish")} disabled={configurationBusy}>{t("Publish")}</Button> : null}
                  {latestConfiguration?.projection.status === "FAILED" ? <Button type="button" variant="outline" onClick={() => void retryLatestProjection()} disabled={configurationBusy}>{t("Retry projection")}</Button> : null}
                </div>
                {configurationResult ? <p role="status" className="text-sm text-muted-foreground">{configurationResult}</p> : null}
              </FieldGroup>
            </div>
            <div className="min-w-0 rounded-lg border">
              <div className="border-b px-4 py-3"><div className="font-medium">{t("Revision history")}</div><div className="text-xs text-muted-foreground">{t("Immutable revision records remain queryable after restart.")}</div></div>
              {configurationRevisions.length ? (
                <Table>
                  <TableHeader><TableRow><TableHead>{t("Revision")}</TableHead><TableHead>{t("State")}</TableHead><TableHead>{t("Desired")}</TableHead><TableHead>{t("Observed")}</TableHead><TableHead>{t("Projection")}</TableHead><TableHead>{t("Drift")}</TableHead><TableHead>{t("Retries")}</TableHead><TableHead>{t("Rollback")}</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {configurationRevisions.slice().sort((left, right) => right.created_at - left.created_at || right.revision.localeCompare(left.revision)).map((revision) => (
                      <TableRow key={revision.revision}>
                        <TableCell className="font-mono text-xs">{revision.revision}</TableCell>
                        <TableCell><Badge variant={revision.state === "PUBLISHED" ? "secondary" : "outline"}>{t(revision.state)}</Badge></TableCell>
                        <TableCell className="font-mono text-xs">{revision.projection.desired_revision}</TableCell>
                        <TableCell className="font-mono text-xs">{revision.projection.observed_revision ?? "—"}</TableCell>
                        <TableCell><Badge variant={revision.projection.status === "FAILED" ? "destructive" : "outline"}>{t(revision.projection.status)}</Badge>{revision.projection.last_error ? <div className="mt-1 text-xs text-destructive">{revision.projection.last_error}</div> : null}</TableCell>
                        <TableCell><Badge variant={revision.projection.drift ? "destructive" : "secondary"}>{revision.projection.drift ? t("Drift") : t("Converged")}</Badge></TableCell>
                        <TableCell className="tabular-nums">{revision.projection.retry_count}</TableCell>
                        <TableCell className="font-mono text-xs">{revision.rolled_back_from ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : <DataEmpty icon={Settings2Icon} title={t("No configuration revisions")} description={t("Create the first tenant configuration draft to begin the V1.1 lifecycle.")} />}
            </div>
          </div>
        </CardContent>
      </Card>
</div></details>
      <details className="rounded-xl border p-4"><summary className="cursor-pointer font-medium">{t("Notification subscriptions")}</summary><div className="mt-4">      <Card>
        <CardHeader className="border-b"><CardTitle className="flex items-center gap-2"><BellIcon className="size-4" /><TitleHelp help={t("Choose notification type and channel. Changes are permission-bounded and audited.")}>{t("Notification subscriptions")}</TitleHelp></CardTitle></CardHeader>
        <CardContent className="grid gap-6 xl:grid-cols-[minmax(20rem,0.8fr)_minmax(32rem,1.2fr)]">
          <form onSubmit={(event) => void saveNotificationSubscription(event)}><FieldGroup><Field><FieldLabel htmlFor="notification-type">{t("Notification type")}</FieldLabel><select id="notification-type" className="h-9 rounded-md border bg-background px-3 text-sm" value={notificationType} onChange={(event) => setNotificationType(event.target.value as NotificationType)} required><option value="ACCESS_REQUEST">{t("ACCESS_REQUEST")}</option><option value="ENTITLEMENT_EXPIRING">{t("ENTITLEMENT_EXPIRING")}</option><option value="RUNAWAY_INVOCATION_SUSPENDED">{t("RUNAWAY_INVOCATION_SUSPENDED")}</option><option value="ALL">{t("ALL")}</option></select></Field><Field><FieldLabel htmlFor="notification-channel">{t("Channel")}</FieldLabel><select id="notification-channel" className="h-9 rounded-md border bg-background px-3 text-sm" value={notificationChannel} disabled><option value="IN_APP">{t("In-app")}</option></select><FieldDescription>{t("V1.1 delivers notifications in-app only.")}</FieldDescription></Field><Button type="submit" className="self-start" disabled={configurationBusy}><BellIcon data-icon="inline-start" />{t("Save subscription")}</Button></FieldGroup></form>
          <div className="min-w-0 rounded-lg border"><Table><TableHeader><TableRow><TableHead>{t("Type")}</TableHead><TableHead>{t("Channel")}</TableHead><TableHead>{t("State")}</TableHead><TableHead /></TableRow></TableHeader><TableBody>{notificationSubscriptions.map((subscription) => <TableRow key={subscription.subscription_id}><TableCell>{t(subscription.notification_type)}</TableCell><TableCell>{t(subscription.channel)}</TableCell><TableCell><Badge variant={subscription.enabled ? "secondary" : "outline"}>{subscription.enabled ? t("Enabled") : t("Disabled")}</Badge></TableCell><TableCell className="text-right">{subscription.enabled ? <Button size="sm" variant="ghost" onClick={() => void disableNotificationSubscription(subscription.subscription_id)} disabled={configurationBusy}>{t("Disable")}</Button> : null}</TableCell></TableRow>)}</TableBody></Table>{notificationSubscriptions.length === 0 ? <DataEmpty icon={BellIcon} title={t("No subscriptions")} description={t("Subscribe to a notification type to route it to a channel.")} /> : null}</div>
        </CardContent>
      </Card></div></details>
    </div>
  )
}
