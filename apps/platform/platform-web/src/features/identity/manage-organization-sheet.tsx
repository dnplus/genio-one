import { LoaderCircleIcon, Settings2Icon } from "lucide-react"
import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import { useTranslation } from "react-i18next"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { Organization, TenantIdentityInventory, UpdateOrganizationInput } from "@/domain/contracts"
import { organizationAdministratorSubjectIds } from "@/domain/organization-roles"
import { updateOrganization } from "@/lib/product-api"

type DirectorySource = "NONE" | "SCIM_GROUP" | "OIDC_GROUP"

function findDirectorySource(organization: Organization) {
  return organization.membership_sources.find(
    (source): source is typeof source & { kind: Exclude<DirectorySource, "NONE"> } =>
      source.kind === "SCIM_GROUP" || source.kind === "OIDC_GROUP",
  )
}

export function ManageOrganizationSheet({
  tenantId,
  organization,
  identity,
  onSaved,
  trigger,
}: {
  tenantId: string
  organization: Organization
  identity: TenantIdentityInventory | null
  onSaved: () => Promise<void>
  trigger?: ReactNode
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [displayName, setDisplayName] = useState(organization.display_name)
  const [members, setMembers] = useState(organization.member_subject_ids)
  const [organizationAdministrators, setOrganizationAdministrators] = useState(() => organizationAdministratorSubjectIds(organization))
  const initialDirectorySource = findDirectorySource(organization)
  const [directorySource, setDirectorySource] = useState<DirectorySource>(initialDirectorySource?.kind ?? "NONE")
  const [directoryReference, setDirectoryReference] = useState(initialDirectorySource?.reference ?? "")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const people = identity?.subjects.filter((subject) => subject.kind === "PERSON") ?? []

  useEffect(() => {
    if (!open) return
    setDisplayName(organization.display_name)
    setMembers(organization.member_subject_ids)
    setOrganizationAdministrators(organizationAdministratorSubjectIds(organization))
    const source = findDirectorySource(organization)
    setDirectorySource(source?.kind ?? "NONE")
    setDirectoryReference(source?.reference ?? "")
    setError("")
  }, [open, organization])

  function toggle(list: string[], setList: (next: string[]) => void, subjectId: string, checked: boolean) {
    setList(checked ? [...new Set([...list, subjectId])] : list.filter((id) => id !== subjectId))
  }

  function toggleMember(subjectId: string, checked: boolean) {
    toggle(members, setMembers, subjectId, checked)
    if (!checked) {
      setOrganizationAdministrators((current) => current.filter((id) => id !== subjectId))
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError("")
    const input: UpdateOrganizationInput = {
      displayName: displayName.trim(),
      memberSubjectIds: members,
      organizationAdministratorSubjectIds: organizationAdministrators,
      membershipSources: [
        { kind: "MANUAL", reference: "console", status: "SYNCED" },
        ...(directorySource === "NONE" || !directoryReference.trim()
          ? []
          : [{ kind: directorySource, reference: directoryReference.trim(), status: "PENDING" as const }]),
      ],
    }
    try {
      await updateOrganization(tenantId, organization, input)
      setOpen(false)
      await onSaved()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Organization update failed"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        {trigger ?? <Button size="sm" variant="outline"><Settings2Icon data-icon="inline-start" />{t("Manage")}</Button>}
      </SheetTrigger>
      <SheetContent className="w-full overflow-y-auto sm:max-w-3xl">
        <form className="flex min-h-full flex-col" onSubmit={submit}>
          <SheetHeader className="border-b px-6 py-5">
            <SheetTitle>{t("Manage Organization")}</SheetTitle>
            <SheetDescription>{organization.display_name}</SheetDescription>
          </SheetHeader>
          <FieldGroup className="p-6">
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor={`organization-name-${organization.organization_id}`}>{t("Display name")}</FieldLabel>
              <Input id={`organization-name-${organization.organization_id}`} value={displayName} onChange={(event) => setDisplayName(event.target.value)} aria-invalid={Boolean(error)} required />
            </Field>
            {/*
              Directory synchronization is not implemented: nothing reads these
              rows, and membership is resolved only from the table below. A
              mapping recorded here would silently never apply, so a new one
              cannot be created. An existing mapping stays visible and
              removable so a tenant that already recorded one can clear it.
            */}
            {directorySource === "NONE" ? null : (
              <Field>
                <FieldLabel>{t("Directory group mapping")}</FieldLabel>
                <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
                  <Input value={t(directorySource === "SCIM_GROUP" ? "SCIM group" : "OIDC group claim")} disabled readOnly />
                  <Input value={directoryReference} disabled readOnly />
                </div>
                <FieldDescription>
                  {t("This mapping is recorded but never synchronized: membership comes only from the list below. Remove it to avoid implying directory-managed membership.")}
                </FieldDescription>
                <Button type="button" variant="outline" className="w-fit" onClick={() => { setDirectorySource("NONE"); setDirectoryReference("") }}>
                  {t("Remove mapping")}
                </Button>
              </Field>
            )}
            <Field data-invalid={Boolean(error)}>
              <FieldLabel>{t("Members and roles")}</FieldLabel>
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader><TableRow><TableHead>{t("Person")}</TableHead><TableHead>{t("Member")}</TableHead><TableHead>{t("Role")}</TableHead><TableHead>{t("Data scope")}</TableHead></TableRow></TableHeader>
                  <TableBody>{people.map((subject) => {
                    const id = subject.subject_id
                    const member = members.includes(id)
                    const tenantAdministrator = identity?.tenant_administrators.includes(id) ?? false
                    const organizationAdministrator = organizationAdministrators.includes(id)
                    const role = tenantAdministrator ? "ADMINISTRATOR" : organizationAdministrator ? "ORGANIZATION_ADMINISTRATOR" : "USER"
                    return <TableRow key={id}>
                      <TableCell><div className="font-medium">{subject.profile.display_name ?? id}</div><div className="text-xs text-muted-foreground">{subject.profile.email ?? "—"}</div></TableCell>
                      <TableCell><Checkbox checked={member} onCheckedChange={(checked) => toggleMember(id, checked === true)} aria-label={t("Member")} /></TableCell>
                      <TableCell><Select disabled={!member || tenantAdministrator} value={role} onValueChange={(value) => setOrganizationAdministrators((current) => value === "ORGANIZATION_ADMINISTRATOR" ? [...new Set([...current, id])] : current.filter((subjectId) => subjectId !== id))}><SelectTrigger className="w-52"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="USER">{t("User")}</SelectItem><SelectItem value="ORGANIZATION_ADMINISTRATOR">{t("Organization Administrator")}</SelectItem>{tenantAdministrator ? <SelectItem value="ADMINISTRATOR">{t("Administrator")}</SelectItem> : null}</SelectGroup></SelectContent></Select></TableCell>
                      <TableCell className="text-muted-foreground">{t(tenantAdministrator ? "All organizations" : organizationAdministrator ? "This organization" : "Own access")}</TableCell>
                    </TableRow>
                  })}</TableBody>
                </Table>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">{t("{{count}} user(s)", { count: members.filter((id) => !organizationAdministrators.includes(id) && !identity?.tenant_administrators.includes(id)).length })}</Badge>
                <Badge variant="outline">{t("{{count}} organization administrator(s)", { count: organizationAdministrators.length })}</Badge>
                <Badge variant="outline">{t("{{count}} administrator(s)", { count: identity?.tenant_administrators.length ?? 0 })}</Badge>
              </div>
              {error ? <FieldError>{t(error)}</FieldError> : null}
            </Field>
          </FieldGroup>
          <SheetFooter className="mt-auto border-t bg-background px-6 py-4">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>{t("Cancel")}</Button>
            <Button type="submit" disabled={saving || !displayName.trim() || !members.length}>
              {saving ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" /> : null}{t(saving ? "Saving…" : "Save changes")}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
