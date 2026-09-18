import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { SearchableSelect } from "@/components/ui/searchable-select"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { ResourceRegistration, Organization, UseCaseEntry } from "@/domain/contracts"
import {
  listResourcePublicModels,
  listUseCases,
  loadModelRoutingPolicy,
  ProductApiError,
  saveModelRoutingPolicy,
  type ModelRoutingPolicyView,
  type PublicModelView,
} from "@/lib/product-api"

type ContextRequirement = NonNullable<ModelRoutingPolicyView["context_requirements"]>[number]

export function ResourceModelRoutingCard({
  canEdit,
  organizations,
  refreshKey = 0,
  resource,
  tenantId,
}: {
  canEdit: boolean
  organizations: Organization[]
  refreshKey?: number
  resource: ResourceRegistration
  tenantId: string
}) {
  const { t } = useTranslation()
  const capability = resource.capabilities.find((candidate) => candidate.capability_id === "model.invoke")
  const capabilityId = capability?.capability_id
  const [models, setModels] = useState<PublicModelView[]>([])
  const [policy, setPolicy] = useState<ModelRoutingPolicyView | null>(null)
  const [editing, setEditing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [mode, setMode] = useState<ModelRoutingPolicyView["mode"]>("DETERMINISTIC")
  const [leaseSeconds, setLeaseSeconds] = useState("1800")
  const [useCases, setUseCases] = useState<UseCaseEntry[]>([])
  const [contextUseCaseId, setContextUseCaseId] = useState("")
  const [minimumRisk, setMinimumRisk] = useState<"LOW" | "MEDIUM" | "HIGH" | "CRITICAL">("HIGH")
  const [requiredObligations, setRequiredObligations] = useState("")
  const [contextRequirements, setContextRequirements] = useState<ContextRequirement[]>([])
  const publishedModels = useMemo(
    () => models.filter((model) => model.lifecycle === "PUBLISHED"),
    [models],
  )
  const organizationLabels = useMemo(
    () => new Map(organizations.map((value) => [value.organization_id, value.display_name])),
    [organizations],
  )
  const useCaseOptions = useMemo(() => useCases.filter((value) => value.state === "ACTIVE").map((value) => ({
    value: `${value.organization_id}\u0000${value.use_case_id}`,
    label: value.display_name,
    description: `${organizationLabels.get(value.organization_id) ?? value.organization_id} · ${t(value.risk_level)}`,
    searchText: `${value.use_case_id} ${value.organization_id}`,
  })), [organizationLabels, t, useCases])

  useEffect(() => {
    if (!capabilityId) return
    let active = true
    setLoading(true)
    setError("")
    void Promise.all([
      listResourcePublicModels(tenantId, resource.resource_id),
      loadModelRoutingPolicy(tenantId, resource.resource_id, capabilityId).catch((caught) => {
        if (caught instanceof ProductApiError && caught.status === 404) return null
        throw caught
      }),
      Promise.all(organizations.map((organization) =>
        listUseCases(tenantId, organization.organization_id).catch(() => []),
      )).then((values) => values.flat()),
    ]).then(([nextModels, nextPolicy, nextUseCases]) => {
      if (!active) return
      setModels(nextModels)
      setPolicy(nextPolicy)
      setUseCases(nextUseCases)
      setMode(nextPolicy?.mode ?? "DETERMINISTIC")
      setLeaseSeconds(String(nextPolicy?.session_lease_seconds ?? 1800))
      setContextRequirements(nextPolicy?.context_requirements ?? [])
      setContextUseCaseId("")
      setMinimumRisk("HIGH")
      setRequiredObligations("")
    }).catch((caught) => {
      if (!active) return
      setError(caught instanceof Error ? caught.message : "MODEL_ROUTING_POLICY_LOAD_FAILED")
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [capabilityId, organizations, refreshKey, resource.lifecycle, resource.resource_id, tenantId])

  if (resource.kind !== "LLM" || !capability) return null

  async function save() {
    if (!capabilityId) return
    const ttl = Number.parseInt(leaseSeconds, 10)
    if (mode === "SESSION_LEASE" && (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 86_400)) {
      setError("SESSION_LEASE_TTL_INVALID")
      return
    }
    const candidates = publishedModels.map((model) => model.model_id)
    if (candidates.length === 0) {
      setError("PUBLIC_MODEL_REQUIRED")
      return
    }
    const obligations = [...new Set(requiredObligations.split(",").map((value) => value.trim()).filter(Boolean))].sort()
    const [consumerOrganizationId, useCaseId] = contextUseCaseId.split("\u0000")
    if ((contextUseCaseId && (!consumerOrganizationId || !useCaseId || obligations.length === 0)) || (!contextUseCaseId && obligations.length > 0)) {
      setError("CONTEXT_ROUTE_REQUIREMENT_INVALID")
      return
    }
    const nextRequirements = contextUseCaseId
      ? [...contextRequirements.filter((value) => !(
          value.consumer_organization_id === consumerOrganizationId &&
          value.use_case_id === useCaseId &&
          value.minimum_risk_level === minimumRisk
        )), {
          consumer_organization_id: consumerOrganizationId!,
          use_case_id: useCaseId!,
          minimum_risk_level: minimumRisk,
          required_obligation_kinds: obligations,
        }]
      : contextRequirements
    setSaving(true)
    setError("")
    try {
      const saved = await saveModelRoutingPolicy(
        tenantId,
        resource.resource_id,
        capabilityId,
        {
          routing_revision: (policy?.routing_revision ?? 0) + 1,
          mode,
          candidate_public_model_ids: candidates,
          default_public_model_id: policy && candidates.includes(policy.default_public_model_id)
            ? policy.default_public_model_id
            : candidates[0]!,
          session_lease_seconds: mode === "SESSION_LEASE" ? ttl : null,
          context_requirements: nextRequirements,
        },
      )
      setPolicy(saved)
      setEditing(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "MODEL_ROUTING_POLICY_SAVE_FAILED")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card data-testid="resource-model-routing">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>{t("Model routing")}</CardTitle>
          {canEdit && !editing ? (
            <Button onClick={() => setEditing(true)} size="sm" variant="outline">
              {t(policy ? "Edit routing" : "Configure routing")}
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error ? <Alert variant="destructive"><AlertTitle>{t("Model routing unavailable")}</AlertTitle><AlertDescription>{t(error)}</AlertDescription></Alert> : null}
        {loading ? <div className="text-sm text-muted-foreground">{t("Loading")}</div> : null}
        {!loading && policy && !editing ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <div><div className="text-xs text-muted-foreground">{t("Mode")}</div><div className="mt-1"><Badge variant="secondary">{t(policy.mode)}</Badge></div></div>
            <div><div className="text-xs text-muted-foreground">{t("Revision")}</div><div className="mt-1 font-medium tabular-nums">{policy.routing_revision}</div></div>
            <div><div className="text-xs text-muted-foreground">{t("Session TTL")}</div><div className="mt-1 font-medium">{policy.session_lease_seconds ? `${policy.session_lease_seconds}s` : "—"}</div></div>
            <div><div className="text-xs text-muted-foreground">{t("Context route requirements")}</div><div className="mt-1 font-medium">{policy.context_requirements?.length ?? 0}</div></div>
          </div>
        ) : null}
        {editing ? (
          <FieldGroup className="rounded-lg border p-4">
            <Field>
              <FieldLabel>{t("Routing mode")}</FieldLabel>
              <Select value={mode} onValueChange={(value) => setMode(value as ModelRoutingPolicyView["mode"])}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup><SelectItem value="DETERMINISTIC">{t("DETERMINISTIC")}</SelectItem><SelectItem value="SESSION_LEASE">{t("SESSION_LEASE")}</SelectItem></SelectGroup></SelectContent>
              </Select>
              <FieldDescription>{t("Session routing pins the selected public model and candidate order for one subject, client, and session.")}</FieldDescription>
            </Field>
            {mode === "SESSION_LEASE" ? <Field><FieldLabel>{t("Session lease seconds")}</FieldLabel><Input inputMode="numeric" min={1} max={86400} onChange={(event) => setLeaseSeconds(event.target.value)} type="number" value={leaseSeconds} /></Field> : null}
            <Field>
              <FieldLabel>{t("Managed Use Case (optional)")}</FieldLabel>
              <SearchableSelect value={contextUseCaseId} options={useCaseOptions} onValueChange={(value) => {
                setContextUseCaseId(value)
                const [organizationId, useCaseId] = value.split("\u0000")
                const selected = useCases.find((entry) => entry.organization_id === organizationId && entry.use_case_id === useCaseId)
                if (selected) setMinimumRisk(selected.risk_level)
              }} placeholder={t("No context-specific route")} searchPlaceholder={t("Search Use Cases")} emptyLabel={t("No active Use Cases found.")} />
              <FieldDescription>{t("The Resource owner can narrow the frozen route when this trusted Organization and Use Case reaches the selected risk level.")}</FieldDescription>
            </Field>
            {contextUseCaseId ? <>
              <Field>
                <FieldLabel>{t("Minimum risk")}</FieldLabel>
                <SearchableSelect value={minimumRisk} options={["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((value) => ({ value, label: t(value) }))} onValueChange={(value) => setMinimumRisk(value as typeof minimumRisk)} placeholder={t("Select risk")} searchPlaceholder={t("Search risk levels")} emptyLabel={t("No risk levels found.")} />
              </Field>
              <Field>
                <FieldLabel htmlFor="context-route-obligations">{t("Required obligations")}</FieldLabel>
                <Input id="context-route-obligations" value={requiredObligations} onChange={(event) => setRequiredObligations(event.target.value)} placeholder={t("dlp, audit")} />
                <FieldDescription>{t("Comma-separated obligation kinds. Only compatible Connections remain eligible.")}</FieldDescription>
              </Field>
              <Button onClick={() => {
                const [organizationId, useCaseId] = contextUseCaseId.split("\u0000")
                const obligations = [...new Set(requiredObligations.split(",").map((value) => value.trim()).filter(Boolean))].sort()
                if (!organizationId || !useCaseId || obligations.length === 0) {
                  setError("CONTEXT_ROUTE_REQUIREMENT_INVALID")
                  return
                }
                setContextRequirements((current) => [...current.filter((value) => !(
                  value.consumer_organization_id === organizationId &&
                  value.use_case_id === useCaseId &&
                  value.minimum_risk_level === minimumRisk
                )), {
                  consumer_organization_id: organizationId,
                  use_case_id: useCaseId,
                  minimum_risk_level: minimumRisk,
                  required_obligation_kinds: obligations,
                }])
                setContextUseCaseId("")
                setRequiredObligations("")
                setError("")
              }} type="button" variant="outline">{t("Add context route")}</Button>
            </> : null}
            {contextRequirements.length > 0 ? <div className="space-y-2">
              {contextRequirements.map((requirement) => {
                const useCase = useCases.find((value) =>
                  value.organization_id === requirement.consumer_organization_id &&
                  value.use_case_id === requirement.use_case_id
                )
                return <div className="flex items-center justify-between gap-3 rounded-md border p-3" key={`${requirement.consumer_organization_id}:${requirement.use_case_id}:${requirement.minimum_risk_level}`}>
                  <div><div className="font-medium">{useCase?.display_name ?? requirement.use_case_id}</div><div className="text-xs text-muted-foreground">{organizationLabels.get(requirement.consumer_organization_id) ?? requirement.consumer_organization_id} · {t(requirement.minimum_risk_level)} · {requirement.required_obligation_kinds.join(", ")}</div></div>
                  <Button onClick={() => setContextRequirements((current) => current.filter((value) => value !== requirement))} size="sm" type="button" variant="ghost">{t("Remove")}</Button>
                </div>
              })}
            </div> : null}
          </FieldGroup>
        ) : null}
      </CardContent>
      {editing ? <CardFooter className="justify-end gap-2"><Button onClick={() => { setEditing(false); setError("") }} variant="outline">{t("Cancel")}</Button><Button disabled={saving} onClick={() => void save()}>{saving ? t("Saving") : t("Save routing")}</Button></CardFooter> : null}
    </Card>
  )
}
