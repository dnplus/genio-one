import type { ConnectorConfiguration, ConnectorKind, DemoProjectStatus, IdentitySession } from "@/domain/contracts"
import { isDecisionAuditEvent } from "@/domain/audit-events"
import {
  getGetRuntimePolicyDraftUrl,
  getGetV1TenantsTenantIdOnePolicyFirstPartyBotDraftUrl,
  getGetV1TenantsTenantIdResourcesResourceIdCapabilitiesCapabilityIdPolicyDraftUrl,
  getPolicyAuthoringSettings as getPolicyAuthoringSettingsRequest,
  getRuntimePolicy as getRuntimePolicyRequest,
  getRuntimePolicyDraft as getRuntimePolicyDraftRequest,
  getRuntimePolicyRevision as getRuntimePolicyRevisionRequest,
  getV1TenantsTenantIdOnePolicyDrafts as getPolicyDraftsRequest,
  getV1TenantsTenantIdOnePolicyFirstPartyBotRevisions as getBotPolicyRevisionsRequest,
  listAccessGroups as listAccessGroupsRequest,
  listRuntimePolicies as listRuntimePoliciesRequest,
  listRuntimePolicyRevisions as listRuntimePolicyRevisionsRequest,
  discardRuntimePolicyDraft as discardRuntimePolicyDraftRequest,
  publishRuntimePolicyDraft as publishRuntimePolicyDraftRequest,
  replaceAccessGroupMembers as replaceAccessGroupMembersRequest,
  reviewRuntimePolicyDraft as reviewRuntimePolicyDraftRequest,
  saveAccessGroup as saveAccessGroupRequest,
  savePolicyAuthoringSettings as savePolicyAuthoringSettingsRequest,
  saveRuntimePolicyDraft as saveRuntimePolicyDraftRequest,
  setRuntimePolicyEnabled as setRuntimePolicyEnabledRequest,
  validateRuntimePolicyDraft as validateRuntimePolicyDraftRequest,
} from "@/generated/management-api"
import type {
  GetPolicyAuthoringSettings200,
  GetRuntimePolicy200,
  GetV1TenantsTenantIdOnePolicyFirstPartyBotDraft200,
  GetV1TenantsTenantIdOnePolicyFirstPartyBotRevisions200Item,
  PutV1TenantsTenantIdOnePolicyFirstPartyBotDraftBody,
  DiscardRuntimePolicyDraftBody,
  PublishRuntimePolicyDraftBody,
  ReplaceAccessGroupMembersBody,
  ReviewRuntimePolicyDraftBody,
  SaveAccessGroupBody,
  SavePolicyAuthoringSettingsBody,
  SaveRuntimePolicyDraftBody,
  SetRuntimePolicyEnabledBody,
  ValidateRuntimePolicyDraftBody,
} from "@/generated/management-api"
import { preservePolicySteps } from "./policy-steps"
import { ProductApiError, managementToken, requestJson } from "./management-api-transport"
export { ProductApiError }
import type { BotPolicyRules } from "@/domain/contracts"
import type {
  AiUsageDashboard,
  AgentDelegation,
  AgentExtensionVersion,
  ApiEnvironmentDeployment,
  ApiGatewayActivityInventory,
  ApiGatewayActivityEvent,
  ApiGatewayTransactionDetail,
  ApiInboundSecurity,
  ApiUpstreamRequestMapping,
  ApiVersionMigrationNotice,
  ApplicationApiCredential,
  ApplicationApiCredentialCreation,
  ApplicationRegistration,
  AccessNotification,
  AccessReviewScope,
  EntitlementAccessReview,
  SubjectRiskAssessment,
  AccessRequest,
  Entitlement,
  ExecutionGrantRequest,
  AuditEvent,
  AuditExportArtifact,
  ConnectionSummary,
  ConnectionCertificate,
  CreateAgentDelegationInput,
  ClassifyDiscoveredResourcesInput,
  CreateUsagePolicyRevisionInput,
  CreateOrganizationInput,
  CreateResourceInput,
  EndpointActivityInventory,
  GatewayBootstrapConfiguration,
  GatewayFleetAvailability,
  GatewayRegistration,
  ImportOpenApiResourceInput,
  InvocationAccountingRecord,
  LocalAccessGroupInventory,
  LocalAccessGroup,
  McpDiscoveryOperation,
  McpOAuthAuthorization,
  McpOAuthBinding,
  OverviewFailure,
  OverviewSnapshot,
  GatewayActivityTrendPoint,
  ResourceRegistration,
  ResourceOnboardingRequest,
  RegisterConnectionInput,
  RegisterGatewayInput,
  RegisterApplicationInput,
  RegisteredEndpointDevice,
  RequestAccessOutcome,
  RuntimeInventoryEntry,
  RoutingReconstruction,
  GatewayActivitySessionTimeline,
  OutcomeAttribution,
  SiemDelivery,
  SiemDestination,
  TenantIdentityInventory,
  Organization,
  UpdateOrganizationInput,
  NotificationChannel,
  NotificationType,
  NotificationSubscription,
  OnePolicyBotSeed,
  TenantConfiguration,
  TenantConfigurationRevision,
  UseCaseEntry,
  UsagePolicyRevision,
} from "@/domain/contracts"
import { isMockMode } from "@/lib/runtime-mode"
import { createMockOrganization, updateMockOrganization } from "@/mocks/organization-store"
import { createMockAiUsageDashboard, createMockGatewayMetrics, createMockTraces } from "@/mocks/observability"
import { mockApiGatewayTransactionDetail } from "@/mocks/overview"
import { loadBrowserOidcConfiguration } from "@/lib/browser-oidc"

const defaultGatewayMetricsWindowSeconds = 7 * 24 * 60 * 60

export function loadDemoProject(tenantId: string) {
  return requestJson<DemoProjectStatus>(`/v1/tenants/${encodeURIComponent(tenantId)}/demo-project`)
}

export function installDemoProject(tenantId: string, organizationId: string) {
  return requestJson<DemoProjectStatus>(`/v1/tenants/${encodeURIComponent(tenantId)}/demo-project/install`, {
    method: "POST",
    body: JSON.stringify({ organization_id: organizationId }),
  })
}

export function skipDemoProject(tenantId: string) {
  return requestJson<DemoProjectStatus>(`/v1/tenants/${encodeURIComponent(tenantId)}/demo-project/skip`, {
    method: "POST",
  })
}

function normalizeAuditEvent(value: AuditEvent): AuditEvent {
  if (!isDecisionAuditEvent(value) || value.kind !== "RUNTIME_POLICY_DECISION") return value
  return {
    ...value,
    target_subject_id: value.target_subject_id ?? null,
    actor_subject: value.actor_subject ?? null,
    resource_id: value.resource_id ?? null,
    capability_id: value.capability_id ?? null,
    device_id: value.device_id ?? null,
    endpoint_version: value.endpoint_version ?? null,
    desired_state_revision: value.desired_state_revision ?? null,
    applied_state_revision: value.applied_state_revision ?? null,
    applied_policy_version: value.policy_id && value.policy_revision !== null && value.policy_revision !== undefined
      ? `${value.policy_id}@${value.policy_revision}`
      : null,
    policy_proposal_id: value.policy_proposal_id ?? null,
    proposed_policy_version: value.proposed_policy_version ?? null,
    access_group_id: value.access_group_id ?? null,
    destination_host: value.destination_host ?? null,
    routing_policy_rule_id: value.routing_policy_rule_id ?? null,
    route: value.route ?? null,
    missing_deployment_capability: value.missing_deployment_capability ?? null,
    decision: null,
    access_request_id: value.access_request_id ?? null,
    entitlement_id: value.entitlement_id ?? null,
    enforcement_point_id: "AGENT_RUNTIME",
    obligation_kind: value.obligations?.[0]?.kind ?? null,
    runaway_trigger: value.runaway_trigger ?? null,
    upstream_attempted: value.upstream_attempted ?? false,
    report_outcome: value.report_outcome ?? null,
    authorization_audit_event_id: value.authorization_audit_event_id ?? null,
    policy_display_name: value.policy_display_name ?? null,
    policy_revision: value.policy_revision ?? null,
    runtime_id: value.runtime_id ?? null,
    bot_id: value.bot_id ?? null,
    target: value.target ?? null,
    action: value.action ?? null,
    session_id: value.session_id ?? null,
    constraints: value.constraints ?? [],
    obligations: value.obligations ?? [],
    matched_policy_refs: value.matched_policy_refs ?? [],
  }
}

async function settled<T>(label: string, promise: Promise<T>, fallback: T) {
  try {
    return { value: await promise, failure: null as OverviewFailure | null }
  } catch (error) {
    return {
      value: fallback,
      failure: {
        source: label,
        code: error instanceof Error ? error.message : "UNKNOWN_ERROR",
        ...(error instanceof ProductApiError ? { status: error.status } : {}),
      },
    }
  }
}

function notInstalled<T>(value: T) {
  return Promise.resolve({ value, failure: null as OverviewFailure | null })
}

function accessGroupInventory(tenantId: string, groups: LocalAccessGroup[]): LocalAccessGroupInventory {
  return {
    tenant_id: tenantId,
    groups,
    memberships: groups.flatMap((group) => group.membership_sources.flatMap((source) => source.subject_ids.map((subjectId) => ({
      tenant_id: group.tenant_id,
      access_group_id: group.access_group_id,
      subject_id: subjectId,
      source: source.kind,
      source_reference: source.source_id,
      source_revision: source.revision,
      assigned_by: { subject_id: source.updated_by, evidence_level: "VERIFIED" as const },
      assigned_at: source.updated_at,
    })))),
  }
}

export async function listAccessGroups(tenantId: string): Promise<LocalAccessGroup[]> {
  return (await listAccessGroupsRequest(tenantId)).data
}

export async function saveAccessGroup(tenantId: string, accessGroupId: string, value: SaveAccessGroupBody): Promise<LocalAccessGroup> {
  return (await saveAccessGroupRequest(tenantId, accessGroupId, value)).data
}

export async function replaceAccessGroupMembers(tenantId: string, accessGroupId: string, value: ReplaceAccessGroupMembersBody): Promise<LocalAccessGroup> {
  return (await replaceAccessGroupMembersRequest(tenantId, accessGroupId, value)).data
}

export function loadResources(tenantId: string) {
  return requestJson<ResourceRegistration[]>(`/v1/tenants/${encodeURIComponent(tenantId)}/resources`)
}

