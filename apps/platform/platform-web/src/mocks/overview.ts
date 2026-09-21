import type {
  ApiGatewayActivityEvent,
  ApiGatewayTransactionDetail,
  AuditEvent,
  ConnectionSummary,
  EndpointActivityEvent,
  GatewayRegistration,
  Entitlement,
  OverviewSnapshot,
  ResourceKind,
  ResourceRegistration,
  RuntimeInventoryEntry,
} from "@/domain/contracts"
import { createMockGatewayMetrics } from "@/mocks/observability"
import { applyMockOrganizationOverrides } from "@/mocks/organization-store"

const tenantId = "tenant-design-preview"
const now = Math.floor(Date.now() / 1_000)
const day = 86_400

type MockResourceDefinition = {
  id: string
  name: string
  kind: ResourceKind
  lifecycle: ResourceRegistration["lifecycle"]
  operationalState: ResourceRegistration["operational_state"]
  authenticationStrategy: ResourceRegistration["authentication_strategy"]
  capabilities: string[]
  enforcementPointId: string
  publicationEndpoint?: ResourceRegistration["publication_endpoint"]
  publicationRequest?: ResourceRegistration["publication_request"]
}

const resourceDefinitions: MockResourceDefinition[] = [
  {
    id: "corporate-gpt",
    name: "Corporate GPT",
    kind: "LLM",
    lifecycle: "PUBLISHED",
    operationalState: "HEALTHY",
    authenticationStrategy: "API_KEY",
    capabilities: ["Chat", "Embeddings"],
    enforcementPointId: "ai-gateway",
    publicationEndpoint: {
      gateway_id: "ai-gateway",
      visibility: "REQUEST",
      hostname: "ai.tenant-design-preview.example.com",
      base_path: "/v1",
      dns_management: "EXTERNAL",
      dns_verification: "VERIFIED",
      dns_target: "ai-gateway.edge.genioone.example",
    },
  },
  {
    id: "research-models",
    name: "Research Models",
    kind: "LLM",
    lifecycle: "DRAFT",
    operationalState: "UNKNOWN",
    authenticationStrategy: "API_KEY",
    capabilities: ["Chat"],
    enforcementPointId: "ai-gateway",
    publicationEndpoint: {
      gateway_id: "ai-gateway",
      visibility: "PRIVATE",
      hostname: "research-ai.tenant-design-preview.example.com",
      base_path: "/v1",
      dns_management: "EXTERNAL",
      dns_verification: "PENDING",
      dns_target: "ai-gateway.edge.genioone.example",
    },
  },
  {
    id: "engineering-mcp",
    name: "Engineering MCP",
    kind: "MCP",
    lifecycle: "PUBLISHED",
    operationalState: "HEALTHY",
    authenticationStrategy: "OAUTH",
    capabilities: ["Search code", "Read repository", "Create pull request", "Review changes"],
    enforcementPointId: "ai-gateway",
    publicationEndpoint: {
      gateway_id: "ai-gateway",
      visibility: "REQUEST",
      hostname: "mcp.tenant-design-preview.example.com",
      base_path: "/engineering",
      dns_management: "PLATFORM_MANAGED",
      dns_verification: "VERIFIED",
    },
  },
  {
    id: "finance-mcp",
    name: "Finance MCP",
    kind: "MCP",
    lifecycle: "RETIRED",
    operationalState: "UNAVAILABLE",
    authenticationStrategy: "OAUTH",
    capabilities: ["Read ledger", "Export report"],
    enforcementPointId: "ai-gateway",
    publicationEndpoint: {
      gateway_id: "ai-gateway",
      visibility: "PRIVATE",
      hostname: "mcp.tenant-design-preview.example.com",
      base_path: "/finance",
      dns_management: "PLATFORM_MANAGED",
      dns_verification: "VERIFIED",
    },
  },
  {
    id: "orders-api",
    name: "Orders API",
    kind: "API",
    lifecycle: "DRAFT",
    operationalState: "HEALTHY",
    authenticationStrategy: "OAUTH",
    capabilities: ["List orders", "Create order", "Cancel order"],
    enforcementPointId: "api-gateway",
    publicationEndpoint: {
      gateway_id: "api-gateway",
      visibility: "PRIVATE",
      hostname: "api.tenant-design-preview.example.com",
      base_path: "/orders/v1",
      dns_management: "EXTERNAL",
      dns_verification: "VERIFIED",
      dns_target: "api-gateway.edge.genioone.example",
    },
    publicationRequest: {
      request_id: "publication-request-orders-api",
      state: "PENDING",
      requested_by: "api-owner",
      requested_at: now - 3_600,
    },
  },
  {
    id: "customer-api",
    name: "Customer API",
    kind: "API",
    lifecycle: "PUBLISHED",
    operationalState: "DEGRADED",
    authenticationStrategy: "MTLS",
    capabilities: ["Read customer", "Update customer", "Export profile"],
    enforcementPointId: "api-gateway",
    publicationEndpoint: {
      gateway_id: "api-gateway",
      visibility: "REQUEST",
      hostname: "api.tenant-design-preview.example.com",
      base_path: "/customers/v1",
      dns_management: "EXTERNAL",
      dns_verification: "VERIFIED",
      dns_target: "api-gateway.edge.genioone.example",
    },
  },
  {
    id: "legacy-billing-api",
    name: "Legacy Billing API",
    kind: "API",
    lifecycle: "DEPRECATED",
    operationalState: "HEALTHY",
    authenticationStrategy: "API_KEY",
    capabilities: ["Read invoice", "Issue invoice"],
    enforcementPointId: "api-gateway",
    publicationEndpoint: {
      gateway_id: "api-gateway",
      visibility: "PUBLIC",
      hostname: "api.tenant-design-preview.example.com",
      base_path: "/billing/v1",
      dns_management: "EXTERNAL",
      dns_verification: "VERIFIED",
      dns_target: "api-gateway.edge.genioone.example",
    },
  },
  {
    id: "openai-web",
    name: "OpenAI Web",
    kind: "SAAS",
    lifecycle: "PUBLISHED",
    operationalState: "HEALTHY",
    authenticationStrategy: "OAUTH",
    capabilities: ["Access site"],
    enforcementPointId: "access-gateway",
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    kind: "SAAS",
    lifecycle: "PUBLISHED",
    operationalState: "DEGRADED",
    authenticationStrategy: "OAUTH",
    capabilities: ["Access site"],
    enforcementPointId: "access-gateway",
  },
  {
    id: "shadow-ai-domain",
    name: "Shadow AI Domain",
    kind: "SAAS",
    lifecycle: "DRAFT",
    operationalState: "UNKNOWN",
    authenticationStrategy: "NONE",
    capabilities: ["Access site"],
    enforcementPointId: "access-gateway",
  },
  {
    id: "code-review-skill",
    name: "Code Review Skill",
    kind: "EXTENSION",
    lifecycle: "PUBLISHED",
    operationalState: "HEALTHY",
    authenticationStrategy: "NONE",
    capabilities: ["Run skill"],
    enforcementPointId: "ai-gateway",
  },
  {
    id: "document-plugin",
    name: "Document Plugin",
    kind: "EXTENSION",
    lifecycle: "DRAFT",
    operationalState: "UNKNOWN",
    authenticationStrategy: "NONE",
    capabilities: ["Read document", "Transform document"],
    enforcementPointId: "ai-gateway",
  },
]

