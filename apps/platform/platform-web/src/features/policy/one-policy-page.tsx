import { resourceAdministrationState } from "@/features/resources/resource-administration"
import { createColumnHelper } from "@tanstack/react-table"
import { PlusIcon, RefreshCwIcon, ShieldCheckIcon } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { DataEmpty } from "@/components/data-empty"
import { TableView } from "@/components/data-table/data-table"
import type { DataTableFeatures } from "@/components/data-table/data-table-features"
import { PageHeader } from "@/components/page-header"
import { RelationValue } from "@/components/relation-value"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { SearchableSelect } from "@/components/ui/searchable-select"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import type { IdentitySession, OnePolicyBotSeed, OverviewSnapshot, ResourceRegistration } from "@/domain/contracts"
import { useRecordSelection } from "@/hooks/use-record-selection"
import { ResourceEnforcementChainCard } from "@/features/resources/resource-enforcement-chain-card"
import { BotPolicyEditor } from "./bot-policy-editor"
import { PolicyAuthoringGovernanceCard } from "./policy-authoring-governance-card"
import { RuntimePolicyEditor } from "./RuntimePolicyEditor"
import { getFirstPartyBotPolicySeed, listLatestEnforcementChains, listPolicyDrafts, listRuntimePolicies, setFirstPartyBotPolicySeedEnabled, type EnforcementChainInventoryView, type PolicyDraftView, type RuntimePolicyRevision } from "@/lib/product-api"

interface PolicyRow {
  id: string
  name: string
  source: "SYSTEM_SEED" | "RESOURCE_CAPABILITY" | "RUNTIME_CAPABILITY"
  resource?: ResourceRegistration
  capabilityId: string
  capabilityName: string
  revision: number
  status: string
  draftStatus: string
  organizationName: string
  runtimePolicy?: RuntimePolicyRevision
  runtimePolicyId?: string
  runtimeDisplayName?: string
}
const columnHelper = createColumnHelper<DataTableFeatures, PolicyRow>()

