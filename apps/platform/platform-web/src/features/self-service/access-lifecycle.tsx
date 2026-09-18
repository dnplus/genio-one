import { BellIcon, CalendarClockIcon, CheckCircle2Icon, ShieldAlertIcon, XCircleIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Badge } from "@/components/ui/badge"
import { TitleHelp } from "@/components/title-help"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import type { AccessNotification, AccessRequest, ApiVersionMigrationNotice } from "@/domain/contracts"
import { relativeTime } from "@/lib/format"

export interface AccessDisplayDirectory {
  capability(resourceId: string, capabilityId: string): {
    resource: string
    capability: string
  }
  organization(organizationId: string): string
  subject(subjectId: string): string
  application(applicationId: string): string
}

function readableIdentifier(value: string): string {
  return value
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

const fallbackDisplay: AccessDisplayDirectory = {
  capability: (resourceId, capabilityId) => ({
    resource: readableIdentifier(resourceId),
    capability: readableIdentifier(capabilityId),
  }),
  organization: readableIdentifier,
  subject: readableIdentifier,
  application: readableIdentifier,
}

export function AccessUpdates({
  requests,
  notifications,
  apiVersionMigrationNotices = [],
  onSelectRequest,
  display,
}: {
  requests: AccessRequest[]
  notifications: AccessNotification[]
  apiVersionMigrationNotices?: ApiVersionMigrationNotice[]
  onSelectRequest: (request: AccessRequest) => void
  display?: AccessDisplayDirectory
}) {
  const { t } = useTranslation()
  const directory = display ?? fallbackDisplay

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2"><BellIcon className="size-4" /><TitleHelp help={t("Access lifecycle and governance alerts from the Product API.")}>{t("Access updates")}</TitleHelp></CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {apiVersionMigrationNotices.length ? (
          <div className="divide-y border-b">
            {apiVersionMigrationNotices.slice(0, 8).map((notice) => {
              const Icon = notice.kind === "MIGRATED" ? CheckCircle2Icon : notice.kind === "RETIRED" ? XCircleIcon : CalendarClockIcon
              return (
                <div key={`${notice.application_id}:${notice.resource_id}`} className="flex items-start gap-3 px-6 py-4">
                  <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-muted"><Icon className="size-4" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{t(`API version ${notice.kind.toLowerCase()}`)}</span>
                    <span className="block text-xs text-muted-foreground">{notice.application_id} · {notice.resource_id} → {notice.replacement_resource_id} · {notice.migration_path}</span>
                    <span className="mt-1 block text-sm">{notice.release_summary}</span>
                    <span className="block text-xs text-muted-foreground">{notice.migration_guidance} · {t("Migration deadline")} {relativeTime(notice.migration_deadline)}{notice.delivery_channels?.length ? ` · ${notice.delivery_channels.map((channel) => t(channel)).join(", ")}` : ""}</span>
                  </span>
                </div>
              )
            })}
          </div>
        ) : null}
        {notifications.length ? (
          <div className="divide-y">
            {notifications.slice(0, 8).map((notification) => {
              const request = requests.find((item) => item.access_request_id === notification.access_request_id)
              const capability = directory.capability(notification.resource_id, notification.capability_id)
              const title = notification.kind === "PENDING_APPROVAL" ? "Access Request awaiting your approval" : notification.kind === "REQUEST_APPROVED" ? "Access approved" : notification.kind === "REQUEST_DENIED" ? "Access denied" : notification.kind === "RUNAWAY_INVOCATION_SUSPENDED" ? "Runaway invocation suspended" : "Entitlement expires soon"
              const Icon = notification.kind === "REQUEST_APPROVED" ? CheckCircle2Icon : notification.kind === "REQUEST_DENIED" ? XCircleIcon : notification.kind === "ENTITLEMENT_EXPIRING" ? CalendarClockIcon : notification.kind === "RUNAWAY_INVOCATION_SUSPENDED" ? ShieldAlertIcon : BellIcon
              return (
                <div key={notification.notification_id} className="flex items-center gap-2 px-3">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-3 px-3 py-4 text-left transition-colors hover:bg-muted/40 disabled:cursor-default"
                    disabled={!request}
                    onClick={() => request && onSelectRequest(request)}
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted"><Icon className="size-4" /></span>
                    <span className="min-w-0 flex-1"><span className="block font-medium">{t(title)}</span><span className="block truncate text-xs text-muted-foreground">{capability.resource} / {capability.capability}{notification.requester ? ` · ${t("Requester")}: ${directory.subject(notification.requester)}` : ""}{notification.runaway_trigger ? ` · ${notification.runaway_trigger.requests}/${notification.runaway_trigger.window_seconds}s · ${t(notification.runaway_trigger.scope)}` : ""}{notification.valid_until ? ` · ${t("Valid until")} ${relativeTime(notification.valid_until)}` : ""}{notification.delivery_channels?.length ? ` · ${notification.delivery_channels.map((channel) => t(channel)).join(", ")}` : ""}</span></span>
                    <span className="text-xs text-muted-foreground">{relativeTime(notification.occurred_at)}</span>
                  </button>
                  {notification.entitlement_id && notification.audience !== "RESOURCE_OWNER" ? (
                    <Button asChild size="sm" variant="ghost"><a href={notification.action_path}>{t("Open Resource")}</a></Button>
                  ) : null}
                </div>
              )
            })}
          </div>
        ) : apiVersionMigrationNotices.length ? null : <p className="px-6 py-8 text-sm text-muted-foreground">{t("No access updates require your attention.")}</p>}
      </CardContent>
    </Card>
  )
}

