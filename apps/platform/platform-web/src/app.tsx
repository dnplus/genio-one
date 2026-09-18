import { isTemporarySessionFailure } from "@/lib/session-recovery"
import { useEffect, useState } from "react"
import {
  LoaderCircleIcon,
  LogInIcon,
  ShieldCheckIcon,
  UserRoundIcon,
} from "lucide-react"
import { useTranslation } from "react-i18next"

import { AppSidebar } from "@/components/app-sidebar"
import { DemoPageGuide } from "@/components/demo-page-guide"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { SheetWorkspaceRoot } from "@/components/ui/sheet"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { OverviewPage } from "@/features/overview/overview-page"
import { PersonalSettingsPage } from "@/features/personal-settings/personal-settings-page"
import { AccessGovernancePage } from "@/features/access-governance/access-governance-page"
import { ApplicationsPage } from "@/features/applications/applications-page"
import { DashboardsPage, MetricsPage, TracesPage } from "@/features/activity/observability-pages"
import { ConnectionsPage } from "@/features/connections/connections-page"
import { OnePolicyPage } from "@/features/policy/one-policy-page"
import { ProductApiReferencePage } from "@/features/api-docs/product-api-reference-page"
import { ProductDocumentationPage } from "@/features/product-docs/product-documentation-page"
import {
  AccessPage,
  ActivityPage,
  IdentityPage,
  OrganizationPage,
  ResourcesPage,
  RuntimesPage,
  SettingsPage,
} from "@/features/sections/section-pages"
import { useOverview } from "@/hooks/use-overview"
import { useDemoMode } from "@/hooks/use-demo-mode"
import { useManagementNavigation } from "@/hooks/use-management-navigation"
import type { IdentitySession } from "@/domain/contracts"
import { isMockMode } from "@/lib/runtime-mode"
import {
  BROWSER_SESSION_EXPIRED_EVENT,
  beginBrowserLogin,
  clearBrowserSession,
  completeBrowserLogin,
  loadBrowserAccessToken,
  loadIdentitySession,
  refreshBrowserSession,
} from "@/lib/browser-oidc"
import { activatePersonalPreferences } from "@/lib/personal-preferences"

const mockIdentity: IdentitySession = {
  tenant_id: "tenant-design-preview",
  subject_id: "platform-admin",
  acting_client_id: "genio-one-design-preview",
  scopes: ["genioone-management"],
  acr: "mock",
  amr: ["mock"],
}

