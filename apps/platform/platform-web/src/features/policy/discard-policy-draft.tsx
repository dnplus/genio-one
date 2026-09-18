import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { discardPolicyDraft } from "@/lib/product-api"

export function DiscardPolicyDraft({ path, version, onDiscarded }: { path: string; version: number; onDiscarded: () => void | Promise<void> }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  async function discard() {
    setBusy(true)
    setError("")
    try { await discardPolicyDraft(path, version); await onDiscarded(); setOpen(false) }
    catch (caught) { setError(caught instanceof Error ? caught.message : "POLICY_DRAFT_CONFLICT") }
    finally { setBusy(false) }
  }
  return <><Button variant="outline" onClick={() => setOpen(true)}>{t("Discard draft")}</Button>
    <AlertDialog open={open} onOpenChange={setOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t("Discard draft")}</AlertDialogTitle><AlertDialogDescription>{t("Discard this saved draft and return to the published policy. Published rules and revision history remain available.")}</AlertDialogDescription></AlertDialogHeader>
      {error ? <p role="alert" className="text-sm text-destructive">{t(error)}</p> : null}
      <AlertDialogFooter><AlertDialogCancel disabled={busy}>{t("Cancel")}</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={(event) => { event.preventDefault(); void discard() }}>{t("Discard draft")}</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>
  </>
}
