import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { SearchableSelect } from "@/components/ui/searchable-select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { CreateUsagePolicyRevisionInput, ResourceRegistration, Organization, TenantIdentityInventory, UseCaseEntry, UsagePolicyRevision } from "@/domain/contracts"
import { createUsagePolicyRevision, createUseCase, listUsagePolicies, listUseCases } from "@/lib/product-api"

type LimitKind = "REQUEST_QUOTA" | "CONCURRENCY" | "CREDIT_BUDGET" | "CURRENCY_BUDGET"

const limitOptions = [
  { value: "REQUEST_QUOTA", label: "Request quota" },
  { value: "CONCURRENCY", label: "Concurrency" },
  { value: "CREDIT_BUDGET", label: "Credit budget" },
  { value: "CURRENCY_BUDGET", label: "Currency budget" },
]

function limitSummary(policy: UsagePolicyRevision) {
  if (policy.limits.request_quota) return `${policy.limits.request_quota.limit} / ${policy.limits.request_quota.window_seconds}s`
  if (policy.limits.concurrency) return `${policy.limits.concurrency.limit} · TTL ${policy.limits.concurrency.lease_ttl_seconds}s`
  if (policy.limits.credit_budget) return `${policy.limits.credit_budget.limit} credits · ${policy.limits.credit_budget.credits_per_admitted_request}/request`
  if (policy.limits.currency_budget) return `${policy.limits.currency_budget.currency} ${(policy.limits.currency_budget.limit_micros / 1_000_000).toFixed(6)} / ${policy.limits.currency_budget.window_seconds}s`
  return "—"
}

