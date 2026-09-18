import { useState, type FormEvent, type ReactNode } from "react"
import { LoaderCircleIcon, PlusIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
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
import type { CreateOrganizationInput, TenantIdentityInventory } from "@/domain/contracts"
import { createOrganization } from "@/lib/product-api"

const initialInput: CreateOrganizationInput = {
  displayName: "",
  memberSubjectIds: [],
}

export function CreateOrganizationSheet({
  tenantId,
  identity,
  onCreated,
  trigger,
}: {
  tenantId: string
  identity: TenantIdentityInventory | null
  onCreated: () => Promise<void>
  trigger?: ReactNode
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState(initialInput)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")
  const people = identity?.subjects.filter((subject) => subject.kind === "PERSON") ?? []

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    setError("")
    try {
      await createOrganization(tenantId, input)
      setInput(initialInput)
      setOpen(false)
      await onCreated()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Organization creation failed"))
    } finally {
      setSubmitting(false)
    }
  }

  function toggleMember(subjectId: string, checked: boolean) {
    setInput((current) => ({
      ...current,
      memberSubjectIds: checked
        ? [...new Set([...current.memberSubjectIds, subjectId])]
        : current.memberSubjectIds.filter((member) => member !== subjectId),
    }))
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      {trigger ? (
        <SheetTrigger asChild>{trigger}</SheetTrigger>
      ) : (
        <Button type="button" onClick={() => setOpen(true)}>
          <PlusIcon data-icon="inline-start" />
          {t("Create Organization")}
        </Button>
      )}
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <form className="flex min-h-full flex-col" onSubmit={submit}>
          <SheetHeader className="border-b px-6 py-5">
          <SheetTitle>{t("Create Organization")}</SheetTitle>
          <SheetDescription>
              {t("Create an Organization and add its first Users. Administrative roles can be assigned afterward.")}
            </SheetDescription>
          </SheetHeader>
          <FieldGroup className="p-6">
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor="organization-display-name">{t("Display name")}</FieldLabel>
              <Input
                id="organization-display-name"
                value={input.displayName}
                onChange={(event) => setInput((current) => ({ ...current, displayName: event.target.value }))}
                placeholder={t("Platform Engineering")}
                aria-invalid={Boolean(error)}
                required
              />
            </Field>
            <Field data-invalid={Boolean(error)}>
              <FieldLabel>{t("Verified members")}</FieldLabel>
              <div className="rounded-lg border p-3">
                {people.map((subject) => (
                  <label key={subject.subject_id} className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-muted/60">
                    <Checkbox
                      checked={input.memberSubjectIds.includes(subject.subject_id)}
                      onCheckedChange={(checked) => toggleMember(subject.subject_id, checked === true)}
                      aria-label={t("Member")}
                    />
                    <span className="flex flex-col">
                      <span className="text-sm font-medium">{subject.profile.display_name ?? subject.subject_id}</span>
                      <span className="text-xs text-muted-foreground">{subject.profile.email ?? "—"}</span>
                    </span>
                  </label>
                ))}
              </div>
              <FieldDescription>{t("Verified Users can be assigned after the Organization is created.")}</FieldDescription>
              {error ? <FieldError>{t(error)}</FieldError> : null}
            </Field>
          </FieldGroup>
          <SheetFooter className="mt-auto border-t bg-background px-6 py-4">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t("Cancel")}
            </Button>
            <Button
              type="submit"
              disabled={submitting || !input.displayName.trim()}
            >
              {submitting ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" /> : null}
              {t(submitting ? "Creating…" : "Create Organization")}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
