import { DiscardPolicyDraft } from "@/features/policy/discard-policy-draft"
import { DATA_PROTECTION_SEMANTIC_TYPES, MAX_SAFETY_CHECKS, PRESIDIO_ENTITY_TYPES, dataProtectionAction, defaultSafetyCheckConfiguration, executableStep, presidioDetectorValid, processLabel, processSteps, requiresExecutionConfirmation, safetyCheckConfigurationValid, type DraftProcessStep, type PresidioDetectorDraft, type RequestAction, type ResponseAction, type SafetyCheckConfigurationDraft } from "@/features/policy/policy-process-draft"
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
import { Textarea } from "@/components/ui/textarea"
import type { ConnectionSummary, ResourceRegistration } from "@/domain/contracts"
import {
  buildResourcePolicyDefinition,
  getPolicyDraft,
  getLatestResourceEnforcementChain,
  listProcessorAdapters,
  listResourcePublicModels,
  policyDraftPath,
  ProductApiError,
  publishPolicyDraft,
  reviewPolicyDraft,
  savePolicyDraft,
  validatePolicyDraft,
  type EnforcementChainRevisionView,
  type PolicyDraftView,
  type ProcessorAdapterCatalogEntry,
  type PublicModelView,
  type ResourcePolicyDefinition,
} from "@/lib/product-api"

type ResourcePolicyComparable = Pick<ResourcePolicyDefinition, "eligible_connection_ids" | "steps">
const EMPTY_CONNECTIONS: ConnectionSummary[] = []

function policyDefinitionChain(definition: ResourcePolicyComparable | null): { chain: { steps: ResourcePolicyDefinition["steps"] } } | null {
  return definition ? { chain: { steps: definition.steps } } : null
}

function hasUnsavedResourcePolicy(
  definition: ResourcePolicyComparable | null,
  draft: DraftProcessStep[],
  eligibleConnectionIds: string[],
  executionConfirmation: boolean,
) {
  if (!definition) return draft.length > 0 || eligibleConnectionIds.length > 0 || executionConfirmation
  return (
    JSON.stringify(draft.map(executableStep)) !== JSON.stringify(definition.steps.filter((step) => step.kind === "PROCESS").map((step) => ({ step_id: step.step_id, hooks: step.hooks }))) ||
    JSON.stringify(eligibleConnectionIds) !== JSON.stringify(definition.eligible_connection_ids ?? []) ||
    executionConfirmation !== definition.steps.some((step) => step.kind === "AUTHORIZE" && Array.isArray(step.config?.required_obligations) && step.config.required_obligations.includes("execution.confirmation"))
  )
}

function isPolicyDraftConflict(error: unknown) {
  return error instanceof ProductApiError && error.status === 409 && ["POLICY_DRAFT_CONFLICT", "POLICY_REVISION_CONFLICT", "STALE_DRAFT"].includes(error.message)
}

function adapterLabel(adapter: ProcessorAdapterCatalogEntry): string {
  return [adapter.kind, adapter.endpoint, adapter.model].filter(Boolean).join(" · ")
}

function nextSafetyCheckId(checks: SafetyCheckConfigurationDraft["checks"]): string {
  const ids = new Set(checks.map((check) => check.id.trim()))
  let sequence = 1
  while (ids.has(`check-${sequence}`)) sequence += 1
  return `check-${sequence}`
}

function AdapterSelector({
  adapters,
  label,
  onValueChange,
  placeholder,
  value,
}: {
  adapters: ProcessorAdapterCatalogEntry[]
  label: string
  onValueChange: (value: string) => void
  placeholder: string
  value: string
}) {
  const { t } = useTranslation()
  const selectedAdapter = adapters.find((adapter) => adapter.id === value)
  return <Field>
    <FieldLabel>{label}</FieldLabel>
    {adapters.length > 0 ? <>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger><SelectValue placeholder={placeholder} /></SelectTrigger>
        <SelectContent><SelectGroup>{adapters.map((adapter) => (
          <SelectItem key={adapter.id} value={adapter.id}>{adapterLabel(adapter)}</SelectItem>
        ))}</SelectGroup></SelectContent>
      </Select>
      {selectedAdapter ? <p className="mt-1 text-xs text-muted-foreground">{adapterLabel(selectedAdapter)}</p> : null}
    </> : <p className="text-sm text-muted-foreground">{t("No compatible operator-provisioned adapter is available for this tenant.")}</p>}
  </Field>
}

