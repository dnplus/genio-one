import assert from "node:assert/strict"
import test from "node:test"

import { parseLiteLlmPriceCatalog } from "../src/capabilities/pricing-catalog/litellm"
import { createPostgresModelPriceCatalog } from "../src/capabilities/pricing-catalog/postgres"
import type { SqlAdapter } from "../src/persistence/sql-adapter"

function estimatorSql(row: Record<string, unknown>): SqlAdapter {
  return {
    async query<Row extends Record<string, unknown>>() {
      return { rows: [row as Row], rowCount: 1 }
    },
    async transaction() {
      throw new Error("transaction is not used by estimate")
    },
  }
}

test("normalizes a provider-prefixed model and ignores the sample schema", () => {
  const entries = parseLiteLlmPriceCatalog(JSON.stringify({
    sample_spec: {
      litellm_provider: "one of",
      input_cost_per_token: 0,
      output_cost_per_token: 0,
    },
    "openai/gpt-example": {
      litellm_provider: "openai",
      input_cost_per_token: 0.000002,
      output_cost_per_token: 0.000008,
    },
  }))

  assert.deepEqual(entries, [{
    providerId: "OPENAI",
    catalogModelKey: "openai/gpt-example",
    providerModelId: "gpt-example",
    inputCostPerToken: 0.000002,
    outputCostPerToken: 0.000008,
  }])
})

test("freezes the LiteLLM version used by the token estimate", async () => {
  const version = "a".repeat(64)
  const catalog = createPostgresModelPriceCatalog({
    sql: estimatorSql({
      source_version: version,
      input_cost_per_token: "0.000002",
      output_cost_per_token: "0.000008",
    }),
  })

  assert.deepEqual(await catalog.estimate({
    providerId: "openai",
    effectiveModelId: "gpt-example",
    inputTokens: 100,
    outputTokens: 25,
    totalTokens: 125,
  }), {
    status: "ESTIMATED",
    currency: "USD",
    estimatedCostMicros: 400,
    pricingSource: "LITELLM",
    pricingVersion: version,
  })
})

test("marks an unmatched provider model unpriced without guessing", async () => {
  const version = "b".repeat(64)
  const catalog = createPostgresModelPriceCatalog({
    sql: estimatorSql({
      source_version: version,
      input_cost_per_token: null,
      output_cost_per_token: null,
    }),
  })

  assert.deepEqual(await catalog.estimate({
    providerId: "OLLAMA",
    effectiveModelId: "local-model",
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
  }), {
    status: "UNPRICED",
    currency: null,
    estimatedCostMicros: null,
    pricingSource: "LITELLM",
    pricingVersion: version,
  })
})

test("marks total-token-only provider usage unpriced without fabricating a split", async () => {
  const catalog = createPostgresModelPriceCatalog({
    sql: {
      async query() {
        throw new Error("pricing lookup is not used without an input/output split")
      },
      async transaction() {
        throw new Error("transaction is not used by estimate")
      },
    },
  })

  assert.deepEqual(await catalog.estimate({
    providerId: "OPENAI",
    effectiveModelId: "gpt-example",
    inputTokens: null,
    outputTokens: null,
    totalTokens: 120,
  }), {
    status: "UNPRICED",
    currency: null,
    estimatedCostMicros: null,
    pricingSource: null,
    pricingVersion: null,
  })
})

test("keeps activities without provider usage not applicable", async () => {
  const catalog = createPostgresModelPriceCatalog({
    sql: {
      async query() {
        throw new Error("pricing lookup is not used without provider usage")
      },
      async transaction() {
        throw new Error("transaction is not used by estimate")
      },
    },
  })

  assert.deepEqual(await catalog.estimate({
    providerId: null,
    effectiveModelId: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
  }), {
    status: "NOT_APPLICABLE",
    currency: null,
    estimatedCostMicros: null,
    pricingSource: null,
    pricingVersion: null,
  })
})

test("matches an explicit LiteLLM zero-cost Ollama model without guessing", async () => {
  const version = "c".repeat(64)
  let query = ""
  const catalog = createPostgresModelPriceCatalog({
    sql: {
      async query<Row extends Record<string, unknown>>(text: string) {
        query = text
        return {
          rows: [{
            source_version: version,
            input_cost_per_token: 0,
            output_cost_per_token: 0,
          } as unknown as Row],
          rowCount: 1,
        }
      },
      async transaction() {
        throw new Error("transaction is not used by estimate")
      },
    },
  })

  assert.deepEqual(await catalog.estimate({
    providerId: "ollama",
    effectiveModelId: "llama3:latest",
    inputTokens: 100,
    outputTokens: 25,
    totalTokens: 125,
  }), {
    status: "ESTIMATED",
    currency: "USD",
    estimatedCostMicros: 0,
    pricingSource: "LITELLM",
    pricingVersion: version,
  })
  assert.match(query, /right\(lower\(\$2\), 7\) = ':latest'/)
})
