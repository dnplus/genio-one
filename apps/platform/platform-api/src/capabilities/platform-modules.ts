import { createPolicyDraftStore, type PolicyDraftStore } from "./one-policy/drafts"
import { generateKeyPairSync } from "node:crypto"

import { createInMemoryResourceConnectionRegistry } from "./connections/memory"
import type { ResourceConnectionRegistry } from "./connections/module"
import { createEnforcementChainCompiler } from "./enforcement/compiler"
import type { EnforcementChainCompiler } from "./enforcement/module"
import type { EnforcementChainRevisionReader } from "./enforcement/module"
import {
  createEphemeralEd25519Signer,
  createInMemoryGatewayProjector,
} from "./gateway-projection/memory"
import type { GatewayProjectionRepository } from "./gateway-projection/contract"
import type { GatewayProjector } from "./gateway-projection/module"
import { createDurableEd25519Signer } from "./gateway-projection/signer"
import { createInMemoryModelRouter } from "./model-routing/memory"
import type { ModelRouter } from "./model-routing/module"
import type { ModelRoutingPolicyStore } from "./model-routing/module"
import type { ModelRoutingDecisionProvider } from "./model-routing/decision-provider"
import { createInMemoryModelRoutingPolicyStore } from "./model-routing/policy-memory"
import { createInMemoryPublicModelCatalog } from "./models/memory"
import type { PublicModelCatalog } from "./models/module"
import { createInMemoryOrganizationDirectory } from "./organizations/memory"
import type { OrganizationDirectory } from "./organizations/module"
import { createInMemoryProviderProfileCatalog } from "./providers/memory"
import type { ProviderProfileCatalog } from "./providers/module"
import { createInMemoryProviderCredentialProfileStore } from "./provider-credentials/memory"
import type { ProviderCredentialProfileStore } from "./provider-credentials/module"
import { createInMemoryResourceRegistry } from "./resources/memory"
import type { ResourceRegistry } from "./resources/module"
import { createModelMemoryState } from "./models/state"
import { createResourceMemoryState } from "./resources/state"
import {
  createAiResourcePublicationWorkflow,
  createInMemoryPublicationWorkflowStore,
} from "./publications/memory"
import { createInMemoryEnforcementChainReader } from "./enforcement/memory"
import type { AiResourcePublicationWorkflow } from "./publications/module"
import { createInMemoryModelEntitlementCatalog } from "./entitlements/memory"
import type { ModelEntitlementCatalog } from "./entitlements/module"
import { createInMemoryRuntimeControlStore } from "./runtime-control/memory"
import type {
  RegisterGatewayRuntimeInput,
  RuntimeControlStore,
} from "./runtime-control/contract"
import type { GatewayAggregateRuntimeControlStore } from "./gateway-runtime-control/contract"
import { createInMemoryGatewayAggregateRuntimeControlStore } from "./gateway-runtime-control/memory"
import type { GatewayReleasePackageSource } from "./gateway-policy-release/package-source"
import type { GatewayPolicyReleaseRenewal } from "./gateway-policy-release/renewal"
import { createInMemoryGatewayAggregatePublicationModule } from "./gateway-policy-release/memory-delivery"
import { createInMemoryGatewayActivityStore } from "./activities/memory"
import { createInMemoryUsageGovernanceDirectory } from "./usage-governance/directory"
import type { UsageGovernanceDirectory } from "./usage-governance/directory"
import { createInMemoryAccountingLedger, type AccountingLedger } from "./usage-governance/accounting"
import { createInMemoryUsageCounterStore } from "./usage-governance/memory-counter"
import type { UsageCounterStore } from "./usage-governance/admission"
import type { GatewayActivityDetailStore } from "./activities/detail-module"
import type { GatewayActivityMaterializer, GatewayActivityStore } from "./activities/module"
import type { TraceStore } from "./traces/module"
import { createInMemoryTraceStore } from "./traces/memory"
import type { GatewayMetricsStore } from "./metrics/module"
import { createInMemoryGatewayMetricsStore } from "./metrics/memory"
import type { IdentityDirectory } from "./identity/module"
import { createInMemoryIdentityDirectory } from "./identity/memory"
import { createAccessGroupDirectory, type AccessGroupDirectory } from "./access-groups/module"
import { createInMemoryAccessGroupRepository } from "./access-groups/memory"
import { createInMemoryGatewayAuthorizationAuditStore } from "./audit-events/memory"
import type { GatewayAuthorizationAuditStore } from "./audit-events/module"
import type { ApplicationRegistry } from "./applications/module"
import { createInMemoryApplicationRegistry } from "./applications/memory"
import type { FederationService } from "./federation/module"
import { createInMemoryFederationService } from "./federation/memory"
import type { SiemForwarder } from "./siem/module"
import { createInMemorySiemForwarder } from "./siem/memory"
import type { NotificationSubscriptionStore } from "./notifications/module"
import { createInMemoryNotificationSubscriptionStore } from "./notifications/memory"
import type { TenantConfigurationStore } from "./configuration/module"
import { createInMemoryTenantConfigurationStore } from "./configuration/memory"
import type { AccessGovernanceStore } from "./access/module"
import { createInMemoryAccessGovernanceStore } from "./access/memory"
import type { McpDiscoveryStore } from "./mcp-discovery/module"
import { createInMemoryMcpDiscoveryStore } from "./mcp-discovery/memory"
import { createPersonalCredentials, createMemoryPasswordCredentialStore, type PersonalCredentials } from "./personal-credentials/module"
import { createMcpOAuthSecretCodec } from "./mcp-oauth/crypto"
import { createInMemoryMcpOAuthStore } from "./mcp-oauth/memory"
import { createMcpOAuthService } from "./mcp-oauth/module"
import type { McpOAuthService } from "./mcp-oauth/module"
import { createInMemoryGatewayDiagnosticSettingsStore } from "./gateway-settings/memory"
import type { GatewayDiagnosticSettingsStore } from "./gateway-settings/module"
import type { GatewayRegistrationLifecycle } from "./gateway-registration/module"
import { createGatewayRegistrationLifecycle } from "./gateway-registration/module"
import { createInMemoryGatewayRegistrationRepository } from "./gateway-registration/memory"
import { createInMemoryEndpointActivityStore } from "./endpoint-activities/memory"
import type { EndpointActivityStore } from "./endpoint-activities/module"
import { createInMemoryEndpointRuntimeStore } from "./endpoint-runtime/memory"
import type { EndpointRuntimeStore } from "./endpoint-runtime/module"
import { createInMemoryAgentDelegationRepository } from "./agent-delegations/memory"
import { createAgentDelegationDirectory, type AgentDelegationDirectory } from "./agent-delegations/module"
import { createInMemoryExecutionGrantRepository } from "./execution-grants/memory"
import { createExecutionGrantDirectory, type ExecutionGrantDirectory } from "./execution-grants/module"
import type { OnePolicy } from "./one-policy/module"
import { createDefaultOnePolicy } from "./one-policy/default"
import { createInMemoryRuntimePolicyStore } from "./one-policy/runtime-memory"
import { PERSONAL_BOT_RESOURCE_ID } from "./one-policy/runtime"
import { createInMemoryDemoInstallationStore } from "./demo-project/memory"
import type { DemoInstallationStore } from "./demo-project/module"
import { createProcessorAdapterCatalog, type ProcessorAdapterCatalog } from "./processor-adapters/catalog"
import {
  PROCESSOR_ADAPTERS_SCHEMA_VERSION,
  type ProcessorAdapterRegistry,
} from "../../../../../runtimes/gateway/services/shared/processor-adapters"