function SafetyCheckFields({
  adapters,
  configuration,
  onChange,
  phase,
}: {
  adapters: ProcessorAdapterCatalogEntry[]
  configuration: SafetyCheckConfigurationDraft
  onChange: (value: SafetyCheckConfigurationDraft) => void
  phase: "request" | "response"
}) {
  const { t } = useTranslation()
  return <FieldGroup className="rounded-md border border-dashed p-3">
    <div>
      <FieldLabel>{t(phase === "request" ? "Request safety checks" : "Response safety checks")}</FieldLabel>
      <p className="text-xs text-muted-foreground">{t("JEV and HTTP adapters send the configured guardrail instructions to the shown operator-provisioned endpoint. The selected provider receives only this hook's policy input.")}</p>
    </div>
    <div className="grid gap-4 md:grid-cols-2">
      <AdapterSelector adapters={adapters} label={t("Guardrail provider")} value={configuration.adapterId} placeholder={t("Select a JEV or HTTP adapter")} onValueChange={(adapterId) => onChange({ ...configuration, adapterId })} />
      <Field><FieldLabel>{t("Timeout (ms)")}</FieldLabel><Input min={100} max={30000} type="number" value={configuration.timeoutMs} onChange={(event) => onChange({ ...configuration, timeoutMs: Number(event.target.value) })} /></Field>
    </div>
    {configuration.checks.map((check, index) => <FieldGroup className="rounded-md border p-3" key={index}>
      <div className="flex items-center justify-between gap-2"><FieldLabel>{t("Safety check {{number}}", { number: index + 1 })}</FieldLabel><Button disabled={configuration.checks.length === 1} onClick={() => onChange({ ...configuration, checks: configuration.checks.filter((_, checkIndex) => checkIndex !== index) })} size="sm" type="button" variant="ghost">{t("Remove")}</Button></div>
      <div className="grid gap-4 md:grid-cols-3">
        <Field><FieldLabel>{t("Check ID")}</FieldLabel><Input value={check.id} onChange={(event) => onChange({ ...configuration, checks: configuration.checks.map((current, checkIndex) => checkIndex === index ? { ...current, id: event.target.value } : current) })} /></Field>
        <Field><FieldLabel>{t("Risk threshold")}</FieldLabel><Input min={0} max={1} step={0.01} type="number" value={check.threshold} onChange={(event) => onChange({ ...configuration, checks: configuration.checks.map((current, checkIndex) => checkIndex === index ? { ...current, threshold: Number(event.target.value) } : current) })} /></Field>
        <Field className="md:col-span-1"><FieldLabel>{t("Guardrail prompt")}</FieldLabel><Textarea value={check.instructions} onChange={(event) => onChange({ ...configuration, checks: configuration.checks.map((current, checkIndex) => checkIndex === index ? { ...current, instructions: event.target.value } : current) })} /></Field>
      </div>
    </FieldGroup>)}
    <Button className="self-start" disabled={configuration.checks.length >= MAX_SAFETY_CHECKS} onClick={() => onChange({ ...configuration, checks: [...configuration.checks, { id: nextSafetyCheckId(configuration.checks), instructions: "", threshold: 0.5 }] })} size="sm" type="button" variant="outline"><PlusIcon data-icon="inline-start" />{t("Add safety check")}</Button>
  </FieldGroup>
}

