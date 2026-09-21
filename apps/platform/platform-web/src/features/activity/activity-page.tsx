import { isDecisionAuditEvent } from "@/domain/audit-events"
import type { DecisionAuditEvent } from "@/domain/contracts"
import { AuditQueryTable } from "./audit-query-table"
import { } from "@/components/relation-value"
import { PageHeader } from "@/components/page-header"
import { subjectDisplayName } from "@/features/sections/section-chrome"
import { createColumnHelper } from "@tanstack/react-table"
import {
  ActivityIcon,
  BotIcon,
  LoaderCircleIcon,
  ServerIcon,
  ShieldCheckIcon,
  DownloadIcon,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import { DataTable } from "@/components/data-table/data-table"
import type { DataTableFeatures } from "@/components/data-table/data-table-features"
import { RecordFilterBar } from "@/components/data-table/record-filter-bar"
import { DataEmpty } from "@/components/data-empty"
import { SearchableSelect } from "@/components/ui/searchable-select"
import { RouteBadge } from "@/components/route-badge"
import { TitleHelp } from "@/components/title-help"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { } from "@/components/ui/textarea"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, } from "@/components/ui/tabs"
import type { AccessRequest, ApiGatewayActivityEvent, AuditEvent, AuditExportArtifact, EndpointActivityEvent, InvocationAccountingRecord, OverviewSnapshot, ResourceRegistration, RouteDecision } from "@/domain/contracts"
import { } from "@/features/provider-credentials/provider-credential-profiles-panel"
import { } from "@/features/access/access-request-sheet"
import { } from "@/features/access/grant-entitlement-sheet"
import { } from "@/features/access/execution-grant-requests-card"
import { } from "@/features/access/revoke-entitlement-sheet"
import { AuditDecisionSheet } from "@/features/activity/audit-decision-sheet"
import { AiUsageDashboard } from "@/features/activity/ai-usage-dashboard"
import { UsageGovernancePanel } from "@/features/activity/usage-governance-panel"
import { loadActivityAccountingEvidence } from "@/features/activity/activity-evidence"
import { createActivityDisplayDirectory } from "@/features/activity/activity-display"
import { ApiGatewayTransactionSheet } from "@/features/activity/api-gateway-transaction-sheet"
import { ClassifyDiscoveriesSheet } from "@/features/activity/classify-discoveries-sheet"
import {
  apiGatewayTrafficPath,
  endpointTrafficPath,
  governedGatewayTrafficPath,
  TrafficPathBadge,
  trafficPathLabels,
} from "@/features/activity/traffic-path"
import { } from "@/features/self-service/access-lifecycle"
import {
  EnforcementPointFilter,
  matchesEnforcementPoint,
  normalizeEnforcementPoint,
  readEnforcementPointFilter,
  enforcementPointQueryKey,
  writeEnforcementPointFilter,
  type EnforcementPointFilterValue,
  type EnforcementPointId,
} from "@/features/observability/enforcement-points"
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
import { actingClientLabel, relativeTime } from "@/lib/format"
import { } from "@/lib/personal-preferences"
import {
  exportAuditEvents,
  queryAuditEvents,
  type AuditQueryResponse,
} from "@/lib/product-api"

const apiActivityColumnHelper = createColumnHelper<DataTableFeatures, ApiGatewayActivityEvent>()
const governedActivityColumnHelper = createColumnHelper<DataTableFeatures, DecisionAuditEvent>()
const endpointActivityColumnHelper = createColumnHelper<DataTableFeatures, EndpointActivityEvent>()

function isRuntimeAuditEvent(event: DecisionAuditEvent): boolean {
  return event.kind === "RUNTIME_POLICY_DECISION"
}

function runtimeAuditPolicyLabel(event: DecisionAuditEvent): string {
  if (!isRuntimeAuditEvent(event)) return event.decision?.policy_version ?? ""
  const label = event.policy_display_name ?? event.policy_id ?? "Runtime policy"
  return event.policy_revision === null || event.policy_revision === undefined
    ? label
    : `${label} · r${event.policy_revision}`
}

function runtimeAuditActualOutcome(event: DecisionAuditEvent): string {
  return isRuntimeAuditEvent(event) ? event.report_outcome ?? "" : ""
}

function GovernedGatewayActivityTable({
  events,
  resources,
  lane,
  accessTier,
  search,
  onOpen,
}: {
  events: DecisionAuditEvent[]
  resources: ResourceRegistration[]
  lane: "ai" | "access"
  accessTier: "T1" | "T2"
  search: string
  onOpen: (event: AuditEvent) => void
}) {
  const { t } = useTranslation()
  const resourcesById = useMemo(
    () => new Map(resources.map((resource) => [resource.resource_id, resource])),
    [resources],
  )
  const laneTitle = lane === "ai"
    ? "AI Gateway activity"
    : accessTier === "T2" ? "Secure Access Gateway activity" : "Access Gateway activity"
  const laneHelp = lane === "ai"
    ? "LLM and MCP invocation outcomes correlated to identity, Resource, Capability, route, and policy evidence."
    : "Access destination outcomes correlated to identity, device, route, and policy evidence."
  const columns = useMemo(() => governedActivityColumnHelper.columns([
    governedActivityColumnHelper.accessor(
      (event) => `${event.subject.subject_id} ${event.acting_client.acting_client_id ?? ""}`,
      {
        id: "subject",
        header: t("Subject / Acting Client"),
        cell: ({ row }) => <>
          <div className="font-medium">{row.original.subject.subject_id}</div>
          <div className="font-mono text-xs text-muted-foreground">{row.original.acting_client.acting_client_id ?? t("Unknown")}</div>
        </>,
      },
    ),
    governedActivityColumnHelper.accessor(
      (event) => `${resourcesById.get(event.resource_id ?? "")?.display_name ?? ""} ${event.resource_id ?? ""} ${event.capability_id ?? ""}`,
      {
        id: "resource",
        header: t("Resource / Capability"),
        cell: ({ row }) => {
          const resource = row.original.resource_id ? resourcesById.get(row.original.resource_id) : undefined
          return <>
            <div>{resource?.display_name ?? row.original.resource_id ?? "—"}</div>
            <div className="font-mono text-xs text-muted-foreground">{row.original.capability_id ?? "—"}</div>
          </>
        },
      },
    ),
    governedActivityColumnHelper.accessor(
      (event) => lane === "ai"
        ? `${resourcesById.get(event.resource_id ?? "")?.kind ?? ""} ${event.enforcement_point_id ?? ""}`
        : `${event.destination_host ?? ""} ${event.device_id ?? ""}`,
      {
        id: "gateway-detail",
        header: lane === "ai" ? t("Type / Gateway") : t("Destination / Device"),
        cell: ({ row }) => {
          const resource = row.original.resource_id ? resourcesById.get(row.original.resource_id) : undefined
          return lane === "ai" ? (
            <><Badge variant="secondary">{resource?.kind ?? "—"}</Badge><div className="mt-1 text-xs text-muted-foreground">{row.original.enforcement_point_id ?? "—"}</div></>
          ) : (
            <><div className="max-w-56 truncate" title={row.original.destination_host ?? undefined}>{row.original.destination_host ?? "—"}</div><div className="font-mono text-xs text-muted-foreground">{row.original.device_id ?? "—"}</div></>
          )
        },
      },
    ),
    governedActivityColumnHelper.accessor(
      (event) => governedGatewayTrafficPath(event, lane),
      {
        id: "trafficPath",
        header: t("Traffic path"),
        cell: ({ getValue }) => <TrafficPathBadge path={getValue()} />,
        filterFn: "includesString",
      },
    ),
    governedActivityColumnHelper.accessor("outcome", {
      header: t("Outcome"),
      cell: ({ getValue }) => <Badge variant={getValue() === "FAILED" || getValue() === "DENIED" || getValue() === "BLOCKED" ? "destructive" : "outline"}>{t(getValue())}</Badge>,
      filterFn: "includesString",
    }),
    governedActivityColumnHelper.accessor("correlation_id", {
      header: t("Correlation"),
      cell: ({ getValue }) => <span className="font-mono text-xs">{getValue()}</span>,
    }),
    governedActivityColumnHelper.accessor("occurred_at", {
      header: t("Occurred"),
      cell: ({ getValue }) => <span className="text-muted-foreground">{relativeTime(getValue())}</span>,
    }),
  ]), [lane, resourcesById, t])
  const trafficPaths = lane === "ai"
    ? (["MANAGED_RESOURCE", "BLOCK"] as const)
    : (["SECURE_ACCESS", "BLOCK"] as const)

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle><TitleHelp help={t(laneHelp)}>{t(laneTitle)}</TitleHelp></CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        {events.length ? (
          <DataTable
            columns={columns}
            data={events}
            filters={[
              {
                allLabel: t("All traffic paths"),
                columnId: "trafficPath",
                label: t("Traffic path"),
                options: trafficPaths.map((path) => ({ label: t(trafficPathLabels[path]), value: path })),
              },
              {
                allLabel: t("All outcomes"),
                columnId: "outcome",
                label: t("Outcome"),
                options: [...new Set(events.map((event) => event.outcome))]
                  .map((outcome) => ({ label: t(outcome), value: outcome })),
              },
            ]}
            getRowId={(event) => event.audit_event_id}
            getRowTestId={(event) => `${lane}-gateway-activity-row-${event.audit_event_id}`}
            noResults={<DataEmpty icon={lane === "ai" ? BotIcon : ShieldCheckIcon} title={t("No matching activity")} description={t("Try another traffic path, outcome, or search term.")} />}
            onRowClick={onOpen}
            pageSize={10}
            searchPlaceholder={t(lane === "ai" ? "Search AI Gateway activity" : "Search Access Gateway activity")}
          />
        ) : (
          <DataEmpty
            icon={lane === "ai" ? BotIcon : ShieldCheckIcon}
            title={search
              ? t(lane === "ai" ? "No matching AI Gateway activity" : "No matching Access Gateway activity")
              : t(lane === "ai" ? "No AI Gateway activity" : "No Access Gateway activity")}
            description={t(lane === "ai"
              ? "Governed LLM and MCP traffic will appear after AI Gateway reporting."
              : "Governed destination traffic will appear after Access Gateway reporting.")}
          />
        )}
      </CardContent>
    </Card>
  )
}


