import type { ConnectorConfiguration } from "../../../../connectors/configuration"
export type { ConnectorConfiguration, ConnectorKind } from "../../../../connectors/configuration"
import type {
  GetGatewayMetrics200,
  GetGatewayActivitySessionTimeline200,
  GetGatewayTransactionTrends200PointsItem,
  GetRoutingReconstruction200,
  ListAccessGroups200Item,
  ListGatewayActivities200,
  ListGatewayActivities200EventsItem,
  ListActivityOutcomeAttributions200Item,
  ListTraces200TracesItem,
  ListTraces200TracesItemSpansItem,
} from "@/generated/management-api"

export type RouteDecision = "DIRECT" | "MANAGED" | "BLOCK"
export type ResourceLifecycle = "DRAFT" | "PUBLISHED" | "DEPRECATED" | "RETIRED"

export type TraceSpan = ListTraces200TracesItemSpansItem
export type TraceSummary = ListTraces200TracesItem
export type GatewayMetricsSummary = GetGatewayMetrics200
export type GatewayActivitySessionTimeline = GetGatewayActivitySessionTimeline200
export type OutcomeAttribution = ListActivityOutcomeAttributions200Item
export type ResourcePublicationRequestState = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED"
export type ResourceDnsManagement = "PLATFORM_MANAGED" | "EXTERNAL"
export type ResourceDnsVerificationState = "PENDING" | "VERIFIED" | "FAILED"
export type ResourceKind = "MCP" | "LLM" | "SAAS" | "API" | "EXTENSION"
export type InstallationServiceKind = "SERVICENOW_CSM" | "MAIL2000" | "DISCOVERY" | "GENIO_BOT"
export type ConnectionCertificateMode = "SYSTEM_CA" | "CUSTOM_CA"
export type ConnectionCertificateStatus = "NOT_CONFIGURED" | "VALID" | "EXPIRING" | "EXPIRED" | "NOT_YET_VALID" | "INVALID"

export interface ConnectionCertificate {
  mode: ConnectionCertificateMode
  certificate_pem: string | null
  fingerprint_sha256: string | null
  subject: string | null
  issuer: string | null
  is_self_signed: boolean
  not_before: number | null
  not_after: number | null
  status: ConnectionCertificateStatus
}
export type AccessRequestState =
  | "PENDING"
  | "APPROVED"
  | "DENIED"
  | "CANCELLED"
  | "EXPIRED"

export interface ResourceCapability {
  capability_id: string
  display_name: string
}

export interface ResourcePublicationEndpoint {
  gateway_id: string
  hostname: string
  base_path: string
  visibility: "PRIVATE" | "REQUEST" | "PUBLIC"
  dns_management: ResourceDnsManagement
  dns_verification: ResourceDnsVerificationState
  dns_target?: string | null
}

export type ApiInboundSecurity =
  | { type: "KEYLESS" }
  | { type: "API_KEY"; header_name: "x-api-key" }
  | { type: "MTLS"; trusted_client_ca_pem: string }
  | { type: "JWT"; issuer: string; audience: string; jwks_url: string }
  | {
      type: "MTLS_AND_JWT"
      trusted_client_ca_pem: string
      issuer: string
      audience: string
      jwks_url: string
    }
  | {
      type: "OAUTH2"
      issuer: string
      audience: string
      jwks_url: string
      scope: string
    }

export interface ApiResourceMetadata {
  api_product_id: string
  openapi_version: string
  document_title: string
  document_version: string
  public_path: string
  inbound_security: ApiInboundSecurity
  request_schema_validation: boolean
  operations: Array<{
    operation_id: string
    method: string
    path: string
    parameters?: Array<{
      location: "HEADER" | "QUERY"
      name: string
    }>
  }>
  a2a?: {
    protocol_version: "1.0"
    operation: "SEND_MESSAGE" | "SEND_STREAMING_MESSAGE"
    target_agent_subject_id: string
  }
}

export interface ApiRequestParameterRule {
  operation_id: string | null
  location: "HEADER" | "QUERY"
  name: string
  action: "PASSTHROUGH" | "SET" | "REMOVE"
  value: string | null
}

export interface ApiUpstreamRequestMapping {
  default_action: "PASSTHROUGH"
  rules: ApiRequestParameterRule[]
}

export interface McpAuthorizationMetadata {
  resource: string
  authorization_servers: string[]
  scopes_supported: string[]
  required_issuer: string
}

export interface McpDiscoveryOperation {
  tenant_id: string
  operation_id: string
  gateway_id: string
  resource_id: string
  connection_id: string
  requested_by_subject_id: string
  correlation_id: string
  state: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED"
  runtime_id: string | null
  endpoint: string
  credential_ref: string | null
  downstream_identity: {
    mode: "NONE" | "SERVICE" | "USER_PASSTHROUGH" | "USER_OAUTH" | "USER_PASSWORD"
    authentication?: "API_KEY" | "PROVIDER_CREDENTIAL_PROFILE"
    forward_headers?: Array<{ name: string }>
  }
  observation: {
    protocol_version: string
    server_name: string
    server_version: string | null
    tools: Array<{
      name: string
      title: string | null
      description: string | null
    }>
  } | null
  candidates: Array<{
    candidate_id: string
    capability_id: string
    tool_name: string
    revision_digest: string
    state: "NEW" | "PUBLISHED" | "IGNORED" | "BLOCKED"
  }>
  error_code: string | null
  error_message: string | null
  created_at: number
  claimed_at: number | null
  completed_at: number | null
  updated_at: number
}

export interface McpOAuthAuthorization {
  authorization_url: string
  expires_at: number
}

export interface McpOAuthBinding {
  tenant_id: string
  resource_id: string
  connection_id: string
  subject_id: string
  state: "CONNECTED"
  issuer: string
  resource_url: string
  scopes: string[]
  expires_at: number | null
  updated_at: number
}