function PresidioDetectorFields({
  adapters,
  detector,
  onChange,
  phase,
}: {
  adapters: ProcessorAdapterCatalogEntry[]
  detector: PresidioDetectorDraft
  onChange: (value: PresidioDetectorDraft) => void
  phase: "request" | "response"
}) {
  const { t } = useTranslation()
  return <FieldGroup className="rounded-md border border-dashed p-3">
    <div>
      <FieldLabel>{t(phase === "request" ? "Request Presidio detector" : "Response Presidio detector")}</FieldLabel>
      <p className="text-xs text-muted-foreground">{t("Use a language supported by this Presidio deployment. English (en) is the default; unsupported languages fail closed at runtime.")}</p>
    </div>
    <div className="grid gap-4 md:grid-cols-2">
      <AdapterSelector adapters={adapters} label={t("Presidio provider")} value={detector.adapterId} placeholder={t("Select a Presidio adapter")} onValueChange={(adapterId) => onChange({ ...detector, adapterId })} />
      <Field><FieldLabel>{t("Language")}</FieldLabel><Input value={detector.language} onChange={(event) => onChange({ ...detector, language: event.target.value })} /></Field>
      <Field><FieldLabel>{t("Entities")}</FieldLabel><Input value={detector.entities} onChange={(event) => onChange({ ...detector, entities: event.target.value })} /><p className="mt-1 text-xs text-muted-foreground">{PRESIDIO_ENTITY_TYPES.join(", ")}</p></Field>
      <Field><FieldLabel>{t("Risk threshold")}</FieldLabel><Input min={0} max={1} step={0.01} type="number" value={detector.scoreThreshold} onChange={(event) => onChange({ ...detector, scoreThreshold: Number(event.target.value) })} /></Field>
    </div>
  </FieldGroup>
}