/**
 * Complete aggregate-release transport dependencies.  The pair is optional
 * only for memory-dev graphs that do not model immutable Gateway releases;
 * production composes both from the same PostgreSQL graph.
 */
export interface GatewayAggregateRuntimeControlModule {
  store: GatewayAggregateRuntimeControlStore
  packages: GatewayReleasePackageSource
}

/**
 * One coherent capability graph for a Management API process.
 *
 * Callers inject the whole graph. Mixing adapters from unrelated in-memory,
 * legacy and PostgreSQL graphs would let one request write state that another
 * module cannot observe.
 */
export interface PlatformModuleGraph {
  organizations: OrganizationDirectory
  applications: ApplicationRegistry
  federation: FederationService
  resources: ResourceRegistry
  connections: ResourceConnectionRegistry
  providers: ProviderProfileCatalog
  providerCredentials: ProviderCredentialProfileStore
  models: PublicModelCatalog
  entitlements: ModelEntitlementCatalog
  modelRouter: ModelRouter
  modelRoutingPolicies: ModelRoutingPolicyStore
  enforcementCompiler: EnforcementChainCompiler
  processorAdapters: ProcessorAdapterCatalog
  policyDrafts: PolicyDraftStore
  enforcementRevisionStore: EnforcementChainRevisionReader
  gatewayProjector: GatewayProjector
  gatewayProjections: GatewayProjectionRepository
  runtimeControl: RuntimeControlStore
  gatewayAggregateRuntimeControl?: GatewayAggregateRuntimeControlModule
  gatewayPolicyReleaseRenewal?: GatewayPolicyReleaseRenewal
  publicationWorkflow: AiResourcePublicationWorkflow
  activities: GatewayActivityStore
  usageGovernance: UsageGovernanceDirectory
  accountingLedger: (tenantId: string) => AccountingLedger
  usageCounterStore: UsageCounterStore
  endpointActivities: EndpointActivityStore
  endpointRuntime: EndpointRuntimeStore
  activityDetails?: GatewayActivityDetailStore
  activityMaterializer?: GatewayActivityMaterializer
  traces: TraceStore
  metrics: GatewayMetricsStore
  identity: IdentityDirectory
  accessGroups: AccessGroupDirectory
  auditEvents: GatewayAuthorizationAuditStore
  siem: SiemForwarder
  notifications: NotificationSubscriptionStore
  configuration: TenantConfigurationStore
  access: AccessGovernanceStore
  mcpDiscovery: McpDiscoveryStore
  personalCredentials: PersonalCredentials
  mcpOAuth: McpOAuthService
  gatewayDiagnosticSettings: GatewayDiagnosticSettingsStore
  gatewayRegistrations: GatewayRegistrationLifecycle
  agentDelegations: AgentDelegationDirectory
  executionGrants: ExecutionGrantDirectory
  botAccessPolicy: OnePolicy
  demoInstallations: DemoInstallationStore
}

