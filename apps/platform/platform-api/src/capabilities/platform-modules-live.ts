import { createPolicyDraftStore } from "./one-policy/drafts"
import { createEnforcementChainCompiler } from "./enforcement/compiler"
import { createPostgresEnforcementChainRevisionStore } from "./enforcement/postgres"
import {
  createInMemoryGatewayProjector,
} from "./gateway-projection/memory"
import type {
  GatewayProjectionRendererOptions,
} from "./gateway-projection/contract"
import type { DurableEd25519Signer } from "./gateway-projection/signer"
import { createValkeyModelRouter } from "./model-routing/valkey"
import type {
  ValkeyModelRouterOptions,
  ValkeySessionLeaseClient,
} from "./model-routing/valkey"
import type { ModelRoutingDecisionProvider } from "./model-routing/decision-provider"
import {
  createPostgresPlatformModules,
} from "./platform-modules-postgres"
import type { PostgresPlatformModulesOptions } from "./platform-modules-postgres"
import type { SqlAdapter } from "../persistence/sql-adapter"
import { PlatformApiError } from "./errors"
import type { ConnectionVerifier } from "./connections/module"
import type { PublicationDnsVerifier } from "./resources/module"
import { createAiResourcePublicationWorkflow } from "./publications/memory"
import { createPostgresPublicationWorkflowStore } from "./publications/postgres"
import { createPostgresRuntimeControlStore } from "./runtime-control/postgres"
import {
  type GatewayAggregateRuntimeControlModule,
  type PlatformModuleGraph as BasePlatformModuleGraph,
} from "./platform-modules"
import { createPostgresGatewayAggregateRuntimeControlStore } from "./gateway-runtime-control/postgres"
import { createPostgresGatewayPolicyReleaseStore } from "./gateway-policy-release/postgres"
import type { GatewayPolicyReleaseStore } from "./gateway-policy-release/module"
import { createGatewayReleasePackageSource } from "./gateway-policy-release/package-source"
import { createGatewayPolicyReleaseRenewal } from "./gateway-policy-release/renewal"
import {
  createAggregateGatewayPublicationDelivery,
  createAggregateGatewayLifecycleReleasePublisher,
} from "./gateway-policy-release/delivery"
import { createGatewayPublicationReleaseCoordinator } from "./gateway-policy-release/publication-commit"
import { createPostgresGatewayActiveProjectionSetSource } from "./gateway-policy-release/active-projections"
import { createPostgresGatewayPolicyInputSource } from "./gateway-policy-release/policy-inputs"
import type { CompactJwsSigner } from "./gateway-policy-release/contract"
import { createPostgresGatewayActivityStore } from "./activities/postgres"
import { createPostgresEndpointActivityStore } from "./endpoint-activities/postgres"
import { createPostgresEndpointRuntimeStore } from "./endpoint-runtime/postgres"
import { createClickHouseGatewayActivityMaterializer } from "./activities/otel-clickhouse"
import { createClickHouseGatewayActivityDetailStore } from "./activities/detail-clickhouse"
import { createPostgresGatewayAuthorizationAuditStore } from "./audit-events/postgres"
import { createPostgresModelPriceCatalog } from "./pricing-catalog/postgres"
import { createValkeyUsageCounterStore, type ValkeyEvalClient } from "../../../../../runtimes/gateway/services/shared/usage-governance-valkey"
import { createClickHouseTraceStore } from "./traces/clickhouse"
import { createClickHouseGatewayMetricsStore } from "./metrics/clickhouse"
import { createPostgresIdentityDirectory } from "./identity/postgres"
import { createAccessGroupDirectory } from "./access-groups/module"
import { createPostgresAccessGroupRepository } from "./access-groups/postgres"
import { createPostgresSiemForwarder } from "./siem/postgres"
import { createPostgresNotificationSubscriptionStore } from "./notifications/postgres"
import { createPostgresTenantConfigurationStore } from "./configuration/postgres"
import { createPostgresAccessGovernanceStore } from "./access/postgres"
import { createPostgresMcpDiscoveryStore } from "./mcp-discovery/postgres"
import { createPersonalCredentials, createPostgresPasswordCredentialStore } from "./personal-credentials/module"
import { createMcpOAuthSecretCodec } from "./mcp-oauth/crypto"
import { createMcpOAuthService } from "./mcp-oauth/module"
import { createPostgresMcpOAuthStore } from "./mcp-oauth/postgres"
import {
  createPostgresGatewayDiagnosticSettingsSource,
  createPostgresGatewayDiagnosticSettingsStore,
} from "./gateway-settings/postgres"
import type { GatewayIdentityProvisioner } from "./gateway-registration/module"
import type { ApplicationOAuthClientProvisioner } from "./applications/module"
import type { ApplicationTokenBroker, WorkloadAssertionVerifier } from "./federation/module"
import { createGatewayRegistrationLifecycle } from "./gateway-registration/module"
import { createPostgresGatewayRegistrationRepository } from "./gateway-registration/postgres"
import { createPostgresAgentDelegationRepository } from "./agent-delegations/postgres"
import { createAgentDelegationDirectory } from "./agent-delegations/module"
import { createPostgresExecutionGrantRepository } from "./execution-grants/postgres"
import { createExecutionGrantDirectory } from "./execution-grants/module"
import type { OnePolicy } from "./one-policy/module"
import { createDefaultOnePolicy } from "./one-policy/default"
import { createPostgresOnePolicySeedStore } from "./one-policy/postgres"
import { createPostgresRuntimePolicyStore } from "./one-policy/runtime-postgres"
import { PERSONAL_BOT_RESOURCE_ID } from "./one-policy/runtime"
import { createPostgresDemoInstallationStore } from "./demo-project/postgres"