function capabilityId(resourceId: string, capabilityName: string) {
  return `${resourceId}.${capabilityName.toLowerCase().replaceAll(" ", "-")}`
}

function resources(): ResourceRegistration[] {
  return resourceDefinitions.map((definition, index) => {
    const capabilities = definition.capabilities.map((displayName) => ({
      capability_id: capabilityId(definition.id, displayName),
      display_name: displayName,
    }))
    return {
      tenant_id: tenantId,
      resource_id: definition.id,
      display_name: definition.name,
      kind: definition.kind,
      owner_organization_id: definition.kind === "API"
        ? "api-platform"
        : definition.kind === "SAAS"
          ? "secure-access"
          : "ai-platform",
      authentication_strategy: definition.authenticationStrategy,
      environment_id: "production",
      version: "1.0",
      lifecycle: definition.lifecycle,
      publication_endpoint: definition.publicationEndpoint,
      publication_request: definition.publicationRequest,
      operational_state: definition.operationalState,
      health_observed_at: definition.operationalState === "UNKNOWN" ? undefined : now - (index + 1) * 90,
      capabilities,
      api: definition.kind === "API" ? {
        api_product_id: `${definition.id}-product`,
        openapi_version: "3.0.3",
        document_title: definition.name,
        document_version: "1.0",
        public_path: `/api/${definition.id.replace("-api", "")}`,
        inbound_security: definition.authenticationStrategy === "API_KEY"
          ? { type: "API_KEY", header_name: "x-api-key" }
          : definition.authenticationStrategy === "MTLS"
            ? { type: "MTLS", trusted_client_ca_pem: "mock-ca-reference" }
            : {
                type: "OAUTH2",
                issuer: "https://identity.example.internal",
                audience: definition.id,
                jwks_url: "https://identity.example.internal/.well-known/jwks.json",
                scope: "genioone-invocation",
              },
        request_schema_validation: definition.id !== "legacy-billing-api",
        operations: capabilities.map((capability, operationIndex) => ({
          operation_id: capability.capability_id,
          method: operationIndex === 0 ? "GET" : "POST",
          path: operationIndex === 0 ? "/" : `/${operationIndex}`,
        })),
      } : null,
      enforcement_point_id: definition.enforcementPointId,
      created_at: now - (60 + index) * day,
    }
  })
}

