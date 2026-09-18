import { useMemo, useState } from "react"
import { BotIcon, LoaderCircleIcon, PlusIcon, ShieldOffIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { DataEmpty } from "@/components/data-empty"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { SearchableSelect } from "@/components/ui/searchable-select"
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { OverviewSnapshot } from "@/domain/contracts"
import { relativeTime } from "@/lib/format"
import { createAgentDelegation, revokeAgentDelegation } from "@/lib/product-api"

const durationSeconds = 24 * 60 * 60

export function AgentDelegationsCard({
  tenantId,
  data,
  onChanged,
}: {
  tenantId: string
  data: OverviewSnapshot
  onChanged: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [principalSubjectId, setPrincipalSubjectId] = useState("")
  const [agentSubjectId, setAgentSubjectId] = useState("")
  const [resourceId, setResourceId] = useState("")
  const [capabilityId, setCapabilityId] = useState("")
  const [actingClientIds, setActingClientIds] = useState("")
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")

  const subjects = data.identity?.subjects ?? []
  const subjectLabels = useMemo(
    () => new Map(subjects.map((subject) => [subject.subject_id, subject.profile.display_name ?? subject.subject_id])),
    [subjects],
  )
  const selectedResource = data.resources.find((resource) => resource.resource_id === resourceId)
  const activeDelegations = data.agentDelegations.filter((delegation) => delegation.state === "ACTIVE")

  async function submit() {
    const clients = [...new Set(actingClientIds.split(",").map((value) => value.trim()).filter(Boolean))]
    if (!principalSubjectId || !agentSubjectId || !resourceId || !capabilityId || clients.length === 0) return
    setBusy("create")
    setError("")
    try {
      await createAgentDelegation(tenantId, {
        principalSubjectId,
        agentSubjectId,
        resourceId,
        capabilityIds: [capabilityId],
        actingClientIds: clients,
        expiresAt: Math.floor(Date.now() / 1000) + durationSeconds,
      })
      await onChanged()
      setOpen(false)
      setPrincipalSubjectId("")
      setAgentSubjectId("")
      setResourceId("")
      setCapabilityId("")
      setActingClientIds("")
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy("")
    }
  }

  async function revoke(delegationId: string, revision: number) {
    setBusy(delegationId)
    setError("")
    try {
      await revokeAgentDelegation(tenantId, delegationId, revision)
      await onChanged()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy("")
    }
  }

  return (
    <>
      <Card>
        <CardHeader className="border-b">
          <div>
            <CardTitle>{t("Agent Delegations")}</CardTitle>
            <CardDescription>{t("Bounded authority that intersects the Principal and Agent Entitlements on every invocation.")}</CardDescription>
          </div>
          <Button onClick={() => setOpen(true)}><PlusIcon data-icon="inline-start" />{t("Create Delegation")}</Button>
        </CardHeader>
        <CardContent className="px-0">
          {activeDelegations.length ? (
            <Table>
              <TableHeader><TableRow><TableHead>{t("Principal")}</TableHead><TableHead>{t("Agent")}</TableHead><TableHead>{t("Resource / Capability")}</TableHead><TableHead>{t("Expires")}</TableHead><TableHead className="text-right">{t("Action")}</TableHead></TableRow></TableHeader>
              <TableBody>{activeDelegations.map((delegation) => (
                <TableRow key={delegation.delegation_id}>
                  <TableCell>{subjectLabels.get(delegation.principal_subject_id) ?? delegation.principal_subject_id}</TableCell>
                  <TableCell>{subjectLabels.get(delegation.agent_subject_id) ?? delegation.agent_subject_id}</TableCell>
                  <TableCell><div>{data.resources.find((resource) => resource.resource_id === delegation.resource_id)?.display_name ?? delegation.resource_id}</div><div className="text-xs text-muted-foreground">{delegation.capability_ids.join(", ")}</div></TableCell>
                  <TableCell>{relativeTime(delegation.expires_at)}</TableCell>
                  <TableCell className="text-right"><Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void revoke(delegation.delegation_id, delegation.revision)}>{busy === delegation.delegation_id ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : <ShieldOffIcon data-icon="inline-start" />}{t("Revoke")}</Button></TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          ) : <DataEmpty icon={BotIcon} title={t("No active Delegations")} description={t("Create a bounded Delegation before an Agent acts for another Subject.")} />}
          {error ? <p className="px-6 py-3 text-sm text-destructive" role="alert">{t(error)}</p> : null}
        </CardContent>
      </Card>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="w-full sm:max-w-xl">
          <SheetHeader className="border-b px-6 py-5"><SheetTitle>{t("Create Delegation")}</SheetTitle></SheetHeader>
          <FieldGroup className="p-6">
            <Field><FieldLabel>{t("Principal")}</FieldLabel><SearchableSelect value={principalSubjectId} options={subjects.map((subject) => ({ value: subject.subject_id, label: subject.profile.display_name ?? subject.subject_id, description: subject.kind }))} onValueChange={setPrincipalSubjectId} placeholder={t("Select Principal")} searchPlaceholder={t("Search Subjects")} emptyLabel={t("No Subjects found.")} /></Field>
            <Field><FieldLabel>{t("Agent")}</FieldLabel><SearchableSelect value={agentSubjectId} options={subjects.filter((subject) => subject.kind === "AGENT").map((subject) => ({ value: subject.subject_id, label: subject.profile.display_name ?? subject.subject_id }))} onValueChange={setAgentSubjectId} placeholder={t("Select Agent")} searchPlaceholder={t("Search Agents")} emptyLabel={t("No Agents found.")} /></Field>
            <Field><FieldLabel>{t("Resource")}</FieldLabel><SearchableSelect value={resourceId} options={data.resources.map((resource) => ({ value: resource.resource_id, label: resource.display_name }))} onValueChange={(value) => { setResourceId(value); setCapabilityId("") }} placeholder={t("Select Resource")} searchPlaceholder={t("Search Resources")} emptyLabel={t("No Resources found.")} /></Field>
            <Field><FieldLabel>{t("Capability")}</FieldLabel><SearchableSelect value={capabilityId} options={(selectedResource?.capabilities ?? []).map((capability) => ({ value: capability.capability_id, label: capability.display_name }))} onValueChange={setCapabilityId} placeholder={t("Select Capability")} searchPlaceholder={t("Search Capabilities")} emptyLabel={t("No Capabilities found.")} /></Field>
            <Field><FieldLabel htmlFor="delegation-acting-clients">{t("Acting Client IDs")}</FieldLabel><Input id="delegation-acting-clients" value={actingClientIds} onChange={(event) => setActingClientIds(event.target.value)} placeholder="agent-runtime-client" /><FieldDescription>{t("Comma-separated verified OAuth client IDs allowed to exercise this Delegation.")}</FieldDescription></Field>
            <FieldDescription>{t("The Delegation expires after 24 hours and cannot exceed either Subject's active Entitlement window.")}</FieldDescription>
            {error ? <p className="text-sm text-destructive" role="alert">{t(error)}</p> : null}
          </FieldGroup>
          <SheetFooter className="mt-auto border-t px-6 py-4"><Button variant="outline" onClick={() => setOpen(false)}>{t("Cancel")}</Button><Button disabled={Boolean(busy) || !principalSubjectId || !agentSubjectId || !resourceId || !capabilityId || !actingClientIds.trim()} onClick={() => void submit()}>{busy === "create" ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : null}{t("Create")}</Button></SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  )
}
