import { Type, type Static } from "typebox"
import { Value } from "typebox/value"
import {
  ModelCandidateEffectSchema,
  isModelCandidateEffect,
} from "../shared/model-candidate-effect"
import type { DataClassificationReceipt } from "../shared/data-classification"
import { compareUtf8 } from "@genioone/protocol/canonical"
import {
  MAX_SAFETY_DECISION_HANDOFF_BYTES,
  safetyDecisionReceiptSerializedBytes,
  type SafetyDecision,
  type SafetyDecisionReceipt,
} from "../shared/safety-decision"
import {
  PRESIDIO_PAYLOAD_TIMEOUT_MS,
  systemOneQuestionsWithinRequestBudget,
} from "../shared/processor-adapters"

export type { SafetyDecision } from "../shared/safety-decision"

const PROCESSOR_POLICY_SCHEMA_VERSION = 1 as const
export const PROCESSOR_POLICY_BUNDLE_SCHEMA_VERSION = 1 as const
export const PROCESSOR_REMOTE_TIMEOUT_BUDGET_MS = 30_000

const WORST_CASE_SAFETY_DECISION_MODEL = "\u0001".repeat(512)
const LONGEST_SAFETY_DECISION_SCORE = 0.0000010000000000000002

const ProcessorIdentifier = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^(?!\\s)(?!.*\\s$)[^\\u0000\\r\\n]+$",
})

const SafetyCheckIdentifier = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^(?!__proto__$)(?!constructor$)(?!prototype$)(?!\\s)(?!.*\\s$)[^\\u0000\\r\\n]+$",
})

const SemanticEntitySchema = Type.String({
  minLength: 1,
  maxLength: 32,
  pattern: "^[A-Z][A-Z0-9_]{0,31}$",
})

const DataProtectionActionSchema = Type.Union([
  Type.Literal("BLOCK"),
  Type.Literal("REDACT"),
  Type.Literal("TOKENIZE"),
  Type.Literal("RESTORE"),
])

export type DataProtectionAction = Static<typeof DataProtectionActionSchema>

const DataProtectionPatternSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 128 }),
    expression: Type.String({ minLength: 1, maxLength: 2_048 }),
    flags: Type.Optional(Type.String({ pattern: "^[dgimsuvy]*$", maxLength: 7 })),
  },
  { additionalProperties: false },
)

export type DataProtectionPattern = Static<typeof DataProtectionPatternSchema>

const PresidioDetectorConfigSchema = Type.Object(
  {
    adapter_id: ProcessorIdentifier,
    language: Type.String({ minLength: 1, maxLength: 64 }),
    entities: Type.Array(SemanticEntitySchema, { minItems: 1, maxItems: 128 }),
    score_threshold: Type.Number({ minimum: 0, maximum: 1 }),
  },
  { additionalProperties: false },
)

export type PresidioDetectorConfig = Static<typeof PresidioDetectorConfigSchema>

const SafetyCheckSchema = Type.Object(
  {
    id: SafetyCheckIdentifier,
    instructions: Type.String({ minLength: 1, maxLength: 4_096 }),
    threshold: Type.Number({ minimum: 0, maximum: 1 }),
  },
  { additionalProperties: false },
)

export type SafetyCheck = Static<typeof SafetyCheckSchema>

const SafetyCheckConfigSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    adapter_id: ProcessorIdentifier,
    checks: Type.Array(SafetyCheckSchema, { minItems: 1, maxItems: 64 }),
    timeout_ms: Type.Integer({ minimum: 100, maximum: 30_000 }),
  },
  { additionalProperties: false },
)

export type SafetyCheckConfig = Static<typeof SafetyCheckConfigSchema>

const ProcessorPolicySchema = Type.Object(
  {
    schema_version: Type.Literal(PROCESSOR_POLICY_SCHEMA_VERSION),
    revision: ProcessorIdentifier,
    action: DataProtectionActionSchema,
    patterns: Type.Array(DataProtectionPatternSchema, { maxItems: 128 }),
    token_ttl_seconds: Type.Integer({ minimum: 60, maximum: 86_400 }),
    detector: Type.Optional(PresidioDetectorConfigSchema),
  },
  { additionalProperties: false },
)

export type ProcessorPolicy = Static<typeof ProcessorPolicySchema>

/**
 * A compact, action-neutral config shape for a built-in processor action.
 * The action lives on the hook, so this shape only carries data-protection
 * parameters. ProcessorPolicy remains the internal adapter input for the
 * existing DataProcessor implementation.
 */
