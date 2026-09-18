import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import type { ProviderCredentialStrategy, ProviderCredentialProfileRevision } from "@/domain/contracts"
import { createProviderCredentialProfile } from "@/lib/product-api"
import { ProviderCredentialCreateFields } from "./provider-credential-create-fields"

export function InlineCredentialProfile({ tenantId, organizationId, onCreated }: {
  tenantId: string
  organizationId: string
  onCreated: (profile: ProviderCredentialProfileRevision) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<{ displayName: string; strategy: ProviderCredentialStrategy; credentialMaterial?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  async function create() {
    if (!draft) return
    setBusy(true)
    setError("")
    try {
      const profile = await createProviderCredentialProfile(tenantId, { ownerOrganizationId: organizationId, ...draft })
      onCreated(profile)
      setOpen(false)
      setDraft(null)
    } catch (caught) { setError(caught instanceof Error ? caught.message : "CREDENTIAL_PROFILE_CREATE_FAILED") }
    finally { setBusy(false) }
  }
  return open ? <div className="flex flex-col gap-4 rounded-lg border p-4">
    <ProviderCredentialCreateFields idPrefix="inline-credential" onReady={setDraft} />
    {error ? <Alert variant="destructive"><AlertDescription>{t(error)}</AlertDescription></Alert> : null}
    <div className="flex gap-2"><Button type="button" disabled={busy || !draft} onClick={() => void create()}>{t("Create and select profile")}</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>{t("Cancel")}</Button></div>
  </div> : <div><Button type="button" variant="outline" disabled={!organizationId} onClick={() => setOpen(true)}>{t("Create credential profile here")}</Button></div>
}