export interface ResourceRegistration {
  builtin_service?: "DISCOVERY" | null
  installation_owned?: boolean
  service_kind?: InstallationServiceKind | null
  tenant_id: string
  resource_id: string
  display_name: string
  documentation?: string
  kind: ResourceKind
  owner_organization_id: string
  authentication_strategy: "NONE" | "EMA" | "OAUTH" | "API_KEY" | "MTLS"
  environment_id: string
  version: string
  lifecycle: ResourceLifecycle
  publication_endpoint?: ResourcePublicationEndpoint | null
  publication_request?: {
    request_id: string
    state: ResourcePublicationRequestState
    requested_by: string
    requested_at: number
    reviewed_by?: string | null
    reviewed_at?: number | null
    publication_state?: "IDLE" | "PENDING_REVIEW" | "BUILDING" | "FAILED" | "READY"
    attempt_id?: string | null
    failure_code?: string | null
  } | null
  operational_state: "UNKNOWN" | "HEALTHY" | "DEGRADED" | "UNAVAILABLE"
  health_observed_at?: number
  capabilities: ResourceCapability[]
  capabilities_owner_defined?: boolean
  mcp_authorization?: McpAuthorizationMetadata | null
  api?: ApiResourceMetadata | null
  extension_metadata?: BotPackageManifest | null
  enforcement_point_id: string
  created_at: number
}

export interface ApiEnvironmentDeployment {
  api_product_id: string
  environment_id: string
  active_resource_id: string
  previous_resource_id?: string | null
  deprecation?: ApiVersionDeprecation | null
  updated_by: string
  updated_at: number
}

export interface ApiVersionMigrationPlan {
  migration_path: string
  release_summary: string
  migration_guidance: string
  migration_deadline: number
}

export interface ApiVersionDeprecation extends ApiVersionMigrationPlan {
  resource_id: string
  replacement_resource_id: string
  original_public_path: string
  affected_application_ids: string[]
  deprecated_at: number
  retired_at?: number | null
}

export interface ApiVersionMigrationNotice extends ApiVersionMigrationPlan {
  application_id: string
  owner_organization_id: string
  resource_id: string
  replacement_resource_id: string
  kind: "DEPRECATED" | "REMINDER" | "MIGRATED" | "RETIRED"
  delivery_channels?: NotificationChannel[]
}

export interface ConnectionSummary {
  status: "DRAFT" | "READY" | "DEGRADED" | "DISABLED"
  connector_configuration?: ConnectorConfiguration
  connection_id: string
  display_name: string
  kind: ResourceKind
  endpoint_url: string
  mcp_tool_namespace?: string | null
  mcp_selected_tools: string[]
  mcp_tool_selection_operation_id: string | null
  credential_configured: boolean
  provider_credential_profile?: {
    profile_id: string
    revision: number
    strategy_digest: string
  } | null
  downstream_identity: {
    mode: "NONE" | "SERVICE" | "USER_PASSTHROUGH" | "USER_OAUTH" | "USER_PASSWORD"
    authentication?: "API_KEY" | "PROVIDER_CREDENTIAL_PROFILE"
    forward_headers?: Array<{ name: string }>
  }
  request_mapping?: ApiUpstreamRequestMapping | null
  certificate?: ConnectionCertificate
  llm?: LlmConnectionConfiguration | null
  resiliency?: UpstreamResiliencyPolicy
  resource_id: string
  enforcement_point_id: string
  lifecycle: ConnectionLifecycle
  configuration_revision: number
  revoke_requested_after_release_revision?: number | null
  verification_state: "UNVERIFIED" | "VERIFIED" | "FAILED"
  health_state: "UNKNOWN" | "HEALTHY" | "DEGRADED" | "UNAVAILABLE"
  health_observed_at: number | null
  health_source_revision: number | null
  routing_priority: number
  region: string | null
  supported_obligations: string[]
}

export interface ConnectionPage {
  items: ConnectionSummary[]
  offset: number
  limit: number
  has_more: boolean
}

export interface LlmModelRegistration {
  model_id: string
  upstream_model_id: string
}

export interface LlmConnectionConfiguration {
  provider_id: string
  models: LlmModelRegistration[]
}

export type ConnectionKind = Extract<ResourceKind, "MCP" | "LLM" | "API">
export type ConnectionLifecycle = "DRAFT" | "ENABLED" | "DISABLED" | "REVOKE_PENDING" | "REVOKED"
export interface UpstreamResiliencyPolicy {
  timeout_ms: number
  max_attempts: number
  idempotency_header?: string | null
  circuit_failure_threshold: number
  circuit_open_ms: number
}

export interface EndpointActivityEvent {
  activity_id: string
  correlation_id: string
  kind: "DISCOVERY" | "USAGE"
  subject_id: string
  device_id: string
  destination_host: string
  resource_id: string
  resource_class: "KNOWN" | "UNCLASSIFIED"
  client:
    | { status: "UNKNOWN" }
    | { status: "VERIFIED"; acting_client_id: string }
  client_compliance?: {
    state: "COMPLIANT" | "NON_COMPLIANT"
    issues: Array<"MANAGED_CONFIGURATION" | "OTEL_CONFIGURATION">
  }
  route: RouteDecision
  request_count: number
  observed_at: number
}

export interface EndpointActivityInventory {
  resources: Array<{
    resource_id: string
    resource_class: "KNOWN" | "UNCLASSIFIED"
    destination_hosts: string[]
    subjects: string[]
    devices: string[]
    clients: Array<{ status: "UNKNOWN" } | { status: "VERIFIED"; acting_client_id: string }>
    routes: RouteDecision[]
    first_seen_at: number
    request_count: number
    last_seen_at: number
    classification?: {
      source_resource_id: string
      discovery_activity_ids: string[]
      destination_hosts: string[]
      first_seen_at: number
      last_seen_at: number
      resource_id: string
      kind: ResourceKind
      policy_defaults: {
        visibility: "VISIBLE" | "HIDDEN"
        access: "AUTO_GRANT" | "REQUEST" | "DENY"
      }
      classified_by: {
        subject_id: string
        evidence_level: "VERIFIED"
      }
      classified_via: {
        acting_client_id: string | null
        evidence_level: "VERIFIED" | "ASSERTED" | "UNKNOWN"
      }
      classified_at: number
    }
  }>
  recent_activity: EndpointActivityEvent[]
}

export type ApiGatewayActivityEvent = ListGatewayActivities200EventsItem
export type RoutingReconstruction = GetRoutingReconstruction200

export interface ApiGatewayHttpMessageDetail {
  headers: Array<[string, string]>
  body: string | null
  body_truncated: boolean
  content_type: string | null
}

export interface ApiGatewayTransactionDetail {
  correlation_id: string
  availability: ApiGatewayActivityEvent["detail_availability"]
  captured_at: number | null
  expires_at: number | null
  redacted_fields: string[]
  request: ApiGatewayHttpMessageDetail | null
  response: ApiGatewayHttpMessageDetail | null
}

