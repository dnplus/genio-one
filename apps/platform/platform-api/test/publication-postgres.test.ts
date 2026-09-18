import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"

import { canonicalEnforcementChainDigest } from "../src/capabilities/enforcement/postgres"
import type { CompiledEnforcementChain } from "../src/capabilities/enforcement/contract"
import type {
  GatewayProjection,
  GatewayProjectionSnapshot,
} from "../src/capabilities/gateway-projection/contract"
import { PlatformApiError } from "../src/capabilities/errors"
import { snapshotDigest } from "../src/capabilities/publications/memory"
import { createPostgresPublicationWorkflowStore } from "../src/capabilities/publications/postgres"
import type { ResourceRegistration } from "../src/capabilities/resources/contract"
import type { ResourceRegistry } from "../src/capabilities/resources/module"
import { resourceContentDigest } from "../src/capabilities/resources/resource-content"
import { runMigrations } from "../src/persistence/migration-runner"
import { createPostgresSqlAdapter } from "../src/persistence/sql-adapter"
import type { SqlAdapter, SqlQueryResult, SqlTransaction } from "../src/persistence/sql-adapter"

type Row = Record<string, unknown>

const tenantId = "tenant-publication-postgres"
const resourceId = "resource-mail2000"
const publicationId = "publication-mail2000"
const requestId = "publication-request-mail2000"
const attemptId = "publication-attempt-mail2000"
const connectionId = "connection-mail2000"

const endpoint = {
  gateway_id: "genio-ai-mcp-gateway",
  hostname: "mail2000.example.test",
  base_path: "/mail2000",
  visibility: "PUBLIC" as const,
  dns_management: "EXTERNAL" as const,
  dns_verification: "VERIFIED" as const,
  dns_target: null,
}

const connectorConfiguration = {
  kind: "mail2000" as const,
  imap_host: "mail.gss.com.tw",
  imap_port: 993,
  smtp_host: "mail.gss.com.tw",
  smtp_port: 465,
}

const mail2000ToolCapability = {
  capability_id: "mcp-tool-05181a69c786a5da75d6fc343c7f0cf3",
  display_name: "list_mailboxes",
} as const

const resource: ResourceRegistration = {
  tenant_id: tenantId,
  resource_id: resourceId,
  display_name: "Mail2000",
  kind: "MCP",
  owner_organization_id: "org-platform",
  authentication_strategy: "OAUTH",
  environment_id: "uat",
  version: "1.0.0",
  lifecycle: "DRAFT",
  operational_state: "UNKNOWN",
  capabilities: [{ capability_id: "mcp.invoke", display_name: "Invoke" }],
  api: null,
  extension_metadata: null,
  enforcement_point_id: "genio-ai-mcp-gateway",
  publication_endpoint: endpoint,
  publication_request: null,
  created_at: 1_700_000_000,
}

const connection = {
  connector_configuration: connectorConfiguration,
  tenant_id: tenantId,
  connection_id: connectionId,
  resource_id: resourceId,
  display_name: "Mail2000",
  connection_kind: "MCP" as const,
  provider_type: null,
  provider_profile_id: null,
  endpoint: "https://mail.gss.com.tw/mcp",
  mcp_tool_namespace: "mail2000",
  mcp_selected_tools: ["list_mailboxes"],
  mcp_tool_selection_operation_id: null,
  credential_ref: null,
  provider_credential_profile: null,
  downstream_identity: { mode: "USER_PASSWORD" as const },
  request_mapping: null,
  certificate: {
    mode: "SYSTEM_CA" as const,
    certificate_pem: null,
    fingerprint_sha256: null,
    subject: null,
    issuer: null,
    is_self_signed: false,
    not_before: null,
    not_after: null,
    status: "NOT_CONFIGURED" as const,
  },
  status: "READY" as const,
  configuration_revision: 2,
  lifecycle: "ENABLED" as const,
  revoke_requested_after_release_revision: null,
  verification_state: "VERIFIED" as const,
  health_state: "HEALTHY" as const,
  health_observed_at: 1_700_000_001,
  health_source_revision: 1,
  routing_priority: 0,
  region: null,
  supported_obligations: [],
  created_at: 1_700_000_001,
}

