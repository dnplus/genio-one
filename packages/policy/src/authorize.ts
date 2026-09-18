import { observeOperation } from "../../telemetry/src/operation-observability"
import { createHash } from "node:crypto"

import type {
  AuthorizationDecision,
  AuthorizationInput,
  CompiledAuthorizationBundle,
  CompiledAuthorizationRule,
} from "../../protocol/src/authorization"

function matches(values: string[], value: string): boolean {
  return values.includes("*") || values.includes(value)
}

function ruleMatches(rule: CompiledAuthorizationRule, input: AuthorizationInput): boolean {
  const isMcpRequest = input.requestProtocol === "MCP"
  const toolAllowed = !isMcpRequest || (
    input.mcpMethod === "tools/call"
      ? input.mcpTool !== undefined && rule.mcp_tools?.includes(input.mcpTool) === true
      : (rule.mcp_tools?.length ?? 0) > 0
  )
  return (
    matches(rule.subject_ids, input.subjectId) &&
    matches(rule.acting_client_ids, input.actingClientId) &&
    rule.resource_id === input.resourceId &&
    (isMcpRequest || rule.capability_id === input.capabilityId) &&
    toolAllowed
  )
}

function decisionId(bundle: CompiledAuthorizationBundle, input: AuthorizationInput): string {
  return createHash("sha256")
    .update(bundle.revision)
    .update("\0")
    .update(input.tenantId)
    .update("\0")
    .update(input.subjectId)
    .update("\0")
    .update(input.actingClientId)
    .update("\0")
    .update(input.resourceId)
    .update("\0")
    .update(input.capabilityId)
    .update("\0")
    .update(input.requestedPublicModel ?? "")
    .update("\0")
    .update(input.mcpMethod ?? "")
    .update("\0")
    .update(input.mcpTool ?? "")
    .update("\0")
    .update(input.a2aOperation ?? "")
    .update("\0")
    .update(input.targetAgentSubjectId ?? "")
    .update("\0")
    .update(input.consumerOrganizationId ?? "")
    .update("\0")
    .update(input.useCaseId ?? "")
    .update("\0")
    .update(input.riskLevel ?? "")
    .update("\0")
    .update(input.subjectKind ?? "")
    .update("\0")
    .update(input.authorityMode ?? "")
    .update("\0")
    .update(input.principalSubjectId ?? "")
    .update("\0")
    .update(input.delegationId ?? "")
    .update("\0")
    .update(String(input.delegationRevision ?? ""))
    .update("\0")
    .update(String(input.delegationRevocationGeneration ?? ""))
    .update("\0")
    .update(input.executionGrantId ?? "")
    .update("\0")
    .update(input.actionDigest ?? "")
    .update("\0")
    .update(input.correlationId)
    .digest("hex")
}

function denied(
  bundle: CompiledAuthorizationBundle,
  input: AuthorizationInput,
  reason: AuthorizationDecision["reason"],
  rule?: CompiledAuthorizationRule,
): AuthorizationDecision {
  return {
    disposition: "DENY",
    reason,
    decisionId: decisionId(bundle, input),
    ruleId: rule?.rule_id,
    allowedPublicModels: [],
    allowedMcpTools: [],
    requiredObligations: [],
    bundleRevision: bundle.revision,
    policyVersion: bundle.policy_version,
  }
}

function intersectGrants(left: readonly string[], right: readonly string[]): string[] {
  if (left.length === 0) return [...right]
  if (right.length === 0) return [...left]
  return left.filter((value) => right.includes(value))
}

function agentActingChain(input: AuthorizationInput): AuthorizationDecision["agentActingChain"] {
  if (
    input.requestProtocol !== "A2A" ||
    input.subjectKind !== "AGENT" ||
    !input.targetAgentSubjectId ||
    (input.authorityMode !== "SELF" && input.authorityMode !== "DELEGATED")
  ) return undefined
  return {
    authority_mode: input.authorityMode,
    calling_agent_subject_id: input.subjectId,
    target_agent_subject_id: input.targetAgentSubjectId,
    ...(input.authorityMode === "DELEGATED"
      ? {
          principal_subject_id: input.principalSubjectId,
          delegation_id: input.delegationId,
          delegation_revision: input.delegationRevision,
          delegation_revocation_generation: input.delegationRevocationGeneration,
        }
      : {}),
  }
}

