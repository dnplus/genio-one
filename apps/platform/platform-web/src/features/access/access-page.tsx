import { RelationValue } from "@/components/relation-value"
import { PageHeader } from "@/components/page-header"
import { managementRelationHref } from "@/features/sections/section-chrome"
import { } from "@tanstack/react-table"
import {
  KeyRoundIcon,
  ShieldCheckIcon,
} from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

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
import type { AccessRequest, Entitlement, OverviewSnapshot } from "@/domain/contracts"
import { } from "@/features/provider-credentials/provider-credential-profiles-panel"
import { AccessRequestSheet } from "@/features/access/access-request-sheet"
import { GrantEntitlementSheet } from "@/features/access/grant-entitlement-sheet"
import { ExecutionGrantRequestsCard } from "@/features/access/execution-grant-requests-card"
import { RevokeEntitlementSheet } from "@/features/access/revoke-entitlement-sheet"
import { } from "@/features/activity/audit-decision-sheet"
import { } from "@/features/activity/ai-usage-dashboard"
import { } from "@/features/activity/usage-governance-panel"
import { } from "@/features/activity/activity-evidence"
import { createActivityDisplayDirectory } from "@/features/activity/activity-display"
import { } from "@/features/activity/api-gateway-transaction-sheet"
import { } from "@/features/activity/classify-discoveries-sheet"
import { AccessUpdates } from "@/features/self-service/access-lifecycle"
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
import { formatEpochSeconds } from "@/lib/personal-preferences"
import { loadResources } from "@/lib/product-api"