export function ActivityPage({
  tenantId,
  data,
  search,
  onRefresh,
  mode = "activity",
  accessTier = "T1",
}: {
  tenantId: string
  data: OverviewSnapshot
  search: string
  onRefresh: () => Promise<void>
  mode?: "activity" | "audit" | "metrics" | "usage"
  accessTier?: "T1" | "T2"
}) {
  const { t } = useTranslation()
  const executionAuditEvents = useMemo(() => data.auditEvents.filter(isDecisionAuditEvent), [data.auditEvents])
  const latestGatewayPoint: EnforcementPointId = normalizeEnforcementPoint(data.apiActivity.events[0]?.enforcement_point_id) ?? "API_GATEWAY"
  const initialTab = mode === "audit" ? "audit" : mode === "metrics" || mode === "usage" ? "usage" : latestGatewayPoint
  const [activityTab, setActivityTab] = useState<EnforcementPointId>(() => {
    const parameters = new URLSearchParams(window.location.search)
    const requested = readEnforcementPointFilter(parameters.get(enforcementPointQueryKey) ?? parameters.get("lane"), latestGatewayPoint)
    return requested === "ALL" ? latestGatewayPoint : requested
  })
  const [auditEnforcementPoint, setAuditEnforcementPoint] = useState<EnforcementPointFilterValue>(() =>
    readEnforcementPointFilter(new URLSearchParams(window.location.search).get(enforcementPointQueryKey), "ALL"),
  )
  const [selectedDiscoveries, setSelectedDiscoveries] = useState<string[]>([])
  const [selectedAuditEvent, setSelectedAuditEvent] = useState<AuditEvent | null>(null)
  const [selectedAuditAccounting, setSelectedAuditAccounting] = useState<InvocationAccountingRecord | null>(null)
  const [selectedAuditAccessRequest, setSelectedAuditAccessRequest] = useState<AccessRequest | null>(null)
  const [selectedApiActivity, setSelectedApiActivity] = useState<ApiGatewayActivityEvent | null>(null)
  const [classificationOpen, setClassificationOpen] = useState(false)
  const auditedResource = executionAuditEvents.find((event) => event.resource_id)?.resource_id
  const [auditResourceId, setAuditResourceId] = useState(auditedResource ?? data.resources[0]?.resource_id ?? "")
  const [auditFrom, setAuditFrom] = useState(() => {
    const date = new Date()
    date.setDate(date.getDate() - 7)
    return date.toISOString().slice(0, 10)
  })
  const [auditTo, setAuditTo] = useState(() => new Date().toISOString().slice(0, 10))
  const [auditExportBusy, setAuditExportBusy] = useState(false)
  const [auditExportResult, setAuditExportResult] = useState<AuditExportArtifact | null>(null)
  const [auditExportError, setAuditExportError] = useState("")
  const [serverAuditQuery, setServerAuditQuery] = useState<AuditQueryResponse | null>(null)
  const [auditQueryCorrelationId, setAuditQueryCorrelationId] = useState("")
  const [auditQueryResourceId, setAuditQueryResourceId] = useState("")
  const [auditQuerySubjectId, setAuditQuerySubjectId] = useState("")
  const [auditQueryOutcome, setAuditQueryOutcome] = useState("")
  const [auditQueryFrom, setAuditQueryFrom] = useState("")
  const [auditQueryTo, setAuditQueryTo] = useState("")
  const [auditQueryOffset, setAuditQueryOffset] = useState(0)
  const [auditQueryLimit, setAuditQueryLimit] = useState(50)
  const [auditQueryBusy, setAuditQueryBusy] = useState(false)
  const [auditQueryError, setAuditQueryError] = useState("")
  const activityDisplay = useMemo(
    () => createActivityDisplayDirectory(data),
    [data.applications, data.connections, data.identity, data.resources],
  )
  const serverAuditEvents = serverAuditQuery?.events ?? null
  const auditResourceOptions = useMemo(
    () => data.resources.map((resource) => ({
      value: resource.resource_id,
      label: resource.display_name,
      description: resource.resource_id,
    })),
    [data.resources],
  )
  const auditSubjectOptions = useMemo(
    () => [
      { value: "ALL", label: t("All Subjects"), searchText: t("All Subjects") },
      ...(data.identity?.subjects ?? []).map((subject) => ({
        value: subject.subject_id,
        label: subject.profile.display_name ?? subject.subject_id,
        description: `${t(subject.kind)} · ${subject.subject_id}`,
        searchText: `${subject.profile.display_name ?? ""} ${subject.subject_id} ${t(subject.kind)}`,
      })),
    ],
    [data.identity?.subjects, t],
  )
  const auditQueryResourceOptions = useMemo(
    () => [{ value: "ALL", label: t("All Resources"), searchText: t("All Resources") }, ...auditResourceOptions],
    [auditResourceOptions, t],
  )
  const query = search.trim().toLowerCase()
  const discoveries = data.activity.resources.filter(
    (resource) =>
      resource.resource_class === "UNCLASSIFIED" &&
      !resource.classification &&
      [resource.resource_id, ...resource.destination_hosts].some((value) =>
        value.toLowerCase().includes(query),
      ),
  )
  const activities = data.activity.recent_activity.filter((activity) =>
    [
      activity.subject_id,
      activity.kind,
      t(activity.kind),
      activity.correlation_id,
      actingClientLabel(activity.client),
      activity.resource_id,
      activity.destination_host,
      activity.route,
    ].some((value) => value.toLowerCase().includes(query)),
  )
  const apiActivities = data.apiActivity.events.filter((event) =>
    matchesEnforcementPoint(event.enforcement_point_id, "API_GATEWAY") &&
    [
      activityDisplay.subject(event.subject_id, event.subject_display).label,
      activityDisplay.application(event.application_id ?? event.acting_client_id).label,
      activityDisplay.resource(event.resource_id).label,
      activityDisplay.capability(event.resource_id, event.capability_id).label,
      event.subject_id ?? "",
      event.application_id ?? "",
      event.resource_id,
      event.capability_id ?? "",
      event.method,
      event.path,
      event.mcp_method ?? "",
      event.mcp_tool ?? "",
      event.mcp_backend ?? "",
      event.downstream_identity_mode ?? "",
      String(event.status_code),
      event.outcome,
      event.correlation_id,
    ].some((value) => value.toLowerCase().includes(query)),
  )
  const aiRequestActivities = data.apiActivity.events.filter(
    (event) => matchesEnforcementPoint(event.enforcement_point_id, "AI_GATEWAY") && [
      activityDisplay.subject(event.subject_id, event.subject_display).label,
      activityDisplay.application(event.application_id ?? event.acting_client_id).label,
      activityDisplay.resource(event.resource_id).label,
      activityDisplay.capability(event.resource_id, event.capability_id).label,
      event.subject_id ?? "",
      event.application_id ?? "",
      event.resource_id,
      event.capability_id ?? "",
      event.method,
      event.path,
      event.mcp_method ?? "",
      event.mcp_tool ?? "",
      event.mcp_backend ?? "",
      event.downstream_identity_mode ?? "",
      String(event.status_code),
      event.outcome,
      event.correlation_id,
    ].some((value) => value.toLowerCase().includes(query)),
  )
  const auditByCorrelation = useMemo(
    () => new Map(executionAuditEvents.map((event) => [event.correlation_id, event])),
    [executionAuditEvents],
  )
  const activityByCorrelation = useMemo(
    () => new Map(data.apiActivity.events.map((event) => [event.correlation_id, event])),
    [data.apiActivity.events],
  )
  const updateActivityFilters = useCallback(({ filters, query }: { filters: Record<string, string>; query: string }) => {
    const url = new URL(window.location.href)
    if (query) url.searchParams.set("table_q", query)
    else url.searchParams.delete("table_q")
    if (filters.outcome) url.searchParams.set("outcome", filters.outcome)
    else url.searchParams.delete("outcome")
    if (filters.trafficPath) url.searchParams.set("traffic", filters.trafficPath)
    else url.searchParams.delete("traffic")
    window.history.replaceState({}, "", url)
  }, [])

  const openApiActivity = useCallback((event: ApiGatewayActivityEvent) => {
    const url = new URL(window.location.href)
    url.searchParams.set("record", event.correlation_id)
    window.history.pushState({}, "", url)
    setSelectedApiActivity(event)
  }, [])

  useEffect(() => {
    const restoreActivityLocation = () => {
      if (mode === "activity") {
        const parameters = new URLSearchParams(window.location.search)
        const requested = readEnforcementPointFilter(parameters.get(enforcementPointQueryKey) ?? parameters.get("lane"), latestGatewayPoint)
        setActivityTab(requested === "ALL" ? latestGatewayPoint : requested)
      }
      if (mode === "audit") {
        setAuditEnforcementPoint(readEnforcementPointFilter(new URLSearchParams(window.location.search).get(enforcementPointQueryKey), "ALL"))
      }
      const recordId = new URLSearchParams(window.location.search).get("record")
      setSelectedApiActivity(recordId ? data.apiActivity.events.find((event) => event.correlation_id === recordId) ?? null : null)
    }
    restoreActivityLocation()
    window.addEventListener("popstate", restoreActivityLocation)
    return () => window.removeEventListener("popstate", restoreActivityLocation)
  }, [data.apiActivity.events, latestGatewayPoint, mode])
  const apiActivityColumns = useMemo(() => apiActivityColumnHelper.columns([
    apiActivityColumnHelper.accessor(
      (event) => {
        const audit = auditByCorrelation.get(event.correlation_id)
        const client = activityDisplay.application(event.application_id ?? event.acting_client_id ?? audit?.acting_client.acting_client_id)
        const subject = activityDisplay.subject(
          event.subject_id ?? audit?.subject.subject_id,
          event.subject_display,
        )
        return `${client.label} ${subject.label}`
      },
      {
        id: "application",
        header: t("Client / Subject"),
        cell: ({ row }) => {
          const audit = auditByCorrelation.get(row.original.correlation_id)
          const client = activityDisplay.application(row.original.application_id ?? row.original.acting_client_id ?? audit?.acting_client.acting_client_id)
          const subject = activityDisplay.subject(
            row.original.subject_id ?? audit?.subject.subject_id,
            row.original.subject_display,
          )
          return <>
            <div className="font-medium">{client.resolved ? client.label : t(client.label)}</div>
            <div className="text-xs text-muted-foreground">{subject.resolved ? subject.label : t(subject.label)} · {t(subject.kind)}</div>
          </>
        },
      },
    ),
    apiActivityColumnHelper.accessor(
      (event) => `${activityDisplay.resource(event.resource_id).label} ${activityDisplay.capability(event.resource_id, event.capability_id).label}`,
      {
        id: "resource",
        header: t("Resource / Capability"),
        cell: ({ row }) => {
          const resource = activityDisplay.resource(row.original.resource_id)
          const capability = activityDisplay.capability(row.original.resource_id, row.original.capability_id)
          return <>
            <div className="font-medium">{resource.label}</div>
            <div className="text-xs text-muted-foreground">{capability.label}</div>
          </>
        },
      },
    ),
    apiActivityColumnHelper.accessor(
      (event) => `${event.method} ${event.path} ${event.mcp_method ?? ""} ${event.mcp_tool ?? ""}`,
      {
        id: "request",
        header: t("HTTP Request"),
        cell: ({ row }) => row.original.mcp_method ? <>
          <div className="font-medium">{t("MCP")} · {row.original.mcp_method}</div>
          <div className="max-w-64 truncate font-mono text-xs text-muted-foreground" title={row.original.mcp_tool ?? row.original.path}>{row.original.mcp_tool ?? row.original.path}</div>
        </> : <>
          <div className="font-medium">{row.original.method}</div>
          <div className="max-w-64 truncate font-mono text-xs text-muted-foreground" title={row.original.path}>{row.original.path}</div>
        </>,
      },
    ),
    apiActivityColumnHelper.accessor("status_code", {
      header: t("Status"),
      cell: ({ getValue }) => <Badge variant={getValue() >= 400 ? "destructive" : "secondary"}>{getValue()}</Badge>,
    }),
    apiActivityColumnHelper.accessor(
      (event) => apiGatewayTrafficPath(event),
      {
        id: "trafficPath",
        header: t("Traffic path"),
        cell: ({ getValue }) => <TrafficPathBadge path={getValue()} />,
        filterFn: "includesString",
      },
    ),
    apiActivityColumnHelper.accessor("outcome", {
      header: t("Outcome"),
      cell: ({ getValue }) => <Badge variant={getValue() === "COMPLETED" ? "outline" : "destructive"}>{t(getValue())}</Badge>,
      filterFn: "includesString",
    }),
    apiActivityColumnHelper.accessor("correlation_id", {
      header: t("Correlation"),
      cell: ({ getValue }) => <span className="font-mono text-xs">{getValue()}</span>,
    }),
    apiActivityColumnHelper.accessor("occurred_at", {
      header: t("Occurred"),
      cell: ({ getValue }) => <span className="text-muted-foreground">{relativeTime(getValue())}</span>,
    }),
  ]), [activityDisplay, auditByCorrelation, t])
  const endpointActivityColumns = useMemo(() => endpointActivityColumnHelper.columns([
    endpointActivityColumnHelper.accessor(
      (event) => subjectDisplayName(data, event.subject_id),
      {
        id: "subject",
      header: t("Subject"),
        cell: ({ getValue }) => <span className="font-medium">{getValue()}</span>,
      },
    ),
    endpointActivityColumnHelper.accessor("kind", {
      header: t("Kind"),
      cell: ({ row, getValue }) => <span data-testid={`endpoint-activity-kind-${row.original.activity_id}`} title={getValue()}>{t(getValue())}</span>,
      filterFn: "includesString",
    }),
    endpointActivityColumnHelper.accessor("correlation_id", {
      header: t("Correlation"),
      cell: ({ row, getValue }) => <span className="font-mono text-xs" data-correlation-id={getValue()} data-testid={`endpoint-activity-correlation-${row.original.activity_id}`}>{getValue()}</span>,
    }),
    endpointActivityColumnHelper.accessor(
      (event) => event.client.status,
      {
        id: "processState",
        header: t("Process State"),
        cell: ({ row, getValue }) => <span data-testid={`endpoint-activity-process-state-${row.original.activity_id}`} title={getValue()}>{t(getValue())}</span>,
      },
    ),
    endpointActivityColumnHelper.accessor(
      (event) => actingClientLabel(event.client),
      {
        id: "actingClient",
        header: t("Acting Client"),
        cell: ({ row, getValue }) => <span data-testid={`endpoint-activity-acting-client-${row.original.activity_id}`}>{getValue()}</span>,
      },
    ),
    endpointActivityColumnHelper.accessor(
      (event) => event.client_compliance?.state ?? "UNKNOWN",
      {
        id: "compliance",
        header: t("Compliance"),
        cell: ({ getValue }) => getValue() === "UNKNOWN" ? "—" : t(getValue() === "COMPLIANT" ? "Compliant" : "Non-compliant"),
      },
    ),
    endpointActivityColumnHelper.accessor("device_id", { header: t("Device") }),
    endpointActivityColumnHelper.accessor(
      (event) => event.resource_class === "UNCLASSIFIED"
        ? event.destination_host
        : data.resources.find((resource) => resource.resource_id === event.resource_id)?.display_name ?? event.resource_id,
      {
        id: "resource",
        header: t("Resource"),
        cell: ({ row }) => row.original.resource_class === "UNCLASSIFIED" ? <>
          <div className="font-medium">{row.original.destination_host}</div>
          <div className="text-xs text-muted-foreground">{t("Unclassified")}</div>
        </> : <span className="font-medium">
          {data.resources.find((resource) => resource.resource_id === row.original.resource_id)?.display_name ?? row.original.resource_id}
        </span>,
      },
    ),
    endpointActivityColumnHelper.accessor("destination_host", { header: t("Destination") }),
    endpointActivityColumnHelper.accessor(
      (event) => endpointTrafficPath(event),
      {
        id: "trafficPath",
        header: t("Traffic path"),
        cell: ({ getValue }) => <TrafficPathBadge path={getValue()} />,
        filterFn: "includesString",
      },
    ),
    endpointActivityColumnHelper.accessor("request_count", { header: t("Requests") }),
    endpointActivityColumnHelper.accessor("observed_at", {
      header: t("Observed"),
      cell: ({ getValue }) => <span className="text-muted-foreground">{relativeTime(getValue())}</span>,
    }),
  ]), [data, t])
  const resourcesById = new Map(data.resources.map((resource) => [resource.resource_id, resource]))
  const governedActivityMatchesSearch = (event: DecisionAuditEvent) => [
    event.subject.subject_id,
    event.acting_client.acting_client_id ?? "",
    event.resource_id ?? "",
    resourcesById.get(event.resource_id ?? "")?.display_name ?? "",
    event.capability_id ?? "",
    event.destination_host ?? "",
    event.route ?? "",
    event.outcome,
    event.correlation_id,
  ].some((value) => value.toLowerCase().includes(query))
  const aiGatewayActivities = executionAuditEvents.filter((event) =>
    matchesEnforcementPoint(event.enforcement_point_id, "AI_GATEWAY") && governedActivityMatchesSearch(event),
  )
  const accessGatewayActivities = executionAuditEvents.filter((event) =>
    matchesEnforcementPoint(event.enforcement_point_id, "ACCESS_GATEWAY") && governedActivityMatchesSearch(event),
  )
  const decisions = (serverAuditEvents ?? executionAuditEvents).filter(isDecisionAuditEvent).filter((event) => {
    const runtime = isRuntimeAuditEvent(event)
    if ((!event.decision && !runtime) || !matchesEnforcementPoint(event.enforcement_point_id, auditEnforcementPoint)) return false
    return [
      activityDisplay.subject(event.subject.subject_id).label,
      activityDisplay.application(activityByCorrelation.get(event.correlation_id)?.application_id ?? event.acting_client.acting_client_id).label,
      activityDisplay.resource(event.resource_id).label,
      activityDisplay.capability(event.resource_id ?? "", event.capability_id).label,
      event.subject.subject_id,
      event.acting_client.acting_client_id ?? "",
      event.resource_id ?? "",
      event.capability_id ?? "",
      event.correlation_id,
      event.outcome,
      runtime ? event.bot_id ?? "" : event.decision?.policy_version ?? "",
      runtime ? event.runtime_id ?? "" : "",
      runtime ? event.target ?? "" : "",
      runtime ? event.policy_display_name ?? "" : "",
      runtime ? event.report_outcome ?? "" : "",
    ].some((value) => value.toLowerCase().includes(query))
  })
  const policyDecisionColumns = useMemo(() => governedActivityColumnHelper.columns([
    governedActivityColumnHelper.accessor(
      (event) => {
        const activity = activityByCorrelation.get(event.correlation_id)
        const subject = activityDisplay.subject(event.subject.subject_id)
        const application = activityDisplay.application(activity?.application_id ?? event.acting_client.acting_client_id)
        return `${subject.label} ${application.label}`
      },
      {
        id: "subject",
        header: t("Subject / Acting Client"),
        cell: ({ row }) => {
          const activity = activityByCorrelation.get(row.original.correlation_id)
          const subject = activityDisplay.subject(row.original.subject.subject_id)
          const application = activityDisplay.application(activity?.application_id ?? row.original.acting_client.acting_client_id)
          return <>
            <div className="font-medium">{subject.label}</div>
            <div className="text-xs text-muted-foreground">{application.label} · {t(application.kind)}</div>
          </>
        },
      },
    ),
    governedActivityColumnHelper.accessor(
      (event) => isRuntimeAuditEvent(event)
        ? `${event.target ?? ""} ${event.runtime_id ?? ""} ${event.capability_id ?? ""} ${event.action ?? ""}`
        : `${activityDisplay.resource(event.resource_id).label} ${activityDisplay.capability(event.resource_id ?? "", event.capability_id).label}`,
      {
        id: "resource",
        header: t("Resource / Runtime target"),
        cell: ({ row }) => isRuntimeAuditEvent(row.original) ? <>
          <div className="font-medium">{row.original.target ?? "—"}</div>
          <div className="text-xs text-muted-foreground">{row.original.capability_id ?? "—"} · {row.original.action ?? "—"}</div>
        </> : (() => {
          const resource = activityDisplay.resource(row.original.resource_id)
          const capability = activityDisplay.capability(row.original.resource_id ?? "", row.original.capability_id)
          return <>
            <div className="font-medium">{resource.label}</div>
            <div className="text-xs text-muted-foreground">{capability.label}</div>
          </>
        })(),
      },
    ),
    governedActivityColumnHelper.accessor((event) => event.decision?.policy_version ?? "", {
      id: "policy-version",
      header: t("Policy version"),
      cell: ({ row, getValue }) => <span className="text-xs">{runtimeAuditPolicyLabel(row.original) || getValue() || "—"}</span>,
    }),
    governedActivityColumnHelper.accessor((event) => isRuntimeAuditEvent(event) ? event.outcome : event.decision?.access ?? "", {
      id: "decision",
      header: t("Decision"),
      cell: ({ getValue }) => getValue() ? t(getValue()) : "—",
    }),
    governedActivityColumnHelper.accessor((event) => isRuntimeAuditEvent(event) ? event.phase ?? "" : event.decision?.route ?? event.route ?? "", {
      id: "route",
      header: t("Route"),
      cell: ({ row, getValue }) => {
        const route = getValue()
        if (!route) return "—"
        return isRuntimeAuditEvent(row.original) ? <Badge variant="outline">{t(route)}</Badge> : <RouteBadge route={route as RouteDecision} />
      },
    }),
    governedActivityColumnHelper.accessor((event) => runtimeAuditActualOutcome(event), {
      id: "actual-outcome",
      header: t("Execution result"),
      cell: ({ getValue }) => getValue() ? <Badge variant={getValue() === "FAILED" || getValue() === "DENY" ? "destructive" : "outline"}>{t(getValue())}</Badge> : "—",
    }),
    governedActivityColumnHelper.accessor("outcome", {
      header: t("Outcome"),
      cell: ({ getValue }) => <Badge variant={getValue() === "BLOCKED" || getValue() === "DENY" ? "destructive" : "outline"}>{t(getValue())}</Badge>,
      filterFn: "includesString",
    }),
    governedActivityColumnHelper.accessor("occurred_at", {
      header: t("Occurred"),
      cell: ({ getValue }) => <span className="text-muted-foreground">{relativeTime(getValue())}</span>,
    }),
  ]), [activityByCorrelation, activityDisplay, t])
  async function openAuditEvent(event: AuditEvent) {
    setSelectedAuditEvent(event)
    setSelectedAuditAccounting(null)
    setSelectedAuditAccessRequest(null)
    if (!isDecisionAuditEvent(event)) return
    setSelectedAuditAccessRequest(
      event.access_request_id
        ? data.accessRequests.find((request) => request.access_request_id === event.access_request_id) ?? null
        : null,
    )
    if (!event.kind.startsWith("INVOCATION") || !event.decision) return
    try {
      const evidence = await loadActivityAccountingEvidence({
        tenantId,
        correlationId: event.correlation_id,
      })
      setSelectedAuditAccounting(evidence.accounting[0] ?? null)
    } catch {
      setSelectedAuditAccounting(null)
    }
  }
  async function downloadAuditExport() {
    setAuditExportBusy(true)
    setAuditExportError("")
    setAuditExportResult(null)
    try {
      const from = Math.floor(new Date(`${auditFrom}T00:00:00`).getTime() / 1000)
      const to = Math.floor(new Date(`${auditTo}T23:59:59`).getTime() / 1000)
      const artifact = await exportAuditEvents(tenantId, {
        from,
        to,
        resourceId: auditResourceId,
      })
      const url = URL.createObjectURL(new Blob([JSON.stringify(artifact, null, 2)], { type: "application/json" }))
      const link = document.createElement("a")
      link.href = url
      link.download = `genioone-audit-export-${auditResourceId}.json`
      link.click()
      URL.revokeObjectURL(url)
      setAuditExportResult(artifact)
    } catch (error) {
      setAuditExportError(error instanceof Error ? error.message : "AUDIT_EXPORT_FAILED")
    } finally {
      setAuditExportBusy(false)
    }
  }

  async function runAuditQuery(offset = auditQueryOffset) {
    setAuditQueryBusy(true)
    setAuditQueryError("")
    try {
      const from = auditQueryFrom
        ? Math.floor(new Date(`${auditQueryFrom}T00:00:00`).getTime() / 1000)
        : undefined
      const to = auditQueryTo
        ? Math.floor(new Date(`${auditQueryTo}T23:59:59`).getTime() / 1000)
        : undefined
      if (from !== undefined && to !== undefined && from > to) {
        throw new Error("Choose a valid time range.")
      }
      const result = await queryAuditEvents(tenantId, {
        correlationId: auditQueryCorrelationId.trim() || undefined,
        from,
        to,
        limit: auditQueryLimit,
        offset,
        outcome: auditQueryOutcome || undefined,
        resourceId: auditQueryResourceId || undefined,
        subjectId: auditQuerySubjectId.trim() || undefined,
        enforcementPointId: auditEnforcementPoint === "ALL" ? undefined : auditEnforcementPoint,
      })
      setAuditQueryOffset(offset)
      setServerAuditQuery(result)
    } catch (error) {
      setAuditQueryError(error instanceof Error ? error.message : "AUDIT_QUERY_FAILED")
    } finally {
      setAuditQueryBusy(false)
    }
  }

  function clearAuditQuery() {
    setServerAuditQuery(null)
    setAuditQueryError("")
    setAuditQueryOffset(0)
  }
  function useLoadedAuditRange() {
    const timestamps = [
      ...executionAuditEvents
        .filter((event) => event.resource_id === auditResourceId)
        .map((event) => event.occurred_at),
      ...data.apiActivity.events
        .filter((event) => event.resource_id === auditResourceId)
        .map((event) => event.occurred_at),
    ]
    if (!timestamps.length) return
    const localDate = (timestamp: number) => {
      const date = new Date(timestamp * 1000)
      return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0"),
      ].join("-")
    }
    setAuditFrom(localDate(Math.min(...timestamps)))
    setAuditTo(localDate(Math.max(...timestamps)))
  }
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t(mode === "audit" ? "Audit logs" : mode === "metrics" ? "Metrics" : mode === "usage" ? "Usage and cost" : "Activity")}
        description={t(mode === "audit"
          ? "Canonical governance and security decisions with correlation evidence."
          : mode === "metrics"
            ? "OpenTelemetry-aligned service, traffic, latency, error, and usage measurements."
            : mode === "usage"
              ? "Time-bounded usage, explicit cost distribution and Resource budget status across Endpoint and Gateway activity."
            : "Operational records from API Gateway, AI Gateway, Access enforcement, and Endpoints. Bypass appears only when an Endpoint reports minimal metadata; traffic that is not observed cannot have a detailed record.")}
      />
      <Tabs
        value={mode === "activity" ? activityTab : initialTab}
        onValueChange={(value) => {
          if (mode !== "activity") return
          const nextValue = normalizeEnforcementPoint(value)
          if (!nextValue) return
          setActivityTab(nextValue)
          writeEnforcementPointFilter(nextValue)
        }}
        className="gap-5"
      >
        {mode === "activity" ? (
          <EnforcementPointFilter
            value={activityTab}
            onValueChange={(value) => {
              if (value === "ALL") return
              setActivityTab(value)
              writeEnforcementPointFilter(value)
            }}
            variant="tabs"
            includeAll={false}
            labelOverrides={{ ACCESS_GATEWAY: t(accessTier === "T2" ? "Secure Access Gateway" : "Access Gateway") }}
          />
        ) : null}
        <TabsContent value="usage">
          <div className="flex flex-col gap-5">
            <AiUsageDashboard tenantId={tenantId} />
            <details className="rounded-xl border p-4"><summary className="cursor-pointer font-medium">{t("Usage policies and limits")}</summary><div className="mt-4"><UsageGovernancePanel
              tenantId={tenantId}
              organizations={data.organizations}
              resources={data.resources}
              identity={data.identity}
            /></div></details>
          </div>
        </TabsContent>
        <TabsContent value="audit" className="flex flex-col gap-5">
      <RecordFilterBar
        query={auditQueryCorrelationId}
        onQueryChange={setAuditQueryCorrelationId}
        searchPlaceholder={t("Search audit by correlation ID")}
        filters={[{
          id: "audit-outcome",
          label: t("Outcome"),
          allLabel: t("All Outcomes"),
          value: auditQueryOutcome || "ALL",
          options: (["COMPLETED", "REQUEST", "DENY", "BLOCKED", "ACTIVE", "REVOKED"] as const)
            .map((outcome) => ({ label: t(outcome), value: outcome })),
          onValueChange: (value) => setAuditQueryOutcome(value === "ALL" ? "" : value),
        }]}
      >
        <EnforcementPointFilter
          value={auditEnforcementPoint}
          onValueChange={(value) => {
            setAuditEnforcementPoint(value)
            writeEnforcementPointFilter(value)
            setServerAuditQuery(null)
            setAuditQueryOffset(0)
          }}
          testId="audit-enforcement-point-filter"
        />
      </RecordFilterBar>
      <Card data-testid="audit-export-panel">
        <CardHeader className="border-b">
          <CardTitle><TitleHelp help={t("Export traceable decisions for one Resource and a specified period. The artifact includes Policy Version and Decision Correlation ID.")}>{t("Audit Export")}</TitleHelp></CardTitle>
        </CardHeader>
        <CardContent className="pt-5">
          <FieldGroup className="grid gap-4 md:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="audit-export-from">{t("From")}</FieldLabel>
              <Input id="audit-export-from" type="date" value={auditFrom} onChange={(event) => setAuditFrom(event.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="audit-export-to">{t("To")}</FieldLabel>
              <Input id="audit-export-to" type="date" value={auditTo} onChange={(event) => setAuditTo(event.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="audit-export-resource">{t("Resource")}</FieldLabel>
              <SearchableSelect
                id="audit-export-resource"
                value={auditResourceId}
                options={auditResourceOptions}
                onValueChange={setAuditResourceId}
                placeholder={t("Select Resource")}
                searchPlaceholder={t("Search Resources")}
                emptyLabel={t("No Resources found.")}
              />
            </Field>
          </FieldGroup>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button variant="outline" onClick={useLoadedAuditRange} disabled={![...executionAuditEvents, ...data.apiActivity.events].some((event) => event.resource_id === auditResourceId)}>
              {t("Use loaded activity range")}
            </Button>
            <Button disabled={auditExportBusy || !auditFrom || !auditTo || !auditResourceId || auditFrom > auditTo} onClick={() => void downloadAuditExport()}>
              {auditExportBusy ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" /> : <DownloadIcon data-icon="inline-start" />}
              {t("Export Audit JSON")}
            </Button>
            {auditExportResult ? (
              <p className="text-sm" role="status" data-testid="audit-export-success">
                {t("Downloaded {{count}} traceable records for {{resource}}.", { count: auditExportResult.record_count, resource: auditExportResult.resource_id })}
                {` ${t("Export range: {{from}} to {{to}}.", { from: auditExportResult.from, to: auditExportResult.to })}`}
                {(() => {
                  const provenance = auditExportResult.records.find((record) => record.policy_version && record.decision_correlation_id)
                  return provenance
                    ? ` ${t("Verified Policy Version {{policy}} and Decision Correlation ID {{correlation}}.", { policy: provenance.policy_version, correlation: provenance.decision_correlation_id })}`
                    : ""
                })()}
              </p>
            ) : null}
            {auditExportError ? <p className="text-sm text-destructive" role="alert">{t(auditExportError)}</p> : null}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="border-b">
          <CardTitle><TitleHelp help={t("Query tenant-scoped Audit Events with bounded server-side filters and pagination. The result keeps Resource, Subject, Outcome, time range, offset, and limit visible.")}>{t("Server-side Audit query")}</TitleHelp></CardTitle>
        </CardHeader>
        <CardContent className="pt-5">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Field>
              <FieldLabel htmlFor="audit-query-resource">{t("Resource")}</FieldLabel>
              <SearchableSelect
                id="audit-query-resource"
                value={auditQueryResourceId || "ALL"}
                options={auditQueryResourceOptions}
                onValueChange={(value) => setAuditQueryResourceId(value === "ALL" ? "" : value)}
                placeholder={t("All Resources")}
                searchPlaceholder={t("Search Resources")}
                emptyLabel={t("No Resources found.")}
                ariaLabel={t("Audit query Resource")}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="audit-query-subject">{t("Subject ID")}</FieldLabel>
              <SearchableSelect
                id="audit-query-subject"
                value={auditQuerySubjectId || "ALL"}
                options={auditSubjectOptions}
                onValueChange={(value) => setAuditQuerySubjectId(value === "ALL" ? "" : value)}
                placeholder={t("All Subjects")}
                searchPlaceholder={t("Search Subjects")}
                emptyLabel={t("No Subjects found")}
              />
            </Field>
          </div>
          <details className="group mt-4 rounded-lg border bg-muted/10" data-testid="audit-query-advanced-filters">
            <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium">{t("Advanced filters")}</summary>
            <FieldGroup className="grid gap-4 border-t p-4 md:grid-cols-3">
              <Field>
                <FieldLabel htmlFor="audit-query-from">{t("From")}</FieldLabel>
                <Input id="audit-query-from" type="date" value={auditQueryFrom} onChange={(event) => setAuditQueryFrom(event.target.value)} />
              </Field>
              <Field>
                <FieldLabel htmlFor="audit-query-to">{t("To")}</FieldLabel>
                <Input id="audit-query-to" type="date" value={auditQueryTo} onChange={(event) => setAuditQueryTo(event.target.value)} />
              </Field>
              <Field>
                <FieldLabel htmlFor="audit-query-limit">{t("Page size")}</FieldLabel>
                <select id="audit-query-limit" className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm" value={auditQueryLimit} onChange={(event) => { setAuditQueryLimit(Number(event.target.value)); setAuditQueryOffset(0) }}>
                  {[25, 50, 100].map((limit) => <option key={limit} value={limit}>{limit}</option>)}
                </select>
              </Field>
            </FieldGroup>
          </details>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button disabled={auditQueryBusy} onClick={() => void runAuditQuery(0)}>
              {auditQueryBusy ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" /> : null}
              {t("Query Audit Events")}
            </Button>
            <Button variant="outline" disabled={auditQueryBusy || serverAuditEvents === null || auditQueryOffset === 0} onClick={() => void runAuditQuery(Math.max(0, auditQueryOffset - auditQueryLimit))}>
              {t("Previous page")}
            </Button>
            <Button variant="outline" disabled={auditQueryBusy || serverAuditQuery === null || !serverAuditQuery.coverage.has_more} onClick={() => void runAuditQuery(auditQueryOffset + auditQueryLimit)}>
              {t("Next page")}
            </Button>
            <Button variant="ghost" disabled={auditQueryBusy || serverAuditEvents === null} onClick={clearAuditQuery}>{t("Clear query")}</Button>
            {serverAuditQuery ? (
              <div className="text-sm" role="status" data-testid="audit-query-status">
                <p>{t("Tenant-scoped server query returned {{count}} records · offset {{offset}} · limit {{limit}}.", { count: serverAuditQuery.coverage.returned_count, offset: serverAuditQuery.offset, limit: serverAuditQuery.limit })}</p>
                <p>{t("Source revision {{revision}}.", { revision: serverAuditQuery.source_revision })}</p>
                <p>{t("Freshness as of {{asOf}}; latest event {{latest}}.", { asOf: relativeTime(serverAuditQuery.freshness.as_of), latest: serverAuditQuery.freshness.latest_event_at === null ? "—" : relativeTime(serverAuditQuery.freshness.latest_event_at) })}</p>
                <p>{t("Coverage returned {{returned}} records; requested range {{from}} to {{to}}; more pages {{hasMore}}.", { returned: serverAuditQuery.coverage.returned_count, from: serverAuditQuery.coverage.requested_from ?? "—", to: serverAuditQuery.coverage.requested_to ?? "—", hasMore: t(serverAuditQuery.coverage.has_more ? "Yes" : "No") })}</p>
              </div>
            ) : null}
            {auditQueryError ? <p className="text-sm text-destructive" role="alert">{t(auditQueryError)}</p> : null}
            {serverAuditEvents?.length ? <AuditQueryTable events={serverAuditEvents} onOpen={(event) => void openAuditEvent(event)} /> : null}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="border-b">
          <CardTitle><TitleHelp help={t("Open a correlated decision to inspect identity evidence, policy version, winning rule, route, obligations, and enforcement outcome.")}>{t("Policy Decisions")}</TitleHelp></CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          {decisions.length ? (
            <DataTable
              columns={policyDecisionColumns}
              data={decisions}
              filters={[{
                columnId: "outcome",
                label: t("Outcome"),
                allLabel: t("All Outcomes"),
                options: [...new Set(decisions.map((event) => event.outcome))].map((outcome) => ({ label: t(outcome), value: outcome })),
              }]}
              getRowId={(event) => event.audit_event_id}
              getRowLabel={() => t("View details")}
              getRowTestId={(event) => `audit-decision-row-${event.audit_event_id}`}
              noResults={<DataEmpty icon={ShieldCheckIcon} title={t("No matching policy decisions")} description={t("Try another outcome or search term.")} />}
              onRowClick={(event) => void openAuditEvent(event)}
              pageSize={10}
              searchPlaceholder={t("Search policy decisions")}
            />
          ) : (
            <DataEmpty icon={ShieldCheckIcon} title={t("No Policy Decisions")} description={t("Correlated ALLOW, REQUEST, DENY, DIRECT, MANAGED, and BLOCK decisions will appear here.")} />
          )}
        </CardContent>
      </Card>
        </TabsContent>
        <TabsContent value="API_GATEWAY">
      <Card>
        <CardHeader className="border-b">
          <CardTitle><TitleHelp help={t("Normalized Gravitee request outcomes correlated to GenioOne Resources, Applications, Capabilities, and Entitlements.")}>{t("API Gateway activity")}</TitleHelp></CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          {apiActivities.length ? (
            <DataTable
              columns={apiActivityColumns}
              data={apiActivities}
              filters={[{
                allLabel: t("All outcomes"),
                columnId: "outcome",
                label: t("Outcome"),
                options: [...new Set(apiActivities.map((event) => event.outcome))]
                  .map((outcome) => ({ label: t(outcome), value: outcome })),
              }, {
                allLabel: t("All traffic paths"),
                columnId: "trafficPath",
                label: t("Traffic path"),
                options: (["MANAGED_RESOURCE", "BLOCK"] as const)
                  .map((path) => ({ label: t(trafficPathLabels[path]), value: path })),
              }]}
              getRowId={(event) => event.correlation_id}
              getRowLabel={(event) => t("Open transaction {{id}}", { id: event.correlation_id })}
              getRowTestId={(event) => `api-gateway-activity-row-${event.correlation_id}`}
              initialFilterValues={{
                outcome: new URLSearchParams(window.location.search).get("outcome") ?? "",
                trafficPath: new URLSearchParams(window.location.search).get("traffic") ?? "",
              }}
              initialGlobalFilter={new URLSearchParams(window.location.search).get("table_q") ?? ""}
              noResults={<DataEmpty icon={ServerIcon} title={t("No matching API activity")} description={t("Try another outcome or search term.")} />}
              onFilterStateChange={updateActivityFilters}
              onRowClick={openApiActivity}
              pageSize={10}
              searchPlaceholder={t("Search API activity")}
            />
          ) : (
            <DataEmpty
              icon={ServerIcon}
              title={search ? t("No matching API activity") : t("No API Gateway activity")}
              description={t("Published API traffic will appear after the bundled API Gateway reports it.")}
            />
          )}
        </CardContent>
      </Card>
        </TabsContent>
        <TabsContent value="AI_GATEWAY">
          {aiRequestActivities.length ? (
            <Card>
              <CardHeader className="border-b">
                <CardTitle><TitleHelp help={t("LLM and MCP invocation outcomes reported by AI Gateway.")}>{t("AI Gateway activity")}</TitleHelp></CardTitle>
              </CardHeader>
              <CardContent className="px-0">
                <DataTable
                  columns={apiActivityColumns}
                  data={aiRequestActivities}
                  filters={[{
                    allLabel: t("All outcomes"),
                    columnId: "outcome",
                    label: t("Outcome"),
                    options: [...new Set(aiRequestActivities.map((event) => event.outcome))]
                      .map((outcome) => ({ label: t(outcome), value: outcome })),
                  }]}
                  getRowId={(event) => event.correlation_id}
                  getRowTestId={(event) => `ai-gateway-activity-row-${event.correlation_id}`}
                  onRowClick={openApiActivity}
                  noResults={<DataEmpty icon={BotIcon} title={t("No matching AI Gateway activity")} description={t("Try another outcome or search term.")} />}
                  pageSize={10}
                  searchPlaceholder={t("Search AI Gateway activity")}
                />
              </CardContent>
            </Card>
          ) : (
            <GovernedGatewayActivityTable
              events={aiGatewayActivities}
              resources={data.resources}
              lane="ai"
              accessTier={accessTier}
              search={search}
              onOpen={(event) => { void openAuditEvent(event) }}
            />
          )}
        </TabsContent>
        <TabsContent value="ACCESS_GATEWAY">
          <GovernedGatewayActivityTable
            events={accessGatewayActivities}
            resources={data.resources}
            lane="access"
            accessTier={accessTier}
            search={search}
            onOpen={(event) => { void openAuditEvent(event) }}
          />
        </TabsContent>
        <TabsContent value="ENDPOINT" className="flex flex-col gap-5">
      <Card>
        <CardHeader className="border-b">
          <CardTitle><TitleHelp help={t("Unclassified AI and SaaS destinations reported by verified Endpoints.")}>{t("Discovered Resources")}</TitleHelp></CardTitle>
          {discoveries.length ? (
            <CardAction>
              <Button
                disabled={!selectedDiscoveries.length}
                onClick={() => setClassificationOpen(true)}
              >
                {t("Classify selected Resources")} ({selectedDiscoveries.length})
              </Button>
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent className="px-0">
          {discoveries.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12"><span className="sr-only">{t("Select")}</span></TableHead>
                  <TableHead>{t("Destination")}</TableHead>
                  <TableHead>{t("Subjects")}</TableHead>
                  <TableHead>{t("Devices")}</TableHead>
                  <TableHead>{t("Routes")}</TableHead>
                  <TableHead>{t("Requests")}</TableHead>
                  <TableHead className="text-right">{t("Last seen")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {discoveries.map((resource) => {
                  const checked = selectedDiscoveries.includes(resource.resource_id)
                  return (
                    <TableRow key={resource.resource_id} data-state={checked ? "selected" : undefined}>
                      <TableCell>
                        <Checkbox
                          aria-label={t("Select {{resource}}", { resource: resource.destination_hosts[0] ?? resource.resource_id })}
                          checked={checked}
                          onCheckedChange={(nextChecked) => {
                            setSelectedDiscoveries((current) =>
                              nextChecked === true
                                ? [...current, resource.resource_id]
                                : current.filter((id) => id !== resource.resource_id),
                            )
                          }}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{resource.destination_hosts[0] ?? resource.resource_id}</div>
                        <div className="text-xs text-muted-foreground">{t("Unclassified")}</div>
                      </TableCell>
                      <TableCell>{resource.subjects.length}</TableCell>
                      <TableCell>{resource.devices.length}</TableCell>
                      <TableCell className="space-x-1">
                        {resource.routes.map((route) => <RouteBadge key={route} route={route} />)}
                      </TableCell>
                      <TableCell>{resource.request_count}</TableCell>
                      <TableCell className="text-right text-muted-foreground">{relativeTime(resource.last_seen_at)}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          ) : (
            <DataEmpty
              icon={ShieldCheckIcon}
              title={t("No unclassified Resources")}
              description={t("New Endpoint discoveries requiring governance will appear here.")}
            />
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="border-b">
          <CardTitle><TitleHelp help={t("Prompt and response bodies are not part of this inventory.")}>{t("Endpoint activity")}</TitleHelp></CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          {activities.length ? (
            <DataTable
              columns={endpointActivityColumns}
              data={activities}
              filters={[
                {
                  allLabel: t("All traffic paths"),
                  columnId: "trafficPath",
                  label: t("Traffic path"),
                  options: (["DIRECT", "SECURE_ACCESS", "BLOCK"] as const)
                    .map((path) => ({ label: t(trafficPathLabels[path]), value: path })),
                },
                {
                  allLabel: t("All activity types"),
                  columnId: "kind",
                  label: t("Kind"),
                  options: [...new Set(data.activity.recent_activity.map((activity) => activity.kind))]
                    .map((kind) => ({ label: t(kind), value: kind })),
                },
              ]}
              getRowId={(activity) => activity.activity_id}
              getRowTestId={(activity) => `endpoint-activity-row-${activity.activity_id}`}
              noResults={<DataEmpty icon={ActivityIcon} title={t("No matching activity")} description={t("Try another traffic path, activity type, or search term.")} />}
              pageSize={10}
              searchPlaceholder={t("Search Endpoint activity")}
            />
          ) : (
            <DataEmpty
              icon={ActivityIcon}
              title={search ? t("No matching activity") : t("No Endpoint activity")}
              description={t("Codex, Grok, and other verified Acting Clients appear after Endpoint reporting.")}
            />
          )}
        </CardContent>
      </Card>
        </TabsContent>
      </Tabs>
      <ClassifyDiscoveriesSheet
        tenantId={tenantId}
        discoveries={data.activity.resources.filter((resource) =>
          selectedDiscoveries.includes(resource.resource_id),
        )}
        open={classificationOpen}
        onOpenChange={setClassificationOpen}
        onClassified={async () => {
          await onRefresh()
          setSelectedDiscoveries([])
        }}
      />
      <AuditDecisionSheet
        event={selectedAuditEvent}
        data={data}
        executionActivity={selectedAuditEvent ? activityByCorrelation.get(selectedAuditEvent.correlation_id) ?? null : null}
        accounting={selectedAuditAccounting}
        accessRequest={selectedAuditAccessRequest}
        open={Boolean(selectedAuditEvent)}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedAuditEvent(null)
            setSelectedAuditAccounting(null)
            setSelectedAuditAccessRequest(null)
          }
        }}
      />
      <ApiGatewayTransactionSheet
        tenantId={tenantId}
        event={selectedApiActivity}
        auditEvent={selectedApiActivity ? auditByCorrelation.get(selectedApiActivity.correlation_id) ?? null : null}
        data={data}
        open={Boolean(selectedApiActivity)}
        onOpenChange={(open) => {
          if (open) return
          setSelectedApiActivity(null)
          const url = new URL(window.location.href)
          url.searchParams.delete("record")
          window.history.replaceState({}, "", url)
        }}
      />
    </div>
  )
}