export async function loadOverview(tenantId: string, role?: IdentitySession["role"]): Promise<OverviewSnapshot> {
  const tenant = encodeURIComponent(tenantId)
  const base = `/v1/tenants/${tenant}`
  const analyticsTo = Math.floor(Date.now() / 1000)
  const analyticsFrom = analyticsTo - defaultGatewayMetricsWindowSeconds
  const analyticsQuery = new URLSearchParams({
    from: String(analyticsFrom),
    to: String(analyticsTo),
  })
  const [resources, apiEnvironmentDeployments, activity, apiActivity, aiUsage, gatewayMetrics, auditEvents, endpointEnrolledEvents, endpointRevokedEvents, endpointSessionRejectedEvents, siemDestination, siemDeliveries, accessRequests, ownedEntitlements, accessNotifications, apiVersionMigrationNotices, resourceOnboardingRequests, identity, agentDelegations, executionGrantRequests, agentExtensions, accessGroups, organizations, applications, runtimes, gatewayRegistrations, gatewaySites, health] =
    await Promise.all([
      settled("Resources", loadResources(tenantId), []),
      notInstalled([] as ApiEnvironmentDeployment[]),
      settled(
        "Endpoint activity",
        requestJson<EndpointActivityInventory>(`${base}/ai-activities?recent_limit=100`),
        { resources: [], recent_activity: [] },
      ),
      settled(
        "API Gateway activity",
        requestJson<ApiGatewayActivityInventory>(`${base}/api-activities?limit=100`),
        { events: [] },
      ),
      settled(
        "AI Usage analytics",
        requestJson<AiUsageDashboard>(`${base}/ai-usage?${analyticsQuery}`),
        null,
      ),
      settled("Gateway metrics", getGatewayMetrics(tenantId, defaultGatewayMetricsWindowSeconds), null),
      settled("Audit", requestJson<AuditEvent[]>(`${base}/audit-events?limit=100`), []),
      settled(
        "Endpoint enrolled audit",
        requestJson<AuditEvent[]>(`${base}/audit-events?kind=ENDPOINT_ENROLLED&limit=50`),
        [],
      ),
      settled(
        "Endpoint revoked audit",
        requestJson<AuditEvent[]>(`${base}/audit-events?kind=ENDPOINT_REVOKED&limit=50`),
        [],
      ),
      settled(
        "Endpoint session rejection audit",
        requestJson<AuditEvent[]>(`${base}/audit-events?kind=ENDPOINT_SESSION_REJECTED&limit=50`),
        [],
      ),
      settled("SIEM destination", requestJson<SiemDestination | null>(`${base}/siem-destination`), null),
      settled("SIEM deliveries", requestJson<SiemDelivery[]>(`${base}/siem-deliveries?limit=100`), []),
      settled("Access requests", requestJson<AccessRequest[]>(`${base}/access-requests`), []),
      managementToken()
        ? settled("Owned Entitlements", requestJson<Entitlement[]>(`${base}/me/owned-entitlements`), [])
        : Promise.resolve({ value: [] as Entitlement[], failure: null as OverviewFailure | null }),
      managementToken()
        ? settled("Access notifications", requestJson<AccessNotification[]>(`${base}/me/access-notifications`), [])
        : Promise.resolve({ value: [] as AccessNotification[], failure: null as OverviewFailure | null }),
      notInstalled([] as ApiVersionMigrationNotice[]),
      notInstalled([] as ResourceOnboardingRequest[]),
      settled("Identity", requestJson<TenantIdentityInventory>(`${base}/identity`), null),
      settled("Agent Delegations", requestJson<AgentDelegation[]>(`${base}/agent-delegations`), []),
      settled("Execution Grant Requests", requestJson<ExecutionGrantRequest[]>(`${base}/execution-grant-requests`), []),
      notInstalled([] as AgentExtensionVersion[]),
      role === "TENANT_ADMINISTRATOR"
        ? settled("Access groups", listAccessGroups(tenantId), [] as LocalAccessGroup[])
        : Promise.resolve({ value: [] as LocalAccessGroup[], failure: null as OverviewFailure | null }),
      settled(
        "Organizations",
        requestJson<Organization[]>(`${base}/organizations`),
        [],
      ),
      settled("Applications", requestJson<ApplicationRegistration[]>(`${base}/applications`), []),
      settled("Runtimes", requestJson<RuntimeInventoryEntry[]>(`${base}/runtimes`), []),
      settled("Gateway registrations", requestJson<GatewayRegistration[]>(`${base}/gateways`), []),
      settled("Gateway Sites", requestJson<GatewayFleetAvailability>(`${base}/gateway-sites`), null),
      settled("Platform health", requestJson<{ status: string }>("/healthz"), null),
    ])

  const platformConnections = (await Promise.all(resources.value.map(async (resource) => {
    try {
      const values = await requestJson<Array<{
        connection_id: string
        resource_id: string
        display_name: string
        provider_type: "GENERIC_OPENAI_COMPATIBLE" | "OPENAI" | "OMLX" | "OLLAMA" | "GCP_VERTEX_AI" | "ANTHROPIC" | null
        endpoint: string
        mcp_tool_namespace?: string | null
        mcp_selected_tools: string[]
        mcp_tool_selection_operation_id: string | null
        credential_ref?: string | null
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
        request_mapping: import("@/domain/contracts").ApiUpstreamRequestMapping | null
        connector_configuration?: ConnectorConfiguration
        certificate?: ConnectionCertificate
        status: "DRAFT" | "READY" | "DEGRADED" | "DISABLED"
        configuration_revision: number
        lifecycle: import("@/domain/contracts").ConnectionLifecycle
        revoke_requested_after_release_revision?: number | null
        verification_state: "UNVERIFIED" | "VERIFIED" | "FAILED"
        health_state: "UNKNOWN" | "HEALTHY" | "DEGRADED" | "UNAVAILABLE"
        health_observed_at: number | null
        health_source_revision: number | null
        routing_priority: number
        region: string | null
        supported_obligations: string[]
      }>>(`${base}/resources/${encodeURIComponent(resource.resource_id)}/connections`)
      return values.map((connection): ConnectionSummary => ({
        status: connection.status,
        connection_id: connection.connection_id,
        display_name: connection.display_name,
        kind: resource.kind,
        endpoint_url: connection.endpoint,
        connector_configuration: connection.connector_configuration,
        mcp_tool_namespace: connection.mcp_tool_namespace ?? null,
        mcp_selected_tools: connection.mcp_selected_tools,
        mcp_tool_selection_operation_id: connection.mcp_tool_selection_operation_id,
        credential_configured: Boolean(connection.credential_ref || connection.provider_credential_profile),
        provider_credential_profile: connection.provider_credential_profile ?? null,
        downstream_identity: connection.downstream_identity,
        request_mapping: connection.request_mapping,
        certificate: connection.certificate,
        llm: resource.kind === "LLM" ? {
          provider_id: connection.provider_type!.toLowerCase(),
          models: [],
        } : null,
        resource_id: connection.resource_id,
        enforcement_point_id: resource.enforcement_point_id,
        lifecycle: connection.lifecycle,
        revoke_requested_after_release_revision: connection.revoke_requested_after_release_revision ?? null,
        configuration_revision: connection.configuration_revision,
        verification_state: connection.verification_state,
        health_state: connection.health_state,
        health_observed_at: connection.health_observed_at,
        health_source_revision: connection.health_source_revision,
        routing_priority: connection.routing_priority,
        region: connection.region,
        supported_obligations: connection.supported_obligations,
      }))
    } catch {
      return []
    }
  }))).flat()

  return {
    resources: resources.value,
    apiEnvironmentDeployments: apiEnvironmentDeployments.value,
    connections: platformConnections,
    activity: activity.value,
    apiActivity: apiActivity.value,
    aiUsage: aiUsage.value,
    gatewayMetrics: gatewayMetrics.value,
    auditEvents: auditEvents.value.map(normalizeAuditEvent),
    endpointSecurityEvents: [...endpointEnrolledEvents.value, ...endpointRevokedEvents.value, ...endpointSessionRejectedEvents.value]
      .filter(isDecisionAuditEvent)
      .filter((event, index, events) => events.findIndex((candidate) => candidate.audit_event_id === event.audit_event_id) === index)
      .sort((left, right) => right.occurred_at - left.occurred_at)
      .slice(0, 50),
    siemDestination: siemDestination.value,
    siemDeliveries: siemDeliveries.value,
    accessRequests: accessRequests.value,
    ownedEntitlements: ownedEntitlements.value,
    accessNotifications: accessNotifications.value,
    apiVersionMigrationNotices: apiVersionMigrationNotices.value,
    resourceOnboardingRequests: resourceOnboardingRequests.value,
    identity: identity.value,
    agentDelegations: agentDelegations.value,
    executionGrantRequests: executionGrantRequests.value,
    agentExtensions: agentExtensions.value,
    accessGroups: accessGroupInventory(tenantId, accessGroups.value),
    organizations: organizations.value,
    applications: applications.value,
    runtimes: runtimes.value,
    gatewayRegistrations: gatewayRegistrations.value,
    gatewayFleet: gatewaySites.value,
    platformHealthy: health.value?.status === "ok",
    failures: [
      resources.failure,
      apiEnvironmentDeployments.failure,
      activity.failure,
      apiActivity.failure,
      aiUsage.failure,
      gatewayMetrics.failure,
      auditEvents.failure,
      endpointEnrolledEvents.failure,
      endpointRevokedEvents.failure,
      endpointSessionRejectedEvents.failure,
      siemDestination.failure,
      siemDeliveries.failure,
      accessRequests.failure,
      ownedEntitlements.failure,
      accessNotifications.failure,
      apiVersionMigrationNotices.failure,
      resourceOnboardingRequests.failure,
      identity.failure,
      agentDelegations.failure,
      executionGrantRequests.failure,
      agentExtensions.failure,
      accessGroups.failure,
      organizations.failure,
      applications.failure,
      runtimes.failure,
      gatewayRegistrations.failure,
      gatewaySites.failure,
      health.failure,
    ].filter((failure): failure is OverviewFailure => Boolean(failure)),
  }
}

export async function getGatewayTransactionTrends(
  tenantId: string,
  from: number,
  to: number,
  timeZone: string,
): Promise<GatewayActivityTrendPoint[]> {
  const tenant = encodeURIComponent(tenantId)
  const query = new URLSearchParams({
    from: String(from),
    to: String(to),
    time_zone: timeZone,
  })
  const result = await requestJson<{ points: GatewayActivityTrendPoint[] }>(
    `/v1/tenants/${tenant}/transaction-trends?${query}`,
  )
  return result.points
}

export async function loadApiGatewayTransactionDetail(
  tenantId: string,
  event: ApiGatewayActivityEvent,
) {
  if (isMockMode) return mockApiGatewayTransactionDetail(event)
  return requestJson<ApiGatewayTransactionDetail>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/api-activities/${encodeURIComponent(event.correlation_id)}/detail`,
  )
}


export async function revokeEndpoint(
  tenantId: string,
  deviceId: string,
  reason: string,
) {
  return requestJson<RegisteredEndpointDevice>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/endpoints/${encodeURIComponent(deviceId)}/revoke`,
    {
      method: "POST",
      body: JSON.stringify({
        correlation_id: `console-endpoint-revoke-${crypto.randomUUID()}`,
        reason,
      }),
    },
  )
}

export async function rollbackGateways(
  tenantId: string,
  input: {
    failedRevision: string
    targetRevision: string
    runtimeIds: string[]
  },
) {
  return requestJson<{
    correlation_id: string
    failed_revision: string
    target_revision: string
    runtimes: Array<{
      runtime_id: string
      command_id: string
      desired_state_revision: string
    }>
  }>(`/v1/tenants/${encodeURIComponent(tenantId)}/gateway-rollbacks`, {
    method: "POST",
    body: JSON.stringify({
      correlation_id: `console-gateway-rollback-${crypto.randomUUID()}`,
      failed_revision: input.failedRevision,
      target_revision: input.targetRevision,
      runtime_ids: input.runtimeIds,
    }),
  })
}

export async function configureSiemDestination(
  tenantId: string,
  input: { destinationId: string; endpointUrl: string; eventKinds: string[]; enabled: boolean },
) {
  return requestJson<SiemDestination>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/siem-destination`,
    {
      method: "PUT",
      body: JSON.stringify({
        destination_id: input.destinationId,
        endpoint_url: input.endpointUrl,
        event_kinds: input.eventKinds,
        enabled: input.enabled,
      }),
    },
  )
}

export async function listConfigurationRevisions(tenantId: string) {
  return requestJson<TenantConfigurationRevision[]>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/configuration-revisions`,
  )
}

