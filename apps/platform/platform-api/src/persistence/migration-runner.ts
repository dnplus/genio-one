import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

import type { SqlAdapter, SqlTransaction } from "./sql-adapter"

const MIGRATION_FILE = /^(\d+)_([a-z0-9][a-z0-9_-]*)\.sql$/
const DEFAULT_LOCK_KEY = "genio-one-platform-api-migrations"

export interface Migration {
  id: number
  name: string
  filename: string
  sql: string
  checksum: string
}

export interface MigrationDefinition {
  id: number
  name: string
  sql: string
  filename?: string
}

export interface MigrationRunResult {
  applied: number[]
  skipped: number[]
}

export interface MigrationRunnerOptions {
  migrationsDir?: string
  migrations?: readonly Migration[]
  advisoryLockKey?: string
}

class MigrationDefinitionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MigrationDefinitionError"
  }
}

export class MigrationChecksumDriftError extends Error {
  constructor(
    readonly migrationId: number,
    readonly expectedChecksum: string,
    readonly actualChecksum: string,
  ) {
    super(
      `Migration ${migrationId} checksum drift: expected ${expectedChecksum}, got ${actualChecksum}`,
    )
    this.name = "MigrationChecksumDriftError"
  }
}

class MigrationHistoryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MigrationHistoryError"
  }
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex")
}

export function createMigration(input: MigrationDefinition): Migration {
  if (!Number.isInteger(input.id) || input.id < 1) {
    throw new MigrationDefinitionError("Migration id must be a positive integer")
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(input.name)) {
    throw new MigrationDefinitionError(`Invalid migration name: ${input.name}`)
  }
  if (!input.sql.trim()) {
    throw new MigrationDefinitionError(`Migration ${input.id} is empty`)
  }
  return {
    id: input.id,
    name: input.name,
    filename: input.filename ?? `${String(input.id).padStart(3, "0")}_${input.name}.sql`,
    sql: input.sql,
    checksum: checksum(input.sql),
  }
}

/** Load numbered SQL files in lexical migration order and reject duplicates. */
export async function loadMigrations(
  directory = fileURLToPath(new URL("../../migrations", import.meta.url)),
): Promise<Migration[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const migrations: Migration[] = []
  const ids = new Set<number>()
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sql")) continue
    const match = MIGRATION_FILE.exec(entry.name)
    if (!match) {
      throw new MigrationDefinitionError(`Invalid migration filename: ${entry.name}`)
    }
    const id = Number.parseInt(match[1], 10)
    if (ids.has(id)) {
      throw new MigrationDefinitionError(`Duplicate migration id: ${id}`)
    }
    ids.add(id)
    migrations.push(
      createMigration({
        id,
        name: match[2],
        filename: entry.name,
        sql: await readFile(join(directory, entry.name), "utf8"),
      }),
    )
  }
  return migrations.sort((left, right) => left.id - right.id)
}

const CREATE_HISTORY_TABLE = `
create table if not exists schema_migrations (
  migration_id integer primary key,
  name text not null,
  checksum text not null,
  applied_at timestamptz not null default now()
)`

const SELECT_HISTORY = `
select migration_id, name, checksum
from schema_migrations
order by migration_id`

const INSERT_HISTORY = `
insert into schema_migrations (migration_id, name, checksum)
values ($1, $2, $3)`

function migrationMap(migrations: readonly Migration[]): Map<number, Migration> {
  const byId = new Map<number, Migration>()
  for (const migration of migrations) {
    if (byId.has(migration.id)) {
      throw new MigrationDefinitionError(`Duplicate migration id: ${migration.id}`)
    }
    byId.set(migration.id, migration)
  }
  return byId
}

async function applyMigrations(
  transaction: SqlTransaction,
  migrations: readonly Migration[],
  advisoryLockKey: string,
): Promise<MigrationRunResult> {
  // Transaction-scoped advisory lock is released automatically on commit or
  // rollback, including when the driver returns a pooled connection.
  await transaction.query("select pg_advisory_xact_lock(hashtext($1))", [advisoryLockKey])
  await transaction.query(CREATE_HISTORY_TABLE)
  const history = await transaction.query<{
    migration_id: number | string
    name: string
    checksum: string
  }>(SELECT_HISTORY)
  const known = migrationMap(migrations)
  for (const row of history.rows) {
    const migrationId = Number(row.migration_id)
    const migration = known.get(migrationId)
    if (!migration) {
      throw new MigrationHistoryError(
        `Database contains migration ${migrationId}, but no matching file is present`,
      )
    }
    if (row.name !== migration.name || row.checksum !== migration.checksum) {
      throw new MigrationChecksumDriftError(
        migrationId,
        row.checksum,
        migration.checksum,
      )
    }
  }

  const appliedIds = new Set(history.rows.map((row) => Number(row.migration_id)))
  const applied: number[] = []
  const skipped: number[] = []
  for (const migration of [...migrations].sort((left, right) => left.id - right.id)) {
    if (appliedIds.has(migration.id)) {
      skipped.push(migration.id)
      continue
    }
    await transaction.query(migration.sql)
    await transaction.query(INSERT_HISTORY, [migration.id, migration.name, migration.checksum])
    applied.push(migration.id)
  }
  return { applied, skipped }
}

class MigrationRunner {
  private readonly migrationsDir: string | undefined
  private readonly migrations: readonly Migration[] | undefined
  private readonly advisoryLockKey: string

  constructor(options: MigrationRunnerOptions = {}) {
    this.migrationsDir = options.migrationsDir
    this.migrations = options.migrations
    this.advisoryLockKey = options.advisoryLockKey ?? DEFAULT_LOCK_KEY
  }

  async run(adapter: SqlAdapter): Promise<MigrationRunResult> {
    const migrations = this.migrations ?? (await loadMigrations(this.migrationsDir))
    migrationMap(migrations)
    return adapter.transaction((transaction) =>
      applyMigrations(transaction, migrations, this.advisoryLockKey),
    )
  }
}

export function runMigrations(
  adapter: SqlAdapter,
  options: MigrationRunnerOptions = {},
): Promise<MigrationRunResult> {
  return new MigrationRunner(options).run(adapter)
}