/**
 * The complete production capability graph. Every stateful capability is
 * composed from the same PostgreSQL adapter; Valkey is used only for the
 * short-lived session route lease and the projection signer is mandatory.
 */
export interface PlatformModuleGraph extends BasePlatformModuleGraph {
  sql: SqlAdapter
  gatewayPolicyReleases: GatewayPolicyReleaseStore
  gatewayAggregateRuntimeControl: GatewayAggregateRuntimeControlModule
}

export interface LivePlatformModuleGraphOptions
  extends Pick<PostgresPlatformModulesOptions, "sql" | "now" | "idFactory"> {
  /** An already-connected Valkey/Redis client. The caller owns its lifecycle. */
  valkey: ValkeySessionLeaseClient & ValkeyEvalClient
  clickhouse?: {
    origin: string
    database: string
    username: string
    password: string
  }
  /** Independent durable signing roles; no two roles may share a key id. */
  signingRoles: {
    projection: DurableEd25519Signer
    runtimeCommand: DurableEd25519Signer
    policyArtifact: DurableEd25519Signer
    releaseRoot: DurableEd25519Signer
  }
  runtimeReportKeyId?: string
  runtimeReportPublicKeyPem?: string
  /** Validity window for one immutable policy release. */
  gatewayReleaseTtlSeconds: number
  subjectAliases?: Readonly<Record<string, readonly string[]>>
  renderer?: GatewayProjectionRendererOptions
  leaseIdFactory?: ValkeyModelRouterOptions["idFactory"]
  modelRoutingDecisionProvider?: ModelRoutingDecisionProvider
  modelRoutingDecisionMinimumConfidence?: number
  connectionVerifier?: ConnectionVerifier
  publicationDnsVerifier?: PublicationDnsVerifier
  mcpOAuthEncryptionKey: Uint8Array
  mcpOAuthPublicOrigin: string
  managementUiOrigin: string
  platformOrigin: string
  defaultGatewayId: string
  gatewayIdentityProvisioner: GatewayIdentityProvisioner
  applicationOAuthProvisioner?: ApplicationOAuthClientProvisioner
  applicationTokenBroker: ApplicationTokenBroker
  workloadAssertionVerifier: WorkloadAssertionVerifier
}

/**
 * Compose the TypeScript Control Plane graph over durable stores.
 *
 * This constructor intentionally has no memory fallback. Callers must provide
 * PostgreSQL, a connected Valkey client and a durable projection signer before
 * the live graph can be created.
 */
