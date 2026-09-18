import { } from "@/components/relation-value"
import { PageHeader } from "@/components/page-header"
import { } from "@tanstack/react-table"
import {
  ServerIcon,
} from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"

import { } from "@/components/data-table/data-table"
import { } from "@/components/data-table/record-filter-bar"
import { DataEmpty } from "@/components/data-empty"
import { } from "@/components/ui/searchable-select"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
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
import type { OverviewSnapshot } from "@/domain/contracts"
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
import { RegisterGatewaySheet } from "@/features/runtimes/register-gateway-sheet"
import { GatewayDiagnosticsSheet } from "@/features/runtimes/gateway-diagnostics-sheet"
import { } from "@/features/identity/create-organization-sheet"
import { } from "@/features/identity/manage-organization-sheet"
import { } from "@/features/identity/register-agent-sheet"
import { } from "@/features/identity/agent-delegations-card"
import { } from "@/features/identity/identity-providers-card"
import { } from "@/features/identity/suspend-person-action"
import { } from "@/domain/organization-roles"
import { relativeTime } from "@/lib/format"
import { } from "@/lib/personal-preferences"
import { runtimeConvergence, runtimeRemediation } from "@/lib/runtime-health"
import {
  rollbackGateways,
  retireGateway,
} from "@/lib/product-api"

