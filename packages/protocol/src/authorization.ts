export const AUTHORIZATION_BUNDLE_SCHEMA_VERSION = 1 as const

export type AuthorizationDisposition = "ALLOW" | "DENY"

export interface CompiledAuthorizationRule {
  rule_id: string
  disposition: AuthorizationDisposition
  subject_ids: string[]
  acting_client_ids: string[]
  resource_id: string
  capability_id: string
  public_models: string[]
  mcp_tools?: string[]
  allowed_actions?: string[]
  required_obligations?: string[]
}

export interface CompiledAuthorizationBundle {
  schema_version: typeof AUTHORIZATION_BUNDLE_SCHEMA_VERSION
  tenant_id: string
  revision: string
  policy_version: string
  issued_at: number
  expires_at: number
  rules: CompiledAuthorizationRule[]
  revoked_entitlement_ids?: string[]
  usage_policies?: CompiledUsagePolicy[]
  usage_contexts?: CompiledUsageContext[]
  resource_owners?: CompiledResourceOwner[]
  subject_contexts?: CompiledSubjectContext[]
  agent_delegations?: CompiledAgentDelegation[]
  execution_grants?: CompiledExecutionGrant[]
}

export interface CompiledSubjectContext {
  subject_id: string
  kind: "PERSON" | "APPLICATION" | "AGENT"
}

export interface CompiledAgentDelegation {
  delegation_id: string
  revision: number
  principal_subject_id: string
  agent_subject_id: string
  resource_id: string
  capability_ids: string[]
  acting_client_ids: string[]
  starts_at: number
  expires_at: number
  revocation_generation: number
  state: "ACTIVE" | "REVOKED"
}

export interface CompiledExecutionGrant {
  execution_grant_id: string
  subject_id: string
  acting_client_id: string
  resource_id: string
  capability_id: string
  action_digest: string
  issued_at: number
  expires_at: number
  issued_by_subject_id: string
}

export interface CompiledResourceOwner {
  resource_id: string
  organization_id: string
}

export interface CompiledUsagePolicy {
  usage_policy_id: string
  revision: number
  accounting_key_id: string
  selectors: {
    subject_id?: string
    consumer_organization_id?: string
    resource_id?: string
    capability_id?: string
    use_case_id?: string
  }
  limits: {
    request_quota?: { limit: number; window_seconds: number }
    concurrency?: { limit: number; lease_ttl_seconds: number }
    credit_budget?: { allocation_id: string; limit: number; credits_per_admitted_request: number }
    currency_budget?: { allocation_id: string; window_seconds: number; currency: string; limit_micros: number }
  }
}

export interface CompiledUsageContext {
  subject_id: string
  consumer_organization_id: string
  use_case_id: string
  risk_level?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
}

export interface AuthorizationInput {
  requestProtocol: "LLM" | "MCP" | "API" | "A2A"
  tenantId: string
  subjectId: string
  actingClientId: string
  resourceId: string
  capabilityId: string
  requestedPublicModel?: string
  mcpMethod?: string
  mcpTool?: string
  requestedAction?: string
  a2aOperation?: "SEND_MESSAGE" | "SEND_STREAMING_MESSAGE"
  targetAgentSubjectId?: string
  consumerOrganizationId?: string
  useCaseId?: string
  riskLevel?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
  resourceOwnerOrganizationId?: string
  subjectKind?: "PERSON" | "APPLICATION" | "AGENT"
  authorityMode?: "DIRECT" | "SELF" | "DELEGATED"
  principalSubjectId?: string
  delegationId?: string
  delegationRevision?: number
  delegationRevocationGeneration?: number
  executionGrantId?: string
  actionDigest?: string
  requestMethod?: string
  requestPath?: string
  correlationId: string
  now: number
}

export interface AuthorizationDecision {
  disposition: AuthorizationDisposition
  reason:
    | "ALLOWED_BY_RULE"
    | "DENIED_BY_RULE"
    | "MODEL_NOT_ENTITLED"
    | "NO_MATCHING_ENTITLEMENT"
    | "BUNDLE_EXPIRED"
    | "TENANT_MISMATCH"
    | "EXECUTION_GRANT_REQUIRED"
    | "EXECUTION_GRANT_INVALID"
    | "EXECUTION_GRANT_STORE_UNAVAILABLE"
    | "DELEGATION_NOT_ALLOWED"
  decisionId: string
  ruleId?: string
  supportingRuleIds?: string[]
  agentActingChain?: {
    authority_mode: "SELF" | "DELEGATED"
    calling_agent_subject_id: string
    target_agent_subject_id: string
    principal_subject_id?: string
    delegation_id?: string
    delegation_revision?: number
    delegation_revocation_generation?: number
  }
  allowedPublicModels: string[]
  allowedMcpTools: string[]
  allowedActions?: string[]
  requiredObligations: string[]
  validUntil?: number
  bundleRevision: string
  policyVersion: string
}

export interface AuthorizationDecisionEvent {
  event: "genio.one.authorization-decision"
  input: AuthorizationInput
  decision: AuthorizationDecision
}