export function createPlatformModuleGraph(
  options: LivePlatformModuleGraphOptions,
): PlatformModuleGraph {
  assertSigningRoles(options.signingRoles)
  if (
    !Number.isSafeInteger(options.gatewayReleaseTtlSeconds) ||
    options.gatewayReleaseTtlSeconds < 1
  ) {
    throw new Error("gatewayReleaseTtlSeconds must be a positive integer")
  }
  const runtimeControl = createPostgresRuntimeControlStore({
    sql: options.sql,
    now: options.now,
  })
  const gatewayPolicyReleases = createPostgresGatewayPolicyReleaseStore({
    sql: options.sql,
  })
  const gatewayAggregateRuntimeControl = createPostgresGatewayAggregateRuntimeControlStore({
    sql: options.sql,
    signer: options.signingRoles.runtimeCommand,
    now: options.now,
    idFactory: options.idFactory,
  })
  const artifactSigner = compactJwsSigner(options.signingRoles.policyArtifact)
  const releaseRootSigner = compactJwsSigner(options.signingRoles.releaseRoot)
  const gatewaySettingsSource = createPostgresGatewayDiagnosticSettingsSource()
  const aggregateCoordinator = createGatewayPublicationReleaseCoordinator({
    activeProjections: createPostgresGatewayActiveProjectionSetSource(),
    policyInputs: createPostgresGatewayPolicyInputSource(),
    gatewaySettings: gatewaySettingsSource,
    runtimeSelector: gatewayAggregateRuntimeControl,
    releases: gatewayPolicyReleases,
    scheduler: gatewayAggregateRuntimeControl,
    artifactSigner,
    releaseRootSigner,
    verificationKeys: {
      schema_version: 1,
      keys: [{
        key_id: options.signingRoles.policyArtifact.keyId,
        public_key_pem: options.signingRoles.policyArtifact.publicKeyPem,
      }],
    },
    releaseTtlSeconds: options.gatewayReleaseTtlSeconds,
    subjectAliases: options.subjectAliases,
  })
  const gatewayPolicyReleaseRenewal = createGatewayPolicyReleaseRenewal({
    sql: options.sql,
    coordinator: aggregateCoordinator,
    now: options.now,
    releaseTtlSeconds: options.gatewayReleaseTtlSeconds,
  })
  const lifecycleReleasePublisher =
    createAggregateGatewayLifecycleReleasePublisher(aggregateCoordinator)
  const gatewayDiagnosticSettings = createPostgresGatewayDiagnosticSettingsStore({
    sql: options.sql,
    releasePublisher: lifecycleReleasePublisher,
    now: options.now,
  })
  const gatewayRegistrations = createGatewayRegistrationLifecycle({
    repository: createPostgresGatewayRegistrationRepository({ sql: options.sql }),
    provisioner: options.gatewayIdentityProvisioner,
    runtimeControl,
    platformOrigin: options.platformOrigin,
    defaultGatewayId: options.defaultGatewayId,
    runtimeCommandVerificationKeys: {
      schema_version: 1,
      keys: [{
        key_id: options.signingRoles.runtimeCommand.keyId,
        public_key_pem: options.signingRoles.runtimeCommand.publicKeyPem,
      }],
    },
    policyReleaseRootKeys: {
      schema_version: 1,
      keys: [{
        key_id: options.signingRoles.releaseRoot.keyId,
        public_key_pem: options.signingRoles.releaseRoot.publicKeyPem,
      }],
    },
  })
  const postgres = createPostgresPlatformModules({
    providerCredentialCodec: createMcpOAuthSecretCodec(options.mcpOAuthEncryptionKey),
    sql: options.sql,
    now: options.now,
    idFactory: options.idFactory,
    connectionVerifier: options.connectionVerifier,
    publicationDnsVerifier: options.publicationDnsVerifier,
    lifecycleReleasePublisher,
    applicationOAuthProvisioner: options.applicationOAuthProvisioner,
    applicationTokenBroker: options.applicationTokenBroker,
    workloadAssertionVerifier: options.workloadAssertionVerifier,
  })
  const modelRouter = createValkeyModelRouter({
    client: options.valkey,
    models: postgres.models,
    now: options.now,
    idFactory: options.leaseIdFactory,
    decisionProvider: options.modelRoutingDecisionProvider,
    decisionMinimumConfidence: options.modelRoutingDecisionMinimumConfidence,
  })
  const enforcementCompiler = createEnforcementChainCompiler({
    resources: postgres.resources,
    connections: postgres.connections,
  })
  const auditEvents = createPostgresGatewayAuthorizationAuditStore({ sql: postgres.sql })
  const policyDrafts = createPolicyDraftStore({ sql: postgres.sql, now: options.now, audit: auditEvents })
  const enforcementRevisionStore = createPostgresEnforcementChainRevisionStore({
    sql: postgres.sql,
    now: options.now,
    releasePublisher: createAggregateGatewayLifecycleReleasePublisher(aggregateCoordinator),
    audit: auditEvents,
  })
  const publicationStore = createPostgresPublicationWorkflowStore({
    sql: postgres.sql,
    resources: postgres.resources,
    now: options.now,
    idFactory: options.idFactory,
    gatewayPublicationDelivery: createAggregateGatewayPublicationDelivery(aggregateCoordinator),
  })
  const gatewayReleasePackages = createGatewayReleasePackageSource({
    releases: gatewayPolicyReleases,
    projections: publicationStore,
  })
  const gatewayProjector = createInMemoryGatewayProjector({
    ...options.renderer,
    // This is a stateless renderer. Its only state input is the immutable
    // Publication review snapshot resolved by the PostgreSQL aggregate.
    source: publicationStore,
    signer: options.signingRoles.projection,
    allowEphemeralSigner: false,
  })
  const publicationWorkflow = createAiResourcePublicationWorkflow({
    resources: postgres.resources,
    connections: postgres.connections,
    providerCredentials: postgres.providerCredentials,
    models: postgres.models,
    chains: enforcementRevisionStore,
    store: publicationStore,
    projector: gatewayProjector,
    now: options.now,
    idFactory: options.idFactory,
  })
  const priceCatalog = createPostgresModelPriceCatalog({ sql: postgres.sql })
  const activities = createPostgresGatewayActivityStore({
    sql: postgres.sql,
    costEstimator: priceCatalog,
    connections: postgres.connections,
  })
  const endpointActivities = createPostgresEndpointActivityStore({
    sql: postgres.sql,
    idFactory: options.idFactory ? () => options.idFactory!("activity") : undefined,
  })
  const endpointRuntime = createPostgresEndpointRuntimeStore({
    sql: postgres.sql,
    now: options.now,
  })
  const runtimePolicyStore = createPostgresRuntimePolicyStore({ sql: postgres.sql, now: options.now, audit: auditEvents })
  const activityMaterializer = options.clickhouse
    ? createClickHouseGatewayActivityMaterializer({
        ...options.clickhouse,
        activities,
        audits: auditEvents,
        connections: postgres.connections,
      })
    : undefined
  const activityDetails = options.clickhouse
    ? createClickHouseGatewayActivityDetailStore(options.clickhouse)
    : undefined
  const traces = options.clickhouse
    ? createClickHouseTraceStore(options.clickhouse)
    : { spans: async () => { throw Object.assign(new Error("TELEMETRY_STORE_UNAVAILABLE"), { statusCode: 503 }) }, list: async () => { throw Object.assign(new Error("TELEMETRY_STORE_UNAVAILABLE"), { statusCode: 503 }) }, logs: async () => { throw Object.assign(new Error("TELEMETRY_STORE_UNAVAILABLE"), { statusCode: 503 }) } }
  const metrics = options.clickhouse
    ? createClickHouseGatewayMetricsStore(options.clickhouse)
    : { summarize: async () => { throw Object.assign(new Error("TELEMETRY_STORE_UNAVAILABLE"), { statusCode: 503 }) } }
  const identity = createPostgresIdentityDirectory({ sql: postgres.sql })
  const accessGroups = createAccessGroupDirectory({
    repository: createPostgresAccessGroupRepository({ sql: postgres.sql, audit: auditEvents }),
    identity,
    now: options.now,
  })
  const agentDelegations = createAgentDelegationDirectory({
    repository: createPostgresAgentDelegationRepository({
      sql: postgres.sql,
      releasePublisher: lifecycleReleasePublisher,
    }),
    identity,
    entitlements: postgres.entitlements,
    now: options.now,
  })
  const executionGrants = createExecutionGrantDirectory({
    repository: createPostgresExecutionGrantRepository({
      sql: postgres.sql,
      releasePublisher: lifecycleReleasePublisher,
    }),
    entitlements: postgres.entitlements,
    resources: postgres.resources,
    organizations: postgres.organizations,
    now: options.now,
  })
  const siem = createPostgresSiemForwarder({
    sql: postgres.sql,
    allowInsecureLoopback: process.env.NODE_ENV !== "production",
  })
  const notifications = createPostgresNotificationSubscriptionStore({
    sql: postgres.sql,
  })
  const configuration = createPostgresTenantConfigurationStore({
    sql: postgres.sql,
    now: options.now,
  })
  const access = createPostgresAccessGovernanceStore({
    sql: postgres.sql,
    releasePublisher: lifecycleReleasePublisher,
    now: options.now,
    idFactory: options.idFactory,
  })
  const mcpDiscovery = createPostgresMcpDiscoveryStore({
    sql: postgres.sql,
    idFactory: options.idFactory ? () => options.idFactory!("mcp-discovery") : undefined,
    publicationIdFactory: options.idFactory,
  })
  const personalCredentials = createPersonalCredentials({ identity, store: createPostgresPasswordCredentialStore(postgres.sql), connections: postgres.connections, codec: createMcpOAuthSecretCodec(options.mcpOAuthEncryptionKey) })
  const mcpOAuth = createMcpOAuthService({
    store: createPostgresMcpOAuthStore({ sql: postgres.sql }),
    connections: postgres.connections,
    identity,
    codec: createMcpOAuthSecretCodec(options.mcpOAuthEncryptionKey),
    publicOrigin: options.mcpOAuthPublicOrigin,
    managementUiOrigin: options.managementUiOrigin,
    now: options.now,
    idFactory: options.idFactory ? () => options.idFactory!("mcp-oauth") : undefined,
  })
  const botAccessPolicy: OnePolicy = createDefaultOnePolicy({
    seedStore: createPostgresOnePolicySeedStore({
      sql: options.sql,
      now: options.now,
      audit: auditEvents,
    }),
    runtimeStore: runtimePolicyStore,
    runtimeAuditSink: auditEvents,
    accessGroups,
    ...(options.runtimeReportKeyId ? { runtimeReportKeyId: options.runtimeReportKeyId } : {}),
    ...(options.runtimeReportPublicKeyPem ? { runtimeReportPublicKeyPem: options.runtimeReportPublicKeyPem } : {}),
    connectionEnabled: async ({ tenantId }) => {
      try {
        const connectionsForBot = await postgres.connections.list({ tenantId, resourceId: PERSONAL_BOT_RESOURCE_ID })
        return connectionsForBot.some((connection) => connection.resource_id === PERSONAL_BOT_RESOURCE_ID && connection.connection_id === PERSONAL_BOT_RESOURCE_ID && connection.lifecycle === "ENABLED")
      } catch {
        return false
      }
    },
  })
  const demoInstallations = createPostgresDemoInstallationStore(postgres.sql)

  return {
    sql: postgres.sql,
    organizations: postgres.organizations,
    applications: postgres.applications,
    federation: postgres.federation,
    resources: postgres.resources,
    connections: postgres.connections,
    providers: postgres.providers,
    providerCredentials: postgres.providerCredentials,
    models: postgres.models,
    entitlements: postgres.entitlements,
    modelRouter,
    modelRoutingPolicies: postgres.modelRoutingPolicies,
    enforcementCompiler,
    policyDrafts,
    enforcementRevisionStore,
    gatewayProjector,
    gatewayProjections: publicationStore,
    runtimeControl,
    gatewayPolicyReleases,
    gatewayAggregateRuntimeControl: {
      store: gatewayAggregateRuntimeControl,
      packages: gatewayReleasePackages,
    },
    gatewayPolicyReleaseRenewal,
    publicationWorkflow,
    activities,
    usageGovernance: postgres.usageGovernance,
    accountingLedger: postgres.accountingLedger,
    usageCounterStore: createValkeyUsageCounterStore(options.valkey),
    endpointActivities,
    endpointRuntime,
    ...(activityMaterializer ? { activityMaterializer } : {}),
    ...(activityDetails ? { activityDetails } : {}),
    traces,
    metrics,
    identity,
    accessGroups,
    agentDelegations,
    executionGrants,
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

function compactJwsSigner(signer: DurableEd25519Signer): CompactJwsSigner {
  return {
    algorithm: "EdDSA",
    keyId: signer.keyId,
    sign: (payload) => signer.sign(payload),
  }
}

function assertSigningRoles(
  roles: LivePlatformModuleGraphOptions["signingRoles"],
): void {
  if (!roles || typeof roles !== "object") {
    throw new PlatformApiError(
      "GATEWAY_PROJECTION_SIGNER_REQUIRED",
      500,
      "Platform signing roles require durable Ed25519 keys",
    )
  }
  const signers = Object.values(roles)
  const keyIds = signers.map((signer) => signer?.keyId)
  const publicKeys = signers.map((signer) => signer?.publicKeyPem?.trim())
  if (
    signers.some(
      (signer) =>
        signer?.algorithm !== "Ed25519" || typeof signer.sign !== "function",
    ) ||
    keyIds.some((keyId) => typeof keyId !== "string" || !keyId.trim()) ||
    publicKeys.some((publicKey) => !publicKey) ||
    new Set(keyIds).size !== keyIds.length ||
    new Set(publicKeys).size !== publicKeys.length
  ) {
    throw new PlatformApiError(
      "PLATFORM_SIGNING_ROLE_CONFLICT",
      500,
      "Platform signing roles require four distinct durable Ed25519 keys and key ids",
    )
  }
}