export type ApiGatewayActivityInventory = ListGatewayActivities200
export type GatewayActivityTrendPoint = GetGatewayTransactionTrends200PointsItem

export interface PolicyDecision {
  decision_id: string
  correlation_id: string
  policy_version: string
  winning_rule_id: string | null
  reason: string | Record<string, string>
  visibility: "VISIBLE" | "HIDDEN"
  access: "ENTITLED" | "AUTO_GRANT" | "REQUEST" | "DENY"
  route: RouteDecision
  obligations: Array<{
    kind: string
    enforcement_point_id: string
    parameters: Array<[string, string]>
  }>
  entitlement_conditions: {
    required_verified_acting_client_id: string | null
    requires_device: boolean
  }
  entitlement_id: string | null
  auto_grant_valid_for: number | null
  input_receipt: {
    requested_model_id?: string | null
    effective_model_id?: string | null
    mcp_authorization?: McpAuthorizationMetadata | null
    mcp_method?: string | null
    mcp_tool?: string | null
    mcp_name?: string | null
    mcp_protocol_version?: string | null
    mcp_connection_id?: string | null
    [key: string]: unknown
  }
  agent_authority?: {
    authority_mode: "SELF" | "DELEGATED"
    agent_subject_id: string
    principal_subject_id: string | null
    delegation_id: string | null
    delegation_revision: number | null
    delegation_revocation_generation: number | null
    target_agent_subject_id: string | null
    execution_grant_id: string | null
    action_digest: string | null
  } | null
}

export interface BotPolicyRules {
  allowed_roles: Array<"TENANT_ADMINISTRATOR" | "ORGANIZATION_ADMINISTRATOR" | "USER">
  allowed_subject_ids: string[]
}

export interface OnePolicyBotSeed {
  tenant_id: string
  policy_id: "one-policy.first-party.bot-default"
  policy_revision: number
  rules: BotPolicyRules
  seed: true
  enabled: boolean
  created_at: number
  updated_at: number
}

type ApiAuditEvent = Extract<import("@/generated/management-api").ListGatewayAuthorizationAuditEvents200, unknown[]>[number]
export type GovernanceAuditEvent = Extract<ApiAuditEvent, { kind: "POLICY_CHANGE" | "ACCESS_GROUP_CHANGE" }>

export type AuditEvent = DecisionAuditEvent | GovernanceAuditEvent

export interface DecisionAuditEvent {
  audit_event_id: string
  correlation_id: string
  kind: string
  outcome: string
  phase?: "AUTHORIZE" | "REPORT" | "PREVIEW"
  reason_code?: string
  report_outcome?: "ALLOW" | "DENY" | "COMPLETED" | "FAILED" | null
  authorization_audit_event_id?: string | null
  tenant_id: string
  subject: { subject_id: string; evidence_level: string }
  target_subject_id: string | null
  actor_subject: { subject_id: string; evidence_level: string } | null
  acting_client: { acting_client_id: string | null; evidence_level: string }
  resource_id: string | null
  capability_id: string | null
  policy_id?: string | null
  policy_display_name?: string | null
  policy_revision?: number | null
  runtime_id?: string | null
  bot_id?: string | null
  target?: string | null
  action?: string | null
  session_id?: string | null
  constraints?: Array<{ kind: string; parameters: Record<string, unknown> }>
  obligations?: Array<{ kind: string; enforcement_point_id?: string; parameters: Record<string, unknown> }>
  matched_policy_refs?: Array<{ policy_id: string; policy_display_name: string; policy_revision: number; rule_ids: string[] }>
  device_id: string | null
  endpoint_version: string | null
  desired_state_revision: string | null
  applied_state_revision: string | null
  applied_policy_version: string | null
  policy_proposal_id: string | null
  proposed_policy_version: string | null
  access_group_id: string | null
  destination_host: string | null
  routing_policy_rule_id: string | null
  route: RouteDecision | null
  missing_deployment_capability: "MANAGED_HTTP_PROXY" | "PROVIDER_TRANSPORT" | "SECURE_ACCESS" | null
  decision: PolicyDecision | null
  access_request_id: string | null
  entitlement_id: string | null
  entitlement_revocation_generation?: number | null
  enforcement_point_id: string | null
  obligation_kind: string | null
  runaway_trigger: {
    requests: number
    window_seconds: number
    suspend_seconds: number
    scope: "SUBJECT_ACTING_CLIENT" | "CAPABILITY"
    state: "TRIGGERED" | "ACTIVE"
  } | null
  upstream_attempted: boolean
  occurred_at: number
}

export interface SiemDestination {
  destination_id: string
  endpoint_url: string
  event_kinds: string[]
  enabled: boolean
  configured_by: { subject_id: string; evidence_level: "VERIFIED" }
  configured_at: number
}

export interface SiemDelivery {
  tenant_id: string
  destination_id: string
  audit_event_id: string
  endpoint_url: string
  event: AuditEvent
  status: "PENDING" | "IN_FLIGHT" | "RETRY_SCHEDULED" | "DELIVERED" | "CANCELLED"
  attempt_count: number
  next_attempt_at: number
  lease_owner: string | null
  lease_expires_at: number | null
  delivered_at: number | null
  cancelled_at: number | null
  last_error_code: string | null
}

export type ResourceHistoryStage =
  | "DISCOVERED"
  | "CLASSIFIED"
  | "POLICY_ASSIGNED"
  | "PUBLISHED"
  | "ENTITLEMENT_GRANTED"
  | "ENFORCEMENT"

export interface ResourceHistoryEvent {
  source_event_id: string
  correlation_id: string
  stage: ResourceHistoryStage
  subject_id: string
  acting_client_id: string | null
  capability_id: string | null
  policy_version: string | null
  entitlement_id: string | null
  route: RouteDecision | null
  occurred_at: number
}

export interface ResourceHistory {
  tenant_id: string
  resource_id: string
  events: ResourceHistoryEvent[]
}

export interface ResourceUsageConsumer {
  subject_id: string
  acting_client_id: string
  request_count: number
  total_tokens: number
}

export interface ResourceUsageAnalytics {
  tenant_id: string
  resource_id: string
  from: number
  to: number
  request_count: number
  settled_request_count: number
  error_count: number
  error_rate_basis_points: number
  average_latency_seconds: number | null
  p95_latency_seconds: number | null
  input_tokens: number
  output_tokens: number
  total_tokens: number
  top_consumers: ResourceUsageConsumer[]
  cost: {
    currency: string | null
    total_cost_micros: number | null
    priced_record_count: number
    unpriced_record_count: number
  } | null
}

