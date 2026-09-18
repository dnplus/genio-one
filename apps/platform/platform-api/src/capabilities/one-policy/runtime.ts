import { createHash } from "node:crypto"

import { Type, type Static } from "typebox"
import * as Value from "typebox/value"

const Identifier = Type.String({ minLength: 1, maxLength: 256 })
const StringList = Type.Array(Identifier, { maxItems: 2_048, uniqueItems: true })

const RuntimeActionSchema = Type.Union([
  Type.Literal("expose"),
  Type.Literal("invoke"),
  Type.Literal("load_extension"),
  Type.Literal("use"),
  Type.Literal("execute"),
])
const RuntimeEffectSchema = Type.Union([Type.Literal("ALLOW"), Type.Literal("DENY")])
const RuntimeRoleSchema = Type.Union([
  Type.Literal("TENANT_ADMINISTRATOR"),
  Type.Literal("ORGANIZATION_ADMINISTRATOR"),
  Type.Literal("USER"),
])

export const RuntimePolicyCapabilityIdSchema = Identifier

export const RuntimePolicyTargetSchema = Type.Object({
  runtime_id: Identifier,
  capability_id: RuntimePolicyCapabilityIdSchema,
}, { additionalProperties: false })

export const RuntimePolicyScopeSchema = Type.Object({
  subject_ids: Type.Array(Identifier, { maxItems: 1_000, uniqueItems: true }),
  organization_ids: Type.Array(Identifier, { maxItems: 1_000, uniqueItems: true }),
  roles: Type.Array(RuntimeRoleSchema, { maxItems: 3, uniqueItems: true }),
  client_ids: Type.Array(Identifier, { maxItems: 256, uniqueItems: true }),
  bot_ids: Type.Array(Identifier, { maxItems: 256, uniqueItems: true }),
  runtime_ids: Type.Array(Identifier, { maxItems: 256, uniqueItems: true }),
}, { additionalProperties: false })