export function RuntimesPage({
  tenantId,
  data,
  search,
  onRefresh,
}: {
  tenantId: string
  data: OverviewSnapshot
  search: string
  onRefresh: () => Promise<void>
}) {
  const { t } = useTranslation()
  const searchTerms = search.trim().toUpperCase().split(/\s+/).filter(Boolean)
  const filteredRuntimes = data.runtimes.filter((runtime) => {
    if (!searchTerms.length) return true
    const searchable = [
      runtime.runtime_id,
      runtime.gateway_id,
      data.gatewayRegistrations.find((registration) => registration.runtime_id === runtime.runtime_id)?.display_name,
      runtime.runtime_kind,
      runtime.operator_state,
      runtime.connected ? "CONNECTED" : "OFFLINE",
      runtime.in_sync ? "IN_SYNC" : "OUT_OF_SYNC",
      runtime.operator_alert_code ?? "",
      ...(runtime.observed_state?.components.map((component) => component.component) ?? []),
    ].join(" ").toUpperCase()
    return searchTerms.every((term) => searchable.includes(term))
  })
  const alerts = filteredRuntimes.filter((runtime) => runtime.operator_alert_code)
  const gatewayRegistrationByRuntime = new Map(
    data.gatewayRegistrations.map((registration) => [registration.runtime_id, registration]),
  )
  const [retiringRuntimeId, setRetiringRuntimeId] = useState<string | null>(null)
  const [confirmingRetirementRuntimeId, setConfirmingRetirementRuntimeId] = useState<string | null>(null)
  const [runtimeRetirementError, setRuntimeRetirementError] = useState<string | null>(null)
  const [rollingBackRuntimeId, setRollingBackRuntimeId] = useState<string | null>(null)
  const [confirmingRollbackRuntimeId, setConfirmingRollbackRuntimeId] = useState<string | null>(null)
  const [runtimeRollbackError, setRuntimeRollbackError] = useState<string | null>(null)
  const endpointSecurityEvents = data.endpointSecurityEvents.filter((event) => Boolean(event.device_id))
  const retirementRegistration = data.gatewayRegistrations.find((registration) => registration.runtime_id === confirmingRetirementRuntimeId) ?? null
  const retire = async (runtimeId: string) => {
    setRetiringRuntimeId(runtimeId)
    setRuntimeRetirementError(null)
    try {
      await retireGateway(tenantId, runtimeId)
      await onRefresh()
      setConfirmingRetirementRuntimeId(null)
    } catch (error) {
      setRuntimeRetirementError(error instanceof Error ? error.message : "PRODUCT_API_REQUEST_FAILED")
    } finally {
      setRetiringRuntimeId(null)
    }
  }
  const rollbackGateway = async (
    runtimeId: string,
    failedRevision: string,
    targetRevision: string,
  ) => {
    setRollingBackRuntimeId(runtimeId)
    setRuntimeRollbackError(null)
    try {
      await rollbackGateways(tenantId, {
        failedRevision,
        targetRevision,
        runtimeIds: [runtimeId],
      })
      setConfirmingRollbackRuntimeId(null)
      await onRefresh()
    } catch (error) {
      setRuntimeRollbackError(error instanceof Error ? error.message : "PRODUCT_API_REQUEST_FAILED")
    } finally {
      setRollingBackRuntimeId(null)
    }
  }
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t("Runtimes")}
        description={t("Runtime-initiated control channels apply Desired State and report separate Observed State.")}
        actions={<RegisterGatewaySheet tenantId={tenantId} onRegistered={onRefresh} />}
      />
      {data.gatewayFleet ? (
        <Card className={data.gatewayFleet.operator_state === "DOWN" ? "border-destructive/40" : ""}>
          <CardHeader className="border-b lg:flex-row lg:items-center lg:justify-between">
            <div>
              <CardTitle>{t("Gateway Site availability")}</CardTitle>
              <CardDescription>
                {data.gatewayFleet.traffic_available
                  ? t("At least one READY Gateway remains eligible for traffic.")
                  : t("No READY Gateway is currently eligible for traffic.")}
              </CardDescription>
            </div>
            <Badge variant={data.gatewayFleet.operator_state === "DOWN" ? "destructive" : data.gatewayFleet.operator_state === "READY" ? "secondary" : "outline"}>
              {t(data.gatewayFleet.operator_state)}
            </Badge>
          </CardHeader>
          <CardContent className="grid gap-3 p-5 lg:grid-cols-2">
            {data.gatewayFleet.sites.map((site) => (
              <div key={site.site_id} className="rounded-lg border p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="font-medium">{site.site_id}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{site.gateway_id} · {site.region}</div>
                  </div>
                  <Badge variant={site.operator_state === "DOWN" ? "destructive" : site.operator_state === "READY" ? "secondary" : "outline"}>
                    {t(site.operator_state)}
                  </Badge>
                </div>
                <div className="mt-4 text-sm">
                  {t("{{ready}} of {{total}} Gateway instances are traffic eligible.", {
                    ready: site.traffic_eligible_instance_count,
                    total: site.registered_instance_count,
                  })}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {site.instances.map((instance) => (
                    <Badge key={instance.runtime_id} variant={instance.traffic_eligible ? "secondary" : "outline"}>
                      {instance.runtime_id} · {t(instance.operator_state)}
                    </Badge>
                  ))}
                  <GatewayDiagnosticsSheet
                    tenantId={tenantId}
                    gatewayId={site.gateway_id}
                    onUpdated={onRefresh}
                  />
                </div>
              </div>
            ))}
            {!data.gatewayFleet.sites.length ? (
              <p className="text-sm text-muted-foreground">{t("No active Gateway Sites")}</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
      {alerts.length ? (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardHeader className="border-b border-destructive/20">
            <CardTitle><TitleHelp help={t("Operator attention is required before this deployment can be considered healthy.")}>{t("Runtime alerts")}</TitleHelp></CardTitle>
          </CardHeader>
          <CardContent className="divide-y px-0">
            {alerts.map((runtime) => (
              <div key={`alert-${runtime.runtime_kind}-${runtime.runtime_id}`} className="flex flex-col justify-between gap-2 px-6 py-4 sm:flex-row sm:items-center">
                <div>
                  <div className="font-medium">{runtime.runtime_id}</div>
                  <div className="text-sm text-muted-foreground">{t(runtime.operator_alert_code ?? "")}</div>
                  {runtime.last_error ? <div className="text-sm text-destructive">{runtime.last_error}</div> : null}
                  <div className="text-sm text-muted-foreground">{t(runtimeRemediation(runtime))}</div>
                </div>
                <Badge variant="destructive">{t(runtime.operator_state)}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader className="border-b">
          <CardTitle><TitleHelp help={t("Canonical Gateway identities and their dedicated Keycloak service clients.")}>{t("Gateway registrations")}</TitleHelp></CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          {data.gatewayRegistrations.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Gateway")}</TableHead>
                  <TableHead>{t("Site")}</TableHead>
                  <TableHead>{t("Region")}</TableHead>
                  <TableHead>{t("Identity client")}</TableHead>
                  <TableHead>{t("State")}</TableHead>
                  <TableHead className="text-right">{t("Registered")}</TableHead>
                  <TableHead className="text-right">{t("Action")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.gatewayRegistrations.map((registration) => (
                  <TableRow key={registration.runtime_id}>
                    <TableCell>
                      <div className="font-medium">{registration.display_name}</div>
                      <div className="text-xs text-muted-foreground">{registration.runtime_id}</div>
                    </TableCell>
                    <TableCell>{registration.site_id}</TableCell>
                    <TableCell>{registration.region}</TableCell>
                    <TableCell className="font-mono text-xs">{registration.identity_client_id}</TableCell>
                    <TableCell>
                      <Badge variant={registration.state === "ACTIVE" ? "secondary" : registration.state === "RETIRED" ? "destructive" : "outline"}>
                        {t(registration.state)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {relativeTime(registration.registered_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      {registration.state === "PROVISIONING" ? (
                        <RegisterGatewaySheet
                          tenantId={tenantId}
                          retryRuntimeId={registration.runtime_id}
                          onRegistered={onRefresh}
                        />
                      ) : registration.state === "ACTIVE" ? (
                        <Button
                          data-testid={`retire-gateway-${registration.runtime_id}`}
                          disabled={retiringRuntimeId !== null}
                          onClick={() => {
                            setRuntimeRetirementError(null)
                            setConfirmingRetirementRuntimeId(registration.runtime_id)
                          }}
                          size="sm"
                          variant="outline"
                        >
                          {t("Retire")}
                        </Button>
                      ) : (
                        <span className="text-sm text-muted-foreground">{t("None")}</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <DataEmpty
              icon={ServerIcon}
              title={t("No registered Gateways")}
              description={t("Register the first Genio Gateway and save its one-time bootstrap configuration.")}
            />
          )}
        </CardContent>
      </Card>
      <AlertDialog
        open={retirementRegistration !== null}
        onOpenChange={(open) => {
          if (!open && retiringRuntimeId === null) {
            setConfirmingRetirementRuntimeId(null)
            setRuntimeRetirementError(null)
          }
        }}
      >
        <AlertDialogContent data-testid="retire-gateway-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Retire {{name}}?", { name: retirementRegistration?.display_name ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>{t("This disables the Gateway identity. Audit provenance is retained.")}</AlertDialogDescription>
          </AlertDialogHeader>
          {runtimeRetirementError ? (
            <p className="text-sm text-destructive" role="alert">
              {t("Gateway retirement failed")}: {t(runtimeRetirementError)}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={retiringRuntimeId !== null}>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={retiringRuntimeId !== null || retirementRegistration === null}
              onClick={(event) => {
                event.preventDefault()
                if (retirementRegistration) void retire(retirementRegistration.runtime_id)
              }}
              variant="destructive"
            >
              {t(retiringRuntimeId !== null ? "Retiring…" : "Retire")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Card>
        <CardHeader className="border-b">
          <CardTitle><TitleHelp help={t("Missing observed state is shown explicitly, never inferred as healthy.")}>{t("Runtime inventory")}</TitleHelp></CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          {runtimeRollbackError ? (
            <div role="alert" className="border-b border-destructive/20 bg-destructive/5 px-6 py-3 text-sm text-destructive">
              {t("Gateway rollback failed")}: {t(runtimeRollbackError)}
            </div>
          ) : null}
          {filteredRuntimes.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Runtime")}</TableHead>
                  <TableHead>{t("Kind")}</TableHead>
                  <TableHead>{t("Site")}</TableHead>
                  <TableHead>{t("Region")}</TableHead>
                  <TableHead>{t("Version")}</TableHead>
                  <TableHead>{t("Control channel")}</TableHead>
                  <TableHead>{t("Convergence")}</TableHead>
                  <TableHead>{t("Health")}</TableHead>
                  <TableHead>{t("Desired policy version")}</TableHead>
                  <TableHead>{t("Applied policy version")}</TableHead>
                  <TableHead>{t("Desired")}</TableHead>
                  <TableHead>{t("Observed")}</TableHead>
                  <TableHead>{t("Pending")}</TableHead>
                  <TableHead className="text-right">{t("Last report")}</TableHead>
                  <TableHead className="text-right">{t("Actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRuntimes.map((runtime) => {
                  const failedRevision = runtime.desired_state_revision
                  const targetRevision = runtime.last_successful_state_revision
                  const canRollback = runtime.runtime_kind === "GATEWAY"
                    && Boolean(failedRevision)
                    && Boolean(targetRevision)
                    && failedRevision !== targetRevision
                  return (
                  <TableRow key={`${runtime.runtime_kind}-${runtime.runtime_id}`}>
                    <TableCell className="font-medium">{runtime.runtime_id}</TableCell>
                    <TableCell>{runtime.runtime_kind === "GATEWAY" ? t("Gateway") : t("Endpoint")}</TableCell>
                    <TableCell>
                      {gatewayRegistrationByRuntime.get(runtime.runtime_id)?.site_id ?? "—"}
                    </TableCell>
                    <TableCell>
                      {gatewayRegistrationByRuntime.get(runtime.runtime_id)?.region ?? "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {runtime.observed_state?.runtime_version ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={runtime.connected ? "secondary" : "outline"}>
                        {t(runtime.connected ? "CONNECTED" : "OFFLINE")}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={runtime.in_sync ? "secondary" : "outline"}>
                        {t(runtimeConvergence(runtime))}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          runtime.operator_state === "READY"
                            ? "secondary"
                            : runtime.operator_state === "DEGRADED" || runtime.operator_state === "OFFLINE"
                              ? "destructive"
                              : "outline"
                        }
                      >
                        {t(runtime.operator_state)}
                      </Badge>
                    </TableCell>
                    <TableCell
                      className="font-mono text-xs"
                      data-testid={`runtime-desired-policy-${runtime.runtime_id}`}
                    >
                      {runtime.desired_policy_version ?? "—"}
                    </TableCell>
                    <TableCell
                      className="font-mono text-xs"
                      data-testid={`runtime-applied-policy-${runtime.runtime_id}`}
                    >
                      {runtime.observed_state?.applied_policy_version ?? "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {runtime.desired_state_revision ?? "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {runtime.observed_state?.applied_state_revision ?? "—"}
                    </TableCell>
                    <TableCell className="tabular-nums">{runtime.pending_command_count}</TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {runtime.last_reported_at ? relativeTime(runtime.last_reported_at) : t("Never")}
                    </TableCell>
                    <TableCell className="text-right">
                      {canRollback ? (
                        <div className="flex justify-end gap-2">
                          {confirmingRollbackRuntimeId === runtime.runtime_id ? (
                            <Button
                              data-testid={`cancel-rollback-gateway-${runtime.runtime_id}`}
                              disabled={rollingBackRuntimeId === runtime.runtime_id}
                              onClick={() => setConfirmingRollbackRuntimeId(null)}
                              size="sm"
                              variant="ghost"
                            >
                              {t("Cancel")}
                            </Button>
                          ) : null}
                          <Button
                            data-testid={`rollback-gateway-${runtime.runtime_id}`}
                            disabled={rollingBackRuntimeId === runtime.runtime_id}
                            onClick={() => {
                              if (confirmingRollbackRuntimeId === runtime.runtime_id) {
                                void rollbackGateway(runtime.runtime_id, failedRevision!, targetRevision!)
                              } else {
                                setConfirmingRollbackRuntimeId(runtime.runtime_id)
                              }
                            }}
                            size="sm"
                            variant="outline"
                          >
                            {t(
                              rollingBackRuntimeId === runtime.runtime_id
                                ? "Rolling back Gateway…"
                                : confirmingRollbackRuntimeId === runtime.runtime_id
                                  ? "Confirm Gateway rollback"
                                  : "Roll back Gateway",
                            )}
                          </Button>
                        </div>
                      ) : (
                        <span className="text-sm text-muted-foreground">{t("None")}</span>
                      )}
                    </TableCell>
                  </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center">
              <DataEmpty
                icon={ServerIcon}
                title={t(search.trim() ? "No matching Runtimes" : "No runtime reports")}
                description={t(search.trim() ? "Clear the filter to inspect all registered runtime reports." : "A Runtime appears only after a command, observed-state report, or active outbound control channel establishes its identity.")}
              />
              {search.trim() ? <Button asChild variant="outline" className="mb-5"><a href="/management?view=runtimes">{t("Clear filters")}</a></Button> : null}
            </div>
          )}
        </CardContent>
      </Card>
      {filteredRuntimes
        .filter((runtime) => runtime.observed_state?.components.length)
        .map((runtime) => (
          <Card key={`components-${runtime.runtime_id}`}>
            <CardHeader className="border-b">
              <CardTitle><TitleHelp help={t("Observed module state reported by this Gateway Runtime.")}>{t("{{runtime}} modules", { runtime: runtime.runtime_id })}</TitleHelp></CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Module")}</TableHead>
                    <TableHead>{t("Health")}</TableHead>
                    <TableHead>{t("Applied config revision")}</TableHead>
                    <TableHead>{t("Detail")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runtime.observed_state?.components.map((component) => (
                    <TableRow key={component.component}>
                      <TableCell className="font-medium">
                        {component.component.replaceAll("_", " ")}
                      </TableCell>
                      <TableCell>
                        <Badge variant={component.health === "READY" ? "secondary" : "destructive"}>
                          {t(component.health)}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {component.applied_config_revision ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{component.detail ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ))}
      <Card data-testid="endpoint-security-audit">
        <CardHeader className="border-b">
          <CardTitle><TitleHelp help={t("Recent enrollment, revoke, and session-rejection events reported by Endpoint control paths.")}>{t("Endpoint lifecycle audit")}</TitleHelp></CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          {endpointSecurityEvents.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Event")}</TableHead>
                  <TableHead>{t("Device")}</TableHead>
                  <TableHead>{t("Subject")}</TableHead>
                  <TableHead>{t("Outcome")}</TableHead>
                  <TableHead>{t("Endpoint version")}</TableHead>
                  <TableHead>{t("Desired state")}</TableHead>
                  <TableHead>{t("Correlation")}</TableHead>
                  <TableHead className="text-right">{t("Occurred")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {endpointSecurityEvents.map((event) => (
                  <TableRow key={event.audit_event_id} data-testid={`endpoint-security-audit-${event.audit_event_id}`}>
                    <TableCell className="font-medium">{t(event.kind)}</TableCell>
                    <TableCell className="font-mono text-xs">{event.device_id}</TableCell>
                    <TableCell className="font-mono text-xs">{event.subject.subject_id}</TableCell>
                    <TableCell><Badge variant="outline">{t(event.outcome)}</Badge></TableCell>
                    <TableCell className="font-mono text-xs">{event.endpoint_version ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs" data-testid={`endpoint-audit-desired-state-${event.audit_event_id}`}>
                      {event.desired_state_revision ?? "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{event.correlation_id}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{relativeTime(event.occurred_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="px-6 py-5 text-sm text-muted-foreground">{t("Endpoint lifecycle audit has no recent events.")}</p>
          )}
        </CardContent>
      </Card>

    </div>
  )
}