export function SelfServiceRequestSheet({
  request,
  open,
  onOpenChange,
  busy,
  onCancel,
  display,
}: {
  request: AccessRequest | null
  open: boolean
  onOpenChange: (open: boolean) => void
  busy: boolean
  onCancel: (requestId: string) => Promise<void>
  display?: AccessDisplayDirectory
}) {
  const { t } = useTranslation()
  if (!request) return null
  const directory = display ?? fallbackDisplay
  const capability = directory.capability(request.resource_id, request.capability_id)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader className="border-b px-6 py-5">
          <SheetTitle>{t("Access Request details")}</SheetTitle>
          <SheetDescription>{capability.resource} · {capability.capability}</SheetDescription>
        </SheetHeader>
        <div className="grid grid-cols-2 gap-x-5 gap-y-5 p-6 text-sm">
          <Detail label={t("State")}><Badge variant={request.state === "DENIED" ? "destructive" : "secondary"}>{t(request.state)}</Badge></Detail>
          <Detail label={t("Created")}>{relativeTime(request.created_at)}</Detail>
          <Detail label={t("Requester")}>{directory.subject(request.requester)}</Detail>
          <Detail label={t("Target Subject")}>{directory.subject(request.target_subject)}</Detail>
          <Detail label={t("Acting Client")}>{request.acting_client.acting_client_id ? directory.application(request.acting_client.acting_client_id) : t("Unknown")}</Detail>
          <Detail label={t("Resource Owner")}>{directory.organization(request.approver)}</Detail>
          <Detail label={t("Requested duration")}>{t("{{hours}} hours", { hours: request.requested_valid_for / 3_600 })}</Detail>
          {request.configuration_revision ? <Detail label={t("Configuration revision")}>{request.configuration_revision}</Detail> : null}
          {request.approval_workflow_version ? <Detail label={t("Approval workflow")}>{request.approval_workflow_version}</Detail> : null}
          <Detail className="col-span-2" label={t("Resource / Capability")}><div className="font-medium">{capability.resource}</div><div className="text-xs text-muted-foreground">{capability.capability}</div></Detail>
          <Detail className="col-span-2" label={t("Justification")}><p className="whitespace-pre-wrap rounded-md bg-muted p-3">{request.justification}</p></Detail>
          <Detail label={t("Policy version")}>{request.policy_version_at_creation}</Detail>
          {request.resolved_at ? <Detail label={t("Resolved")}>{relativeTime(request.resolved_at)}</Detail> : null}
          {request.resolution_reason ? <Detail className="col-span-2" label={t("Resolution reason")}><p className="whitespace-pre-wrap">{request.resolution_reason}</p></Detail> : null}
        </div>
        <SheetFooter className="border-t px-6 py-5">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("Close")}</Button>
          {request.state === "PENDING" ? <Button variant="destructive" disabled={busy} onClick={() => void onCancel(request.access_request_id)}>{t("Cancel request")}</Button> : null}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function Detail({ label, className = "", children }: { label: string; className?: string; children: React.ReactNode }) {
  return <div className={className}><div className="mb-1 text-xs text-muted-foreground">{label}</div><div className="font-medium">{children}</div></div>
}
