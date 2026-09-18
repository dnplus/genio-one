import { useTranslation } from "react-i18next"

import { Badge } from "@/components/ui/badge"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import type { AccessRequest, ApiGatewayActivityEvent, AuditEvent, InvocationAccountingRecord, OverviewSnapshot } from "@/domain/contracts"
import { relativeTime } from "@/lib/format"
import { createActivityDisplayDirectory, type ActivityEntityDisplay } from "./activity-display"

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

function EntityDetail({
  label,
  entity,
  id,
  metadata,
}: {
  label: string
  entity: ActivityEntityDisplay
  id: string | null | undefined
  metadata?: string
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-medium text-foreground">{id ? entity.label : "—"}</div>
      {id ? <div className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">{id}{metadata ? ` · ${metadata}` : ""}</div> : null}
    </div>
  )
}

function RuntimeAuditDetails({
  event,
  data,
}: {
  event: AuditEvent
  data: Pick<OverviewSnapshot, "applications" | "connections" | "identity" | "resources">
}) {
  const { t } = useTranslation()
  const display = createActivityDisplayDirectory(data)
  const subject = display.subject(event.subject.subject_id)
  const policy = event.policy_display_name ?? event.policy_id ?? t("Unconfigured")
  return (
    <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
      <SheetHeader className="border-b px-6 py-5">
        <SheetTitle>{t("Runtime policy decision details")}</SheetTitle>
        <SheetDescription className="font-mono text-xs">{event.correlation_id}</SheetDescription>
      </SheetHeader>
      <div className="grid grid-cols-2 gap-x-5 gap-y-4 border-b p-6 text-sm">
        <Detail label={t("Phase")}>{event.phase ? t(event.phase) : "—"}</Detail>
        <Detail label={t("Authorization")}>{event.outcome}</Detail>
        <Detail label={t("Execution result")}>{event.phase === "PREVIEW" ? t("Not executed (preview)") : event.report_outcome ?? t("Not reported")}</Detail>
        <Detail label={t("Reason")}>{event.reason_code ?? event.outcome}</Detail>
        <EntityDetail label={t(event.phase === "PREVIEW" ? "Preview administrator" : "Person / Agent")} entity={subject} id={event.subject.subject_id} metadata={t(event.subject.evidence_level)} />
        {event.phase === "PREVIEW" && event.target_subject_id ? <EntityDetail label={t("Preview user")} entity={display.subject(event.target_subject_id)} id={event.target_subject_id} /> : null}
        <EntityDetail label={t("Acting Client")} entity={display.application(event.acting_client.acting_client_id)} id={event.acting_client.acting_client_id} metadata={t(event.acting_client.evidence_level)} />
        <Detail label={t("Bot")}>{event.bot_id ?? "—"}</Detail>
        <Detail label={t("Session")}>{event.session_id ?? "—"}</Detail>
        <Detail label={t("Runtime")}>{event.runtime_id ?? "—"}</Detail>
        <Detail label={t("Capability")}>{event.capability_id ?? "—"}</Detail>
        <Detail label={t("Action")}>{event.action ?? "—"}</Detail>
        <Detail label={t("Target")}>{event.target ?? "—"}</Detail>
        <Detail label={t("Policy")}>{policy}</Detail>
        <Detail label={t("Policy revision")}>{event.policy_revision ?? t("Not configured")}</Detail>
        <Detail label={t("Policy ID")}>{event.policy_id ?? t("Not configured")}</Detail>
        <Detail label={t("Matched policies")}>{event.matched_policy_refs?.length ? event.matched_policy_refs.map((ref) => `${ref.policy_display_name} · r${ref.policy_revision} · ${ref.rule_ids.join(", ") || t("No matching rule")}`).join(" | ") : t("No matched policy")}</Detail>
        <Detail label={t("Authorization event")}>{event.phase === "PREVIEW" ? t("Not applicable") : event.authorization_audit_event_id ?? t("This event")}</Detail>
        <Detail label={t("Correlation")}>{event.correlation_id}</Detail>
        <Detail label={t("Occurred")}>{relativeTime(event.occurred_at)}</Detail>
      </div>
      <div className="space-y-5 p-6">
        <div>
          <h3 className="font-semibold">{t("Runtime constraints")}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{t("Only constraints returned by the verified One Policy decision are shown.")}</p>
          {event.constraints?.length ? <pre className="mt-3 overflow-x-auto rounded-lg border bg-muted/20 p-3 font-mono text-xs">{JSON.stringify(event.constraints, null, 2)}</pre> : <p className="mt-2 text-sm">{t("No constraints")}</p>}
        </div>
        <div>
          <h3 className="font-semibold">{t("Runtime obligations")}</h3>
          {event.obligations?.length ? <pre className="mt-3 overflow-x-auto rounded-lg border bg-muted/20 p-3 font-mono text-xs">{JSON.stringify(event.obligations, null, 2)}</pre> : <p className="mt-2 text-sm">{t("No obligations")}</p>}
        </div>
      </div>
    </SheetContent>
  )
}

export function AuditDecisionSheet({
  event,
  executionActivity,
  accounting,
  accessRequest,
  data,
  open,
  onOpenChange,
}: {
  event: AuditEvent | null
  executionActivity: ApiGatewayActivityEvent | null
  accounting: InvocationAccountingRecord | null
  accessRequest: AccessRequest | null
  data: Pick<OverviewSnapshot, "applications" | "connections" | "identity" | "resources">
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  if (!event) return null
  if (event.kind === "RUNTIME_POLICY_DECISION") {
    return <Sheet open={open} onOpenChange={onOpenChange}><RuntimeAuditDetails event={event} data={data} /></Sheet>
  }

  const decision = event.decision
  const display = createActivityDisplayDirectory(data)
  const subject = display.subject(event.subject.subject_id)
  const application = display.application(executionActivity?.application_id ?? event.acting_client.acting_client_id)
  const resource = display.resource(event.resource_id)
  const capability = display.capability(event.resource_id ?? "", event.capability_id)
  const connection = display.connection(decision?.input_receipt.mcp_connection_id)
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader className="border-b px-6 py-5">
          <SheetTitle>{t("Policy Decision details")}</SheetTitle>
          <SheetDescription className="font-mono text-xs">{event.correlation_id}</SheetDescription>
        </SheetHeader>

        <div className="grid grid-cols-2 gap-x-5 gap-y-4 border-b p-6 text-sm">
          <Detail label={t("Outcome")}><Badge variant={event.outcome === "BLOCKED" || event.outcome === "DENY" ? "destructive" : "secondary"}>{t(event.outcome)}</Badge></Detail>
          <Detail label={t("Occurred")}>{relativeTime(event.occurred_at)}</Detail>
          <EntityDetail label={t("Subject")} entity={subject} id={event.subject.subject_id} metadata={t(event.subject.evidence_level)} />
          <EntityDetail label={t("Acting Client")} entity={application} id={event.acting_client.acting_client_id} metadata={t(event.acting_client.evidence_level)} />
          <EntityDetail label={t("Resource")} entity={resource} id={event.resource_id} />
          <EntityDetail label={t("Capability")} entity={capability} id={event.capability_id} />
          <Detail label={t("Device")}>{event.device_id ?? "—"}</Detail>
          <Detail label={t("Enforcement point")}>{event.enforcement_point_id ?? "—"}</Detail>
          <Detail label={t("Route")}>{event.route || decision?.route ? t(event.route ?? decision?.route ?? "—") : "—"}</Detail>
          <Detail label={t("Upstream attempted")}>{event.upstream_attempted ? t("Yes") : t("No")}</Detail>
          {event.entitlement_revocation_generation != null ? (
            <Detail label={t("Entitlement revoke generation")}>{event.entitlement_revocation_generation}</Detail>
          ) : null}
        </div>

        {executionActivity ? (
          <div className="border-b bg-muted/20 p-6" data-testid="correlated-execution-outcome">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold">{t("Gateway execution outcome")}</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {event.outcome === "ALLOW" && executionActivity.outcome !== "COMPLETED"
                    ? t("Authorization succeeded; a later Gateway stage denied or failed the request.")
                    : t("Final Gateway execution correlated to this policy decision.")}
                </p>
              </div>
              <Badge variant={executionActivity.outcome === "COMPLETED" ? "outline" : "destructive"}>{t(executionActivity.outcome)}</Badge>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-4 text-sm">
              <Detail label={t("HTTP Request")}>{executionActivity.method} {executionActivity.path}</Detail>
              <Detail label={t("Status code")}>{executionActivity.status_code}</Detail>
              <Detail label={t("Error code")}>{executionActivity.error_code ?? "—"}</Detail>
              <Detail label={t("Upstream attempted")}>{executionActivity.upstream_attempted ? t("Yes") : t("No")}</Detail>
              <Detail label={t("Usage admission")}>{t(executionActivity.usage_admission_disposition)}</Detail>
              <Detail label={t("Admission ID")}>{executionActivity.usage_admission_id ?? "—"}</Detail>
              <Detail label={t("Admission reason")}>{executionActivity.usage_admission_reason ? t(executionActivity.usage_admission_reason) : "—"}</Detail>
              <Detail label={t("Consumer Organization")}>{executionActivity.consumer_organization_id ?? "—"}</Detail>
              <Detail label={t("Resource Owner Organization")}>{executionActivity.resource_owner_organization_id ?? "—"}</Detail>
              <Detail label={t("Use Case")}>{executionActivity.use_case_id ?? "—"}</Detail>
            </div>
          </div>
        ) : null}

        {event.runaway_trigger ? (
          <div className="border-b bg-destructive/5 p-6">
            <h3 className="font-semibold">{t("Runaway invocation guard")}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{t("The Gateway suspended the configured scope before contacting the upstream.")}</p>
            <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-4">
              <Detail label={t("Trigger condition")}>{event.runaway_trigger.requests} / {event.runaway_trigger.window_seconds} {t("seconds")}</Detail>
              <Detail label={t("Affected scope")}>{t(event.runaway_trigger.scope)}</Detail>
              <Detail label={t("Disposition")}>{t(event.runaway_trigger.state)}</Detail>
              <Detail label={t("Suspension")}>{event.runaway_trigger.suspend_seconds} {t("seconds")}</Detail>
            </div>
          </div>
        ) : null}

        {decision ? (
          <div className="space-y-5 p-6">
            <div>
              <h3 className="font-semibold">{t("One Policy decision")}</h3>
              <p className="text-sm text-muted-foreground">{t("Canonical decision and obligations evaluated before enforcement.")}</p>
            </div>
            <div className="grid grid-cols-2 gap-x-5 gap-y-4">
              <Detail label={t("Decision ID")}>{decision.decision_id}</Detail>
              <Detail label={t("Policy version")}>{decision.policy_version}</Detail>
              <Detail label={t("Winning rule")}>{decision.winning_rule_id ?? t("No matching rule")}</Detail>
              <Detail label={t("Reason")}>{typeof decision.reason === "string" ? decision.reason : JSON.stringify(decision.reason)}</Detail>
              <Detail label={t("Visibility")}>{t(decision.visibility)}</Detail>
              <Detail label={t("Access")}>{t(decision.access)}</Detail>
              <Detail label={t("Route")}>{t(decision.route)}</Detail>
              <Detail label={t("Entitlement")}>{event.entitlement_id ?? decision.entitlement_id ?? "—"}</Detail>
              <Detail label={t("Requested model")}>{decision.input_receipt.requested_model_id ?? "—"}</Detail>
              <Detail label={t("Effective model")}>{decision.input_receipt.effective_model_id ?? "—"}</Detail>
              <Detail label={t("MCP method")}>{decision.input_receipt.mcp_method ?? "—"}</Detail>
              <Detail label={t("Mcp-Name")}>{decision.input_receipt.mcp_tool ?? decision.input_receipt.mcp_name ?? "—"}</Detail>
              <Detail label={t("MCP protocol version")}>{decision.input_receipt.mcp_protocol_version ?? "—"}</Detail>
              <EntityDetail label={t("Connection")} entity={connection} id={decision.input_receipt.mcp_connection_id} />
            </div>
            {decision.agent_authority ? <div className="rounded-lg border bg-muted/10 p-4" data-testid="agent-authority-evidence">
              <h4 className="font-medium">{t("Agent authority")}</h4>
              <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                <Detail label={t("Authority mode")}>{decision.agent_authority.authority_mode}</Detail>
                <Detail label={t("Agent Subject")}>{decision.agent_authority.agent_subject_id}</Detail>
                <Detail label={t("Principal")}>{decision.agent_authority.principal_subject_id ?? "—"}</Detail>
                <Detail label={t("Delegation")}>{decision.agent_authority.delegation_id ?? "—"}</Detail>
                <Detail label={t("Delegation revision")}>{decision.agent_authority.delegation_revision ?? "—"}</Detail>
                <Detail label={t("Revocation generation")}>{decision.agent_authority.delegation_revocation_generation ?? "—"}</Detail>
                <Detail label={t("Target Agent")}>{decision.agent_authority.target_agent_subject_id ?? "—"}</Detail>
                <Detail label={t("Execution Grant")}>{decision.agent_authority.execution_grant_id ?? "—"}</Detail>
                <Detail label={t("Action digest")}>{decision.agent_authority.action_digest ?? "—"}</Detail>
              </dl>
            </div> : null}
            {decision.access === "REQUEST" ? (
              <div className="rounded-lg border border-dashed bg-muted/10 p-4" data-testid="mcp-input-required">
                <h4 className="font-medium">{t("Input required")}</h4>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("The Gateway withheld the MCP payload until an Access Request is approved; raw payload was not collected.")}
                </p>
                <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                  <Detail label={t("Required input type")}>{t("ACCESS_REQUEST")}</Detail>
                  <Detail label={t("Request status")}>{accessRequest ? t(accessRequest.state) : t("Not created")}</Detail>
                  <Detail label={t("Access Request")}>{accessRequest?.access_request_id ?? event.access_request_id ?? t("Not created")}</Detail>
                  <Detail label={t("Retry correlation")}>{event.correlation_id}</Detail>
                </dl>
              </div>
            ) : null}
            {decision.input_receipt.mcp_authorization ? (
              <div className="rounded-lg border bg-muted/10 p-4">
                <h4 className="font-medium">{t("MCP authorization metadata")}</h4>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("The Decision Receipt carries the Resource authorization contract separately from Connection credentials.")}
                </p>
                <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-muted-foreground">{t("MCP Resource identifier")}</dt>
                    <dd className="mt-0.5 break-all font-mono text-xs">{decision.input_receipt.mcp_authorization.resource}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">{t("Required issuer")}</dt>
                    <dd className="mt-0.5 break-all font-mono text-xs">{decision.input_receipt.mcp_authorization.required_issuer}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">{t("Authorization servers")}</dt>
                    <dd className="mt-0.5 break-all font-mono text-xs">{decision.input_receipt.mcp_authorization.authorization_servers.join(", ")}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">{t("Supported scopes")}</dt>
                    <dd className="mt-0.5 break-all font-mono text-xs">{decision.input_receipt.mcp_authorization.scopes_supported.join(", ")}</dd>
                  </div>
                </dl>
              </div>
            ) : null}
            <div>
              <div className="text-xs text-muted-foreground">{t("Obligations")}</div>
              {decision.obligations.length ? (
                <div className="mt-2 space-y-2">
                  {decision.obligations.map((obligation, index) => (
                    <div key={`${obligation.kind}-${index}`} className="rounded-md border bg-muted/30 p-3">
                      <div className="font-medium">{t(obligation.kind)}</div>
                      <div className="mt-1 font-mono text-xs text-muted-foreground">{obligation.enforcement_point_id}</div>
                      {obligation.parameters.length ? <div className="mt-2 font-mono text-xs">{obligation.parameters.map(([key, value]) => `${key}=${value}`).join(" · ")}</div> : null}
                    </div>
                  ))}
                </div>
              ) : <div className="mt-1 text-sm">{t("No obligations")}</div>}
            </div>
            {accounting ? (
              <div className="rounded-lg border bg-muted/10 p-4" data-testid="mcp-usage-facts">
                <h4 className="font-medium">{t("Usage facts")}</h4>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("Canonical accounting is correlated to the admitted invocation and one charge.")}
                </p>
                <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                  <Detail label={t("Consumer Organization")}>{accounting.invocation.consumer_organization_id}</Detail>
                  <Detail label={t("Resource Owner Organization")}>{accounting.invocation.resource_owner_organization_id}</Detail>
                  <Detail label={t("Use Case")}>{accounting.invocation.use_case_id}</Detail>
                  <Detail label={t("Release revision")}>{accounting.invocation.release_revision}</Detail>
                  <Detail label={t("Usage Policy revisions")}>{accounting.invocation.usage_policy_revisions.join(" · ")}</Detail>
                  <Detail label={t("Accounting key")}>{accounting.invocation.accounting_key_id}</Detail>
                  <Detail label={t("Canonical charge")}>{accounting.charge.charge_id}</Detail>
                  <Detail label={t("Quantities")}>{accounting.quantities.map((value) => `${value.unit}: ${value.quantity}`).join(" · ") || t("Not collected")}</Detail>
                  <Detail label={t("Quantity source")}>{[...new Set(accounting.quantities.map((value) => value.trusted_source))].join(" · ") || t("Not collected")}</Detail>
                  <Detail label={t("Cost valuations")}>{accounting.valuations.map((value) => `${value.status} ${value.currency} ${(value.amount_micros / 1_000_000).toFixed(6)}`).join(" · ") || t("Not collected")}</Detail>
                  <Detail label={t("Pricing provenance")}>{accounting.valuations.map((value) => `${value.pricing_source}@${value.pricing_version}`).join(" · ") || t("Not collected")}</Detail>
                </dl>
              </div>
            ) : decision.input_receipt.mcp_method ? (
              <div className="rounded-lg border bg-muted/10 p-4" data-testid="mcp-usage-facts">
                <h4 className="font-medium">{t("Usage facts")}</h4>
                <p className="mt-1 text-sm text-muted-foreground">{t("Not collected")}</p>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="p-6 text-sm text-muted-foreground">
            {t("This correlated event does not contain a Policy Decision payload.")}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
