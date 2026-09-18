import { useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { KeyRoundIcon, LoaderCircleIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { SearchableSelect } from "@/components/ui/searchable-select"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import type { ResourceRegistration, TenantIdentityInventory } from "@/domain/contracts"
import { grantEntitlement } from "@/lib/product-api"

export function GrantEntitlementSheet({
  tenantId,
  identity,
  loadResources,
  onGranted,
}: {
  tenantId: string
  identity: TenantIdentityInventory | null
  loadResources: () => Promise<ResourceRegistration[]>
  onGranted: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [subjectId, setSubjectId] = useState("")
  const [resourceId, setResourceId] = useState("")
  const [capabilityId, setCapabilityId] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")
  const [resources, setResources] = useState<ResourceRegistration[] | null>(null)
  const [loadingResources, setLoadingResources] = useState(false)
  const [resourceError, setResourceError] = useState("")
  const sheetContentRef = useRef<HTMLDivElement>(null)
  const grantRequestRef = useRef<{ payload: string; idempotencyKey: string } | null>(null)
  const publishedResources = useMemo(
    () => (resources ?? []).filter((resource) => resource.lifecycle === "PUBLISHED"),
    [resources],
  )
  const selectedResource = publishedResources.find((resource) => resource.resource_id === resourceId)

  useEffect(() => {
    if (!open) return
    grantRequestRef.current = null
    setSubjectId("")
    setResourceId("")
    setCapabilityId("")
    setError("")
  }, [open])

  useEffect(() => {
    if (!open) return
    let current = true
    setResources(null)
    setLoadingResources(true)
    setResourceError("")
    void (async () => {
      try {
        const next = await loadResources()
        if (current) setResources(next)
      } catch (caught) {
        if (current) setResourceError(caught instanceof Error ? caught.message : "RESOURCE_INVENTORY_UNAVAILABLE")
      } finally {
        if (current) setLoadingResources(false)
      }
    })()
    return () => { current = false }
  }, [loadResources, open])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!subjectId || !resourceId || !capabilityId) return
    setSubmitting(true)
    setError("")
    try {
      const payload = JSON.stringify([subjectId, resourceId, capabilityId])
      if (grantRequestRef.current?.payload !== payload) {
        grantRequestRef.current = { payload, idempotencyKey: crypto.randomUUID() }
      }
      await grantEntitlement(tenantId, {
        subjectId,
        resourceId,
        capabilityId,
        idempotencyKey: grantRequestRef.current.idempotencyKey,
      })
      await onGranted()
      setOpen(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "ENTITLEMENT_GRANT_FAILED")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button disabled={!identity?.subjects.length}>
          <KeyRoundIcon data-icon="inline-start" />
          {t("Grant Entitlement")}
        </Button>
      </SheetTrigger>
      {!identity?.subjects.length ? <p className="text-sm text-muted-foreground">{t("Add a verified identity before granting access.")}</p> : null}
      <SheetContent ref={sheetContentRef} className="w-full overflow-y-auto sm:max-w-xl">
        <form className="flex min-h-full flex-col" onSubmit={(event) => void submit(event)}>
          <SheetHeader className="border-b px-6 py-5">
            <SheetTitle>{t("Grant Entitlement")}</SheetTitle>
            <SheetDescription>{t("Grant one Subject access to one canonical Resource Capability.")}</SheetDescription>
          </SheetHeader>
          <FieldGroup className="p-6">
            <Field>
              <FieldLabel>{t("Target Subject")}</FieldLabel>
              <SearchableSelect value={subjectId} options={(identity?.subjects ?? []).map((subject) => ({ value: subject.subject_id, label: subject.profile.display_name ?? subject.subject_id, description: subject.kind, searchText: subject.subject_id }))} onValueChange={(value) => { setSubjectId(value); grantRequestRef.current = null }} placeholder={t("Select Subject")} searchPlaceholder={t("Search Subjects")} emptyLabel={t("No Subjects found.")} portalContainer={sheetContentRef} />
            </Field>
            <Field>
              <FieldLabel>{t("Resource")}</FieldLabel>
              {loadingResources ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircleIcon className="size-4 animate-spin" />{t("Loading Resources…")}</p> : resourceError ? <FieldError>{t(resourceError)}</FieldError> : <SearchableSelect value={resourceId} options={publishedResources.map((resource) => ({ value: resource.resource_id, label: resource.display_name, description: resource.kind, searchText: resource.resource_id }))} onValueChange={(value) => { setResourceId(value); setCapabilityId(""); grantRequestRef.current = null }} placeholder={t("Select Resource")} searchPlaceholder={t("Search Resources")} emptyLabel={t("No Resources found.")} portalContainer={sheetContentRef} />}
            </Field>
            <Field>
              <FieldLabel>{t("Capability")}</FieldLabel>
              {loadingResources || resourceError ? <p className="text-sm text-muted-foreground">{t("Load the Resource inventory before selecting a Capability.")}</p> : <SearchableSelect value={capabilityId} options={(selectedResource?.capabilities ?? []).map((capability) => ({ value: capability.capability_id, label: capability.display_name, description: capability.capability_id }))} onValueChange={(value) => { setCapabilityId(value); grantRequestRef.current = null }} placeholder={t("Select Capability")} searchPlaceholder={t("Search Capabilities")} emptyLabel={t("No Capabilities found.")} portalContainer={sheetContentRef} />}
            </Field>
            {error ? <FieldError>{t(error)}</FieldError> : null}
          </FieldGroup>
          <SheetFooter className="mt-auto border-t bg-background px-6 py-4">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>{t("Cancel")}</Button>
            <Button type="submit" disabled={submitting || !subjectId || !resourceId || !capabilityId}>
              {submitting ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" /> : null}
              {t(submitting ? "Granting…" : "Grant Entitlement")}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
