import { LoaderCircleIcon } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import { Badge } from "@/components/ui/badge"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { ApiGatewayActivityEvent, ApiGatewayHttpMessageDetail, DecisionAuditEvent, OverviewSnapshot } from "@/domain/contracts"
import { loadActivityEvidence, type ActivityEvidence } from "@/features/activity/activity-evidence"
import { createActivityDisplayDirectory, type ActivityEntityDisplay } from "@/features/activity/activity-display"
import { enforcementPointLabel, normalizeEnforcementPoint } from "@/features/observability/enforcement-point-model"
import { relativeTime } from "@/lib/format"
import { formatEpochSeconds } from "@/lib/personal-preferences"

function Value({ children }: { children: React.ReactNode }) {
  return <div className="mt-1 break-words font-mono text-xs text-foreground">{children || "—"}</div>
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <Value>{children}</Value>
    </div>
  )
}

function EntityDetail({ label, value }: { label: string; value: ActivityEntityDisplay }) {
  const { t } = useTranslation()
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 font-medium text-foreground">{t(value.label)}</div>
      {value.supporting ? <div className="mt-0.5 text-xs text-muted-foreground">{t(value.kind)} · {value.supporting}</div> : null}
    </div>
  )
}

function HttpMessageDetail({ message }: { message: ApiGatewayHttpMessageDetail | null }) {
  const { t } = useTranslation()
  if (!message) {
    return <div className="rounded-md border p-4 text-sm text-muted-foreground">{t("No body captured.")}</div>
  }
  return <div className="flex flex-col gap-5">
    <div>
      <div className="mb-2 text-xs text-muted-foreground">{t("Headers")}</div>
      <div className="divide-y rounded-md border font-mono text-xs">
        {message.headers.map(([name, value]) => <div className="grid grid-cols-[minmax(8rem,0.35fr)_1fr] gap-3 px-3 py-2" key={name}><span className="text-muted-foreground">{name}</span><span className="break-all">{value}</span></div>)}
      </div>
    </div>
    <div>
      <div className="mb-2 flex items-center justify-between gap-3 text-xs text-muted-foreground"><span>{t("Body")}</span>{message.body_truncated ? <Badge variant="secondary">{t("Truncated")}</Badge> : null}</div>
      {message.body ? <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-4 font-mono text-xs">{message.body}</pre> : <div className="rounded-md border p-4 text-sm text-muted-foreground">{t("No body captured.")}</div>}
    </div>
  </div>
}

function formatEstimatedCost(currency: "USD" | null, micros: number | null): string {
  if (!currency || micros === null) return "—"
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(micros / 1_000_000)
}

export function ApiGatewayTransactionSheet({
  tenantId,
  event,
  auditEvent,
  data,
  open,
  onOpenChange,
}: {
  tenantId: string
  event: ApiGatewayActivityEvent | null
  auditEvent: DecisionAuditEvent | null
  data: Pick<OverviewSnapshot, "applications" | "connections" | "identity" | "resources">
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const [evidence, setEvidence] = useState<ActivityEvidence | null>(null)
  const [evidenceError, setEvidenceError] = useState("")
  const [evidenceLoading, setEvidenceLoading] = useState(false)
  const fallbackDisplay = useMemo(() => createActivityDisplayDirectory(data), [data])

  useEffect(() => {
    if (!open || !event) {
      setEvidence(null)
      setEvidenceError("")
      return
    }
    let active = true
    setEvidence(null)
    setEvidenceError("")
    setEvidenceLoading(true)
    void loadActivityEvidence({ tenantId, event, data })
      .then((value) => { if (active) setEvidence(value) })
      .catch(() => { if (active) setEvidenceError("Activity evidence could not be loaded.") })
      .finally(() => { if (active) setEvidenceLoading(false) })
    return () => { active = false }
  }, [data, event, open, tenantId])

  if (!event) return null

  const accounting = evidence?.accounting ?? []
  const detail = evidence?.detail ?? null
  const detailError = evidence?.errors.detail ?? evidenceError
  const detailLoading = evidenceLoading
  const display = evidence?.display ?? fallbackDisplay
  const outcomeAttributions = evidence?.outcomeAttributions ?? []
  const reconstruction = evidence?.reconstruction ?? null
  const sessionTimeline = evidence?.sessionTimeline ?? null

  const successful = event.outcome === "COMPLETED"
  const enforcementPoint = normalizeEnforcementPoint(event.enforcement_point_id)
  const subject = display.subject(
    event.subject_id ?? auditEvent?.subject.subject_id,
    event.subject_display,
  )
  const client = display.application(event.application_id ?? event.acting_client_id ?? auditEvent?.acting_client.acting_client_id)
  const resource = display.resource(event.resource_id)
  const capability = display.capability(event.resource_id, event.capability_id)
  const connection = display.connection(event.connection_id)
  const provider = display.provider(event.provider_id)
  const title = event.enforcement_point_id === "AI_GATEWAY"
    ? "AI Gateway transaction details"
    : "API Gateway transaction details"
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl" data-testid="api-gateway-transaction-sheet">
        <SheetHeader className="border-b px-6 py-5">
          <SheetTitle>{t(title)}</SheetTitle>
          <SheetDescription className="font-mono text-xs">{event.correlation_id}</SheetDescription>
        </SheetHeader>

        <div className="grid grid-cols-2 gap-x-5 gap-y-4 border-b p-6 text-sm">
          <Detail label={t("Outcome")}><Badge variant={successful ? "outline" : "destructive"}>{t(event.outcome)}</Badge></Detail>
          <Detail label={t("Occurred")}>{relativeTime(event.occurred_at)}</Detail>
          <Detail label={t("Status code")}>{event.status_code}</Detail>
          <Detail label={t("Latency")}>{event.latency_millis == null ? "—" : `${event.latency_millis} ms`}</Detail>
          <EntityDetail label={t(client.kind)} value={client} />
          <EntityDetail label={subject.resolved ? t(subject.kind) : t("Subject")} value={subject} />
          <EntityDetail label={t("Resource")} value={resource} />
          <EntityDetail label={t("Capability")} value={capability} />
          <Detail label={t("Enforcement point")}>{enforcementPoint ? t(enforcementPointLabel(enforcementPoint)) : t("Unknown")}</Detail>
          <Detail label={t("Route")}>{t(event.route)}</Detail>
          <Detail label={t("Upstream attempted")}>{event.upstream_attempted ? t("Yes") : t("No")}</Detail>
          <Detail label={t("Requested model")}>{event.requested_model_id ?? "—"}</Detail>
          <Detail label={t("Effective model")}>{event.effective_model_id ?? "—"}</Detail>
          <EntityDetail label={t("Provider")} value={provider} />
          <EntityDetail label={t("Connection")} value={connection} />
        </div>

        {reconstruction ? (
          <div className="border-b p-6" data-testid="gateway-routing-reconstruction">
            <h3 className="font-semibold">{t("Routing reconstruction")}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{t("Reconstructed from immutable release and attempt receipts without invoking an upstream.")}</p>
            <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-4 text-sm">
              <Detail label={t("Release head")}>{reconstruction.release_head_revision ?? "—"}</Detail>
              <Detail label={t("Candidate set digest")}>{reconstruction.candidate_set_digest ?? "—"}</Detail>
              <Detail label={t("Selected Connection")}>
                {reconstruction.selected_connection_id
                  ? t(display.connection(reconstruction.selected_connection_id).label)
                  : "—"}
              </Detail>
              <Detail label={t("Upstream invoked by query")}>{reconstruction.query_upstream_invoked ? t("Yes") : t("No")}</Detail>
            </div>
            <div className="mt-4 space-y-2">
              {reconstruction.ordered_attempts.map((attempt) => (
                <div className="grid grid-cols-[2rem_1fr_auto] items-center gap-3 rounded-md border px-3 py-2 text-sm" key={`${attempt.order}:${attempt.connection_id}`}>
                  <span className="font-mono text-xs text-muted-foreground">{attempt.order}</span>
                  <span>{t(display.connection(attempt.connection_id).label)}</span>
                  <Badge variant={attempt.outcome === "SELECTED" ? "outline" : "secondary"}>{t(attempt.outcome)}</Badge>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="border-b p-6" data-testid="gateway-usage-admission">
          <h3 className="font-semibold">{t("Authorization and usage admission")}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{t("Entitlement authorization and Usage Admission are separate decisions for the same correlation.")}</p>
          <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-4 text-sm">
            <Detail label={t("Authorization")}>{auditEvent?.decision ? t(auditEvent.decision.access) : t("Not collected")}</Detail>
            <Detail label={t("Entitlement")}>{event.entitlement_id ?? auditEvent?.entitlement_id ?? auditEvent?.decision?.entitlement_id ?? "—"}</Detail>
            <Detail label={t("Usage admission")}><Badge variant={event.usage_admission_disposition === "REJECT" ? "destructive" : "outline"}>{t(event.usage_admission_disposition)}</Badge></Detail>
            <Detail label={t("Admission ID")}>{event.usage_admission_id ?? "—"}</Detail>
            <Detail label={t("Admission reason")}>{event.usage_admission_reason ? t(event.usage_admission_reason) : "—"}</Detail>
            <Detail label={t("Consumer Organization")}>{event.consumer_organization_id ?? "—"}</Detail>
            <Detail label={t("Resource Owner Organization")}>{event.resource_owner_organization_id ?? "—"}</Detail>
            <Detail label={t("Use Case")}>{event.use_case_id ?? "—"}</Detail>
          </div>
        </div>

        {event.mcp_method || event.mcp_tool || event.mcp_backend ? (
          <div className="border-b p-6" data-testid="gateway-mcp-facts">
            <h3 className="font-semibold">{t("MCP")}</h3>
            <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-4 text-sm">
              <Detail label={t("MCP method")}>{event.mcp_method ?? "—"}</Detail>
              <Detail label={t("MCP tool")}>{event.mcp_tool ?? "—"}</Detail>
              <Detail label={t("Downstream identity")}>{event.downstream_identity_mode ? t(event.downstream_identity_mode) : "—"}</Detail>
            </div>
          </div>
        ) : null}

        {event.route_mode === "SESSION_LEASE" ? (
          <div className="border-b p-6" data-testid="gateway-route-lease-evidence">
            <h3 className="font-semibold">{t("Session route evidence")}</h3>
            <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-4 text-sm">
              <Detail label={t("Route mode")}>{t(event.route_mode)}</Detail>
              <Detail label={t("Lease status")}>{event.route_lease_reused ? t("Reused") : t("New lease")}</Detail>
              <Detail label={t("Route lease ID")}>{event.route_lease_id ?? "—"}</Detail>
              <Detail label={t("Session")}>{event.session_id ?? "—"}</Detail>
              <Detail label={t("Routing policy")}>{event.routing_policy_id ?? "—"}</Detail>
              <Detail label={t("Routing revision")}>{event.routing_revision ?? "—"}</Detail>
              <Detail label={t("Candidate set digest")}>{event.candidate_set_digest ?? "—"}</Detail>
              <Detail label={t("Provider credential profile")}>{event.provider_credential_profile_id ?? "—"}</Detail>
              <Detail label={t("Provider credential revision")}>{event.provider_credential_profile_revision ?? "—"}</Detail>
              <Detail label={t("Provider credential strategy digest")}>{event.provider_credential_strategy_digest ?? "—"}</Detail>
            </div>
          </div>
        ) : null}

        {sessionTimeline ? (
          <div className="border-b p-6" data-testid="gateway-session-timeline">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">{t("Session timeline")}</h3>
              {sessionTimeline.summary ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{t("{{count}} steps", { count: sessionTimeline.summary.total_events })}</span>
                  <span>·</span>
                  <span>{t("{{count}} tokens", { count: sessionTimeline.summary.total_tokens.toLocaleString() })}</span>
                  <span>·</span>
                  <span>{t("{{count}} ms", { count: sessionTimeline.summary.total_latency_millis })}</span>
                </div>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{t("This timeline is a read model. Every invocation keeps its own authorization decision and correlation.")}</p>
            <div className="mt-4 space-y-2">
              {sessionTimeline.steps && sessionTimeline.steps.length > 0 ? (
                sessionTimeline.steps.map((step) => (
                  <div className="grid grid-cols-[1fr_auto] gap-3 rounded-md border px-3 py-2 text-sm" key={step.correlation_id}>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-semibold text-muted-foreground">#{step.step_index}</span>
                        <Badge variant={step.step_type === "POLICY_INTERCEPTION" ? "destructive" : step.step_type === "TOOL_EXECUTION" ? "secondary" : "outline"} className="text-[10px] px-1.5 py-0">
                          {t(step.step_type)}
                        </Badge>
                        <span className="font-medium text-xs truncate max-w-[280px]">{step.model_id ?? step.tool_name ?? step.correlation_id}</span>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {formatEpochSeconds(step.occurred_at)}
                        {step.latency_millis !== null ? ` · ${step.latency_millis}ms` : ""}
                        {step.total_tokens !== null ? ` · ${step.total_tokens} tokens` : ""}
                        {step.data_classifications.length > 0 ? ` · ${step.data_classifications.join(", ")}` : ""}
                      </div>
                    </div>
                    <Badge variant={step.outcome === "COMPLETED" ? "outline" : "destructive"}>{t(step.outcome)}</Badge>
                  </div>
                ))
              ) : (
                sessionTimeline.events.map((sessionEvent) => (
                  <div className="grid grid-cols-[1fr_auto] gap-3 rounded-md border px-3 py-2 text-sm" key={sessionEvent.correlation_id}>
                    <div><div className="font-mono text-xs">{sessionEvent.correlation_id}</div><div className="text-xs text-muted-foreground">{formatEpochSeconds(sessionEvent.occurred_at)} · {sessionEvent.resource_id} · {sessionEvent.capability_id ?? "—"}</div></div>
                    <Badge variant={sessionEvent.outcome === "COMPLETED" ? "outline" : "destructive"}>{t(sessionEvent.outcome)}</Badge>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : null}

        {outcomeAttributions.length > 0 ? (
          <div className="border-b p-6" data-testid="gateway-outcome-attributions">
            <h3 className="font-semibold">{t("Outcome attribution")}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{t("External outcomes are correlated evidence and never grant or revoke Entitlement.")}</p>
            <div className="mt-4 space-y-2">
              {outcomeAttributions.map((attribution) => (
                <div className="grid grid-cols-[1fr_auto] gap-3 rounded-md border px-3 py-2 text-sm" key={attribution.attribution_id}>
                  <div><div className="font-medium">{attribution.value}</div><div className="font-mono text-xs text-muted-foreground">{attribution.source} · {attribution.outcome_reference}</div></div>
                  <span className="text-xs text-muted-foreground">{formatEpochSeconds(attribution.observed_at)}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {event.processor_request_steps.length > 0 || event.processor_response_steps.length > 0 ? (
          <div className="border-b p-6" data-testid="gateway-processor-receipt">
            <h3 className="font-semibold">{t("Data protection processing")}</h3>
            <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-4 text-sm">
              <Detail label={t("Request processing")}>
                {event.processor_request_steps.length > 0
                  ? event.processor_request_steps.map((step) => `${step.step_id} · ${step.action}`).join(" → ")
                  : "—"}
              </Detail>
              <Detail label={t("Response processing")}>
                {event.processor_response_steps.length > 0
                  ? event.processor_response_steps.map((step) => `${step.step_id} · ${step.action}`).join(" → ")
                  : "—"}
              </Detail>
              <Detail label={t("Policy bundle revision")}>{event.processor_bundle_revision ?? "—"}</Detail>
              {event.data_classifications.length > 0 ? (
                <Detail label={t("Classification provenance")}>
                  {event.data_classifications.map((receipt) =>
                    `${receipt.classification} · ${receipt.handling_action} · ${receipt.source} · ${receipt.source_version} · ${receipt.trust_level}`
                  ).join(" → ")}
                </Detail>
              ) : null}
            </div>
          </div>
        ) : null}

        {event.input_tokens !== null || event.output_tokens !== null || event.total_tokens !== null ? (
          <div className="border-b p-6" data-testid="gateway-usage-facts">
            <h3 className="font-semibold">{t("Provider-reported usage")}</h3>
            <div className="mt-4 grid grid-cols-3 gap-x-5 gap-y-4 text-sm">
              <Detail label={t("Input tokens")}>{event.input_tokens ?? "—"}</Detail>
              <Detail label={t("Output tokens")}>{event.output_tokens ?? "—"}</Detail>
              <Detail label={t("Total tokens")}>{event.total_tokens ?? "—"}</Detail>
            </div>
          </div>
        ) : null}

        {event.cost_estimation_status !== "NOT_APPLICABLE" ? (
          <div className="border-b p-6" data-testid="gateway-estimated-cost">
            <h3 className="font-semibold">{t("Estimated Cost")}</h3>
            <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-4 text-sm">
              <Detail label={t("Status")}>{t(event.cost_estimation_status)}</Detail>
              <Detail label={t("Estimated Cost")}>
                {event.cost_estimation_status === "ESTIMATED"
                  ? formatEstimatedCost(event.estimated_cost_currency, event.estimated_cost_micros)
                  : t("No public price is available for this provider model.")}
              </Detail>
              <Detail label={t("Pricing source")}>{event.pricing_source ?? "—"}</Detail>
              <Detail label={t("Pricing version")}>{event.pricing_version ?? "—"}</Detail>
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              {t("Estimated from public model pricing; actual provider charges may differ.")}
            </p>
          </div>
        ) : null}

        {accounting.length > 0 ? (
          <div className="border-b p-6" data-testid="gateway-canonical-accounting">
            <h3 className="font-semibold">{t("Canonical charge")}</h3>
            <div className="mt-4 space-y-4">
              {accounting.map((record) => (
                <div className="grid grid-cols-2 gap-x-5 gap-y-4 rounded-md border p-4 text-sm" key={record.charge.charge_id}>
                  <Detail label={t("Consumer Organization")}>{record.invocation.consumer_organization_id}</Detail>
                  <Detail label={t("Resource Owner Organization")}>{record.invocation.resource_owner_organization_id}</Detail>
                  <Detail label={t("Use Case")}>{record.invocation.use_case_id}</Detail>
                  <Detail label={t("Accounting key")}>{record.invocation.accounting_key_id}</Detail>
                  <Detail label={t("Usage Policy revisions")}>{record.invocation.usage_policy_revisions.join(" · ")}</Detail>
                  <Detail label={t("Release revision")}>{record.invocation.release_revision}</Detail>
                  <Detail label={t("Canonical charge")}>{record.charge.charge_id}</Detail>
                  <Detail label={t("Quantities")}>{record.quantities.map((value) => `${value.unit}: ${value.quantity}`).join(" · ") || t("Not collected")}</Detail>
                  <Detail label={t("Cost valuations")}>{record.valuations.map((value) => `${value.status} ${value.currency} ${(value.amount_micros / 1_000_000).toFixed(6)}`).join(" · ") || t("Not collected")}</Detail>
                  <Detail label={t("Pricing provenance")}>{record.valuations.map((value) => `${value.pricing_source}@${value.pricing_version}`).join(" · ") || t("Not collected")}</Detail>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {auditEvent?.decision ? (
          <div className="border-b bg-muted/20 p-6" data-testid="correlated-authorization-evidence">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold">{t("Authorization evidence")}</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {auditEvent.outcome === "ALLOW" && event.outcome !== "COMPLETED"
                    ? t("One Policy allowed the request; a later Gateway stage produced the final execution outcome shown above.")
                    : t("The verified One Policy decision correlated to this Gateway transaction.")}
                </p>
              </div>
              <Badge variant={auditEvent.outcome === "DENY" ? "destructive" : "outline"}>{t(auditEvent.outcome)}</Badge>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-4 text-sm">
              <Detail label={t("Subject evidence")}>{t(auditEvent.subject.evidence_level)}</Detail>
              <Detail label={t("Acting Client evidence")}>{t(auditEvent.acting_client.evidence_level)}</Detail>
              <Detail label={t("Policy version")}>{auditEvent.decision.policy_version}</Detail>
              <Detail label={t("Access")}>{t(auditEvent.decision.access)}</Detail>
            </div>
          </div>
        ) : null}

        <div className="space-y-4 border-b p-6">
          <div>
            <div className="text-xs text-muted-foreground">{t("HTTP Request")}</div>
            <div className="mt-1 font-mono text-sm">{event.method} {event.path}</div>
          </div>
          {event.error_code ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4">
              <div className="text-xs text-muted-foreground">{t("Error code")}</div>
              <div className="mt-1 font-mono text-sm text-destructive">{event.error_code}</div>
            </div>
          ) : null}
        </div>

        <div className="p-6" data-testid="api-gateway-transaction-detail">
          {detailLoading ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircleIcon className="animate-spin" />{t("Loading transaction detail")}</div> : null}
          {detailError ? <div className="text-sm text-destructive" role="alert">{t(detailError)}</div> : null}
          {detail?.availability === "AVAILABLE" && (detail.request || detail.response) ? <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge>{t("Detail available")}</Badge>
              {detail.redacted_fields.length ? <Badge variant="secondary">{t("Sensitive values redacted")}</Badge> : null}
              <span className="text-xs text-muted-foreground">{t("Retained until {{time}}", { time: detail.expires_at ? formatEpochSeconds(detail.expires_at) : "—" })}</span>
            </div>
            <Tabs defaultValue="request">
              <TabsList>
                <TabsTrigger value="request">{t("Request detail")}</TabsTrigger>
                <TabsTrigger value="response">{t("Response detail")}</TabsTrigger>
              </TabsList>
              <TabsContent value="request"><HttpMessageDetail message={detail.request} /></TabsContent>
              <TabsContent value="response"><HttpMessageDetail message={detail.response} /></TabsContent>
            </Tabs>
          </div> : null}
          {detail?.availability === "EXPIRED" ? <div className="rounded-md border p-4 text-sm text-muted-foreground">{t("Request and response detail expired at {{time}}. Transaction metadata remains available.", { time: detail.expires_at ? formatEpochSeconds(detail.expires_at) : "—" })}</div> : null}
          {detail?.availability === "NOT_CAPTURED" ? <div className="rounded-md border p-4 text-sm text-muted-foreground">{t("Detailed capture was not enabled for this transaction. Transaction metadata remains available.")}</div> : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}
