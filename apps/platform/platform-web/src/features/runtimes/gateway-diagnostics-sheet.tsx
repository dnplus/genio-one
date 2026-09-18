import { useEffect, useState } from "react"
import { Settings2Icon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import {
  getGatewayDiagnosticSettings,
  updateGatewayDiagnosticSettings,
} from "@/lib/product-api"

export function GatewayDiagnosticsSheet({
  tenantId,
  gatewayId,
  onUpdated,
}: {
  tenantId: string
  gatewayId: string
  onUpdated: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [captureMessageContent, setCaptureMessageContent] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!open) return
    let active = true
    setLoading(true)
    setError("")
    void getGatewayDiagnosticSettings(tenantId, gatewayId)
      .then((settings) => {
        if (active) setCaptureMessageContent(settings.capture_message_content)
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : "PRODUCT_API_REQUEST_FAILED")
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [gatewayId, open, tenantId])

  async function save() {
    setSaving(true)
    setError("")
    try {
      await updateGatewayDiagnosticSettings(tenantId, gatewayId, { captureMessageContent })
      await onUpdated()
      setOpen(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "PRODUCT_API_REQUEST_FAILED")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button size="sm" type="button" variant="outline">
          <Settings2Icon />
          {t("Message capture settings")}
        </Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{t("Message capture settings")}</SheetTitle>
          <SheetDescription>{gatewayId}</SheetDescription>
        </SheetHeader>
        <div className="px-4">
          <Field orientation="horizontal">
            <div className="min-w-0 flex-1">
              <FieldLabel htmlFor={`capture-message-content-${gatewayId}`}>
                {t("Capture request and response content")}
              </FieldLabel>
              <FieldDescription>
                {t("Captured content is available in Activity details and is not written to Audit records.")}
              </FieldDescription>
            </div>
            <Switch
              id={`capture-message-content-${gatewayId}`}
              checked={captureMessageContent}
              disabled={loading || saving}
              onCheckedChange={setCaptureMessageContent}
            />
          </Field>
          {error ? <p className="mt-4 text-sm text-destructive">{t(error)}</p> : null}
        </div>
        <SheetFooter>
          <Button type="button" disabled={loading || saving} onClick={() => void save()}>
            {t(saving ? "Publishing…" : "Save and publish")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