async function getSelfServiceConfiguration(tenantId: string) {
  return requestJson<TenantConfigurationRevision | null>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/self-service-configuration`,
  )
}

export async function createConfigurationRevision(
  tenantId: string,
  settings: TenantConfiguration,
) {
  return requestJson<TenantConfigurationRevision>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/configuration-revisions`,
    {
      method: "POST",
      body: JSON.stringify({
        correlation_id: `console-config-create-${crypto.randomUUID()}`,
        settings,
      }),
    },
  )
}

export async function transitionConfigurationRevision(
  tenantId: string,
  revision: string,
  transition: "validate" | "preview" | "review" | "publish",
  projectionFailureReason?: string,
) {
  return requestJson<TenantConfigurationRevision>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/configuration-revisions/${encodeURIComponent(revision)}/${transition}`,
    {
      method: "POST",
      body: JSON.stringify({
        correlation_id: `console-config-${transition}-${crypto.randomUUID()}`,
        ...(projectionFailureReason ? { projection_failure_reason: projectionFailureReason } : {}),
      }),
    },
  )
}

export async function retryConfigurationProjection(tenantId: string, revision: string) {
  return requestJson<TenantConfigurationRevision>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/configuration-revisions/${encodeURIComponent(revision)}/retry`,
    {
      method: "POST",
      body: JSON.stringify({ correlation_id: `console-config-retry-${crypto.randomUUID()}` }),
    },
  )
}

export async function listNotificationSubscriptions(tenantId: string) {
  return requestJson<NotificationSubscription[]>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/notification-subscriptions`,
  )
}

export async function upsertNotificationSubscription(
  tenantId: string,
  input: { notificationType: NotificationType; channel: NotificationChannel; enabled: boolean },
) {
  return requestJson<NotificationSubscription>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/notification-subscriptions`,
    {
      method: "POST",
      body: JSON.stringify({
        correlation_id: `console-notification-${crypto.randomUUID()}`,
        notification_type: input.notificationType,
        channel: input.channel,
        enabled: input.enabled,
      }),
    },
  )
}

export async function cancelNotificationSubscription(tenantId: string, subscriptionId: string) {
  return requestJson<NotificationSubscription>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/notification-subscriptions/${encodeURIComponent(subscriptionId)}`,
    {
      method: "DELETE",
      body: JSON.stringify({ correlation_id: `console-notification-cancel-${crypto.randomUUID()}` }),
    },
  )
}

export async function registerApplication(
  tenantId: string,
  input: RegisterApplicationInput,
) {
  return requestJson<ApplicationRegistration>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/applications`,
    {
      method: "POST",
      body: JSON.stringify({
        display_name: input.displayName,
        owner_organization_id: input.ownerOrganizationId,
      }),
    },
  )
}

export async function createOrganization(tenantId: string, input: CreateOrganizationInput) {
  if (isMockMode) return createMockOrganization(tenantId, input)
  return requestJson<Organization>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/organizations`,
    {
      method: "POST",
      body: JSON.stringify({
        display_name: input.displayName,
        member_subject_ids: input.memberSubjectIds,
      }),
    },
  )
}

export async function updateOrganization(tenantId: string, organization: Organization, input: UpdateOrganizationInput) {
  if (isMockMode) return updateMockOrganization(organization, input)
  return requestJson<Organization>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/organizations/${encodeURIComponent(organization.organization_id)}`,
    {
      method: "PUT",
      body: JSON.stringify({
        display_name: input.displayName,
        member_subject_ids: input.memberSubjectIds,
        organization_administrator_subject_ids: input.organizationAdministratorSubjectIds,
        membership_sources: input.membershipSources,
      }),
    },
  )
}


export async function requestApplicationAccess(
  tenantId: string,
  applicationSubjectId: string,
  resourceId: string,
  capabilityId: string,
  justification: string,
) {
  const configuration = await getSelfServiceConfiguration(tenantId)
  if (!configuration) throw new Error("ACCESS_REQUEST_CONFIGURATION_REQUIRED")
  const outcome = await requestJson<RequestAccessOutcome>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/access-requests`,
    {
      method: "POST",
      body: JSON.stringify({
        correlation_id: `console-application-access-${crypto.randomUUID()}`,
        target_subject_id: applicationSubjectId,
        resource_id: resourceId,
        capability_id: capabilityId,
        justification,
        requested_valid_for_seconds: configuration.settings.request_form.default_ttl_seconds,
      }),
    },
  )
  if ("NOT_REQUESTABLE" in outcome) throw new Error("ACCESS_NOT_REQUESTABLE")
  if ("ALREADY_ENTITLED" in outcome) throw new Error("APPLICATION_ALREADY_ENTITLED")
  return outcome
}

export async function createApplicationApiCredential(
  tenantId: string,
  applicationId: string,
  resourceId: string,
  capabilityId: string,
) {
  return requestJson<ApplicationApiCredentialCreation>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/applications/${encodeURIComponent(applicationId)}/api-credentials`,
    {
      method: "POST",
      body: JSON.stringify({
        correlation_id: `console-application-credential-${crypto.randomUUID()}`,
        resource_id: resourceId,
        capability_id: capabilityId,
        client_certificate_pem: null,
        jwt_client_id: null,
      }),
    },
  )
}

export async function listApplicationApiCredentials(
  tenantId: string,
  applicationId: string,
) {
  return requestJson<ApplicationApiCredential[]>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/applications/${encodeURIComponent(applicationId)}/api-credentials`,
  )
}

export async function rotateApplicationApiCredential(
  tenantId: string,
  applicationId: string,
  credentialId: string,
  gracePeriodSeconds: number,
) {
  return requestJson<ApplicationApiCredentialCreation>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/applications/${encodeURIComponent(applicationId)}/api-credentials/${encodeURIComponent(credentialId)}/rotate`,
    {
      method: "POST",
      body: JSON.stringify({
        correlation_id: `console-application-credential-rotate-${crypto.randomUUID()}`,
        grace_period_seconds: gracePeriodSeconds,
      }),
    },
  )
}

export async function revokeApplicationApiCredential(
  tenantId: string,
  applicationId: string,
  credentialId: string,
) {
  return requestJson<ApplicationApiCredential>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/applications/${encodeURIComponent(applicationId)}/api-credentials/${encodeURIComponent(credentialId)}/revoke`,
    {
      method: "POST",
      body: JSON.stringify({
        correlation_id: `console-application-credential-revoke-${crypto.randomUUID()}`,
      }),
    },
  )
}

export async function listApplicationFederationTrusts(
  tenantId: string,
  applicationId: string,
) {
  return requestJson<import("@/domain/contracts").FederationTrustRevision[]>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/applications/${encodeURIComponent(applicationId)}/federation-trust-revisions`,
  )
}

export async function listProviderProfiles(tenantId: string) {
  return requestJson<import("@/domain/contracts").ProviderProfile[]>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/providers/profiles`,
  )
}

export async function listProviderCredentialProfiles(tenantId: string) {
  return requestJson<import("@/domain/contracts").ProviderCredentialProfileRevision[]>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/provider-credential-profiles`,
  )
}

export async function createProviderCredentialProfile(
  tenantId: string,
  input: {
    profileId?: string
    ownerOrganizationId: string
    displayName: string
    strategy: import("@/domain/contracts").ProviderCredentialStrategy
    credentialMaterial?: string
  },
) {
  return requestJson<import("@/domain/contracts").ProviderCredentialProfileRevision>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/provider-credential-profiles`,
    {
      method: "POST",
      body: JSON.stringify({
        ...(input.profileId ? { profile_id: input.profileId } : {}),
        owner_organization_id: input.ownerOrganizationId,
        display_name: input.displayName,
        strategy: input.strategy,
        ...(input.credentialMaterial ? { credential_material: input.credentialMaterial } : {}),
      }),
    },
  )
}

export async function reviseProviderCredentialProfile(
  tenantId: string,
  profile: import("@/domain/contracts").ProviderCredentialProfileRevision,
  state: "ACTIVE" | "REVOKED",
  credentialMaterial?: string,
) {
  return requestJson<import("@/domain/contracts").ProviderCredentialProfileRevision>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/provider-credential-profiles/${encodeURIComponent(profile.profile_id)}/revisions`,
    {
      method: "POST",
      body: JSON.stringify({
        expected_revision: profile.revision,
        display_name: profile.display_name,
        strategy: profile.strategy,
        ...(credentialMaterial ? { credential_material: credentialMaterial } : {}),
        state,
      }),
    },
  )
}

export async function createApplicationFederationTrust(
  tenantId: string,
  applicationId: string,
  input: {
    displayName: string
    issuer: string
    jwksUri: string
    audience: string
    algorithm: "RS256" | "ES256" | "EdDSA"
    externalSubjectId: string
    requiredClaimName?: string
    requiredClaimValue?: string
    maxAssertionTtlSeconds: number
  },
) {
  const requiredClaims = input.requiredClaimName?.trim() && input.requiredClaimValue?.trim()
    ? [{ name: input.requiredClaimName.trim(), value: input.requiredClaimValue.trim() }]
    : []
  return requestJson<import("@/domain/contracts").FederationTrustRevision>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/applications/${encodeURIComponent(applicationId)}/federation-trust-revisions`,
    {
      method: "POST",
      body: JSON.stringify({
        display_name: input.displayName.trim(),
        issuer: input.issuer.trim(),
        jwks_uri: input.jwksUri.trim(),
        audiences: [input.audience.trim()],
        algorithms: [input.algorithm],
        external_subject_id: input.externalSubjectId.trim(),
        required_claims: requiredClaims,
        max_assertion_ttl_seconds: input.maxAssertionTtlSeconds,
      }),
    },
  )
}

export async function listApplicationFederationExchanges(
  tenantId: string,
  applicationId: string,
) {
  return requestJson<import("@/domain/contracts").FederationExchangeEvent[]>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/applications/${encodeURIComponent(applicationId)}/federation-exchanges`,
  )
}

export async function loadAiUsageDashboard(
  tenantId: string,
  from: number,
  to: number,
) {
  if (isMockMode) return createMockAiUsageDashboard(tenantId, from, to)
  const query = new URLSearchParams({ from: String(from), to: String(to) })
  return requestJson<AiUsageDashboard>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/ai-usage?${query}`,
  )
}

export async function loadEntitlementRisks(tenantId: string) {
  return requestJson<SubjectRiskAssessment[]>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/entitlement-risks`,
  )
}

export async function loadAccessReviews(tenantId: string) {
  return requestJson<EntitlementAccessReview[]>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/access-reviews`,
  )
}

export async function createAccessReview(
  tenantId: string,
  input: {
    name: string
    scope: AccessReviewScope
    defaultReviewerId: string | null
    deadline: number
    notificationsEnabled: boolean
  },
) {
  return requestJson<EntitlementAccessReview>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/access-reviews`,
    {
      method: "POST",
      body: JSON.stringify({
        correlation_id: `console-access-review-create-${crypto.randomUUID()}`,
        name: input.name,
        scope: input.scope,
        default_reviewer_id: input.defaultReviewerId,
        deadline: input.deadline,
        notifications_enabled: input.notificationsEnabled,
      }),
    },
  )
}

export async function decideAccessReviewItem(
  tenantId: string,
  reviewId: string,
  entitlementId: string,
  decision: "RETAIN" | "REVOKE",
  reason: string,
) {
  return requestJson<EntitlementAccessReview>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/access-reviews/${encodeURIComponent(reviewId)}/items/${encodeURIComponent(entitlementId)}/decision`,
    {
      method: "POST",
      body: JSON.stringify({
        correlation_id: `console-access-review-decision-${crypto.randomUUID()}`,
        decision,
        reason,
      }),
    },
  )
}

export async function completeAccessReview(tenantId: string, reviewId: string) {
  return requestJson<EntitlementAccessReview>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/access-reviews/${encodeURIComponent(reviewId)}/complete`,
    {
      method: "POST",
      body: JSON.stringify({
        correlation_id: `console-access-review-complete-${crypto.randomUUID()}`,
      }),
    },
  )
}

