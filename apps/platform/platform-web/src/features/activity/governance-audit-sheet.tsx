import { useTranslation } from "react-i18next"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import type { GovernanceAuditEvent, OverviewSnapshot } from "@/domain/contracts"
import { createActivityDisplayDirectory } from "./activity-display"

export function GovernanceAuditSheet({ event, data, open, onOpenChange }: {
  event: GovernanceAuditEvent
  data: Pick<OverviewSnapshot, "applications" | "connections" | "identity" | "resources">
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const display = createActivityDisplayDirectory(data)
  const subject = display.subject(event.subject.subject_id)
  const actor = display.subject(event.actor_subject.subject_id)
  const fields = event.kind === "POLICY_CHANGE"
    ? [
      ["Policy", event.policy_key],
      ["Action", t(event.action)],
      ["Draft", event.policy_draft_version],
      ["Based on revision", event.base_revision],
      ["Published revision", event.published_revision],
      ...(event.enabled === undefined ? [] : [["Policy state", t(event.enabled ? "ENABLED" : "DISABLED")]]),
      ["Content digest", event.content_digest],
    ] as const
    : event.kind === "ACCESS_GROUP_CHANGE" ? [
      ["Access group", event.access_group_id],
      ["Action", t(event.operation)],
      ["Based on revision", event.before_revision],
      ["Revision", event.after_revision],
    ] as const
    : [
      ["Resource", `${display.resource(event.resource_id).label} · ${event.resource_id}`],
      ["Capability", `${display.capability(event.resource_id, event.capability_id).label} · ${event.capability_id}`],
      ["Operation", t(event.operation)],
      ["Client", event.acting_client?.acting_client_id ?? "—"],
      ["Access request", event.access_request_id],
      ["Entitlement", event.entitlement_id],
    ] as const
  return <Sheet open={open} onOpenChange={onOpenChange}>
    <SheetContent presentation="workspace-panel" data-testid="governance-audit-sheet">
      <SheetHeader className="border-b p-6 pr-16">
        <SheetTitle>{t(event.kind)}</SheetTitle>
        <SheetDescription>{event.correlation_id}</SheetDescription>
      </SheetHeader>
      <dl className="grid gap-5 p-6 sm:grid-cols-2">
        <div><dt className="text-muted-foreground">{t("Subject")}</dt><dd>{subject.label}</dd><dd className="break-all text-xs text-muted-foreground">{event.subject.subject_id}</dd></div>
        <div><dt className="text-muted-foreground">{t("Actor")}</dt><dd>{actor.label}</dd><dd className="break-all text-xs text-muted-foreground">{event.actor_subject.subject_id}</dd></div>
        <div><dt className="text-muted-foreground">{t("Occurred")}</dt><dd>{new Date(event.occurred_at * 1000).toLocaleString()}</dd></div>
        {fields.map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{t(label)}</dt><dd className="break-all">{value ?? "—"}</dd></div>)}
        <div><dt className="text-muted-foreground">{t("Outcome")}</dt><dd>{t(event.outcome)}</dd></div>
        <div><dt className="text-muted-foreground">{t("Audit Event")}</dt><dd className="break-all text-xs">{event.audit_event_id}</dd></div>
      </dl>
    </SheetContent>
  </Sheet>
}
