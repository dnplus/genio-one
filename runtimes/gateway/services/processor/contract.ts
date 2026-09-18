import { Type, type Static } from "typebox"
import { Value } from "typebox/value"
import {
  ModelCandidateEffectSchema,
  isModelCandidateEffect,
} from "../shared/model-candidate-effect"
import type { DataClassificationReceipt } from "../shared/data-classification"

const PROCESSOR_POLICY_SCHEMA_VERSION = 1 as const
export const PROCESSOR_POLICY_BUNDLE_SCHEMA_VERSION = 1 as const

const ProcessorIdentifier = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^(?!\\s)(?!.*\\s$)[^\\u0000\\r\\n]+$",
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

const ProcessorPolicySchema = Type.Object(
  {
    schema_version: Type.Literal(PROCESSOR_POLICY_SCHEMA_VERSION),
    revision: ProcessorIdentifier,
    action: DataProtectionActionSchema,
    patterns: Type.Array(DataProtectionPatternSchema, { maxItems: 128 }),
    token_ttl_seconds: Type.Integer({ minimum: 60, maximum: 86_400 }),
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
  return input
}

function scopeKey(scope: ProcessorPolicyScope): string {
  return `${scope.resource_id}\u0000${scope.capability_id}`
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
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

export interface DataProtectionResult {
  disposition: "CONTINUE" | "BLOCK"
  body: Uint8Array
  matches: string[]
  dataClassifications?: DataClassificationReceipt[]
  /** Ordered hooks that actually ran while producing this result. */
  executedSteps?: Array<{
    stepId: string
    action: string
  }>
}