function connections(allResources: ResourceRegistration[]): ConnectionSummary[] {
  const connectionDefinitions = [
    ["corporate-gpt", "Primary", "ENABLED"],
    ["corporate-gpt", "Failover", "ENABLED"],
    ["engineering-mcp", "Production", "ENABLED"],
    ["engineering-mcp", "Recovery", "ENABLED"],
    ["finance-mcp", "Archive", "DISABLED"],
    ["orders-api", "Staging", "ENABLED"],
    ["customer-api", "Primary", "ENABLED"],
    ["customer-api", "Failover", "ENABLED"],
    ["legacy-billing-api", "Legacy", "DISABLED"],
    ["code-review-skill", "Package", "ENABLED"],
  ] as const

  return connectionDefinitions.map(([resourceId, label, lifecycle], index) => {
    const resource = allResources.find((candidate) => candidate.resource_id === resourceId)
    if (!resource) throw new Error(`Missing mock resource ${resourceId}`)
    return {
      connection_id: `connection-${String(index + 1).padStart(2, "0")}`,
      status: lifecycle === "ENABLED" ? "READY" : "DISABLED",
      display_name: `${resource.display_name} ${label}`,
      kind: resource.kind,
      endpoint_url: `https://${resource.resource_id}-${label.toLowerCase()}.example.internal`,
      mcp_selected_tools: [],
      mcp_tool_selection_operation_id: null,
      credential_configured: resource.authentication_strategy !== "NONE",
      downstream_identity: { mode: "NONE" },
      resource_id: resource.resource_id,
      enforcement_point_id: resource.enforcement_point_id,
      lifecycle,
      configuration_revision: 1,
      verification_state: "VERIFIED",
      health_state: lifecycle === "ENABLED" ? "HEALTHY" : "UNKNOWN",
      health_observed_at: lifecycle === "ENABLED" ? 1_700_000_000 : null,
      health_source_revision: lifecycle === "ENABLED" ? 1 : null,
      routing_priority: label === "Primary" ? 0 : 10,
      region: null,
      supported_obligations: [],
    }
  })
}

function endpointActivity(allResources: ResourceRegistration[]): EndpointActivityEvent[] {
  const counts = [7, 10, 8, 12, 9, 11, 9]
  const actingClientIds = [
    "codex-cli",
    null,
    "claude-code",
    "agent-operations",
    "codex-cli",
    null,
    "claude-code",
  ] as const
  const observedResources = [
    "openai-web",
    "github-copilot",
    "corporate-gpt",
    "engineering-mcp",
    "customer-api",
    "code-review-skill",
    "shadow-ai-domain",
  ].map((resourceId) => {
    const resource = allResources.find((candidate) => candidate.resource_id === resourceId)
    if (!resource) throw new Error(`Missing mock resource ${resourceId}`)
    return resource
  })
  return counts.map((requestCount, index) => ({
    activity_id: `endpoint-activity-${index + 1}`,
    correlation_id: `endpoint-correlation-${index + 1}`,
    kind: "USAGE",
    subject_id: `person-${(index % 4) + 1}`,
    device_id: `endpoint-${String((index % 11) + 1).padStart(2, "0")}`,
    destination_host: `${observedResources[index].resource_id}.example.internal`,
    resource_id: observedResources[index].resource_id,
    resource_class: "KNOWN",
    client: actingClientIds[index]
      ? { status: "VERIFIED", acting_client_id: actingClientIds[index] }
      : { status: "UNKNOWN" },
    client_compliance: { state: "COMPLIANT", issues: [] },
    route: index === 3 ? "BLOCK" : "MANAGED",
    request_count: requestCount,
    observed_at: now - (6 - index) * day - 3_600,
  }))
}

