import type { McpOAuthSecretCodec } from "./mcp-oauth/crypto"
import type { SqlAdapter } from "../persistence/sql-adapter"
import type { ApplicationTokenBroker, FederationService, WorkloadAssertionVerifier } from "./federation/module"
import { createPostgresFederationService } from "./federation/postgres"
import { createPostgresResourceConnectionRegistry } from "./connections/postgres"
import type { ResourceConnectionRegistry } from "./connections/module"
import { createPostgresPublicModelCatalog } from "./models/postgres"
import type { PublicModelCatalog } from "./models/module"
import { createPostgresOrganizationDirectory } from "./organizations/postgres"
import type { OrganizationDirectory } from "./organizations/module"
import { createPostgresProviderProfileCatalog } from "./providers/postgres"
import type { ProviderProfileCatalog } from "./providers/module"
import { createPostgresProviderCredentialProfileStore } from "./provider-credentials/postgres"
import type { ProviderCredentialProfileStore } from "./provider-credentials/module"
import { createPostgresResourceRegistry } from "./resources/postgres"
import type { ResourceRegistry } from "./resources/module"
import type { PublicationDnsVerifier } from "./resources/module"
import type { ResourceLifecycleReleasePublisher } from "./resources/module"
import { createPostgresModelEntitlementCatalog } from "./entitlements/postgres"
import type { ModelEntitlementCatalog } from "./entitlements/module"
import type { ConnectionVerifier } from "./connections/module"
import { createPostgresModelRoutingPolicyStore } from "./model-routing/policy-postgres"
import type { ModelRoutingPolicyStore } from "./model-routing/module"
import { createPostgresApplicationRegistry } from "./applications/postgres"
import type { ApplicationOAuthClientProvisioner, ApplicationRegistry } from "./applications/module"
import { createPostgresUsageGovernanceDirectory } from "./usage-governance/postgres"
import type { UsageGovernanceDirectory } from "./usage-governance/directory"
import type { AccountingLedger } from "./usage-governance/accounting"
import { createPostgresAccountingLedger } from "./usage-governance/accounting-postgres"

export interface PostgresPlatformModulesOptions {
  providerCredentialCodec?: McpOAuthSecretCodec
  /** Migrations are run by the process bootstrap, not by this constructor. */
  sql: SqlAdapter
  now?: () => number
  idFactory?: (prefix: string) => string
  connectionVerifier?: ConnectionVerifier
  publicationDnsVerifier?: PublicationDnsVerifier
  lifecycleReleasePublisher?: ResourceLifecycleReleasePublisher
  applicationOAuthProvisioner?: ApplicationOAuthClientProvisioner
}

export interface PostgresPlatformModules {
  sql: SqlAdapter
  organizations: OrganizationDirectory
  applications: ApplicationRegistry
  resources: ResourceRegistry
  connections: ResourceConnectionRegistry
  providers: ProviderProfileCatalog
  providerCredentials: ProviderCredentialProfileStore
  models: PublicModelCatalog
  entitlements: ModelEntitlementCatalog
  modelRoutingPolicies: ModelRoutingPolicyStore
  usageGovernance: UsageGovernanceDirectory
  accountingLedger: (tenantId: string) => AccountingLedger
}

/**
 * Compose one coherent capability graph over PostgreSQL.
 *
 * The adapters intentionally share one SqlAdapter and the Resource/Connection
 * interfaces.  There is no generic repository layer and no second aggregate
 * for Exposure/Backend; a Publication is stored in the dedicated publication
 * table by the Resource adapter because the current ResourceRegistry seam
 * still owns those commands.
 */
export function createPostgresPlatformModules(
  options: PostgresPlatformModulesOptions,
): PostgresPlatformModules {
  const organizations = createPostgresOrganizationDirectory({
    sql: options.sql,
    now: options.now,
    idFactory: options.idFactory,
  })
  const applications = createPostgresApplicationRegistry({
    sql: options.sql,
    idFactory: options.idFactory ? () => options.idFactory!("application") : undefined,
    oauthProvisioner: options.applicationOAuthProvisioner,
    releasePublisher: options.lifecycleReleasePublisher,
    now: options.now,
  })
  const federation = createPostgresFederationService({
    sql: options.sql,
    ...(options.workloadAssertionVerifier ? { verifier: options.workloadAssertionVerifier } : {}),
    ...(options.applicationTokenBroker ? { tokenBroker: options.applicationTokenBroker } : {}),
    now: options.now,
    idFactory: options.idFactory ? () => options.idFactory!("federation") : undefined,
  })
  const providers = createPostgresProviderProfileCatalog({
    sql: options.sql,
    now: options.now,
    idFactory: options.idFactory,
  })
  const providerCredentials = createPostgresProviderCredentialProfileStore({
    codec: options.providerCredentialCodec,
    sql: options.sql,
    idFactory: options.idFactory ? () => options.idFactory!("provider-credential-profile") : undefined,
  })
  const resources = createPostgresResourceRegistry({
    sql: options.sql,
    organizations,
    now: options.now,
    idFactory: options.idFactory,
    verifyDns: options.publicationDnsVerifier?.verify,
    dnsTargetForGateway: options.publicationDnsVerifier?.targetForGateway,
    lifecycleReleasePublisher: options.lifecycleReleasePublisher,
  })
  const connections = createPostgresResourceConnectionRegistry({
    sql: options.sql,
    resources,
    providers,
    providerCredentials,
    now: options.now,
    idFactory: options.idFactory,
    verifier: options.connectionVerifier,
    releasePublisher: options.lifecycleReleasePublisher,
  })
  const models = createPostgresPublicModelCatalog({
    sql: options.sql,
    resources,
    connections,
    providers,
    now: options.now,
    idFactory: options.idFactory,
  })
  const entitlements = createPostgresModelEntitlementCatalog({
    sql: options.sql,
    now: options.now,
    idFactory: options.idFactory,
    releasePublisher: options.lifecycleReleasePublisher,
  })
  const modelRoutingPolicies = createPostgresModelRoutingPolicyStore({
    sql: options.sql,
    now: options.now,
    idFactory: options.idFactory,
    releasePublisher: options.lifecycleReleasePublisher,
  })
  const usageGovernance = createPostgresUsageGovernanceDirectory(options.sql, {
    releasePublisher: options.lifecycleReleasePublisher,
    now: options.now,
  })
  return {
    federation,
    sql: options.sql,
    organizations,
    applications,
    resources,
    connections,
    providers,
    providerCredentials,
    models,
    entitlements,
    modelRoutingPolicies,
    usageGovernance,
    accountingLedger: (tenantId) => createPostgresAccountingLedger(options.sql, tenantId),
  }
}

export interface PostgresPlatformModulesOptions {
  providerCredentialCodec?: McpOAuthSecretCodec
  applicationTokenBroker?: ApplicationTokenBroker
  workloadAssertionVerifier?: WorkloadAssertionVerifier
}

export interface PostgresPlatformModules {
  federation: FederationService
}