export async function loadInvocationAccounting(
  tenantId: string,
  correlationId: string,
) {
  return requestJson<InvocationAccountingRecord[]>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/activities/${encodeURIComponent(correlationId)}/accounting`,
  )
}

export async function loadRoutingReconstruction(
  tenantId: string,
  correlationId: string,
) {
  return requestJson<RoutingReconstruction>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/activities/${encodeURIComponent(correlationId)}/routing-reconstruction`,
  )
}

export async function loadGatewayActivitySessionTimeline(
  tenantId: string,
  sessionId: string,
) {
  return requestJson<GatewayActivitySessionTimeline>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/activity-sessions/${encodeURIComponent(sessionId)}`,
  )
}

export async function listActivityOutcomeAttributions(
  tenantId: string,
  correlationId: string,
) {
  return requestJson<OutcomeAttribution[]>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/activities/${encodeURIComponent(correlationId)}/outcomes`,
  )
}

export async function listUseCases(tenantId: string, organizationId: string) {
  if (isMockMode) return []
  return requestJson<UseCaseEntry[]>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/organizations/${encodeURIComponent(organizationId)}/use-cases`,
  )
}

export async function createUseCase(
  tenantId: string,
  organizationId: string,
  input: { displayName: string; riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" },
) {
  const useCaseId = `use-case-${crypto.randomUUID()}`
  if (isMockMode) {
    return {
      tenant_id: tenantId,
      organization_id: organizationId,
      use_case_id: useCaseId,
      display_name: input.displayName,
      risk_level: input.riskLevel,
      state: "ACTIVE" as const,
      created_at: Math.floor(Date.now() / 1000),
    }
  }
  return requestJson<UseCaseEntry>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/organizations/${encodeURIComponent(organizationId)}/use-cases`,
    {
      method: "POST",
      body: JSON.stringify({ display_name: input.displayName, risk_level: input.riskLevel }),
    },
  )
}

export async function listUsagePolicies(tenantId: string) {
  if (isMockMode) return []
  return requestJson<UsagePolicyRevision[]>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/usage-policies`,
  )
}

export async function createUsagePolicyRevision(
  tenantId: string,
  value: CreateUsagePolicyRevisionInput,
): Promise<UsagePolicyRevision> {
  const usagePolicyId = value.usage_policy_id ?? `usage-policy-${crypto.randomUUID()}`
  const accountingKeyId = value.accounting_key_id ?? `accounting-key-${crypto.randomUUID()}`
  const limits: UsagePolicyRevision["limits"] = {
    ...(value.limits.request_quota ? { request_quota: value.limits.request_quota } : {}),
    ...(value.limits.concurrency ? { concurrency: value.limits.concurrency } : {}),
    ...(value.limits.credit_budget ? {
      credit_budget: {
        limit: value.limits.credit_budget.limit,
        credits_per_admitted_request: value.limits.credit_budget.credits_per_admitted_request,
        allocation_id: value.limits.credit_budget.allocation_id ?? `allocation-${crypto.randomUUID()}`,
      },
    } : {}),
    ...(value.limits.currency_budget ? {
      currency_budget: {
        window_seconds: value.limits.currency_budget.window_seconds,
        currency: value.limits.currency_budget.currency,
        limit_micros: value.limits.currency_budget.limit_micros,
        allocation_id: value.limits.currency_budget.allocation_id ?? `allocation-${crypto.randomUUID()}`,
      },
    } : {}),
  }
  if (isMockMode) {
    return {
      ...value,
      usage_policy_id: usagePolicyId,
      accounting_key_id: accountingKeyId,
      revision: value.revision ?? 1,
      limits,
      tenant_id: tenantId,
      created_at: Math.floor(Date.now() / 1000),
    }
  }
  return requestJson<UsagePolicyRevision>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/usage-policies`,
    { method: "POST", body: JSON.stringify(value) },
  )
}

export interface AuditEventQuery {
  correlationId?: string
  enforcementPointId?: string
  outcome?: string
  resourceId?: string
  subjectId?: string
  from?: number
  to?: number
  offset?: number
  limit?: number
}

export interface AuditQueryResponse {
  events: AuditEvent[]
  source_revision: number
  offset: number
  limit: number
  freshness: {
    as_of: number
    latest_event_at: number | null
    age_seconds: number | null
  }
  coverage: {
    requested_from: number | null
    requested_to: number | null
    returned_from: number | null
    returned_to: number | null
    returned_count: number
    has_more: boolean
  }
}

export async function queryAuditEvents(
  tenantId: string,
  input: AuditEventQuery,
): Promise<AuditQueryResponse> {
  const query = new URLSearchParams()
  query.set("metadata", "true")
  if (input.correlationId) query.set("correlation_id", input.correlationId)
  if (input.enforcementPointId) query.set("enforcement_point_id", input.enforcementPointId)
  if (input.outcome) query.set("outcome", input.outcome)
  if (input.resourceId) query.set("resource_id", input.resourceId)
  if (input.subjectId) query.set("subject_id", input.subjectId)
  if (input.from !== undefined) query.set("from", String(input.from))
  if (input.to !== undefined) query.set("to", String(input.to))
  if (input.offset !== undefined) query.set("offset", String(input.offset))
  if (input.limit !== undefined) query.set("limit", String(input.limit))
  const response = await requestJson<AuditQueryResponse>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/audit-events?${query.toString()}`,
  )
  return { ...response, events: response.events.map(normalizeAuditEvent) }
}

export async function exportAuditEvents(
  tenantId: string,
  input: { from: number; to: number; resourceId: string },
) {
  const query = new URLSearchParams({
    from: String(input.from),
    to: String(input.to),
    resource_id: input.resourceId,
  })
  return requestJson<AuditExportArtifact>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/audit-export?${query}`,
  )
}

export async function updateResource(
  tenantId: string,
  resourceId: string,
  value: {
    documentation?: string
    display_name?: string
    version?: string
    owner_organization_id?: string
  },
) {
  return requestJson<ResourceRegistration>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/resources/${encodeURIComponent(resourceId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(value),
    },
  )
}

export async function setResourceLifecycle(
  tenantId: string,
  resourceId: string,
  lifecycle: "DEPRECATED" | "RETIRED",
) {
  return requestJson<ResourceRegistration>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/resources/${encodeURIComponent(resourceId)}/lifecycle`,
    {
      method: "POST",
      body: JSON.stringify({
        correlation_id: `console-resource-lifecycle-${crypto.randomUUID()}`,
        lifecycle,
      }),
    },
  )
}

export async function listTraces(tenantId: string, limit = 20, filters: { before?: number; before_trace_id?: string; search?: string; from?: number; until?: number } = {}) {
  if (isMockMode) return { traces: createMockTraces().slice(0, limit) }
  return requestJson<{ traces: import("@/domain/contracts").TraceSummary[] }>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/traces?${new URLSearchParams(Object.entries({ limit, ...filters }).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]))}`,
  )
}

export async function listTraceSpans(tenantId: string, traceId: string, after?: string) {
  return requestJson<{ spans: import("@/domain/contracts").TraceSpan[]; next_cursor: string | null }>(`/v1/tenants/${encodeURIComponent(tenantId)}/traces/${encodeURIComponent(traceId)}/spans?limit=200${after ? `&after=${encodeURIComponent(after)}` : ""}`)
}

export async function getGatewayMetrics(tenantId: string, windowSeconds = defaultGatewayMetricsWindowSeconds) {
  if (isMockMode) return { ...createMockGatewayMetrics(tenantId), window_seconds: windowSeconds }
  return requestJson<import("@/domain/contracts").GatewayMetricsSummary>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/metrics?window_seconds=${encodeURIComponent(windowSeconds)}`,
  )
}

export async function getGatewayDiagnosticSettings(tenantId: string, gatewayId: string) {
  return requestJson<import("@/domain/contracts").GatewayDiagnosticSettings>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/gateway-groups/${encodeURIComponent(gatewayId)}/diagnostics`,
  )
}

export async function updateGatewayDiagnosticSettings(
  tenantId: string,
  gatewayId: string,
  input: { captureMessageContent: boolean },
) {
  return requestJson<import("@/domain/contracts").GatewayDiagnosticSettings>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/gateway-groups/${encodeURIComponent(gatewayId)}/diagnostics`,
    {
      method: "PUT",
      body: JSON.stringify({ capture_message_content: input.captureMessageContent }),
    },
  )
}

export async function registerAgentSubject(
  tenantId: string,
  input: { subjectId?: string; displayName: string; department?: string },
) {
  return requestJson<ConnectionSummary>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/identity/subjects`,
    {
      method: "POST",
      body: JSON.stringify({
        kind: "AGENT",
        ...(input.subjectId?.trim() ? { subject_id: input.subjectId.trim() } : {}),
        display_name: input.displayName.trim(),
        ...(input.department?.trim() ? { department: input.department.trim() } : {}),
      }),
    },
  )
}

export async function createAgentDelegation(
  tenantId: string,
  input: CreateAgentDelegationInput,
) {
  return requestJson<AgentDelegation>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/agent-delegations`,
    {
      method: "POST",
      body: JSON.stringify({
        principal_subject_id: input.principalSubjectId,
        agent_subject_id: input.agentSubjectId,
        resource_id: input.resourceId,
        capability_ids: input.capabilityIds,
        acting_client_ids: input.actingClientIds,
        expires_at: input.expiresAt,
      }),
    },
  )
}

export async function revokeAgentDelegation(
  tenantId: string,
  delegationId: string,
  expectedRevision: number,
) {
  return requestJson<AgentDelegation>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/agent-delegations/${encodeURIComponent(delegationId)}/revoke`,
    {
      method: "POST",
      body: JSON.stringify({ expected_revision: expectedRevision }),
    },
  )
}

export async function decideExecutionGrantRequest(
  tenantId: string,
  requestId: string,
  expectedRevision: number,
  decision: "APPROVE" | "DENY",
  reason: string,
) {
  return requestJson<ExecutionGrantRequest>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/execution-grant-requests/${encodeURIComponent(requestId)}/decision`,
    {
      method: "POST",
      body: JSON.stringify({ expected_revision: expectedRevision, decision, reason }),
    },
  )
}

export async function createExecutionGrantRequest(
  tenantId: string,
  input: { resourceId: string; capabilityId: string; actionDigest: string; requestedExpiresAt: number },
) {
  return requestJson<ExecutionGrantRequest>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/execution-grant-requests`,
    {
      method: "POST",
      body: JSON.stringify({
        resource_id: input.resourceId,
        capability_id: input.capabilityId,
        action_digest: input.actionDigest,
        requested_expires_at: input.requestedExpiresAt,
      }),
    },
  )
}

export async function setResourcePublicationEndpoint(
  tenantId: string,
  resourceId: string,
  endpoint: import("@/domain/contracts").ResourcePublicationEndpoint,
) {
  return requestJson<ResourceRegistration>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/resources/${encodeURIComponent(resourceId)}/publication-endpoint`,
    {
      method: "PUT",
      body: JSON.stringify(endpoint),
    },
  )
}

export async function verifyResourcePublicationDns(
  tenantId: string,
  resourceId: string,
  endpoint: import("@/domain/contracts").ResourcePublicationEndpoint,
) {
  return requestJson<ResourceRegistration>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/resources/${encodeURIComponent(resourceId)}/publication-endpoint`,
    {
      method: "PUT",
      body: JSON.stringify({
        ...endpoint,
        dns_target: endpoint.dns_target?.trim() || null,
        dns_verification: "VERIFIED",
      }),
    },
  )
}

