import { createHash } from "node:crypto"
import { runtimeActivityDetails, type ChatMessage } from "../shared/bot-timeline"

function document(message: ChatMessage) {
  const details = message.kind === "activity" ? runtimeActivityDetails(message.runtimeItem) : ""
  const text = [message.text, details].filter(Boolean).join("\n\n")
  return { messageId: message.id, role: message.role, kind: message.kind ?? "message", messageType: message.messageType ?? null, replyToMessageId: message.replyToMessageId ?? null, handoffId: message.handoffId ?? null, createdAt: message.createdAt ?? null,
    threadId: message.runtimeThreadId ?? null, turnId: message.runtimeTurnId ?? null,
    legacy: Boolean(message.legacySource), text, revision: createHash("sha256").update(text).digest("hex") }
}

export function searchBotHistory(messages: ChatMessage[], args: { query?: unknown; cursor?: unknown }) {
  if (args.query !== undefined && (typeof args.query !== "string" || args.query.length > 200)) throw new Error("BOT_HISTORY_QUERY_INVALID")
  if (args.cursor !== undefined && typeof args.cursor !== "string") throw new Error("BOT_HISTORY_CURSOR_INVALID")
  const needle = typeof args.query === "string" ? args.query.trim().toLocaleLowerCase() : ""
  const matches = messages.map(document).reverse().filter((entry) => !needle || entry.text.toLocaleLowerCase().includes(needle))
  const cursorIndex = args.cursor === undefined ? -1 : matches.findIndex((entry) => entry.messageId === args.cursor)
  if (args.cursor !== undefined && cursorIndex < 0) throw new Error("BOT_HISTORY_CURSOR_INVALID")
  const page = matches.slice(cursorIndex + 1, cursorIndex + 21)
  return { source: "current_bot_history", dataOnly: true,
    messages: page.map(({ text, ...entry }) => {
      const match = needle ? text.toLocaleLowerCase().indexOf(needle) : 0
      const start = Math.max(0, match - 100)
      return { ...entry, excerpt: text.slice(start, start + 800), truncated: start > 0 || text.length > start + 800 }
    }),
    nextCursor: matches.length > cursorIndex + 21 ? page.at(-1)!.messageId : null }
}

export function readBotHistory(messages: ChatMessage[], args: { messageId?: unknown; offset?: unknown; expectedRevision?: unknown }) {
  if (typeof args.messageId !== "string" || !args.messageId) throw new Error("BOT_HISTORY_MESSAGE_INVALID")
  const offset = args.offset ?? 0
  if (!Number.isSafeInteger(offset) || Number(offset) < 0) throw new Error("BOT_HISTORY_OFFSET_INVALID")
  const message = messages.find((entry) => entry.id === args.messageId)
  if (!message) throw new Error("BOT_HISTORY_MESSAGE_NOT_FOUND")
  const { text, ...entry } = document(message)
  if ((Number(offset) > 0 || args.expectedRevision !== undefined) && args.expectedRevision !== entry.revision) throw new Error("BOT_HISTORY_REVISION_CHANGED")
  if (Number(offset) > text.length) throw new Error("BOT_HISTORY_OFFSET_INVALID")
  const next = Number(offset) + 4000
  return { source: "current_bot_history", dataOnly: true, ...entry, text: text.slice(Number(offset), next), nextOffset: text.length > next ? next : null }
}
