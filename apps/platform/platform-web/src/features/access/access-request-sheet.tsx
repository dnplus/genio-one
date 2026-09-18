import { RelationValue } from "@/components/relation-value"
import { createActivityDisplayDirectory } from "@/features/activity/activity-display"
import type { OverviewSnapshot } from "@/domain/contracts"
import { useEffect, useMemo, useState, type FormEvent } from "react"
import { CheckIcon, LoaderCircleIcon, XIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import type { AccessRequest } from "@/domain/contracts"
import { relativeTime } from "@/lib/format"
import { formatEpochSeconds } from "@/lib/personal-preferences"
import { decideAccessRequest } from "@/lib/product-api"

function initialExpiry() {
  const date = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 16)
}

function requestedExpiry(request: AccessRequest | null) {
  if (!request) return initialExpiry()
  const date = new Date(Date.now() + request.requested_valid_for * 1000)
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 16)
}

export function AccessRequestSheet({
  tenantId,
  data,
  request,
  open,
  onOpenChange,
  onDecided,
}: {
  tenantId: string
  data: OverviewSnapshot
  request: AccessRequest | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onDecided: () => Promise<void>
}) {
  const { t } = useTranslation()
  const display = useMemo(() => createActivityDisplayDirectory(data), [data])
  const approverName = (id: string) => data.organizations.find((organization) => organization.organization_id === id)?.display_name ?? display.subject(id).label
  const [expiry, setExpiry] = useState(initialExpiry)
  const [reason, setReason] = useState("")
  const [submitting, setSubmitting] = useState<"approve" | "deny" | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!open) return
    setExpiry(requestedExpiry(request))
    setReason("")
    setError("")
  }, [open, request?.access_request_id])

  if (!request) return null
  const currentRequest = request
  const pending = request.state === "PENDING"

  async function decide(kind: "approve" | "deny", event: FormEvent) {
    event.preventDefault()
    setError("")
    if (kind === "approve" && !expiry) return setError(t("Choose an Entitlement expiry."))
    if (kind === "deny" && !reason.trim()) return setError(t("Provide a denial reason."))

    setSubmitting(kind)
    try {
      const decision =
        kind === "approve"
          ? { APPROVE: { valid_until: Math.floor(new Date(expiry).getTime() / 1000) } }
          : { DENY: { reason: reason.trim() } }
      await decideAccessRequest(tenantId, currentRequest.access_request_id, decision)
      await onDecided()
      onOpenChange(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Access decision failed"))
    } finally {
      setSubmitting(null)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <form className="flex min-h-full flex-col" onSubmit={(event) => void decide("approve", event)}>
          <SheetHeader className="border-b px-6 py-5">
            <SheetTitle>{t("Access Request details")}</SheetTitle>
            <SheetDescription className="font-mono text-xs">{request.access_request_id}</SheetDescription>
          </SheetHeader>

          <div className="grid grid-cols-2 gap-x-5 gap-y-4 border-b p-6 text-sm">
            <div><div className="text-xs text-muted-foreground">{t("State")}</div><Badge className="mt-1" variant={request.state === "DENIED" ? "destructive" : "secondary"}>{t(request.state)}</Badge></div>
            <div><div className="text-xs text-muted-foreground">{t("Created")}</div><div className="mt-1 font-medium">{relativeTime(request.created_at)}</div></div>
            <div><div className="text-xs text-muted-foreground">{t("Approval deadline")}</div><div className="mt-1 font-medium">{request.expires_at ? formatEpochSeconds(request.expires_at) : t("No timeout")}</div></div>
            <div><div className="text-xs text-muted-foreground">{t("Target Subject")}</div><div className="mt-1 font-medium"><RelationValue id={request.target_subject} label={display.subject(request.target_subject).label} /></div></div>
            <div><div className="text-xs text-muted-foreground">{t("Requester")}</div><div className="mt-1 font-medium"><RelationValue id={request.requester} label={display.subject(request.requester).label} /></div></div>
            <div><div className="text-xs text-muted-foreground">{t("Acting Client")}</div><div className="mt-1 font-medium"><RelationValue id={request.acting_client.acting_client_id ?? ""} label={display.application(request.acting_client.acting_client_id).label} /></div></div>
            <div><div className="text-xs text-muted-foreground">{t("Current Approver")}</div><div className="mt-1 font-medium"><RelationValue id={request.approver} label={approverName(request.approver)} /></div></div>
            <div><div className="text-xs text-muted-foreground">{t("Requested duration")}</div><div className="mt-1 font-medium">{t("{{hours}} hours", { hours: request.requested_valid_for / 3_600 })}</div></div>
            {request.configuration_revision ? <div><div className="text-xs text-muted-foreground">{t("Configuration revision")}</div><div className="mt-1 font-mono text-xs font-medium">{request.configuration_revision}</div></div> : null}
            {request.approval_workflow_version ? <div><div className="text-xs text-muted-foreground">{t("Approval workflow")}</div><div className="mt-1 font-medium">{request.approval_workflow_version}</div></div> : null}
            <div className="col-span-2"><div className="text-xs text-muted-foreground">{t("Resource / Capability")}</div><div className="mt-1 font-medium"><RelationValue id={request.resource_id} label={display.resource(request.resource_id).label} href={`?view=resources&resource=${encodeURIComponent(request.resource_id)}`} /></div><div className="font-mono text-xs text-muted-foreground">{display.capability(request.resource_id, request.capability_id).label}</div></div>
            <div className="col-span-2"><div className="text-xs text-muted-foreground">{t("Justification")}</div><p className="mt-1 whitespace-pre-wrap rounded-md bg-muted p-3">{request.justification}</p></div>
            {request.resolution_reason ? <div className="col-span-2"><div className="text-xs text-muted-foreground">{t("Resolution reason")}</div><p className="mt-1">{request.resolution_reason}</p></div> : null}
            {request.approval_stages.length ? (
              <div className="col-span-2">
                <div className="text-xs text-muted-foreground">{t("Approval stages")}</div>
                <div className="mt-2 grid gap-2">
                  {request.approval_stages.map((stage, index) => (
                    <div key={stage.stage_id} className="flex items-center justify-between rounded-md border px-3 py-2">
                      <div><div className="font-medium">{stage.stage_id}</div><div className="text-xs text-muted-foreground"><RelationValue id={stage.assigned_approver} label={approverName(stage.assigned_approver)} /></div></div>
                      <Badge variant={stage.state === "APPROVED" ? "secondary" : "outline"}>{index === request.current_approval_stage && stage.state === "PENDING" ? t("Current stage") : t(stage.state)}</Badge>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          {pending ? (
            <FieldGroup className="p-6">
              <Field data-invalid={Boolean(error)}>
                <FieldLabel htmlFor="entitlement-expiry">{t("Entitlement expiry")}</FieldLabel>
                <Input id="entitlement-expiry" type="datetime-local" value={expiry} onChange={(event) => setExpiry(event.target.value)} />
                <FieldDescription>{t("Approval grants a time-bounded Entitlement to the Target Subject.")}</FieldDescription>
              </Field>
              <Field data-invalid={Boolean(error)}>
                <FieldLabel htmlFor="denial-reason">{t("Denial reason")}</FieldLabel>
                <Textarea id="denial-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t("Explain why access cannot be granted")} />
                <FieldDescription>{t("Required only when denying the request.")}</FieldDescription>
                {error ? <FieldError>{error}</FieldError> : null}
              </Field>
            </FieldGroup>
          ) : null}

          <SheetFooter className="mt-auto border-t px-6 py-5">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t("Close")}</Button>
            {pending ? <>
              <Button type="button" variant="destructive" disabled={Boolean(submitting)} onClick={(event) => void decide("deny", event)}>
                {submitting === "deny" ? <LoaderCircleIcon className="animate-spin" /> : <XIcon />}{t("Deny")}
              </Button>
              <Button type="submit" disabled={Boolean(submitting)}>
                {submitting === "approve" ? <LoaderCircleIcon className="animate-spin" /> : <CheckIcon />}{t("Approve")}
              </Button>
            </> : null}
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
