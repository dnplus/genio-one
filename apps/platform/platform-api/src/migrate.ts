import { runMigrations } from "./persistence/migration-runner"
import { createPostgresSqlAdapter } from "./persistence/sql-adapter"

const databaseUrl = process.env.GENIO_ONE_DATABASE_URL?.trim()
if (!databaseUrl) {
  throw new Error("GENIO_ONE_DATABASE_URL is required")
}

const sql = createPostgresSqlAdapter({ url: databaseUrl })

try {
  const result = await runMigrations(sql, {
    migrationsDir: process.env.GENIO_ONE_PLATFORM_MIGRATIONS_DIR,
  })
  process.stdout.write(
    `${JSON.stringify({
      component: "genio-one-platform",
      event: "postgres-migrations-complete",
      applied: result.applied,
      skipped: result.skipped,
    })}\n`,
  )
} finally {
  await sql.end({ timeout: 5 })
}
