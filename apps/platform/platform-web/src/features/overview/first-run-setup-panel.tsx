import { ChevronRightIcon, PlusIcon, RefreshCwIcon } from "lucide-react"
import type { TFunction } from "i18next"
import { useState } from "react"
import { useTranslation } from "react-i18next"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { TitleHelp } from "@/components/title-help"
import type { OverviewSnapshot } from "@/domain/contracts"
import { RegisterConnectionSheet } from "@/features/connections/connections-page"
import { CreateOrganizationSheet } from "@/features/identity/create-organization-sheet"
import { ManageOrganizationSheet } from "@/features/identity/manage-organization-sheet"
import { CreateResourceWizard } from "@/features/resources/create-resource-wizard"
import { RegisterGatewaySheet } from "@/features/runtimes/register-gateway-sheet"

type SetupEvidence = {
  id: string
  title: string
  detail: string
  state: "ready" | "pending" | "optional"
}

function setupEvidence(stepId: string, data: OverviewSnapshot, t: TFunction): SetupEvidence[] {
  if (stepId === "authentication") {
    const administrators = data.identity?.tenant_administrators ?? []
    return [
      ...administrators.map((subjectId) => ({
        id: `administrator-${subjectId}`,
        title: t("Recovery Tenant Administrator"),
        detail: subjectId,
        state: "ready" as const,
      })),
      {
        id: "external-sign-in",
        title: t("Enterprise sign-in"),
        detail: data.identity?.external_identity_bindings.length
          ? t("External identity binding is available")
          : t("Bundled OIDC and local recovery path are available"),
        state: data.identity?.external_identity_bindings.length ? "ready" : "optional",
      },
    ]
  }

  if (stepId === "directory") {
    const sources = data.organizations.flatMap((organization) => (organization.membership_sources ?? []).map((source) => ({ organization, source })))
    const peopleCount = data.identity?.subjects.filter((subject) => subject.kind === "PERSON").length ?? 0
    return [{
      id: "local-accounts",
      title: t("Local account maintenance"),
      detail: peopleCount > 1
        ? t("{{count}} canonical People", { count: peopleCount })
        : t("Add another verified person through your identity provider before delegating organization administration."),
      state: peopleCount > 1 ? "ready" as const : "pending" as const,
    }, ...sources.map(({ organization, source }) => ({
      id: `${organization.organization_id}-${source.kind}-${source.reference}`,
      title: `${t(source.kind)} · ${organization.display_name}`,
      detail: source.reference,
      state: source.status === "SYNCED" ? "ready" as const : "pending" as const,
    }))]
  }

  if (stepId === "organization") {
    return data.organizations.length ? data.organizations.map((organization) => ({
      id: organization.organization_id,
      title: organization.display_name,
      detail: t("{{users}} Members · {{admins}} Organization Administrators", { users: organization.member_subject_ids.length, admins: organization.organization_administrator_subject_ids?.length ?? 0 }),
      state: organization.organization_administrator_subject_ids?.length ? "ready" as const : "pending" as const,
    })) : [{ id: "organization-missing", title: t("No Organizations"), detail: t("Create the first Organization and delegate an administrator"), state: "pending" as const }]
  }

  if (stepId === "gateway") {
    const runtimes = data.runtimes.filter((runtime) => runtime.runtime_kind === "GATEWAY")
    return runtimes.length ? runtimes.map((runtime) => ({
      id: runtime.runtime_id,
      title: runtime.runtime_id,
      detail: runtime.operator_state === "AWAITING_REPORT" ? t("Awaiting report") : runtime.connected ? runtime.in_sync ? t("Connected and in sync") : t("Connected with configuration drift") : t("Runtime is offline"),
      state: runtime.operator_state === "READY" && runtime.in_sync ? "ready" as const : "pending" as const,
    })) : [{ id: "gateway-missing", title: t("No Gateway deployment"), detail: t("Register a customer or hosted deployment target"), state: "pending" as const }]
  }

  if (stepId === "resource") {
    const resources = data.resources.filter((resource) => !resource.builtin_service && resource.lifecycle !== "RETIRED")
    const readyResource = resources.find((resource) => data.connections.some(
      (connection) => connection.resource_id === resource.resource_id && connection.lifecycle === "ENABLED",
    ))
    return [{
      id: "resource-readiness",
      title: t("Resource and Connection"),
      detail: readyResource ? t("A governed Resource has a usable Connection.") : t("Create a Resource and attach an enabled Connection"),
      state: readyResource ? "ready" as const : "pending" as const,
    }]
  }

  const auditCorrelationIds = new Set(data.auditEvents.map((event) => event.correlation_id))
  const correlationIds = [
    ...data.activity.recent_activity.map((event) => event.correlation_id),
    ...data.apiActivity.events.map((event) => event.correlation_id),
  ].filter((correlationId) => auditCorrelationIds.has(correlationId))
  return correlationIds.length ? correlationIds.slice(0, 5).map((correlationId) => ({
    id: correlationId,
    title: t("Attributed invocation"),
    detail: correlationId,
    state: "ready" as const,
  })) : [{ id: "invocation-missing", title: t("No attributed invocation"), detail: t("Run one governed request and verify its Activity and Audit correlation"), state: "pending" as const }]
}

