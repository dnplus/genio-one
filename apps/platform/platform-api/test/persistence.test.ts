import assert from "node:assert/strict"
import test from "node:test"

import type { SqlAdapter, SqlQueryResult, SqlTransaction } from "../src/persistence/sql-adapter"
import {
  createMigration,
  loadMigrations,
  MigrationChecksumDriftError,
  runMigrations,
} from "../src/persistence/migration-runner"

type MigrationRow = { migration_id: number; name: string; checksum: string }

class FakeMigrationTransaction implements SqlTransaction {
  readonly queries: string[] = []
  readonly parameters: unknown[][] = []
  history: MigrationRow[]

  constructor(history: MigrationRow[] = []) {
    this.history = [...history]
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    parameters?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>> {
    this.queries.push(text)
    if (parameters) this.parameters.push([...parameters])
    if (text.includes("from schema_migrations")) {
      return { rows: this.history as unknown as Row[], rowCount: this.history.length }
    }
    if (text.trimStart().startsWith("insert into schema_migrations")) {
      const [migrationId, name, migrationChecksum] = parameters ?? []
      this.history.push({
        migration_id: Number(migrationId),
        name: String(name),
        checksum: String(migrationChecksum),
      })
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  }
}

class FakeMigrationAdapter implements SqlAdapter {
  readonly transactions: FakeMigrationTransaction[] = []
  readonly history: MigrationRow[]

  constructor(history: MigrationRow[] = []) {
    this.history = history
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    _text: string,
    _parameters?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>> {
    return { rows: [], rowCount: 0 }
  }

  async transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
    const transaction = new FakeMigrationTransaction(this.history)
    this.transactions.push(transaction)
    const value = await work(transaction)
    this.history.splice(0, this.history.length, ...transaction.history)
    return value
  }
}

test("numbered migrations are ordered and encode the normalized ownership boundaries", async () => {
  const migrations = await loadMigrations()
  assert.deepEqual(
    migrations.slice(0, 4).map((migration) => migration.id),
    [1, 2, 3, 4],
  )
  assert.ok(migrations.length >= 4)
  assert.ok(migrations.every((migration) => /^[a-f0-9]{64}$/.test(migration.checksum)))

  const foundation = migrations[0].sql
  const routing = migrations[1].sql
  const integrity = migrations[2].sql
  const modelMappings = migrations[3].sql
  const runtimeDelivery = migrations.find((migration) => migration.id === 7)?.sql
  const gatewayPolicyReleases = migrations.find((migration) => migration.id === 8)?.sql
  const aggregateRuntimeDelivery = migrations.find((migration) => migration.id === 9)?.sql
  const gatewayRoutingArtifact = migrations.find((migration) => migration.id === 12)?.sql
  const typescriptAuthority = migrations.find((migration) => migration.id === 35)?.sql
  const removedAuthority = migrations.find((migration) => migration.id === 36)?.sql
  const removedLegacyRuntimeDelivery = migrations.find((migration) => migration.id === 52)?.sql
  const runtimePolicyCatalog = migrations.find((migration) => migration.id === 94)?.sql
  const entitlementGrantIdempotency = migrations.find((migration) => migration.id === 100)?.sql
  assert.ok(runtimeDelivery)
  assert.ok(gatewayPolicyReleases)
  assert.ok(aggregateRuntimeDelivery)
  assert.ok(gatewayRoutingArtifact)
  assert.ok(typescriptAuthority)
  assert.ok(removedAuthority)
  assert.ok(removedLegacyRuntimeDelivery)
  assert.ok(runtimePolicyCatalog)
  assert.ok(entitlementGrantIdempotency)
  assert.match(foundation, /create table if not exists genio_one_organizations/i)
  assert.match(foundation, /create table if not exists genio_one_resources/i)
  assert.match(foundation, /create table if not exists genio_one_resource_connections/i)
  assert.match(foundation, /create table if not exists genio_one_provider_profiles/i)
  assert.match(foundation, /create table if not exists genio_one_public_models/i)
  assert.match(foundation, /create table if not exists genio_one_publications/i)
  assert.match(foundation, /endpoint_revision bigint not null/i)
  assert.match(foundation, /resource_revision bigint not null/i)
  assert.match(foundation, /resource_digest text not null/i)
  assert.match(foundation, /policy_revision bigint not null/i)
  assert.match(foundation, /request_snapshot jsonb not null/i)
  assert.match(foundation, /review_snapshot jsonb not null/i)
  assert.match(foundation, /dns_proof_status text not null/i)
  assert.doesNotMatch(foundation, /genio_one_resources[\s\S]*publication_endpoint\s+jsonb/i)
  assert.match(foundation, /credential_ref text/i)
  assert.doesNotMatch(foundation, /secret_value|api_key\s+text|password\s+text/i)

  assert.match(routing, /create table if not exists tenant_control_plane_authority/i)
  assert.match(routing, /authority text not null default 'RUST'/i)
  assert.match(routing, /authority in \('RUST', 'TYPESCRIPT'\)/i)
  assert.match(typescriptAuthority, /alter column authority set default 'TYPESCRIPT'/i)
  assert.match(typescriptAuthority, /where authority = 'RUST'/i)
  assert.match(removedAuthority, /drop table if exists tenant_control_plane_authority/i)
  assert.match(routing, /create table if not exists genio_one_model_route_transitions/i)
  assert.match(routing, /capability_id text not null/i)
  assert.match(routing, /eligible_connection_ids jsonb not null/i)
  assert.match(routing, /subject_id text not null/i)
  assert.match(routing, /client_id text not null/i)
  assert.match(routing, /public_model_id text not null/i)
  assert.match(routing, /session_id text not null/i)
  assert.doesNotMatch(routing, /genio_one_model_route_leases/i)
  assert.match(routing, /create table if not exists genio_one_mutation_idempotency_receipts/i)
  assert.match(integrity, /genio_one_publications_one_active_idx/i)
  assert.match(integrity, /genio_one_gateway_projections_publication_fk/i)
  assert.match(integrity, /genio_one_projection_chain_resource_idx/i)
  assert.doesNotMatch(integrity, /genio_one_gateway_projection_enforcement_chains/i)
  assert.match(integrity, /genio_one_route_transition_to_connection_fk/i)
  assert.match(modelMappings, /create table if not exists genio_one_connection_model_mappings/i)
  assert.match(modelMappings, /provider_model text not null/i)
  assert.match(modelMappings, /genio_one_route_transition_to_mapping_fk/i)
  assert.match(modelMappings, /contains legacy rows/i)
  assert.doesNotMatch(modelMappings, /insert into genio_one_connection_model_mappings/i)
  assert.match(runtimeDelivery, /create table if not exists genio_one_platform_runtime_registrations/i)
  assert.match(runtimeDelivery, /create table if not exists genio_one_platform_runtime_commands/i)
  assert.doesNotMatch(
    runtimeDelivery,
    /create table if not exists genio_one_runtime_(commands|observed_states|report_history|session_leases)/i,
  )
  assert.match(removedLegacyRuntimeDelivery, /drop table if exists genio_one_platform_runtime_commands/i)
  assert.match(removedLegacyRuntimeDelivery, /drop table if exists genio_one_platform_runtime_observed_states/i)
  assert.match(removedLegacyRuntimeDelivery, /drop table if exists genio_one_platform_runtime_report_history/i)
  assert.match(runtimePolicyCatalog, /create table if not exists genio_one_policy_revisions/i)
  assert.match(runtimePolicyCatalog, /provenance in \('SYSTEM_SEED', 'TENANT_AUTHORED'\)/i)
  assert.match(runtimePolicyCatalog, /genio_one_policy_revisions_latest_idx/i)
  assert.match(
    gatewayPolicyReleases,
    /create table genio_one_gateway_policy_releases/i,
  )
  assert.match(
    gatewayPolicyReleases,
    /create table genio_one_gateway_policy_release_projections/i,
  )
  assert.match(
    gatewayPolicyReleases,
    /create table genio_one_gateway_policy_release_manifests/i,
  )
  assert.match(
    gatewayPolicyReleases,
    /create table genio_one_gateway_policy_release_heads/i,
  )
  assert.match(gatewayPolicyReleases, /pg_advisory_xact_lock|head_revision/i)
  assert.doesNotMatch(
    gatewayPolicyReleases,
    /select\s+max\s*\(\s*(revision|head_revision)\s*\)/i,
  )
  assert.match(
    aggregateRuntimeDelivery,
    /create table if not exists genio_one_platform_runtime_capabilities/i,
  )
  assert.match(
    aggregateRuntimeDelivery,
    /create table if not exists genio_one_platform_runtime_aggregate_commands/i,
  )
  assert.match(
    aggregateRuntimeDelivery,
    /create table if not exists genio_one_platform_runtime_aggregate_observed_states/i,
  )
  assert.match(
    aggregateRuntimeDelivery,
    /create table if not exists genio_one_platform_runtime_aggregate_report_history/i,
  )
  assert.match(
    aggregateRuntimeDelivery,
    /package_digest\s+~\s+'\^\[a-f0-9\]\{64\}\$'/i,
  )
  assert.match(aggregateRuntimeDelivery, /foreign key[\s\S]*runtime_registrations/i)
  assert.doesNotMatch(
    aggregateRuntimeDelivery,
    /alter table\s+genio_one_platform_runtime_(commands|observed_states|report_history)/i,
  )
  assert.match(gatewayRoutingArtifact, /gateway_routing_artifact\s+bytea\s+not null/i)
  assert.match(gatewayRoutingArtifact, /gateway_routing_artifact_sha256\s+text\s+not null/i)
  assert.match(gatewayRoutingArtifact, /gateway_routing_artifact_key_id\s+text\s+not null/i)
  assert.match(gatewayRoutingArtifact, /contains v1 rows/i)
  assert.match(entitlementGrantIdempotency, /add column if not exists grant_idempotency_key text/i)
  assert.match(entitlementGrantIdempotency, /add column if not exists grant_request_digest text/i)
  assert.match(entitlementGrantIdempotency, /unique index genio_one_entitlement_grant_idempotency_key_unique/i)
  assert.match(entitlementGrantIdempotency, /where grant_idempotency_key is not null/i)
  assert.doesNotMatch(entitlementGrantIdempotency, /\b(update|delete|revoke)\b/i)
})

test("migration runner applies once, skips matching history, and takes a transaction advisory lock", async () => {
  const migrations = [
    createMigration({ id: 1, name: "first", sql: "create table first (id integer);" }),
    createMigration({ id: 2, name: "second", sql: "create table second (id integer);" }),
  ]
  const adapter = new FakeMigrationAdapter()
  const first = await runMigrations(adapter, { migrations, advisoryLockKey: "test-lock" })
  assert.deepEqual(first, { applied: [1, 2], skipped: [] })
  assert.equal(adapter.transactions.length, 1)
  assert.ok(adapter.transactions[0].queries.some((query) => query.includes("pg_advisory_xact_lock")))
  assert.deepEqual(adapter.transactions[0].parameters[0], ["test-lock"])

  const second = await runMigrations(adapter, { migrations, advisoryLockKey: "test-lock" })
  assert.deepEqual(second, { applied: [], skipped: [1, 2] })
  assert.equal(adapter.transactions.length, 2)
})

test("migration runner fails closed when an applied migration checksum or name drifts", async () => {
  const migration = createMigration({ id: 1, name: "first", sql: "create table first (id integer);" })
  const adapter = new FakeMigrationAdapter([
    { migration_id: 1, name: "first", checksum: "not-the-file-checksum" },
  ])
  await assert.rejects(
    () => runMigrations(adapter, { migrations: [migration] }),
    (error: unknown) =>
      error instanceof MigrationChecksumDriftError &&
      error.migrationId === 1 &&
      error.expectedChecksum === "not-the-file-checksum" &&
      error.actualChecksum === migration.checksum,
  )
})

test("migration runner tolerates one final newline change in applied history", async () => {
  const current = createMigration({ id: 1, name: "first", sql: "select 1;\n" })
  const previouslyApplied = createMigration({ id: 1, name: "first", sql: "select 1;\n\n" })
  const adapter = new FakeMigrationAdapter([
    { migration_id: 1, name: "first", checksum: previouslyApplied.checksum },
  ])

  await assert.doesNotReject(() => runMigrations(adapter, { migrations: [current] }))
})
