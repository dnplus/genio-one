import { ExternalLinkIcon, LoaderCircleIcon, RefreshCwIcon } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import type { DemoProjectItem, DemoProjectStatus, Organization, TenantIdentityInventory } from "@/domain/contracts"
import { CreateOrganizationSheet } from "@/features/identity/create-organization-sheet"
import { ProductApiError, installDemoProject, loadDemoProject, skipDemoProject } from "@/lib/product-api"

type BotDemoTask = "documents" | "spec-and-diagram" | "interviews"

const botTasks = new Set<BotDemoTask>(["documents", "spec-and-diagram", "interviews"])

function demoTaskCopy(id: string) {
  if (id === "documents") return { title: "Research technical documentation", detail: "Find implementation guidance for Next.js forms and server-side validation." }
  if (id === "spec-and-diagram") return { title: "Create a product spec and diagram", detail: "Turn the requirements into a concise PRD and an interactive architecture diagram." }
  if (id === "interviews") return { title: "Synthesize interviews", detail: "Turn the interview notes into user needs and testable first-release requirements." }
  return { title: "Demo task", detail: "Open this task in Genio Bot." }
}

function itemVariant(state: DemoProjectItem["state"]) {
  if (state === "READY") return "secondary" as const
  if (state === "NEEDS_CONFIGURATION" || state === "ERROR") return "destructive" as const
  return "outline" as const
}

function itemLabel(state: DemoProjectItem["state"]) {
  if (state === "READY") return "Ready"
  if (state === "NEEDS_CONFIGURATION") return "Needs configuration"
  if (state === "ERROR") return "Error"
  return "Disabled"
}

function manageableOrganizations(
  organizations: Organization[],
  identity: TenantIdentityInventory | null,
  actorSubjectId: string,
) {
  if (identity?.tenant_administrators.includes(actorSubjectId)) return organizations
  return organizations.filter((organization) => organization.organization_administrator_subject_ids.includes(actorSubjectId))
}