function apiActivity(allResources: ResourceRegistration[]): ApiGatewayActivityEvent[] {
  const apiResources = allResources.filter((resource) => resource.kind === "API")
  const outcomes: ApiGatewayActivityEvent["outcome"][] = [
    "COMPLETED",
    "COMPLETED",
    "RATE_LIMITED",
    "COMPLETED",
    "DENIED",
    "FAILED",
    "COMPLETED",
  ]
  return outcomes.map((outcome, index) => {
    const resource = apiResources[index % apiResources.length]
    const occurredAt = now - (index + 1) * 3_600
    const detailAvailability: ApiGatewayActivityEvent["detail_availability"] = index === 5 ? "EXPIRED" : index === 6 ? "NOT_CAPTURED" : "AVAILABLE"
    const detailExpiresAt = detailAvailability === "AVAILABLE" ? occurredAt + day : detailAvailability === "EXPIRED" ? occurredAt + 3_600 : null
    return {
      correlation_id: `api-correlation-${index + 1}`,
      tenant_id: tenantId,
      resource_id: resource.resource_id,
      capability_id: resource.capabilities[index % resource.capabilities.length].capability_id,
      application_id: `application-${(index % 5) + 1}`,
      subject_id: `application-subject-${(index % 5) + 1}`,
      subject_display: {
        subject_id: `application-subject-${(index % 5) + 1}`,
        display_name: `Business Application ${(index % 5) + 1}`,
        kind: "APPLICATION",
      },
      acting_client_id: `api-client-${(index % 3) + 1}`,
      entitlement_id: `entitlement-${index + 1}`,
      usage_admission_id: outcome === "RATE_LIMITED" ? null : `admission-${index + 1}`,
      usage_admission_disposition: outcome === "RATE_LIMITED" ? "REJECT" : "ADMIT",
      usage_admission_reason: outcome === "RATE_LIMITED" ? "QUOTA_EXHAUSTED" : null,
      consumer_organization_id: "ai-platform",
      resource_owner_organization_id: resource.owner_organization_id,
      use_case_id: "customer-support",
      enforcement_point_id: "api-management",
      route: "MANAGED",
      method: index % 2 ? "POST" : "GET",
      path: `/v1/orders/${index + 1}`,
      status_code: outcome === "COMPLETED" ? 200 : outcome === "RATE_LIMITED" ? 429 : outcome === "DENIED" ? 403 : 502,
      outcome,
      error_code: outcome === "COMPLETED" ? null : outcome,
      latency_millis: 68 + index * 11,
      upstream_attempted: outcome !== "DENIED" && outcome !== "RATE_LIMITED",
      requested_model_id: null,
      effective_model_id: null,
      provider_id: null,
      connection_id: null,
      downstream_identity_mode: null,
      mcp_method: null,
      mcp_tool: null,
      mcp_backend: null,
      processor_bundle_revision: null,
      processor_request_steps: [],
      processor_response_steps: [],
      data_classifications: [],
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      route_mode: null,
      route_lease_id: null,
      route_lease_reused: null,
      routing_policy_id: null,
      routing_revision: null,
      candidate_set_digest: null,
      cost_estimation_status: "NOT_APPLICABLE",
      estimated_cost_currency: null,
      estimated_cost_micros: null,
      pricing_source: null,
      pricing_version: null,
      detail_availability: detailAvailability,
      detail_ref: detailAvailability === "NOT_CAPTURED" ? null : `api-detail-${index + 1}`,
      detail_expires_at: detailExpiresAt,
      occurred_at: occurredAt,
    }
  })
}

export function mockApiGatewayTransactionDetail(event: ApiGatewayActivityEvent): ApiGatewayTransactionDetail {
  if (event.detail_availability !== "AVAILABLE") {
    return {
      correlation_id: event.correlation_id,
      availability: event.detail_availability,
      captured_at: event.detail_ref ? event.occurred_at : null,
      expires_at: event.detail_expires_at,
      redacted_fields: [],
      request: null,
      response: null,
    }
  }
  return {
    correlation_id: event.correlation_id,
    availability: "AVAILABLE",
    captured_at: event.occurred_at,
    expires_at: event.detail_expires_at,
    redacted_fields: ["request.headers.authorization", "request.body.customer_id"],
    request: {
      headers: [
        ["content-type", "application/json"],
        ["x-request-id", event.correlation_id],
        ["authorization", "[REDACTED]"],
      ],
      body: event.method === "GET" ? null : JSON.stringify({ customer_id: "cust_***", items: [{ sku: "SKU-104", quantity: 1 }] }, null, 2),
      body_truncated: false,
      content_type: "application/json",
    },
    response: {
      headers: [
        ["content-type", "application/json"],
        ["x-upstream-request-id", `upstream-${event.correlation_id}`],
      ],
      body: JSON.stringify(event.outcome === "COMPLETED" ? { order_id: "ord_8102", status: "accepted" } : { error: event.error_code }, null, 2),
      body_truncated: false,
      content_type: "application/json",
    },
  }
}