export function AccessPage({
  tenantId,
  data,
  onRefresh,
}: {
  tenantId: string
  data: OverviewSnapshot
  onRefresh: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<AccessRequest | null>(null)
  const [selectedEntitlement, setSelectedEntitlement] = useState<Entitlement | null>(null)
  const display = useMemo(() => createActivityDisplayDirectory(data), [data])
  const loadResourceInventory = useCallback(() => loadResources(tenantId), [tenantId])

  function subjectHref(subjectId: string, kind: string) {
    if (kind === "Agent") return managementRelationHref("agents", { q: subjectId })
    if (kind === "Application") return managementRelationHref("applications", { q: subjectId })
    return managementRelationHref("people", { q: subjectId })
  }

  function relation(id: string, onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void) {
    const resource = display.resource(id)
    return {
      label: resource.resolved ? resource.label : id,
      href: resource.resolved ? managementRelationHref("resources", { resource: id }) : undefined,
      onClick,
    }
  }

  function capabilityRelation(resourceId: string, capabilityId: string, onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void) {
    const capability = display.capability(resourceId, capabilityId)
    return {
      label: capability.resolved ? capability.label : capabilityId,
      href: capability.resolved ? managementRelationHref("resources", { resource: resourceId }, "resource-capabilities") : undefined,
      onClick,
    }
  }

  function subjectRelation(subjectId: string, onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void) {
    const subject = display.subject(subjectId)
    return {
      label: subject.resolved ? subject.label : subjectId,
      href: subject.resolved ? subjectHref(subjectId, subject.kind) : undefined,
      onClick,
    }
  }

  function applicationRelation(applicationId: string, onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void) {
    const application = display.application(applicationId)
    return {
      label: application.resolved ? application.label : applicationId,
      href: application.resolved ? managementRelationHref("applications", { q: applicationId }) : undefined,
      onClick,
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t("Access")}
        description={t("Requests are approval history. Entitlements are the currently effective grants. An approved Request is not by itself Active access.")}
        actions={<GrantEntitlementSheet tenantId={tenantId} identity={data.identity} loadResources={loadResourceInventory} onGranted={onRefresh} />}
      />
      <AccessUpdates
        display={{
          capability: (resourceId, capabilityId) => ({ resource: display.resource(resourceId).label, capability: display.capability(resourceId, capabilityId).label }),
          subject: (id) => display.subject(id).label,
          application: (id) => display.application(id).label,
          organization: (id) => data.organizations.find((organization) => organization.organization_id === id)?.display_name ?? t("Unresolved reference"),
        }}
        requests={data.accessRequests}
        notifications={data.accessNotifications}
        apiVersionMigrationNotices={data.apiVersionMigrationNotices}
        onSelectRequest={setSelected}
      />
      <ExecutionGrantRequestsCard data={data} tenantId={tenantId} requests={data.executionGrantRequests} onChanged={onRefresh} />
      <Card data-testid="access-entitlements">
        <CardHeader className="border-b">
          <CardTitle><TitleHelp help={t("Active grants only appear here as Active. Expired and revoked grants stay for audit and are not current access.")}>{t("Entitlement inventory")}</TitleHelp></CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          {data.ownedEntitlements.length ? (
            <Table>
              <TableHeader><TableRow><TableHead>{t("Target Subject")}</TableHead><TableHead>{t("Resource / Capability")}</TableHead><TableHead>{t("State")}</TableHead><TableHead>{t("Related Request")}</TableHead><TableHead>{t("Valid until")}</TableHead><TableHead className="text-right">{t("Action")}</TableHead></TableRow></TableHeader>
              <TableBody>{data.ownedEntitlements.map((entitlement) => {
                const relatedRequest = data.accessRequests.find(
                  (request) =>
                    request.target_subject === entitlement.subject_id
                    && request.resource_id === entitlement.resource_id
                    && request.capability_id === entitlement.capability_id,
                )
                const resource = relation(entitlement.resource_id)
                const capability = capabilityRelation(entitlement.resource_id, entitlement.capability_id)
                const targetSubject = subjectRelation(entitlement.subject_id)
                const requester = relatedRequest ? subjectRelation(relatedRequest.requester) : null
                return (
                <TableRow id={`entitlement-${entitlement.entitlement_id}`} key={entitlement.entitlement_id} data-testid={`entitlement-row-${entitlement.entitlement_id}`}>
                  <TableCell className="font-medium">
                    <RelationValue id={entitlement.subject_id} {...targetSubject} />
                    {relatedRequest && relatedRequest.requester !== relatedRequest.target_subject ? (
                      <div className="mt-1 text-xs text-muted-foreground"><span>{t("Requester")}: </span><RelationValue id={relatedRequest.requester} {...requester!} /></div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <RelationValue id={entitlement.resource_id} {...resource} />
                    <div className="mt-2"><RelationValue id={entitlement.capability_id} {...capability} /></div>
                    <a className="mt-2 block max-w-64 text-xs text-primary underline-offset-4 hover:underline" href={`#entitlement-${entitlement.entitlement_id}`} title={entitlement.entitlement_id}>
                      <span className="block">{t("Entitlement")} · {t(entitlement.state)}</span>
                      <span className="block truncate font-mono text-muted-foreground">{entitlement.entitlement_id}</span>
                    </a>
                  </TableCell>
                  <TableCell><Badge variant={entitlement.state === "ACTIVE" ? "secondary" : "outline"} data-testid={`entitlement-state-${entitlement.entitlement_id}`}>{t(entitlement.state)}</Badge></TableCell>
                  <TableCell>
                    {relatedRequest ? (
                      <Button type="button" size="sm" variant="ghost" onClick={() => setSelected(relatedRequest)}>
                        {relatedRequest.state}
                      </Button>
                    ) : <span className="text-xs text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell>{formatEpochSeconds(entitlement.valid_until)}</TableCell>
                  <TableCell className="text-right"><Button size="sm" variant="destructive" disabled={entitlement.state !== "ACTIVE"} onClick={() => setSelectedEntitlement(entitlement)}>{t("Revoke")}</Button></TableCell>
                </TableRow>
                )
              })}</TableBody>
            </Table>
          ) : (
            <DataEmpty icon={ShieldCheckIcon} title={t("No Entitlements")} description={t("Active and historical Entitlements for capabilities you own will appear here.")} />
          )}
        </CardContent>
      </Card>
      <Card data-testid="access-requests">
        <CardHeader className="border-b">
          <CardTitle><TitleHelp help={t("Approval status, Requester, Target Subject, and Acting Client. History remains after the Entitlement expires or is revoked.")}>{t("Request inventory")}</TitleHelp></CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          {data.accessRequests.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Target Subject")}</TableHead>
                  <TableHead>{t("Requester")}</TableHead>
                  <TableHead>{t("Acting Client")}</TableHead>
                  <TableHead>{t("Resource / Capability")}</TableHead>
                  <TableHead>{t("Approver")}</TableHead>
                  <TableHead>{t("State")}</TableHead>
                  <TableHead className="text-right">{t("Created")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.accessRequests.map((request) => {
                  const targetSubject = subjectRelation(request.target_subject, (event) => event.stopPropagation())
                  const requester = subjectRelation(request.requester, (event) => event.stopPropagation())
                  const actingClient = applicationRelation(request.acting_client.acting_client_id ?? "", (event) => event.stopPropagation())
                  const resource = relation(request.resource_id, (event) => event.stopPropagation())
                  const capability = capabilityRelation(request.resource_id, request.capability_id, (event) => event.stopPropagation())
                  const approvingOrganization = data.organizations.find((organization) => organization.organization_id === request.approver)
                  const approver = approvingOrganization ? { label: approvingOrganization.display_name } : subjectRelation(request.approver, (event) => event.stopPropagation())
                  return (
                <TableRow
                  key={request.access_request_id}
                  id={`access-request-${request.access_request_id}`}
                  aria-label={t("View details")}
                  className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  data-testid={`access-request-row-${request.access_request_id}`}
                  onClick={() => setSelected(request)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      setSelected(request)
                    }
                  }}
                  tabIndex={0}
                >
                    <TableCell className="font-medium"><RelationValue id={request.target_subject} {...targetSubject} /></TableCell>
                    <TableCell><RelationValue id={request.requester} {...requester} /></TableCell>
                    <TableCell>{request.acting_client.acting_client_id ? <RelationValue id={request.acting_client.acting_client_id} {...actingClient} /> : t("Unknown")}</TableCell>
                    <TableCell>
                      <RelationValue id={request.resource_id} {...resource} />
                      <div className="mt-2"><RelationValue id={request.capability_id} {...capability} /></div>
                    </TableCell>
                    <TableCell><RelationValue id={request.approver} {...approver} /></TableCell>
                    <TableCell>
                      <Badge variant={request.state === "DENIED" ? "destructive" : "secondary"}>
                        {request.state}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {relativeTime(request.created_at)}
                    </TableCell>
                  </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          ) : (
            <DataEmpty
              icon={KeyRoundIcon}
              title={t("No Access Requests")}
              description={t("Requests from Self-service and approved third-party clients will appear here.")}
            />
          )}
        </CardContent>
      </Card>
      <AccessRequestSheet
        data={data}
        tenantId={tenantId}
        request={selected}
        open={Boolean(selected)}
        onOpenChange={(open) => { if (!open) setSelected(null) }}
        onDecided={onRefresh}
      />
      <RevokeEntitlementSheet
        data={data}
        tenantId={tenantId}
        entitlement={selectedEntitlement}
        open={Boolean(selectedEntitlement)}
        onOpenChange={(open) => { if (!open) setSelectedEntitlement(null) }}
        onRevoked={onRefresh}
      />
    </div>
  )
}