export function DemoProjectCard({
  actorSubjectId,
  tenantId,
  organizations,
  identity,
  onRefresh,
  onStatusChange,
}: {
  actorSubjectId: string
  tenantId: string
  organizations: Organization[]
  identity: TenantIdentityInventory | null
  onRefresh: () => Promise<void>
  onStatusChange?: (status: DemoProjectStatus | null) => void
}) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<DemoProjectStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [operation, setOperation] = useState<"install" | "skip" | "provision" | null>(null)
  const [error, setError] = useState("")
  const [installOpen, setInstallOpen] = useState(false)
  const [demoOpen, setDemoOpen] = useState(false)
  const eligibleOrganizations = useMemo(
    () => manageableOrganizations(organizations, identity, actorSubjectId),
    [actorSubjectId, identity, organizations],
  )
  const [organizationId, setOrganizationId] = useState("")

  useEffect(() => {
    const defaultOrganizationId = eligibleOrganizations[0]?.organization_id ?? ""
    setOrganizationId((current) => eligibleOrganizations.some((organization) => organization.organization_id === current) ? current : defaultOrganizationId)
  }, [eligibleOrganizations])

  async function reload() {
    setLoading(true)
    try {
      const nextStatus = await loadDemoProject(tenantId)
      setStatus(nextStatus)
      onStatusChange?.(nextStatus)
      setError("")
    } catch (caught) {
      onStatusChange?.(null)
      setError(caught instanceof Error ? caught.message : t("Unable to load the Demo Project status"))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
  }, [tenantId])

  async function install() {
    if (!organizationId) return
    setOperation("install")
    setError("")
    try {
      await installDemoProject(tenantId, organizationId)
      await onRefresh()
      await reload()
      setInstallOpen(false)
    } catch (caught) {
      setError(caught instanceof ProductApiError ? caught.message : caught instanceof Error ? caught.message : t("Demo installation failed"))
    } finally {
      setOperation(null)
    }
  }

  async function skip() {
    setOperation("skip")
    setError("")
    try {
      await skipDemoProject(tenantId)
      await onRefresh()
      await reload()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Unable to skip the Demo Project"))
    } finally {
      setOperation(null)
    }
  }

  async function completeSetup() {
    const installedOrganizationId = status?.organization_id
    if (!installedOrganizationId) return
    setOperation("provision")
    setError("")
    try {
      await installDemoProject(tenantId, installedOrganizationId)
      await onRefresh()
      await reload()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Demo setup failed"))
    } finally {
      setOperation(null)
    }
  }

  function actionUrl(item: DemoProjectItem) {
    if (item.action_url) return item.action_url
    return item.resource_id ? `/management?view=connections&resource=${encodeURIComponent(item.resource_id)}` : null
  }

  function openAction(item: DemoProjectItem) {
    const url = actionUrl(item)
    if (url) window.location.assign(url)
  }

  function openBotTask(id: string) {
    if (!status?.bot_url || !botTasks.has(id as BotDemoTask)) return
    window.open(`${status.bot_url.replace(/\/$/, "")}/?demo=${encodeURIComponent(id)}`, "_blank", "noopener,noreferrer")
  }

  const installation = status?.installation ?? "NOT_INSTALLED"
  const canInstall = eligibleOrganizations.length > 0
  const installing = operation === "install"
  const provisioning = operation === "provision"
  const needsSetup = installation === "INSTALLED" && Boolean(status?.organization_id) && Boolean(status?.items.some((item) => item.state !== "READY"))

  return (
    <>
      <Card data-testid="overview-demo-project" size="sm">
        <CardHeader>
          <CardTitle>{t("CE Demo Project")}</CardTitle>
          <CardDescription>{t("Install a guided starter project with sample materials, skills, and plugins. Some connections require your own sign-in or API key.")}</CardDescription>
          <CardAction>
            <Badge variant={installation === "INSTALLED" ? "secondary" : installation === "SKIPPED" ? "outline" : "destructive"}>
              {t(installation === "INSTALLED" ? "Installed" : installation === "SKIPPED" ? "Skipped" : "Not installed")}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {loading ? <div className="flex items-center gap-2 text-muted-foreground"><LoaderCircleIcon className="size-4 animate-spin" />{t("Loading Demo Project status…")}</div> : null}
          {error ? <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">{t(error)}</div> : null}
          {status ? (
            <ItemGroup>
              {status.items.map((item) => (
                <Item key={item.id} size="sm" variant="outline">
                  <ItemContent>
                    <ItemTitle>{item.name}</ItemTitle>
                    <ItemDescription>{item.detail}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Badge variant={itemVariant(item.state)}>{t(itemLabel(item.state))}</Badge>
                    {actionUrl(item) ? <Button size="sm" variant="outline" onClick={() => openAction(item)}>{t("Configure")}<ExternalLinkIcon data-icon="inline-end" /></Button> : null}
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          ) : null}
          {needsSetup ? <div className="rounded-md border p-3 text-sm text-muted-foreground">{t("Some Demo Project connections still need your personal sign-in or API key. Complete Demo setup prepares available services without replacing those settings.")}</div> : null}
          {!canInstall ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm text-muted-foreground"><span>{t("Create an Organization you administer before installing the Demo Project.")}</span><CreateOrganizationSheet identity={identity} onCreated={async () => { await onRefresh(); await reload() }} tenantId={tenantId} trigger={<Button size="sm">{t("Create Organization")}</Button>} /></div> : null}
        </CardContent>
        <CardFooter className="justify-between gap-2">
          <Button disabled={loading || operation !== null} onClick={() => void reload()} size="sm" variant="outline"><RefreshCwIcon data-icon="inline-start" />{t("Refresh")}</Button>
          <div className="flex flex-wrap justify-end gap-2">
            {installation !== "INSTALLED" ? <Button disabled={!canInstall || loading || operation !== null} onClick={() => setInstallOpen(true)} size="sm">{t(installation === "SKIPPED" ? "Install Demo Project" : "Install Demo")}</Button> : null}
            {installation === "NOT_INSTALLED" ? <Button disabled={loading || operation !== null} onClick={() => void skip()} size="sm" variant="outline">{operation === "skip" ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : null}{t("Skip for now")}</Button> : null}
            {needsSetup ? <Button disabled={loading || operation !== null} onClick={() => void completeSetup()} size="sm" variant="outline">{provisioning ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : null}{t(error ? "Retry Demo setup" : "Complete Demo setup")}</Button> : null}
            {installation === "INSTALLED" ? <Button disabled={loading} onClick={() => setDemoOpen(true)} size="sm">{t("Open Demo")}</Button> : null}
          </div>
        </CardFooter>
      </Card>
      <Sheet open={installOpen} onOpenChange={setInstallOpen}>
        <SheetContent className="w-full sm:max-w-xl" presentation="side" side="right">
          <SheetHeader>
            <SheetTitle>{t("Install CE Demo Project")}</SheetTitle>
            <SheetDescription>{t("The Demo Project creates only its own Organization-scoped materials. You can configure personal connections afterward with your own sign-in or API key.")}</SheetDescription>
          </SheetHeader>
          <FieldGroup className="px-6 py-5">
            <Field>
              <FieldLabel>{t("Organization")}</FieldLabel>
              <Select value={organizationId} onValueChange={setOrganizationId}>
                <SelectTrigger><SelectValue placeholder={t("Select an Organization")} /></SelectTrigger>
                <SelectContent><SelectGroup>{eligibleOrganizations.map((organization) => <SelectItem key={organization.organization_id} value={organization.organization_id}>{organization.display_name}</SelectItem>)}</SelectGroup></SelectContent>
              </Select>
              <FieldDescription>{t("Only Organizations you administer are available.")}</FieldDescription>
            </Field>
            {error ? <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">{t(error)}</div> : null}
          </FieldGroup>
          <SheetFooter className="border-t px-6 py-4">
            <Button disabled={installing} onClick={() => setInstallOpen(false)} type="button" variant="outline">{t("Cancel")}</Button>
            <Button disabled={!organizationId || operation !== null} onClick={() => void install()} type="button">{installing ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : null}{t(installing ? "Installing…" : error ? "Retry installation" : "Install Demo Project")}</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
      <Sheet open={demoOpen} onOpenChange={setDemoOpen}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-2xl" presentation="side" side="right">
          <SheetHeader>
            <SheetTitle>{t("CE Demo tasks")}</SheetTitle>
            <SheetDescription>{t("Choose a task to begin working with the CE starter project in Genio Bot.")}</SheetDescription>
          </SheetHeader>
          <ItemGroup className="px-6 py-5">
            {status?.prompts.map((prompt) => {
              const canOpenTask = Boolean(status.bot_url && botTasks.has(prompt.id as BotDemoTask))
              const copy = demoTaskCopy(prompt.id)
              return (
                <Item className="flex-col items-stretch gap-3" key={prompt.id} size="sm" variant="outline">
                  <ItemContent className="w-full">
                    <ItemTitle className="w-full whitespace-normal">{t(copy.title)}</ItemTitle>
                    <ItemDescription className="line-clamp-none">{t(copy.detail)}</ItemDescription>
                  </ItemContent>
                  <ItemActions className="w-full flex-wrap justify-between">
                    <Badge variant="outline">{t(prompt.model_route === "codex-subscription" ? "Codex subscription" : "Genio Gateway")}</Badge>
                    <Button disabled={!canOpenTask} onClick={() => openBotTask(prompt.id)} size="sm">
                      {t("Open in Bot")}<ExternalLinkIcon data-icon="inline-end" />
                    </Button>
                  </ItemActions>
                </Item>
              )
            })}
          </ItemGroup>
          {!status?.bot_url ? <div className="mx-6 rounded-md border p-3 text-sm text-muted-foreground">{t("The CE demo Bot URL has not been configured for this environment.")}</div> : null}
          <SheetFooter className="mt-5 border-t px-6 py-4"><Button onClick={() => setDemoOpen(false)} type="button" variant="outline">{t("Close")}</Button></SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  )
}
