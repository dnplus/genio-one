import { expect, test } from "bun:test"
import { readBotHistory, searchBotHistory } from "./bot-history-reader"
import type { ChatMessage } from "../shared/bot-timeline"

test("history pages remain stable across new messages and long reads reject changed content", () => {
  const messages: ChatMessage[] = Array.from({ length: 25 }, (_, i) => ({ id: `message-${i}`, role: "user", text: `query ${i}`, runtimeThreadId: "old", runtimeTurnId: `turn-${i}` }))
  const first = searchBotHistory(messages, { query: "query" })
  expect(first.messages).toHaveLength(20)
  expect(first.nextCursor).toBe("message-5")
  messages.push({ id: "new", role: "assistant", text: "query newest" })
  const second = searchBotHistory(messages, { query: "query", cursor: first.nextCursor })
  expect(second.messages.map((entry) => entry.messageId)).toEqual(["message-4", "message-3", "message-2", "message-1", "message-0"])
  expect(second.nextCursor).toBeNull()
  expect(() => searchBotHistory(messages, { cursor: "unknown" })).toThrow("BOT_HISTORY_CURSOR_INVALID")
  messages.push({ id: "long", role: "assistant", text: "a".repeat(4100) + "query end" })
  const found = searchBotHistory(messages, { query: "query end" }).messages[0]!
  expect(found.excerpt).toContain("query end")
  expect(found.truncated).toBe(true)
  const read = readBotHistory(messages, { messageId: found.messageId })
  expect(read.text).toHaveLength(4000)
  const last = readBotHistory(messages, { messageId: found.messageId, offset: read.nextOffset, expectedRevision: read.revision })
  expect(read.text + last.text).toBe(messages.at(-1)!.text)
  messages.at(-1)!.text += " updated"
  expect(() => readBotHistory(messages, { messageId: found.messageId, offset: read.nextOffset, expectedRevision: read.revision })).toThrow("BOT_HISTORY_REVISION_CHANGED")
})