export interface AiUsageDashboard {
  tenant_id: string
  from: number
  to: number
  active_user_count: number
  ai_resource_count: number
  route_distribution: {
    direct: number
    managed: number
    block: number
  }
  usage: {
    request_count: number
    tool_call_count: number
    request_bytes: number
    response_bytes: number
    input_tokens: number
    output_tokens: number
    total_tokens: number
  }
  cost_by_currency: Array<{
    currency: string
    total_cost_micros: number
    priced_record_count: number
  }>
  cost_by_resource: Array<{
    resource_id: string
    display_name: string
    currency: string
    total_cost_micros: number
  }>
  cost_by_subject: Array<{
    subject_id: string
    display_name: string | null
    department: string | null
    currency: string
    total_cost_micros: number
  }>
  cost_by_department: Array<{
    department: string | null
    currency: string
    total_cost_micros: number
  }>
  cost_trend: Array<{
    day_start: number
    currency: string
    total_cost_micros: number
  }>
  resource_budgets: Array<{
    resource_id: string
    display_name: string
    allocation_id: string
    currency: string
    limit_cost_micros: number
    consumed_cost_micros: number
    consumption_basis_points: number
    priced_record_count: number
    unpriced_record_count: number
    starts_at: number
    ends_at: number
    status: "WITHIN_BUDGET" | "OVER_BUDGET" | "INCOMPLETE_PRICING"
  }>
  priced_record_count: number
  unpriced_record_count: number
}

export interface InvocationAccountingRecord {
  invocation: {
    invocation_id: string
    correlation_id: string
    tenant_id: string
    subject_id: string
    consumer_organization_id: string
    resource_owner_organization_id: string
    resource_id: string
    capability_id: string
    use_case_id: string
    usage_policy_revisions: string[]
    release_revision: string
    accounting_key_id: string
    created_at: number
  }
  quantities: Array<{
    quantity_id: string
    invocation_id: string
    quantity: number
    unit: string
    trusted_source: string
    observed_at: number
  }>
  charge: {
    charge_id: string
    invocation_id: string
    correlation_id: string
    accounting_key_id: string
    created_at: number
  }
  valuations: Array<{
    valuation_id: string
    charge_id: string
    status: "ESTIMATED" | "ACTUAL"
    currency: string
    amount_micros: number
    pricing_source: string
    pricing_version: string
    valued_at: number
  }>
}

export interface UseCaseEntry {
  tenant_id: string
  organization_id: string
  use_case_id: string
  display_name: string
  risk_level: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
  state: "ACTIVE" | "DISABLED"
  created_at: number
}

export interface UsagePolicyRevision {
  usage_policy_id: string
  display_name?: string
  revision: number
  tenant_id: string
  owner_organization_id: string
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
  state: "DRAFT" | "ACTIVE" | "RETIRED"
  created_at: number
}

export interface CreateUsagePolicyRevisionInput {
  usage_policy_id?: string
  display_name: string
  revision?: number
  owner_organization_id: string
  accounting_key_id?: string
  selectors: UsagePolicyRevision["selectors"]
  limits: {
    request_quota?: { limit: number; window_seconds: number }
    concurrency?: { limit: number; lease_ttl_seconds: number }
    credit_budget?: { allocation_id?: string; limit: number; credits_per_admitted_request: number }
    currency_budget?: { allocation_id?: string; window_seconds: number; currency: string; limit_micros: number }
  }
  state: UsagePolicyRevision["state"]
}

export interface ClassifyDiscoveredResourcesInput {
  resources: Array<{
    sourceResourceId: string
    resourceId: string
    displayName: string
  }>
  kind: Extract<ResourceKind, "MCP" | "LLM" | "SAAS">
  visibility: "VISIBLE" | "HIDDEN"
  access: "AUTO_GRANT" | "REQUEST" | "DENY"
  authenticationStrategy: "NONE" | "EMA" | "OAUTH" | "API_KEY" | "MTLS"
  environmentId: string
  version: string
  capabilityId: string
  capabilityName: string
  enforcementPointId: string
}

export interface AccessRequest {
  access_request_id: string
  requester: string
  target_subject: string
  acting_client: {
    acting_client_id: string | null
    evidence_level: "VERIFIED" | "ASSERTED" | "UNKNOWN"
  }
  resource_id: string
  capability_id: string
  justification: string
  requested_valid_for: number
  configuration_revision?: string | null
  approval_workflow_version?: string | null
  approver: string
  state: AccessRequestState
  created_at: number
  expires_at: number | null
  resolved_at: number | null
  resolution_reason: string | null
  policy_version_at_creation: string
  approval_stages: Array<{
    stage_id: string
    approver:
      | { kind: "ORGANIZATION"; organization_id: string }
      | { kind: "SUBJECT"; subject_id: string }
    primary_approver: string
    assigned_approver: string
    delegation_id?: string | null
    state: "PENDING" | "APPROVED" | "DENIED" | "CANCELLED" | "EXPIRED"
    decided_by?: { subject_id: string; evidence_level: "VERIFIED" | "ASSERTED" | "UNKNOWN" } | null
    decided_at?: number | null
  }>
  current_approval_stage: number
}

export type RequestAccessOutcome =
  | { CREATED: AccessRequest }
  | { EXISTING: AccessRequest }
  | { ALREADY_ENTITLED: string }
  | { NOT_REQUESTABLE: PolicyDecision }

export interface Entitlement {
  entitlement_id: string
  subject_id: string
  resource_id: string
  capability_id: string
  state: "ACTIVE" | "REVOKED" | "EXPIRED"
  valid_from: number
  valid_until: number
  revocation_reason: string | null
}

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"

export interface EntitlementRiskFinding {
  entitlement_id: string
  score: number
  level: RiskLevel
  factors: Array<{ code: string; points: number; explanation: string }>
  last_used_at?: number | null
  toxic_combination: boolean
}

export interface SubjectRiskAssessment {
  model_version: string
  tenant_id: string
  subject_id: string
  subject_kind: "PERSON" | "APPLICATION" | "AGENT"
  score: number
  level: RiskLevel
  active_entitlement_count: number
  toxic_warnings: string[]
  findings: EntitlementRiskFinding[]
  trend: Array<{
    score: number
    level: RiskLevel
    at: number
    cause_kind: string
    entitlement_id?: string | null
  }>
  assessed_at: number
}