export function UsageGovernancePanel({
  tenantId,
  organizations,
  resources,
  identity,
}: {
  tenantId: string
  organizations: Organization[]
  resources: ResourceRegistration[]
  identity: TenantIdentityInventory | null
}) {
  const { t } = useTranslation()
  const [ownerOrganizationId, setOwnerOrganizationId] = useState(organizations[0]?.organization_id ?? "")
  const [consumerOrganizationId, setConsumerOrganizationId] = useState(organizations[0]?.organization_id ?? "")
  const [resourceId, setResourceId] = useState("")
  const [capabilityId, setCapabilityId] = useState("")
  const [useCases, setUseCases] = useState<UseCaseEntry[]>([])
  const [policies, setPolicies] = useState<UsagePolicyRevision[]>([])
  const [selectedPolicyId, setSelectedPolicyId] = useState("")
  const [policyDisplayName, setPolicyDisplayName] = useState("")
  const [subjectId, setSubjectId] = useState("")
  const [useCaseId, setUseCaseId] = useState("")
  const [newUseCaseName, setNewUseCaseName] = useState("")
  const [newUseCaseRisk, setNewUseCaseRisk] = useState<"LOW" | "MEDIUM" | "HIGH" | "CRITICAL">("LOW")
  const [limitKind, setLimitKind] = useState<LimitKind>("REQUEST_QUOTA")
  const [limit, setLimit] = useState("100")
  const [windowSeconds, setWindowSeconds] = useState("60")
  const [allocationId, setAllocationId] = useState("")
  const [unitsPerRequest, setUnitsPerRequest] = useState("1")
  const [currency, setCurrency] = useState("USD")
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState("")
  const [failure, setFailure] = useState("")

  const organizationOptions = useMemo(() => organizations.map((organization) => ({
    value: organization.organization_id,
    label: organization.display_name,
  })), [organizations])
  const resourceOptions = useMemo(() => resources.map((resource) => ({
    value: resource.resource_id,
    label: resource.display_name,
    searchText: resource.capabilities.map((capability) => capability.display_name).join(" "),
  })), [resources])
  const subjectOptions = useMemo(() => (identity?.subjects ?? []).map((subject) => ({
    value: subject.subject_id,
    label: subject.profile.display_name ?? subject.subject_id,
    description: subject.kind,
    searchText: subject.subject_id,
  })), [identity])
  const policyOptions = useMemo(() => policies.map((policy) => ({
    value: policy.usage_policy_id,
    label: policy.display_name ?? policy.usage_policy_id,
    description: `${t("Revision")} ${policy.revision}`,
    searchText: policy.usage_policy_id,
  })), [policies, t])
  const selectedResource = resources.find((resource) => resource.resource_id === resourceId)
  const selectedPolicy = policies.find((policy) => policy.usage_policy_id === selectedPolicyId)
  const capabilityOptions = useMemo(() => (selectedResource?.capabilities ?? []).map((capability) => ({
    value: capability.capability_id,
    label: capability.display_name,
    description: capability.capability_id,
  })), [selectedResource])
  const useCaseOptions = useMemo(() => useCases.filter((entry) => entry.state === "ACTIVE").map((entry) => ({
    value: entry.use_case_id,
    label: entry.display_name,
    description: `${t(entry.risk_level)} · ${entry.use_case_id}`,
  })), [t, useCases])
  const organizationLabels = useMemo(() => new Map(organizations.map((value) => [value.organization_id, value.display_name])), [organizations])
  const resourceLabels = useMemo(() => new Map(resources.map((value) => [value.resource_id, value.display_name])), [resources])

  useEffect(() => {
    const first = organizations[0]?.organization_id ?? ""
    if (!organizations.some((value) => value.organization_id === ownerOrganizationId)) setOwnerOrganizationId(first)
    if (!organizations.some((value) => value.organization_id === consumerOrganizationId)) setConsumerOrganizationId(first)
  }, [consumerOrganizationId, organizations, ownerOrganizationId])

  useEffect(() => {
    let active = true
    void listUsagePolicies(tenantId)
      .then((value) => { if (active) setPolicies(value) })
      .catch((error) => { if (active) setFailure(error instanceof Error ? error.message : "USAGE_POLICY_LOAD_FAILED") })
    return () => { active = false }
  }, [tenantId])

  useEffect(() => {
    if (!consumerOrganizationId) {
      setUseCases([])
      setUseCaseId("")
      return
    }
    setUseCaseId("")
    let active = true
    void listUseCases(tenantId, consumerOrganizationId)
      .then((value) => { if (active) setUseCases(value) })
      .catch((error) => { if (active) setFailure(error instanceof Error ? error.message : "USE_CASE_LOAD_FAILED") })
    return () => { active = false }
  }, [consumerOrganizationId, tenantId])

  async function submitUseCase() {
    if (!consumerOrganizationId || !newUseCaseName.trim()) return
    setBusy(true)
    setFailure("")
    try {
      const created = await createUseCase(tenantId, consumerOrganizationId, {
        displayName: newUseCaseName.trim(),
        riskLevel: newUseCaseRisk,
      })
      setUseCases((current) => [...current.filter((value) => value.use_case_id !== created.use_case_id), created])
      setUseCaseId(created.use_case_id)
      setNewUseCaseName("")
      setFeedback(t("Use Case created; a successor Gateway Release was queued."))
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "USE_CASE_CREATE_FAILED")
    } finally {
      setBusy(false)
    }
  }

  async function submitPolicy() {
    if (!policyDisplayName.trim() || !ownerOrganizationId) return
    const numericLimit = Number(limit)
    const numericWindow = Number(windowSeconds)
    const numericUnits = Number(unitsPerRequest)
    if (!Number.isSafeInteger(numericLimit) || numericLimit < 1 || !Number.isSafeInteger(numericWindow) || numericWindow < 1) return
    if (limitKind === "CREDIT_BUDGET" && (!Number.isSafeInteger(numericUnits) || numericUnits < 1)) return
    if (limitKind === "CURRENCY_BUDGET" && !/^[A-Z]{3}$/.test(currency.trim().toUpperCase())) return
    const previousRevision = selectedPolicy?.revision ?? 0
    const selectors = {
      ...(subjectId.trim() ? { subject_id: subjectId.trim() } : {}),
      ...(consumerOrganizationId ? { consumer_organization_id: consumerOrganizationId } : {}),
      ...(resourceId ? { resource_id: resourceId } : {}),
      ...(capabilityId ? { capability_id: capabilityId } : {}),
      ...(useCaseId ? { use_case_id: useCaseId } : {}),
    }
    const limits: CreateUsagePolicyRevisionInput["limits"] = limitKind === "REQUEST_QUOTA"
      ? { request_quota: { limit: numericLimit, window_seconds: numericWindow } }
      : limitKind === "CONCURRENCY"
        ? { concurrency: { limit: numericLimit, lease_ttl_seconds: numericWindow } }
        : limitKind === "CREDIT_BUDGET"
          ? { credit_budget: { ...(allocationId.trim() ? { allocation_id: allocationId.trim() } : {}), limit: numericLimit, credits_per_admitted_request: numericUnits } }
          : { currency_budget: { ...(allocationId.trim() ? { allocation_id: allocationId.trim() } : {}), window_seconds: numericWindow, currency: currency.trim().toUpperCase(), limit_micros: numericLimit } }
    setBusy(true)
    setFailure("")
    try {
      const created = await createUsagePolicyRevision(tenantId, {
        ...(selectedPolicy ? {
          usage_policy_id: selectedPolicy.usage_policy_id,
          revision: previousRevision + 1,
          accounting_key_id: selectedPolicy.accounting_key_id,
        } : {}),
        display_name: policyDisplayName.trim(),
        owner_organization_id: ownerOrganizationId,
        selectors,
        limits,
        state: "ACTIVE",
      })
      setPolicies((current) => [...current.filter((value) => value.usage_policy_id !== created.usage_policy_id), created])
      setSelectedPolicyId(created.usage_policy_id)
      setPolicyDisplayName(created.display_name ?? policyDisplayName.trim())
      setAllocationId(created.limits.credit_budget?.allocation_id ?? created.limits.currency_budget?.allocation_id ?? "")
      setFeedback(t("Usage Policy revision created; a successor Gateway Release was queued."))
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "USAGE_POLICY_CREATE_FAILED")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card data-testid="usage-governance-panel">
      <CardHeader className="border-b">
        <CardTitle>{t("Usage governance")}</CardTitle>
        <p className="text-sm text-muted-foreground">{t("Manage Organization-owned Use Cases and immutable Usage Policy revisions. Runtime application remains visible in Runtime status.")}</p>
      </CardHeader>
      <CardContent className="space-y-6 p-5">
        {failure ? <p role="alert" className="text-sm text-destructive">{t(failure)}</p> : null}
        {feedback ? <p role="status" className="text-sm text-emerald-700">{feedback}</p> : null}

        <section className="space-y-3">
          <div>
            <h3 className="font-medium">{t("Managed Use Cases")}</h3>
            <p className="text-sm text-muted-foreground">{t("Choose a consumer Organization, then create or select a human-readable business purpose.")}</p>
          </div>
          <div className="grid gap-3 lg:grid-cols-4">
            <Field><FieldLabel>{t("Consumer Organization")}</FieldLabel><SearchableSelect value={consumerOrganizationId} options={organizationOptions} onValueChange={setConsumerOrganizationId} placeholder={t("Select Organization")} searchPlaceholder={t("Search Organizations")} emptyLabel={t("No Organizations found.")} /></Field>
            <Field><FieldLabel htmlFor="new-use-case-name">{t("Display name")}</FieldLabel><Input id="new-use-case-name" value={newUseCaseName} onChange={(event) => setNewUseCaseName(event.target.value)} /></Field>
            <Field><FieldLabel>{t("Risk")}</FieldLabel><SearchableSelect value={newUseCaseRisk} options={["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((value) => ({ value, label: t(value) }))} onValueChange={(value) => setNewUseCaseRisk(value as typeof newUseCaseRisk)} placeholder={t("Select risk")} searchPlaceholder={t("Search risk levels")} emptyLabel={t("No risk levels found.")} /></Field>
            <div className="flex items-end"><Button className="w-full" disabled={busy || !consumerOrganizationId || !newUseCaseName.trim()} onClick={submitUseCase}>{t("Create Use Case")}</Button></div>
          </div>
        </section>

        <section className="space-y-3 border-t pt-5">
          <div>
            <h3 className="font-medium">{t("Immutable Usage Policy")}</h3>
            <p className="text-sm text-muted-foreground">{t("All matching policies apply. Accounting keys aggregate approved shared upstream capacity independently of Connection identity.")}</p>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <Field>
              <FieldLabel htmlFor="usage-policy-name">{t("Display name")}</FieldLabel>
              <Input id="usage-policy-name" value={policyDisplayName} onChange={(event) => setPolicyDisplayName(event.target.value)} />
              <p className="text-xs text-muted-foreground">{t(selectedPolicy ? "New revision keeps the existing policy and accounting identities." : "Policy, revision, accounting, and budget identities are generated automatically.")}</p>
            </Field>
            <Field>
              <FieldLabel>{t("Existing Usage Policy (optional)")}</FieldLabel>
              <SearchableSelect
                value={selectedPolicyId}
                options={policyOptions}
                onValueChange={(value) => {
                  const policy = policies.find((candidate) => candidate.usage_policy_id === value)
                  setSelectedPolicyId(value)
                  setPolicyDisplayName(policy?.display_name ?? "")
                  setAllocationId(policy?.limits.credit_budget?.allocation_id ?? policy?.limits.currency_budget?.allocation_id ?? "")
                }}
                placeholder={t("Create new Usage Policy")}
                searchPlaceholder={t("Search Usage Policies")}
                emptyLabel={t("No Usage Policies found.")}
              />
            </Field>
            <Field><FieldLabel>{t("Owner Organization")}</FieldLabel><SearchableSelect value={ownerOrganizationId} options={organizationOptions} onValueChange={setOwnerOrganizationId} placeholder={t("Select Organization")} searchPlaceholder={t("Search Organizations")} emptyLabel={t("No Organizations found.")} /></Field>
            <Field><FieldLabel>{t("Subject (optional)")}</FieldLabel><SearchableSelect value={subjectId} options={subjectOptions} onValueChange={setSubjectId} placeholder={t("All Subjects")} searchPlaceholder={t("Search Subjects")} emptyLabel={t("No Subjects found.")} /></Field>
            <Field><FieldLabel>{t("Resource")}</FieldLabel><SearchableSelect value={resourceId} options={resourceOptions} onValueChange={(value) => { setResourceId(value); setCapabilityId("") }} placeholder={t("Select Resource")} searchPlaceholder={t("Search Resources")} emptyLabel={t("No Resources found.")} /></Field>
            <Field><FieldLabel>{t("Capability")}</FieldLabel><SearchableSelect value={capabilityId} options={capabilityOptions} onValueChange={setCapabilityId} placeholder={t("Select Capability")} searchPlaceholder={t("Search Capabilities")} emptyLabel={t("No Capabilities found.")} /></Field>
            <Field><FieldLabel>{t("Use Case")}</FieldLabel><SearchableSelect value={useCaseId} options={useCaseOptions} onValueChange={setUseCaseId} placeholder={t("Select Use Case")} searchPlaceholder={t("Search Use Cases")} emptyLabel={t("No Use Cases found.")} /></Field>
            <Field><FieldLabel>{t("Limit type")}</FieldLabel><SearchableSelect value={limitKind} options={limitOptions.map((value) => ({ ...value, label: t(value.label) }))} onValueChange={(value) => setLimitKind(value as LimitKind)} placeholder={t("Select limit type")} searchPlaceholder={t("Search limit types")} emptyLabel={t("No limit types found.")} /></Field>
            <Field><FieldLabel htmlFor="usage-limit">{t(limitKind === "CURRENCY_BUDGET" ? "Limit micros" : "Limit")}</FieldLabel><Input id="usage-limit" inputMode="numeric" value={limit} onChange={(event) => setLimit(event.target.value)} /></Field>
            <Field><FieldLabel htmlFor="usage-window">{t(limitKind === "CONCURRENCY" ? "Lease TTL seconds" : "Window seconds")}</FieldLabel><Input id="usage-window" inputMode="numeric" value={windowSeconds} onChange={(event) => setWindowSeconds(event.target.value)} /></Field>
            {limitKind === "CREDIT_BUDGET" || limitKind === "CURRENCY_BUDGET" ? <p className="self-end text-xs text-muted-foreground">{t("Budget allocation identity is generated automatically.")}</p> : null}
            {limitKind === "CREDIT_BUDGET" ? <Field><FieldLabel htmlFor="usage-units">{t("Credits per request")}</FieldLabel><Input id="usage-units" inputMode="numeric" value={unitsPerRequest} onChange={(event) => setUnitsPerRequest(event.target.value)} /></Field> : null}
            {limitKind === "CURRENCY_BUDGET" ? <Field><FieldLabel htmlFor="usage-currency">{t("Currency")}</FieldLabel><Input id="usage-currency" value={currency} maxLength={3} onChange={(event) => setCurrency(event.target.value)} /></Field> : null}
          </div>
          <Button disabled={busy || !policyDisplayName.trim() || !ownerOrganizationId} onClick={submitPolicy}>{t("Create Usage Policy revision")}</Button>
        </section>

        <section className="space-y-3 border-t pt-5">
          <h3 className="font-medium">{t("Active Usage Policies")}</h3>
          <Table>
            <TableHeader><TableRow><TableHead>{t("Policy")}</TableHead><TableHead>{t("Scope")}</TableHead><TableHead>{t("Accounting key")}</TableHead><TableHead>{t("Limit")}</TableHead><TableHead>{t("State")}</TableHead></TableRow></TableHeader>
            <TableBody>
              {policies.map((policy) => (
                <TableRow key={`${policy.usage_policy_id}-${policy.revision}`}>
                  <TableCell><div className="font-medium">{policy.display_name ?? policy.usage_policy_id}</div><div className="font-mono text-xs text-muted-foreground">{policy.usage_policy_id} · {t("Revision")} {policy.revision}</div></TableCell>
                  <TableCell className="text-xs"><div>{organizationLabels.get(policy.selectors.consumer_organization_id ?? "") ?? policy.selectors.consumer_organization_id ?? t("All Organizations")}</div><div>{resourceLabels.get(policy.selectors.resource_id ?? "") ?? policy.selectors.resource_id ?? t("All Resources")}</div><div>{policy.selectors.capability_id ?? t("All Capabilities")} · {policy.selectors.use_case_id ?? t("All Use Cases")}</div></TableCell>
                  <TableCell className="font-mono text-xs">{policy.accounting_key_id}</TableCell>
                  <TableCell>{limitSummary(policy)}</TableCell>
                  <TableCell><Badge variant="outline">{t(policy.state)}</Badge></TableCell>
                </TableRow>
              ))}
              {policies.length === 0 ? <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">{t("No active Usage Policies.")}</TableCell></TableRow> : null}
            </TableBody>
          </Table>
        </section>
      </CardContent>
    </Card>
  )
}