export async function requestResourcePublication(
  tenantId: string,
  resourceId: string,
) {
  return requestJson<{ request_id: string }>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/resources/${encodeURIComponent(resourceId)}/publication-requests`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  )
}

export type EnforcementProcessAction =
  | "BLOCK"
  | "REDACT"
  | "TOKENIZE"
  | "RESTORE"
  | "MODEL_CLASSIFIER"

export type EnforcementCandidateEffect =
  | "NARROW_ENTITLEMENT_CANDIDATES"
  | "SORT_ENTITLEMENT_CANDIDATES"

export interface EditableEnforcementProcessStep {
  step_id: string
  hooks: {
    request?: {
      action: EnforcementProcessAction
      effect?: EnforcementCandidateEffect
      config?: Record<string, unknown>
    }
    response?: {
      action: EnforcementProcessAction
      effect?: EnforcementCandidateEffect
      config?: Record<string, unknown>
    }
  }
}

export interface EnforcementChainRevisionView {
  tenant_id: string
  resource_id: string
  capability_id: string
  one_policy_revision: number
  chain: {
    eligible_connection_ids: string[]
    steps: Array<{
      step_id: string
      kind: "AUTHENTICATE" | "AUTHORIZE" | "PROCESS" | "ROUTE" | "OBSERVE"
      hooks?: EditableEnforcementProcessStep["hooks"]
      config?: Record<string, unknown>
    }>
    request_filter_order: string[]
    response_filter_order: string[]
  }
  chain_digest: string
  created_at: number
  updated_at: number
}

export interface EnforcementChainInventoryView {
  tenant_id: string
  resource_id: string
  capability_id: string
  one_policy_revision: number
  status: "READY" | "MIGRATION_REQUIRED"
  revision: EnforcementChainRevisionView | null
  issue_code: string | null
}

function enforcementChainPath(tenantId: string, resourceId: string, capabilityId: string) {
  return `/v1/tenants/${encodeURIComponent(tenantId)}/resources/${encodeURIComponent(resourceId)}/capabilities/${encodeURIComponent(capabilityId)}/enforcement-chain`
}

export async function getLatestResourceEnforcementChain(
  tenantId: string,
  resourceId: string,
  capabilityId: string,
) {
  return requestJson<EnforcementChainRevisionView>(
    enforcementChainPath(tenantId, resourceId, capabilityId),
  )
}

export async function listLatestEnforcementChains(tenantId: string) {
  return requestJson<EnforcementChainInventoryView[]>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/enforcement-chains`,
  )
}

export async function getFirstPartyBotPolicySeed(tenantId: string) {
  return requestJson<OnePolicyBotSeed>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/one-policy/first-party-bot`,
  )
}

export async function setFirstPartyBotPolicySeedEnabled(tenantId: string, enabled: boolean) {
  return requestJson<OnePolicyBotSeed>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/one-policy/first-party-bot`,
    { method: "PATCH", body: JSON.stringify({ enabled }) },
  )
}

async function standardEnforcementSteps(
  processSteps: readonly EditableEnforcementProcessStep[],
  inboundSecurity?: ApiInboundSecurity,
  requireExecutionConfirmation = false,
) {
  const oidc = await loadBrowserOidcConfiguration()
  const oauth = inboundSecurity?.type === "OAUTH2" ? inboundSecurity : null
  const issuer = (oauth?.issuer.trim() || oidc.issuer).replace(/\/$/, "")
  const audience = oauth?.audience.trim() || "genio-one-product-api"
  const remoteJwksUri = oauth?.jwks_url.trim() || `${issuer}/protocol/openid-connect/certs`
  const steps: Array<Record<string, unknown>> = [
    {
      step_id: "authenticate",
      kind: "AUTHENTICATE",
      phase: "REQUEST",
      implementation: "NATIVE",
      config: {
        schema_version: "genio.one.auth.jwt.v1",
        provider: oauth ? "api-oauth2" : "keycloak",
        issuer,
        audiences: [audience],
        remote_jwks_uri: remoteJwksUri,
        subject_claim: "sub",
        client_claim: "azp",
      },
    },
    {
      step_id: "authorize",
      kind: "AUTHORIZE",
      phase: "REQUEST",
      implementation: "EXT_AUTH",
      depends_on: ["authenticate"],
      ...(requireExecutionConfirmation ? { config: { required_obligations: ["execution.confirmation"] } } : {}),
    },
  ]
  let dependency = "authorize"
  for (const step of processSteps) {
    steps.push({
      step_id: step.step_id,
      kind: "PROCESS",
      implementation: "PROCESSOR",
      depends_on: [dependency],
      hooks: step.hooks,
    })
    dependency = step.step_id
  }
  steps.push({
    step_id: "route",
    kind: "ROUTE",
    phase: "ROUTING",
    implementation: "AIGW_NATIVE",
    depends_on: [dependency],
  })
  return steps
}

export async function saveResourceEnforcementChain(
  tenantId: string,
  resourceId: string,
  capabilityId: string,
  onePolicyRevision: number,
  processSteps: readonly EditableEnforcementProcessStep[],
  inboundSecurity?: ApiInboundSecurity,
  requireExecutionConfirmation = false,
  eligibleConnectionIds?: readonly string[],
) {
  return requestJson<EnforcementChainRevisionView>(
    enforcementChainPath(tenantId, resourceId, capabilityId),
    {
      method: "POST",
      body: JSON.stringify({
        one_policy_revision: onePolicyRevision,
        ...(eligibleConnectionIds ? { eligible_connection_ids: eligibleConnectionIds } : {}),
        steps: await standardEnforcementSteps(processSteps, inboundSecurity, requireExecutionConfirmation),
      }),
    },
  )
}

export async function saveStandardResourceEnforcement(
  tenantId: string,
  resource: ResourceRegistration,
) {
  await Promise.all(resource.capabilities.map(async (capability) => {
    try {
      const latest = await getLatestResourceEnforcementChain(
        tenantId,
        resource.resource_id,
        capability.capability_id,
      )
      if (resource.lifecycle !== "PUBLISHED") return
      const processSteps = latest.chain.steps.flatMap((step) =>
        step.kind === "PROCESS" && step.hooks
          ? [{ step_id: step.step_id, hooks: step.hooks }]
          : [],
      )
      await saveResourceEnforcementChain(
        tenantId,
        resource.resource_id,
        capability.capability_id,
        latest.one_policy_revision + 1,
        processSteps,
        resource.api?.inbound_security,
        latest.chain.steps.some((step) =>
          step.kind === "AUTHORIZE" &&
          Array.isArray(step.config?.required_obligations) &&
          step.config.required_obligations.includes("execution.confirmation")),
        latest.chain.eligible_connection_ids,
      )
    } catch (error) {
      if (!(error instanceof ProductApiError) || error.status !== 404) throw error
      await saveResourceEnforcementChain(
        tenantId,
        resource.resource_id,
        capability.capability_id,
        1,
        [],
        resource.api?.inbound_security,
      )
    }
  }))
}

export async function reviewResourcePublication(
  tenantId: string,
  resourceId: string,
  requestId: string,
  decision: "APPROVE" | "REJECT",
) {
  return requestJson<ResourceRegistration>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/resources/${encodeURIComponent(resourceId)}/publication-requests/${encodeURIComponent(requestId)}/review`,
    {
      method: "POST",
      body: JSON.stringify({
        decision,
      }),
    },
  )
}

export async function registerGateway(tenantId: string, input: RegisterGatewayInput) {
  return requestJson<GatewayBootstrapConfiguration>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/gateways`,
    {
      method: "POST",
      body: JSON.stringify({
        correlation_id: `console-gateway-registration-${crypto.randomUUID()}`,
        display_name: input.displayName,
        site_id: input.siteId,
        region: input.region,
        labels: input.labels,
        ...(input.runtimeId?.trim() ? { runtime_id: input.runtimeId.trim() } : {}),
      }),
    },
  )
}

export async function registerConnection(
  tenantId: string,
  input: RegisterConnectionInput,
) {
  const isMcp = input.kind === "MCP"
  const isLlm = input.kind === "LLM"
  const isApi = input.kind === "API"
  const providerType = input.llm?.provider_id.trim().toUpperCase()
  if (isLlm && providerType !== "GENERIC_OPENAI_COMPATIBLE" && providerType !== "OPENAI" && providerType !== "OMLX" && providerType !== "OLLAMA" && providerType !== "GCP_VERTEX_AI" && providerType !== "ANTHROPIC") {
    throw new Error("UNSUPPORTED_PROVIDER_TYPE")
  }
  if (isLlm && providerType === "GCP_VERTEX_AI" && !input.providerCredentialProfile) {
    throw new Error("PROVIDER_CREDENTIAL_PROFILE_REQUIRED")
  }
  if (isLlm && input.upstreamAuthentication === "PROVIDER_CREDENTIAL_PROFILE" && !input.providerCredentialProfile) {
    throw new Error("PROVIDER_CREDENTIAL_PROFILE_REQUIRED")
  }
  if (isMcp && input.upstreamAuthentication === "USER_PASSTHROUGH" && !input.userCredentialHeader?.trim()) {
    throw new Error("MCP_USER_CREDENTIAL_HEADER_REQUIRED")
  }
  return requestJson<{
    tenant_id: string
    connection_id: string
    resource_id: string
    display_name: string
    connection_kind: "LLM" | "MCP" | "API"
    provider_type: "GENERIC_OPENAI_COMPATIBLE" | "OPENAI" | "OMLX" | "OLLAMA" | "GCP_VERTEX_AI" | "ANTHROPIC" | null
    endpoint: string
    status: "DRAFT" | "READY" | "DEGRADED" | "DISABLED"
  }>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/resources/${encodeURIComponent(input.resourceId)}/connections`,
    {
      method: "POST",
      body: JSON.stringify({
        display_name: input.displayName,
        connection_kind: input.kind,
        ...(isMcp
          ? {
              downstream_identity: input.upstreamAuthentication === "API_KEY"
                ? { mode: "SERVICE", authentication: "API_KEY" }
                : input.upstreamAuthentication === "USER_PASSTHROUGH"
                  ? {
                      mode: "USER_PASSTHROUGH",
                      forward_headers: [{ name: input.userCredentialHeader?.trim() }],
                    }
                  : input.upstreamAuthentication === "USER_OAUTH"
                    ? { mode: "USER_OAUTH" }
                  : { mode: "NONE" },
            }
          : isLlm ? {
              provider_type: providerType,
              provider_profile_id: input.providerProfileId?.trim() || (
                providerType === "GCP_VERTEX_AI"
                  ? "provider-gcp-vertex-ai"
                  : providerType === "GENERIC_OPENAI_COMPATIBLE"
                    ? "provider-generic-openai-compatible"
                    : providerType === "ANTHROPIC"
                      ? "provider-anthropic"
                      : `provider-${providerType!.toLowerCase()}`
              ),
              ...(input.providerCredentialProfile
                ? { provider_credential_profile: input.providerCredentialProfile }
                : { downstream_identity: { mode: "NONE" } }),
            } : { downstream_identity: { mode: "NONE" } }),
        ...(input.connectorConfiguration ? { connector_configuration: input.connectorConfiguration } : { endpoint: input.endpointUrl }),
        ...(input.certificateMode ? {
          certificate_mode: input.certificateMode,
          certificate_pem: input.certificateMode === "CUSTOM_CA" ? input.certificatePem ?? null : null,
        } : {}),
        ...(input.region ? { region: input.region } : {}),
        ...(input.mcpToolNamespace?.trim()
          ? { mcp_tool_namespace: input.mcpToolNamespace.trim().toLowerCase() }
          : {}),
        ...(input.credentialReference?.trim() && input.upstreamAuthentication !== "USER_OAUTH" && !input.providerCredentialProfile
          ? { credential_ref: input.credentialReference.trim() }
          : {}),
        ...(isApi
          ? { request_mapping: input.requestMapping ?? { default_action: "PASSTHROUGH", rules: [] } }
          : {}),
      }),
    },
  )
}

export async function updateResourceConnectionRequestMapping(
  tenantId: string,
  resourceId: string,
  connectionId: string,
  expectedRevision: number,
  requestMapping: ApiUpstreamRequestMapping,
) {
  return requestJson<ConnectionSummary>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/resources/${encodeURIComponent(resourceId)}/connections/${encodeURIComponent(connectionId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ expected_revision: expectedRevision, request_mapping: requestMapping }),
    },
  )
}

export async function updateResourceConnection(
  tenantId: string,
  input: {
    connectorConfiguration?: ConnectorConfiguration
    resourceId: string
    connectionId: string
    expectedRevision: number
    displayName?: string
    endpointUrl?: string
    routingPriority?: number
    region?: string | null
    supportedObligations?: string[]
    providerCredentialProfile?: {
      profile_id: string
      revision: number
    } | null
  },
) {
  return requestJson<ConnectionSummary>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/resources/${encodeURIComponent(input.resourceId)}/connections/${encodeURIComponent(input.connectionId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        ...(input.connectorConfiguration ? { connector_configuration: input.connectorConfiguration } : {}),
        expected_revision: input.expectedRevision,
        ...(input.displayName === undefined ? {} : { display_name: input.displayName }),
        ...(input.endpointUrl === undefined ? {} : { endpoint: input.endpointUrl }),
        ...(input.routingPriority === undefined ? {} : { routing_priority: input.routingPriority }),
        ...(input.region === undefined ? {} : { region: input.region }),
        ...(input.supportedObligations === undefined ? {} : { supported_obligations: input.supportedObligations }),
        ...(input.providerCredentialProfile === undefined ? {} : { provider_credential_profile: input.providerCredentialProfile }),
      }),
    },
  )
}

export async function updateResourceConnectionCertificate(
  tenantId: string,
  input: {
    resourceId: string
    connectionId: string
    expectedRevision: number
    mode: "SYSTEM_CA" | "CUSTOM_CA"
    certificatePem: string | null
  },
) {
  return requestJson<ConnectionSummary>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/resources/${encodeURIComponent(input.resourceId)}/connections/${encodeURIComponent(input.connectionId)}/certificate`,
    {
      method: "PUT",
      body: JSON.stringify({
        expected_revision: input.expectedRevision,
        mode: input.mode,
        certificate_pem: input.certificatePem,
      }),
    },
  )
}

