import { expect, test } from "bun:test"
import { readLegacyHistory, validateLegacyHistory } from "./legacy-history"

test("legacy discovery includes orphaned conversations and keeps repeated text and original positions", () => {
  const data = new Map([
    ["genio.bot.messages.a.old", JSON.stringify([{ role: "user", text: "再次確認", id: "1" }, { role: "user", text: "再次確認", id: "2" }])],
    ["genio.bot.messages.b.old", JSON.stringify([{ role: "user", text: "其他 Bot" }])],
  ])
  const entries = readLegacyHistory({ length: data.size, key: (i) => [...data.keys()][i] ?? null, getItem: (key) => data.get(key) ?? null }, "a")
  expect(entries).toHaveLength(2)
  expect(entries.map((entry) => entry.position)).toEqual([0, 1])
  expect(data.size).toBe(2)
  expect(() => validateLegacyHistory("b", entries)).toThrow("LEGACY_HISTORY_INVALID")
})
