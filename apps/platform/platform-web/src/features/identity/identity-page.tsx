import { } from "@/components/relation-value"
import { PageHeader } from "@/components/page-header"
import { } from "@tanstack/react-table"
import {
  BotIcon,
  IdCardIcon,
} from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"

import { } from "@/components/data-table/data-table"
import { } from "@/components/data-table/record-filter-bar"
import { DataEmpty } from "@/components/data-empty"
import { } from "@/components/ui/searchable-select"
import { } from "@/components/route-badge"
import { } from "@/components/title-help"
import { Badge } from "@/components/ui/badge"
import { } from "@/components/ui/button"
import { } from "@/components/ui/checkbox"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { } from "@/components/ui/input"
import { } from "@/components/ui/textarea"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { IdentitySession, OverviewSnapshot } from "@/domain/contracts"
import { } from "@/features/provider-credentials/provider-credential-profiles-panel"
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
import { RegisterAgentSheet } from "@/features/identity/register-agent-sheet"
import { AgentDelegationsCard } from "@/features/identity/agent-delegations-card"
import { IdentityProvidersCard } from "@/features/identity/identity-providers-card"
import { AccessGroupsPanel } from "@/features/identity/access-groups-panel"
import { SuspendPersonAction } from "@/features/identity/suspend-person-action"
import { } from "@/domain/organization-roles"
import { relativeTime } from "@/lib/format"
import { } from "@/lib/personal-preferences"