const RuntimePolicyConstraintParameters = Type.Union([
  Type.Object({
    kind: Type.Literal("path_allowlist"),
    parameters: Type.Object({ paths: StringList }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("command_allowlist"),
    parameters: Type.Object({ commands: StringList }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("command_deny"),
    parameters: Type.Object({ commands: StringList }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("network"),
    parameters: Type.Object({ allow: StringList, deny: StringList }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("approval_required"),
    parameters: Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("read_only"),
    parameters: Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("cwd"),
    parameters: Type.Object({ path: Identifier }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("template"),
    parameters: Type.Object({ template: Identifier }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("ttl"),
    parameters: Type.Object({ ttl_seconds: Type.Integer({ minimum: 1, maximum: 86_400 }) }, { additionalProperties: false }),
  }, { additionalProperties: false }),
])

export const RuntimePolicyConstraintSchema = RuntimePolicyConstraintParameters

const RuntimePolicyObligationParameters = Type.Union([
  Type.Object({
    kind: Type.Literal("audit"),
    enforcement_point_id: Type.Optional(Identifier),
    parameters: Type.Object({
      event_kind: Type.Optional(Type.Union([Type.Literal("expose"), Type.Literal("invoke"), Type.Literal("denied")])),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("require_approval"),
    enforcement_point_id: Type.Optional(Identifier),
    parameters: Type.Object({ reason: Type.Optional(Identifier) }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("redact"),
    enforcement_point_id: Type.Optional(Identifier),
    parameters: Type.Object({ fields: StringList }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("usage"),
    enforcement_point_id: Type.Optional(Identifier),
    parameters: Type.Object({ meter: Identifier }, { additionalProperties: false }),
  }, { additionalProperties: false }),
])

export const RuntimePolicyObligationSchema = RuntimePolicyObligationParameters

export const RuntimePolicyRuleSchema = Type.Object({
  group_id: Type.Optional(Identifier),
  individual_settings: Type.Optional(Type.Boolean()),
  rule_id: Identifier,
  target: RuntimePolicyTargetSchema,
  actions: Type.Array(RuntimeActionSchema, { minItems: 1, uniqueItems: true }),
  effect: RuntimeEffectSchema,
  constraints: Type.Array(RuntimePolicyConstraintSchema, { maxItems: 128 }),
  obligations: Type.Array(RuntimePolicyObligationSchema, { maxItems: 128 }),
}, { additionalProperties: false })

export const RuntimePolicyMatchedPolicyRefSchema = Type.Object({
  policy_id: Identifier,
  policy_display_name: Type.String({ minLength: 1, maxLength: 512 }),
  policy_revision: Type.Integer({ minimum: 1 }),
  rule_ids: Type.Array(Identifier, { maxItems: 4_096, uniqueItems: true }),
}, { additionalProperties: false })

export const RuntimePolicyDefinitionSchema = Type.Object({
  display_name: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  scope: RuntimePolicyScopeSchema,
  rules: Type.Array(RuntimePolicyRuleSchema, { maxItems: 4_096 }),
}, { additionalProperties: false })

export const RuntimePolicyRevisionSchema = Type.Object({
  tenant_id: Identifier,
  policy_id: Identifier,
  revision: Type.Integer({ minimum: 1 }),
  display_name: Type.String({ minLength: 1, maxLength: 512 }),
  provenance: Type.Union([Type.Literal("SYSTEM_SEED"), Type.Literal("TENANT_AUTHORED")]),
  enabled: Type.Boolean(),
  scope: RuntimePolicyScopeSchema,
  rules: Type.Array(RuntimePolicyRuleSchema, { maxItems: 4_096 }),
  published_by_subject_id: Type.Union([Identifier, Type.Null()]),
  created_at: Type.Integer({ minimum: 0 }),
  published_at: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

const RuntimeObservedOutcomeSchema = Type.Union([
  Type.Literal("ALLOW"),
  Type.Literal("DENY"),
  Type.Literal("COMPLETED"),
  Type.Literal("FAILED"),
])

export const RuntimePolicyDecisionSchema = Type.Object({
  tenant_id: Identifier,
  subject_id: Identifier,
  client_id: Identifier,
  bot_id: Identifier,
  runtime_id: Identifier,
  policy_id: Type.Union([Identifier, Type.Null()]),
  policy_display_name: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
  policy_revision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  capability_id: Identifier,
  action: RuntimeActionSchema,
  target: Identifier,
  decision: RuntimeEffectSchema,
  reason_code: Identifier,
  constraints: Type.Array(RuntimePolicyConstraintSchema, { maxItems: 128 }),
  obligations: Type.Array(RuntimePolicyObligationSchema, { maxItems: 128 }),
  matched_policy_refs: Type.Array(RuntimePolicyMatchedPolicyRefSchema, { maxItems: 256 }),
  correlation_id: Type.Union([Identifier, Type.Null()]),
  session_id: Type.Union([Identifier, Type.Null()]),
  evaluated_at: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

export const RuntimePolicyAuditEventSchema = Type.Object({
  tenant_id: Identifier,
  audit_event_id: Identifier,
  correlation_id: Identifier,
  kind: Type.Literal("RUNTIME_POLICY_DECISION"),
  enforcement_point_id: Type.Literal("AGENT_RUNTIME"),
  phase: Type.Union([Type.Literal("AUTHORIZE"), Type.Literal("REPORT"), Type.Literal("PREVIEW")]),
  actor_subject: Type.Optional(Type.Object({ subject_id: Identifier, evidence_level: Type.Literal("VERIFIED") })),
  target_subject_id: Type.Optional(Identifier),
  outcome: RuntimeEffectSchema,
  report_outcome: Type.Union([RuntimeObservedOutcomeSchema, Type.Null()]),
  authorization_audit_event_id: Type.Union([Identifier, Type.Null()]),
  subject: Type.Object({ subject_id: Identifier, evidence_level: Type.Literal("VERIFIED") }, { additionalProperties: false }),
  acting_client: Type.Object({ acting_client_id: Identifier, evidence_level: Type.Literal("VERIFIED") }, { additionalProperties: false }),
  bot_id: Identifier,
  runtime_id: Identifier,
  capability_id: Identifier,
  action: RuntimeActionSchema,
  target: Identifier,
  policy_id: Type.Union([Identifier, Type.Null()]),
  policy_display_name: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
  policy_revision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  decision: RuntimeEffectSchema,
  reason_code: Identifier,
  constraints: Type.Array(RuntimePolicyConstraintSchema, { maxItems: 128 }),
  obligations: Type.Array(RuntimePolicyObligationSchema, { maxItems: 128 }),
  matched_policy_refs: Type.Array(RuntimePolicyMatchedPolicyRefSchema, { maxItems: 256 }),
  session_id: Type.Union([Identifier, Type.Null()]),
  occurred_at: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false })

export const RuntimePolicyEffectiveQuerySchema = Type.Object({
  bot_id: Identifier,
  runtime_id: Identifier,
  capability_id: Identifier,
  action: RuntimeActionSchema,
  session_id: Type.Optional(Identifier),
}, { additionalProperties: false })

export const RuntimePolicyAuthorizeBodySchema = Type.Object({
  correlation_id: Identifier,
  bot_id: Identifier,
  runtime_id: Identifier,
  capability_id: Identifier,
  action: RuntimeActionSchema,
  session_id: Type.Optional(Identifier),
}, { additionalProperties: false })

export const RuntimePolicyReportBodySchema = Type.Object({
  correlation_id: Identifier,
  bot_id: Identifier,
  runtime_id: Identifier,
  capability_id: Identifier,
  action: RuntimeActionSchema,
  outcome: RuntimeObservedOutcomeSchema,
  reason_code: Type.Optional(Identifier),
  session_id: Type.Optional(Identifier),
}, { additionalProperties: false })

export const RuntimePolicyListSchema = Type.Array(RuntimePolicyRevisionSchema)

export type RuntimeAction = Static<typeof RuntimeActionSchema>
export type RuntimePolicyEffect = Static<typeof RuntimeEffectSchema>
export type RuntimePolicyRole = Static<typeof RuntimeRoleSchema>
export type RuntimePolicyTarget = Static<typeof RuntimePolicyTargetSchema>
export type RuntimePolicyCapabilityId = Static<typeof RuntimePolicyCapabilityIdSchema>
export type RuntimePolicyMatchedPolicyRef = Static<typeof RuntimePolicyMatchedPolicyRefSchema>
export type RuntimePolicyScope = Static<typeof RuntimePolicyScopeSchema>
export type RuntimePolicyConstraint = Static<typeof RuntimePolicyConstraintSchema>
export type RuntimePolicyObligation = Static<typeof RuntimePolicyObligationSchema>
export type RuntimePolicyRule = Static<typeof RuntimePolicyRuleSchema>
export type RuntimePolicyDefinition = Static<typeof RuntimePolicyDefinitionSchema>
export type RuntimePolicyRevision = Static<typeof RuntimePolicyRevisionSchema>
export type RuntimePolicyDecision = Static<typeof RuntimePolicyDecisionSchema>
export type RuntimePolicyAuditEvent = Static<typeof RuntimePolicyAuditEventSchema>
export type RuntimePolicyEffectiveQuery = Static<typeof RuntimePolicyEffectiveQuerySchema>
export type RuntimePolicyAuthorizeBody = Static<typeof RuntimePolicyAuthorizeBodySchema>
export type RuntimePolicyReportOutcome = Static<typeof RuntimeObservedOutcomeSchema>
export type RuntimePolicyReportBody = Static<typeof RuntimePolicyReportBodySchema>

export const RUNTIME_POLICY_ID = "one-policy.runtime.capabilities" as const
export const PERSONAL_BOT_RESOURCE_ID = "genio.personal-bot" as const
export const RUNTIME_POLICY_CAPABILITY_IDS = [
  "codex.subscription",
  "model.invoke",
  "shell.exec",
  "filesystem.read",
  "filesystem.write",
  "browser.open",
  "web_search.query",
] as const

export function runtimeTarget(runtimeId: string, capabilityId: string): string {
  const runtime = runtimeId.trim()
  const capability = capabilityId.trim()
  if (!runtime || !capability) {
    throw new Error("RUNTIME_POLICY_TARGET_INVALID")
  }
  return `runtime:${runtime}:${capability}`
}

export interface RuntimePolicyEvaluationInput {
  tenant_id: string
  subject_id: string
  client_id: string
  role?: RuntimePolicyRole
  organization_ids: readonly string[]
  bot_id: string
  runtime_id: string
  capability_id: string
  action: RuntimeAction
  correlation_id?: string | null
  session_id?: string | null
  evaluated_at: number
}

export interface RuntimePolicyEvaluationOptions {
  connection_enabled?: boolean
  capability_registered?: boolean
}

function includesOrUnscoped(values: readonly string[], value: string): boolean {
  return values.length === 0 || values.includes(value)
}

export function runtimePolicyScopeMatches(scope: RuntimePolicyScope, input: RuntimePolicyEvaluationInput): boolean {
  return includesOrUnscoped(scope.subject_ids, input.subject_id) &&
    (scope.organization_ids.length === 0 || scope.organization_ids.some((id) => input.organization_ids.includes(id))) &&
    (scope.roles.length === 0 || (input.role !== undefined && scope.roles.includes(input.role))) &&
    includesOrUnscoped(scope.client_ids, input.client_id) &&
    includesOrUnscoped(scope.bot_ids, input.bot_id) &&
    includesOrUnscoped(scope.runtime_ids, input.runtime_id)
}

function targetMatches(rule: RuntimePolicyRule, input: RuntimePolicyEvaluationInput): boolean {
  return rule.target.runtime_id === input.runtime_id && rule.target.capability_id === input.capability_id && rule.actions.includes(input.action)
}

function constraintKey(value: RuntimePolicyConstraint): string {
  return JSON.stringify(value)
}

function obligationKey(value: RuntimePolicyObligation): string {
  return JSON.stringify(value)
}

function mergeConstraints(values: readonly RuntimePolicyConstraint[]): RuntimePolicyConstraint[] {
  const result = new Map<string, RuntimePolicyConstraint>()
  for (const value of values) result.set(constraintKey(value), value)
  return [...result.values()]
}

function mergeObligations(values: readonly RuntimePolicyObligation[]): RuntimePolicyObligation[] {
  const result = new Map<string, RuntimePolicyObligation>()
  for (const value of values) result.set(obligationKey(value), value)
  return [...result.values()]
}

function matchedPolicyRef(policy: RuntimePolicyRevision, ruleIds: readonly string[]): RuntimePolicyMatchedPolicyRef {
  return {
    policy_id: policy.policy_id,
    policy_display_name: policy.display_name,
    policy_revision: policy.revision,
    rule_ids: [...new Set(ruleIds)],
  }
}

function refsForEntries(entries: readonly { policy: RuntimePolicyRevision; rule?: RuntimePolicyRule }[]): RuntimePolicyMatchedPolicyRef[] {
  const grouped = new Map<string, { policy: RuntimePolicyRevision; ruleIds: string[] }>()
  for (const entry of entries) {
    const key = `${entry.policy.policy_id}\0${entry.policy.revision}`
    const current = grouped.get(key) ?? { policy: entry.policy, ruleIds: [] }
    if (entry.rule) current.ruleIds.push(entry.rule.rule_id)
    grouped.set(key, current)
  }
  return [...grouped.values()]
    .sort((left, right) => left.policy.policy_id.localeCompare(right.policy.policy_id) || right.policy.revision - left.policy.revision)
    .map((entry) => matchedPolicyRef(entry.policy, entry.ruleIds))
}

function baseDecision(input: RuntimePolicyEvaluationInput, policy: RuntimePolicyRevision | null): RuntimePolicyDecision {
  return {
    tenant_id: input.tenant_id,
    subject_id: input.subject_id,
    client_id: input.client_id,
    bot_id: input.bot_id,
    runtime_id: input.runtime_id,
    policy_id: policy?.policy_id ?? null,
    policy_display_name: policy?.display_name ?? null,
    policy_revision: policy?.revision ?? null,
    capability_id: input.capability_id,
    action: input.action,
    target: runtimeTarget(input.runtime_id, input.capability_id),
    decision: "DENY",
    reason_code: "DEFAULT_DENY",
    constraints: [],
    obligations: [],
    matched_policy_refs: [],
    correlation_id: input.correlation_id ?? null,
    session_id: input.session_id ?? null,
    evaluated_at: input.evaluated_at,
  }
}

export function unconfiguredRuntimeDecision(
  input: RuntimePolicyEvaluationInput,
  reasonCode = "POLICY_NOT_CONFIGURED",
): RuntimePolicyDecision {
  return { ...baseDecision(input, null), reason_code: reasonCode }
}

export function evaluateRuntimePolicy(
  policy: RuntimePolicyRevision,
  input: RuntimePolicyEvaluationInput,
  options: RuntimePolicyEvaluationOptions = {},
): RuntimePolicyDecision {
  const base = baseDecision(input, policy)
  if (!Value.Check(RuntimePolicyRevisionSchema, policy)) return { ...base, reason_code: "POLICY_INVALID" }
  if (policy.tenant_id !== input.tenant_id) return { ...base, reason_code: "TENANT_MISMATCH" }
  if (options.capability_registered === false || (options.capability_registered === undefined && !(RUNTIME_POLICY_CAPABILITY_IDS as readonly string[]).includes(input.capability_id))) return { ...base, reason_code: "RUNTIME_CAPABILITY_NOT_REGISTERED" }
  if (!policy.enabled) return { ...base, reason_code: "POLICY_DISABLED" }
  if (options.connection_enabled === false) {
    return { ...base, reason_code: "BOT_CONNECTION_DISABLED" }
  }
  if (!runtimePolicyScopeMatches(policy.scope, input)) return { ...base, reason_code: "POLICY_SCOPE_NOT_ALLOWED" }
  const matching = policy.rules.filter((rule) => targetMatches(rule, input))
  const applicable = { ...base, matched_policy_refs: [{ policy_id: policy.policy_id, policy_display_name: policy.display_name, policy_revision: policy.revision, rule_ids: matching.map((rule) => rule.rule_id) }] }
  const deny = matching.find((rule) => rule.effect === "DENY")
  if (deny) return { ...applicable, reason_code: `RULE_DENY:${deny.rule_id}` }
  const allow = matching.filter((rule) => rule.effect === "ALLOW")
  if (allow.length === 0) return { ...applicable, reason_code: "DEFAULT_DENY" }
  return {
    ...applicable,
    decision: "ALLOW",
    reason_code: `RULE_ALLOW:${allow[0]!.rule_id}`,
    constraints: mergeConstraints(allow.flatMap((rule) => rule.constraints)),
    obligations: mergeObligations(allow.flatMap((rule) => rule.obligations)),
  }
}

export function evaluateRuntimePolicies(
  policies: readonly RuntimePolicyRevision[],
  input: RuntimePolicyEvaluationInput,
  options: RuntimePolicyEvaluationOptions = {},
): RuntimePolicyDecision {
  if (options.connection_enabled === false) {
    return unconfiguredRuntimeDecision(input, "BOT_CONNECTION_DISABLED")
  }
  if (options.capability_registered === false || (options.capability_registered === undefined && !(RUNTIME_POLICY_CAPABILITY_IDS as readonly string[]).includes(input.capability_id))) {
    return unconfiguredRuntimeDecision(input, "RUNTIME_CAPABILITY_NOT_REGISTERED")
  }
  const tenantPolicies = policies.filter((policy) => policy.tenant_id === input.tenant_id)
  if (tenantPolicies.some((policy) => !Value.Check(RuntimePolicyRevisionSchema, policy))) {
    return unconfiguredRuntimeDecision(input, "POLICY_INVALID")
  }
  const scopedPolicies = tenantPolicies.filter((policy) => runtimePolicyScopeMatches(policy.scope, input))
  if (scopedPolicies.length === 0) {
    return unconfiguredRuntimeDecision(input, tenantPolicies.length === 0 ? "POLICY_NOT_CONFIGURED" : "POLICY_SCOPE_NOT_ALLOWED")
  }
  const disabled = scopedPolicies.filter((policy) => !policy.enabled)
  const enabled = scopedPolicies.filter((policy) => policy.enabled)
  if (enabled.length === 0) return evaluateRuntimePolicy(disabled[0]!, input, options)
  const ordered = [...enabled].sort((left, right) => left.policy_id.localeCompare(right.policy_id) || right.revision - left.revision)
  const matching = ordered.flatMap((policy) => policy.rules
    .filter((rule) => targetMatches(rule, input))
    .map((rule) => ({ policy, rule })))
  const deny = matching.find((entry) => entry.rule.effect === "DENY")
  if (deny) {
    const decision = evaluateRuntimePolicy(deny.policy, input, options)
    return { ...decision, reason_code: `RULE_DENY:${deny.rule.rule_id}`, matched_policy_refs: refsForEntries(matching) }
  }
  const allow = matching.filter((entry) => entry.rule.effect === "ALLOW")
  if (allow.length === 0) {
    const decision = evaluateRuntimePolicy(ordered[0]!, input, options)
    return { ...decision, matched_policy_refs: ordered.map((policy) => matchedPolicyRef(policy, [])) }
  }
  const winner = allow[0]!
  const decision = evaluateRuntimePolicy(winner.policy, input, options)
  const refs = refsForEntries(allow)
  return {
    ...decision,
    decision: "ALLOW",
    reason_code: `RULE_ALLOW:${winner.rule.rule_id}`,
    constraints: mergeConstraints(allow.flatMap((entry) => entry.rule.constraints)),
    obligations: mergeObligations(allow.flatMap((entry) => entry.rule.obligations)),
    matched_policy_refs: refs,
  }
}

export function runtimePolicyAuditEvent(
  decision: RuntimePolicyDecision,
  input: Pick<RuntimePolicyEvaluationInput, "tenant_id" | "subject_id" | "client_id">,
  phase: RuntimePolicyAuditEvent["phase"],
  occurredAt: number,
  options: {
    audit_event_id?: string
    authorization_audit_event_id?: string | null
    report_outcome?: RuntimePolicyReportOutcome | null
    reason_code?: string
  } = {},
): RuntimePolicyAuditEvent {
  const correlationId = decision.correlation_id ?? createHash("sha256").update(JSON.stringify(decision)).digest("hex")
  const auditEventId = options.audit_event_id ?? `${correlationId}:${phase.toLowerCase()}`
  return {
    tenant_id: input.tenant_id,
    audit_event_id: auditEventId,
    correlation_id: correlationId,
    kind: "RUNTIME_POLICY_DECISION",
    enforcement_point_id: "AGENT_RUNTIME",
    phase,
    outcome: decision.decision,
    report_outcome: options.report_outcome ?? null,
    authorization_audit_event_id: options.authorization_audit_event_id ?? null,
    subject: { subject_id: input.subject_id, evidence_level: "VERIFIED" },
    acting_client: { acting_client_id: input.client_id, evidence_level: "VERIFIED" },
    bot_id: decision.bot_id,
    runtime_id: decision.runtime_id,
    capability_id: decision.capability_id,
    action: decision.action,
    target: decision.target,
    policy_id: decision.policy_id,
    policy_display_name: decision.policy_display_name,
    policy_revision: decision.policy_revision,
    decision: decision.decision,
    reason_code: options.reason_code ?? decision.reason_code,
    constraints: decision.constraints,
    obligations: decision.obligations,
    matched_policy_refs: decision.matched_policy_refs,
    session_id: decision.session_id,
    occurred_at: occurredAt,
  }
}
