import { useState } from "react"
import { LoaderCircleIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger,
} from "@/components/ui/sheet"
import type { TenantIdentityInventory } from "@/domain/contracts"
import { restoreSubject, suspendSubject } from "@/lib/product-api"

type Person = TenantIdentityInventory["subjects"][number]

export function SuspendPersonAction({ tenantId, person, isSelf, onChanged }: {
  tenantId: string
  person: Person
  /** Suspending your own Subject would end your session, so it is not offered. */
  isSelf: boolean
  onChanged: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError("")
    try {
      await action()
      await onChanged()
      setOpen(false)
      setReason("")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  if (person.suspended) {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => void run(() => restoreSubject(tenantId, person.subject_id))}
      >
        {busy ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" /> : null}
        {t("Restore access")}
      </Button>
    )
  }

  if (isSelf) return <span className="text-xs text-muted-foreground">{t("You")}</span>

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild><Button variant="outline" size="sm">{t("Suspend")}</Button></SheetTrigger>
      <SheetContent className="w-full sm:max-w-lg">
        <SheetHeader className="border-b px-6 py-5">
          <SheetTitle>{t("Suspend access")}</SheetTitle>
          <SheetDescription>{person.profile.display_name ?? person.subject_id}</SheetDescription>
        </SheetHeader>
        <FieldGroup className="p-6">
          <p className="text-sm">
            {t("This person stops being able to sign in or use Genio Bot, starting with their next request. Existing records and history are kept.")}
          </p>
          <p className="text-sm text-muted-foreground">
            {t("Suspending here does not disable the account in your identity provider. Do that as well when someone leaves.")}
          </p>
          <Field>
            <FieldLabel htmlFor="suspend-reason">{t("Reason")}</FieldLabel>
            <Input id="suspend-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
          </Field>
          {error ? <p className="text-sm text-destructive" role="alert">{t(error)}</p> : null}
        </FieldGroup>
        <SheetFooter className="mt-auto border-t bg-background px-6 py-4">
          <Button variant="outline" onClick={() => setOpen(false)}>{t("Cancel")}</Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => void run(() => suspendSubject(tenantId, person.subject_id, reason))}
          >
            {busy ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" /> : null}
            {t("Suspend")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
