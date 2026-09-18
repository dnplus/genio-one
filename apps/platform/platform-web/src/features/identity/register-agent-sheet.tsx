import { useState } from "react"
import { BotIcon, LoaderCircleIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { registerAgentSubject } from "@/lib/product-api"

export function RegisterAgentSheet({ tenantId, onCreated }: { tenantId: string; onCreated: () => Promise<void> }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [displayName, setDisplayName] = useState("")
  const [department, setDepartment] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  async function submit() {
    if (!displayName.trim()) return
    setBusy(true)
    setError("")
    try {
      await registerAgentSubject(tenantId, { displayName, department })
      await onCreated()
      setOpen(false)
      setDisplayName("")
      setDepartment("")
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild><Button><BotIcon data-icon="inline-start" />{t("Register Agent")}</Button></SheetTrigger>
      <SheetContent className="w-full sm:max-w-lg">
        <SheetHeader className="border-b px-6 py-5">
          <SheetTitle>{t("Register Agent")}</SheetTitle>
          <SheetDescription>{t("Create a canonical Agent Subject for governance and entitlement assignment.")}</SheetDescription>
        </SheetHeader>
        <FieldGroup className="p-6">
          <Field><FieldLabel htmlFor="agent-display-name">{t("Display name")}</FieldLabel><Input id="agent-display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></Field>
          <p className="text-sm text-muted-foreground">{t("Subject ID is generated automatically by GenioOne.")}</p>
          <Field><FieldLabel htmlFor="agent-department">{t("Department")}</FieldLabel><Input id="agent-department" value={department} onChange={(event) => setDepartment(event.target.value)} /></Field>
          {error ? <p className="text-sm text-destructive" role="alert">{t(error)}</p> : null}
        </FieldGroup>
        <SheetFooter className="mt-auto border-t bg-background px-6 py-4">
          <Button variant="outline" onClick={() => setOpen(false)}>{t("Cancel")}</Button>
          <Button disabled={busy || !displayName.trim()} onClick={() => void submit()}>{busy ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" /> : null}{t("Register")}</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
