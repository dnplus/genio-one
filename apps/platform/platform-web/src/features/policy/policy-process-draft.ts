import type { EditableEnforcementProcessStep, EnforcementChainRevisionView } from "@/lib/product-api"

export type RequestAction = "NONE" | "BLOCK" | "REDACT" | "TOKENIZE" | "MODEL_CLASSIFIER"
export type ResponseAction = "NONE" | "BLOCK" | "REDACT" | "RESTORE"

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

function semanticType(value: string | undefined): string {
  const normalized = value?.trim().toUpperCase()
  return DATA_PROTECTION_SEMANTIC_TYPES.includes(
    normalized as (typeof DATA_PROTECTION_SEMANTIC_TYPES)[number],
  ) ? normalized! : "CREDENTIAL"
}

export interface DraftProcessStep {
  original?: EditableEnforcementProcessStep
  changed?: boolean
  expression: string
  patternName: string
  requestAction: RequestAction
  responseAction: ResponseAction
  stepId: string
  classifierKeywords: string
  classifierModel: string
  classifierFallback: string
}

export function processSteps(revision: { chain: Pick<EnforcementChainRevisionView["chain"], "steps"> } | null): DraftProcessStep[] {
  return (revision?.chain.steps ?? [])
    .filter((step) => step.kind === "PROCESS" && step.hooks)
    .map((step) => {
      const config = (step.hooks?.request?.config ?? step.hooks?.response?.config) as {
        patterns?: Array<{ name?: string; expression?: string }>
        rules?: Array<{ keywords?: string[]; public_model_name?: string }>
        fallback_public_model_name?: string
      } | undefined
      const pattern = config?.patterns?.[0]
      const classifierRule = config?.rules?.[0]
      return {
        original: { step_id: step.step_id, hooks: step.hooks! },
        stepId: step.step_id,
        requestAction: (step.hooks?.request?.action ?? "NONE") as RequestAction,
        responseAction: (step.hooks?.response?.action ?? "NONE") as ResponseAction,
        patternName: semanticType(pattern?.name),
        expression: pattern?.expression ?? "",
        classifierKeywords: classifierRule?.keywords?.join(", ") ?? "",
        classifierModel: classifierRule?.public_model_name ?? "",
        classifierFallback: config?.fallback_public_model_name ?? "",
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

export function executableStep(step: DraftProcessStep): EditableEnforcementProcessStep {
  if (step.original && !step.changed) return step.original
  if (step.requestAction === "MODEL_CLASSIFIER") {
    const previous = step.original?.hooks.request
    const priorConfig = previous?.config ?? {}
    const priorRules = Array.isArray(priorConfig.rules) ? priorConfig.rules : []
    return {
      step_id: step.stepId,
      hooks: {
        request: {
          action: "MODEL_CLASSIFIER",
          effect: previous?.effect ?? "SORT_ENTITLEMENT_CANDIDATES",
          config: {
            ...priorConfig,
            schema_version: priorConfig.schema_version ?? 1,
            strategy: priorConfig.strategy ?? "KEYWORD",
            rules: [{
              ...(typeof priorRules[0] === "object" ? priorRules[0] : {}),
              keywords: step.classifierKeywords.split(",").map((value) => value.trim()).filter(Boolean),
              public_model_name: step.classifierModel,
            }, ...priorRules.slice(1)],
            fallback_public_model_name: step.classifierFallback,
          },
        },
      },
    }
  }
  const patterns = step.expression.trim()
    ? [{ name: semanticType(step.patternName), expression: step.expression.trim() }]
    : []
  const hook = (phase: "request" | "response", action: Exclude<RequestAction | ResponseAction, "NONE">) => {
    const previous = step.original?.hooks[phase]
    const config = previous?.config ?? {}
    const priorPatterns = Array.isArray(config.patterns) ? config.patterns : []
    return { ...previous, action, config: { ...config, patterns: [...patterns.map((pattern) => ({ ...(typeof priorPatterns[0] === "object" ? priorPatterns[0] : {}), ...pattern, flags: typeof priorPatterns[0] === "object" && priorPatterns[0] !== null && "flags" in priorPatterns[0] ? priorPatterns[0].flags : "i" })), ...priorPatterns.slice(1)], token_ttl_seconds: config.token_ttl_seconds ?? 600 } }
  }
  return {
    step_id: step.stepId,
    hooks: {
      ...(step.requestAction !== "NONE" ? { request: hook("request", step.requestAction) } : {}),
      ...(step.responseAction !== "NONE" ? { response: hook("response", step.responseAction) } : {}),
    },
  }
}

