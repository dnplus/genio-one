import { useTranslation } from "react-i18next"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { isGovernanceAuditEvent } from "@/domain/audit-events"
import type { AuditEvent } from "@/domain/contracts"
import { relativeTime } from "@/lib/format"

export function AuditQueryTable({ events, onOpen }: { events: AuditEvent[]; onOpen: (event: AuditEvent) => void }) {
  const { t } = useTranslation()
  return <div className="mt-6 min-w-0 rounded-lg border">
    <div className="border-b px-4 py-3">
      <div className="font-medium">{t("Queried Audit Events")}</div>
      <div className="text-xs text-muted-foreground">{t("Open an event to inspect its verified identity and correlation.")}</div>
    </div>
    <Table>
      <TableHeader><TableRow>
        <TableHead>{t("Audit Event")}</TableHead><TableHead>{t("Outcome")}</TableHead>
        <TableHead>{t("Policy / Target")}</TableHead><TableHead>{t("Subject / Acting Client")}</TableHead>
        <TableHead>{t("Correlation")}</TableHead><TableHead className="text-right">{t("Occurred")}</TableHead>
      </TableRow></TableHeader>
      <TableBody>{events.map((event) => {
        const governance = isGovernanceAuditEvent(event)
        const target = governance
          ? event.kind === "POLICY_CHANGE" ? event.policy_key : event.access_group_id
          : event.kind === "RUNTIME_POLICY_DECISION"
            ? `${event.policy_display_name ?? event.policy_id ?? t("Runtime capability policy")}${event.policy_revision == null ? "" : ` · r${event.policy_revision}`}`
            : event.decision?.policy_version ?? "—"
        const action = governance
          ? event.kind === "POLICY_CHANGE" ? event.action : event.operation
          : event.target ?? ""
        return <TableRow key={event.audit_event_id} aria-label={t("View details")}
          className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          onClick={() => onOpen(event)} onKeyDown={(keyboardEvent) => {
            if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") {
              keyboardEvent.preventDefault()
              onOpen(event)
            }
          }} tabIndex={0}>
          <TableCell><div className="font-mono text-xs">{event.audit_event_id}</div><div className="text-xs text-muted-foreground">{t(event.kind)}</div></TableCell>
          <TableCell><Badge variant={event.outcome === "FAILED" || event.outcome === "DENY" ? "destructive" : "outline"}>{t(event.outcome)}</Badge>
            {!governance && event.kind === "RUNTIME_POLICY_DECISION" && event.report_outcome ? <div className="mt-1 text-xs text-muted-foreground">{t("Result")}: {t(event.report_outcome)}</div> : null}
          </TableCell>
          <TableCell><div className="max-w-56 truncate font-medium" title={target}>{target}</div><div className="max-w-56 truncate text-xs text-muted-foreground" title={action}>{t(action)}</div></TableCell>
          <TableCell><div className="font-medium">{event.subject.subject_id}</div><div className="text-xs text-muted-foreground">{governance ? t(event.actor_subject.evidence_level) : event.acting_client.acting_client_id ?? t("Unknown")}</div></TableCell>
          <TableCell className="max-w-64 truncate font-mono text-xs" title={event.correlation_id}>{event.correlation_id}</TableCell>
          <TableCell className="text-right text-muted-foreground">{relativeTime(event.occurred_at)}</TableCell>
        </TableRow>
      })}</TableBody>
    </Table>
  </div>
}
