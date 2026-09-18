import { RelationValue } from "@/components/relation-value"
import { createActivityDisplayDirectory } from "@/features/activity/activity-display"
import type { OverviewSnapshot } from "@/domain/contracts"
import { useEffect, useMemo, useState, type FormEvent } from "react"
import { LoaderCircleIcon, ShieldXIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import type { Entitlement } from "@/domain/contracts"
import { revokeEntitlement } from "@/lib/product-api"

export function RevokeEntitlementSheet({
  tenantId,
  data,
  entitlement,
  open,
  onOpenChange,
  onRevoked,
}: {
  tenantId: string
  data: OverviewSnapshot
  entitlement: Entitlement | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onRevoked: () => Promise<void>
}) {
  const { t } = useTranslation()
  const display = useMemo(() => createActivityDisplayDirectory(data), [data])
  const [reason, setReason] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!open) return
    setReason("")
    setError("")
  }, [open, entitlement?.entitlement_id])

  if (!entitlement) return null
  const currentEntitlement = entitlement

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!reason.trim()) return setError(t("Provide a revocation reason."))
    setSubmitting(true)
    setError("")
    try {
      await revokeEntitlement(tenantId, currentEntitlement.entitlement_id, reason.trim())
      await onRevoked()
      onOpenChange(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Entitlement revocation failed"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <form className="flex min-h-full flex-col" onSubmit={(event) => void submit(event)}>
          <SheetHeader className="border-b px-6 py-5">
            <SheetTitle>{t("Revoke Entitlement")}</SheetTitle>
            <SheetDescription className="font-mono text-xs">{entitlement.entitlement_id}</SheetDescription>
          </SheetHeader>
          <div className="grid grid-cols-2 gap-4 border-b p-6 text-sm">
            <div><div className="text-xs text-muted-foreground">{t("Target Subject")}</div><div className="mt-1 font-medium"><RelationValue id={entitlement.subject_id} label={display.subject(entitlement.subject_id).label} /></div></div>
            <div><div className="text-xs text-muted-foreground">{t("State")}</div><Badge className="mt-1" variant="secondary">{t(entitlement.state)}</Badge></div>
            <div className="col-span-2"><div className="text-xs text-muted-foreground">{t("Resource / Capability")}</div><div className="mt-1 font-medium"><RelationValue id={entitlement.resource_id} label={display.resource(entitlement.resource_id).label} href={`?view=resources&resource=${encodeURIComponent(entitlement.resource_id)}`} /></div><div className="font-mono text-xs text-muted-foreground">{display.capability(entitlement.resource_id, entitlement.capability_id).label}</div></div>
          </div>
          <FieldGroup className="p-6">
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor="revocation-reason">{t("Revocation reason")}</FieldLabel>
              <Textarea id="revocation-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t("Explain why access must be revoked now")} />
              <FieldDescription>{t("Revocation immediately invalidates future invocation authorization and refreshes runtime policy state.")}</FieldDescription>
              {error ? <FieldError>{error}</FieldError> : null}
            </Field>
          </FieldGroup>
          <SheetFooter className="mt-auto border-t px-6 py-5">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t("Cancel")}</Button>
            <Button type="submit" variant="destructive" disabled={submitting || !reason.trim()}>
              {submitting ? <LoaderCircleIcon className="animate-spin" /> : <ShieldXIcon />}{t("Revoke now")}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