export type InMemoryPlatformModules = PlatformModuleGraph

export interface InMemoryPlatformOptions {
  now?: () => number
  processorAdapterRegistry?: ProcessorAdapterRegistry
  /** Supplying this enables strict in-memory publication delivery for runtime tests. */
  runtimeRegistrations?: readonly RegisterGatewayRuntimeInput[]
  runtimeReportKeyId?: string
  runtimeReportPublicKeyPem?: string
  connectionEnabled?: (input: { tenantId: string; botId: string }) => Promise<boolean> | boolean
  modelRoutingDecisionProvider?: ModelRoutingDecisionProvider
  modelRoutingDecisionMinimumConfidence?: number
}

export function createInMemoryPlatformModules(
  options: InMemoryPlatformOptions = {},
): InMemoryPlatformModules {
  const organizations = createInMemoryOrganizationDirectory({ now: options.now })
  const identity = createInMemoryIdentityDirectory()
  const auditEvents = createInMemoryGatewayAuthorizationAuditStore()
  const accessGroups = createAccessGroupDirectory({
    repository: createInMemoryAccessGroupRepository({ audit: auditEvents }),
    identity,
    now: options.now,
  })
  const applications = createInMemoryApplicationRegistry({
    identity,
    organizations,
    now: options.now,
  })
  const federation = createInMemoryFederationService({
    now: options.now,
    async applicationSubject({ tenantId, applicationId }) {
      return (await applications.list({ tenantId }))
        .find((application) => application.application_id === applicationId)?.subject_id ?? null
    },
  })
  const resourceState = createResourceMemoryState()
  const resources = createInMemoryResourceRegistry({
    state: resourceState,
    organizations,
    now: options.now,
  })
  const providers = createInMemoryProviderProfileCatalog({ now: options.now })
  const providerCredentials = createInMemoryProviderCredentialProfileStore({ now: options.now })
  const connections = createInMemoryResourceConnectionRegistry({
    state: resourceState,
    resources,
    providers,
    providerCredentials,
    now: options.now,
    // memory-dev is an explicit mock runtime; production injects a trusted
    // provider/runtime verifier and never accepts a caller-supplied READY.
    verifier: { verify: () => true },
  })
  const modelState = createModelMemoryState()
  const models = createInMemoryPublicModelCatalog({
    state: modelState,
    resources,
    connections,
    providers,
    now: options.now,
  })
  const modelRouter = createInMemoryModelRouter({
    state: modelState,
    models,
    now: options.now,
    decisionProvider: options.modelRoutingDecisionProvider,
    decisionMinimumConfidence: options.modelRoutingDecisionMinimumConfidence,
  })
  const modelRoutingPolicies = createInMemoryModelRoutingPolicyStore({ now: options.now })
  const entitlements = createInMemoryModelEntitlementCatalog({ now: options.now, models })
  const agentDelegations = createAgentDelegationDirectory({
    repository: createInMemoryAgentDelegationRepository(),
    identity,
    entitlements,
    now: options.now,
  })
  const executionGrants = createExecutionGrantDirectory({
    repository: createInMemoryExecutionGrantRepository(),
    entitlements,
    resources,
    organizations,
    now: options.now,
  })
  const processorAdapters = createProcessorAdapterCatalog(
    options.processorAdapterRegistry ?? {
      schema_version: PROCESSOR_ADAPTERS_SCHEMA_VERSION,
      adapters: [],
    },
  )
  const enforcementCompiler = createEnforcementChainCompiler({
    resources,
    connections,
    processorAdapters,
  })
  const policyDrafts = createPolicyDraftStore({ now: options.now, audit: auditEvents })
  const enforcementRevisionStore = createInMemoryEnforcementChainReader({
    drafts: policyDrafts,
    compiler: enforcementCompiler,
    audit: auditEvents,
    now: options.now,
  })
  const signer = createEphemeralEd25519Signer()
  const memorySigner = (keyId: string) => {
    const key = generateKeyPairSync("ed25519")
    return createDurableEd25519Signer({
      privateKeyPem: key.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      keyId,
    })
  }
  const runtimeCommandSigner = memorySigner("memory-runtime-command")
  const artifactSigner = memorySigner("memory-policy-artifact")
  const releaseRootSigner = memorySigner("memory-release-root")
  const runtimeControl = createInMemoryRuntimeControlStore({
    now: options.now,
    registrations: options.runtimeRegistrations,
  })
  const gatewayAggregateRuntimeControlStore = createInMemoryGatewayAggregateRuntimeControlStore({
    registrations: runtimeControl,
    signer: runtimeCommandSigner,
    now: options.now,
  })
  const aggregatePublication = createInMemoryGatewayAggregatePublicationModule({
    projections: () => [...resourceState.publicationProjections.values()],
    resources,
    connections,
    models,
    entitlements,
    routingPolicies: modelRoutingPolicies,
    registrations: runtimeControl,
    aggregate: gatewayAggregateRuntimeControlStore,
    artifactSigner,
    releaseRootSigner,
  })
  const publicationStore = createInMemoryPublicationWorkflowStore({
    state: resourceState,
    resources,
    connections,
    models,
    chains: enforcementRevisionStore,
    now: options.now,
    gatewayDelivery: aggregatePublication.delivery,
  })
  const gatewayProjector = createInMemoryGatewayProjector({
    source: publicationStore,
    signer,
    allowEphemeralSigner: true,
  })
  const publicationWorkflow = createAiResourcePublicationWorkflow({
    resources,
    connections,
    providerCredentials,
    models,
    chains: enforcementRevisionStore,
    store: publicationStore,
    projector: gatewayProjector,
    now: options.now,
  })
  const activities = createInMemoryGatewayActivityStore()
  const usageGovernance = createInMemoryUsageGovernanceDirectory()
  const accountingLedgers = new Map<string, AccountingLedger>()
  const accountingLedger = (tenantId: string) => {
    const existing = accountingLedgers.get(tenantId)
    if (existing) return existing
    const created = createInMemoryAccountingLedger()
    accountingLedgers.set(tenantId, created)
    return created
  }
  const usageCounterStore = createInMemoryUsageCounterStore()
  const endpointActivities = createInMemoryEndpointActivityStore()
  const endpointRuntime = createInMemoryEndpointRuntimeStore({ now: options.now })
  const traces = createInMemoryTraceStore()
  const metrics = createInMemoryGatewayMetricsStore()
  const siem = createInMemorySiemForwarder({ now: options.now })
  const notifications = createInMemoryNotificationSubscriptionStore({ now: options.now })
  const configuration = createInMemoryTenantConfigurationStore({ now: options.now })
  const access = createInMemoryAccessGovernanceStore({
    resources,
    entitlements,
    configuration,
    identity,
    organizations,
    now: options.now,
  })
  const mcpDiscovery = createInMemoryMcpDiscoveryStore({
    state: resourceState,
    resources,
    connections,
    now: options.now,
  })
  const personalCredentials = createPersonalCredentials({ identity, store: createMemoryPasswordCredentialStore(), connections, codec: createMcpOAuthSecretCodec(Buffer.alloc(32)) })
  const mcpOAuth = createMcpOAuthService({
    store: createInMemoryMcpOAuthStore(),
    connections,
    identity,
    codec: createMcpOAuthSecretCodec(Buffer.alloc(32)),
    publicOrigin: "http://127.0.0.1:58082",
    managementUiOrigin: "http://127.0.0.1:5173",
    now: options.now,
  })
  const gatewayDiagnosticSettings = createInMemoryGatewayDiagnosticSettingsStore({
    now: options.now,
  })
  const gatewayRegistrations = createGatewayRegistrationLifecycle({
    repository: createInMemoryGatewayRegistrationRepository({ now: options.now }),
    provisioner: {
      async provision({ clientId }) {
        return {
          issuer: "http://127.0.0.1:58080/realms/genio-one",
          token_endpoint: "http://127.0.0.1:58080/realms/genio-one/protocol/openid-connect/token",
          audience: "genio-one-product-api",
          scope: "genioone-gateway-runtime",
          client_id: clientId,
          client_secret: `memory-${clientId}`,
        }
      },
      async revoke() {},
    },
    runtimeControl,
    platformOrigin: "http://127.0.0.1:58082",
    defaultGatewayId: "genio-ai-mcp-gateway",
    runtimeCommandVerificationKeys: {
      schema_version: 1,
      keys: [{ key_id: runtimeCommandSigner.keyId, public_key_pem: runtimeCommandSigner.publicKeyPem }],
    },
    policyReleaseRootKeys: {
      schema_version: 1,
      keys: [{ key_id: releaseRootSigner.keyId, public_key_pem: releaseRootSigner.publicKeyPem }],
    },
  })
  const botAccessPolicy = createDefaultOnePolicy({
    drafts: policyDrafts,
    runtimeStore: createInMemoryRuntimePolicyStore({ now: options.now, drafts: policyDrafts, audit: auditEvents }),
    runtimeAuditSink: auditEvents,
    policyAuditSink: auditEvents,
    accessGroups,
    connectionEnabled: options.connectionEnabled ?? (async ({ tenantId }) => {
      try {
        const connectionsForBot = await connections.list({ tenantId, resourceId: PERSONAL_BOT_RESOURCE_ID })
        return connectionsForBot.some((connection) => connection.resource_id === PERSONAL_BOT_RESOURCE_ID && connection.connection_id === PERSONAL_BOT_RESOURCE_ID && connection.lifecycle === "ENABLED")
      } catch {
        return false
      }
    }),
    ...(options.now ? { now: options.now } : {}),
    ...(options.runtimeReportKeyId ? { runtimeReportKeyId: options.runtimeReportKeyId } : {}),
    ...(options.runtimeReportPublicKeyPem ? { runtimeReportPublicKeyPem: options.runtimeReportPublicKeyPem } : {}),
  })
  const demoInstallations = createInMemoryDemoInstallationStore()
  return {
    organizations,
    applications,
    federation,
    resources,
    connections,
    providers,
    providerCredentials,
    models,
    entitlements,
    agentDelegations,
    executionGrants,
    modelRouter,
    modelRoutingPolicies,
    enforcementCompiler,
    processorAdapters,
    policyDrafts,
    enforcementRevisionStore,
    gatewayProjector,
    gatewayProjections: publicationStore,
    runtimeControl,
    gatewayAggregateRuntimeControl: {
      store: gatewayAggregateRuntimeControlStore,
      packages: aggregatePublication.packages,
    },
    publicationWorkflow,
    activities,
    usageGovernance,
    accountingLedger,
    usageCounterStore,
    endpointActivities,
    endpointRuntime,
    traces,
    metrics,
    identity,
    accessGroups,
    auditEvents,
    siem,
    notifications,
    configuration,
    access,
    mcpDiscovery,
    mcpOAuth,
    personalCredentials,
    gatewayDiagnosticSettings,
    gatewayRegistrations,
    botAccessPolicy,
    demoInstallations,
  }
}