export async function transitionResourceConnectionLifecycle(
  tenantId: string,
  input: {
    resourceId: string
    connectionId: string
    expectedRevision: number
    command: "ENABLE" | "DISABLE" | "REQUEST_REVOKE" | "CONFIRM_REVOKED"
    appliedReleaseRevision?: number
  },
) {
  return requestJson<ConnectionSummary>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/resources/${encodeURIComponent(input.resourceId)}/connections/${encodeURIComponent(input.connectionId)}/lifecycle`,
    {
      method: "POST",
      body: JSON.stringify({
        correlation_id: `console-connection-lifecycle-${crypto.randomUUID()}`,
        expected_revision: input.expectedRevision,
        command: input.command,
        ...(input.appliedReleaseRevision === undefined
          ? {}
          : { applied_release_revision: input.appliedReleaseRevision }),
      }),
    },
  )
}

export async function deleteResourceConnection(tenantId: string, resourceId: string, connectionId: string) {
  await requestJson<null>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/resources/${encodeURIComponent(resourceId)}/connections/${encodeURIComponent(connectionId)}`,
    { method: "DELETE" },
  )
}

export async function createPublicModel(
  tenantId: string,
  resourceId: string,
  input: {
    modelName: string
    displayName: string
    connectionId: string
    providerModel: string
    capabilities?: PublicModelView["capabilities"]
  },
) {
  return requestJson<{
    tenant_id: string
    model_id: string
    model_name: string
    display_name: string
    resource_id: string
    visibility: "PUBLIC" | "PRIVATE"
    lifecycle: "PUBLISHED" | "DEPRECATED"
  }>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/resources/${encodeURIComponent(resourceId)}/models`,
    {
      method: "POST",
      body: JSON.stringify({
        model_name: input.modelName,
        display_name: input.displayName,
        visibility: "PUBLIC",
        capabilities: input.capabilities ?? ["CHAT", "STREAMING"],
        mappings: [{
          connection_id: input.connectionId,
          provider_model: input.providerModel,
        }],
      }),
    },
  )
}

export interface PublicModelView {
  tenant_id: string
  model_id: string
  model_name: string
  display_name: string
  resource_id: string
  visibility: "PUBLIC" | "PRIVATE"
  lifecycle: "PUBLISHED" | "DEPRECATED"
  capabilities: Array<"CHAT" | "STREAMING" | "TOOL_CALLING" | "VISION" | "REASONING" | "EMBEDDINGS" | "TRANSCRIPTION">
  created_at: number
}

export interface ConnectionModelMappingView {
  tenant_id: string
  mapping_id: string
  public_model_id: string
  resource_id: string
  connection_id: string
  provider_model: string
  mapping_revision: number
  created_at: number
}

export async function listResourcePublicModels(tenantId: string, resourceId: string) {
  const query = new URLSearchParams({ visibility: "PUBLIC", resource_id: resourceId })
  return requestJson<PublicModelView[]>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/models?${query}`,
  )
}

export async function listResourceModelMappings(tenantId: string, resourceId: string) {
  return requestJson<ConnectionModelMappingView[]>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/resources/${encodeURIComponent(resourceId)}/model-mappings`,
  )
}

export async function addConnectionModelMapping(
  tenantId: string,
  resourceId: string,
  modelId: string,
  input: {
    connectionId: string
    providerModel: string
    expectedConnectionRevision: number
  },
) {
  return requestJson<ConnectionModelMappingView>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/resources/${encodeURIComponent(resourceId)}/models/${encodeURIComponent(modelId)}/mappings`,
    {
      method: "POST",
      body: JSON.stringify({
        connection_id: input.connectionId,
        provider_model: input.providerModel,
        expected_connection_revision: input.expectedConnectionRevision,
      }),
    },
  )
}

export interface ModelRoutingPolicyView {
  tenant_id: string
  routing_policy_id: string
  owner_organization_id: string
  resource_id: string
  capability_id: string
  routing_revision: number
  mode: "DETERMINISTIC" | "SESSION_LEASE"
  candidate_public_model_ids: string[]
  default_public_model_id: string
  session_lease_seconds: number | null
  context_requirements?: Array<{
    consumer_organization_id: string
    use_case_id: string
    minimum_risk_level: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
    required_obligation_kinds: string[]
  }>
  created_at: number
  updated_at: number
}

function modelRoutingPolicyPath(
  tenantId: string,
  resourceId: string,
  capabilityId: string,
) {
  return `/v1/tenants/${encodeURIComponent(tenantId)}/resources/${encodeURIComponent(resourceId)}/capabilities/${encodeURIComponent(capabilityId)}/model-routing-policy`
}

export async function loadModelRoutingPolicy(
  tenantId: string,
  resourceId: string,
  capabilityId: string,
) {
  return requestJson<ModelRoutingPolicyView>(
    modelRoutingPolicyPath(tenantId, resourceId, capabilityId),
  )
}

export async function saveModelRoutingPolicy(
  tenantId: string,
  resourceId: string,
  capabilityId: string,
  input: Pick<
    ModelRoutingPolicyView,
    | "routing_revision"
    | "mode"
    | "candidate_public_model_ids"
    | "default_public_model_id"
    | "session_lease_seconds"
    | "context_requirements"
  >,
) {
  return requestJson<ModelRoutingPolicyView>(
    modelRoutingPolicyPath(tenantId, resourceId, capabilityId),
    { method: "PUT", body: JSON.stringify(input) },
  )
}

export async function ensureStandardModelRoutingPolicy(
  tenantId: string,
  resource: ResourceRegistration,
) {
  if (resource.kind !== "LLM") return
  const capability = resource.capabilities.find(
    (candidate) => candidate.capability_id === "model.invoke",
  )
  if (!capability) return
  try {
    await loadModelRoutingPolicy(tenantId, resource.resource_id, capability.capability_id)
    return
  } catch (error) {
    if (!(error instanceof ProductApiError) || error.status !== 404) throw error
  }
  const query = new URLSearchParams({
    visibility: "PUBLIC",
    resource_id: resource.resource_id,
  })
  const models = await requestJson<Array<{
    model_id: string
    lifecycle: "PUBLISHED" | "DEPRECATED"
  }>>(`/v1/tenants/${encodeURIComponent(tenantId)}/models?${query}`)
  const published = models.filter((model) => model.lifecycle === "PUBLISHED")
  if (published.length !== 1) return
  const modelId = published[0].model_id
  return requestJson<unknown>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/resources/${encodeURIComponent(resource.resource_id)}/capabilities/${encodeURIComponent(capability.capability_id)}/model-routing-policy`,
    {
      method: "PUT",
      body: JSON.stringify({
        routing_revision: 1,
        mode: "DETERMINISTIC",
        candidate_public_model_ids: [modelId],
        default_public_model_id: modelId,
        session_lease_seconds: null,
      }),
    },
  )
}

export async function grantEntitlement(
  tenantId: string,
  input: { subjectId: string; resourceId: string; capabilityId: string; idempotencyKey: string },
) {
  return requestJson<Entitlement>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/entitlements`,
    {
      method: "POST",
      headers: { "Idempotency-Key": input.idempotencyKey },
      body: JSON.stringify({
        subject_id: input.subjectId,
        resource_id: input.resourceId,
        capability_id: input.capabilityId,
        public_model_id: null,
      }),
    },
  )
}

export async function verifyResourceConnection(
  tenantId: string,
  resourceId: string,
  connectionId: string,
) {
  return requestJson<ConnectionSummary>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/resources/${encodeURIComponent(resourceId)}/connections/${encodeURIComponent(connectionId)}/verify`,
    { method: "POST" },
  )
}

export async function updateConnectionMcpRouting(
  tenantId: string,
  resourceId: string,
  connectionId: string,
  expectedRevision: number,
  mcpToolNamespace: string | null,
) {
  return requestJson<ConnectionSummary>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/resources/${encodeURIComponent(resourceId)}/connections/${encodeURIComponent(connectionId)}/mcp-routing`,
    {
      method: "POST",
      body: JSON.stringify({
        correlation_id: `console-mcp-routing-${crypto.randomUUID()}`,
        expected_revision: expectedRevision,
        mcp_tool_namespace: mcpToolNamespace?.trim() || null,
      }),
    },
  )
}

export async function requestMcpDiscovery(
  tenantId: string,
  resourceId: string,
  connectionId: string,
) {
  return requestJson<McpDiscoveryOperation>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/resources/${encodeURIComponent(resourceId)}/connections/${encodeURIComponent(connectionId)}/mcp-discovery`,
    {
      method: "POST",
      body: JSON.stringify({
        correlation_id: `console-mcp-discovery-${crypto.randomUUID()}`,
      }),
    },
  )
}

export async function getLatestMcpDiscovery(
  tenantId: string,
  resourceId: string,
  connectionId: string,
) {
  return requestJson<McpDiscoveryOperation | null>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/resources/${encodeURIComponent(resourceId)}/connections/${encodeURIComponent(connectionId)}/mcp-discovery/latest`,
  )
}