export function FirstRunSetupPanel({
  tenantId,
  stepId,
  title,
  description,
  data,
  onRefresh,
}: {
  tenantId: string
  stepId: string
  title: string
  description: string
  data: OverviewSnapshot
  onRefresh: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [refreshing, setRefreshing] = useState(false)
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(null)
  const [showResourceCreator, setShowResourceCreator] = useState(false)
  const evidence = setupEvidence(stepId, data, t)
  const activeResources = data.resources.filter((resource) => !resource.builtin_service && resource.lifecycle !== "RETIRED")

  function selectEvidence(id: string) {
    setSelectedEvidenceId((current) => current === id ? null : id)
  }

  function evidenceAction(item: SetupEvidence) {
    const actionTrigger = (
      <Button size="sm" variant="outline" onClick={(event) => event.stopPropagation()}>
        {t("Configure")}
        <ChevronRightIcon data-icon="inline-end" />
      </Button>
    )

    if ((stepId === "directory" && item.id !== "local-accounts") || stepId === "organization") {
      const organization = data.organizations.find((candidate) => item.id === candidate.organization_id || item.id.startsWith(`${candidate.organization_id}-`))
      return organization ? (
        <ManageOrganizationSheet identity={data.identity} onSaved={onRefresh} organization={organization} tenantId={tenantId} trigger={actionTrigger} />
      ) : (
        <CreateOrganizationSheet identity={data.identity} onCreated={onRefresh} tenantId={tenantId} trigger={actionTrigger} />
      )
    }

    if (stepId === "gateway" && item.id === "gateway-missing") {
      return <RegisterGatewaySheet onRegistered={onRefresh} tenantId={tenantId} trigger={actionTrigger} />
    }

    if (stepId === "resource") {
      const hasReadyResource = activeResources.some((resource) => data.connections.some(
        (connection) => connection.resource_id === resource.resource_id && connection.lifecycle === "ENABLED",
      ))
      const resourceWithoutConnection = hasReadyResource ? undefined : activeResources[0]
      return <>
        {resourceWithoutConnection ? (
          <RegisterConnectionSheet
            defaultResourceId={resourceWithoutConnection.resource_id}
            onRegistered={onRefresh}
            resources={data.resources}
            tenantId={tenantId}
            trigger={actionTrigger}
          />
        ) : null}
        <Button size="sm" variant="outline" onClick={() => setShowResourceCreator(true)}>
          <PlusIcon data-icon="inline-start" />
          {t("Add resource")}
        </Button>
      </>
    }

    return (
      <Button
        size="sm"
        variant="outline"
        onClick={(event) => {
          event.stopPropagation()
          if (stepId === "verify") void refresh()
          else window.location.assign(`/management?view=${stepId === "gateway" ? "runtimes" : "people"}${stepId === "gateway" ? `&q=${encodeURIComponent(item.id)}` : ""}`)
        }}
      >
        {t(stepId === "verify" ? "Refresh evidence" : "Review")}
        <ChevronRightIcon data-icon="inline-end" />
      </Button>
    )
  }

  async function refresh() {
    setRefreshing(true)
    try {
      await onRefresh()
    } finally {
      setRefreshing(false)
    }
  }

  if (stepId === "resource" && (!activeResources.length || showResourceCreator)) {
    return (
      <Card className="mt-5" data-testid="first-run-resource-creator" size="sm">
        <CardContent>
          <CreateResourceWizard
            connections={data.connections}
            resources={data.resources}
            agents={data.identity?.subjects ?? []}
            onCancel={() => setShowResourceCreator(false)}
            onCreated={async () => {
              await onRefresh()
              setShowResourceCreator(false)
            }}
            organizations={data.organizations}
            tenantId={tenantId}
          />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="mt-5" data-testid={`first-run-${stepId}-panel`} size="sm">
      <CardHeader>
        <CardTitle><TitleHelp help={description}>{title}</TitleHelp></CardTitle>
      </CardHeader>
      <CardContent>
        <ItemGroup>
          {evidence.map((item) => (
            <Item
              className="hover:bg-muted/50"
              key={item.id}
              size="sm"
              variant="outline"
            >
              <button
                aria-expanded={selectedEvidenceId === item.id}
                className="min-w-0 flex-1 cursor-pointer text-left"
                onClick={() => selectEvidence(item.id)}
                type="button"
              >
                <ItemContent>
                  <ItemTitle>{item.title}</ItemTitle>
                  <ItemDescription className="break-all">{item.detail}</ItemDescription>
                </ItemContent>
              </button>
              <ItemActions>
                <Badge variant={item.state === "ready" ? "secondary" : item.state === "pending" ? "destructive" : "outline"}>
                  {t(item.state === "ready" ? "Ready" : item.state === "pending" ? "Needs setup" : "Optional")}
                </Badge>
                {evidenceAction(item)}
              </ItemActions>
              {selectedEvidenceId === item.id ? (
                <div className="basis-full border-t pt-3 text-sm text-muted-foreground">
                  {t(item.state === "ready"
                    ? "This evidence is already persisted. Use the row action to review or adjust its source."
                    : "This evidence is missing. Use the row action to open its setup or management page.")}
                </div>
              ) : null}
            </Item>
          ))}
        </ItemGroup>
      </CardContent>
      <CardFooter className="justify-end">
        <Button disabled={refreshing} onClick={() => void refresh()} variant="outline">
          <RefreshCwIcon className={refreshing ? "animate-spin" : undefined} data-icon="inline-start" />
          {t("Refresh evidence")}
        </Button>
      </CardFooter>
    </Card>
  )
}