export interface BlastRadiusSnapshot {
  tenant_id: string
  root_subject_id: string
  as_of: number
  include_history: boolean
  nodes: Array<{
    node_id: string
    kind: "PERSON" | "APPLICATION" | "AGENT" | "ENTITLEMENT" | "CAPABILITY" | "RESOURCE"
    label: string
    state: string
    last_used_at?: number | null
    risk_level?: RiskLevel | null
  }>
  edges: Array<{
    source_node_id: string
    target_node_id: string
    relation: string
    entitlement_id?: string | null
    capability_id?: string | null
    state: string
    ttl_seconds?: number | null
  }>
  risk: SubjectRiskAssessment
}

export interface AccessReviewScope {
  subject_ids: string[]
  subject_kinds: Array<"PERSON" | "APPLICATION" | "AGENT">
  resource_ids: string[]
  capability_ids: string[]
  access_group_ids: string[]
}

export interface EntitlementAccessReview {
  review_id: string
  tenant_id: string
  name: string
  scope: AccessReviewScope
  state: "OPEN" | "COMPLETED"
  items: Array<{
    entitlement_id: string
    subject_id: string
    resource_id: string
    capability_id: string
    valid_until: number
    reviewer_id: string
    risk: EntitlementRiskFinding
    decision?: {
      decision: "RETAIN" | "REVOKE"
      reviewer: { subject_id: string; evidence_level: string }
      reason: string
      decided_at: number
    } | null
    revoked: boolean
  }>
  deadline: number
  notifications_enabled: boolean
  created_by: { subject_id: string; evidence_level: string }
  created_at: number
  completed_by?: { subject_id: string; evidence_level: string } | null
  completed_at?: number | null
  report?: {
    schema_version: string
    report_id: string
    review_id: string
    generated_at: number
    generated_by: { subject_id: string; evidence_level: string }
    scope: AccessReviewScope
    items: EntitlementAccessReview["items"]
    timeline: Array<{ kind: string; actor_subject_id: string; occurred_at: number; entitlement_id?: string | null }>
  } | null
  timeline: Array<{ kind: string; actor_subject_id: string; occurred_at: number; entitlement_id?: string | null }>
}

export interface AccessNotification {
  notification_id: string
  kind: "PENDING_APPROVAL" | "REQUEST_APPROVED" | "REQUEST_DENIED" | "ENTITLEMENT_EXPIRING" | "RUNAWAY_INVOCATION_SUSPENDED"
  notification_type?: string
  audience: "APPROVER" | "REQUESTER" | "TARGET_SUBJECT" | "RESOURCE_OWNER" | "SECURITY_ADMIN"
  recipient_subject_id: string
  requester: string | null
  access_request_id: string | null
  entitlement_id: string | null
  resource_id: string
  capability_id: string
  occurred_at: number
  valid_until: number | null
  runaway_trigger?: {
    requests: number
    window_seconds: number
    suspend_seconds: number
    scope: "SUBJECT_ACTING_CLIENT" | "CAPABILITY"
    state: "TRIGGERED" | "ACTIVE"
  } | null
  delivery_channels?: NotificationChannel[]
  action_path: string
}

export type ConfigurationRevisionState = "DRAFT" | "VALIDATED" | "REVIEWED" | "PUBLISHED"
export type ConfigurationProjectionStatus = "PENDING" | "CONVERGED" | "FAILED" | "ROLLED_BACK"
export type NotificationChannel = "IN_APP"

export type NotificationType =
  | "ACCESS_REQUEST"
  | "ENTITLEMENT_EXPIRING"
  | "RUNAWAY_INVOCATION_SUSPENDED"
  | "API_VERSION_LIFECYCLE"
  | "ALL"

export interface TenantConfiguration {
  brand_name: string
  language: string
  catalog_visibility: string
  request_form: {
    enabled: boolean
    required_fields: string[]
    default_ttl_seconds: number
  }
  ttl_options_seconds: number[]
  approval_workflow_version: string
  notification_channels: NotificationChannel[]
  login_branding?: TenantLoginBranding
}

export interface TenantLoginBranding {
  tagline: string
  logo_url: string
  primary_color: string
  page_color: string
  custom_css: string
}

export interface TenantConfigurationRevision {
  tenant_id: string
  revision: string
  state: ConfigurationRevisionState
  settings: TenantConfiguration
  created_by: { subject_id: string; evidence_level: string }
  created_at: number
  validated_at: number | null
  previewed_at: number | null
  reviewed_at: number | null
  published_at: number | null
  projection: {
    desired_revision: string
    observed_revision: string | null
    status: ConfigurationProjectionStatus
    drift: boolean
    last_error: string | null
    retry_count: number
    last_reconciled_at: number | null
  }
  rolled_back_from: string | null
}

export interface NotificationSubscription {
  subscription_id: string
  tenant_id: string
  subject_id: string
  notification_type: NotificationType
  channel: NotificationChannel
  enabled: boolean
  created_by: { subject_id: string; evidence_level: string }
  updated_at: number
}

export interface ResourceOnboardingRequest {
  resource_onboarding_request_id: string
  tenant_id: string
  correlation_id: string
  requester: string
  acting_client: {
    acting_client_id: string | null
    evidence_level: "VERIFIED" | "ASSERTED" | "UNKNOWN"
  }
  requested_resource_name: string
  requested_service_url: string | null
  business_justification: string
  state: "PENDING"
  created_at: number
}

export type SelfServiceHubStatus =
  | "CONNECTED"
  | "AVAILABLE"
  | "REQUEST_ACCESS"
  | "PENDING_APPROVAL"
  | "DENIED"

export interface SubjectCatalogCapability {
  resource_id: string
  resource_display_name: string
  capability_id: string
  capability_display_name: string
  resource_owner_id: string
  resource_owner_display_name: string
  connection_status: string
  access: "ENTITLED" | "AUTO_GRANT" | "REQUEST" | "DENY"
  hub_status: SelfServiceHubStatus
  restriction_reason?: string | null
}

export interface SubjectCatalogSnapshot {
  tenant_id: string
  catalog_revision: string
  subject_id: string
  subject_display_name: string
  capabilities: SubjectCatalogCapability[]
}

export interface IdentitySession {
  tenant_id: string
  subject_id: string
  acting_client_id: string
  role?: "USER" | "ORGANIZATION_ADMINISTRATOR" | "TENANT_ADMINISTRATOR"
  organization_ids?: string[]
  scopes: string[]
  acr: string | null
  amr: string[]
}