const chain: CompiledEnforcementChain = {
  chain_id: "chain-mail2000",
  tenant_id: tenantId,
  resource_id: resourceId,
  capability_id: "mcp.invoke",
  eligible_connection_ids: [connectionId],
  one_policy_revision: 1,
  steps: [
    {
      step_id: "authenticate",
      kind: "AUTHENTICATE",
      phase: "REQUEST",
      implementation: "NATIVE",
      depends_on: [],
      config: {
        schema_version: "genio.one.auth.jwt.v1",
        provider: "test-oidc",
        issuer: "https://issuer.example.test",
        audiences: ["genio-one"],
        remote_jwks_uri: "https://issuer.example.test/.well-known/jwks.json",
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
      config: {},
    },
    {
      step_id: "route",
      kind: "ROUTE",
      phase: "ROUTING",
      implementation: "AIGW_NATIVE",
      depends_on: ["authorize"],
      config: {},
    },
  ],
  request_filter_order: [],
  response_filter_order: [],
}

const snapshotWithoutDigest: Omit<GatewayProjectionSnapshot, "snapshot_digest"> = {
  tenant_id: tenantId,
  publication_id: publicationId,
  request_id: requestId,
  resource_id: resourceId,
  capability_id: "mcp.invoke",
  endpoint_revision: 1,
  resource_revision: 1,
  policy_revision: 1,
  resource_digest: "resource-digest",
  resource,
  publication_endpoint: endpoint,
  one_policy_chain: chain,
  connections: [connection],
  models: [],
  model_mappings: [],
}

const snapshot: GatewayProjectionSnapshot = {
  ...snapshotWithoutDigest,
  snapshot_digest: snapshotDigest(snapshotWithoutDigest),
}

const publicationRow: Row = {
  tenant_id: tenantId,
  publication_id: publicationId,
  resource_id: resourceId,
  endpoint_revision: 1,
  resource_revision: 1,
  resource_digest: snapshot.resource_digest,
  policy_revision: 1,
  gateway_id: endpoint.gateway_id,
  hostname: endpoint.hostname,
  base_path: endpoint.base_path,
  visibility: endpoint.visibility,
  publication_state: "PENDING_REVIEW",
  dns_management: endpoint.dns_management,
  dns_proof_status: endpoint.dns_verification,
  dns_proof: { dns_target: null },
  request_snapshot: {
    request_id: requestId,
    state: "PENDING",
    requested_by: "platform-admin",
    requested_at: 1_700_000_002,
  },
  review_snapshot: {
    reviewed_by: "platform-admin",
    reviewed_at: 1_700_000_003,
  },
  publication_snapshot: snapshot,
  publication_build_state: "BUILDING",
  build_attempt_id: attemptId,
  last_error_code: null,
  projection_digest: null,
  row_revision: 2,
  created_at: 1_700_000_002,
  updated_at: 1_700_000_003,
}

const resourceRow: Row = {
  tenant_id: tenantId,
  resource_id: resourceId,
  lifecycle: "DRAFT",
  row_revision: snapshot.resource_revision,
}

const connectionRow: Row = {
  tenant_id: tenantId,
  connection_id: connectionId,
  resource_id: resourceId,
  display_name: connection.display_name,
  connection_kind: connection.connection_kind,
  provider_type: null,
  provider_profile_id: null,
  endpoint: connection.endpoint,
  mcp_tool_namespace: connection.mcp_tool_namespace,
  mcp_selected_tools: connection.mcp_selected_tools,
  mcp_tool_selection_operation_id: null,
  credential_ref: null,
  provider_credential_profile_id: null,
  provider_credential_profile_revision: null,
  provider_credential_strategy_digest: null,
  downstream_identity: connection.downstream_identity,
  request_mapping: null,
  connector_configuration: connectorConfiguration,
  certificate_mode: "SYSTEM_CA",
  certificate_pem: null,
  certificate_fingerprint_sha256: null,
  certificate_subject: null,
  certificate_issuer: null,
  certificate_is_self_signed: false,
  certificate_not_before: null,
  certificate_not_after: null,
  status: connection.status,
  configuration_revision: connection.configuration_revision,
  lifecycle: connection.lifecycle,
  revoke_requested_after_release_revision: null,
  verification_state: connection.verification_state,
  health_state: connection.health_state,
  health_observed_at: connection.health_observed_at,
  health_source_revision: connection.health_source_revision,
  routing_priority: connection.routing_priority,
  region: null,
  supported_obligations: [],
  created_at: connection.created_at,
}

const projection: GatewayProjection = {
  schema_version: "genio.one.gateway.v1",
  projection_id: "projection-mail2000",
  tenant_id: tenantId,
  publication_id: publicationId,
  resource_id: resourceId,
  capability_id: "mcp.invoke",
  endpoint_revision: 1,
  policy_revision: 1,
  revision: 1,
  digest: "a".repeat(64),
  signature: { algorithm: "Ed25519", key_id: "test", value: "A".repeat(86) },
  publication_endpoint: {
    gateway_id: endpoint.gateway_id,
    hostname: endpoint.hostname,
    base_path: endpoint.base_path,
  },
  policy_bundle: { enforcement_chain: chain },
  operation: "APPLY",
  resources: [{
    apiVersion: "gateway.networking.k8s.io/v1",
    kind: "HTTPRoute",
    metadata: { name: "mail2000" },
    spec: {},
  }],
}

class PublicationSql implements SqlAdapter, SqlTransaction {
  readonly calls: Array<{ text: string; parameters: readonly unknown[] }> = []

  protected async response<Result extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    _parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Result>> {
    if (text.includes("from genio_one_publications")) return { rows: [publicationRow as Result], rowCount: 1 }
    if (text.includes("from genio_one_resources")) return { rows: [resourceRow as Result], rowCount: 1 }
    if (text.includes("from genio_one_resource_connections")) {
      const row = text.includes("connector_configuration")
        ? connectionRow
        : { ...connectionRow, connector_configuration: undefined }
      return { rows: [row as unknown as Result], rowCount: 1 }
    }
    if (text.includes("from genio_one_public_models")) return { rows: [], rowCount: 0 }
    if (text.includes("from genio_one_connection_model_mappings")) return { rows: [], rowCount: 0 }
    if (text.includes("from genio_one_enforcement_chain_revisions")) {
      return {
        rows: [{ one_policy_revision: 1, chain, chain_digest: canonicalEnforcementChainDigest(chain) } as unknown as Result],
        rowCount: 1,
      }
    }
    if (text.includes("from genio_one_gateway_projections")) return { rows: [], rowCount: 0 }
    if (text.startsWith("update genio_one_resources")) return { rows: [resourceRow as Result], rowCount: 1 }
    if (text.startsWith("update genio_one_publications")) return { rows: [publicationRow as Result], rowCount: 1 }
    if (text.startsWith("update genio_one_publication_build_attempts")) return { rows: [publicationRow as Result], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  }

  async query<Result extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Result>> {
    this.calls.push({ text, parameters })
    return this.response(text, parameters)
  }

  async transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
    return work(this)
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

class PublicationLockInterleavingSql extends PublicationSql implements SqlAdapter {
  private transactionId = 0
  readonly reconciliationHasGateway = deferred()
  readonly allowReconciliationResource = deferred()
  readonly publicationWaitingForGateway = deferred()
  readonly reconciliationFinished = deferred()
  publicationLockedResourceBeforeGateway = false

  async transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
    const transactionId = this.transactionId++
    const transaction: SqlTransaction = {
      query: (text, parameters = []) => this.queryFor(transactionId, text, parameters),
    }
    try {
      return await work(transaction)
    } finally {
      if (transactionId === 0) this.reconciliationFinished.resolve()
    }
  }

  private async queryFor<Result extends Record<string, unknown> = Record<string, unknown>>(
    transactionId: number,
    text: string,
    parameters: readonly unknown[],
  ): Promise<SqlQueryResult<Result>> {
    this.calls.push({ text, parameters })
    if (text.includes("pg_advisory_xact_lock")) {
      if (transactionId === 0) {
        this.reconciliationHasGateway.resolve()
        return { rows: [], rowCount: 1 }
      }
      this.publicationWaitingForGateway.resolve()
      await this.reconciliationFinished.promise
      return { rows: [], rowCount: 1 }
    }
    if (transactionId === 0 && text.includes("from genio_one_resources") && text.includes("for update")) {
      await this.allowReconciliationResource.promise
      return { rows: [{ resource_id: resourceId } as unknown as Result], rowCount: 1 }
    }
    if (transactionId === 1 && text.includes("from genio_one_resources") && text.includes("for update")) {
      this.publicationLockedResourceBeforeGateway = true
    }
    return this.response(text, parameters)
  }
}

test("PostgreSQL publication freeze preserves configured ConnectorConfiguration", async () => {
  const sql = new PublicationSql()
  const resources: ResourceRegistry = {
    async getResource() {
      return { ...resource, lifecycle: "PUBLISHED" }
    },
  } as unknown as ResourceRegistry
  const store = createPostgresPublicationWorkflowStore({
    sql,
    resources,
    gatewayPublicationDelivery: { async deliverInTransaction() {} },
    now: () => 1_700_000_003,
  })

  const published = await store.commitBuild({
    tenantId,
    resourceId,
    requestId,
    attemptId,
    reviewerId: "platform-admin",
    reviewedAt: 1_700_000_003,
    projection,
  })

  assert.equal(published.lifecycle, "PUBLISHED")
  const connectionQuery = sql.calls.find((call) => call.text.includes("from genio_one_resource_connections"))
  assert.ok(connectionQuery)
  assert.match(connectionQuery.text, /connector_configuration/)
  const releaseLockIndex = sql.calls.findIndex((call) => call.text.includes("pg_advisory_xact_lock"))
  const resourceLockIndex = sql.calls.findIndex((call) =>
    call.text.includes("from genio_one_resources") && call.text.includes("for update"))
  const publicationLockIndex = sql.calls.findIndex((call) =>
    call.text.includes("from genio_one_publications") && call.text.includes("for update"))
  assert.ok(releaseLockIndex >= 0)
  assert.ok(resourceLockIndex > releaseLockIndex)
  assert.ok(publicationLockIndex > resourceLockIndex)
})

test("publication commit waits for the Gateway lock before it can lock frozen Resource inputs", async () => {
  const sql = new PublicationLockInterleavingSql()
  const resources: ResourceRegistry = {
    async getResource() {
      return { ...resource, lifecycle: "PUBLISHED" }
    },
  } as unknown as ResourceRegistry
  const store = createPostgresPublicationWorkflowStore({
    sql,
    resources,
    gatewayPublicationDelivery: { async deliverInTransaction() {} },
    now: () => 1_700_000_003,
  })
  const reconciliation = sql.transaction(async (transaction) => {
    await transaction.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", ["gateway"])
    await transaction.query("select resource_id from genio_one_resources where resource_id = $1 for update", [resourceId])
  })
  await sql.reconciliationHasGateway.promise
  const publication = store.commitBuild({
    tenantId,
    resourceId,
    requestId,
    attemptId,
    reviewerId: "platform-admin",
    reviewedAt: 1_700_000_003,
    projection,
  })
  await sql.publicationWaitingForGateway.promise
  assert.equal(sql.publicationLockedResourceBeforeGateway, false)
  sql.allowReconciliationResource.resolve()
  await Promise.all([reconciliation, publication])
  assert.equal(sql.publicationLockedResourceBeforeGateway, true)
})

const databaseUrl = process.env.GENIO_ONE_DATABASE_URL
const persistenceTestEnabled = process.env.GENIO_ONE_PUBLICATION_PERSISTENCE_TEST === "1"

test(
  "PostgreSQL publication creates an installed Mail2000 successor at the current Resource revision",
  { skip: !persistenceTestEnabled || !databaseUrl, timeout: 30_000 },
  async () => {
    assert.ok(databaseUrl)
    assert.ok(["localhost", "127.0.0.1"].includes(new URL(databaseUrl).hostname))
    const schema = `publicationqa_${randomUUID().replaceAll("-", "")}`
    const setup = createPostgresSqlAdapter({ url: databaseUrl })
    await setup.query(`create schema ${schema}`)
    const sql = createPostgresSqlAdapter({ url: databaseUrl, options: { max: 1, connection: { search_path: schema } } })
    const integrationTenantId = `tenant-publication-postgres-${randomUUID()}`
    const integrationResourceId = `resource-mail2000-${randomUUID()}`
    const integrationPublicationId = `publication-mail2000-${randomUUID()}`
    const integrationPreviousRequestId = `publication-request-mail2000-previous-${randomUUID()}`
    const integrationPreviousAttemptId = `publication-attempt-mail2000-previous-${randomUUID()}`
    const integrationRequestId = `publication-request-mail2000-${randomUUID()}`
    const integrationConnectionId = `connection-mail2000-${randomUUID()}`
    const integrationOrganizationId = `org-mail2000-${randomUUID()}`
    const integrationProjectionId = `projection-mail2000-${randomUUID()}`

    try {
      await runMigrations(sql)
      const integrationResource: ResourceRegistration = {
        ...resource,
        tenant_id: integrationTenantId,
        resource_id: integrationResourceId,
        owner_organization_id: integrationOrganizationId,
        capabilities: [...resource.capabilities, mail2000ToolCapability],
        installation_owned: true,
        service_kind: "MAIL2000",
      }
      const integrationConnection = {
        ...connection,
        tenant_id: integrationTenantId,
        resource_id: integrationResourceId,
        connection_id: integrationConnectionId,
      }
      const integrationChain: CompiledEnforcementChain = {
        ...chain,
        tenant_id: integrationTenantId,
        resource_id: integrationResourceId,
        eligible_connection_ids: [integrationConnectionId],
      }
      const previousResource: ResourceRegistration = {
        ...integrationResource,
        capabilities: resource.capabilities,
      }
      const previousSnapshotWithoutDigest: Omit<GatewayProjectionSnapshot, "snapshot_digest"> = {
        ...snapshot,
        tenant_id: integrationTenantId,
        publication_id: integrationPublicationId,
        request_id: integrationPreviousRequestId,
        resource_id: integrationResourceId,
        resource_revision: 1,
        resource_digest: resourceContentDigest(previousResource),
        resource: previousResource,
        one_policy_chain: integrationChain,
        connections: [integrationConnection],
      }
      const previousSnapshot: GatewayProjectionSnapshot = {
        ...previousSnapshotWithoutDigest,
        snapshot_digest: snapshotDigest(previousSnapshotWithoutDigest),
      }
      await sql.query(
        `insert into genio_one_organizations (tenant_id, organization_id, display_name, slug)
         values ($1, $2, $3, $4)`,
        [integrationTenantId, integrationOrganizationId, "Mail2000 Test", `mail2000-${randomUUID()}`],
      )
      await sql.query(
        `insert into genio_one_resources
           (tenant_id, resource_id, display_name, kind, owner_organization_id,
            authentication_strategy, environment_id, version, lifecycle,
            operational_state, capabilities, enforcement_point_id,
            builtin_service, installation_owned, service_kind, documentation, row_revision)
         values ($1, $2, $3, 'MCP', $4, 'OAUTH', 'uat', '1.0.0', 'DRAFT',
                 'UNKNOWN', $5::text::jsonb, 'genio-ai-mcp-gateway',
                 null, true, 'MAIL2000', 'Mail2000 installed connector', 2)`,
        [integrationTenantId, integrationResourceId, "Mail2000", integrationOrganizationId, JSON.stringify(integrationResource.capabilities)],
      )
      await sql.query(
        `insert into genio_one_resource_connections
           (tenant_id, resource_id, connection_id, display_name, connection_kind,
            provider_type, provider_profile_id, endpoint, credential_ref,
            status, downstream_identity, mcp_tool_namespace,
            mcp_selected_tools, request_mapping, connector_configuration,
            lifecycle, verification_state, health_state, health_observed_at,
            health_source_revision, configuration_revision, routing_priority,
            supported_obligations, created_at)
         values ($1, $2, $3, 'Mail2000', 'MCP', null, null, $4, null, 'READY',
                 $5::text::jsonb, 'mail2000', $6::text[], null, $7::text::jsonb,
                 'ENABLED', 'VERIFIED', 'HEALTHY', to_timestamp($8), 1, 2, 0, $9::text[], to_timestamp($10))`,
        [
          integrationTenantId,
          integrationResourceId,
          integrationConnectionId,
          "https://mail.gss.com.tw/mcp",
          JSON.stringify(integrationConnection.downstream_identity),
          integrationConnection.mcp_selected_tools,
          JSON.stringify(connectorConfiguration),
          integrationConnection.health_observed_at,
          [],
          integrationConnection.created_at,
        ],
      )
      await sql.query(
        `insert into genio_one_enforcement_chain_revisions
           (tenant_id, resource_id, capability_id, one_policy_revision,
            eligible_connection_ids, chain, chain_digest)
         values ($1, $2, $3, 1, $4::text::jsonb, $5::text::jsonb, $6)`,
        [
          integrationTenantId,
          integrationResourceId,
          integrationChain.capability_id,
          JSON.stringify(integrationChain.eligible_connection_ids),
          JSON.stringify(integrationChain),
          canonicalEnforcementChainDigest(integrationChain),
        ],
      )
      await sql.query(
        `insert into genio_one_publications
           (tenant_id, publication_id, resource_id, endpoint_revision,
            resource_revision, resource_digest, policy_revision, gateway_id,
            hostname, base_path, visibility, publication_state, dns_management,
            dns_proof_status, dns_proof, request_snapshot, review_snapshot,
            publication_snapshot, publication_build_state, build_attempt_id)
         values ($1, $2, $3, 1, 1, $4, 1, $5, $6, $7, 'PUBLIC',
                 'PENDING_REVIEW', 'EXTERNAL', 'VERIFIED', '{}'::jsonb,
                 $8::text::jsonb, $9::text::jsonb, $10::text::jsonb, 'FAILED', $11)`,
        [
          integrationTenantId,
          integrationPublicationId,
          integrationResourceId,
          resourceContentDigest(previousResource),
          endpoint.gateway_id,
          endpoint.hostname,
          endpoint.base_path,
          JSON.stringify({
            request_id: integrationPreviousRequestId,
            state: "PENDING",
            requested_by: "platform-admin",
            requested_at: 1_700_000_002,
            reviewed_by: "platform-admin",
            reviewed_at: 1_700_000_003,
            publication_state: "FAILED",
            attempt_id: integrationPreviousAttemptId,
            failure_code: "PUBLICATION_SNAPSHOT_STALE",
          }),
          JSON.stringify({ reviewed_by: "platform-admin", reviewed_at: 1_700_000_003 }),
          JSON.stringify(previousSnapshot),
          integrationPreviousAttemptId,
        ],
      )
      await sql.query(
        `insert into genio_one_publication_build_attempts
           (tenant_id, publication_id, attempt_id, request_id, snapshot_digest,
            state, failure_code, claimed_by, claimed_at, completed_at)
         values ($1, $2, $3, $4, $5, 'FAILED', 'PUBLICATION_SNAPSHOT_STALE', 'platform-admin', now(), now())`,
        [integrationTenantId, integrationPublicationId, integrationPreviousAttemptId, integrationPreviousRequestId, previousSnapshot.snapshot_digest],
      )

      const store = createPostgresPublicationWorkflowStore({
        sql,
        resources: {
          async getResource() {
            return { ...integrationResource, lifecycle: "PUBLISHED" }
          },
        } as unknown as ResourceRegistry,
        gatewayPublicationDelivery: { async deliverInTransaction() {} },
        now: () => 1_700_000_003,
      })
      const publicationReference = await store.preparePublicationReference({
        tenantId: integrationTenantId,
        resourceId: integrationResourceId,
      })
      assert.ok(publicationReference)
      assert.notEqual(publicationReference.publicationId, integrationPublicationId)
      assert.equal(publicationReference.endpointRevision, 2)
      assert.equal(publicationReference.resourceRevision, 2)
      const previousPublication = await sql.query<{ resource_revision: number | string; snapshot_digest: string }>(
        `select resource_revision, publication_snapshot->>'snapshot_digest' as snapshot_digest
           from genio_one_publications
          where tenant_id = $1 and publication_id = $2`,
        [integrationTenantId, integrationPublicationId],
      )
      assert.equal(Number(previousPublication.rows[0]?.resource_revision), 1)
      assert.equal(previousPublication.rows[0]?.snapshot_digest, previousSnapshot.snapshot_digest)
      const integrationSnapshotWithoutDigest: Omit<GatewayProjectionSnapshot, "snapshot_digest"> = {
        ...snapshot,
        tenant_id: integrationTenantId,
        publication_id: publicationReference.publicationId,
        request_id: integrationRequestId,
        resource_id: integrationResourceId,
        endpoint_revision: publicationReference.endpointRevision,
        resource_revision: publicationReference.resourceRevision,
        resource_digest: resourceContentDigest(integrationResource),
        resource: integrationResource,
        one_policy_chain: integrationChain,
        connections: [integrationConnection],
      }
      const integrationSnapshot: GatewayProjectionSnapshot = {
        ...integrationSnapshotWithoutDigest,
        snapshot_digest: snapshotDigest(integrationSnapshotWithoutDigest),
      }
      await store.saveReviewSnapshot({
        tenantId: integrationTenantId,
        resourceId: integrationResourceId,
        request: {
          request_id: integrationRequestId,
          state: "PENDING",
          requested_by: "platform-admin",
          requested_at: 1_700_000_002,
          reviewed_by: null,
          reviewed_at: null,
          publication_state: "PENDING_REVIEW",
          attempt_id: null,
          failure_code: null,
        },
        snapshot: integrationSnapshot,
      })
      const claimed = await store.claimBuild({
        tenantId: integrationTenantId,
        resourceId: integrationResourceId,
        requestId: integrationRequestId,
        reviewerId: "platform-admin",
        reviewedAt: 1_700_000_003,
      })
      assert.equal(claimed.snapshot.resource_revision, 2)
      const integrationProjection: GatewayProjection = {
        ...projection,
        tenant_id: integrationTenantId,
        publication_id: publicationReference.publicationId,
        resource_id: integrationResourceId,
        endpoint_revision: publicationReference.endpointRevision,
        projection_id: integrationProjectionId,
        policy_bundle: { enforcement_chain: integrationChain },
      }
      const changedConnectorConfiguration = {
        ...connectorConfiguration,
        smtp_port: 466,
      }
      await sql.query(
        `update genio_one_resource_connections
            set connector_configuration = $1::text::jsonb
          where tenant_id = $2 and resource_id = $3 and connection_id = $4`,
        [JSON.stringify(changedConnectorConfiguration), integrationTenantId, integrationResourceId, integrationConnectionId],
      )
      await assert.rejects(
        store.commitBuild({
          tenantId: integrationTenantId,
          resourceId: integrationResourceId,
          requestId: integrationRequestId,
          attemptId: claimed.attemptId,
          reviewerId: "platform-admin",
          reviewedAt: 1_700_000_003,
          projection: integrationProjection,
        }),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "PUBLICATION_SNAPSHOT_STALE",
      )
      await sql.query(
        `update genio_one_resource_connections
            set connector_configuration = $1::text::jsonb
          where tenant_id = $2 and resource_id = $3 and connection_id = $4`,
        [JSON.stringify(connectorConfiguration), integrationTenantId, integrationResourceId, integrationConnectionId],
      )
      await sql.query(
        `update genio_one_resources
            set capabilities = $1::text::jsonb, row_revision = 3
          where tenant_id = $2 and resource_id = $3`,
        [JSON.stringify([...integrationResource.capabilities, { capability_id: "mcp-tool-resource-change", display_name: "resource-change" }]), integrationTenantId, integrationResourceId],
      )
      await assert.rejects(
        store.commitBuild({
          tenantId: integrationTenantId,
          resourceId: integrationResourceId,
          requestId: integrationRequestId,
          attemptId: claimed.attemptId,
          reviewerId: "platform-admin",
          reviewedAt: 1_700_000_003,
          projection: integrationProjection,
        }),
        (error: unknown) => {
          if (!(error instanceof PlatformApiError)) return false
          assert.equal(error.code, "PUBLICATION_SNAPSHOT_STALE")
          assert.ok(error.violations.some((violation) => violation.code === "RESOURCE_REVISION_CHANGED"))
          return true
        },
      )
      await sql.query(
        `update genio_one_resources
            set capabilities = $1::text::jsonb, row_revision = 2
          where tenant_id = $2 and resource_id = $3`,
        [JSON.stringify(integrationResource.capabilities), integrationTenantId, integrationResourceId],
      )
      await store.commitBuild({
        tenantId: integrationTenantId,
        resourceId: integrationResourceId,
        requestId: integrationRequestId,
        attemptId: claimed.attemptId,
        reviewerId: "platform-admin",
        reviewedAt: 1_700_000_003,
        projection: integrationProjection,
      })
      const state = await sql.query<{ lifecycle: string; publication_state: string; publication_build_state: string }>(
        `select resource.lifecycle, publication.publication_state, publication.publication_build_state
           from genio_one_resources resource
           join genio_one_publications publication
             on publication.tenant_id = resource.tenant_id and publication.resource_id = resource.resource_id
          where resource.tenant_id = $1 and resource.resource_id = $2
            and publication.publication_id = $3`,
        [integrationTenantId, integrationResourceId, publicationReference.publicationId],
      )
      assert.deepEqual(state.rows[0], { lifecycle: "PUBLISHED", publication_state: "PUBLISHED", publication_build_state: "READY" })
    } finally {
      await sql.end({ timeout: 1 })
      await setup.query(`drop schema ${schema} cascade`)
      await setup.end({ timeout: 1 })
    }
  },
)

test("publication freeze includes configured credential metadata without reading ciphertext", async () => {
  const profile = { tenant_id: tenantId, profile_id: "adc-profile", revision: 2, owner_organization_id: "org-platform", display_name: "ADC", adapter_family: "GCP", strategy: { kind: "RUNTIME_IDENTITY", adapter: "GCP_APPLICATION_DEFAULT", parameters: { project_name: "project", region: "us-central1" } }, strategy_digest: "b".repeat(64), credential_configured: true, state: "ACTIVE", created_by_subject_id: "admin", created_at: 1_700_000_001 } as const
  const frozen = { ...snapshotWithoutDigest, provider_credential_profiles: [profile] }
  const row = { ...publicationRow, publication_snapshot: { ...frozen, snapshot_digest: snapshotDigest(frozen) } }
  class CredentialPublicationSql extends PublicationSql {
    override async query<Result extends Record<string, unknown> = Record<string, unknown>>(text: string, parameters: readonly unknown[] = []): Promise<SqlQueryResult<Result>> {
      if (text.includes("from genio_one_publications")) return { rows: [row as unknown as Result], rowCount: 1 }
      if (text.includes("from genio_one_provider_credential_profile_revisions")) {
        if (text.includes("strategy_digest")) assert.match(text, /credential_ciphertext is not null/)
        return { rows: [profile as unknown as Result], rowCount: 1 }
      }
      return super.query<Result>(text, parameters)
    }
  }
  const store = createPostgresPublicationWorkflowStore({ sql: new CredentialPublicationSql(), resources: { getResource: async () => ({ ...resource, lifecycle: "PUBLISHED" }) } as unknown as ResourceRegistry, gatewayPublicationDelivery: { async deliverInTransaction() {} }, now: () => 1_700_000_003 })
  const result = await store.commitBuild({ tenantId, resourceId, requestId, attemptId, reviewerId: "admin", reviewedAt: 1_700_000_003, projection })
  assert.equal(result.lifecycle, "PUBLISHED")
})
