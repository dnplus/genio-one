import type { EditableEnforcementProcessStep, EnforcementChainRevisionView } from "@/lib/product-api"

export type RequestAction = "NONE" | "BLOCK" | "REDACT" | "TOKENIZE" | "MODEL_CLASSIFIER" | "SAFETY_CHECK"
export type ResponseAction = "NONE" | "BLOCK" | "REDACT" | "RESTORE" | "SAFETY_CHECK"

export const DATA_PROTECTION_SEMANTIC_TYPES = [
  "PERSON",
  "EMAIL",
  "PHONE",
  "ADDRESS",
  "IP_ADDRESS",
  "CREDENTIAL",
  "CUSTOMER_DATA",
  "CUSTOMER_ID",
] as const

export const PRESIDIO_ENTITY_TYPES = [
  "PERSON",
  "EMAIL_ADDRESS",
  "PHONE_NUMBER",
  "LOCATION",
  "IP_ADDRESS",
  "CREDIT_CARD",
  "US_SSN",
  "IBAN_CODE",
] as const

export const MAX_SAFETY_CHECKS = 64

export interface SafetyCheckDraft {
  id: string
  instructions: string
  threshold: number
}

export interface SafetyCheckConfigurationDraft {
  adapterId: string
  checks: SafetyCheckDraft[]
  timeoutMs: number
}

export interface PresidioDetectorDraft {
  adapterId: string
  entities: string
  language: string
  scoreThreshold: number
}

