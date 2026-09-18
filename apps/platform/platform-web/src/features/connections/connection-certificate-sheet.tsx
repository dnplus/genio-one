import { useEffect, useState, type ChangeEvent, type FormEvent } from "react"
import { AlertTriangleIcon, FileKey2Icon, LoaderCircleIcon, UploadIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import type { ConnectionSummary } from "@/domain/contracts"
import { updateResourceConnectionCertificate } from "@/lib/product-api"

function certificateLabel(status: ConnectionSummary["certificate"] extends infer Certificate
  ? Certificate extends { status: infer Status } ? Status : never
  : never): string {
  return String(status)
}

function formatCertificateDate(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—"
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value * 1_000))
}

function certificateStatusVariant(status: string): "secondary" | "outline" | "destructive" {
  if (status === "VALID") return "secondary"
  if (status === "EXPIRING") return "outline"
  if (status === "NOT_CONFIGURED") return "outline"
  return "destructive"
}

export function ConnectionCertificateSheet({
  connection,
  editable,
  onUpdated,
  tenantId,
}: {
  connection: ConnectionSummary
  editable: boolean
  onUpdated: () => Promise<void>
  tenantId: string
}) {
  const { t } = useTranslation()
  const certificate = connection.certificate
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<"SYSTEM_CA" | "CUSTOM_CA">(certificate?.mode ?? "SYSTEM_CA")
  const [pem, setPem] = useState(certificate?.certificate_pem ?? "")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!open) return
    setMode(certificate?.mode ?? "SYSTEM_CA")
    setPem(certificate?.certificate_pem ?? "")
    setError("")
  }, [certificate, open])

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    void file.text().then((value) => setPem(value))
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (mode === "CUSTOM_CA" && !pem.trim()) {
      setError(t("Import a PEM X.509 certificate or switch to system CA."))
      return
    }
    setSubmitting(true)
    setError("")
    try {
      await updateResourceConnectionCertificate(tenantId, {
        resourceId: connection.resource_id,
        connectionId: connection.connection_id,
        expectedRevision: connection.configuration_revision,
        mode,
        certificatePem: mode === "CUSTOM_CA" ? pem.trim() : null,
      })
      await onUpdated()
      setOpen(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Connection certificate update failed"))
    } finally {
      setSubmitting(false)
    }
  }

  const status = certificate?.status ?? "NOT_CONFIGURED"
  const locked = !editable || connection.lifecycle === "REVOKE_PENDING" || connection.lifecycle === "REVOKED"

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          data-testid={`connection-certificate-${connection.connection_id}`}
          size="sm"
          variant="outline"
        >
          <FileKey2Icon data-icon="inline-start" />
          {t("TLS certificate")}
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full sm:max-w-xl" data-testid="connection-certificate-sheet">
        <form className="flex min-h-full flex-col" onSubmit={submit}>
          <SheetHeader className="border-b px-6 py-5">
            <SheetTitle>{t("Connection trust certificate")}</SheetTitle>
            <SheetDescription>{connection.display_name} · {connection.connection_id}</SheetDescription>
          </SheetHeader>
          <FieldGroup className="p-6">
            <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-3">
              <Badge variant={certificateStatusVariant(status)}>
                {status === "EXPIRING" ? <AlertTriangleIcon data-icon="inline-start" /> : null}
                {t(certificateLabel(status))}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {certificate?.mode === "CUSTOM_CA" ? t("Custom trust anchor") : t("System CA store")}
              </span>
            </div>
            <Field>
              <FieldLabel>{t("Trust source")}</FieldLabel>
              <Select disabled={locked} value={mode} onValueChange={(value) => setMode(value as typeof mode)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup>
                  <SelectItem value="SYSTEM_CA">{t("System CA store")}</SelectItem>
                  <SelectItem value="CUSTOM_CA">{t("Imported custom CA / self-signed")}</SelectItem>
                </SelectGroup></SelectContent>
              </Select>
              <FieldDescription>{t("Only public X.509 certificates are accepted. Private keys and provider secrets are never stored here.")}</FieldDescription>
            </Field>
            {mode === "CUSTOM_CA" ? (
              <>
                <Field>
                  <FieldLabel htmlFor={`connection-certificate-file-${connection.connection_id}`}>{t("Import certificate file")}</FieldLabel>
                  <div className="flex items-center gap-2">
                    <input
                      accept=".pem,.crt,.cer,application/x-pem-file,application/pkix-cert"
                      className="sr-only"
                      disabled={locked}
                      id={`connection-certificate-file-${connection.connection_id}`}
                      onChange={onFileChange}
                      type="file"
                    />
                    <Button asChild disabled={locked} type="button" variant="outline">
                      <label htmlFor={`connection-certificate-file-${connection.connection_id}`}>
                        <UploadIcon data-icon="inline-start" />
                        {t("Choose PEM file")}
                      </label>
                    </Button>
                    <span className="text-xs text-muted-foreground">{t("Self-signed roots are supported")}</span>
                  </div>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`connection-certificate-pem-${connection.connection_id}`}>{t("PEM certificate chain")}</FieldLabel>
                  <Textarea
                    className="min-h-56 font-mono text-xs"
                    disabled={locked}
                    id={`connection-certificate-pem-${connection.connection_id}`}
                    onChange={(event) => setPem(event.target.value)}
                    placeholder={t("PEM certificate placeholder")}
                    spellCheck={false}
                    value={pem}
                  />
                  <FieldDescription>{t("The first certificate supplies the subject, issuer, fingerprint, and expiry shown below.")}</FieldDescription>
                </Field>
                {certificate?.mode === "CUSTOM_CA" ? (
                  <dl className="grid gap-3 rounded-lg border p-4 text-sm sm:grid-cols-2">
                    <div><dt className="text-xs text-muted-foreground">{t("Fingerprint")}</dt><dd className="mt-1 break-all font-mono text-xs">{certificate.fingerprint_sha256 ?? "—"}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">{t("Self-signed")}</dt><dd className="mt-1">{certificate.is_self_signed ? t("Yes") : t("No")}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">{t("Valid from")}</dt><dd className="mt-1">{formatCertificateDate(certificate.not_before)}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">{t("Valid until")}</dt><dd className="mt-1">{formatCertificateDate(certificate.not_after)}</dd></div>
                  </dl>
                ) : null}
              </>
            ) : null}
            {connection.lifecycle === "REVOKE_PENDING" ? <FieldDescription>{t("Certificate maintenance is locked while this Connection awaits successor Release ACK.")}</FieldDescription> : null}
            {connection.lifecycle === "REVOKED" ? <FieldDescription>{t("Revoked Connections cannot receive new trust material.")}</FieldDescription> : null}
            {certificate?.mode === "CUSTOM_CA" && certificate.status === "EXPIRING" ? <FieldDescription className="text-amber-700">{t("This certificate expires soon. Save a successor certificate before the current release reaches expiry.")}</FieldDescription> : null}
            {error ? <FieldError>{t(error)}</FieldError> : null}
          </FieldGroup>
          <SheetFooter className="mt-auto border-t bg-background px-6 py-4">
            <Button onClick={() => setOpen(false)} type="button" variant="outline">{t("Cancel")}</Button>
            <Button disabled={locked || submitting} type="submit">
              {submitting ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : null}
              {t(submitting ? "Saving…" : "Save certificate")}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