export interface BrowserOidcConfiguration {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  client_id: string
  scopes: string[]
  management_client_id?: string
  management_scopes?: string[]
}

export interface AuditExportRecord {
  policy_version: string | null
  decision_correlation_id: string
  audit_event_id: string
  correlation_id: string
  resource_id: string | null
  occurred_at: number
}

export interface AuditExportArtifact {
  schema_version: "genioone.audit-export.v1"
  tenant_id: string
  from: number
  to: number
  resource_id: string
  record_count: number
  records: AuditExportRecord[]
}

export type EndpointManagedRouteTarget = "AI_MCP" | "API" | "PRIVATE_RESOURCE"

export interface EndpointManagedRouteBinding {
  target: EndpointManagedRouteTarget
  provider_id: string
}

export interface EndpointPeerLease {
  peer_lease_id: string
  access_session_id: string
  endpoint_device_id: string
  gateway_runtime_id: string
  provider_id: string
  endpoint_public_key: string
  gateway_public_key: string
  gateway_endpoint: string
  endpoint_allowed_networks: string[]
  gateway_allowed_networks: string[]
  persistent_keepalive_seconds: number
  generation: number
  issued_at: number
  expires_at: number
}

export interface EndpointRouteProjection {
  peer_lease_id: string
  resource_id: string
  binding: EndpointManagedRouteBinding
  route_reference: string
  dns_names: string[]
  network_prefixes: string[]
  generation: number
}

export type EndpointManagedDelivery =
  | { kind: "HTTP_PROXY"; proxy_url: string }
  | { kind: "PROVIDER_TRANSPORT"; transport_provider_id: string; route_reference: string }
  | { kind: "SECURE_ACCESS"; peer_lease: EndpointPeerLease; route_projection: EndpointRouteProjection }

export interface EndpointManagedRoute {
  enforcement_point_id: string
  binding: EndpointManagedRouteBinding
  delivery: EndpointManagedDelivery
}

export interface EndpointClientComplianceRequirement {
  acting_client_id: string
  managed_configuration_revision: string
  otel_collector_origin: string
}

export interface EndpointRoutingRule {
  policy_rule_id: string
  resource_id: string
  host_suffix: string
  route: RouteDecision
  managed_route: EndpointManagedRoute | null
  policy_message: string | null
  client_compliance?: EndpointClientComplianceRequirement | null
}

export interface EndpointDesiredState {
  revision: string
  policy_version: string
  routing: {
    default_route: "DIRECT"
    rules: EndpointRoutingRule[]
  }
}

export interface TenantIdentityInventory {
  tenant_id: string
  subjects: Array<{
    subject_id: string
    kind: "PERSON" | "APPLICATION" | "AGENT"
    profile: { display_name: string | null; email: string | null; department: string | null }
    suspended: boolean
    suspended_at: number | null
    suspended_by: string | null
    suspension_reason: string | null
  }>
  external_identity_bindings: Array<{
    provider_id: string
    external_subject_id: string
    subject_id: string
  }>
  tenant_administrators: string[]
}

export interface AgentCapabilityScope {
  resource_id: string
  capability_id: string
}

export interface AgentDelegation {
  tenant_id: string
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
  created_by_subject_id: string
  created_at: number
}

export interface ExecutionGrantRequest {
  tenant_id: string
  request_id: string
  revision: number
  subject_id: string
  acting_client_id: string
  resource_id: string
  capability_id: string
  action_digest: string
  requested_expires_at: number
  state: "PENDING" | "APPROVED" | "DENIED"
  created_by_subject_id: string
  created_at: number
  decided_by_subject_id: string | null
  decided_at: number | null
  decision_reason: string | null
  execution_grant_id: string | null
}

export interface AgentExtensionVersion {
  extension_id: string
  version: string
  capability_ids: string[]
  entitlement_ids: string[]
  policy_version: string
  contract_digest: string
  lifecycle: "DRAFT" | "PUBLISHED" | "RETIRED"
  created_at: number
  published_at?: number | null
}

export interface BotPackageManifest {
  package_type: "BOT" | "SKILL" | "PLUGIN"
  resource_id?: string
  version?: string
  profile: {
    title: string
    description: string
    avatar: unknown
  }
  skills: Array<{ id: string; path: string; digest?: string }>
  plugins: Array<{ name: string; marketplace?: string; digest?: string }>
  resource_bindings: Array<{ resource_id: string; capability_id: string }>
  default_runtime_tier: "none" | "headless" | "desktop"
  manifest_digest: string
  artifact_digest: string
  source?: {
    kind: "GITHUB" | "FIXTURE" | "UPLOAD"
    ref: string
    path?: string
  }
}

export interface CreateAgentDelegationInput {
  principalSubjectId: string
  agentSubjectId: string
  resourceId: string
  capabilityIds: string[]
  actingClientIds: string[]
  expiresAt: number
}

export type LocalAccessGroup = ListAccessGroups200Item
export type LocalAccessGroupMembershipSource = LocalAccessGroup["membership_sources"][number]
export type LocalAccessGroupMembershipSourceKind = LocalAccessGroupMembershipSource["kind"]

export interface LocalAccessGroupMembership {
  tenant_id: string
  access_group_id: string
  subject_id: string
  source: LocalAccessGroupMembershipSourceKind
  source_reference: string
  source_revision: number
  assigned_by: { subject_id: string; evidence_level: "VERIFIED" }
  assigned_at: number
}

export interface LocalAccessGroupInventory {
  tenant_id: string
  groups: LocalAccessGroup[]
  memberships: LocalAccessGroupMembership[]
}

export interface Organization {
  tenant_id: string
  organization_id: string
  display_name: string
  slug: string
  member_subject_ids: string[]
  organization_administrator_subject_ids: string[]
  membership_sources: Array<{
    kind: "MANUAL" | "SCIM_GROUP" | "OIDC_GROUP"
    reference: string
    status: "SYNCED" | "PENDING" | "ERROR"
  }>
  created_at: number
}

export type DemoProjectInstallation = "NOT_INSTALLED" | "SKIPPED" | "INSTALLED"
export type DemoProjectItemState = "READY" | "NEEDS_CONFIGURATION" | "DISABLED" | "ERROR"

export interface DemoProjectItem {
  id: "archify" | "codex" | "context7" | "product-management" | "gemini"
  name: string
  state: DemoProjectItemState
  detail: string
  resource_id?: string | null
  connection_id?: string | null
  action_url?: string | null
}

