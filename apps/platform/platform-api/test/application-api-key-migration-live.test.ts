import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"

import { loadMigrations, runMigrations } from "../src/persistence/migration-runner"
import { createPostgresSqlAdapter } from "../src/persistence/sql-adapter"

const databaseUrl = process.env.GENIO_ONE_TEST_DATABASE_URL

test("Application API key migration upgrades the existing main history without replacing migration 017", { skip: !databaseUrl }, async () => {
  const schema = `application_key_upgrade_${randomUUID().replaceAll("-", "")}`
  const owner = createPostgresSqlAdapter({ url: databaseUrl! })
  const sql = createPostgresSqlAdapter({ url: databaseUrl!, options: { connection: { search_path: schema } } })
  try {
    await owner.query(`create schema ${schema}`)
    const migrations = await loadMigrations()
    const main = migrations.filter(migration => migration.id <= 24)
    const installed = await runMigrations(sql, { migrations: main })
    assert.equal(installed.applied.length, 24)
    const history = await sql.query(`select migration_id, name, checksum from schema_migrations order by migration_id`)
    assert.equal(history.rows[16]!.name, "shared_memories")
    const upgraded = await runMigrations(sql, { migrations })
    assert.deepEqual(upgraded.applied, [27])
    assert.deepEqual(upgraded.skipped, main.map(migration => migration.id))
    const preserved = await sql.query(`select migration_id, name, checksum from schema_migrations where migration_id <= 24 order by migration_id`)
    assert.deepEqual(preserved.rows, history.rows)
    assert.deepEqual((await runMigrations(sql, { migrations })).applied, [])
    const tables = await sql.query<{ name: string }>(`select table_name as name from information_schema.tables where table_schema = $1`, [schema])
    assert.ok(tables.rows.some(row => row.name === "genio_one_shared_memories"))
    const columns = await sql.query<{ name: string }>(`select column_name as name from information_schema.columns where table_schema = $1 and table_name = 'genio_one_application_api_credentials'`, [schema])
    assert.ok(columns.rows.some(row => row.name === "api_key_hash"))
  } finally {
    await sql.end()
    await owner.query(`drop schema if exists ${schema} cascade`)
    await owner.end()
  }
})