function auditEvents(allResources: ResourceRegistration[]): AuditEvent[] {
  const invocations = allResources.filter((resource) => resource.kind !== "API").slice(0, 7)
  const outcomes = ["COMPLETED", "COMPLETED", "DENIED", "COMPLETED", "FAILED", "COMPLETED", "COMPLETED"]
  const invocationEvents = invocations.map((resource, index): AuditEvent => ({
    audit_event_id: `audit-${index + 1}`,
    correlation_id: `audit-correlation-${index + 1}`,
    kind: "INVOCATION_OUTCOME",
    outcome: outcomes[index],
    tenant_id: tenantId,
    subject: { subject_id: `person-${(index % 4) + 1}`, evidence_level: "VERIFIED" },
    target_subject_id: null,
    actor_subject: null,
    acting_client: { acting_client_id: `client-${(index % 4) + 1}`, evidence_level: "VERIFIED" },
    resource_id: resource.resource_id,
    capability_id: resource.capabilities[index % resource.capabilities.length].capability_id,
    device_id: `endpoint-${String((index % 11) + 1).padStart(2, "0")}`,
    endpoint_version: "1.4.0",
    desired_state_revision: "config-42",
    applied_state_revision: "config-42",
    applied_policy_version: "policy-7",
    policy_proposal_id: null,
    proposed_policy_version: null,
    access_group_id: null,
    destination_host: `${resource.resource_id}.example.internal`,
    routing_policy_rule_id: "managed-default",
    route: outcomes[index] === "DENIED" ? "BLOCK" : "MANAGED",
    missing_deployment_capability: null,
    decision: null,
    access_request_id: null,
    entitlement_id: `entitlement-audit-${index + 1}`,
    enforcement_point_id: "genio-gateway",
    obligation_kind: null,
    runaway_trigger: null,
    upstream_attempted: outcomes[index] !== "DENIED",
    occurred_at: now - (6 - index) * day - 10_800,
  }))
  const apiEvents = apiActivity(allResources).map((activity, index): AuditEvent => ({
    audit_event_id: `api-authorization-${index + 1}`,
    correlation_id: activity.correlation_id,
    kind: "ONE_POLICY_DECISION",
    outcome: "ALLOW",
    tenant_id: tenantId,
    subject: { subject_id: activity.subject_id ?? "unknown", evidence_level: "VERIFIED" },
    target_subject_id: null,
    actor_subject: null,
    acting_client: { acting_client_id: activity.acting_client_id, evidence_level: "VERIFIED" },
    resource_id: activity.resource_id,
    capability_id: activity.capability_id,
    device_id: null,
    endpoint_version: null,
    desired_state_revision: null,
    applied_state_revision: null,
    applied_policy_version: "policy-7",
    policy_proposal_id: null,
    proposed_policy_version: null,
    access_group_id: null,
    destination_host: null,
    routing_policy_rule_id: "api-entitlement",
    route: "MANAGED",
    missing_deployment_capability: null,
    decision: {
      decision_id: `api-decision-${index + 1}`,
      correlation_id: activity.correlation_id,
      policy_version: "policy-7",
      winning_rule_id: "api-entitlement",
      reason: "ALLOWED_BY_RULE",
      visibility: "VISIBLE",
      access: "ENTITLED",
      route: "MANAGED",
      obligations: [],
      entitlement_conditions: { required_verified_acting_client_id: activity.acting_client_id, requires_device: false },
      entitlement_id: activity.entitlement_id,
      auto_grant_valid_for: null,
      input_receipt: {},
    },
    access_request_id: null,
    entitlement_id: activity.entitlement_id,
    enforcement_point_id: "API_GATEWAY",
    obligation_kind: null,
    runaway_trigger: null,
    upstream_attempted: false,
    occurred_at: activity.occurred_at - 1,
  }))
  return [...invocationEvents, ...apiEvents]
}

