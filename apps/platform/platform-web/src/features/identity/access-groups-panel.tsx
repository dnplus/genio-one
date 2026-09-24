import { LoaderCircleIcon, UsersIcon } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"

import { DataEmpty } from "@/components/data-empty"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { SearchableSelect } from "@/components/ui/searchable-select"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { IdentitySession, LocalAccessGroup, OverviewSnapshot } from "@/domain/contracts"
import { replaceAccessGroupMembers, saveAccessGroup } from "@/lib/product-api"

const globalOwnerValue = "__genio_global_owner__"

function groupMemberCount(group: LocalAccessGroup, data: OverviewSnapshot): number {
  const subjectIds = new Set(group.membership_sources.flatMap((source) => source.subject_ids))
  if (group.organization_id === null) return subjectIds.size
  const organization = data.organizations.find((candidate) => candidate.organization_id === group.organization_id)
  if (!organization) return 0
  const members = new Set(organization.member_subject_ids)
  return [...subjectIds].filter((subjectId) => members.has(subjectId)).length
}

function AccessGroupEditor({
  tenantId,
  data,
  identity,
  initial,
  onChanged,
  onClose,
}: {
  tenantId: string
  data: OverviewSnapshot
  identity: IdentitySession | null
  initial: LocalAccessGroup | null
  onChanged: () => Promise<void>
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [group, setGroup] = useState(initial)
  const [accessGroupId] = useState(() => initial?.access_group_id ?? `access-group-${crypto.randomUUID()}`)
  const [displayName, setDisplayName] = useState(initial?.display_name ?? "")
  const [description, setDescription] = useState(initial?.description ?? "")
  const [enabled, setEnabled] = useState(initial?.enabled ?? true)
  const [organizationId, setOrganizationId] = useState<string | null>(() => initial?.organization_id ?? (identity?.role === "ORGANIZATION_ADMINISTRATOR" ? data.organizations[0]?.organization_id ?? null : null))
  const [members, setMembers] = useState(() => initial?.membership_sources.find((source) => source.source_id === "manual")?.subject_ids ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const allPeople = data.identity?.subjects.filter((subject) => !subject.suspended) ?? []
  const ownerOrganization = organizationId
    ? data.organizations.find((organization) => organization.organization_id === organizationId) ?? null
    : null
  const people = ownerOrganization
    ? allPeople.filter((subject) => ownerOrganization.member_subject_ids.includes(subject.subject_id))
    : allPeople
  const subjectLabel = (subjectId: string) => {
    const subject = allPeople.find((candidate) => candidate.subject_id === subjectId)
    return subject?.profile.display_name ?? subject?.profile.email ?? subjectId
  }

  function changeOwner(value: string) {
    const nextOrganizationId = value === globalOwnerValue ? null : value
    setOrganizationId(nextOrganizationId)
    if (nextOrganizationId === null) {
      setMembers((current) => current.filter((subjectId) => allPeople.some((subject) => subject.subject_id === subjectId)))
      return
    }
    const nextOrganization = data.organizations.find((organization) => organization.organization_id === nextOrganizationId)
    const nextMembers = new Set(nextOrganization?.member_subject_ids ?? [])
    setMembers((current) => current.filter((subjectId) => nextMembers.has(subjectId)))
  }

  async function saveGroup() {
    if (!displayName.trim()) return
    setBusy(true)
    setError("")
    try {
      const next = await saveAccessGroup(tenantId, accessGroupId, {
        expected_revision: group?.revision ?? 0,
        organization_id: organizationId,
        display_name: displayName,
        description,
        enabled,
      })
      setGroup(next)
      setDisplayName(next.display_name)
      setDescription(next.description)
      setEnabled(next.enabled)
      setOrganizationId(next.organization_id)
      await onChanged()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "ACCESS_GROUP_SAVE_FAILED")
    } finally {
      setBusy(false)
    }
  }

  async function saveMembers() {
    if (!group) return
    const source = group.membership_sources.find((candidate) => candidate.source_id === "manual")
    setBusy(true)
    setError("")
    try {
      const next = await replaceAccessGroupMembers(tenantId, group.access_group_id, {
        expected_group_revision: group.revision,
        expected_source_revision: source?.revision ?? 0,
        subject_ids: members,
      })
      setGroup(next)
      setMembers(next.membership_sources.find((candidate) => candidate.source_id === "manual")?.subject_ids ?? [])
      await onChanged()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "ACCESS_GROUP_MEMBERSHIP_SAVE_FAILED")
    } finally {
      setBusy(false)
    }
  }

  return <Sheet open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
    <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
      <SheetHeader className="border-b px-6 py-5">
        <SheetTitle>{t("Access group")}</SheetTitle>
        <SheetDescription>{t("Membership source")}: {t("MANUAL")}</SheetDescription>
      </SheetHeader>
      <FieldGroup className="p-6">
        {error ? <Alert variant="destructive"><AlertDescription>{t(error)}</AlertDescription></Alert> : null}
        <Field><FieldLabel>{t("Display name")}</FieldLabel><Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} disabled={busy} /></Field>
        <Field><FieldLabel>{t("Description")}</FieldLabel><Input value={description} onChange={(event) => setDescription(event.target.value)} disabled={busy} /></Field>
        <Field>
          <FieldLabel>{t("Owner Organization")}</FieldLabel>
          <Select value={organizationId ?? globalOwnerValue} onValueChange={changeOwner} disabled={busy || Boolean(group)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {identity?.role === "TENANT_ADMINISTRATOR" ? <SelectItem value={globalOwnerValue}>{t("Global")}</SelectItem> : null}
              {data.organizations.map((organization) => <SelectItem key={organization.organization_id} value={organization.organization_id}>{organization.display_name}</SelectItem>)}
            </SelectContent>
          </Select>
          <FieldDescription>{t(organizationId ? "Only members of the owner Organization can belong to this group." : "Global groups are managed by Tenant Administrators.")}</FieldDescription>
        </Field>
        <Field orientation="horizontal"><Checkbox checked={enabled} onCheckedChange={(next) => setEnabled(next === true)} disabled={busy} /><FieldLabel>{t(enabled ? "ENABLED" : "DISABLED")}</FieldLabel></Field>
        <Button disabled={busy || !displayName.trim()} onClick={() => void saveGroup()}>{busy ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" /> : null}{t("Save changes")}</Button>
        {group ? <>
          <Field><FieldLabel>{t("People")}</FieldLabel><FieldDescription>{t("Membership source")}</FieldDescription>
            <div className="flex flex-wrap gap-2">{members.map((subjectId) => <Badge key={subjectId} variant="secondary" className="gap-1"><span>{subjectLabel(subjectId)}</span><Button disabled={busy} variant="ghost" size="icon-xs" aria-label={`${t("Remove")} ${subjectLabel(subjectId)}`} onClick={() => setMembers((values) => values.filter((value) => value !== subjectId))}>×</Button></Badge>)}</div>
            {!busy ? <SearchableSelect value="" options={people.filter((subject) => !members.includes(subject.subject_id)).map((subject) => ({ value: subject.subject_id, label: subjectLabel(subject.subject_id), description: subject.profile.email ?? undefined }))} onValueChange={(subjectId) => { if (subjectId) setMembers((values) => [...values, subjectId]) }} placeholder={t("Select a person")} searchPlaceholder={t("Search people")} emptyLabel={t("No results.")} /> : null}
          </Field>
          <Button disabled={busy} onClick={() => void saveMembers()}>{t("Save changes")}</Button>
        </> : null}
      </FieldGroup>
      <SheetFooter className="border-t bg-background px-6 py-4"><Button variant="outline" disabled={busy} onClick={onClose}>{t("Cancel")}</Button></SheetFooter>
    </SheetContent>
  </Sheet>
}

export function AccessGroupsPanel({ tenantId, data, identity, canManage, onChanged }: {
  tenantId: string
  data: OverviewSnapshot
  identity: IdentitySession | null
  canManage: boolean
  onChanged: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<LocalAccessGroup | null | undefined>(undefined)
  const groups = data.accessGroups.groups
  const canManageGlobal = identity?.role === "TENANT_ADMINISTRATOR"
  const isOrganizationScoped = identity?.role === "ORGANIZATION_ADMINISTRATOR"
  const organizations = identity?.role === "ORGANIZATION_ADMINISTRATOR"
    ? data.organizations.filter((organization) => identity.organization_ids?.includes(organization.organization_id))
    : data.organizations
  const scopedData = organizations.length === data.organizations.length ? data : { ...data, organizations }
  const canCreate = canManage && (canManageGlobal || organizations.length > 0)
  const ownerLabel = (organizationId: string | null) => organizationId
    ? organizations.find((organization) => organization.organization_id === organizationId)?.display_name ?? organizationId
    : t("Global")
  return <>
    <Card>
      <CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><div><CardTitle>{t("Access groups")}</CardTitle><CardDescription>{t(isOrganizationScoped ? "Showing Access Groups in your canonical Organization scope." : "Tenant Administrators can see global and Organization-owned Access Groups.")} · {t("Membership source")}: {t("MANUAL")}</CardDescription></div>{canCreate ? <Button onClick={() => setSelected(null)}><UsersIcon data-icon="inline-start" />{t("Create Access Group")}</Button> : null}</div></CardHeader>
      <CardContent className="px-0">
        {groups.length ? <Table><TableHeader><TableRow><TableHead>{t("Display name")}</TableHead><TableHead>{t("Owner")}</TableHead><TableHead>{t("People")}</TableHead><TableHead>{t("Status")}</TableHead>{canManage ? <TableHead className="text-right">{t("Actions")}</TableHead> : null}</TableRow></TableHeader><TableBody>{groups.map((group) => <TableRow key={group.access_group_id}><TableCell><div className="font-medium">{group.display_name}</div><div className="font-mono text-xs text-muted-foreground">{group.access_group_id}</div></TableCell><TableCell>{ownerLabel(group.organization_id)}</TableCell><TableCell>{groupMemberCount(group, data)}</TableCell><TableCell><Badge variant={group.enabled ? "secondary" : "outline"}>{t(group.enabled ? "ENABLED" : "DISABLED")}</Badge></TableCell>{canManage ? <TableCell className="text-right"><Button size="sm" variant="outline" onClick={() => setSelected(group)}>{t("Edit")}</Button></TableCell> : null}</TableRow>)}</TableBody></Table> : <DataEmpty icon={UsersIcon} title={t("Access groups")} description={t(isOrganizationScoped ? "No Access Groups are available in your canonical Organization scope." : "No Access Groups are configured for this tenant.")} />}
      </CardContent>
    </Card>
    {selected !== undefined ? <AccessGroupEditor key={selected?.access_group_id ?? "new"} tenantId={tenantId} data={scopedData} identity={identity} initial={selected} onChanged={onChanged} onClose={() => setSelected(undefined)} /> : null}
  </>
}