export async function decideMcpDiscoveryCandidate(
  tenantId: string,
  resourceId: string,
  connectionId: string,
  candidateId: string,
  expectedRevisionDigest: string,
  state: "PUBLISHED" | "IGNORED" | "BLOCKED",
) {
  return requestJson<McpDiscoveryOperation>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/resources/${encodeURIComponent(resourceId)}/connections/${encodeURIComponent(connectionId)}/mcp-discovery/candidates/${encodeURIComponent(candidateId)}/decision`,
    {
      method: "POST",
      body: JSON.stringify({ expected_revision_digest: expectedRevisionDigest, state }),
    },
  )
}

export async function startMcpOAuthAuthorization(
  tenantId: string,
  resourceId: string,
  connectionId: string,
): Promise<McpOAuthAuthorization> {
  return requestJson<McpOAuthAuthorization>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/resources/${encodeURIComponent(resourceId)}/connections/${encodeURIComponent(connectionId)}/mcp-oauth/authorize`,
    { method: "POST" },
  )
}

export async function getMcpOAuthBinding(
  tenantId: string,
  resourceId: string,
  connectionId: string,
): Promise<McpOAuthBinding | null> {
  return requestJson<McpOAuthBinding | null>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/resources/${encodeURIComponent(resourceId)}/connections/${encodeURIComponent(connectionId)}/mcp-oauth`,
  )
}

export async function disconnectMcpOAuthBinding(
  tenantId: string,
  resourceId: string,
  connectionId: string,
): Promise<void> {
  await requestJson<null>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/resources/${encodeURIComponent(resourceId)}/connections/${encodeURIComponent(connectionId)}/mcp-oauth`,
    { method: "DELETE" },
  )
}

export async function provisionGateway(tenantId: string, runtimeId: string) {
  return requestJson<GatewayBootstrapConfiguration>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/gateways/${encodeURIComponent(runtimeId)}/provision`,
    {
      method: "POST",
      body: JSON.stringify({
        correlation_id: `console-gateway-provision-${crypto.randomUUID()}`,
      }),
    },
  )
}

export async function retireGateway(tenantId: string, runtimeId: string) {
  return requestJson<GatewayRegistration>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/gateways/${encodeURIComponent(runtimeId)}/retire`,
    {
      method: "POST",
      body: JSON.stringify({
        correlation_id: `console-gateway-retire-${crypto.randomUUID()}`,
      }),
    },
  )
}

export async function createResource(tenantId: string, input: CreateResourceInput) {
  const mcpAuthorization = input.kind === "MCP" && input.mcpAuthorization &&
    [
      input.mcpAuthorization.resource,
      input.mcpAuthorization.authorizationServers,
      input.mcpAuthorization.scopesSupported,
      input.mcpAuthorization.requiredIssuer,
    ].some((value) => value.trim().length > 0)
    ? {
        resource: input.mcpAuthorization.resource.trim(),
        authorization_servers: input.mcpAuthorization.authorizationServers
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        scopes_supported: input.mcpAuthorization.scopesSupported
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        required_issuer: input.mcpAuthorization.requiredIssuer.trim(),
      }
    : null
  return requestJson<ResourceRegistration>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/resources`,
    {
      method: "POST",
      body: JSON.stringify({
        display_name: input.displayName,
        kind: input.kind,
        authentication_strategy: input.authenticationStrategy,
        environment_id: input.environmentId,
        version: input.version,
        capabilities: input.capabilities ?? [
          {
            capability_id: input.capabilityId,
            display_name: input.capabilityName,
          },
        ],
        ...(input.api ? { api: input.api } : {}),
        ...(mcpAuthorization ? { mcp_authorization: mcpAuthorization } : {}),
        ...(input.extensionMetadata ? { extension_metadata: input.extensionMetadata } : {}),
        enforcement_point_id: input.enforcementPointId,
        owner_organization_id: input.ownerOrganizationId,
      }),
    },
  )
}

export async function importOpenApiResource(
  tenantId: string,
  input: ImportOpenApiResourceInput,
) {
  const inboundSecurity: ApiInboundSecurity = input.inboundSecurity === "KEYLESS"
    ? { type: "KEYLESS" }
    : input.inboundSecurity === "API_KEY"
      ? { type: "API_KEY", header_name: "x-api-key" }
      : {
          type: "OAUTH2",
          issuer: input.oauthIssuer?.trim() ?? "",
          audience: input.oauthAudience?.trim() ?? "",
          jwks_url: input.oauthJwksUrl?.trim() ?? "",
          scope: input.oauthScope?.trim() ?? "",
        }
  return requestJson<ResourceRegistration>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/resources/import-openapi`,
    {
      method: "POST",
      body: JSON.stringify({
        owner_organization_id: input.ownerOrganizationId,
        authentication_strategy: input.authenticationStrategy,
        environment_id: input.environmentId,
        version: input.version,
        public_path: input.publicPath,
        inbound_security: inboundSecurity,
        request_schema_validation: input.requestSchemaValidation,
        enforcement_point_id: input.enforcementPointId,
        ...(input.a2a ? { a2a: input.a2a } : {}),
        document: input.document,
      }),
    },
  )
}

export async function classifyDiscoveredResources(
  tenantId: string,
  input: ClassifyDiscoveredResourcesInput,
) {
  return requestJson<Array<{ resource: ResourceRegistration }>>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/ai-activities/classify`,
    {
      method: "POST",
      body: JSON.stringify({
        correlation_id: `console-discovery-classification-${crypto.randomUUID()}`,
        resources: input.resources.map((resource) => ({
          source_resource_id: resource.sourceResourceId,
          resource_id: resource.resourceId,
          display_name: resource.displayName,
          capabilities: [
            {
              capability_id: input.capabilityId,
              display_name: input.capabilityName,
            },
          ],
        })),
        kind: input.kind,
        policy_defaults: {
          visibility: input.visibility,
          access: input.access,
        },
        authentication_strategy: input.authenticationStrategy,
        environment_id: input.environmentId,
        version: input.version,
        enforcement_point_id: input.enforcementPointId,
      }),
    },
  )
}

export async function decideAccessRequest(
  tenantId: string,
  requestId: string,
  decision:
    | { APPROVE: { valid_until: number } }
    | { DENY: { reason: string } },
) {
  return requestJson<unknown>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/access-requests/${encodeURIComponent(requestId)}/decision`,
    {
      method: "POST",
      body: JSON.stringify({
        correlation_id: `console-access-decision-${crypto.randomUUID()}`,
        decision,
      }),
    },
  )
}

export async function grantEmergencyAccess(
  tenantId: string,
  resourceId: string,
  capabilityId: string,
  reason: string,
  validForSeconds: number,
) {
  return requestJson<Entitlement>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/emergency-access`,
    {
      method: "POST",
      body: JSON.stringify({
        correlation_id: `console-emergency-access-${crypto.randomUUID()}`,
        resource_id: resourceId,
        capability_id: capabilityId,
        reason,
        valid_for_seconds: validForSeconds,
      }),
    },
  )
}

export async function revokeEntitlement(
  tenantId: string,
  entitlementId: string,
  reason: string,
) {
  return requestJson<Entitlement>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/entitlements/${encodeURIComponent(entitlementId)}/revoke`,
    {
      method: "POST",
      body: JSON.stringify({
        correlation_id: `console-entitlement-revoke-${crypto.randomUUID()}`,
        reason,
      }),
    },
  )
}

export interface ConnectionTestResult {
  connection_id: string
  configuration_revision: number
  checked_at: number
  duration_ms: number
  source: "CONTROL_PLANE"
  http_status: number | null
  passed: boolean
  check: "PROTECTED_ENDPOINT" | "MCP_DISCOVERY" | "HTTP_REACHABILITY" | "PROVIDER_CONNECTIVITY"
  reason_code: string
}

export function testResourceConnection(tenantId: string, resourceId: string, connectionId: string) {
  return requestJson<ConnectionTestResult>(`/v1/tenants/${encodeURIComponent(tenantId)}/resources/${encodeURIComponent(resourceId)}/connections/${encodeURIComponent(connectionId)}/test`, { method: "POST" })
}

export type { BotPolicyRules } from "@/domain/contracts"

type RuntimePolicyDraftContent = Extract<SaveRuntimePolicyDraftBody["content"], { kind: "RUNTIME_CAPABILITY" }>
export type RuntimePolicyDefinition = RuntimePolicyDraftContent["definition"]
export type RuntimePolicyScope = RuntimePolicyDefinition["scope"]
export type RuntimePolicyRule = RuntimePolicyDefinition["rules"][number]
export type RuntimePolicyAction = RuntimePolicyRule["actions"][number]
export type RuntimePolicyEffect = RuntimePolicyRule["effect"]
export type RuntimePolicyRole = RuntimePolicyScope["roles"][number]
export type RuntimePolicyConstraint = RuntimePolicyRule["constraints"][number]
export type RuntimePolicyObligation = RuntimePolicyRule["obligations"][number]
export type RuntimePolicyRevision = GetRuntimePolicy200

export interface RuntimePolicyDecision {
  tenant_id: string
  subject_id: string
  client_id: string
  bot_id: string
  runtime_id: string
  policy_id: string | null
  policy_display_name: string | null
  policy_revision: number | null
  capability_id: string
  action: RuntimePolicyAction
  target: string
  decision: RuntimePolicyEffect
  reason_code: string
  constraints: RuntimePolicyConstraint[]
  obligations: RuntimePolicyObligation[]
  matched_policy_refs?: Array<{ policy_id: string; policy_display_name: string; policy_revision: number; rule_ids: string[] }>
  correlation_id: string | null
  session_id: string | null
  evaluated_at: number
}

export type RuntimePolicyDraftDefinition = RuntimePolicyDefinition

export interface ResourcePolicyDefinition {
  one_policy_revision: number
  eligible_connection_ids?: string[]
  steps: EnforcementChainRevisionView["chain"]["steps"]
}
export type PolicyAuthoringSettings = GetPolicyAuthoringSettings200
type PolicyDraftResponse = Exclude<GetV1TenantsTenantIdOnePolicyFirstPartyBotDraft200, null>
export type PolicyDraftView = Omit<PolicyDraftResponse, "content"> & {
  content: { kind: "BOT_ACCESS"; definition: BotPolicyRules } | { kind: "RESOURCE_CAPABILITY"; definition: ResourcePolicyDefinition } | { kind: "RUNTIME_CAPABILITY"; definition: RuntimePolicyDraftDefinition }
}
export type PolicyDraftEvidence = Exclude<PolicyDraftResponse["validation"], null>
export type PolicyDraftSaveInput = Pick<PutV1TenantsTenantIdOnePolicyFirstPartyBotDraftBody, "expected_version" | "base_revision"> & { content: PolicyDraftView["content"] }

function projectPolicyDraft(value: PolicyDraftResponse): PolicyDraftView {
  return value as PolicyDraftView
}

function projectOptionalPolicyDraft(value: PolicyDraftResponse | null): PolicyDraftView | null {
  return value ? projectPolicyDraft(value) : null
}