function entitlements(allResources: ResourceRegistration[]): Entitlement[] {
  const definitions = [
    ["corporate-gpt", "person-1", "ACTIVE"],
    ["corporate-gpt", "person-2", "ACTIVE"],
    ["engineering-mcp", "agent-operations", "ACTIVE"],
    ["engineering-mcp", "person-3", "EXPIRED"],
    ["customer-api", "application-subject-1", "ACTIVE"],
    ["openai-web", "person-4", "ACTIVE"],
    ["github-copilot", "person-2", "REVOKED"],
    ["code-review-skill", "agent-security", "ACTIVE"],
  ] as const

  return definitions.map(([resourceId, subjectId, state], index) => {
    const resource = allResources.find((candidate) => candidate.resource_id === resourceId)
    if (!resource) throw new Error(`Missing mock resource ${resourceId}`)
    return {
      entitlement_id: `entitlement-${String(index + 1).padStart(2, "0")}`,
      subject_id: subjectId,
      resource_id: resourceId,
      capability_id: resource.capabilities[0].capability_id,
      state,
      valid_from: now - (30 + index) * day,
      valid_until: state === "EXPIRED" ? now - day : now + (60 - index) * day,
      revocation_reason: state === "REVOKED" ? "Access no longer required" : null,
    }
  })
}

function runtime(runtimeId: string, runtimeKind: "ENDPOINT" | "GATEWAY", operatorState: RuntimeInventoryEntry["operator_state"]): RuntimeInventoryEntry {
  const ready = operatorState === "READY"
  return {
    runtime_id: runtimeId,
    runtime_kind: runtimeKind,
    gateway_id: runtimeKind === "GATEWAY" ? "genio-ai-mcp-gateway" : "endpoint",
    release_eligible: runtimeKind === "GATEWAY",
    connected: operatorState !== "OFFLINE",
    pending_command_count: 0,
    desired_state_revision: "config-42",
    desired_policy_version: "policy-7",
    last_successful_state_revision: ready ? "config-42" : "config-41",
    observed_state: runtimeKind === "GATEWAY" ? {
      command_id: `report-${runtimeId}`,
      runtime_id: runtimeId,
      runtime_kind: runtimeKind,
      runtime_version: "1.4.0",
      applied_state_revision: ready ? "config-42" : "config-41",
      applied_policy_version: "policy-7",
      health: ready ? "READY" : "DEGRADED",
      components: ["IDENTITY", "AI_MCP_GATEWAY", "API_MANAGEMENT", "SECURE_ACCESS", "AI_SAAS_EGRESS"].map((component) => ({
        component: component as "IDENTITY" | "AI_MCP_GATEWAY" | "API_MANAGEMENT" | "SECURE_ACCESS" | "AI_SAAS_EGRESS",
        applied_config_revision: ready ? "config-42" : "config-41",
        health: ready ? "READY" : "DEGRADED",
        detail: null,
      })),
    } : null,
    last_reported_at: operatorState === "OFFLINE" ? now - 7_200 : now - 45,
    operator_state: operatorState,
    in_sync: ready,
    health_timed_out: operatorState === "OFFLINE",
    health_timeout_seconds: 300,
    last_error: operatorState === "DEGRADED" ? "Runtime component reported degraded health" : null,
    remediation_hint: operatorState === "OFFLINE" ? "RECONNECT_RUNTIME" : operatorState === "DEGRADED" ? "INSPECT_DEGRADED_COMPONENTS" : null,
    operator_alert_code: operatorState === "OFFLINE" ? "RUNTIME_DISCONNECTED" : ready ? null : "RUNTIME_DEGRADED",
  }
}

function gatewayRegistrations(): GatewayRegistration[] {
  return ["Taipei Core", "Singapore Edge", "Tokyo Recovery"].map((displayName, index) => ({
    tenant_id: tenantId,
    runtime_id: `gateway-${index + 1}`,
    display_name: displayName,
    gateway_id: "genio-ai-mcp-gateway",
    site_id: index === 0 ? "taipei" : index === 1 ? "singapore" : "tokyo",
    region: index === 0 ? "ap-east-1" : index === 1 ? "ap-southeast-1" : "ap-northeast-1",
    labels: { boundary: index === 0 ? "core" : "edge" },
    identity_client_id: `gateway-client-${index + 1}`,
    state: "ACTIVE",
    registered_by: "platform-admin",
    registered_at: now - (30 + index) * day,
    activated_at: now - (29 + index) * day,
    retired_at: null,
    row_revision: 1,
  }))
}