export function OnePolicyPage({ canManageFirstPartyBotSeed, data, tenantId, identity }: {
  identity: IdentitySession
  canManageFirstPartyBotSeed: boolean
  data: OverviewSnapshot
  tenantId: string
}) {
  const { t } = useTranslation()
  const [drafts, setDrafts] = useState<Array<Omit<PolicyDraftView, "content">>>([])
  const [inventory, setInventory] = useState<EnforcementChainInventoryView[]>([])
  const [runtimePolicies, setRuntimePolicies] = useState<RuntimePolicyRevision[]>([])
  const [botSeed, setBotSeed] = useState<OnePolicyBotSeed | null>(null)
  const [selectedId, select] = useRecordSelection("policy")
  const [creating, setCreating] = useState(false)
  const [createKind, setCreateKind] = useState<"RESOURCE_CAPABILITY" | "RUNTIME_CAPABILITY">("RESOURCE_CAPABILITY")
  const [createResourceId, setCreateResourceId] = useState("")
  const [createCapabilityId, setCreateCapabilityId] = useState("")
  const [createRuntimePolicyId, setCreateRuntimePolicyId] = useState(() => `one-policy.runtime.${crypto.randomUUID()}`)
  const [createRuntimeDisplayName, setCreateRuntimeDisplayName] = useState("Agent Runtime Capabilities")
  const [runtimeComposer, setRuntimeComposer] = useState<{ policyId: string; displayName: string } | null>(null)
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null)
  const [loadRevision, setLoadRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const [chains, seed, savedDrafts, policies] = await Promise.all([listLatestEnforcementChains(tenantId), getFirstPartyBotPolicySeed(tenantId), listPolicyDrafts(tenantId), listRuntimePolicies(tenantId)])
      setDrafts(savedDrafts)
      setInventory(chains)
      setBotSeed(seed)
      setRuntimePolicies(policies)
      setLoadRevision((value) => value + 1)
    } catch (caught) { setError(caught instanceof Error ? caught.message : "POLICY_LOAD_FAILED") }
    finally { setLoading(false) }
  }, [tenantId])
  useEffect(() => { void load() }, [load])
  useEffect(() => { setNotice("") }, [selectedId])
  const resources = useMemo(() => data.resources.filter((resource) => !resource.builtin_service && ["LLM", "MCP", "API"].includes(resource.kind)), [data.resources])
  const canManage = (resource: ResourceRegistration) => resourceAdministrationState({ data, identity, resource, isTenantAdministrator: canManageFirstPartyBotSeed }).canManageResource
  const editableResources = resources.filter(canManage)
  const rows = useMemo<PolicyRow[]>(() => {
    const chains = new Map(inventory.map((item) => [JSON.stringify([item.resource_id, item.capability_id]), item]))
    const draftStatus = (id: string, revision: number, source: PolicyRow["source"]) => {
      const key = source === "RUNTIME_CAPABILITY" ? `runtime-capability:${id}` : id
      const draft = drafts.find((item) => item.policy_key === key)
      return draft ? (draft.base_revision === revision ? "DRAFT" : "STALE_DRAFT") : "NO_DRAFT"
    }
    const organizations = new Map(data.organizations.map((item) => [item.organization_id, item.display_name]))
    const result: PolicyRow[] = resources.flatMap((resource) => resource.capabilities.map((capability) => {
      const id = JSON.stringify([resource.resource_id, capability.capability_id])
      const chain = chains.get(id)
      return { id, draftStatus: draftStatus(id, chain?.one_policy_revision ?? 0, "RESOURCE_CAPABILITY"), name: `${resource.display_name} / ${capability.display_name}`, source: "RESOURCE_CAPABILITY" as const, resource, capabilityId: capability.capability_id, capabilityName: capability.display_name, revision: chain?.one_policy_revision ?? 0, status: chain?.revision ? "PUBLISHED" : "NOT_CONFIGURED", organizationName: organizations.get(resource.owner_organization_id) ?? t("Unresolved reference") }
    }))
    if (botSeed) result.unshift({ id: botSeed.policy_id, draftStatus: draftStatus(botSeed.policy_id, botSeed.policy_revision, "SYSTEM_SEED"), name: t("Genio Bot access"), source: "SYSTEM_SEED", capabilityId: "personal_bot.use", capabilityName: t("Use Genio Bot"), revision: botSeed.policy_revision, status: botSeed.enabled ? "ENABLED" : "DISABLED", organizationName: t("Tenant") })
    for (const policy of runtimePolicies) result.push({ id: `runtime:${policy.policy_id}`, runtimePolicy: policy, runtimePolicyId: policy.policy_id, draftStatus: draftStatus(policy.policy_id, policy.revision, "RUNTIME_CAPABILITY"), name: policy.display_name, source: "RUNTIME_CAPABILITY", capabilityId: policy.rules[0]?.target.capability_id ?? "", capabilityName: policy.rules[0]?.target.capability_id ?? t("Runtime capability policy"), revision: policy.revision, status: policy.enabled ? "ENABLED" : "DISABLED", organizationName: t("Tenant") })
    if (runtimeComposer && !runtimePolicies.some((policy) => policy.policy_id === runtimeComposer.policyId)) result.push({ id: `runtime:${runtimeComposer.policyId}`, runtimePolicyId: runtimeComposer.policyId, runtimeDisplayName: runtimeComposer.displayName, draftStatus: draftStatus(runtimeComposer.policyId, 0, "RUNTIME_CAPABILITY"), name: runtimeComposer.displayName, source: "RUNTIME_CAPABILITY", capabilityId: "", capabilityName: t("Runtime capability policy"), revision: 0, status: "NOT_CONFIGURED", organizationName: t("Tenant") })
    return result
  }, [inventory, resources, data.organizations, botSeed, drafts, runtimePolicies, runtimeComposer, t])
  const selected = rows.find((row) => row.id === selectedId)
  const columns = useMemo(() => columnHelper.columns([
    columnHelper.accessor("name", { header: t("Policy"), cell: ({ getValue }) => <span className="font-medium">{getValue()}</span> }),
    columnHelper.accessor("source", { header: t("Source"), cell: ({ getValue }) => <Badge variant="outline">{t(getValue())}</Badge>, filterFn: "includesString" }),
    columnHelper.accessor("organizationName", { header: t("Owner Organization"), filterFn: "includesString" }),
    columnHelper.accessor("revision", { header: t("Published revision") }),
    columnHelper.accessor("draftStatus", { header: t("Draft"), cell: ({ getValue }) => t(getValue()), filterFn: "includesString" }),
    columnHelper.accessor("status", { header: t("Status"), cell: ({ getValue }) => <Badge variant="outline">{t(getValue())}</Badge>, filterFn: "includesString" }),
    columnHelper.display({ id: "actions", cell: ({ row }) => <Button variant="ghost" onClick={(event) => { event.stopPropagation(); select(row.original.id) }}>{t("Open policy")}</Button> }),
  ]), [t, select])
  const createResource = resources.find((resource) => resource.resource_id === createResourceId)
  async function updateEnabled() {
    if (pendingEnabled === null) return
    setSaving(true)
    try { setBotSeed(await setFirstPartyBotPolicySeedEnabled(tenantId, pendingEnabled)); setPendingEnabled(null) }
    catch (caught) { setError(caught instanceof Error ? caught.message : "POLICY_SAVE_FAILED") }
    finally { setSaving(false) }
  }
  return <div className="flex flex-col gap-5">
    <PageHeader title={t("One Policy")} description={t("Manage policy rules and drafts, publish a reviewed revision, then inspect its effective execution.")}
      actions={<><Button variant="outline" disabled={loading} onClick={() => void load()}><RefreshCwIcon />{t("Refresh")}</Button><Button disabled={!editableResources.length && !canManageFirstPartyBotSeed} onClick={() => { setCreateKind("RESOURCE_CAPABILITY"); setCreateRuntimePolicyId(`one-policy.runtime.${crypto.randomUUID()}`); setCreateRuntimeDisplayName(""); setCreating(true) }}><PlusIcon />{t("New policy")}</Button></>} />
    {!selectedId && error ? <Alert variant="destructive"><AlertDescription>{t(error)}</AlertDescription></Alert> : null}
    {canManageFirstPartyBotSeed ? <PolicyAuthoringGovernanceCard tenantId={tenantId} onSaved={load} /> : null}
    <Card><CardHeader><CardTitle>{t("Policies")}</CardTitle></CardHeader><CardContent className="px-0">
      <TableView stateKey={`${tenantId}:policies`} columns={columns} data={rows} getRowId={(row) => row.id} getRowLabel={(row) => row.name} onRowClick={(row) => select(row.id)} searchPlaceholder={t("Search policies")} noResults={t("No policies match the current filters.")} filters={[
        { columnId: "source", label: t("Source"), allLabel: t("All sources"), options: [{ value: "SYSTEM_SEED", label: t("SYSTEM_SEED") }, { value: "RESOURCE_CAPABILITY", label: t("RESOURCE_CAPABILITY") }, { value: "RUNTIME_CAPABILITY", label: t("RUNTIME_CAPABILITY") }] },
        { columnId: "status", label: t("Status"), allLabel: t("All states"), options: ["PUBLISHED", "NOT_CONFIGURED", "ENABLED", "DISABLED"].map((value) => ({ value, label: t(value) })) },
      ]} />
    </CardContent></Card>
    <Sheet open={selectedId !== null} onOpenChange={(open) => { if (!open) select(null) }}>
      <SheetContent data-testid="policy-detail-sheet" presentation="workspace-panel">
        <SheetHeader className="border-b px-6 py-5 pr-14">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <SheetTitle className="text-[1.375rem] font-semibold tracking-tight sm:text-2xl">{selected?.name ?? t("Policy unavailable")}</SheetTitle>
              <SheetDescription className="mt-1 max-w-3xl leading-6">{t("Manage policy rules and drafts, publish a reviewed revision, then inspect its effective execution.")}</SheetDescription>
            </div>
            <Button className="mr-8 shrink-0" variant="outline" disabled={loading} onClick={() => void load()}><RefreshCwIcon />{t("Refresh")}</Button>
          </div>
        </SheetHeader>
        <div className="flex flex-col gap-5 px-6 py-5">
          {notice ? <Alert role="status"><AlertDescription>{t(notice)}</AlertDescription></Alert> : null}
          {error ? <Alert variant="destructive"><AlertDescription>{t(error)}</AlertDescription></Alert> : null}
          {selectedId && !selected && !loading ? <DataEmpty icon={ShieldCheckIcon} title={t("Policy unavailable")} description={t("The policy may have been removed or is outside your current scope.")} /> : null}
          {selected ? <>
            <div className="flex flex-wrap items-center gap-3"><Badge variant="outline">{t(selected.source)}</Badge><Badge variant="outline">{t(selected.status)}</Badge>
              {selected.resource ? <RelationValue id={selected.resource.resource_id} label={selected.resource.display_name} href={`?view=resources&resource=${encodeURIComponent(selected.resource.resource_id)}`} /> : null}
            </div>
            {selected.source === "RUNTIME_CAPABILITY" ? <RuntimePolicyEditor key={`${selected.runtimePolicyId ?? selected.id}:${loadRevision}`} tenantId={tenantId} policy={selected.runtimePolicy ?? null} policyId={selected.runtimePolicyId ?? selected.id.replace(/^runtime:/, "")} initialDisplayName={selected.runtimeDisplayName} canEdit={canManageFirstPartyBotSeed} data={data} refreshKey={loadRevision} onDraftSaved={load} onPublished={async () => { setRuntimeComposer(null); await load(); setNotice("Runtime policy revision published.") }} /> : selected.resource ? <>
              <Alert><AlertDescription>{t("Access is evaluated against current Entitlements. These rules control processing, routing candidates and execution confirmation for this Capability.")}</AlertDescription></Alert>
              <ResourceEnforcementChainCard key={selected.id} refreshKey={loadRevision} canEdit={canManage(selected.resource)} connections={data.connections} initialCapabilityId={selected.capabilityId} resource={selected.resource} tenantId={tenantId} onSaved={load} onDraftSaved={load} />
            </> : botSeed ? <>
              <BotPolicyEditor refreshKey={loadRevision} key={botSeed.policy_revision} tenantId={tenantId} policy={botSeed} canEdit={canManageFirstPartyBotSeed} data={data} onDraftSaved={load} onPublished={async () => { await load(); setNotice("Policy revision published.") }} />
              {canManageFirstPartyBotSeed ? <div><Button variant="outline" onClick={() => setPendingEnabled(!botSeed.enabled)}>{t(botSeed.enabled ? "Disable policy" : "Enable policy")}</Button></div> : null}
            </> : null}
          </> : null}
        </div>
      </SheetContent>
    </Sheet>
    <Dialog open={creating} onOpenChange={setCreating}><DialogContent><DialogHeader><DialogTitle>{t("New policy")}</DialogTitle><DialogDescription>{t(createKind === "RUNTIME_CAPABILITY" ? "Name the policy, then select its scope and capabilities. Identifiers are generated automatically." : "Choose a Resource and Capability to configure its policy. Existing policy drafts reopen in the same editor.")}</DialogDescription></DialogHeader>
      <FieldGroup><Field><FieldLabel>{t("Policy kind")}</FieldLabel><Select value={createKind} onValueChange={(value) => setCreateKind(value as typeof createKind)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="RESOURCE_CAPABILITY">{t("Resource Capability")}</SelectItem><SelectItem value="RUNTIME_CAPABILITY">{t("Runtime Capability")}</SelectItem></SelectGroup></SelectContent></Select></Field>
        {createKind === "RUNTIME_CAPABILITY" ? <><details><summary className="cursor-pointer text-sm">{t("Technical ID")}</summary><p className="break-all font-mono text-xs">{createRuntimePolicyId}</p></details><Field><FieldLabel>{t("Policy name")}</FieldLabel><Input value={createRuntimeDisplayName} onChange={(event) => setCreateRuntimeDisplayName(event.target.value)} /></Field><Button disabled={!createRuntimeDisplayName.trim()} onClick={() => { const policyId = createRuntimePolicyId.trim(); setRuntimeComposer({ policyId, displayName: createRuntimeDisplayName.trim() || policyId }); setCreating(false); select(`runtime:${policyId}`) }}>{t("Continue")}</Button></> : <><Field><FieldLabel>{t("Resource")}</FieldLabel><SearchableSelect value={createResourceId} options={editableResources.map((resource) => ({ value: resource.resource_id, label: resource.display_name, description: resource.kind }))} onValueChange={(id) => { setCreateResourceId(id); setCreateCapabilityId("") }} placeholder={t("Select a Resource")} searchPlaceholder={t("Search resources")} emptyLabel={t("No results.")} /></Field><Field><FieldLabel>{t("Capability")}</FieldLabel><SearchableSelect value={createCapabilityId} options={(createResource?.capabilities ?? []).map((capability) => ({ value: capability.capability_id, label: capability.display_name }))} onValueChange={setCreateCapabilityId} placeholder={t("Select a Capability")} searchPlaceholder={t("Search capabilities")} emptyLabel={t("No results.")} /></Field><Button disabled={!createResourceId || !createCapabilityId} onClick={() => { setCreating(false); select(JSON.stringify([createResourceId, createCapabilityId])) }}>{t("Continue")}</Button></>}
      </FieldGroup>
    </DialogContent></Dialog>
    <AlertDialog open={pendingEnabled !== null} onOpenChange={(open) => { if (!open && !saving) setPendingEnabled(null) }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t(pendingEnabled ? "Enable policy" : "Disable policy")}</AlertDialogTitle><AlertDialogDescription>{t("This changes subsequent Bot access decisions. Existing policy rules and revision history are preserved.")}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={saving}>{t("Cancel")}</AlertDialogCancel><AlertDialogAction disabled={saving} onClick={(event) => { event.preventDefault(); void updateEnabled() }}>{t("Confirm")}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </div>
}
