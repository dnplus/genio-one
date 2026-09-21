import { AlertTriangleIcon, ArrowRightIcon, KeyRoundIcon, MonitorXIcon, ShieldAlertIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import type { PageId } from "@/components/app-sidebar"
import { TitleHelp } from "@/components/title-help"
import { Badge } from "@/components/ui/badge"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import type { OverviewSnapshot } from "@/domain/contracts"
import { isDecisionAuditEvent } from "@/domain/audit-events"

type AttentionItem = {
  id: string
  title: string
  detail: string
  count: number
  severity: "critical" | "warning"
  icon: typeof AlertTriangleIcon
  page: PageId
  filter?: string
}

export function buildAttentionItems(data: OverviewSnapshot): AttentionItem[] {
  const unhealthyGateways = data.runtimes.filter((runtime) => runtime.runtime_kind === "GATEWAY" && (runtime.operator_state !== "READY" || !runtime.release_eligible)).length
  const offlineEndpoints = data.runtimes.filter((runtime) => runtime.runtime_kind === "ENDPOINT" && runtime.operator_state === "OFFLINE").length
  const pendingAccess = data.accessRequests.filter((request) => request.state === "PENDING").length
  const missingCapabilities = new Set(data.auditEvents.filter(isDecisionAuditEvent).flatMap((event) => event.missing_deployment_capability ? [event.missing_deployment_capability] : []))
  return [
    ...data.failures.map((failure) => ({
      id: `failure-${failure.source}`,
      title: failure.source,
      detail: failure.code,
      count: 1,
      severity: "critical" as const,
      icon: AlertTriangleIcon,
      page: "activity" as const,
      filter: failure.code,
    })),
    ...(missingCapabilities.size ? [{ id: "missing-capability", title: "Missing deployment capability", detail: [...missingCapabilities].join(", "), count: missingCapabilities.size, severity: "critical" as const, icon: ShieldAlertIcon, page: "runtimes" as const }] : []),
    ...(unhealthyGateways ? [{ id: "unhealthy-gateways", title: "Gateway requires attention", detail: "Inspect runtime reports and release readiness", count: unhealthyGateways, severity: "warning" as const, icon: MonitorXIcon, page: "runtimes" as const, filter: "GATEWAY" }] : []),
    ...(offlineEndpoints ? [{ id: "offline-endpoints", title: "Endpoint offline", detail: "Device connection state requires attention", count: offlineEndpoints, severity: "warning" as const, icon: MonitorXIcon, page: "runtimes" as const, filter: "OFFLINE" }] : []),
    ...(pendingAccess ? [{ id: "pending-access", title: "Pending Access Requests", detail: "Awaiting a Resource Owner decision", count: pendingAccess, severity: "warning" as const, icon: KeyRoundIcon, page: "access" as const, filter: "PENDING" }] : []),
  ].slice(0, 5)
}

export function AttentionList({
  data,
  onOpenList,
  className,
}: {
  data: OverviewSnapshot
  onOpenList: (page: PageId, filter?: string) => void
  className?: string
}) {
  const { t } = useTranslation()
  const items = buildAttentionItems(data)

  return (
    <Card className={className} data-testid="overview-attention-list">
      <CardHeader>
        <div>
          <CardTitle><TitleHelp help={t("Only issues that affect governance or traffic.")}>{t("Needs attention")}</TitleHelp></CardTitle>
        </div>
        <CardAction><Badge variant={items.length ? "destructive" : "secondary"}>{items.length}</Badge></CardAction>
      </CardHeader>
      <CardContent>
        {items.length ? (
          <ItemGroup className="gap-1">
            {items.map((item) => {
              const Icon = item.icon
              return (
                <Item asChild key={item.id} size="sm">
                  <button type="button" onClick={() => onOpenList(item.page, item.filter)}>
                    <ItemMedia variant="icon"><Icon /></ItemMedia>
                    <ItemContent>
                      <ItemTitle>{t(item.title)}</ItemTitle>
                      <ItemDescription>{t(item.detail)}</ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Badge variant={item.severity === "critical" ? "destructive" : "outline"}>{item.count}</Badge>
                      <ArrowRightIcon />
                    </ItemActions>
                  </button>
                </Item>
              )
            })}
          </ItemGroup>
        ) : (
          <Item variant="muted">
            <ItemMedia variant="icon"><ShieldAlertIcon /></ItemMedia>
            <ItemContent><ItemTitle>{t("No immediate action")}</ItemTitle><ItemDescription>{t("No outstanding issues were found in the available reports.")}</ItemDescription></ItemContent>
          </Item>
        )}
      </CardContent>
    </Card>
  )
}
