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

test("the clean-install baseline encodes the complete current Platform schema", async () => {
  const migrations = await loadMigrations()
  assert.equal(migrations.length, 1)
  assert.equal(migrations[0].id, 1)
  assert.equal(migrations[0].name, "platform_baseline")
  assert.match(migrations[0].checksum, /^[a-f0-9]{64}$/)

  const baseline = migrations[0].sql
  assert.equal(baseline.match(/^CREATE TABLE /gm)?.length, 75)
  assert.equal(baseline.match(/\bFOREIGN KEY \(/g)?.length, 87)
  assert.doesNotMatch(baseline, /^\s*(INSERT INTO|UPDATE|DELETE FROM|DROP TABLE|DROP COLUMN)\b/im)
  assert.doesNotMatch(baseline, /tenant_control_plane_authority/i)
  assert.doesNotMatch(
    baseline,
    /CREATE TABLE genio_one_platform_runtime_(commands|observed_states|report_history)\b/i,
  )

  for (const table of [
    "genio_one_organizations",
    "genio_one_subjects",
    "genio_one_resources",
    "genio_one_resource_connections",
    "genio_one_public_models",
    "genio_one_publications",
    "genio_one_gateway_policy_releases",
    "genio_one_platform_runtime_aggregate_commands",
    "genio_one_access_groups",
    "genio_one_access_group_revisions",
    "genio_one_policy_authoring_settings",
    "genio_one_policy_revisions",
    "genio_one_personal_password_credentials",
  ]) {
    assert.match(baseline, new RegExp(`CREATE TABLE ${table}\\b`))
  }

  assert.match(baseline, /grant_idempotency_key text/i)
  assert.match(baseline, /genio_one_entitlement_grant_idempotency_key_unique/i)
  assert.match(baseline, /require_distinct_reviewer boolean/i)
  assert.match(baseline, /published_by_subject_id text/i)
  assert.match(baseline, /provenance text not null/i)
  assert.match(baseline, /genio_one_gateway_authorization_audit_append_only/i)
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

test("migration runner rejects any applied migration byte or name drift", async () => {
  const migration = createMigration({ id: 1, name: "first", sql: "create table first (id integer);\n" })
  for (const history of [
    { migration_id: 1, name: "first", checksum: "not-the-file-checksum" },
    {
      migration_id: 1,
      name: "first",
      checksum: createMigration({ id: 1, name: "first", sql: `${migration.sql}\n` }).checksum,
    },
    { migration_id: 1, name: "legacy_first", checksum: migration.checksum },
  ]) {
    const adapter = new FakeMigrationAdapter([history])
    await assert.rejects(
      () => runMigrations(adapter, { migrations: [migration] }),
      (error: unknown) =>
        error instanceof MigrationChecksumDriftError &&
        error.migrationId === 1 &&
        error.expectedChecksum === history.checksum &&
        error.actualChecksum === migration.checksum,
    )
  }
})
