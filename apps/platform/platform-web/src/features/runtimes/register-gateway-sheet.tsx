import { useMemo, useState, type FormEvent, type ReactNode } from "react"
import { CheckIcon, ClipboardIcon, DownloadIcon, LoaderCircleIcon, PlusIcon, RotateCwIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import type {
  GatewayBootstrapConfiguration,
  RegisterGatewayInput,
} from "@/domain/contracts"
import { provisionGateway, registerGateway } from "@/lib/product-api"

const initialInput: RegisterGatewayInput = {
  displayName: "",
  siteId: "",
  region: "",
  labels: {},
}

function bootstrapDownloadName(runtimeId: string) {
  const safeRuntimeId = runtimeId.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "gateway"
  return `${safeRuntimeId}.json`
}

interface RegisterGatewaySheetProps {
  tenantId: string
  onRegistered: () => Promise<void>
  retryRuntimeId?: string
  trigger?: ReactNode
}

export function RegisterGatewaySheet({
  tenantId,
  onRegistered,
  retryRuntimeId,
  trigger,
}: RegisterGatewaySheetProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState(initialInput)
  const [labelKey, setLabelKey] = useState("")
  const [labelValue, setLabelValue] = useState("")
  const [bootstrap, setBootstrap] = useState<GatewayBootstrapConfiguration | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")
  const [copied, setCopied] = useState(false)
  const retry = Boolean(retryRuntimeId)

  const bootstrapJson = useMemo(
    () => (bootstrap ? JSON.stringify(bootstrap, null, 2) : ""),
    [bootstrap],
  )

  function update<Key extends keyof RegisterGatewayInput>(
    key: Key,
    value: RegisterGatewayInput[Key],
  ) {
    setInput((current) => ({ ...current, [key]: value }))
  }

  function resetSensitiveState() {
    setBootstrap(null)
    setCopied(false)
  }

  function changeOpen(nextOpen: boolean) {
    setOpen(nextOpen)
    if (!nextOpen) {
      resetSensitiveState()
      setError("")
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")
    setSubmitting(true)
    try {
      const labels = labelKey.trim() && labelValue.trim()
        ? { [labelKey.trim()]: labelValue.trim() }
        : {}
      const result = await registerGateway(tenantId, { ...input, labels })
      setBootstrap(result)
      await onRegistered()
      setInput(initialInput)
      setLabelKey("")
      setLabelValue("")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Gateway registration failed"))
    } finally {
      setSubmitting(false)
    }
  }

  async function retryProvisioning() {
    if (!retryRuntimeId) return
    setError("")
    setSubmitting(true)
    try {
      const result = await provisionGateway(tenantId, retryRuntimeId)
      setBootstrap(result)
      setOpen(true)
      await onRegistered()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Gateway provisioning failed"))
      setOpen(true)
    } finally {
      setSubmitting(false)
    }
  }

  async function copyBootstrap() {
    await navigator.clipboard.writeText(bootstrapJson)
    setCopied(true)
  }

  function downloadBootstrap() {
    if (!bootstrap) return
    const url = URL.createObjectURL(new Blob([bootstrapJson], { type: "application/json" }))
    const link = document.createElement("a")
    link.href = url
    link.download = bootstrapDownloadName(bootstrap.registration.runtime_id)
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Sheet open={open} onOpenChange={changeOpen}>
      {retry ? (
        <Button type="button" variant="outline" size="sm" onClick={() => void retryProvisioning()} disabled={submitting}>
          {submitting ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" /> : <RotateCwIcon data-icon="inline-start" />}
          {t("Retry provisioning")}
        </Button>
      ) : (
        <SheetTrigger asChild>
          {trigger ?? <Button>
            <PlusIcon data-icon="inline-start" />
            {t("Register Gateway")}
          </Button>}
        </SheetTrigger>
      )}
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        {bootstrap ? (
          <div className="flex min-h-full flex-col">
            <SheetHeader className="border-b px-6 py-5">
              <SheetTitle>{t("Save Gateway bootstrap now")}</SheetTitle>
              <SheetDescription>
                {t("This client secret is delivered once and cannot be retrieved after this sheet is closed.")}
              </SheetDescription>
            </SheetHeader>
            <FieldGroup className="p-6">
              <Field>
                <FieldLabel htmlFor={`gateway-bootstrap-${bootstrap.registration.runtime_id}`}>
                  {t("Bootstrap configuration")}
                </FieldLabel>
                <Textarea
                  id={`gateway-bootstrap-${bootstrap.registration.runtime_id}`}
                  className="min-h-96 font-mono text-xs"
                  value={bootstrapJson}
                  readOnly
                  spellCheck={false}
                />
                <FieldDescription>
                  {t("Provide this configuration only to the named Gateway Runtime installation.")}
                </FieldDescription>
              </Field>
              <p className="text-sm text-muted-foreground" aria-live="polite">
                {copied ? t("Bootstrap copied to clipboard.") : t("The secret is held only in this open browser view.")}
              </p>
            </FieldGroup>
            <SheetFooter className="mt-auto border-t bg-background px-6 py-4">
              <Button type="button" variant="outline" onClick={() => changeOpen(false)}>
                {t("I saved the bootstrap")}
              </Button>
              <Button type="button" variant="outline" onClick={downloadBootstrap}>
                <DownloadIcon data-icon="inline-start" />
                {t("Download bootstrap")}
              </Button>
              <Button type="button" onClick={() => void copyBootstrap()}>
                {copied ? <CheckIcon data-icon="inline-start" /> : <ClipboardIcon data-icon="inline-start" />}
                {t(copied ? "Copied" : "Copy bootstrap")}
              </Button>
            </SheetFooter>
          </div>
        ) : retry ? (
          <div className="flex min-h-full flex-col">
            <SheetHeader className="border-b px-6 py-5">
              <SheetTitle>{t("Gateway provisioning unavailable")}</SheetTitle>
              <SheetDescription>{t("The identity provider did not complete this Gateway bootstrap.")}</SheetDescription>
            </SheetHeader>
            <FieldGroup className="p-6">
              <Field data-invalid>
                <FieldError>{t(error)}</FieldError>
              </Field>
            </FieldGroup>
            <SheetFooter className="mt-auto border-t bg-background px-6 py-4">
              <Button type="button" variant="outline" onClick={() => changeOpen(false)}>
                {t("Close")}
              </Button>
            </SheetFooter>
          </div>
        ) : (
          <form className="flex min-h-full flex-col" onSubmit={submit}>
            <SheetHeader className="border-b px-6 py-5">
              <SheetTitle>{t("Register Gateway Runtime")}</SheetTitle>
              <SheetDescription>
                {t("Create a canonical Gateway identity, then provision its dedicated Keycloak client.")}
              </SheetDescription>
            </SheetHeader>
            <FieldGroup className="p-6">
              <Field>
                <FieldLabel htmlFor="gateway-display-name">{t("Display name")}</FieldLabel>
                <Input
                  id="gateway-display-name"
                  value={input.displayName}
                  onChange={(event) => update("displayName", event.target.value)}
                  placeholder={t("Taipei production Gateway")}
                  required
                />
              </Field>
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="gateway-site-id">{t("Site")}</FieldLabel>
                  <Input
                    id="gateway-site-id"
                    value={input.siteId}
                    onChange={(event) => update("siteId", event.target.value)}
                    placeholder="taipei-hq"
                    required
                  />
                  <FieldDescription>{t("Deployment site for this Gateway installation.")}</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="gateway-region">{t("Region")}</FieldLabel>
                  <Input
                    id="gateway-region"
                    value={input.region}
                    onChange={(event) => update("region", event.target.value)}
                    placeholder="ap-east"
                    required
                  />
                  <FieldDescription>{t("Deployment region for this Gateway installation.")}</FieldDescription>
                </Field>
              </div>
              <Field>
                <FieldLabel>{t("Deployment label (optional)")}</FieldLabel>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Input
                    aria-label={t("Label key")}
                    value={labelKey}
                    onChange={(event) => setLabelKey(event.target.value)}
                    placeholder={t("Label key")}
                  />
                  <Input
                    aria-label={t("Label value")}
                    value={labelValue}
                    onChange={(event) => setLabelValue(event.target.value)}
                    placeholder={t("Label value")}
                  />
                </div>
              </Field>
              {error ? <FieldError>{t(error)}</FieldError> : null}
            </FieldGroup>
            <SheetFooter className="mt-auto border-t bg-background px-6 py-4">
              <Button type="button" variant="outline" onClick={() => changeOpen(false)}>
                {t("Cancel")}
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" /> : null}
                {t("Register and provision")}
              </Button>
            </SheetFooter>
          </form>
        )}
      </SheetContent>
    </Sheet>
  )
}
