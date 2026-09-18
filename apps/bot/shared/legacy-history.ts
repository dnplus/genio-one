export interface LegacyHistoryEntry {
  sourceKey: string
  position: number
  message: Record<string, unknown>
}

export function validateLegacyHistory(botId: string, input: unknown): LegacyHistoryEntry[] {
  if (!Array.isArray(input) || input.length > 200) throw new Error("LEGACY_HISTORY_INVALID")
  return input.map((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.sourceKey !== "string"
      || !entry.sourceKey.startsWith(`genio.bot.messages.${botId}.`)
      || !Number.isSafeInteger(entry.position) || entry.position < 0
      || !entry.message || typeof entry.message !== "object" || Array.isArray(entry.message)) throw new Error("LEGACY_HISTORY_INVALID")
    const message = entry.message
    if (!["user", "assistant", "system"].includes(message.role) || typeof message.text !== "string") throw new Error("LEGACY_HISTORY_INVALID")
    return { sourceKey: entry.sourceKey, position: entry.position, message }
  })
}

export function readLegacyHistory(storage: Pick<Storage, "length" | "key" | "getItem">, botId: string): LegacyHistoryEntry[] {
  const entries: LegacyHistoryEntry[] = []
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)
    if (!key?.startsWith(`genio.bot.messages.${botId}.`)) continue
    const messages: unknown = JSON.parse(storage.getItem(key) ?? "[]")
    if (!Array.isArray(messages)) throw new Error("LEGACY_HISTORY_INVALID")
    messages.forEach((message, position) => {
      const [entry] = validateLegacyHistory(botId, [{ sourceKey: key, position, message }])
      entries.push(entry!)
    })
  }
  return entries
}
