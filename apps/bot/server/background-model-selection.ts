import { selectPublicModel, type BotModelDirectory, type BotModelRoute } from "./model-directory"
import type { GenioPrincipal } from "./runtime-broker"

function nativeModel(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const id = typeof row.id === "string" && row.id.trim() ? row.id.trim() : null
  const model = typeof row.model === "string" && row.model.trim() ? row.model.trim() : id
  return model && row.hidden !== true ? { model, isDefault: row.isDefault === true } : null
}

export async function selectBackgroundModel(input: {
  route: BotModelRoute
  modelDirectory: BotModelDirectory
  principal: GenioPrincipal
  botId: string
  accessToken?: string
  request: (method: "model/list", params: Record<string, unknown>) => Promise<unknown>
}) {
  if (input.route.kind === "genio-gateway") {
    const model = selectPublicModel(await input.modelDirectory.resolve(input.principal, input.botId, input.route, input.accessToken), null)
    if (!model || model === "*") throw new Error("BOT_MODEL_UNAVAILABLE")
    return model
  }
  let fallback: string | null = null
  let cursor: string | null = null
  const seen = new Set<string>()
  for (let page = 0; page < 20; page++) {
    let response: unknown
    try {
      response = await input.request("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) })
    } catch {
      throw new Error("BOT_MODEL_UNAVAILABLE")
    }
    const result = response && typeof response === "object" ? response as { data?: unknown; nextCursor?: unknown } : null
    if (!result || !Array.isArray(result.data)) throw new Error("BOT_MODEL_UNAVAILABLE")
    const models = result.data.map(nativeModel).filter((model): model is { model: string; isDefault: boolean } => model !== null)
    const selected = models.find((model) => model.isDefault)
    if (selected) return selected.model
    fallback ??= models[0]?.model ?? null
    if (result.nextCursor === null) break
    if (typeof result.nextCursor !== "string" || !result.nextCursor || seen.has(result.nextCursor)) throw new Error("BOT_MODEL_UNAVAILABLE")
    seen.add(result.nextCursor)
    cursor = result.nextCursor
  }
  if (!fallback) throw new Error("BOT_MODEL_UNAVAILABLE")
  return fallback
}
