import { createHash } from "node:crypto"

import { createPostgresModelPriceCatalog } from "./capabilities/pricing-catalog/postgres"
import { parseLiteLlmPriceCatalog } from "./capabilities/pricing-catalog/litellm"
import { createPostgresSqlAdapter } from "./persistence/sql-adapter"
import { runMigrations } from "./persistence/migration-runner"

const sourceUrl = process.env.GENIO_ONE_LITELLM_PRICE_CATALOG_URL?.trim() ||
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
const databaseUrl = process.env.GENIO_ONE_DATABASE_URL?.trim()
if (!databaseUrl) throw new Error("GENIO_ONE_DATABASE_URL is required")

const response = await fetch(sourceUrl, { headers: { accept: "application/json" } })
if (!response.ok) throw new Error(`LiteLLM price catalog fetch failed (${response.status})`)
const body = await response.text()
const sourceVersion = createHash("sha256").update(body).digest("hex")
const entries = parseLiteLlmPriceCatalog(body)
const sql = createPostgresSqlAdapter({ url: databaseUrl })

try {
  await runMigrations(sql, {
    migrationsDir: process.env.GENIO_ONE_PLATFORM_MIGRATIONS_DIR,
  })
  await createPostgresModelPriceCatalog({ sql }).replace({
    source: "LITELLM",
    sourceUrl,
    sourceVersion,
    fetchedAt: Math.floor(Date.now() / 1_000),
    entries,
  })
  process.stdout.write(`${JSON.stringify({
    event: "litellm-price-catalog-synced",
    source_version: sourceVersion,
    model_count: entries.length,
  })}\n`)
} finally {
  await sql.end({ timeout: 2 })
}
