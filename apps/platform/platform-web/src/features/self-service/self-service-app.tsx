import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  BellIcon,
  CheckIcon,
  Clock3Icon,
  KeyRoundIcon,
  LanguagesIcon,
  LoaderCircleIcon,
  LogInIcon,
  LogOutIcon,
  PackagePlusIcon,
  SearchIcon,
  ShieldCheckIcon,
} from "lucide-react"
import { useTranslation } from "react-i18next"

import { Badge } from "@/components/ui/badge"
import { TitleHelp } from "@/components/title-help"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
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
import type {
  AccessNotification,
  AccessRequest,
  Entitlement,
  IdentitySession,
  ResourceOnboardingRequest,
  SelfServiceHubStatus,
  SubjectCatalogCapability,
  SubjectCatalogSnapshot,
  TenantConfigurationRevision,
} from "@/domain/contracts"
import {
  AccessUpdates,
  SelfServiceRequestSheet,
  type AccessDisplayDirectory,
} from "@/features/self-service/access-lifecycle"
import { changeConsoleLanguage, type ConsoleLanguage } from "@/i18n"
import { relativeTime } from "@/lib/format"
import {
  activateAutoGrant,
  cancelAccessRequest,
  loadSelfService,
  requestAccess,
  requestResourceOnboarding,
} from "@/lib/self-service-api"
import {
  BROWSER_SESSION_EXPIRED_EVENT,
  BROWSER_SESSION_REFRESHED_EVENT,
  beginBrowserLogin,
  clearBrowserSession,
  completeBrowserLogin,
  loadBrowserAccessToken,
  loadIdentitySession,
  refreshBrowserSession,
} from "@/lib/browser-oidc"

interface SelfServiceData {
  catalog: SubjectCatalogSnapshot
  requests: AccessRequest[]
  entitlements: Entitlement[]
  notifications: AccessNotification[]
  onboardingRequests: ResourceOnboardingRequest[]
  configuration: TenantConfigurationRevision | null
}

function statusVariant(status: SelfServiceHubStatus) {
  if (status === "CONNECTED" || status === "AVAILABLE") return "secondary" as const
  if (status === "DENIED") return "destructive" as const
  return "outline" as const
}

function readableIdentifier(value: string): string {
  return value
    .replace(/^genio-one(?=$|[-_.])/i, "GenioOne")
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => {
      const upper = part.toUpperCase()
      if (["AI", "API", "MCP", "OIDC", "OAUTH", "LLM"].includes(upper)) return upper === "OAUTH" ? "OAuth" : upper
      return part.toLowerCase() === "genioone" ? "GenioOne" : part.charAt(0).toUpperCase() + part.slice(1)
    })
    .join(" ")
}

