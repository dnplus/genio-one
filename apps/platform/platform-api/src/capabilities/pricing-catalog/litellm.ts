import type { ModelPriceCatalogEntry } from "./module"

interface LiteLlmPriceRecord {
  litellm_provider?: unknown
  input_cost_per_token?: unknown
  output_cost_per_token?: unknown
  }
function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null
}

export function parseLiteLlmPriceCatalog(input: string): ModelPriceCatalogEntry[] {
  const parsed = JSON.parse(input) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("LiteLLM price catalog must be a JSON object")
  }
  const entries: ModelPriceCatalogEntry[] = []
  for (const [catalogModelKey, unknownRecord] of Object.entries(parsed)) {
    if (catalogModelKey === "sample_spec" || !unknownRecord || typeof unknownRecord !== "object" || Array.isArray(unknownRecord)) continue
    const record = unknownRecord as LiteLlmPriceRecord
    const provider = typeof record.litellm_provider === "string"
      ? record.litellm_provider.trim().toUpperCase()
      : ""
    const inputCost = finiteNonNegative(record.input_cost_per_token)
    const outputCost = finiteNonNegative(record.output_cost_per_token)
    if (!provider || inputCost === null || outputCost === null) continue
    const prefix = `${provider.toLowerCase()}/`
    const providerModelId = catalogModelKey.toLowerCase().startsWith(prefix)
      ? catalogModelKey.slice(prefix.length)
      : catalogModelKey
    if (!providerModelId) continue
    entries.push({
      providerId: provider,
      catalogModelKey,
      providerModelId,
      inputCostPerToken: inputCost,
      outputCostPerToken: outputCost,
    })
  }
  return entries.sort((left, right) =>
    left.providerId.localeCompare(right.providerId) ||
    left.catalogModelKey.localeCompare(right.catalogModelKey),
  )
}