export interface DemoProjectStatus {
  demo_id: "ce-starter"
  version: "1.0.0"
  installation: DemoProjectInstallation
  organization_id: string | null
  items: DemoProjectItem[]
  prompts: Array<{
    id: string
    title: string
    text: string
    model_route: "codex-subscription" | "genio-gateway"
  }>
  package_resource_id: string
  bot_url: string | null
}

export interface CreateOrganizationInput {
  displayName: string
  memberSubjectIds: string[]
}

export interface UpdateOrganizationInput {
  displayName: string
  memberSubjectIds: string[]
  organizationAdministratorSubjectIds: string[]
  membershipSources: Organization["membership_sources"]
}

export interface ApplicationRegistration {
  tenant_id: string
  application_id: string
  subject_id: string
  display_name: string
  owner_organization_id: string
  registered_by: { subject_id: string; evidence_level: "VERIFIED" }
  created_at: number
}

export interface ApplicationApiCredential {
  credential_id: string
  application_id: string
  application_subject_id: string
  resource_id: string
  capability_id: string
  generation: number
  kind: "API_KEY" | "MTLS" | "JWT" | "MTLS_AND_JWT" | "OAUTH2"
  oauth_client_id?: string | null
  oauth_issuer?: string | null
  oauth_audience?: string | null
  oauth_scope?: string | null
  state: "PROVISIONING" | "ACTIVE" | "RETIRED" | "REVOKED"
  created_at: number
  activated_at: number | null
  valid_until: number | null
  revoked_at: number | null
}

export interface ApplicationApiCredentialCreation {
  credential: ApplicationApiCredential
  api_key: string | null
  oauth_client_secret?: string | null
  oauth_token_endpoint?: string | null
  credential_delivery: "ONE_TIME" | "CLIENT_MANAGED"
}

export interface FederationTrustRevision {
  tenant_id: string
  trust_id: string
  revision: number
  application_id: string
  application_subject_id: string
  display_name: string
  issuer: string
  jwks_uri: string
  audiences: string[]
  algorithms: Array<"RS256" | "ES256" | "EdDSA">
  external_subject_id: string
  required_claims: Array<{ name: string; value: string }>
  max_assertion_ttl_seconds: number
  state: "ACTIVE" | "REVOKED"
  created_by_subject_id: string
  created_at: number
}

export interface FederationExchangeEvent {
  tenant_id: string
  exchange_id: string
  correlation_id: string
  trust_id: string
  trust_revision: number
  external_issuer: string
  external_subject_id: string | null
  application_id: string
  application_subject_id: string
  credential_id: string | null
  credential_generation: number | null
  resource_id: string
  capability_id: string
  audience: string
  scope: string
  outcome: "ISSUED" | "REJECTED"
  rejection_reason: string | null
  upstream_attempted: false
  occurred_at: number
}

export type ProviderCredentialStrategy =
  | { kind: "STATIC_SECRET_REFERENCE"; secret_ref: string }
  | {
      kind: "RUNTIME_IDENTITY"
      adapter: "GCP_APPLICATION_DEFAULT"
      parameters: { project_name: string; region: string }
    }
  | {
      kind: "OIDC_FEDERATION"
      source: {
        issuer: string
        client_id: string
        client_secret_ref: string
        audience?: string
      }
      exchange: {
        adapter: "GCP_STS"
        project_name: string
        region: string
        project_id: string
        workload_identity_pool_name: string
        workload_identity_provider_name: string
        service_account_name?: string
      }
    }

export type ProviderType =
  | "GENERIC_OPENAI_COMPATIBLE"
  | "OPENAI"
  | "OMLX"
  | "OLLAMA"
  | "GCP_VERTEX_AI"
  | "ANTHROPIC"

export interface ProviderProfile {
  tenant_id: string
  profile_id: string
  display_name: string
  provider_type: ProviderType
  protocol: "OPENAI_COMPATIBLE" | "OLLAMA_NATIVE" | "GCP_VERTEX_AI" | "ANTHROPIC"
  capabilities: Array<"CHAT" | "STREAMING" | "TOOL_CALLING" | "VISION" | "REASONING" | "EMBEDDINGS">
  model_discovery: "STATIC" | "PROVIDER_API" | "MANUAL"
  endpoint_required: boolean
  credential_required: boolean
  built_in: boolean
}

export interface ProviderCredentialProfileRevision {
  credential_configured?: boolean
  tenant_id: string
  profile_id: string
  revision: number
  owner_organization_id: string
  display_name: string
  adapter_family: "GENERIC" | "GCP"
  strategy: ProviderCredentialStrategy
  strategy_digest: string
  state: "ACTIVE" | "REVOKED"
  created_by_subject_id: string
  created_at: number
}

export interface RegisterApplicationInput {
  displayName: string
  ownerOrganizationId: string
}

export type RuntimeKind = "ENDPOINT" | "GATEWAY"
export type RuntimeHealth = "READY" | "DEGRADED"

export interface RuntimeComponentObservation {
  component: "IDENTITY" | "AI_MCP_GATEWAY" | "API_MANAGEMENT" | "SECURE_ACCESS" | "AI_SAAS_EGRESS" | "AI_GATEWAY" | "AUTHORIZER" | "PROCESSOR"
  applied_config_revision: string | null
  applied_enforcement_bundle_revision?: string | null
  health: RuntimeHealth
  detail: string | null
}

export interface RuntimeObservedState {
  command_id: string
  runtime_id: string
  runtime_kind: RuntimeKind
  runtime_version: string
  applied_state_revision: string
  applied_policy_version?: string | null
  health: RuntimeHealth
  components: RuntimeComponentObservation[]
}

export interface RuntimeInventoryEntry {
  runtime_id: string
  runtime_kind: RuntimeKind
  gateway_id: string
  release_eligible: boolean
  connected: boolean
  pending_command_count: number
  desired_state_revision: string | null
  desired_policy_version: string | null
  last_successful_state_revision: string | null
  observed_state: RuntimeObservedState | null
  last_reported_at: number | null
  operator_state: "READY" | "DEGRADED" | "AWAITING_REPORT" | "OFFLINE" | "OUT_OF_SYNC"
  in_sync: boolean
  health_timed_out: boolean
  health_timeout_seconds: number
  last_error: string | null
  remediation_hint: string | null
  operator_alert_code: "RUNTIME_HEALTH_TIMEOUT" | "RUNTIME_DISCONNECTED" | "RUNTIME_CONFIGURATION_OUT_OF_SYNC" | "RUNTIME_DEGRADED" | null
}

