export const REQUEST_ID_HEADER = "x-request-id"
export const CORRELATION_HEADER = "x-genio-correlation-id"
export const VERIFIED_SUBJECT_HEADER = "x-genio-verified-subject"
export const VERIFIED_CLIENT_HEADER = "x-genio-verified-client"
export const AI_GATEWAY_MODEL_HEADER = "x-ai-eg-model"
export const TRUSTED_TENANT_HEADER = "x-genio-trusted-tenant-id"
export const TRUSTED_SUBJECT_HEADER = "x-genio-trusted-subject-id"
export const TRUSTED_CLIENT_HEADER = "x-genio-trusted-client-id"
export const TRUSTED_RESOURCE_HEADER = "x-genio-trusted-resource-id"
export const TRUSTED_CAPABILITY_HEADER = "x-genio-trusted-capability-id"
export const TRUSTED_CORRELATION_HEADER = "x-genio-trusted-correlation-id"
export const BUNDLE_REVISION_HEADER = "x-genio-bundle-revision"
export const SESSION_ID_HEADER = "x-genio-session-id"
export const ALLOWED_PUBLIC_MODELS_HEADER = "x-genio-allowed-public-models"
export const ALLOWED_MCP_TOOLS_HEADER = "x-genio-allowed-mcp-tools"
export const DECISION_ID_HEADER = "x-genio-decision-id"
export const POLICY_VERSION_HEADER = "x-genio-policy-version"
export const CONSUMER_ORGANIZATION_HEADER = "x-genio-organization-id"
export const USE_CASE_HEADER = "x-genio-use-case-id"
export const ON_BEHALF_OF_SUBJECT_HEADER = "x-genio-on-behalf-of-subject-id"
export const EXECUTION_GRANT_HEADER = "x-genio-execution-grant-id"
export const ORGANIZATION_ROLE_ASSERTION_HEADER = "x-genio-organization-role"
export const SUBJECT_ROLE_ASSERTION_HEADER = "x-genio-role"
export const TRUSTED_CONSUMER_ORGANIZATION_HEADER = "x-genio-trusted-consumer-organization-id"
export const TRUSTED_USE_CASE_HEADER = "x-genio-trusted-use-case-id"
export const TRUSTED_RISK_LEVEL_HEADER = "x-genio-trusted-risk-level"
export const TRUSTED_SUBJECT_KIND_HEADER = "x-genio-trusted-subject-kind"
export const TRUSTED_AUTHORITY_MODE_HEADER = "x-genio-trusted-authority-mode"
export const TRUSTED_PRINCIPAL_SUBJECT_HEADER = "x-genio-trusted-principal-subject-id"
export const TRUSTED_DELEGATION_ID_HEADER = "x-genio-trusted-delegation-id"
export const TRUSTED_DELEGATION_REVISION_HEADER = "x-genio-trusted-delegation-revision"
export const TRUSTED_DELEGATION_GENERATION_HEADER = "x-genio-trusted-delegation-generation"
export const TRUSTED_AGENT_ACTING_CHAIN_HEADER = "x-genio-trusted-agent-acting-chain"
export const TRUSTED_REQUIRED_OBLIGATIONS_HEADER = "x-genio-trusted-required-obligations"
export const TRUSTED_EXECUTION_GRANT_HEADER = "x-genio-trusted-execution-grant-id"
export const TRUSTED_RESOURCE_OWNER_ORGANIZATION_HEADER = "x-genio-trusted-resource-owner-organization-id"
export const USAGE_ADMISSION_ID_HEADER = "x-genio-usage-admission-id"
export const USAGE_ACCOUNTING_KEYS_HEADER = "x-genio-usage-accounting-keys"
export const USAGE_CONCURRENCY_LEASES_HEADER = "x-genio-usage-concurrency-leases"
export const USAGE_POLICY_REVISIONS_HEADER = "x-genio-usage-policy-revisions"
export const USAGE_CURRENCY_ALLOCATIONS_HEADER = "x-genio-usage-currency-allocations"

export const CALLER_IDENTITY_HEADERS = [
  "x-genio-tenant-id",
  "x-genio-subject-id",
  "x-genio-acting-client-id",
  "x-genio-client-id",
  "x-genio-resource-id",
  "x-genio-capability-id",
  VERIFIED_SUBJECT_HEADER,
  VERIFIED_CLIENT_HEADER,
  AI_GATEWAY_MODEL_HEADER,
  CONSUMER_ORGANIZATION_HEADER,
  USE_CASE_HEADER,
  ON_BEHALF_OF_SUBJECT_HEADER,
  EXECUTION_GRANT_HEADER,
  ORGANIZATION_ROLE_ASSERTION_HEADER,
  SUBJECT_ROLE_ASSERTION_HEADER,
] as const

export const TRUSTED_CONTEXT_HEADERS = [
  TRUSTED_TENANT_HEADER,
  TRUSTED_SUBJECT_HEADER,
  TRUSTED_CLIENT_HEADER,
  TRUSTED_RESOURCE_HEADER,
  TRUSTED_CAPABILITY_HEADER,
  TRUSTED_CORRELATION_HEADER,
  TRUSTED_CONSUMER_ORGANIZATION_HEADER,
  TRUSTED_USE_CASE_HEADER,
  TRUSTED_RISK_LEVEL_HEADER,
  TRUSTED_SUBJECT_KIND_HEADER,
  TRUSTED_AUTHORITY_MODE_HEADER,
  TRUSTED_PRINCIPAL_SUBJECT_HEADER,
  TRUSTED_DELEGATION_ID_HEADER,
  TRUSTED_DELEGATION_REVISION_HEADER,
  TRUSTED_DELEGATION_GENERATION_HEADER,
  TRUSTED_AGENT_ACTING_CHAIN_HEADER,
  TRUSTED_REQUIRED_OBLIGATIONS_HEADER,
  TRUSTED_EXECUTION_GRANT_HEADER,
  TRUSTED_RESOURCE_OWNER_ORGANIZATION_HEADER,
] as const
