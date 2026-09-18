import { DiscardPolicyDraft } from "@/features/policy/discard-policy-draft"
import { DATA_PROTECTION_SEMANTIC_TYPES, executableStep, processLabel, processSteps, requiresExecutionConfirmation, type DraftProcessStep, type RequestAction, type ResponseAction } from "@/features/policy/policy-process-draft"
import { buildResourcePolicyDefinition, getPolicyDraft, policyDraftPath, publishPolicyDraft, savePolicyDraft, validateResourcePolicy, type PolicyDraftView } from "@/lib/product-api"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { SearchableSelect } from "@/components/ui/searchable-select"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { ConnectionSummary, ResourceRegistration } from "@/domain/contracts"
import {
  getLatestResourceEnforcementChain,
  listResourcePublicModels,
  ProductApiError,
  type EnforcementChainRevisionView,
  type PublicModelView,
} from "@/lib/product-api"

export function ResourceEnforcementChainCard({
  canEdit,
  initialCapabilityId,
  onSaved,
  onDraftSaved,
  refreshKey = 0,
  resource,
  tenantId,
  connections = [],
}: {
  canEdit: boolean
  initialCapabilityId?: string
  onDraftSaved?: () => void | Promise<void>
  onSaved?: () => void | Promise<void>
  refreshKey?: number
  resource: ResourceRegistration
  tenantId: string
  connections?: ConnectionSummary[]
}) {
  const { t } = useTranslation()
  const [capabilityId, setCapabilityId] = useState(
    initialCapabilityId ?? resource.capabilities[0]?.capability_id ?? "",
  )
  const [editing, setEditing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [persistedDraft, setPersistedDraft] = useState<PolicyDraftView | null>(null)
  const [notice, setNotice] = useState("")
  const [reviewed, setReviewed] = useState(false)
  const [revision, setRevision] = useState<EnforcementChainRevisionView | null>(null)
  const [draft, setDraft] = useState<DraftProcessStep[]>([])
  const [publicModels, setPublicModels] = useState<PublicModelView[]>([])
  const [executionConfirmation, setExecutionConfirmation] = useState(false)
  const [eligibleConnectionIds, setEligibleConnectionIds] = useState<string[]>([])

  const resourceConnections = useMemo(
    () => connections.filter((connection) => connection.resource_id === resource.resource_id),
    [connections, resource.resource_id],
  )
  const readyConnections = useMemo(
    () => resourceConnections.filter((connection) =>
      connection.lifecycle === "ENABLED" &&
      connection.verification_state === "VERIFIED" &&
      connection.health_state === "HEALTHY" &&
      (!connection.certificate || ["NOT_CONFIGURED", "VALID", "EXPIRING"].includes(connection.certificate.status)),
    ),
    [resourceConnections],
  )

  useEffect(() => {
    if (resource.kind !== "LLM") return
    let active = true
    void listResourcePublicModels(tenantId, resource.resource_id)
      .then((models) => {
        if (active) setPublicModels(models.filter((model) => model.lifecycle === "PUBLISHED"))
      })
      .catch(() => {
        if (active) setPublicModels([])
      })
    return () => { active = false }
  }, [refreshKey, resource.kind, resource.resource_id, resource.lifecycle, tenantId])

  useEffect(() => {
    let active = true
    if (!capabilityId) {
      setLoading(false)
      return () => { active = false }
    }
    setLoading(true)
    setError("")
    const path = policyDraftPath(tenantId, { resourceId: resource.resource_id, capabilityId })
    void Promise.all([
      getLatestResourceEnforcementChain(tenantId, resource.resource_id, capabilityId).catch((caught) => {
        if (caught instanceof ProductApiError && caught.status === 404) return null
        throw caught
      }),
      getPolicyDraft(path),
    ]).then(([value, savedDraft]) => {
      if (!active) return
      setRevision(value)
      setPersistedDraft(savedDraft)
      setReviewed(false)
      const definition = canEdit && savedDraft?.content.kind === "RESOURCE_CAPABILITY" ? savedDraft.content.definition : null
      const source = definition ? { chain: { steps: definition.steps, eligible_connection_ids: definition.eligible_connection_ids ?? [] } } : value
      setDraft(processSteps(source as EnforcementChainRevisionView | null))
      setExecutionConfirmation(requiresExecutionConfirmation(source as EnforcementChainRevisionView | null))
      setEligibleConnectionIds(source?.chain.eligible_connection_ids ?? readyConnections.map((connection) => connection.connection_id))
      setEditing(Boolean(savedDraft) && canEdit)
    }).catch((caught) => {
      if (active) setError(caught instanceof Error ? caught.message : "ENFORCEMENT_CHAIN_LOAD_FAILED")
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [capabilityId, readyConnections, resource.lifecycle, resource.resource_id, tenantId, refreshKey, canEdit])

  function updateStep(index: number, value: Partial<DraftProcessStep>) {
    setReviewed(false)
    setDraft((current) => current.map((step, stepIndex) =>
      stepIndex === index ? { ...step, ...value, changed: true } : step))
  }

  function moveStep(index: number, offset: -1 | 1) {
    setReviewed(false)
    setDraft((current) => {
      const target = index + offset
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  async function save() {
    const invalid = draft.find((step) =>
      (step.requestAction === "NONE" && step.responseAction === "NONE") ||
      (step.requestAction === "TOKENIZE") !== (step.responseAction === "RESTORE") ||
      (step.requestAction === "MODEL_CLASSIFIER" && (
        !step.classifierKeywords.split(",").some((value) => value.trim()) ||
        !step.classifierModel ||
        !step.classifierFallback
      )))
    if (invalid) {
      setError("TOKENIZE_RESTORE_PAIR_REQUIRED")
      return
    }
    setSaving(true)
    setError("")
    try {
      const definition = await buildResourcePolicyDefinition((revision?.one_policy_revision ?? 0) + 1, draft.map(executableStep), resource.api?.inbound_security, executionConfirmation, eligibleConnectionIds, revision)
      const saved = await savePolicyDraft(policyDraftPath(tenantId, { resourceId: resource.resource_id, capabilityId }), {
        expected_version: persistedDraft?.version ?? 0,
        base_revision: revision?.one_policy_revision ?? 0,
        content: { kind: "RESOURCE_CAPABILITY", definition },
      })
      setPersistedDraft(saved)
      setReviewed(false)
      setNotice("Draft saved. Published policy is unchanged.")
      await onDraftSaved?.()

    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "ENFORCEMENT_CHAIN_SAVE_FAILED")
    } finally {
      setSaving(false)
    }
  }

  async function reviewOrPublish(publish: boolean) {
    if (persistedDraft?.content.kind !== "RESOURCE_CAPABILITY") return
    setSaving(true)
    setError("")
    try {
      if (!publish) {
        await validateResourcePolicy(tenantId, resource.resource_id, capabilityId, persistedDraft.content.definition)
        setReviewed(true)
        setNotice("Validation passed. Review the saved draft before publishing.")
      } else {
        const saved = await publishPolicyDraft<EnforcementChainRevisionView>(policyDraftPath(tenantId, { resourceId: resource.resource_id, capabilityId }), persistedDraft.version)
        setRevision(saved)
        setPersistedDraft(null)
        setDraft(processSteps(saved))
        setEditing(false)
        setReviewed(false)
        setNotice(resource.lifecycle === "DRAFT" ? "Policy revision published for this draft Resource. Publish the Resource before checking Runtime readiness." : "Policy published. Check Runtime status before expecting traffic changes.")
        await onSaved?.()
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "POLICY_PUBLISH_FAILED") }
    finally { setSaving(false) }
  }

  const savedDefinition = persistedDraft?.content.kind === "RESOURCE_CAPABILITY" ? persistedDraft.content.definition : null
  const unsaved = Boolean(savedDefinition && (
    JSON.stringify(draft.map(executableStep)) !== JSON.stringify(savedDefinition.steps.filter((step) => step.kind === "PROCESS").map((step) => ({ step_id: step.step_id, hooks: step.hooks }))) ||
    JSON.stringify(eligibleConnectionIds) !== JSON.stringify(savedDefinition.eligible_connection_ids ?? []) ||
    executionConfirmation !== savedDefinition.steps.some((step) => step.kind === "AUTHORIZE" && Array.isArray(step.config?.required_obligations) && step.config.required_obligations.includes("execution.confirmation"))
  ))
  const displayed = editing ? draft : processSteps(revision)
  const chain = [
    { id: "authenticate", label: t("Authenticate"), fixed: true },
    { id: "authorize", label: t("Authorize"), fixed: true },
    ...displayed.map((step) => ({ id: step.stepId, label: processLabel(step), fixed: false })),
    { id: "route", label: t("Route"), fixed: true },
  ]

  return (
    <Card data-testid="resource-enforcement-chain">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardTitle>{t("Policy rules")}</CardTitle>
            <CardDescription>{t("Request steps run top to bottom; response hooks return in reverse order.")}</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {revision ? <Badge variant="secondary">{t("Revision")} {revision.one_policy_revision}</Badge> : <Badge variant="outline">{t("Not configured")}</Badge>}
            {canEdit && !editing ? <Button onClick={() => setEditing(true)} size="sm" variant="outline">{t("Edit policy")}</Button> : null}
          </div>
        </div>
      </CardHeader>
      {notice ? <div className="px-6" role="status"><Alert><AlertDescription>{t(notice)}</AlertDescription></Alert></div> : null}
      {persistedDraft && canEdit ? <div className="flex flex-wrap items-center gap-3 px-6 py-3">
        <Badge variant="outline">{t("Draft")} {persistedDraft.version}</Badge>
        {canEdit ? <DiscardPolicyDraft path={policyDraftPath(tenantId, { resourceId: resource.resource_id, capabilityId })} version={persistedDraft.version} onDiscarded={async () => { setPersistedDraft(null); setDraft(processSteps(revision)); setExecutionConfirmation(requiresExecutionConfirmation(revision)); setEligibleConnectionIds(revision?.chain.eligible_connection_ids ?? []); setEditing(false); setReviewed(false); setNotice(""); await onDraftSaved?.() }} /> : null}
        {unsaved ? <Badge variant="outline">{t("Draft changes not saved")}</Badge> : null}
        <span className="text-sm text-muted-foreground">{t("Publishing applies the saved draft, not unsaved form changes.")}</span>
        <Button disabled={saving || unsaved} variant="outline" onClick={() => void reviewOrPublish(false)}>{t("Validate draft")}</Button>
        <Button disabled={saving || !reviewed || unsaved} onClick={() => void reviewOrPublish(true)}>{t("Publish saved draft")}</Button>
      </div> : null}
      <CardContent className="flex flex-col gap-4">
        {resource.capabilities.length > 1 ? (
          <Field>
            <FieldLabel>{t("Capability")}</FieldLabel>
            <Select value={capabilityId} onValueChange={setCapabilityId}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectGroup>{resource.capabilities.map((capability) => (
                <SelectItem key={capability.capability_id} value={capability.capability_id}>{capability.display_name}</SelectItem>
              ))}</SelectGroup></SelectContent>
            </Select>
          </Field>
        ) : null}
        {error ? <Alert variant="destructive"><AlertTitle>{t("Unable to save enforcement chain")}</AlertTitle><AlertDescription>{t(error)}</AlertDescription></Alert> : null}
        <FieldGroup className="rounded-lg border p-4">
          <div>
            <FieldLabel>{t("Connection candidates")}</FieldLabel>
            <p className="text-xs text-muted-foreground">{t("Freeze the verified and healthy Resource-owned Connections this policy may attempt. Runtime failover cannot expand this set.")}</p>
          </div>
          {resourceConnections.length === 0 ? <div className="flex flex-col gap-2"><p className="text-sm text-muted-foreground">{t("No Connections are registered for this Resource.")}</p><Button asChild variant="outline"><a href={`?view=connections&resource=${encodeURIComponent(resource.resource_id)}&create=1`}>{t("Add Connection")}</a></Button></div> : (
            <div className="grid gap-2">
              {resourceConnections.map((connection) => {
                const ready = readyConnections.some((candidate) => candidate.connection_id === connection.connection_id)
                const checked = eligibleConnectionIds.includes(connection.connection_id)
                return (
                  <label className="flex items-start gap-3 rounded-md border p-3" key={connection.connection_id}>
                    <Checkbox
                      checked={checked}
                      disabled={!editing || (!ready && !checked)}
                      onCheckedChange={(value) => setEligibleConnectionIds((current) => value === true
                        ? [...new Set([...current, connection.connection_id])]
                        : current.filter((id) => id !== connection.connection_id))}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{connection.display_name}</span>
                      <span className="block text-xs text-muted-foreground" title={connection.connection_id}>{connection.region ?? connection.kind}</span>
                    </span>
                    <Badge variant={ready ? "secondary" : "outline"}>{t(ready ? "Ready" : connection.lifecycle)}</Badge>
                  </label>
                )
              })}
            </div>
          )}
        </FieldGroup>
        {loading ? <div className="text-sm text-muted-foreground">{t("Loading")}</div> : (
          <div className="flex flex-col gap-2">
            {chain.map((step, index) => (
              <div className="flex min-w-0 items-center gap-3 rounded-lg border p-3" key={step.id}>
                <Badge variant={step.fixed ? "secondary" : "outline"}>{index + 1}</Badge>
                <div className="min-w-0 flex-1 truncate font-medium">{step.label}</div>
                {step.fixed ? <Badge variant="secondary">{t("Required")}</Badge> : editing ? (
                  <div className="flex items-center gap-1">
                    <Button aria-label={t("Move up")} disabled={index === 2} onClick={() => moveStep(index - 2, -1)} size="icon-sm" type="button" variant="ghost"><ArrowUpIcon /></Button>
                    <Button aria-label={t("Move down")} disabled={index === chain.length - 2} onClick={() => moveStep(index - 2, 1)} size="icon-sm" type="button" variant="ghost"><ArrowDownIcon /></Button>
                    <Button aria-label={t("Remove step")} onClick={() => setDraft((current) => current.filter((item) => item.stepId !== step.id))} size="icon-sm" type="button" variant="ghost"><Trash2Icon /></Button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
        {editing ? <FieldGroup>
          <Field orientation="horizontal"><Checkbox checked={executionConfirmation} onCheckedChange={(checked) => setExecutionConfirmation(checked === true)} /><div><FieldLabel>{t("Require execution confirmation")}</FieldLabel><p className="text-xs text-muted-foreground">{t("A Human-approved one-time Execution Grant must match the exact action digest.")}</p></div></Field>
          {draft.map((step, index) => (
            <FieldGroup className="rounded-lg border p-4" key={step.stepId}>
              <div className="font-medium">{index + 1}. {processLabel(step)}</div>
              <div className="grid gap-4 md:grid-cols-2">
                <Field><FieldLabel>{t("Request hook")}</FieldLabel><Select value={step.requestAction} onValueChange={(value) => {
                  const requestAction = value as RequestAction
                  updateStep(index, {
                    requestAction,
                    ...(requestAction === "TOKENIZE" ? { responseAction: "RESTORE" as const } : step.responseAction === "RESTORE" ? { responseAction: "NONE" as const } : {}),
                    ...(requestAction === "MODEL_CLASSIFIER" ? { responseAction: "NONE" as const } : {}),
                  })
                }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectGroup>
                  <SelectItem value="NONE">{t("None")}</SelectItem><SelectItem value="BLOCK">{t("BLOCK")}</SelectItem><SelectItem value="REDACT">{t("REDACT")}</SelectItem><SelectItem value="TOKENIZE">{t("TOKENIZE")}</SelectItem><SelectItem value="MODEL_CLASSIFIER">{t("MODEL CLASSIFIER")}</SelectItem>
                </SelectGroup></SelectContent></Select></Field>
                <Field><FieldLabel>{t("Response hook")}</FieldLabel><Select value={step.responseAction} onValueChange={(value) => {
                  const responseAction = value as ResponseAction
                  updateStep(index, {
                    responseAction,
                    ...(responseAction === "RESTORE" ? { requestAction: "TOKENIZE" as const } : step.requestAction === "TOKENIZE" ? { requestAction: "NONE" as const } : {}),
                  })
                }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectGroup>
                  <SelectItem value="NONE">{t("None")}</SelectItem><SelectItem value="BLOCK">{t("BLOCK")}</SelectItem><SelectItem value="REDACT">{t("REDACT")}</SelectItem><SelectItem value="RESTORE">{t("RESTORE")}</SelectItem>
                </SelectGroup></SelectContent></Select></Field>
              </div>
              {step.requestAction === "MODEL_CLASSIFIER" ? <div className="grid gap-4 md:grid-cols-3">
                <Field><FieldLabel>{t("Keywords")}</FieldLabel><Input placeholder={t("code, debug")} value={step.classifierKeywords} onChange={(event) => updateStep(index, { classifierKeywords: event.target.value })} /></Field>
                <Field><FieldLabel>{t("Matching model")}</FieldLabel><Select value={step.classifierModel} onValueChange={(value) => updateStep(index, { classifierModel: value })}><SelectTrigger><SelectValue placeholder={t("Select a model")} /></SelectTrigger><SelectContent><SelectGroup>{publicModels.map((model) => <SelectItem key={model.model_id} value={model.model_name}>{model.display_name}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
                <Field><FieldLabel>{t("Fallback model")}</FieldLabel><Select value={step.classifierFallback} onValueChange={(value) => updateStep(index, { classifierFallback: value })}><SelectTrigger><SelectValue placeholder={t("Select a model")} /></SelectTrigger><SelectContent><SelectGroup>{publicModels.map((model) => <SelectItem key={model.model_id} value={model.model_name}>{model.display_name}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
              </div> : <div className="grid gap-4 md:grid-cols-2">
                <Field><FieldLabel>{t("Semantic type")}</FieldLabel><SearchableSelect value={step.patternName} options={DATA_PROTECTION_SEMANTIC_TYPES.map((value) => ({ value, label: value }))} onValueChange={(value) => updateStep(index, { patternName: value })} placeholder={t("Select semantic type")} searchPlaceholder={t("Search semantic types")} emptyLabel={t("No semantic types found.")} /></Field>
                <Field><FieldLabel>{t("Pattern expression")}</FieldLabel><Input className="font-mono" value={step.expression} onChange={(event) => updateStep(index, { expression: event.target.value })} /></Field>
              </div>}
            </FieldGroup>
          ))}
          <Button className="self-start" onClick={() => setDraft((current) => [...current, {
            stepId: `process-${crypto.randomUUID()}`,
            requestAction: "REDACT",
            responseAction: "NONE",
            patternName: "CREDENTIAL",
            expression: "secret",
            classifierKeywords: "code, debug",
            classifierModel: publicModels[0]?.model_name ?? "",
            classifierFallback: publicModels[1]?.model_name ?? publicModels[0]?.model_name ?? "",
          }])} type="button" variant="outline"><PlusIcon data-icon="inline-start" />{t("Add processing step")}</Button>
        </FieldGroup> : null}
      </CardContent>
      {editing ? <CardFooter className="justify-end gap-2">
        <Button disabled={saving} onClick={() => { setDraft(processSteps(revision)); setExecutionConfirmation(requiresExecutionConfirmation(revision)); setEligibleConnectionIds(revision?.chain.eligible_connection_ids ?? readyConnections.map((connection) => connection.connection_id)); setEditing(false); setError("") }} type="button" variant="outline">{t("Cancel")}</Button>
        <Button disabled={saving} onClick={() => void save()} type="button">{saving ? t("Saving") : t("Save draft")}</Button>
      </CardFooter> : null}
    </Card>
  )
}