export function createMockOverview(): OverviewSnapshot {
  const allResources = resources()
  const endpointEvents = endpointActivity(allResources)
  const gateways = gatewayRegistrations()
  const gatewayRuntimes = gateways.map((gateway) => runtime(gateway.runtime_id, "GATEWAY", "READY"))
  const endpointRuntimes = Array.from({ length: 22 }, (_, index) => runtime(
    `endpoint-${String(index + 1).padStart(2, "0")}`,
    "ENDPOINT",
    index >= 20 ? "OFFLINE" : "READY",
  ))

  return {
    resources: allResources,
    apiEnvironmentDeployments: [],
    connections: connections(allResources),
    activity: { resources: [], recent_activity: endpointEvents },
    apiActivity: { events: apiActivity(allResources) },
    aiUsage: null,
    gatewayMetrics: createMockGatewayMetrics(tenantId),
    auditEvents: auditEvents(allResources),
    endpointSecurityEvents: [],
    siemDestination: null,
    siemDeliveries: [],
    accessRequests: [],
    ownedEntitlements: entitlements(allResources),
    accessNotifications: [],
    apiVersionMigrationNotices: [],
    resourceOnboardingRequests: [],
    identity: {
      tenant_id: tenantId,
      subjects: [
        { subject_id: "platform-admin", kind: "PERSON", profile: { display_name: "Platform Admin", email: "admin@example.internal", department: "Platform" }, suspended: false, suspended_at: null, suspended_by: null, suspension_reason: null },
        { subject_id: "ai-owner", kind: "PERSON", profile: { display_name: "AI Platform Owner", email: "ai-owner@example.internal", department: "AI Platform" }, suspended: false, suspended_at: null, suspended_by: null, suspension_reason: null },
        { subject_id: "ai-user", kind: "PERSON", profile: { display_name: "AI Analyst", email: "ai-analyst@example.internal", department: "AI Platform" }, suspended: false, suspended_at: null, suspended_by: null, suspension_reason: null },
        { subject_id: "api-owner", kind: "PERSON", profile: { display_name: "API Platform Owner", email: "api-owner@example.internal", department: "API Platform" }, suspended: false, suspended_at: null, suspended_by: null, suspension_reason: null },
        { subject_id: "api-user", kind: "PERSON", profile: { display_name: "API Developer", email: "api-developer@example.internal", department: "API Platform" }, suspended: false, suspended_at: null, suspended_by: null, suspension_reason: null },
        { subject_id: "access-owner", kind: "PERSON", profile: { display_name: "Secure Access Owner", email: "access-owner@example.internal", department: "Security" }, suspended: false, suspended_at: null, suspended_by: null, suspension_reason: null },
        { subject_id: "access-user", kind: "PERSON", profile: { display_name: "Security Analyst", email: "security-analyst@example.internal", department: "Security" }, suspended: false, suspended_at: null, suspended_by: null, suspension_reason: null },
        { subject_id: "agent-operations", kind: "AGENT", profile: { display_name: "Operations Agent", email: null, department: "Platform" }, suspended: false, suspended_at: null, suspended_by: null, suspension_reason: null },
        { subject_id: "agent-security", kind: "AGENT", profile: { display_name: "Security Agent", email: null, department: "Security" }, suspended: false, suspended_at: null, suspended_by: null, suspension_reason: null },
      ],
      external_identity_bindings: [],
      tenant_administrators: ["platform-admin"],
    },
    agentDelegations: [],
    executionGrantRequests: [],
    agentExtensions: [],
    accessGroups: {
      tenant_id: tenantId,
      groups: [
        { tenant_id: tenantId, access_group_id: "access-group-ai-platform", display_name: "AI Platform", description: "People with AI Platform access.", enabled: true, revision: 1, membership_sources: [{ source_id: "manual", kind: "MANUAL" as const, revision: 1, subject_ids: ["ai-owner", "ai-user"], created_at: now - 120 * day, created_by: "platform-admin", updated_at: now - day, updated_by: "platform-admin" }], created_at: now - 120 * day, created_by: "platform-admin", updated_at: now - day, updated_by: "platform-admin" },
        { tenant_id: tenantId, access_group_id: "access-group-api-platform", display_name: "API Platform", description: "API owners and application operators.", enabled: true, revision: 1, membership_sources: [{ source_id: "manual", kind: "MANUAL" as const, revision: 1, subject_ids: ["api-owner", "api-user"], created_at: now - 110 * day, created_by: "platform-admin", updated_at: now - day, updated_by: "platform-admin" }], created_at: now - 110 * day, created_by: "platform-admin", updated_at: now - day, updated_by: "platform-admin" },
        { tenant_id: tenantId, access_group_id: "access-group-security", display_name: "Security Operations", description: "Security analysts using governed SaaS access.", enabled: true, revision: 1, membership_sources: [{ source_id: "manual", kind: "MANUAL" as const, revision: 1, subject_ids: ["access-owner", "access-user"], created_at: now - 100 * day, created_by: "platform-admin", updated_at: now - day, updated_by: "platform-admin" }], created_at: now - 100 * day, created_by: "platform-admin", updated_at: now - day, updated_by: "platform-admin" },
        { tenant_id: tenantId, access_group_id: "access-group-automation", display_name: "Automation Agents", description: "Registered agents with bounded engineering authority.", enabled: true, revision: 1, membership_sources: [{ source_id: "manual", kind: "MANUAL" as const, revision: 1, subject_ids: ["agent-operations", "agent-security"], created_at: now - 90 * day, created_by: "platform-admin", updated_at: now - day, updated_by: "platform-admin" }], created_at: now - 90 * day, created_by: "platform-admin", updated_at: now - day, updated_by: "platform-admin" },
      ],
      memberships: [
        ["access-group-ai-platform", "ai-owner", "engineering/ai-platform"],
        ["access-group-ai-platform", "ai-user", "engineering/ai-platform"],
        ["access-group-api-platform", "api-owner", "/platform/api"],
        ["access-group-api-platform", "api-user", "/platform/api"],
        ["access-group-security", "access-owner", "/security/operations"],
        ["access-group-security", "access-user", "/security/operations"],
        ["access-group-automation", "agent-operations", "registered-agents"],
        ["access-group-automation", "agent-security", "registered-agents"],
      ].map(([accessGroupId, subjectId], index) => ({
        tenant_id: tenantId,
        access_group_id: accessGroupId,
        subject_id: subjectId,
        source: "MANUAL" as const,
        source_reference: "manual",
        source_revision: 1,
        assigned_by: { subject_id: "platform-admin", evidence_level: "VERIFIED" as const },
        assigned_at: now - (20 - index) * day,
      })),
    },
    organizations: applyMockOrganizationOverrides([
      {
        tenant_id: tenantId,
        organization_id: "ai-platform",
        display_name: "AI Platform",
        slug: "ai-platform",
        member_subject_ids: ["ai-owner", "ai-user", "platform-admin"],
        organization_administrator_subject_ids: ["ai-owner"],
        membership_sources: [{ kind: "SCIM_GROUP", reference: "engineering/ai-platform", status: "SYNCED" }],
        created_at: now - 120 * day,
      },
      {
        tenant_id: tenantId,
        organization_id: "api-platform",
        display_name: "API Platform",
        slug: "api-platform",
        member_subject_ids: ["api-owner", "api-user", "platform-admin"],
        organization_administrator_subject_ids: ["api-owner"],
        membership_sources: [{ kind: "OIDC_GROUP", reference: "/platform/api", status: "SYNCED" }],
        created_at: now - 110 * day,
      },
      {
        tenant_id: tenantId,
        organization_id: "secure-access",
        display_name: "Secure Access",
        slug: "secure-access",
        member_subject_ids: ["access-owner", "access-user", "platform-admin"],
        organization_administrator_subject_ids: ["access-owner"],
        membership_sources: [{ kind: "MANUAL", reference: "console", status: "SYNCED" }],
        created_at: now - 100 * day,
      },
    ]),
    applications: Array.from({ length: 5 }, (_, index) => ({
      tenant_id: tenantId,
      application_id: `application-${index + 1}`,
      subject_id: `application-subject-${index + 1}`,
      display_name: `Business Application ${index + 1}`,
      owner_organization_id: "platform-organization",
      registered_by: { subject_id: "platform-admin", evidence_level: "VERIFIED" },
      created_at: now - (20 + index) * day,
    })),
    runtimes: [...gatewayRuntimes, ...endpointRuntimes],
    gatewayRegistrations: gateways,
    gatewayFleet: {
      tenant_id: tenantId,
      operator_state: "READY",
      traffic_available: true,
      sites: gateways.map((gateway) => ({
        gateway_id: gateway.gateway_id,
        site_id: gateway.site_id,
        region: gateway.region,
        operator_state: "READY",
        traffic_available: true,
        registered_instance_count: 1,
        traffic_eligible_instance_count: 1,
        traffic_candidates: [gateway.runtime_id],
        instances: [{ runtime_id: gateway.runtime_id, operator_state: "READY", traffic_eligible: true, alert_code: null }],
      })),
    },
    platformHealthy: true,
    failures: [],
  }
}