const ProcessorBuiltinConfigSchema = Type.Object(
  {
    patterns: Type.Array(DataProtectionPatternSchema, { maxItems: 128 }),
    token_ttl_seconds: Type.Integer({ minimum: 60, maximum: 86_400 }),
    detector: Type.Optional(PresidioDetectorConfigSchema),
  },
  { additionalProperties: false },
)

export type ProcessorBuiltinConfig = Static<typeof ProcessorBuiltinConfigSchema>

const ModelClassifierConfigSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    strategy: Type.Literal("KEYWORD"),
    rules: Type.Array(Type.Object({
      keywords: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
        minItems: 1,
        maxItems: 64,
      }),
      public_model_name: ProcessorIdentifier,
    }, { additionalProperties: false }), { minItems: 1, maxItems: 128 }),
    fallback_public_model_name: ProcessorIdentifier,
  },
  { additionalProperties: false },
)

export type ModelClassifierConfig = Static<typeof ModelClassifierConfigSchema>

/**
 * Hook actions intentionally remain open at the artifact boundary.  The
 * processor registers only the built-ins it can execute and rejects every
 * other action while admitting a stream.  Keeping config unknown here lets a
 * future adapter add its own versioned config without changing this envelope.
 */
const ProcessorHookSchema = Type.Object(
  {
    action: ProcessorIdentifier,
    effect: Type.Optional(ModelCandidateEffectSchema),
    config: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
)

export type ProcessorHook = Static<typeof ProcessorHookSchema>

const ProcessorPolicyStepSchema = Type.Object(
  {
    step_id: ProcessorIdentifier,
    hooks: Type.Object(
      {
        request: Type.Optional(ProcessorHookSchema),
        response: Type.Optional(ProcessorHookSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)

export type ProcessorPolicyStep = Static<typeof ProcessorPolicyStepSchema>

const ProcessorPolicyScopeSchema = Type.Object(
  {
    resource_id: ProcessorIdentifier,
    capability_id: ProcessorIdentifier,
    /** The array order is the request execution order. */
    steps: Type.Array(ProcessorPolicyStepSchema, { minItems: 1, maxItems: 4_096 }),
  },
  { additionalProperties: false },
)

const ProcessorPolicyBundleSchema = Type.Object(
  {
    schema_version: Type.Literal(PROCESSOR_POLICY_BUNDLE_SCHEMA_VERSION),
    tenant_id: ProcessorIdentifier,
    revision: ProcessorIdentifier,
    policy_version: ProcessorIdentifier,
    issued_at: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    expires_at: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    scopes: Type.Array(ProcessorPolicyScopeSchema, { maxItems: 4_096 }),
  },
  { additionalProperties: false },
)

export type ProcessorPolicyScope = Static<typeof ProcessorPolicyScopeSchema>
export type ProcessorPolicyBundle = Static<typeof ProcessorPolicyBundleSchema>

/**
 * Validate untrusted policy data before it reaches the processor. The policy
 * is shipped as a signed projection, but this service still validates the
 * decoded JSON at its process boundary so an unknown action cannot silently
 * take the TOKENIZE branch.
 */
export function validateProcessorPolicy(input: unknown): ProcessorPolicy {
  if (!Value.Check(ProcessorPolicySchema, input)) {
    const issue = Value.Errors(ProcessorPolicySchema, input)[0]
    const detail = issue
      ? ` at ${String(issue.instancePath || "<root>")}: ${issue.message}`
      : ""
    throw new Error(`processor policy schema is invalid${detail}`)
  }
  const policy = input as ProcessorPolicy
  if (policy.action === "RESTORE" && policy.detector !== undefined) {
    throw new Error("RESTORE policy must not declare a detector")
  }
  return policy
}

function scopeKey(scope: ProcessorPolicyScope): string {
  return `${scope.resource_id}\u0000${scope.capability_id}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function validateHookEnvelope(hook: ProcessorHook, path: string): void {
  if (hook.config !== undefined && !isRecord(hook.config)) {
    throw new Error(`${path}.config must be an object`)
  }
  if (hook.config === null) {
    throw new Error(`${path}.config must be an object`)
  }
}

const EXECUTABLE_BUILTIN_ACTIONS = new Set<DataProtectionAction>([
  "BLOCK",
  "REDACT",
  "TOKENIZE",
  "RESTORE",
])

function validateExecutableHook(
  hook: ProcessorHook,
  direction: "request" | "response",
  path: string,
): void {
  validateHookEnvelope(hook, path)
  if (hook.action === "MODEL_CLASSIFIER") {
    if (direction !== "request") {
      throw new Error("MODEL_CLASSIFIER is only valid on a processor request hook")
    }
    if (!isModelCandidateEffect(hook.effect)) {
      throw new Error("MODEL_CLASSIFIER must declare its entitlement candidate effect")
    }
    if (!Value.Check(ModelClassifierConfigSchema, hook.config)) {
      throw new Error(`processor hook config is invalid at ${path} for MODEL_CLASSIFIER`)
    }
    return
  }
  if (hook.action === "SAFETY_CHECK") {
    if (hook.effect !== undefined) {
      throw new Error(`SAFETY_CHECK must not declare an effect at ${path}`)
    }
    if (!Value.Check(SafetyCheckConfigSchema, hook.config)) {
      throw new Error(`processor hook config is invalid at ${path} for SAFETY_CHECK`)
    }
    const config = hook.config as SafetyCheckConfig
    const checkIds = config.checks.map((check) => check.id)
    if (new Set(checkIds).size !== checkIds.length) {
      throw new Error(`SAFETY_CHECK check ids must be unique at ${path}`)
    }
    if (!systemOneQuestionsWithinRequestBudget(config.checks)) {
      throw new Error(`SAFETY_CHECK questions exceed request budget at ${path}`)
    }
    return
  }
  if (!EXECUTABLE_BUILTIN_ACTIONS.has(hook.action as DataProtectionAction)) {
    throw new Error(`processor hook action is unsupported at ${path}: ${hook.action}`)
  }
  if (hook.effect !== undefined) {
    throw new Error(`processor data-protection hook must not declare an effect at ${path}`)
  }
  if (direction === "request" && hook.action === "RESTORE") {
    throw new Error("RESTORE is only valid on a processor response hook")
  }
  if (direction === "response" && hook.action === "TOKENIZE") {
    throw new Error("TOKENIZE is only valid on a processor request hook")
  }
  if (hook.config !== undefined && !Value.Check(ProcessorBuiltinConfigSchema, hook.config)) {
    throw new Error(`processor hook config is invalid at ${path} for ${hook.action}`)
  }
  if (
    hook.action === "RESTORE" &&
    (hook.config as ProcessorBuiltinConfig | undefined)?.detector !== undefined
  ) {
    throw new Error(`RESTORE must not declare a detector at ${path}`)
  }
}

function validateStep(step: ProcessorPolicyStep, path: string): void {
  const hookNames = Object.keys(step.hooks)
  if (hookNames.length === 0) {
    throw new Error(`${path}.hooks must contain request or response`)
  }
  if (step.hooks.request !== undefined) {
    validateExecutableHook(step.hooks.request, "request", `${path}.hooks.request`)
  }
  if (step.hooks.response !== undefined) {
    validateExecutableHook(step.hooks.response, "response", `${path}.hooks.response`)
  }
  const requestAction = step.hooks.request?.action
  const responseAction = step.hooks.response?.action
  if (requestAction === "TOKENIZE" || responseAction === "RESTORE") {
    if (requestAction !== "TOKENIZE" || responseAction !== "RESTORE") {
      throw new Error(
        "reversible tokenization must use request TOKENIZE and response RESTORE on one step",
      )
    }
  }
}

function remoteTimeoutForHook(hook: ProcessorHook | undefined): number {
  if (!hook) return 0
  if (hook.action === "SAFETY_CHECK") {
    return (hook.config as SafetyCheckConfig).timeout_ms
  }
  if (hook.action === "RESTORE") return 0
  const config = hook.config as ProcessorBuiltinConfig | undefined
  return config?.detector ? PRESIDIO_PAYLOAD_TIMEOUT_MS : 0
}

function safetyDecisionReceiptsForHook(
  hook: ProcessorHook | undefined,
  direction: "request" | "response",
  stepId: string,
): SafetyDecisionReceipt[] {
  if (hook?.action !== "SAFETY_CHECK") return []
  const config = hook.config as SafetyCheckConfig
  return config.checks.map((check) => ({
    adapter_id: config.adapter_id,
    provider: "HTTP",
    model: WORST_CASE_SAFETY_DECISION_MODEL,
    check_id: check.id,
    score: LONGEST_SAFETY_DECISION_SCORE,
    threshold: check.threshold,
    decision: "BLOCK",
    direction,
    step_id: stepId,
  }))
}

function validateSafetyDecisionReceiptBudget(
  steps: readonly ProcessorPolicyStep[],
): void {
  const receipts = {
    request: [] as SafetyDecisionReceipt[],
    response: [] as SafetyDecisionReceipt[],
  }
  for (const step of steps) {
    receipts.request.push(
      ...safetyDecisionReceiptsForHook(step.hooks.request, "request", step.step_id),
    )
    receipts.response.push(
      ...safetyDecisionReceiptsForHook(step.hooks.response, "response", step.step_id),
    )
  }
  for (const direction of ["request", "response"] as const) {
    if (safetyDecisionReceiptSerializedBytes(receipts[direction]) > MAX_SAFETY_DECISION_HANDOFF_BYTES) {
      throw new Error(
        `processor ${direction} safety decision receipts exceed ${MAX_SAFETY_DECISION_HANDOFF_BYTES} bytes`,
      )
    }
  }
}

export interface ProcessorRemoteTimeoutBudget {
  request_ms: number
  response_ms: number
}

export function processorRemoteTimeoutBudget(
  steps: readonly ProcessorPolicyStep[],
): ProcessorRemoteTimeoutBudget {
  return steps.reduce<ProcessorRemoteTimeoutBudget>((budget, step) => ({
    request_ms: budget.request_ms + remoteTimeoutForHook(step.hooks.request),
    response_ms: budget.response_ms + remoteTimeoutForHook(step.hooks.response),
  }), { request_ms: 0, response_ms: 0 })
}

/**
 * Validate the executable subset supported by this processor build. The
 * envelope keeps action names open for future adapters, but a release cannot
 * be signed or admitted unless the target runtime can execute every step.
 */
export function validateExecutableProcessorSteps(
  steps: readonly ProcessorPolicyStep[],
  path = "steps",
): void {
  const stepIds = new Set<string>()
  for (const [stepIndex, step] of steps.entries()) {
    validateStep(step, `${path}[${stepIndex}]`)
    if (stepIds.has(step.step_id)) {
      throw new Error("processor policy scope contains duplicate step ids")
    }
    stepIds.add(step.step_id)
  }
  const remoteTimeout = processorRemoteTimeoutBudget(steps)
  if (remoteTimeout.request_ms > PROCESSOR_REMOTE_TIMEOUT_BUDGET_MS) {
    throw new Error("processor request remote timeout exceeds 30000ms")
  }
  if (remoteTimeout.response_ms > PROCESSOR_REMOTE_TIMEOUT_BUDGET_MS) {
    throw new Error("processor response remote timeout exceeds 30000ms")
  }
  validateSafetyDecisionReceiptBudget(steps)
}

/**
 * Processor policy is one Gateway-scoped signed bundle. Each route selects an
 * exact Resource/Capability entry; wildcards would let one publication widen
 * another publication's processing policy.
 */
export function validateProcessorPolicyBundle(input: unknown): ProcessorPolicyBundle {
  if (!Value.Check(ProcessorPolicyBundleSchema, input)) {
    const issue = Value.Errors(ProcessorPolicyBundleSchema, input)[0]
    const detail = issue
      ? ` at ${String(issue.instancePath || "<root>")}: ${issue.message}`
      : ""
    throw new Error(`processor policy bundle schema is invalid${detail}`)
  }
  const bundle = input as ProcessorPolicyBundle
  if (bundle.expires_at <= bundle.issued_at) {
    throw new Error("processor policy bundle expiry is invalid")
  }
  const keys = bundle.scopes.map(scopeKey)
  if (new Set(keys).size !== keys.length) {
    throw new Error("processor policy bundle contains duplicate scopes")
  }
  const sorted = [...keys].sort(compareUtf8)
  if (keys.some((key, index) => key !== sorted[index])) {
    throw new Error("processor policy bundle scopes must be sorted")
  }
  for (const [scopeIndex, scope] of bundle.scopes.entries()) {
    validateExecutableProcessorSteps(scope.steps, `scopes[${scopeIndex}].steps`)
  }
  return bundle
}

export interface ProcessingContext {
  tenantId: string
  subjectId: string
  clientId: string
  resourceId: string
  capabilityId: string
  sessionId: string
  correlationId: string
}

export interface DataProtectionDetectorMatch {
  classification: string
  provider?: "PRESIDIO"
  adapter_id?: string
}

export interface DataProtectionResult {
  disposition: "CONTINUE" | "BLOCK"
  body: Uint8Array
  matches: string[]
  detectorMatches?: DataProtectionDetectorMatch[]
  dataClassifications?: DataClassificationReceipt[]
  safetyDecisions?: SafetyDecision[]
  requiresBufferedResponse?: boolean
  /** Ordered hooks that actually ran while producing this result. */
  executedSteps?: Array<{
    stepId: string
    action: string
  }>
}