export function IdentityPage({
  tenantId,
  identity,
  data,
  mode,
  onRefresh,
}: {
  tenantId: string
  identity: IdentitySession | null
  data: OverviewSnapshot
  mode: "people" | "agents"
  onRefresh: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [agentClassification, setAgentClassification] = useState<"ALL" | "REGISTERED" | "OBSERVED" | "UNKNOWN">("ALL")
  const people = data.identity?.subjects.filter((subject) => subject.kind === "PERSON") ?? []

  if (mode === "agents") {
    const knownAgents = new Map(
      (data.identity?.subjects ?? [])
        .filter((subject) => subject.kind === "AGENT")
        .map((subject) => [subject.subject_id, subject] as const),
    )
    const agents = new Map<string, {
      actingClientId: string | null
      displayName: string | null
      classification: "REGISTERED" | "OBSERVED" | "UNKNOWN"
      evidence: Set<"REGISTERED" | "VERIFIED" | "UNKNOWN">
      sources: Set<"Identity registry" | "Endpoint">
      requestCount: number
      lastObservedAt: number | null
    }>()

    knownAgents.forEach((agent) => agents.set(agent.subject_id, {
      actingClientId: agent.subject_id,
      displayName: agent.profile.display_name ?? null,
      classification: "REGISTERED",
      evidence: new Set(["REGISTERED"]),
      sources: new Set(["Identity registry"]),
      requestCount: 0,
      lastObservedAt: null,
    }))

    function recordObservedClient({
      actingClientId,
      evidence,
      source,
      requestCount,
      observedAt,
    }: {
      actingClientId: string | null
      evidence: "VERIFIED" | "UNKNOWN"
      source: "Endpoint"
      requestCount: number
      observedAt: number
    }) {
      const key = actingClientId ?? "__unknown__"
      const existing = agents.get(key)
      if (existing) {
        existing.evidence.add(evidence)
        existing.sources.add(source)
        existing.requestCount += requestCount
        existing.lastObservedAt = Math.max(existing.lastObservedAt ?? 0, observedAt)
        return
      }
      const agent = actingClientId ? knownAgents.get(actingClientId) : undefined
      agents.set(key, {
        actingClientId,
        displayName: agent?.profile.display_name ?? null,
        classification: agent ? "REGISTERED" : actingClientId ? "OBSERVED" : "UNKNOWN",
        evidence: new Set([evidence]),
        sources: new Set([source]),
        requestCount,
        lastObservedAt: observedAt,
      })
    }

    data.activity.recent_activity.forEach((event) => recordObservedClient({
      actingClientId: event.client.status === "VERIFIED" ? event.client.acting_client_id : null,
      evidence: event.client.status,
      source: "Endpoint",
      requestCount: event.request_count,
      observedAt: event.observed_at,
    }))
    const rows = [...agents.values()].sort((left, right) => (right.lastObservedAt ?? 0) - (left.lastObservedAt ?? 0))
    const filteredRows = agentClassification === "ALL"
      ? rows
      : rows.filter((agent) => agent.classification === agentClassification)
    const classificationCounts = {
      ALL: rows.length,
      REGISTERED: rows.filter((agent) => agent.classification === "REGISTERED").length,
      OBSERVED: rows.filter((agent) => agent.classification === "OBSERVED").length,
      UNKNOWN: rows.filter((agent) => agent.classification === "UNKNOWN").length,
    }

    return (
      <div className="flex flex-col gap-5">
        <PageHeader
          title={t("Agents")}
          description={t("Registered Agent Subjects and Agent clients supported by verified Endpoint evidence.")}
          actions={<RegisterAgentSheet tenantId={tenantId} onCreated={onRefresh} />}
        />
        <Tabs value={agentClassification} onValueChange={(value) => setAgentClassification(value as typeof agentClassification)}>
          <Card>
            <CardHeader className="gap-4 border-b">
              <div>
                <CardTitle>{t("Agent inventory")}</CardTitle>
                <CardDescription>{t("API Gateway activity alone does not classify an acting client as an Agent.")}</CardDescription>
              </div>
              <TabsList className="w-fit max-w-full justify-start overflow-x-auto">
                {(["ALL", "REGISTERED", "OBSERVED", "UNKNOWN"] as const).map((classification) => (
                  <TabsTrigger key={classification} value={classification}>
                    {t(classification === "ALL" ? "All" : classification)}
                    <Badge variant="secondary" className="ml-1 tabular-nums">{classificationCounts[classification]}</Badge>
                  </TabsTrigger>
                ))}
              </TabsList>
            </CardHeader>
            <TabsContent value={agentClassification} className="mt-0">
              <CardContent className="px-0">
                {filteredRows.length ? <Table>
                  <TableHeader><TableRow><TableHead>{t("Agent / acting client")}</TableHead><TableHead>{t("Classification")}</TableHead><TableHead>{t("Evidence")}</TableHead><TableHead>{t("Source")}</TableHead><TableHead className="text-right">{t("Request count")}</TableHead><TableHead className="text-right">{t("Last observed")}</TableHead></TableRow></TableHeader>
                  <TableBody>{filteredRows.map((agent) => <TableRow key={agent.actingClientId ?? "unknown"}>
                    <TableCell><div className="font-medium">{agent.displayName ?? agent.actingClientId ?? t("Unknown")}</div>{agent.displayName && agent.actingClientId ? <div className="font-mono text-xs text-muted-foreground">{agent.actingClientId}</div> : null}</TableCell>
                    <TableCell><Badge variant={agent.classification === "REGISTERED" ? "secondary" : "outline"}>{t(agent.classification)}</Badge></TableCell>
                    <TableCell><div className="flex flex-wrap gap-1">{agent.evidence.size ? [...agent.evidence].map((evidence) => <Badge key={evidence} variant="outline">{t(evidence)}</Badge>) : "—"}</div></TableCell>
                    <TableCell>{agent.sources.size ? [...agent.sources].map((source) => t(source)).join(", ") : "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{agent.requestCount}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{agent.lastObservedAt ? relativeTime(agent.lastObservedAt) : "—"}</TableCell>
                  </TableRow>)}</TableBody>
                </Table> : <DataEmpty icon={BotIcon} title={t("No Agents in this classification")} description={t("Agent activity and registered identities will appear here when they match this classification.")} />}
              </CardContent>
            </TabsContent>
          </Card>
        </Tabs>
        <AgentDelegationsCard tenantId={tenantId} data={data} onChanged={onRefresh} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t("People")} description={t("Canonical Person identities synchronized from the configured identity provider.")} />
      <Card><CardContent className="py-5 text-sm">{t("Create or update People in your identity provider, then have them sign in to synchronize their verified identity. Assign organization membership and roles on the Organizations page.")} <a className="underline" href="/management?view=organization">{t("Organizations")}</a></CardContent></Card>
      <IdentityProvidersCard tenantId={tenantId} />
      {identity?.role === "TENANT_ADMINISTRATOR" || identity?.role === "ORGANIZATION_ADMINISTRATOR"
        ? <AccessGroupsPanel tenantId={tenantId} data={data} identity={identity} canManage onChanged={onRefresh} />
        : null}
      <Card>
        <CardHeader className="border-b"><CardTitle>{t("People")}</CardTitle></CardHeader>
        <CardContent className="px-0">
          {people.length ? <Table><TableHeader><TableRow><TableHead>{t("Display name")}</TableHead><TableHead>{t("Email")}</TableHead><TableHead>{t("Department")}</TableHead><TableHead>{t("Tenant Administrator")}</TableHead><TableHead>{t("Access")}</TableHead><TableHead className="text-right">{t("Actions")}</TableHead></TableRow></TableHeader><TableBody>{people.map((person) => <TableRow key={person.subject_id}><TableCell className="font-medium">{person.profile.display_name ?? "—"}</TableCell><TableCell>{person.profile.email ?? "—"}</TableCell><TableCell>{person.profile.department ?? "—"}</TableCell><TableCell>{data.identity?.tenant_administrators.includes(person.subject_id) ? <Badge variant="secondary">{t("Administrator")}</Badge> : "—"}</TableCell><TableCell>{person.suspended ? <div className="grid gap-1"><Badge variant="destructive">{t("Suspended")}</Badge>{person.suspension_reason ? <span className="text-xs text-muted-foreground">{person.suspension_reason}</span> : null}</div> : <Badge variant="outline">{t("Active")}</Badge>}</TableCell><TableCell className="text-right">{identity?.role === "TENANT_ADMINISTRATOR" ? <SuspendPersonAction tenantId={tenantId} person={person} isSelf={person.subject_id === identity.subject_id} onChanged={onRefresh} /> : null}</TableCell></TableRow>)}</TableBody></Table> : <DataEmpty icon={IdCardIcon} title={t("No People")} description={t("People appear after identity provider synchronization.")} />}
        </CardContent>
      </Card>
    </div>
  )
}