export function App() {
  const { t } = useTranslation()
  const [authState, setAuthState] = useState<"checking" | "signed_out" | "signed_in" | "unavailable">(isMockMode ? "signed_in" : "checking")
  const [authNotice, setAuthNotice] = useState<string | null>(null)
  const [identity, setIdentity] = useState<IdentitySession | null>(isMockMode ? mockIdentity : null)
  const demo = useDemoMode()
  const { activePage, search, focusedResourceId, navigate, setSearch } = useManagementNavigation()
  const tenantId = identity?.tenant_id?.trim() ?? ""
  const overviewEnabled = authState === "signed_in" && tenantId.length > 0
  const { data, loading, refreshing, refresh } = useOverview(tenantId, overviewEnabled, isMockMode)

  useEffect(() => {
    if (isMockMode) return
    let cancelled = false
    void (async () => {
      try {
        const callbackToken = await completeBrowserLogin("/management")
        let token = callbackToken ?? loadBrowserAccessToken("/management")
        if (!token) {
          const query = new URLSearchParams(window.location.search)
          const hasError = query.has("error")
          const isExplicitSignedOut = sessionStorage.getItem("genioone.signed_out:/management") === "true"
          if (!hasError && !isExplicitSignedOut) {
            try {
              await beginBrowserLogin("/management", true)
              return
            } catch (error) {
              if (!cancelled) {
                setAuthState("signed_out")
                setAuthNotice(error instanceof Error ? error.message : "OIDC_FAILED")
              }
              return
            }
          }
          if (!cancelled) setAuthState("signed_out")
          return
        }
        let session: IdentitySession
        try {
          session = await loadIdentitySession(token)
        } catch (error) {
          if (!(error instanceof Error && "status" in error && error.status === 401)) throw error
          token = await refreshBrowserSession("/management", true) ?? ""
          if (!token) throw error
          session = await loadIdentitySession(token)
        }
        if (!session.scopes.includes("genioone-management")) {
          throw new Error("MANAGEMENT_SCOPE_REQUIRED")
        }
        if (!cancelled) {
          sessionStorage.removeItem("genioone.signed_out:/management")
          activatePersonalPreferences(session.subject_id)
          setIdentity(session)
          setAuthState("signed_in")
          setAuthNotice(null)
        }
      } catch (error) {
        if (isTemporarySessionFailure(error)) {
          if (!cancelled) { setAuthState("unavailable"); setAuthNotice("The Platform is temporarily unavailable. Your login is preserved; retry when it is ready.") }
          return
        }
        clearBrowserSession("/management")
        if (!cancelled) {
          setIdentity(null)
          setAuthState("signed_out")
          setAuthNotice(error instanceof Error ? error.message : "OIDC_FAILED")
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (isMockMode) return
    const onExpired = (event: Event) => {
      const detail = (event as CustomEvent<{ redirectPath?: string }>).detail
      if (detail?.redirectPath !== "/management") return
      setIdentity(null)
      setAuthState("signed_out")
      setAuthNotice("OIDC_SESSION_EXPIRED")
    }
    window.addEventListener(BROWSER_SESSION_EXPIRED_EVENT, onExpired)
    return () => window.removeEventListener(BROWSER_SESSION_EXPIRED_EVENT, onExpired)
  }, [])

  function signIn(forceReauthentication = false) {
    sessionStorage.removeItem("genioone.signed_out:/management")
    setAuthNotice(null)
    void beginBrowserLogin("/management", true, forceReauthentication ? { forceReauthentication: true } : {}).catch((error) => {
      setAuthState("signed_out")
      setAuthNotice(error instanceof Error ? error.message : "OIDC_FAILED")
    })
  }

  function signOut() {
    if (isMockMode) return
    sessionStorage.setItem("genioone.signed_out:/management", "true")
    clearBrowserSession("/management")
    setIdentity(null)
    setAuthState("signed_out")
    setAuthNotice(null)
  }

  function page() {
    if (activePage === "product-docs") {
      return <ProductDocumentationPage />
    }
    if (activePage === "api-docs") {
      return <ProductApiReferencePage />
    }
    if (!data) return <div role="status" className="flex items-center gap-3 py-12"><LoaderCircleIcon className="animate-spin" />{t("Loading management data…")}</div>
    if (activePage === "overview") {
      return (
        <OverviewPage
          accessTier={demo.tier}
          actorSubjectId={identity!.subject_id}
          tenantId={tenantId}
          data={data}
          loading={loading}
          refreshing={refreshing}
          onRefresh={refresh}
          onOpenList={(page, filter) => navigate(page, { filter })}
        />
      )
    }
    switch (activePage) {
      case "resources":
        return (
          <ResourcesPage
            tenantId={tenantId}
            identity={identity!}
            data={data}
            initialResourceId={focusedResourceId}
            search={search}
            onRefresh={refresh}
            onOpenConnections={(resourceId, options) => {
              navigate("connections", { focusedResourceId: resourceId, create: options?.create })
            }}
          />
        )
      case "connections":
        return (
          <ConnectionsPage
            tenantId={tenantId}
            resources={data.resources}
            connections={data.connections}
            runtimes={data.runtimes}
            focusedResourceId={focusedResourceId}
            onRefresh={refresh}
            onOpenResource={(resourceId) => {
              navigate("resources", { focusedResourceId: resourceId })
            }}
          />
        )
      case "applications":
        return (
          <ApplicationsPage tenantId={tenantId} data={data} onRefresh={refresh} />
        )
      case "access":
        return <AccessPage tenantId={tenantId} data={data} onRefresh={refresh} />
      case "policy":
        return (
          <OnePolicyPage
            identity={identity!}
            canManageFirstPartyBotSeed={identity?.role === "TENANT_ADMINISTRATOR"}
            data={data}
            tenantId={tenantId}
          />
        )
      case "activity":
        return (
          <ActivityPage
            tenantId={tenantId}
            data={data}
            search={search}
            onRefresh={refresh}
            accessTier={demo.tier}
          />
        )
      case "usage":
        return <ActivityPage tenantId={tenantId} data={data} search={search} onRefresh={refresh} mode="usage" accessTier={demo.tier} />
      case "audit":
        return <ActivityPage tenantId={tenantId} data={data} search={search} onRefresh={refresh} mode="audit" accessTier={demo.tier} />
      case "traces":
        return <TracesPage tenantId={tenantId} />
      case "metrics":
        return <MetricsPage tenantId={tenantId} />
      case "dashboards":
        return <DashboardsPage tenantId={tenantId} data={data} />
      case "intelligence":
        return <AccessGovernancePage tenantId={tenantId} identity={identity!} data={data} />
      case "runtimes":
        return <RuntimesPage tenantId={tenantId} data={data} search={search} onRefresh={refresh} />
      case "people":
        return <IdentityPage tenantId={tenantId} identity={identity} data={data} mode="people" onRefresh={refresh} />
      case "agents":
        return <IdentityPage tenantId={tenantId} identity={identity} data={data} mode="agents" onRefresh={refresh} />
      case "organization":
        return <OrganizationPage tenantId={tenantId} identity={identity!} data={data} onReload={refresh} />
      case "personal-settings":
        return <PersonalSettingsPage identity={identity!} mockMode={isMockMode} />
      case "settings":
        return (
          <SettingsPage
            tenantId={tenantId}
            identity={identity!}
            data={data}
            onReload={refresh}
          />
        )
    }
  }

  if (authState !== "signed_in" || !identity) {
    return (
      <TooltipProvider>
        <main className="flex min-h-screen items-center justify-center bg-muted/20 p-6">
          <Card className="w-full max-w-xl">
            <CardHeader className="border-b">
              <CardTitle className="flex items-center gap-2 text-2xl">
                <ShieldCheckIcon className="size-5 text-primary" />
                {t("GenioOne Control Plane")}
              </CardTitle>
              <CardDescription>
                {authState === "checking"
                  ? t("Checking the OIDC management session…")
                  : authState === "unavailable" ? t("The Platform is temporarily unavailable. Your login is preserved; retry when it is ready.") : t("Sign in with the configured OIDC provider to manage this Tenant.")}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5 py-8">
              {authState === "checking" ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <LoaderCircleIcon className="size-4 animate-spin" />
                  {t("Validating session")}
                </p>
              ) : authState === "unavailable" ? (
                <Button size="lg" className="self-start" onClick={() => window.location.reload()}>
                  <LogInIcon data-icon="inline-start" />
                  {t("Retry")}
                </Button>
              ) : (
                <div className="flex flex-wrap gap-3">
                  <Button size="lg" onClick={() => signIn()}>
                    <LogInIcon data-icon="inline-start" />
                    {t("Sign in as Tenant Administrator")}
                  </Button>
                  <Button size="lg" variant="outline" onClick={() => signIn(true)}>
                    <UserRoundIcon data-icon="inline-start" />
                    {t("Use another account")}
                  </Button>
                </div>
              )}
              {authNotice ? <p className="text-sm text-destructive">{t(authNotice)}</p> : null}
            </CardContent>
          </Card>
        </main>
      </TooltipProvider>
    )
  }

  return (
    <TooltipProvider>
      <SidebarProvider style={{ "--sidebar-width-icon": "4rem" } as React.CSSProperties}>
        <a
          className="fixed left-3 top-3 z-50 -translate-y-20 rounded-md bg-background px-3 py-2 text-sm font-medium shadow focus:translate-y-0"
          href="#management-main"
        >
          {t("Skip to main content")}
        </a>
        <AppSidebar
          activePage={activePage}
          data={data}
          identity={identity}
          mockMode={isMockMode}
          demoTier={demo.tier}
          demoGuideVisible={demo.guideVisible}
          search={search}
          onDemoGuideVisibleChange={demo.setGuideVisible}
          onDemoTierChange={demo.setTier}
          onNavigate={(page, options) => {
            navigate(page, options)
          }}
          onSearchChange={setSearch}
          onSignOut={signOut}
        />
        <SidebarInset>
          <SheetWorkspaceRoot>
          <SidebarTrigger className="fixed top-3 left-3 z-20 border bg-background md:hidden" />
          <div id="management-main" className="min-w-0 flex-1 bg-muted px-4 pb-6 pt-20 sm:px-6 sm:pb-8 md:pt-6 xl:px-6 xl:py-6">
            <div className="mx-auto w-full min-w-0 max-w-[var(--go-content-max)]">
              {isMockMode && demo.guideVisible ? (
                <DemoPageGuide
                  activePage={activePage}
                  tier={demo.tier}
                  onDismiss={() => demo.setGuideVisible(false)}
                  onNavigate={(nextPage) => navigate(nextPage)}
                />
              ) : null}
              {page()}
            </div>
          </div>
          </SheetWorkspaceRoot>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
