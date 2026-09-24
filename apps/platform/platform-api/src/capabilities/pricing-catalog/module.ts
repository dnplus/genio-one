export interface ModelPriceCatalogEntry {
  providerId: string
  catalogModelKey: string
  providerModelId: string
  inputCostPerToken: number
  outputCostPerToken: number
}
export interface ReplaceModelPriceCatalogInput {
  source: "LITELLM"
  sourceUrl: string
  sourceVersion: string
  fetchedAt: number
  entries: readonly ModelPriceCatalogEntry[]
}

export interface UsageCostEstimate {
  status: "ESTIMATED" | "UNPRICED" | "NOT_APPLICABLE"
  currency: "USD" | null
  estimatedCostMicros: number | null
  pricingSource: "LITELLM" | null
  pricingVersion: string | null
}

export interface UsageCostEstimator {
  estimate(input: {
    providerId: string | null
    effectiveModelId: string | null
    inputTokens: number | null
    outputTokens: number | null
    totalTokens: number | null
  }): Promise<UsageCostEstimate>
}

export interface ModelPriceCatalog extends UsageCostEstimator {
  replace(input: ReplaceModelPriceCatalogInput): Promise<void>
}