function authorizeDecision(
  bundle: CompiledAuthorizationBundle,
  input: AuthorizationInput,
): AuthorizationDecision {
  if (bundle.tenant_id !== input.tenantId) {
    return denied(bundle, input, "TENANT_MISMATCH")
  }
  if (input.now < bundle.issued_at || input.now >= bundle.expires_at) {
    return denied(bundle, input, "BUNDLE_EXPIRED")
  }
  if (input.requestProtocol === "A2A") {
    const target = bundle.subject_contexts?.find((context) =>
      context.subject_id === input.targetAgentSubjectId && context.kind === "AGENT")
    if (
      input.subjectKind !== "AGENT" ||
      !input.a2aOperation ||
      !target ||
      input.targetAgentSubjectId === input.subjectId
    ) {
      return denied(bundle, input, "NO_MATCHING_ENTITLEMENT")
    }
  }
  if (input.authorityMode === "DELEGATED") {
    if (!input.principalSubjectId) return denied(bundle, input, "NO_MATCHING_ENTITLEMENT")
    const agentDecision = authorize(bundle, {
      ...input,
      authorityMode: "SELF",
      principalSubjectId: undefined,
      delegationId: undefined,
      delegationRevision: undefined,
      delegationRevocationGeneration: undefined,
    })
    const principalDecision = authorize(bundle, {
      ...input,
      requestProtocol: "API",
      subjectId: input.principalSubjectId,
      subjectKind: undefined,
      authorityMode: "DIRECT",
      principalSubjectId: undefined,
      delegationId: undefined,
      delegationRevision: undefined,
      delegationRevocationGeneration: undefined,
      a2aOperation: undefined,
      targetAgentSubjectId: undefined,
    })
    if (agentDecision.disposition === "DENY" || principalDecision.disposition === "DENY") {
      return denied(bundle, input, "NO_MATCHING_ENTITLEMENT")
    }
    const allowedPublicModels = intersectGrants(
      agentDecision.allowedPublicModels,
      principalDecision.allowedPublicModels,
    )
    const allowedMcpTools = agentDecision.allowedMcpTools.filter((value) =>
      principalDecision.allowedMcpTools.includes(value)
    )
    if (input.requestedPublicModel && allowedPublicModels.length === 0 &&
        agentDecision.allowedPublicModels.length > 0 && principalDecision.allowedPublicModels.length > 0) {
      return denied(bundle, input, "MODEL_NOT_ENTITLED")
    }
    if (input.requestProtocol === "MCP" && input.mcpMethod === "tools/call" && allowedMcpTools.length === 0) {
      return denied(bundle, input, "NO_MATCHING_ENTITLEMENT")
    }
    return {
      disposition: "ALLOW",
      reason: "ALLOWED_BY_RULE",
      decisionId: decisionId(bundle, input),
      ruleId: principalDecision.ruleId,
      supportingRuleIds: [agentDecision.ruleId, principalDecision.ruleId].filter((value): value is string => Boolean(value)),
      allowedPublicModels,
      allowedMcpTools,
      requiredObligations: [...new Set([...agentDecision.requiredObligations, ...principalDecision.requiredObligations])].sort(),
      bundleRevision: bundle.revision,
      policyVersion: bundle.policy_version,
      agentActingChain: agentActingChain(input),
    }
  }

  const matchingRules = bundle.rules.filter((candidate) => ruleMatches(candidate, input))
  if (matchingRules.length === 0) {
    return denied(bundle, input, "NO_MATCHING_ENTITLEMENT")
  }
  const denyRule = matchingRules.find((rule) => rule.disposition === "DENY")
  if (denyRule) {
    return denied(bundle, input, "DENIED_BY_RULE", denyRule)
  }

  const allowRules = matchingRules.filter((rule) => rule.disposition === "ALLOW")
  const allowedMcpTools = [...new Set(allowRules.flatMap((rule) => rule.mcp_tools ?? []))]
    .sort((left, right) => left.localeCompare(right))
  const allowsAnyModel = allowRules.some((rule) => rule.public_models.length === 0)
  const allowedPublicModels = allowsAnyModel
    ? []
    : [...new Set(allowRules.flatMap((rule) => rule.public_models))]
  const rule = input.requestedPublicModel
    ? allowRules.find((candidate) =>
        candidate.public_models.length === 0 ||
        candidate.public_models.includes(input.requestedPublicModel!),
      )
    : allowRules[0]
  if (
    input.requestedPublicModel &&
    !allowsAnyModel &&
    !allowedPublicModels.includes(input.requestedPublicModel)
  ) {
    return denied(bundle, input, "MODEL_NOT_ENTITLED", allowRules[0])
  }
  if (!rule) return denied(bundle, input, "NO_MATCHING_ENTITLEMENT")

  return {
    disposition: "ALLOW",
    reason: "ALLOWED_BY_RULE",
    decisionId: decisionId(bundle, input),
    ruleId: rule.rule_id,
    allowedPublicModels,
    allowedMcpTools,
    requiredObligations: [...new Set(allowRules.flatMap((candidate) => candidate.required_obligations ?? []))].sort(),
    bundleRevision: bundle.revision,
    policyVersion: bundle.policy_version,
    agentActingChain: agentActingChain(input),
  }
}

export function authorize(bundle: CompiledAuthorizationBundle, input: AuthorizationInput): AuthorizationDecision {
  return observeOperation("genio-one-authorizer", "policy.authorize", { ...input, policy_version: bundle.policy_version, bundle_revision: bundle.revision }, () => authorizeDecision(bundle, input))
}