export interface GatewayRegistration {
  tenant_id: string
  runtime_id: string
  display_name: string
  gateway_id: string
  site_id: string
  region: string
  labels: Record<string, string>
  identity_client_id: string
  state: "PROVISIONING" | "ACTIVE" | "RETIRED"
  registered_by: string
  registered_at: number
  activated_at: number | null
  retired_at: number | null
  row_revision: number
}

export interface GatewayBootstrapConfiguration {
  schema_version: "genio.one.gateway-bootstrap.v1"
  registration: GatewayRegistration
  platform_origin: string
  tenant_id: string
  runtime_id: string
  gateway_id: string
  oidc: {
    issuer: string
    token_endpoint: string
    audience: string
    scope: string
    client_id: string
    client_secret: string
  }
  report_signing: {
    key_id: string
    private_key_pem: string
  }
  runtime_command_verification_keys: {
    schema_version: 1
    keys: Array<{ key_id: string; public_key_pem: string }>
  }
  policy_release_root_keys: {
    schema_version: 1
    keys: Array<{ key_id: string; public_key_pem: string }>
  }
  credential_delivery: "ONE_TIME"
}

export interface GatewayFleetAvailability {
  tenant_id: string
  operator_state: "READY" | "DEGRADED" | "DOWN" | "NO_GATEWAYS"
  traffic_available: boolean
  sites: Array<{
    gateway_id: string
    site_id: string
    region: string
    operator_state: "READY" | "DEGRADED" | "DOWN"
    traffic_available: boolean
    registered_instance_count: number
    traffic_eligible_instance_count: number
    traffic_candidates: string[]
    instances: Array<{
      runtime_id: string
      operator_state: "READY" | "DEGRADED" | "AWAITING_REPORT" | "OFFLINE" | "OUT_OF_SYNC"
      traffic_eligible: boolean
      alert_code: string | null
    }>
  }>
}

export interface GatewayDiagnosticSettings {
  tenant_id: string
  gateway_id: string
  capture_message_content: boolean
  row_revision: number
  updated_at: number
}

export interface RegisterGatewayInput {
  runtimeId?: string
  displayName: string
  siteId: string
  region: string
  labels: Record<string, string>
}

export interface OverviewSnapshot {
  resources: ResourceRegistration[]
  apiEnvironmentDeployments: ApiEnvironmentDeployment[]
  connections: ConnectionSummary[]
  activity: EndpointActivityInventory
  apiActivity: ApiGatewayActivityInventory
  aiUsage: AiUsageDashboard | null
  gatewayMetrics: GatewayMetricsSummary | null
  auditEvents: AuditEvent[]
  endpointSecurityEvents: DecisionAuditEvent[]
  siemDestination: SiemDestination | null
  siemDeliveries: SiemDelivery[]
  accessRequests: AccessRequest[]
  ownedEntitlements: Entitlement[]
  accessNotifications: AccessNotification[]
  apiVersionMigrationNotices: ApiVersionMigrationNotice[]
  resourceOnboardingRequests: ResourceOnboardingRequest[]
  identity: TenantIdentityInventory | null
  agentDelegations: AgentDelegation[]
  executionGrantRequests: ExecutionGrantRequest[]
  agentExtensions: AgentExtensionVersion[]
  accessGroups: LocalAccessGroupInventory
  organizations: Organization[]
  applications: ApplicationRegistration[]
  runtimes: RuntimeInventoryEntry[]
  gatewayRegistrations: GatewayRegistration[]
  gatewayFleet: GatewayFleetAvailability | null
  platformHealthy: boolean
  failures: OverviewFailure[]
}

export interface RegisteredEndpointDevice {
  tenant_id: string
  device_id: string
  subject_id: string
  lifecycle_state: "ACTIVE" | "REVOKED"
  enrolled_at: number
  last_seen_at: number
  observed_state: {
    endpoint_version: string
    applied_state_revision: string | null
    applied_policy_version: string | null
    health: "UNKNOWN" | "HEALTHY" | "DEGRADED"
    reported_at: number
  }
  revocation_reason: string | null
}

export interface OverviewFailure {
  source: string
  code: string
  status?: number
}

export interface CreateResourceInput {
  displayName: string
  kind: ResourceKind
  capabilityId: string
  capabilityName: string
  environmentId: string
  version: string
  authenticationStrategy: "NONE" | "EMA" | "OAUTH" | "API_KEY" | "MTLS"
  enforcementPointId: string
  ownerOrganizationId: string
  capabilities?: ResourceRegistration["capabilities"]
  api?: ResourceRegistration["api"]
  mcpAuthorization?: {
    resource: string
    authorizationServers: string
    scopesSupported: string
    requiredIssuer: string
  }
  extensionMetadata?: BotPackageManifest
}

export interface ImportOpenApiResourceInput {
  resourceId: string
  authenticationStrategy: "NONE" | "EMA" | "OAUTH" | "API_KEY" | "MTLS"
  environmentId: string
  version: string
  apiProductId: string
  publicPath: string
  inboundSecurity: "KEYLESS" | "API_KEY" | "OAUTH2"
  oauthIssuer?: string
  oauthAudience?: string
  oauthJwksUrl?: string
  oauthScope?: string
  requestSchemaValidation: boolean
  enforcementPointId: string
  ownerOrganizationId: string
  document: Record<string, unknown>
  a2a?: {
    protocol_version: "1.0"
    operation: "SEND_MESSAGE" | "SEND_STREAMING_MESSAGE"
    target_agent_subject_id: string
  }
}

export interface RegisterConnectionInput {
  connectorConfiguration?: ConnectorConfiguration
  displayName: string
  kind: ConnectionKind
  endpointUrl: string
  mcpToolNamespace?: string
  credentialReference?: string
  upstreamAuthentication?: "NONE" | "API_KEY" | "PROVIDER_CREDENTIAL_PROFILE" | "USER_PASSTHROUGH" | "USER_OAUTH"
  providerCredentialProfile?: {
    profile_id: string
    revision: number
  }
  region?: string
  userCredentialHeader?: string
  requestMapping?: ApiUpstreamRequestMapping
  llm?: LlmConnectionConfiguration
  providerProfileId?: string
  resiliency: UpstreamResiliencyPolicy
  certificateMode?: ConnectionCertificateMode
  certificatePem?: string | null
  resourceId: string
  enforcementPointId: string
}
