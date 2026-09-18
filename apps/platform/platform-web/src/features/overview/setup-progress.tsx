import { ArrowRightIcon } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"

import { GuidedSetupSteps, type GuidedSetupStep } from "@/components/guided-setup-steps"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import type { DemoProjectStatus, OverviewSnapshot } from "@/domain/contracts"
import { FirstRunSetupPanel } from "@/features/overview/first-run-setup-panel"
import { DemoProjectCard } from "@/features/overview/demo-project-card"

type SetupStep = { id: string; label: string; detail: string; complete: boolean }

function setupSteps(data: OverviewSnapshot, demoProject: DemoProjectStatus | null): SetupStep[] {
  const auditCorrelationIds = new Set(data.auditEvents.map((event) => event.correlation_id))
  const people = data.identity?.subjects.filter((subject) => subject.kind === "PERSON") ?? []
  const hasRecoveryAdministrator = Boolean(data.identity?.tenant_administrators.length)
  const hasDirectoryOrLocalAccountSource = Boolean(
    people.length > 1 && data.organizations.some((organization) =>
      (organization.membership_sources ?? []).some((source) => source.status === "SYNCED"),
    ),
  )
  const hasOrganizationAdministration = data.organizations.some(
    (organization) => Boolean(organization.organization_administrator_subject_ids?.length),
  )
  return [
    { id: "authentication", label: "Sign-in and recovery", detail: "Primary sign-in path and a recovery Tenant Administrator", complete: hasRecoveryAdministrator },
    { id: "directory", label: "Directory and accounts", detail: "Previewed directory source or maintained local accounts", complete: hasDirectoryOrLocalAccountSource },
    { id: "organization", label: "Organizations and roles", detail: "Organization boundaries and delegated administrators", complete: hasOrganizationAdministration },
    { id: "demo-project", label: "Optional Demo Project", detail: "Install the CE starter project or skip it for now", complete: demoProject?.installation === "INSTALLED" || demoProject?.installation === "SKIPPED" },
    { id: "gateway", label: "Gateway deployment", detail: "Registered deployment is connected, ready, and in sync", complete: Boolean(data.gatewayFleet?.traffic_available && data.runtimes.some((runtime) => runtime.runtime_kind === "GATEWAY" && runtime.connected && runtime.operator_state === "READY" && runtime.in_sync)) },
    { id: "resource", label: "Resource and Connection", detail: "Governed Resource with a usable Connection", complete: data.resources.some((resource) => !resource.builtin_service && resource.lifecycle !== "RETIRED" && data.connections.some((connection) => connection.resource_id === resource.resource_id && connection.lifecycle === "ENABLED")) },
    { id: "verify", label: "Verify access and audit", detail: "An attributed invocation links Activity and Audit", complete: data.activity.recent_activity.some((event) => auditCorrelationIds.has(event.correlation_id)) || data.apiActivity.events.some((event) => auditCorrelationIds.has(event.correlation_id)) },
  ]
}

export function SetupProgress({
  actorSubjectId,
  tenantId,
  data,
  onRefresh,
}: {
  actorSubjectId: string
  tenantId: string
  data: OverviewSnapshot
  onRefresh: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [demoProject, setDemoProject] = useState<DemoProjectStatus | null>(null)
  const steps = setupSteps(data, demoProject)
  const completed = steps.filter((step) => step.complete).length
  const next = steps.find((step) => !step.complete)
  const [selectedStepId, setSelectedStepId] = useState(next?.id ?? steps[0]?.id ?? "")
  const guidedSteps: GuidedSetupStep[] = steps.map((step) => ({
    id: step.id,
    label: t(step.label),
    description: t(step.detail),
    status: step.complete ? "complete" : step.id === next?.id ? "current" : "upcoming",
  }))

  const selected = steps.find((step) => step.id === selectedStepId) ?? next ?? steps[0]

  return (
    <>
      <Card data-testid="overview-setup-progress" size="sm">
        <CardHeader>
          <CardTitle>{t("First-run setup")} {completed}/{steps.length}</CardTitle>
          <CardDescription>{t(next?.label ?? "Setup is complete")}</CardDescription>
          <CardAction>
            <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>{t(next ? "Continue setup" : "Review setup")}<ArrowRightIcon data-icon="inline-end" /></Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <Progress value={(completed / steps.length) * 100} />
        </CardContent>
      </Card>
      <DemoProjectCard actorSubjectId={actorSubjectId} identity={data.identity} key={`overview-demo-${demoProject?.installation ?? "unavailable"}`} onRefresh={onRefresh} onStatusChange={setDemoProject} organizations={data.organizations} tenantId={tenantId} />
      <Sheet open={open} onOpenChange={(nextOpen) => { setOpen(nextOpen); if (nextOpen) setSelectedStepId(next?.id ?? steps[0]?.id ?? "") }}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-4xl lg:max-w-5xl" data-testid="first-run-setup-wizard">
          <SheetHeader><SheetTitle>{t("First-run setup wizard")}</SheetTitle></SheetHeader>
          <div className="px-6 py-5">
            <GuidedSetupSteps
              activeStepId={selected.id}
              onSelect={setSelectedStepId}
              steps={guidedSteps}
            />
            {selected.id === "demo-project"
              ? <DemoProjectCard actorSubjectId={actorSubjectId} identity={data.identity} onRefresh={onRefresh} onStatusChange={setDemoProject} organizations={data.organizations} tenantId={tenantId} />
              : <FirstRunSetupPanel data={data} description={t(selected.detail)} onRefresh={onRefresh} stepId={selected.id} tenantId={tenantId} title={t(selected.label)} />}
          </div>
          <SheetFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>{t("Close")}</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  )
}