export function policyDraftPath(tenantId: string, target?: { resourceId: string; capabilityId: string }) {
  return target
    ? getGetV1TenantsTenantIdResourcesResourceIdCapabilitiesCapabilityIdPolicyDraftUrl(tenantId, target.resourceId, target.capabilityId)
    : getGetV1TenantsTenantIdOnePolicyFirstPartyBotDraftUrl(tenantId)
}
export async function getPolicyAuthoringSettings(tenantId: string): Promise<PolicyAuthoringSettings> {
  return (await getPolicyAuthoringSettingsRequest(tenantId)).data
}
export async function savePolicyAuthoringSettings(tenantId: string, value: SavePolicyAuthoringSettingsBody): Promise<PolicyAuthoringSettings> {
  return (await savePolicyAuthoringSettingsRequest(tenantId, value)).data
}
export async function getPolicyDraft(path: string): Promise<PolicyDraftView | null> {
  return projectOptionalPolicyDraft(await requestJson<PolicyDraftResponse | null>(path))
}
export async function savePolicyDraft(path: string, value: PolicyDraftSaveInput): Promise<PolicyDraftView> {
  return projectPolicyDraft(await requestJson<PolicyDraftResponse>(path, { method: "PUT", body: JSON.stringify(value) }))
}
export function validatePolicyDraft(path: string, version: number, contentDigest: string) {
  const body: ValidateRuntimePolicyDraftBody = { expected_version: version, expected_content_digest: contentDigest }
  return requestJson<PolicyDraftResponse>(`${path}/validate`, { method: "POST", body: JSON.stringify(body) }).then(projectPolicyDraft)
}
export function reviewPolicyDraft(path: string, version: number, contentDigest: string) {
  const body: ReviewRuntimePolicyDraftBody = { expected_version: version, expected_content_digest: contentDigest }
  return requestJson<PolicyDraftResponse>(`${path}/review`, { method: "POST", body: JSON.stringify(body) }).then(projectPolicyDraft)
}
export function publishPolicyDraft<T>(path: string, version: number, contentDigest: string) {
  const body: PublishRuntimePolicyDraftBody = { expected_version: version, expected_content_digest: contentDigest }
  return requestJson<T>(`${path}/publish`, { method: "POST", body: JSON.stringify(body) })
}
export async function buildResourcePolicyDefinition(revision: number, processSteps: readonly EditableEnforcementProcessStep[], inboundSecurity: ApiInboundSecurity | undefined, requireConfirmation: boolean, connectionIds: string[], previous?: EnforcementChainRevisionView | null): Promise<ResourcePolicyDefinition> {
  const generated = await standardEnforcementSteps(processSteps, inboundSecurity, requireConfirmation)
  const steps = preservePolicySteps(generated, previous?.chain.steps ?? [], requireConfirmation)
  return { one_policy_revision: revision, eligible_connection_ids: connectionIds, steps: steps as ResourcePolicyDefinition["steps"] }
}
export function validateResourcePolicy(tenantId: string, resourceId: string, capabilityId: string, definition: ResourcePolicyDefinition) {
  return requestJson<unknown>(`/v1/tenants/${encodeURIComponent(tenantId)}/ai-gateway/enforcement-chain/preview`, { method: "POST", body: JSON.stringify({ ...definition, resource_id: resourceId, capability_id: capabilityId }) })
}

export type BotPolicyRevisionView = GetV1TenantsTenantIdOnePolicyFirstPartyBotRevisions200Item
export async function listBotPolicyRevisions(tenantId: string): Promise<BotPolicyRevisionView[]> {
  return (await getBotPolicyRevisionsRequest(tenantId)).data
}

export async function listPolicyDrafts(tenantId: string): Promise<Array<Omit<PolicyDraftView, "content">>> {
  return (await getPolicyDraftsRequest(tenantId)).data as Array<Omit<PolicyDraftView, "content">>
}
export function discardPolicyDraft(path: string, version: number) {
  const body: DiscardRuntimePolicyDraftBody = { expected_version: version }
  return requestJson<{ discarded: boolean }>(`${path}/discard`, { method: "POST", body: JSON.stringify(body) })
}

export function runtimePolicyPath(tenantId: string, policyId: string) {
  return `/v1/tenants/${encodeURIComponent(tenantId)}/one-policy/runtime-policies/${encodeURIComponent(policyId)}`
}

export async function listRuntimePolicies(tenantId: string): Promise<RuntimePolicyRevision[]> {
  return (await listRuntimePoliciesRequest(tenantId)).data
}

export async function getRuntimePolicy(tenantId: string, policyId: string): Promise<RuntimePolicyRevision> {
  return (await getRuntimePolicyRequest(tenantId, policyId)).data
}

export async function setRuntimePolicyEnabled(tenantId: string, policyId: string, expectedRevision: number, enabled: boolean): Promise<RuntimePolicyRevision> {
  const body: SetRuntimePolicyEnabledBody = { expected_revision: expectedRevision, enabled }
  return (await setRuntimePolicyEnabledRequest(tenantId, policyId, body)).data
}

export async function listRuntimePolicyRevisions(tenantId: string, policyId: string): Promise<RuntimePolicyRevision[]> {
  return (await listRuntimePolicyRevisionsRequest(tenantId, policyId)).data
}

export async function getRuntimePolicyRevision(tenantId: string, policyId: string, revision: number): Promise<RuntimePolicyRevision | null> {
  return (await getRuntimePolicyRevisionRequest(tenantId, policyId, revision)).data
}

export function runtimePolicyDraftPath(tenantId: string, policyId: string) {
  return getGetRuntimePolicyDraftUrl(tenantId, policyId)
}

export async function getRuntimePolicyDraft(tenantId: string, policyId: string): Promise<PolicyDraftView | null> {
  return projectOptionalPolicyDraft((await getRuntimePolicyDraftRequest(tenantId, policyId)).data)
}

export async function saveRuntimePolicyDraft(tenantId: string, policyId: string, value: SaveRuntimePolicyDraftBody): Promise<PolicyDraftView> {
  return projectPolicyDraft((await saveRuntimePolicyDraftRequest(tenantId, policyId, value)).data)
}

export async function discardRuntimePolicyDraft(tenantId: string, policyId: string, version: number): Promise<{ discarded: boolean }> {
  const body: DiscardRuntimePolicyDraftBody = { expected_version: version }
  return (await discardRuntimePolicyDraftRequest(tenantId, policyId, body)).data
}

export async function validateRuntimePolicyDraft(tenantId: string, policyId: string, version: number, contentDigest: string): Promise<PolicyDraftView> {
  const body: ValidateRuntimePolicyDraftBody = { expected_version: version, expected_content_digest: contentDigest }
  return projectPolicyDraft((await validateRuntimePolicyDraftRequest(tenantId, policyId, body)).data)
}

export async function reviewRuntimePolicyDraft(tenantId: string, policyId: string, version: number, contentDigest: string): Promise<PolicyDraftView> {
  const body: ReviewRuntimePolicyDraftBody = { expected_version: version, expected_content_digest: contentDigest }
  return projectPolicyDraft((await reviewRuntimePolicyDraftRequest(tenantId, policyId, body)).data)
}

export async function publishRuntimePolicyDraft(tenantId: string, policyId: string, version: number, contentDigest: string): Promise<RuntimePolicyRevision> {
  const body: PublishRuntimePolicyDraftBody = { expected_version: version, expected_content_digest: contentDigest }
  return (await publishRuntimePolicyDraftRequest(tenantId, policyId, body)).data
}

export interface InstalledConnector {
  kind: ConnectorKind
  display_name: string
  available: boolean
  resource_id: string
  connection_id: string
  configuration_required: boolean
  lifecycle: "DRAFT" | "ENABLED" | "DISABLED" | "REVOKE_PENDING" | "REVOKED"
}
export function listInstalledConnectors(tenantId: string) {
  return requestJson<InstalledConnector[]>(`/v1/tenants/${encodeURIComponent(tenantId)}/connectors`)
}

export interface UserPermissionPreview {
  subject_id: string
  subject_display_name: string
  actor_subject_id: string
  role: string
  organization_ids: string[]
  access_group_ids: string[]
  runtime_id: string
  client_id: string
  bot_id: string
  evaluated_at: number
  capabilities: Array<{ resource_id: string; resource_display_name: string; capability_id: string; capability_display_name: string; access: string; connection_status: string; restriction_reason: string | null }>
  bot_access: { decision: "ALLOW" | "DENY"; reason_code: string; policy_id: string; policy_revision: number }
  runtime_decisions: Array<RuntimePolicyDecision & { effective_decision: "ALLOW" | "DENY" }>
}

export function previewUserPermissions(tenantId: string, value: { subject_id: string; runtime_id: string; client_id: string; bot_id: string }) {
  return requestJson<UserPermissionPreview>(`/v1/tenants/${encodeURIComponent(tenantId)}/one-policy/permission-preview`, { method: "POST", body: JSON.stringify(value) })
}

export interface TelemetryLogRecord {
  record_id: string; details_loaded: boolean; timestamp_nanos: string; timestamp_millis: number; service: string; severity: string; body: string;
  trace_id: string; span_id: string; correlation_id: string; attributes: Record<string, string> | null; resource_attributes: Record<string, string> | null;
}
export function listTelemetryLogs(tenantId: string, filters: { event?: string; cursor?: string; search?: string; from?: number; until?: number; record_id?: string; timestamp_nanos?: string }) {
  return requestJson<{ records: TelemetryLogRecord[]; next_cursor: string | null }>(`/v1/tenants/${encodeURIComponent(tenantId)}/logs?${new URLSearchParams(Object.entries({ limit: 50, ...filters }).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]))}`)
}

export type IdentityProviderPreset = "google" | "github" | "entra-id" | "okta" | "oidc"

export interface IdentityProvider {
  alias: string
  preset: IdentityProviderPreset
  kind: "SOCIAL" | "OIDC"
  display_name: string
  enabled: boolean
  hidden_on_login_page: boolean
  trust_email: boolean
  client_id: string
  discovery_url?: string
  authorization_url?: string
  token_url?: string
  redirect_uri: string
}

export function listIdentityProviders(tenantId: string) {
  return requestJson<{ tenant_id: string; realm: string; providers: IdentityProvider[] }>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/identity-providers`,
  )
}

export function createIdentityProvider(tenantId: string, value: {
  preset: IdentityProviderPreset
  alias?: string
  display_name?: string
  client_id: string
  client_secret: string
  discovery_url?: string
  enabled?: boolean
  hidden_on_login_page?: boolean
  trust_email?: boolean
}) {
  return requestJson<IdentityProvider>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/identity-providers`,
    { method: "POST", body: JSON.stringify(value) },
  )
}

export function updateIdentityProvider(tenantId: string, alias: string, value: {
  display_name?: string
  client_id?: string
  client_secret?: string
  discovery_url?: string
  enabled?: boolean
  hidden_on_login_page?: boolean
  trust_email?: boolean
}) {
  return requestJson<IdentityProvider>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/identity-providers/${encodeURIComponent(alias)}`,
    { method: "PATCH", body: JSON.stringify(value) },
  )
}

export function deleteIdentityProvider(tenantId: string, alias: string) {
  return requestJson<null>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/identity-providers/${encodeURIComponent(alias)}`,
    { method: "DELETE" },
  )
}

export function suspendSubject(tenantId: string, subjectId: string, reason?: string) {
  return requestJson<TenantIdentityInventory["subjects"][number]>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/identity/subjects/${encodeURIComponent(subjectId)}/suspend`,
    { method: "POST", body: JSON.stringify(reason?.trim() ? { reason: reason.trim() } : {}) },
  )
}

export function restoreSubject(tenantId: string, subjectId: string) {
  return requestJson<TenantIdentityInventory["subjects"][number]>(
    `/v1/tenants/${encodeURIComponent(tenantId)}/identity/subjects/${encodeURIComponent(subjectId)}/restore`,
    { method: "POST" },
  )
}