export function ResourceEnforcementChainCard({
  canEdit,
  initialCapabilityId,
  onSaved,
  onDraftSaved,
  refreshKey = 0,
  resource,
  tenantId,
  connections = EMPTY_CONNECTIONS,
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
  const [conflict, setConflict] = useState(false)
  const [reloadNonce, setReloadNonce] = useState(0)
  const [persistedDraft, setPersistedDraft] = useState<PolicyDraftView | null>(null)
  const [notice, setNotice] = useState("")
  const [revision, setRevision] = useState<EnforcementChainRevisionView | null>(null)
  const [draft, setDraft] = useState<DraftProcessStep[]>([])
  const [publicModels, setPublicModels] = useState<PublicModelView[]>([])
  const [processorAdapters, setProcessorAdapters] = useState<ProcessorAdapterCatalogEntry[]>([])
  const [processorAdaptersLoaded, setProcessorAdaptersLoaded] = useState(false)
  const [processorAdaptersError, setProcessorAdaptersError] = useState("")
  const [processorAdaptersReload, setProcessorAdaptersReload] = useState(0)
  const [executionConfirmation, setExecutionConfirmation] = useState(false)
  const [eligibleConnectionIds, setEligibleConnectionIds] = useState<string[]>([])

  const resourceConnections = useMemo(
    () => connections.filter((connection) => connection.resource_id === resource.resource_id),
    [connections, resource.resource_id],
  )
  const readyConnections = useMemo(
    () => resourceConnections.filter((connection) =>
      connection.status === "READY" &&
      connection.lifecycle === "ENABLED" &&
      connection.verification_state === "VERIFIED" &&
      connection.health_state === "HEALTHY" &&
      (!connection.certificate || ["NOT_CONFIGURED", "VALID", "EXPIRING"].includes(connection.certificate.status)),
    ),
    [resourceConnections],
  )
  const safetyAdapters = useMemo(
    () => processorAdapters.filter((adapter) => adapter.kind === "JEV" || adapter.kind === "HTTP"),
    [processorAdapters],
  )
  const presidioAdapters = useMemo(
    () => processorAdapters.filter((adapter) => adapter.kind === "PRESIDIO"),
    [processorAdapters],
  )
  const defaultSafetyAdapterId = useMemo(
    () => safetyAdapters.find((adapter) => adapter.kind === "JEV")?.id ?? safetyAdapters[0]?.id ?? "",
    [safetyAdapters],
  )
  const defaultPresidioAdapterId = presidioAdapters[0]?.id ?? ""

  useEffect(() => {
    let active = true
    setProcessorAdaptersLoaded(false)
    setProcessorAdaptersError("")
    void listProcessorAdapters(tenantId)
      .then((adapters) => {
        if (!active) return
        setProcessorAdapters(adapters)
        setProcessorAdaptersError("")
      })
      .catch(() => {
        if (!active) return
        setProcessorAdapters([])
        setProcessorAdaptersError("PROCESSOR_ADAPTER_CATALOG_UNAVAILABLE")
      })
      .finally(() => {
        if (active) setProcessorAdaptersLoaded(true)
      })
    return () => { active = false }
  }, [processorAdaptersReload, refreshKey, tenantId])

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
    setConflict(false)
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
      const definition = canEdit && savedDraft?.content.kind === "RESOURCE_CAPABILITY" ? savedDraft.content.definition : null
      const source = policyDefinitionChain(definition) ?? value
      setDraft(processSteps(source))
      setExecutionConfirmation(requiresExecutionConfirmation(source))
      setEligibleConnectionIds(definition?.eligible_connection_ids ?? value?.chain.eligible_connection_ids ?? readyConnections.map((connection) => connection.connection_id))
      setEditing(Boolean(savedDraft) && canEdit)
    }).catch((caught) => {
      if (active) setError(caught instanceof Error ? caught.message : "ENFORCEMENT_CHAIN_LOAD_FAILED")
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [capabilityId, readyConnections, resource.lifecycle, resource.resource_id, tenantId, refreshKey, canEdit, reloadNonce])

  function updateStep(index: number, value: Partial<DraftProcessStep>) {
    const dataProtectionChanged = "expression" in value || "patternName" in value
    const classifierChanged = "classifierKeywords" in value || "classifierModel" in value || "classifierFallback" in value
    setDraft((current) => current.map((step, stepIndex) =>
      stepIndex === index
        ? { ...step, ...value, changed: true, ...(dataProtectionChanged ? { dataProtectionChanged: true } : {}), ...(classifierChanged ? { classifierChanged: true } : {}) }
        : step))
  }

  function updateSafety(index: number, phase: "request" | "response", configuration: SafetyCheckConfigurationDraft) {
    updateStep(index, phase === "request"
      ? { requestSafety: configuration, requestSafetyChanged: true }
      : { responseSafety: configuration, responseSafetyChanged: true })
  }

  function updateDetector(index: number, phase: "request" | "response", detector: PresidioDetectorDraft | null) {
    updateStep(index, phase === "request"
      ? { requestDetector: detector, requestDetectorChanged: true }
      : { responseDetector: detector, responseDetectorChanged: true })
  }

  function safetyConfigurationForSelection(configuration: SafetyCheckConfigurationDraft): SafetyCheckConfigurationDraft {
    const defaults = defaultSafetyCheckConfiguration()
    return {
      ...configuration,
      adapterId: configuration.adapterId || defaultSafetyAdapterId,
      checks: configuration.checks.length > 0 ? configuration.checks : defaults.checks,
    }
  }

  function detectorForSelection(detector: PresidioDetectorDraft | null): PresidioDetectorDraft {
    return {
      adapterId: detector?.adapterId || defaultPresidioAdapterId,
      language: detector?.language || "en",
      entities: detector?.entities || "EMAIL_ADDRESS",
      scoreThreshold: detector?.scoreThreshold ?? 0.5,
    }
  }

  function moveStep(index: number, offset: -1 | 1) {
    setDraft((current) => {
      const target = index + offset
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  function restoreDraftInputs(sourceDraft = persistedDraft) {
    const definition = sourceDraft?.content.kind === "RESOURCE_CAPABILITY" ? sourceDraft.content.definition : null
    const source = policyDefinitionChain(definition) ?? revision
    setDraft(processSteps(source))
    setExecutionConfirmation(requiresExecutionConfirmation(source))
    setEligibleConnectionIds(definition?.eligible_connection_ids ?? revision?.chain.eligible_connection_ids ?? readyConnections.map((connection) => connection.connection_id))
  }

  function reloadSavedDraft() {
    setError("")
    setConflict(false)
    setReloadNonce((current) => current + 1)
  }

  async function save() {
    const invalidPair = draft.find((step) =>
      (step.requestAction === "NONE" && step.responseAction === "NONE") ||
      (step.requestAction === "TOKENIZE") !== (step.responseAction === "RESTORE"))
    if (invalidPair) {
      setError("TOKENIZE_RESTORE_PAIR_REQUIRED")
      setConflict(false)
      return
    }
    const invalidSafety = draft.find((step) =>
      (step.requestAction === "SAFETY_CHECK" && !safetyCheckConfigurationValid(step.requestSafety)) ||
      (step.responseAction === "SAFETY_CHECK" && !safetyCheckConfigurationValid(step.responseSafety)))
    if (invalidSafety) {
      setError("SAFETY_CHECK_CONFIG_INVALID")
      setConflict(false)
      return
    }
    const invalidDetector = draft.find((step) =>
      (dataProtectionAction(step.requestAction) && step.requestDetector && !presidioDetectorValid(step.requestDetector)) ||
      (dataProtectionAction(step.responseAction) && step.responseDetector && !presidioDetectorValid(step.responseDetector)))
    if (invalidDetector) {
      setError("PRESIDIO_DETECTOR_CONFIG_INVALID")
      setConflict(false)
      return
    }
    const invalidClassifier = draft.find((step) => step.requestAction === "MODEL_CLASSIFIER" && (
      !step.classifierKeywords.split(",").some((value) => value.trim()) ||
      !step.classifierModel ||
      !step.classifierFallback
    ))
    if (invalidClassifier) {
      setError("MODEL_CLASSIFIER_CONFIG_INVALID")
      setConflict(false)
      return
    }
    setSaving(true)
    setError("")
    setConflict(false)
    try {
      const definition = await buildResourcePolicyDefinition((revision?.one_policy_revision ?? 0) + 1, draft.map(executableStep), resource.api?.inbound_security, executionConfirmation, eligibleConnectionIds, revision)
      const saved = await savePolicyDraft(policyDraftPath(tenantId, { resourceId: resource.resource_id, capabilityId }), {
        expected_version: persistedDraft?.version ?? 0,
        base_revision: revision?.one_policy_revision ?? 0,
        content: { kind: "RESOURCE_CAPABILITY", definition },
      })
      setPersistedDraft(saved)
      setNotice("Draft saved. Validate the saved draft before review.")
      await onDraftSaved?.()

    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "ENFORCEMENT_CHAIN_SAVE_FAILED")
      setConflict(isPolicyDraftConflict(caught))
    } finally {
      setSaving(false)
    }
  }

  async function transitionDraft(action: "validate" | "review" | "publish") {
    if (persistedDraft?.content.kind !== "RESOURCE_CAPABILITY") return
    setSaving(true)
    setError("")
    setConflict(false)
    try {
      if (action === "validate") {
        const saved = await validatePolicyDraft(policyDraftPath(tenantId, { resourceId: resource.resource_id, capabilityId }), persistedDraft.version, persistedDraft.content_digest)
        setPersistedDraft(saved)
        setNotice("Draft validation saved. Review the validated draft before publishing.")
      } else if (action === "review") {
        const saved = await reviewPolicyDraft(policyDraftPath(tenantId, { resourceId: resource.resource_id, capabilityId }), persistedDraft.version, persistedDraft.content_digest)
        setPersistedDraft(saved)
        setNotice("Draft review saved. Publish the reviewed draft when ready.")
      } else {
        const saved = await publishPolicyDraft<EnforcementChainRevisionView>(policyDraftPath(tenantId, { resourceId: resource.resource_id, capabilityId }), persistedDraft.version, persistedDraft.content_digest)
        setRevision(saved)
        setPersistedDraft(null)
        setDraft(processSteps(saved))
        setEditing(false)
        setNotice(resource.lifecycle === "DRAFT" ? "Policy revision published for this draft Resource. Publish the Resource before checking Runtime readiness." : "Policy published. Check Runtime status before expecting traffic changes.")
        await onSaved?.()
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "POLICY_PUBLISH_FAILED")
      setConflict(isPolicyDraftConflict(caught))
    }
    finally { setSaving(false) }
  }

  const savedDefinition = persistedDraft?.content.kind === "RESOURCE_CAPABILITY" ? persistedDraft.content.definition : null
  const publishedDefinition = revision ? { steps: revision.chain.steps, eligible_connection_ids: revision.chain.eligible_connection_ids } : null
  const unsaved = editing && hasUnsavedResourcePolicy(savedDefinition ?? publishedDefinition, draft, eligibleConnectionIds, executionConfirmation)
  const validated = Boolean(
    persistedDraft &&
    persistedDraft.lifecycle !== "DRAFT" &&
    persistedDraft.validation?.content_digest === persistedDraft.content_digest,
  )
  const reviewed = Boolean(
    persistedDraft?.lifecycle === "REVIEWED" &&
    persistedDraft.review?.content_digest === persistedDraft.content_digest,
  )
  const lifecycleSteps = persistedDraft ? [
    { label: t("Save draft"), state: "complete" },
    { label: t("Validate"), state: validated ? "complete" : "current" },
    { label: t("Review"), state: reviewed ? "complete" : validated ? "current" : "pending" },
    { label: t("Publish"), state: reviewed ? "current" : "pending" },
  ] : []
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
            {canEdit && !editing ? <Button onClick={() => { restoreDraftInputs(); setEditing(true) }} size="sm" variant="outline">{t("Edit policy")}</Button> : null}
          </div>
        </div>
      </CardHeader>
      {notice ? <div className="px-6" role="status"><Alert><AlertDescription>{t(notice)}</AlertDescription></Alert></div> : null}
      {persistedDraft && canEdit ? <div className="flex flex-col gap-3 px-6 py-3" data-testid="resource-policy-draft-lifecycle">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{t("Draft")} {persistedDraft.version}</Badge>
          {unsaved ? <Badge variant="outline">{t("Draft changes not saved")}</Badge> : null}
          {lifecycleSteps.map((step, index) => <Badge aria-current={step.state === "current" ? "step" : undefined} data-state={step.state} key={step.label} variant={step.state === "complete" ? "secondary" : "outline"}>{index + 1}. {step.label}</Badge>)}
        </div>
        <div className="grid gap-1 text-sm text-muted-foreground">
          <span>{t("Content digest")}: <code className="font-mono text-foreground" title={persistedDraft.content_digest}>{persistedDraft.content_digest.slice(0, 12)}</code></span>
          {persistedDraft.validation ? <span>{t("Validated by")} {persistedDraft.validation.actor_subject_id ?? t("Installation")} · {new Date(persistedDraft.validation.at * 1000).toLocaleString()}</span> : <span>{t("Not validated")}</span>}
          {persistedDraft.review ? <span>{t("Reviewed by")} {persistedDraft.review.actor_subject_id ?? t("Installation")} · {new Date(persistedDraft.review.at * 1000).toLocaleString()}</span> : <span>{t("Not reviewed")}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DiscardPolicyDraft path={policyDraftPath(tenantId, { resourceId: resource.resource_id, capabilityId })} version={persistedDraft.version} onDiscarded={async () => { setPersistedDraft(null); restoreDraftInputs(null); setEditing(false); setError(""); setConflict(false); setNotice(""); await onDraftSaved?.() }} />
          <Button disabled={saving || unsaved || persistedDraft.lifecycle !== "DRAFT"} variant="outline" onClick={() => void transitionDraft("validate")}>{t("Validate saved draft")}</Button>
          <Button disabled={saving || unsaved || persistedDraft.lifecycle !== "VALIDATED" || !validated} variant="outline" onClick={() => void transitionDraft("review")}>{t("Review saved draft")}</Button>
          <Button disabled={saving || unsaved || !reviewed} onClick={() => void transitionDraft("publish")}>{t("Publish saved draft")}</Button>
        </div>
        <span className="text-sm text-muted-foreground">{t("Publishing applies the saved draft, not unsaved form changes.")}</span>
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
        {error ? <Alert variant="destructive"><AlertTitle>{t(conflict ? "Draft changed on server" : "Unable to save enforcement chain")}</AlertTitle><AlertDescription><div className="flex flex-col items-start gap-2"><span>{t(error)}</span>{conflict ? <><span>{t("This draft changed on the server. Reload it before continuing.")}</span><Button disabled={saving} onClick={reloadSavedDraft} size="sm" type="button" variant="outline">{t("Reload saved draft")}</Button></> : null}</div></AlertDescription></Alert> : null}
        {editing && canEdit && processorAdaptersLoaded && processorAdaptersError ? <Alert variant="destructive">
          <AlertTitle>{t("Unable to load safety adapters")}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3"><span>{t(processorAdaptersError)}</span><Button onClick={() => setProcessorAdaptersReload((current) => current + 1)} size="sm" type="button" variant="outline">{t("Retry")}</Button></AlertDescription>
        </Alert> : null}
        {editing && canEdit && processorAdaptersLoaded && !processorAdaptersError && processorAdapters.length === 0 ? <Alert>
          <AlertTitle>{t("Safety adapters are not configured")}</AlertTitle>
          <AlertDescription>{t("An operator must configure JEV, HTTP, or Presidio adapters in GENIO_ONE_PROCESSOR_ADAPTERS_FILE and restart Platform and Processor. Credentials remain in environment variables and are never entered in policy.")}</AlertDescription>
        </Alert> : null}
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
                    ...(requestAction === "SAFETY_CHECK" ? { requestSafety: safetyConfigurationForSelection(step.requestSafety), requestSafetyChanged: true } : {}),
                  })
                }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectGroup>
                  <SelectItem value="NONE">{t("None")}</SelectItem><SelectItem value="BLOCK">{t("BLOCK")}</SelectItem><SelectItem value="REDACT">{t("REDACT")}</SelectItem><SelectItem value="TOKENIZE">{t("TOKENIZE")}</SelectItem><SelectItem value="MODEL_CLASSIFIER">{t("MODEL CLASSIFIER")}</SelectItem><SelectItem value="SAFETY_CHECK">{t("SAFETY CHECK")}</SelectItem>
                </SelectGroup></SelectContent></Select></Field>
                <Field><FieldLabel>{t("Response hook")}</FieldLabel><Select value={step.responseAction} onValueChange={(value) => {
                  const responseAction = value as ResponseAction
                  updateStep(index, {
                    responseAction,
                    ...(responseAction === "RESTORE" ? { requestAction: "TOKENIZE" as const } : step.requestAction === "TOKENIZE" ? { requestAction: "NONE" as const } : {}),
                    ...(responseAction === "SAFETY_CHECK" ? { responseSafety: safetyConfigurationForSelection(step.responseSafety), responseSafetyChanged: true } : {}),
                  })
                }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectGroup>
                  <SelectItem value="NONE">{t("None")}</SelectItem><SelectItem value="BLOCK">{t("BLOCK")}</SelectItem><SelectItem value="REDACT">{t("REDACT")}</SelectItem><SelectItem value="RESTORE">{t("RESTORE")}</SelectItem><SelectItem value="SAFETY_CHECK">{t("SAFETY CHECK")}</SelectItem>
                </SelectGroup></SelectContent></Select></Field>
              </div>
              {step.requestAction === "SAFETY_CHECK" ? <SafetyCheckFields adapters={safetyAdapters} configuration={step.requestSafety} onChange={(configuration) => updateSafety(index, "request", configuration)} phase="request" /> : null}
              {step.responseAction === "SAFETY_CHECK" ? <SafetyCheckFields adapters={safetyAdapters} configuration={step.responseSafety} onChange={(configuration) => updateSafety(index, "response", configuration)} phase="response" /> : null}
              {step.requestAction === "MODEL_CLASSIFIER" ? <div className="grid gap-4 md:grid-cols-3">
                <Field><FieldLabel>{t("Keywords")}</FieldLabel><Input placeholder={t("code, debug")} value={step.classifierKeywords} onChange={(event) => updateStep(index, { classifierKeywords: event.target.value })} /></Field>
                <Field><FieldLabel>{t("Matching model")}</FieldLabel><Select value={step.classifierModel} onValueChange={(value) => updateStep(index, { classifierModel: value })}><SelectTrigger><SelectValue placeholder={t("Select a model")} /></SelectTrigger><SelectContent><SelectGroup>{publicModels.map((model) => <SelectItem key={model.model_id} value={model.model_name}>{model.display_name}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
                <Field><FieldLabel>{t("Fallback model")}</FieldLabel><Select value={step.classifierFallback} onValueChange={(value) => updateStep(index, { classifierFallback: value })}><SelectTrigger><SelectValue placeholder={t("Select a model")} /></SelectTrigger><SelectContent><SelectGroup>{publicModels.map((model) => <SelectItem key={model.model_id} value={model.model_name}>{model.display_name}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
              </div> : null}
              {(dataProtectionAction(step.requestAction) || dataProtectionAction(step.responseAction)) ? <FieldGroup className="rounded-md border border-dashed p-3">
                <div><FieldLabel>{t("Data protection detector")}</FieldLabel><p className="text-xs text-muted-foreground">{t("Add an operator-provisioned Presidio detector for each applicable hook. Regular expressions remain available as an additional detector.")}</p></div>
                <div className="grid gap-4 md:grid-cols-2">
                  {dataProtectionAction(step.requestAction) ? <Field><FieldLabel>{t("Request detector")}</FieldLabel><Select value={step.requestDetector ? "PRESIDIO" : "REGEX"} onValueChange={(value) => updateDetector(index, "request", value === "PRESIDIO" ? detectorForSelection(step.requestDetector) : null)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="REGEX">{t("Regular expression only")}</SelectItem><SelectItem value="PRESIDIO">{t("Use Presidio")}</SelectItem></SelectGroup></SelectContent></Select></Field> : null}
                  {dataProtectionAction(step.responseAction) ? <Field><FieldLabel>{t("Response detector")}</FieldLabel><Select value={step.responseDetector ? "PRESIDIO" : "REGEX"} onValueChange={(value) => updateDetector(index, "response", value === "PRESIDIO" ? detectorForSelection(step.responseDetector) : null)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="REGEX">{t("Regular expression only")}</SelectItem><SelectItem value="PRESIDIO">{t("Use Presidio")}</SelectItem></SelectGroup></SelectContent></Select></Field> : null}
                </div>
                <div>
                  <FieldLabel>{t("Additional regular expression")}</FieldLabel>
                  <p className="text-xs text-muted-foreground">{t("This optional expression runs alongside Presidio when selected. Clear it to use Presidio alone; other existing patterns remain unchanged.")}</p>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <Field><FieldLabel>{t("Semantic type")}</FieldLabel><SearchableSelect value={step.patternName} options={DATA_PROTECTION_SEMANTIC_TYPES.map((value) => ({ value, label: value }))} onValueChange={(value) => updateStep(index, { patternName: value })} placeholder={t("Select semantic type")} searchPlaceholder={t("Search semantic types")} emptyLabel={t("No semantic types found.")} /></Field>
                  <Field><FieldLabel>{t("Pattern expression")}</FieldLabel><Input className="font-mono" value={step.expression} onChange={(event) => updateStep(index, { expression: event.target.value })} /></Field>
                </div>
                {dataProtectionAction(step.requestAction) && step.requestDetector ? <PresidioDetectorFields adapters={presidioAdapters} detector={step.requestDetector} onChange={(detector) => updateDetector(index, "request", detector)} phase="request" /> : null}
                {dataProtectionAction(step.responseAction) && step.responseDetector ? <PresidioDetectorFields adapters={presidioAdapters} detector={step.responseDetector} onChange={(detector) => updateDetector(index, "response", detector)} phase="response" /> : null}
              </FieldGroup> : null}
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
            requestSafety: defaultSafetyCheckConfiguration(),
            responseSafety: defaultSafetyCheckConfiguration(),
            requestDetector: null,
            responseDetector: null,
          }])} type="button" variant="outline"><PlusIcon data-icon="inline-start" />{t("Add processing step")}</Button>
        </FieldGroup> : null}
      </CardContent>
      {editing ? <CardFooter className="justify-end gap-2">
        <Button disabled={saving} onClick={() => { restoreDraftInputs(); setEditing(false); setError(""); setConflict(false) }} type="button" variant="outline">{t("Cancel")}</Button>
        <Button disabled={saving} onClick={() => void save()} type="button">{saving ? t("Saving") : t("Save draft")}</Button>
      </CardFooter> : null}
    </Card>
  )
}