export interface DraftProcessStep {
  original?: EditableEnforcementProcessStep
  changed?: boolean
  dataProtectionChanged?: boolean
  expression: string
  patternName: string
  requestAction: RequestAction
  responseAction: ResponseAction
  stepId: string
  classifierKeywords: string
  classifierModel: string
  classifierFallback: string
  requestSafety: SafetyCheckConfigurationDraft
  requestSafetyChanged?: boolean
  responseSafety: SafetyCheckConfigurationDraft
  responseSafetyChanged?: boolean
  requestDetector: PresidioDetectorDraft | null
  requestDetectorChanged?: boolean
  responseDetector: PresidioDetectorDraft | null
  responseDetectorChanged?: boolean
  classifierChanged?: boolean
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function semanticType(value: string | undefined): string {
  const normalized = value?.trim().toUpperCase()
  return DATA_PROTECTION_SEMANTIC_TYPES.includes(
    normalized as (typeof DATA_PROTECTION_SEMANTIC_TYPES)[number],
  ) ? normalized! : "CREDENTIAL"
}

function nonnegativeUnit(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : fallback
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback
}

function firstPattern(config: Record<string, unknown> | undefined) {
  const patterns = Array.isArray(config?.patterns) ? config.patterns : []
  return record(patterns[0])
}

export function defaultSafetyCheckConfiguration(): SafetyCheckConfigurationDraft {
  return {
    adapterId: "",
    checks: [{ id: "guardrail", instructions: "", threshold: 0.5 }],
    timeoutMs: 5000,
  }
}

function safetyCheckConfiguration(config: Record<string, unknown> | undefined): SafetyCheckConfigurationDraft {
  const checks = Array.isArray(config?.checks)
    ? config.checks.flatMap((item) => {
      const value = record(item)
      if (!value) return []
      return [{
        id: typeof value.id === "string" ? value.id : "",
        instructions: typeof value.instructions === "string" ? value.instructions : "",
        threshold: nonnegativeUnit(value.threshold, 0.5),
      }]
    })
    : []
  return {
    adapterId: typeof config?.adapter_id === "string" ? config.adapter_id : "",
    checks,
    timeoutMs: positiveInteger(config?.timeout_ms, 5000),
  }
}

function presidioDetector(config: Record<string, unknown> | undefined): PresidioDetectorDraft | null {
  const detector = record(config?.detector)
  if (!detector) return null
  return {
    adapterId: typeof detector.adapter_id === "string" ? detector.adapter_id : "",
    entities: Array.isArray(detector.entities)
      ? detector.entities.filter((value): value is string => typeof value === "string").join(", ")
      : "",
    language: typeof detector.language === "string" ? detector.language : "en",
    scoreThreshold: nonnegativeUnit(detector.score_threshold, 0.5),
  }
}

function configFor(step: EditableEnforcementProcessStep, phase: "request" | "response") {
  return record(step.hooks[phase]?.config) ?? undefined
}

function actionFor(step: EditableEnforcementProcessStep, phase: "request" | "response") {
  return step.hooks[phase]?.action
}

function actionIsDataProtection(action: string | undefined): boolean {
  return action === "BLOCK" || action === "REDACT" || action === "TOKENIZE" || action === "RESTORE"
}

export function processSteps(revision: { chain: Pick<EnforcementChainRevisionView["chain"], "steps"> } | null): DraftProcessStep[] {
  return (revision?.chain.steps ?? [])
    .filter((step) => step.kind === "PROCESS" && step.hooks)
    .map((step) => {
      const original: EditableEnforcementProcessStep = { step_id: step.step_id, hooks: step.hooks! }
      const requestConfig = configFor(original, "request")
      const responseConfig = configFor(original, "response")
      const requestAction = actionFor(original, "request")
      const responseAction = actionFor(original, "response")
      const dataProtectionConfig = actionIsDataProtection(requestAction)
        ? requestConfig
        : actionIsDataProtection(responseAction)
          ? responseConfig
          : undefined
      const classifierConfig = requestAction === "MODEL_CLASSIFIER" ? requestConfig : undefined
      const pattern = firstPattern(dataProtectionConfig)
      const rules = Array.isArray(classifierConfig?.rules) ? classifierConfig.rules : []
      const classifierRule = record(rules[0])
      return {
        original,
        stepId: step.step_id,
        requestAction: (requestAction ?? "NONE") as RequestAction,
        responseAction: (responseAction ?? "NONE") as ResponseAction,
        patternName: semanticType(typeof pattern?.name === "string" ? pattern.name : undefined),
        expression: typeof pattern?.expression === "string" ? pattern.expression : "",
        classifierKeywords: Array.isArray(classifierRule?.keywords)
          ? classifierRule.keywords.filter((value): value is string => typeof value === "string").join(", ")
          : "",
        classifierModel: typeof classifierRule?.public_model_name === "string" ? classifierRule.public_model_name : "",
        classifierFallback: typeof classifierConfig?.fallback_public_model_name === "string" ? classifierConfig.fallback_public_model_name : "",
        requestSafety: safetyCheckConfiguration(requestConfig),
        responseSafety: safetyCheckConfiguration(responseConfig),
        requestDetector: presidioDetector(requestConfig),
        responseDetector: presidioDetector(responseConfig),
      }
    })
}

export function requiresExecutionConfirmation(revision: { chain: Pick<EnforcementChainRevisionView["chain"], "steps"> } | null): boolean {
  return (revision?.chain.steps ?? []).some((step) =>
    step.kind === "AUTHORIZE" &&
    Array.isArray(step.config?.required_obligations) &&
    step.config.required_obligations.includes("execution.confirmation"))
}

export function processLabel(step: DraftProcessStep): string {
  const hooks = [
    step.requestAction !== "NONE" ? `Request ${step.requestAction}` : null,
    step.responseAction !== "NONE" ? `Response ${step.responseAction}` : null,
  ].filter(Boolean)
  return hooks.join(" / ")
}

export function dataProtectionAction(action: RequestAction | ResponseAction): boolean {
  return action === "BLOCK" || action === "REDACT" || action === "TOKENIZE"
}

export function safetyCheckConfigurationValid(value: SafetyCheckConfigurationDraft): boolean {
  const checkIds = value.checks.map((check) => check.id.trim())
  return Boolean(value.adapterId) &&
    Number.isSafeInteger(value.timeoutMs) && value.timeoutMs >= 100 && value.timeoutMs <= 30_000 &&
    value.checks.length > 0 && value.checks.length <= MAX_SAFETY_CHECKS && value.checks.every((check) =>
      Boolean(check.id.trim()) &&
      Boolean(check.instructions.trim()) &&
      Number.isFinite(check.threshold) && check.threshold >= 0 && check.threshold <= 1,
    ) && new Set(checkIds).size === checkIds.length
}

export function presidioDetectorValid(value: PresidioDetectorDraft | null): boolean {
  if (!value) return false
  return Boolean(value.adapterId) &&
    Boolean(value.language.trim()) &&
    value.entities.split(",").some((entity) => entity.trim()) &&
    Number.isFinite(value.scoreThreshold) && value.scoreThreshold >= 0 && value.scoreThreshold <= 1
}

function safetyHook(configuration: SafetyCheckConfigurationDraft): NonNullable<EditableEnforcementProcessStep["hooks"]["request"]> {
  return {
    action: "SAFETY_CHECK",
    config: {
      schema_version: 1,
      adapter_id: configuration.adapterId,
      checks: configuration.checks.map((check) => ({
        id: check.id.trim(),
        instructions: check.instructions.trim(),
        threshold: check.threshold,
      })),
      timeout_ms: configuration.timeoutMs,
    },
  }
}

function preservedPattern(value: unknown): { name: string; expression: string; flags?: string } | null {
  const pattern = record(value)
  if (
    !pattern ||
    typeof pattern.name !== "string" || !pattern.name ||
    typeof pattern.expression !== "string" || !pattern.expression ||
    (pattern.flags !== undefined && typeof pattern.flags !== "string")
  ) return null
  return {
    name: pattern.name,
    expression: pattern.expression,
    ...(typeof pattern.flags === "string" ? { flags: pattern.flags } : {}),
  }
}

function builtinConfigFor(previous: EditableEnforcementProcessStep["hooks"]["request"] | undefined) {
  return previous && actionIsDataProtection(previous.action) ? record(previous.config) ?? {} : {}
}

function preservedClassifierRule(value: unknown): { keywords: string[]; public_model_name: string } | null {
  const rule = record(value)
  const keywords = Array.isArray(rule?.keywords)
    ? rule.keywords.filter((keyword): keyword is string => typeof keyword === "string" && Boolean(keyword.trim()))
    : []
  const publicModelName = typeof rule?.public_model_name === "string" ? rule.public_model_name.trim() : ""
  return keywords.length > 0 && publicModelName ? { keywords, public_model_name: publicModelName } : null
}

function detectorConfig(detector: PresidioDetectorDraft) {
  return {
    adapter_id: detector.adapterId,
    language: detector.language.trim(),
    entities: detector.entities.split(",").map((entity) => entity.trim()).filter(Boolean),
    score_threshold: detector.scoreThreshold,
  }
}

function builtinHook(
  step: DraftProcessStep,
  phase: "request" | "response",
  action: Exclude<RequestAction | ResponseAction, "NONE" | "MODEL_CLASSIFIER" | "SAFETY_CHECK">,
): NonNullable<EditableEnforcementProcessStep["hooks"]["request"]> {
  const previous = step.original?.hooks[phase]
  const priorConfig = builtinConfigFor(previous)
  const priorPatterns = Array.isArray(priorConfig.patterns) ? priorConfig.patterns : []
  const preservedPatterns = priorPatterns.flatMap((pattern) => {
    const parsed = preservedPattern(pattern)
    return parsed ? [parsed] : []
  })
  const remainingPatterns = preservedPatterns.slice(1)
  const expression = step.expression.trim()
  const detector = phase === "request" ? step.requestDetector : step.responseDetector
  const detectorChanged = phase === "request" ? step.requestDetectorChanged : step.responseDetectorChanged
  const { effect: _effect, ...withoutEffect } = previous ?? {}
  if (previous?.action === action && !step.dataProtectionChanged && detectorChanged) {
    const config: Record<string, unknown> = {
      ...priorConfig,
      patterns: Array.isArray(priorConfig.patterns) ? priorConfig.patterns : [],
      token_ttl_seconds: typeof priorConfig.token_ttl_seconds === "number" &&
        Number.isSafeInteger(priorConfig.token_ttl_seconds) &&
        priorConfig.token_ttl_seconds >= 60 && priorConfig.token_ttl_seconds <= 86_400
        ? priorConfig.token_ttl_seconds
        : 600,
    }
    if (action !== "RESTORE" && detector) config.detector = detectorConfig(detector)
    else delete config.detector
    return { ...withoutEffect, action, config }
  }
  const patterns = action === "RESTORE"
    ? preservedPatterns
    : expression
      ? [{
        ...preservedPatterns[0],
        name: semanticType(step.patternName),
        expression,
        flags: preservedPatterns[0]?.flags ?? "i",
      }, ...remainingPatterns]
      : remainingPatterns
  const config: Record<string, unknown> = {
    patterns,
    token_ttl_seconds: typeof priorConfig.token_ttl_seconds === "number" &&
      Number.isSafeInteger(priorConfig.token_ttl_seconds) &&
      priorConfig.token_ttl_seconds >= 60 && priorConfig.token_ttl_seconds <= 86_400
      ? priorConfig.token_ttl_seconds
      : 600,
  }
  if (action !== "RESTORE" && detector) {
    config.detector = detectorConfig(detector)
  }
  return { ...withoutEffect, action, config }
}

function classifierHook(step: DraftProcessStep): NonNullable<EditableEnforcementProcessStep["hooks"]["request"]> {
  const previous = step.original?.hooks.request
  const priorConfig = previous?.action === "MODEL_CLASSIFIER" ? record(previous.config) ?? {} : {}
  const priorRules = Array.isArray(priorConfig.rules) ? priorConfig.rules : []
  const remainingRules = priorRules.slice(1).flatMap((rule) => {
    const preserved = preservedClassifierRule(rule)
    return preserved ? [preserved] : []
  })
  return {
    action: "MODEL_CLASSIFIER",
    effect: previous?.action === "MODEL_CLASSIFIER" && previous.effect
      ? previous.effect
      : "SORT_ENTITLEMENT_CANDIDATES",
    config: {
      schema_version: 1,
      strategy: "KEYWORD",
      rules: [{
        keywords: step.classifierKeywords.split(",").map((value) => value.trim()).filter(Boolean),
        public_model_name: step.classifierModel,
      }, ...remainingRules],
      fallback_public_model_name: step.classifierFallback,
    },
  }
}

function sameAction(
  step: DraftProcessStep,
  phase: "request" | "response",
  action: RequestAction | ResponseAction,
): boolean {
  return step.original?.hooks[phase]?.action === action
}

export function executableStep(step: DraftProcessStep): EditableEnforcementProcessStep {
  if (step.original && !step.changed) return step.original
  const request = step.requestAction === "NONE"
    ? undefined
    : step.requestAction === "SAFETY_CHECK"
      ? sameAction(step, "request", "SAFETY_CHECK") && !step.requestSafetyChanged
        ? step.original!.hooks.request!
        : safetyHook(step.requestSafety)
      : step.requestAction === "MODEL_CLASSIFIER"
        ? sameAction(step, "request", "MODEL_CLASSIFIER") && !step.classifierChanged
          ? step.original!.hooks.request!
          : classifierHook(step)
        : sameAction(step, "request", step.requestAction) &&
            !step.dataProtectionChanged && !step.requestDetectorChanged
          ? step.original!.hooks.request!
          : builtinHook(step, "request", step.requestAction)
  const response = step.responseAction === "NONE"
    ? undefined
    : step.responseAction === "SAFETY_CHECK"
      ? sameAction(step, "response", "SAFETY_CHECK") && !step.responseSafetyChanged
        ? step.original!.hooks.response!
        : safetyHook(step.responseSafety)
      : sameAction(step, "response", step.responseAction) &&
          !step.dataProtectionChanged && !step.responseDetectorChanged
        ? step.original!.hooks.response!
        : builtinHook(step, "response", step.responseAction)
  return {
    step_id: step.stepId,
    hooks: {
      ...(request ? { request } : {}),
      ...(response ? { response } : {}),
    },
  }
}
