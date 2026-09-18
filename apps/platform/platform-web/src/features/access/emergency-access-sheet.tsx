import { useEffect, useMemo, useState, type FormEvent } from "react"
import { LoaderCircleIcon, ShieldAlertIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import type { Entitlement, IdentitySession } from "@/domain/contracts"
import { beginBrowserLogin } from "@/lib/browser-oidc"
import { formatEpochSeconds } from "@/lib/personal-preferences"
import { grantEmergencyAccess } from "@/lib/product-api"

export type EmergencyCapability = {
  resourceId: string
  resourceName: string
  capabilityId: string
  capabilityName: string
  maxValidFor: number
}

function capabilityKey(capability: EmergencyCapability) {
  return `${capability.resourceId}\u0000${capability.capabilityId}`
}

function hasEmergencyMfa(identity: IdentitySession) {
  const strongAmr = (identity.amr ?? []).some((method) =>
    ["mfa", "otp", "hwk", "webauthn"].includes(method.toLowerCase()),
  )
  const acrLevel = Number(identity.acr?.split(/[:/]/).at(-1))
  return strongAmr || (Number.isInteger(acrLevel) && acrLevel >= 2)
}

export function EmergencyAccessSheet({
  tenantId,
  identity,
  capabilities,
  onGranted,
}: {
  tenantId: string
  identity: IdentitySession
  capabilities: EmergencyCapability[]
  onGranted: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [selectedKey, setSelectedKey] = useState("")
  const [reason, setReason] = useState("")
  const [validForSeconds, setValidForSeconds] = useState(30)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")
  const [granted, setGranted] = useState<Entitlement | null>(null)
  const mfaVerified = hasEmergencyMfa(identity)
  const selected = useMemo(
    () => capabilities.find((capability) => capabilityKey(capability) === selectedKey) ?? null,
    [capabilities, selectedKey],
  )

  useEffect(() => {
    if (!open) return
    const first = capabilities[0]
    setSelectedKey(first ? capabilityKey(first) : "")
    setReason("")
    setValidForSeconds(Math.min(30, first?.maxValidFor ?? 30))
    setError("")
    setGranted(null)
  }, [open])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!selected) return setError(t("Choose an Emergency Access capability."))
    if (!mfaVerified) return setError(t("MFA step-up is required before Emergency Access can be granted."))
    if (!reason.trim()) return setError(t("Provide an Emergency Access reason."))
    if (!Number.isInteger(validForSeconds) || validForSeconds < 5 || validForSeconds > selected.maxValidFor) {
      return setError(t("Emergency Access duration exceeds the active policy limit."))
    }

    setSubmitting(true)
    setError("")
    try {
      const entitlement = await grantEmergencyAccess(
        tenantId,
        selected.resourceId,
        selected.capabilityId,
        reason.trim(),
        validForSeconds,
      )
      setGranted(entitlement)
      await onGranted()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Emergency Access grant failed"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="destructive" disabled={!capabilities.length}>
          <ShieldAlertIcon />{t("Emergency Access")}
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <form className="flex min-h-full flex-col" onSubmit={(event) => void submit(event)}>
          <SheetHeader className="border-b px-6 py-5">
            <SheetTitle>{t("Break-glass Emergency Access")}</SheetTitle>
            <SheetDescription>{t("Creates a short-lived, self-scoped elevated Entitlement under the active One Policy.")}</SheetDescription>
          </SheetHeader>

          <div className="grid grid-cols-2 gap-4 border-b p-6 text-sm">
            <div><div className="text-xs text-muted-foreground">{t("Tenant Administrator")}</div><div className="mt-1 font-medium">{identity.subject_id}</div></div>
            <div><div className="text-xs text-muted-foreground">{t("Authentication assurance")}</div><Badge className="mt-1" variant={mfaVerified ? "secondary" : "destructive"}>{mfaVerified ? t("MFA verified") : t("MFA step-up required")}</Badge></div>
            <div className="col-span-2"><div className="text-xs text-muted-foreground">{t("AMR / ACR")}</div><div className="mt-1 font-mono text-xs">{(identity.amr ?? []).join(", ") || "—"} / {identity.acr ?? "—"}</div></div>
          </div>

          {granted ? (
            <div className="m-6 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
              <div className="font-semibold">{t("Emergency Access granted")}</div>
              <div className="mt-2 font-mono text-xs">{granted.entitlement_id}</div>
              <div className="mt-2">{granted.resource_id} / {granted.capability_id}</div>
              <div className="mt-1">{t("Valid until")}: {formatEpochSeconds(granted.valid_until)}</div>
              <div className="mt-2 text-xs text-muted-foreground">{t("Elevated audit is recorded and the Entitlement expires automatically.")}</div>
            </div>
          ) : (
            <FieldGroup className="p-6">
              {!mfaVerified ? (
                <Field>
                  <FieldDescription>{t("Emergency Access is fail-closed until the OIDC session proves a second authentication factor.")}</FieldDescription>
                  <Button type="button" variant="outline" onClick={() => void beginBrowserLogin("/management", true, { forceReauthentication: true })}>{t("Re-authenticate with MFA")}</Button>
                </Field>
              ) : null}
              <Field>
                <FieldLabel htmlFor="emergency-capability">{t("Resource / Capability")}</FieldLabel>
                <Select value={selectedKey} onValueChange={(value) => {
                  setSelectedKey(value)
                  const next = capabilities.find((capability) => capabilityKey(capability) === value)
                  if (next) setValidForSeconds(Math.min(validForSeconds, next.maxValidFor))
                }}>
                  <SelectTrigger id="emergency-capability" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup>{capabilities.map((capability) => (
                    <SelectItem key={capabilityKey(capability)} value={capabilityKey(capability)}>{capability.resourceName} · {capability.capabilityName}</SelectItem>
                  ))}</SelectGroup></SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="emergency-reason">{t("Emergency reason")}</FieldLabel>
                <Textarea id="emergency-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t("Describe the active incident and why normal approval cannot be used")} />
                <FieldDescription>{t("The reason is stored in elevated audit provenance.")}</FieldDescription>
              </Field>
              <Field data-invalid={Boolean(error)}>
                <FieldLabel htmlFor="emergency-duration">{t("Duration (seconds)")}</FieldLabel>
                <Input id="emergency-duration" type="number" min={5} max={selected?.maxValidFor ?? 3_600} step={1} value={validForSeconds} onChange={(event) => setValidForSeconds(Number(event.target.value))} />
                <FieldDescription>{t("Active policy maximum: {{seconds}} seconds", { seconds: selected?.maxValidFor ?? 0 })}</FieldDescription>
                {error ? <FieldError>{t(error)}</FieldError> : null}
              </Field>
            </FieldGroup>
          )}

          <SheetFooter className="mt-auto border-t px-6 py-5">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>{t("Close")}</Button>
            {!granted ? (
              <Button type="submit" variant="destructive" disabled={submitting || !mfaVerified || !selected || !reason.trim()}>
                {submitting ? <LoaderCircleIcon className="animate-spin" /> : <ShieldAlertIcon />}{t("Grant Emergency Access")}
              </Button>
            ) : null}
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
