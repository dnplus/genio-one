import type { SqlAdapter, SqlTransaction } from "../../persistence/sql-adapter"
import type {
  ModelPriceCatalog,
  ModelPriceCatalogEntry,
  ReplaceModelPriceCatalogInput,
  UsageCostEstimate,
} from "./module"

const BATCH_SIZE = 250

interface CurrentPriceRow extends Record<string, unknown> {
  source_version: string
  input_cost_per_token: string | number | null
  output_cost_per_token: string | number | null
}

function unpriced(sourceVersion: string | null): UsageCostEstimate {
  return {
    status: "UNPRICED",
    currency: null,
    estimatedCostMicros: null,
    pricingSource: sourceVersion ? "LITELLM" : null,
    pricingVersion: sourceVersion,
  }
}
async function insertEntries(
  transaction: SqlTransaction,
  input: ReplaceModelPriceCatalogInput,
  entries: readonly ModelPriceCatalogEntry[],
): Promise<void> {
  for (let offset = 0; offset < entries.length; offset += BATCH_SIZE) {
    const batch = entries.slice(offset, offset + BATCH_SIZE)
    const parameters: unknown[] = []
    const values = batch.map((entry, index) => {
      const base = index * 8
      parameters.push(
        input.source,
        input.sourceVersion,
        entry.providerId,
        entry.catalogModelKey,
        entry.providerModelId,
        entry.inputCostPerToken,
        entry.outputCostPerToken,
        input.fetchedAt,
      )
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8})`
    })
    await transaction.query(
      `insert into genio_one_model_price_catalog (
        source, source_version, provider_id, catalog_model_key, provider_model_id,
        input_cost_per_token, output_cost_per_token, fetched_at
      ) values ${values.join(",")}
      on conflict (source, source_version, provider_id, catalog_model_key) do update set
        provider_model_id = excluded.provider_model_id,
        input_cost_per_token = excluded.input_cost_per_token,
        output_cost_per_token = excluded.output_cost_per_token,
        fetched_at = excluded.fetched_at`,
      parameters,
    )
  }
}

export function createPostgresModelPriceCatalog(options: { sql: SqlAdapter }): ModelPriceCatalog {
  return {
    async replace(input) {
      if (!/^[a-f0-9]{64}$/.test(input.sourceVersion)) {
        throw new Error("Price catalog source version must be a SHA-256 digest")
      }
      if (!input.entries.length) throw new Error("Price catalog contains no token-priced models")
      await options.sql.transaction(async (transaction) => {
        await transaction.query(
          `update genio_one_price_catalog_versions
           set status = 'LKG'
           where source = $1 and status = 'CURRENT' and source_version <> $2`,
          [input.source, input.sourceVersion],
        )
        await transaction.query(
          `insert into genio_one_price_catalog_versions (
            source, source_version, source_url, fetched_at, status
          ) values ($1,$2,$3,$4,'CURRENT')
          on conflict (source, source_version) do update set
            source_url = excluded.source_url,
            fetched_at = excluded.fetched_at,
            status = 'CURRENT'`,
          [input.source, input.sourceVersion, input.sourceUrl, input.fetchedAt],
        )
        await insertEntries(transaction, input, input.entries)
      })
    },

    async estimate(input) {
      if (
        input.inputTokens === null || input.outputTokens === null ||
        !input.providerId || !input.effectiveModelId
      ) {
        return {
          status: "NOT_APPLICABLE",
          currency: null,
          estimatedCostMicros: null,
          pricingSource: null,
          pricingVersion: null,
        }
      }
      const result = await options.sql.query<CurrentPriceRow>(
        `select version.source_version,
                price.input_cost_per_token,
                price.output_cost_per_token
         from genio_one_price_catalog_versions version
         left join lateral (
           select candidate.input_cost_per_token, candidate.output_cost_per_token
           from genio_one_model_price_catalog candidate
           where candidate.source = version.source
             and candidate.source_version = version.source_version
             and candidate.provider_id = $1
             and (
               lower(candidate.catalog_model_key) = lower($2)
               or lower(candidate.provider_model_id) = lower($2)
               or (
                 length($2) > 7
                 and right(lower($2), 7) = ':latest'
                 and lower(candidate.provider_model_id) = lower(left($2, length($2) - 7))
               )
             )
           order by case
                      when lower(candidate.catalog_model_key) = lower($2) then 0
                      when lower(candidate.provider_model_id) = lower($2) then 1
                      else 2
                    end,
                    length(candidate.catalog_model_key), candidate.catalog_model_key
           limit 1
         ) price on true
         where version.source = 'LITELLM' and version.status = 'CURRENT'
         limit 1`,
        [input.providerId.trim().toUpperCase(), input.effectiveModelId],
      )
      const row = result.rows[0]
      if (!row) return unpriced(null)
      if (row.input_cost_per_token === null || row.output_cost_per_token === null) {
        return unpriced(row.source_version)
      }
      const inputCost = Number(row.input_cost_per_token)
      const outputCost = Number(row.output_cost_per_token)
      if (!Number.isFinite(inputCost) || !Number.isFinite(outputCost)) {
        throw new Error("Current model price is invalid")
      }
      const estimatedCostMicros = Math.round(
        (input.inputTokens * inputCost + input.outputTokens * outputCost) * 1_000_000,
      )
      if (!Number.isSafeInteger(estimatedCostMicros) || estimatedCostMicros < 0) {
        throw new Error("Estimated model cost is outside the supported range")
      }
      return {
        status: "ESTIMATED",
        currency: "USD",
        estimatedCostMicros,
        pricingSource: "LITELLM",
        pricingVersion: row.source_version,
      }
    },
  }
}