function LanguageMenu() {
  const { t, i18n } = useTranslation()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t("Language")}>
          <LanguagesIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t("Language")}</DropdownMenuLabel>
          {(["en", "zh-TW"] as ConsoleLanguage[]).map((language) => (
            <DropdownMenuItem
              key={language}
              onClick={() => void changeConsoleLanguage(language)}
            >
              {i18n.resolvedLanguage === language ? <CheckIcon /> : <span className="size-4" />}
              {language === "en" ? t("English") : t("Traditional Chinese")}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function SelfServiceApp() {
  const { t } = useTranslation()
  const callbackStarted = useRef(false)
  const [token, setToken] = useState<string | null>(null)
  const [session, setSession] = useState<IdentitySession | null>(null)
  const [data, setData] = useState<SelfServiceData | null>(null)
  const [selected, setSelected] = useState<SubjectCatalogCapability | null>(null)
  const [selectedRequest, setSelectedRequest] = useState<AccessRequest | null>(null)
  const [justification, setJustification] = useState("")
  const [requestedDurationSeconds, setRequestedDurationSeconds] = useState(28_800)
  const [catalogQuery, setCatalogQuery] = useState("")
  const [requestedServiceUrl, setRequestedServiceUrl] = useState("")
  const [onboardingJustification, setOnboardingJustification] = useState("")
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const configuredTtlChoices = data?.configuration?.settings.ttl_options_seconds ?? [28_800]
  const configuredDefaultTtl = data?.configuration?.settings.request_form.default_ttl_seconds ?? configuredTtlChoices[0]
  const configurationRevision = data?.configuration?.revision ?? null
  const display = useMemo<AccessDisplayDirectory>(() => {
    const catalog = data?.catalog
    const entries = new Map(
      (catalog?.capabilities ?? []).map((capability) => [
        `${capability.resource_id}\u0000${capability.capability_id}`,
        capability,
      ]),
    )
    const owners = new Map(
      (catalog?.capabilities ?? []).map((capability) => [
        capability.resource_owner_id,
        capability.resource_owner_display_name,
      ]),
    )
    return {
      capability(resourceId, capabilityId) {
        const capability = entries.get(`${resourceId}\u0000${capabilityId}`)
        return {
          resource: capability?.resource_display_name ?? readableIdentifier(resourceId),
          capability: capability?.capability_display_name ?? readableIdentifier(capabilityId),
        }
      },
      organization(organizationId) {
        return owners.get(organizationId) ?? readableIdentifier(organizationId)
      },
      subject(subjectId) {
        return subjectId === catalog?.subject_id ? catalog.subject_display_name : readableIdentifier(subjectId)
      },
      application(applicationId) {
        return readableIdentifier(applicationId)
      },
    }
  }, [data?.catalog])

  useEffect(() => {
    if (configuredTtlChoices.includes(configuredDefaultTtl)) {
      setRequestedDurationSeconds(configuredDefaultTtl)
    }
  }, [configurationRevision])

  const refresh = useCallback(async (accessToken: string, identity: IdentitySession) => {
    setData(await loadSelfService(accessToken, identity.tenant_id))
  }, [])

  const connect = useCallback(
    async (accessToken: string) => {
      const identity = await loadIdentitySession(accessToken)
      setToken(accessToken)
      setSession(identity)
      await refresh(accessToken, identity)
    },
    [refresh],
  )

  useEffect(() => {
    if (callbackStarted.current) return
    callbackStarted.current = true
    void completeBrowserLogin("/self-service")
      .then(async (callbackToken) => {
        let accessToken = callbackToken ?? loadBrowserAccessToken("/self-service")
        if (!accessToken) {
          const query = new URLSearchParams(window.location.search)
          const hasError = query.has("error")
          const isExplicitSignedOut = sessionStorage.getItem("genioone.signed_out:/self-service") === "true"
          if (!hasError && !isExplicitSignedOut) {
            try {
              await beginBrowserLogin("/self-service")
              return
            } catch (error) {
              setNotice(error instanceof Error ? error.message : "OIDC_FAILED")
              return
            }
          }
          return
        }
        try {
          await connect(accessToken)
          sessionStorage.removeItem("genioone.signed_out:/self-service")
        } catch (error) {
          if (!(error instanceof Error && "status" in error && error.status === 401)) throw error
          accessToken = await refreshBrowserSession("/self-service") ?? ""
          if (!accessToken) throw error
          await connect(accessToken)
          sessionStorage.removeItem("genioone.signed_out:/self-service")
        }
      })
      .catch((error) => setNotice(error instanceof Error ? error.message : "OIDC_FAILED"))
  }, [connect])

  useEffect(() => {
    const onRefreshed = (event: Event) => {
      const detail = (event as CustomEvent<{ redirectPath?: string; accessToken?: string }>).detail
      if (detail?.redirectPath === "/self-service" && detail.accessToken) {
        setToken(detail.accessToken)
      }
    }
    const onExpired = (event: Event) => {
      const detail = (event as CustomEvent<{ redirectPath?: string }>).detail
      if (detail?.redirectPath !== "/self-service") return
      setToken(null)
      setSession(null)
      setData(null)
      setNotice("OIDC_SESSION_EXPIRED")
    }
    window.addEventListener(BROWSER_SESSION_REFRESHED_EVENT, onRefreshed)
    window.addEventListener(BROWSER_SESSION_EXPIRED_EVENT, onExpired)
    return () => {
      window.removeEventListener(BROWSER_SESSION_REFRESHED_EVENT, onRefreshed)
      window.removeEventListener(BROWSER_SESSION_EXPIRED_EVENT, onExpired)
    }
  }, [])

  async function submitRequest() {
    if (!token || !session || !selected || !justification.trim()) return
    setBusy(true)
    setNotice(null)
    try {
      await requestAccess(
        token,
        session.tenant_id,
        selected.resource_id,
        selected.capability_id,
        justification.trim(),
        requestedDurationSeconds,
      )
      setSelected(null)
      setJustification("")
      setRequestedDurationSeconds(configuredDefaultTtl)
      await refresh(token, session)
      setNotice("Access Request submitted for Human Approval.")
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Request failed")
    } finally {
      setBusy(false)
    }
  }

  async function cancelRequest(requestId: string) {
    if (!token || !session) return
    setBusy(true)
    setNotice(null)
    try {
      await cancelAccessRequest(token, session.tenant_id, requestId)
      await refresh(token, session)
      setSelectedRequest(null)
      setNotice("Access Request cancelled.")
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Cancellation failed")
    } finally {
      setBusy(false)
    }
  }

  async function activateResource(item: SubjectCatalogCapability) {
    if (!token || !session || item.access !== "AUTO_GRANT") return
    setBusy(true)
    setNotice(null)
    try {
      await activateAutoGrant(token, session.tenant_id, item.resource_id, item.capability_id)
      await refresh(token, session)
      setNotice("Resource activated and Entitlement created.")
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Activation failed")
    } finally {
      setBusy(false)
    }
  }

  async function submitResourceOnboarding() {
    if (!token || !session || !catalogQuery.trim() || !onboardingJustification.trim()) return
    setBusy(true)
    setNotice(null)
    try {
      await requestResourceOnboarding(
        token,
        session.tenant_id,
        catalogQuery.trim(),
        requestedServiceUrl,
        onboardingJustification.trim(),
      )
      setRequestedServiceUrl("")
      setOnboardingJustification("")
      await refresh(token, session)
      setNotice("Resource Onboarding Request submitted.")
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Request failed")
    } finally {
      setBusy(false)
    }
  }

  function signOut() {
    sessionStorage.setItem("genioone.signed_out:/self-service", "true")
    clearBrowserSession("/self-service")
    setToken(null)
    setSession(null)
    setData(null)
    setSelected(null)
    setSelectedRequest(null)
    setCatalogQuery("")
    setRequestedServiceUrl("")
    setOnboardingJustification("")
    setNotice(null)
  }

  const activeEntitlements = data?.entitlements.filter((item) => item.state === "ACTIVE") ?? []
  const pendingRequests = data?.requests.filter((item) => item.state === "PENDING") ?? []
  const updateCount = data?.notifications.length ?? 0
  const normalizedCatalogQuery = catalogQuery.trim().toLowerCase()
  const catalogCapabilities =
    data?.catalog.capabilities.filter((item) =>
      [item.resource_id, item.resource_display_name, item.capability_id, item.capability_display_name, item.resource_owner_id, item.resource_owner_display_name].some((value) =>
        value.toLowerCase().includes(normalizedCatalogQuery),
      ),
    ) ?? []

  return (
    <div className="min-h-screen bg-muted/20">
      <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary font-semibold text-primary-foreground">
              G
            </div>
            <div>
              <div className="font-semibold leading-none">GenioOne</div>
              <div className="mt-1 text-xs text-muted-foreground">{t("Self-service")}</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <LanguageMenu />
            {session ? (
              <Button variant="outline" onClick={signOut}>
                <LogOutIcon data-icon="inline-start" />
                {t("Sign out")}
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[1440px] flex-col gap-6 px-4 py-8 sm:px-6">
        {!session || !data ? (
          <Card className="mx-auto mt-14 w-full max-w-2xl">
            <CardHeader className="border-b">
              <CardTitle className="text-2xl"><TitleHelp help={t("Sign in once to discover governed LLM, MCP, and API capabilities available to your identity.")}>{t("Access enterprise capabilities")}</TitleHelp></CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-5 py-8">
              <div className="grid gap-4 sm:grid-cols-3">
                {[t("Identity-scoped Catalog"), t("Human Approval"), t("Audited Entitlement")].map(
                  (label) => (
                    <div key={label} className="rounded-lg border bg-muted/20 p-4 text-sm font-medium">
                      {label}
                    </div>
                  ),
                )}
              </div>
              <Button
                size="lg"
                className="self-start"
                onClick={() => {
                  sessionStorage.removeItem("genioone.signed_out:/self-service")
                  setNotice(null)
                  void beginBrowserLogin("/self-service").catch((error) =>
                    setNotice(error instanceof Error ? error.message : "OIDC_FAILED"),
                  )
                }}
              >
                <LogInIcon data-icon="inline-start" />
                {t("Sign in with GenioOne")}
              </Button>
              {notice ? <p className="text-sm text-destructive">{t(notice)}</p> : null}
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">{t("Your access")}</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("Signed in as {{subject}} through {{client}}.", {
                    subject: data.catalog.subject_display_name,
                    client: display.application(session.acting_client_id),
                  })}
                </p>
              </div>
              <Button
                variant="outline"
                onClick={() => {
                  if (token) void refresh(token, session)
                }}
                disabled={busy}
              >
                {busy ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : null}
                {t("Refresh")}
              </Button>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <SummaryCard icon={ShieldCheckIcon} label={t("Available capabilities")} value={data.catalog.capabilities.length} />
              <SummaryCard icon={KeyRoundIcon} label={t("Active Entitlements")} value={activeEntitlements.length} />
              <SummaryCard icon={Clock3Icon} label={t("Pending Requests")} value={pendingRequests.length} />
              <SummaryCard icon={BellIcon} label={t("Access updates")} value={updateCount} />
            </div>

            {notice ? <p role="status" className="text-sm font-medium text-primary">{t(notice)}</p> : null}

            <AccessUpdates
              requests={data.requests}
              notifications={data.notifications}
              onSelectRequest={setSelectedRequest}
              display={display}
            />

            {data.configuration ? (
              <Card>
                <CardHeader className="border-b">
                  <CardTitle>{data.configuration.settings.brand_name} · {t("Tenant configuration")}</CardTitle>
                  <CardDescription>{t("Published revision {{revision}} · observed {{observed}} · {{status}}", {
                    revision: data.configuration.revision,
                    observed: data.configuration.projection.observed_revision ?? t("not converged"),
                    status: t(data.configuration.projection.status),
                  })}</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-4 sm:grid-cols-3">
                  <div className="rounded-lg border p-4"><div className="text-xs text-muted-foreground">{t("Language")}</div><div className="mt-1 font-medium">{data.configuration.settings.language}</div></div>
                  <div className="rounded-lg border p-4"><div className="text-xs text-muted-foreground">{t("Catalog visibility")}</div><div className="mt-1 font-medium">{data.configuration.settings.catalog_visibility}</div></div>
                  <div className="rounded-lg border p-4"><div className="text-xs text-muted-foreground">{t("Request TTL choices")}</div><div className="mt-1 font-medium">{data.configuration.settings.ttl_options_seconds.map((seconds) => `${Math.round(seconds / 3600)}h`).join(", ")}</div></div>
                </CardContent>
              </Card>
            ) : null}

            <div className="grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(22rem,0.7fr)]">
              <Card>
                <CardHeader className="border-b">
                  <CardTitle><TitleHelp help={t("Hidden capabilities are omitted. Requestable capabilities remain discoverable.")}>{t("Catalog")}</TitleHelp></CardTitle>
                  <CardAction className="w-full sm:w-72">
                    <div className="relative">
                      <SearchIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        className="pl-9"
                        value={catalogQuery}
                        onChange={(event) => setCatalogQuery(event.target.value)}
                        placeholder={t("Search the Catalog")}
                        aria-label={t("Search the Catalog")}
                      />
                    </div>
                  </CardAction>
                </CardHeader>
                <CardContent className="px-0">
                  {catalogCapabilities.length ? <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("Resource")}</TableHead>
                        <TableHead>{t("Capability")}</TableHead>
                        <TableHead>{t("Owner")}</TableHead>
                        <TableHead>{t("Status")}</TableHead>
                        <TableHead className="text-right">{t("Action")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {catalogCapabilities.map((item) => (
                        <TableRow key={`${item.resource_id}-${item.capability_id}`}>
                          <TableCell className="font-medium">{item.resource_display_name}</TableCell>
                          <TableCell>{item.capability_display_name}</TableCell>
                          <TableCell>{item.resource_owner_display_name}</TableCell>
                          <TableCell>
                            <div className="space-y-1">
                              <Badge variant={statusVariant(item.hub_status)}>{t(item.hub_status)}</Badge>
                              {item.hub_status === "DENIED" ? (
                                <div className="max-w-72 text-xs text-muted-foreground">
                                  <p>{t("This capability is unavailable because organizational policy denies access.")}</p>
                                  {item.restriction_reason ? (
                                    <p className="mt-0.5">{t("Policy reason: {{reason}}", { reason: item.restriction_reason })}</p>
                                  ) : null}
                                </div>
                              ) : null}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy || (item.hub_status !== "REQUEST_ACCESS" && item.access !== "AUTO_GRANT")}
                              onClick={() => item.access === "AUTO_GRANT" ? void activateResource(item) : setSelected(item)}
                            >
                              {item.hub_status === "REQUEST_ACCESS"
                                ? t("Request")
                                : item.access === "AUTO_GRANT"
                                  ? t("Activate")
                                  : item.hub_status === "DENIED"
                                    ? t("Unavailable")
                                    : t("Available")}
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table> : normalizedCatalogQuery ? (
                    <div className="p-6">
                      <div className="rounded-xl border border-dashed bg-muted/20 p-5">
                        <div className="flex items-start gap-3">
                          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                            <PackagePlusIcon />
                          </div>
                          <div>
                            <h3 className="font-semibold">{t("Request a new Resource")}</h3>
                            <p className="mt-1 text-sm text-muted-foreground">
                              {t("No Published Catalog Resource matches this search. Submit it for onboarding review.")}
                            </p>
                          </div>
                        </div>
                        <FieldGroup className="mt-5">
                          <Field>
                            <FieldLabel htmlFor="requested-resource-name">{t("Requested Resource")}</FieldLabel>
                            <Input id="requested-resource-name" value={catalogQuery} onChange={(event) => setCatalogQuery(event.target.value)} />
                          </Field>
                          <Field>
                            <FieldLabel htmlFor="requested-service-url">{t("Service URL (optional)")}</FieldLabel>
                            <Input id="requested-service-url" type="url" value={requestedServiceUrl} onChange={(event) => setRequestedServiceUrl(event.target.value)} placeholder="https://" />
                          </Field>
                          <Field>
                            <FieldLabel htmlFor="onboarding-justification">{t("Business Justification")}</FieldLabel>
                            <Textarea id="onboarding-justification" value={onboardingJustification} onChange={(event) => setOnboardingJustification(event.target.value)} placeholder={t("Explain why this Resource should be governed and published")} />
                            <FieldDescription>{t("This creates a durable Resource Onboarding Request for management triage.")}</FieldDescription>
                          </Field>
                          <Button className="self-start" onClick={() => void submitResourceOnboarding()} disabled={busy || !catalogQuery.trim() || !onboardingJustification.trim()}>
                            {busy ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : <PackagePlusIcon data-icon="inline-start" />}
                            {t("Submit Resource Request")}
                          </Button>
                        </FieldGroup>
                      </div>
                    </div>
                  ) : <EmptyState title={t("No Catalog capabilities")} description={t("Published Resources available to your identity will appear here.")} />}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="border-b">
                  <CardTitle><TitleHelp help={t("A Resource Owner remains accountable for the decision.")}>{t("Request access")}</TitleHelp></CardTitle>
                </CardHeader>
                <CardContent>
                  {selected ? (
                    <FieldGroup>
                      <Field>
                        <FieldLabel>{t("Resource / Capability")}</FieldLabel>
                        <Input value={`${selected.resource_display_name} / ${selected.capability_display_name}`} readOnly />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="self-service-justification">{t("Justification")}</FieldLabel>
                        <Input
                          id="self-service-justification"
                          value={justification}
                          onChange={(event) => setJustification(event.target.value)}
                          placeholder={t("Explain why this capability is needed")}
                        />
                        <FieldDescription>{t("This becomes part of the durable approval record.")}</FieldDescription>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="self-service-request-duration">{t("Requested duration")}</FieldLabel>
                        <select
                          id="self-service-request-duration"
                          className="h-9 rounded-md border bg-background px-3 text-sm"
                          value={String(requestedDurationSeconds)}
                          onChange={(event) => setRequestedDurationSeconds(Number(event.target.value))}
                        >
                          {configuredTtlChoices.map((seconds) => (
                            <option key={seconds} value={seconds}>
                              {seconds % 3_600 === 0 ? `${seconds / 3_600}h` : `${seconds}s`}
                            </option>
                          ))}
                        </select>
                        <FieldDescription>{t("The published tenant configuration controls the available TTL choices and stores the selected value with the Access Request.")}</FieldDescription>
                      </Field>
                      <div className="flex gap-2">
                        <Button onClick={() => void submitRequest()} disabled={busy || !justification.trim() || !configuredTtlChoices.includes(requestedDurationSeconds)}>
                          {busy ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : null}
                          {t("Submit request")}
                        </Button>
                        <Button variant="ghost" onClick={() => setSelected(null)}>{t("Cancel")}</Button>
                      </div>
                    </FieldGroup>
                  ) : (
                    <Empty>
                      <EmptyHeader>
                        <EmptyMedia variant="icon"><KeyRoundIcon /></EmptyMedia>
                        <EmptyTitle>{t("Select a requestable capability")}</EmptyTitle>
                        <EmptyDescription>{t("Only capabilities marked Request Access can create a request.")}</EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  )}
                </CardContent>
              </Card>
            </div>

            {data.onboardingRequests.length ? (
              <Card>
                <CardHeader className="border-b">
                  <CardTitle><TitleHelp help={t("Catalog search misses submitted for Resource onboarding review.")}>{t("My Resource Requests")}</TitleHelp></CardTitle>
                </CardHeader>
                <CardContent className="px-0">
                  <Table>
                    <TableHeader><TableRow><TableHead>{t("Requested Resource")}</TableHead><TableHead>{t("Service URL")}</TableHead><TableHead>{t("State")}</TableHead><TableHead className="text-right">{t("Created")}</TableHead></TableRow></TableHeader>
                    <TableBody>{data.onboardingRequests.map((item) => (
                      <TableRow key={item.resource_onboarding_request_id}><TableCell><div className="font-medium">{item.requested_resource_name}</div><div className="max-w-xl text-xs text-muted-foreground">{item.business_justification}</div></TableCell><TableCell className="font-mono text-xs">{item.requested_service_url ?? "—"}</TableCell><TableCell><Badge variant="outline">{t(item.state)}</Badge></TableCell><TableCell className="text-right text-muted-foreground">{relativeTime(item.created_at)}</TableCell></TableRow>
                    ))}</TableBody>
                  </Table>
                </CardContent>
              </Card>
            ) : null}

            <Card>
              <CardHeader className="border-b">
                <CardTitle><TitleHelp help={t("Current and historical Entitlements granted to your canonical Subject.")}>{t("My Access")}</TitleHelp></CardTitle>
              </CardHeader>
              <CardContent className="px-0">
                {data.entitlements.length ? (
                  <Table>
                    <TableHeader><TableRow><TableHead>{t("Resource / Capability")}</TableHead><TableHead>{t("Status")}</TableHead><TableHead>{t("Valid until")}</TableHead></TableRow></TableHeader>
                    <TableBody>{data.entitlements.map((item) => {
                      const capability = display.capability(item.resource_id, item.capability_id)
                      return <TableRow id={`entitlement-${item.entitlement_id}`} key={item.entitlement_id}><TableCell><div className="font-medium">{capability.resource}</div><div className="text-xs text-muted-foreground">{capability.capability}</div></TableCell><TableCell><Badge variant={item.state === "ACTIVE" ? "secondary" : "outline"}>{t(item.state)}</Badge></TableCell><TableCell>{relativeTime(item.valid_until)}</TableCell></TableRow>
                    })}</TableBody>
                  </Table>
                ) : <EmptyState title={t("No Entitlements yet")} description={t("Approved access will appear here.")} />}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="border-b">
                <CardTitle><TitleHelp help={t("Track Human Approval without losing the original request provenance.")}>{t("My Requests")}</TitleHelp></CardTitle>
              </CardHeader>
              <CardContent className="px-0">
                {data.requests.length ? (
                  <Table>
                    <TableHeader><TableRow><TableHead>{t("Resource / Capability")}</TableHead><TableHead>{t("Status")}</TableHead><TableHead>{t("Approver")}</TableHead><TableHead>{t("Created")}</TableHead><TableHead className="text-right">{t("Action")}</TableHead></TableRow></TableHeader>
                    <TableBody>{data.requests.map((item) => {
                      const capability = display.capability(item.resource_id, item.capability_id)
                      return (
                      <TableRow
                        key={item.access_request_id}
                        aria-label={t("View details")}
                        className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                        onClick={() => setSelectedRequest(item)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault()
                            setSelectedRequest(item)
                          }
                        }}
                        tabIndex={0}
                      ><TableCell><div className="font-medium">{capability.resource}</div><div className="text-xs text-muted-foreground">{capability.capability}</div></TableCell><TableCell><Badge variant={item.state === "DENIED" ? "destructive" : "outline"}>{t(item.state)}</Badge></TableCell><TableCell>{display.organization(item.approver)}</TableCell><TableCell>{relativeTime(item.created_at)}</TableCell><TableCell className="text-right">{item.state === "PENDING" ? <Button size="sm" variant="ghost" disabled={busy} onClick={(event) => { event.stopPropagation(); void cancelRequest(item.access_request_id) }}>{t("Cancel request")}</Button> : <Button size="sm" variant="ghost" onClick={(event) => { event.stopPropagation(); setSelectedRequest(item) }}>{t("View details")}</Button>}</TableCell></TableRow>
                      )
                    })}</TableBody>
                  </Table>
                ) : <EmptyState title={t("No Access Requests")} description={t("Requests you submit will appear here.")} />}
              </CardContent>
            </Card>
            <SelfServiceRequestSheet
              request={selectedRequest}
              open={Boolean(selectedRequest)}
              onOpenChange={(open) => { if (!open) setSelectedRequest(null) }}
              busy={busy}
              onCancel={cancelRequest}
              display={display}
            />
          </>
        )}
      </main>
    </div>
  )
}

function SummaryCard({ icon: Icon, label, value }: { icon: typeof ShieldCheckIcon; label: string; value: number }) {
  return <Card><CardHeader><CardAction><div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary"><Icon /></div></CardAction><CardDescription>{label}</CardDescription><CardTitle className="text-2xl tabular-nums">{value}</CardTitle></CardHeader></Card>
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return <Empty className="min-h-36"><EmptyHeader><EmptyTitle>{title}</EmptyTitle><EmptyDescription>{description}</EmptyDescription></EmptyHeader></Empty>
}
