import {
  AUTHORIZATION_BUNDLE_SCHEMA_VERSION,
  type CompiledAuthorizationBundle,
  type CompiledAuthorizationRule,
} from "../../../../packages/protocol/src/authorization"
import {
  verifyCompactEdDsaJws,
  type VerificationKeyRing,
} from "../../../../packages/protocol/src/compact-jws"

export type { VerificationKeyRing } from "../../../../packages/protocol/src/compact-jws"

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value === value.trim()
}

function stringArray(value: unknown, allowEmpty = false): value is string[] {
  return (
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every(nonEmptyString)
  )
}

function canonicalStringArray(value: unknown): value is string[] {
  return stringArray(value, true) &&
    new Set(value).size === value.length &&
    value.every((entry, index) => index === 0 || Buffer.compare(Buffer.from(value[index - 1]!, "utf8"), Buffer.from(entry, "utf8")) < 0)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function positiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function isRule(value: unknown): value is CompiledAuthorizationRule {
  if (!value || typeof value !== "object") return false
  const rule = value as Record<string, unknown>
  return (
    nonEmptyString(rule.rule_id) &&
    (rule.disposition === "ALLOW" || rule.disposition === "DENY") &&
    stringArray(rule.subject_ids) &&
    stringArray(rule.acting_client_ids) &&
    nonEmptyString(rule.resource_id) &&
    nonEmptyString(rule.capability_id) &&
    stringArray(rule.public_models, true) &&
    (rule.mcp_tools === undefined || stringArray(rule.mcp_tools, true)) &&
    (rule.allowed_actions === undefined || stringArray(rule.allowed_actions, true)) &&
    (rule.required_obligations === undefined || canonicalStringArray(rule.required_obligations))
  )
}

function isUsagePolicy(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const policy = value as Record<string, unknown>
  const selectors = policy.selectors as Record<string, unknown>
  const limits = policy.limits as Record<string, unknown>
  if (!selectors || typeof selectors !== "object" || Array.isArray(selectors) ||
      !limits || typeof limits !== "object" || Array.isArray(limits)) return false
  if (!hasOnlyKeys(selectors, ["subject_id", "consumer_organization_id", "resource_id", "capability_id", "use_case_id"]) ||
      Object.values(selectors).some((entry) => !nonEmptyString(entry)) ||
      !hasOnlyKeys(limits, ["request_quota", "concurrency", "credit_budget", "currency_budget"]) ||
      Object.keys(limits).length === 0) return false
  const requestQuota = limits.request_quota as Record<string, unknown> | undefined
  const concurrency = limits.concurrency as Record<string, unknown> | undefined
  const credit = limits.credit_budget as Record<string, unknown> | undefined
  const currency = limits.currency_budget as Record<string, unknown> | undefined
  return nonEmptyString(policy.usage_policy_id) &&
    positiveInteger(policy.revision) &&
    nonEmptyString(policy.accounting_key_id) &&
    (!requestQuota || (hasOnlyKeys(requestQuota, ["limit", "window_seconds"]) && positiveInteger(requestQuota.limit) && positiveInteger(requestQuota.window_seconds))) &&
    (!concurrency || (hasOnlyKeys(concurrency, ["limit", "lease_ttl_seconds"]) && positiveInteger(concurrency.limit) && positiveInteger(concurrency.lease_ttl_seconds))) &&
    (!credit || (hasOnlyKeys(credit, ["allocation_id", "limit", "credits_per_admitted_request"]) && nonEmptyString(credit.allocation_id) && positiveInteger(credit.limit) && positiveInteger(credit.credits_per_admitted_request))) &&
    (!currency || (hasOnlyKeys(currency, ["allocation_id", "window_seconds", "currency", "limit_micros"]) && nonEmptyString(currency.allocation_id) && positiveInteger(currency.window_seconds) && typeof currency.currency === "string" && /^[A-Z]{3}$/.test(currency.currency) && nonNegativeInteger(currency.limit_micros)))
}

function isUsageContext(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const context = value as Record<string, unknown>
  return nonEmptyString(context.subject_id) &&
    nonEmptyString(context.consumer_organization_id) &&
    nonEmptyString(context.use_case_id) &&
    (context.risk_level === undefined || ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(String(context.risk_level)))
}

function isResourceOwner(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const owner = value as Record<string, unknown>
  return nonEmptyString(owner.resource_id) && nonEmptyString(owner.organization_id)
}

function isSubjectContext(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const context = value as Record<string, unknown>
  return nonEmptyString(context.subject_id) && ["PERSON", "APPLICATION", "AGENT"].includes(String(context.kind))
}

function isAgentDelegation(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const delegation = value as Record<string, unknown>
  return nonEmptyString(delegation.delegation_id) &&
    positiveInteger(delegation.revision) &&
    nonEmptyString(delegation.principal_subject_id) &&
    nonEmptyString(delegation.agent_subject_id) &&
    delegation.principal_subject_id !== delegation.agent_subject_id &&
    nonEmptyString(delegation.resource_id) &&
    stringArray(delegation.capability_ids) &&
    stringArray(delegation.acting_client_ids) &&
    nonNegativeInteger(delegation.starts_at) &&
    nonNegativeInteger(delegation.expires_at) &&
    Number(delegation.expires_at) > Number(delegation.starts_at) &&
    nonNegativeInteger(delegation.revocation_generation) &&
    (delegation.state === "ACTIVE" || delegation.state === "REVOKED")
}

function isExecutionGrant(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const grant = value as Record<string, unknown>
  return nonEmptyString(grant.execution_grant_id) &&
    nonEmptyString(grant.subject_id) &&
    nonEmptyString(grant.acting_client_id) &&
    nonEmptyString(grant.resource_id) &&
    nonEmptyString(grant.capability_id) &&
    typeof grant.action_digest === "string" && /^[a-f0-9]{64}$/.test(grant.action_digest) &&
    nonNegativeInteger(grant.issued_at) &&
    nonNegativeInteger(grant.expires_at) &&
    Number(grant.expires_at) > Number(grant.issued_at) &&
    nonEmptyString(grant.issued_by_subject_id)
}

export function isCompiledAuthorizationBundle(
  value: unknown,
): value is CompiledAuthorizationBundle {
  if (!value || typeof value !== "object") return false
  const bundle = value as Record<string, unknown>
  return (
    bundle.schema_version === AUTHORIZATION_BUNDLE_SCHEMA_VERSION &&
    nonEmptyString(bundle.tenant_id) &&
    nonEmptyString(bundle.revision) &&
    nonEmptyString(bundle.policy_version) &&
    Number.isSafeInteger(bundle.issued_at) &&
    Number.isSafeInteger(bundle.expires_at) &&
    Number(bundle.expires_at) > Number(bundle.issued_at) &&
    Array.isArray(bundle.rules) &&
    bundle.rules.every(isRule) &&
    (bundle.revoked_entitlement_ids === undefined || canonicalStringArray(bundle.revoked_entitlement_ids)) &&
    (bundle.usage_policies === undefined || (Array.isArray(bundle.usage_policies) && bundle.usage_policies.every(isUsagePolicy))) &&
    (bundle.usage_contexts === undefined || (Array.isArray(bundle.usage_contexts) && bundle.usage_contexts.every(isUsageContext)))
    && (bundle.resource_owners === undefined || (Array.isArray(bundle.resource_owners) && bundle.resource_owners.every(isResourceOwner)))
    && (bundle.subject_contexts === undefined || (Array.isArray(bundle.subject_contexts) && bundle.subject_contexts.every(isSubjectContext)))
    && (bundle.agent_delegations === undefined || (Array.isArray(bundle.agent_delegations) && bundle.agent_delegations.every(isAgentDelegation)))
    && (bundle.execution_grants === undefined || (Array.isArray(bundle.execution_grants) && bundle.execution_grants.every(isExecutionGrant)))
  )
}

export function verifyAuthorizationBundle(
  compactJws: string,
  keyRing: VerificationKeyRing,
): CompiledAuthorizationBundle {
  const payload = verifyCompactEdDsaJws(compactJws, keyRing)
  if (!isCompiledAuthorizationBundle(payload)) {
    throw new Error("authorization bundle payload is invalid")
  }
  return payload
}
