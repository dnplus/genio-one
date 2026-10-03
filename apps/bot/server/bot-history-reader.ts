import { createHash } from "node:crypto"
import { runtimeActivityDetails, type ChatMessage } from "../shared/bot-timeline"

function messageText(message: ChatMessage) {
  const details = message.kind === "activity" ? runtimeActivityDetails(message.runtimeItem) : ""
  return [message.text, details].filter(Boolean).join("\n\n")
}

function document(message: ChatMessage, text = messageText(message)) {
  return { messageId: message.id, role: message.role, kind: message.kind ?? "message", messageType: message.messageType ?? null, replyToMessageId: message.replyToMessageId ?? null, handoffId: message.handoffId ?? null, createdAt: message.createdAt ?? null,
    threadId: message.runtimeThreadId ?? null, turnId: message.runtimeTurnId ?? null,
    legacy: Boolean(message.legacySource), text, revision: createHash("sha256").update(text).digest("hex") }
}

export function searchBotHistory(messages: ChatMessage[], args: { query?: unknown; cursor?: unknown }) {
  if (args.query !== undefined && (typeof args.query !== "string" || args.query.length > 200)) throw new Error("BOT_HISTORY_QUERY_INVALID")
  if (args.cursor !== undefined && typeof args.cursor !== "string") throw new Error("BOT_HISTORY_CURSOR_INVALID")
  const needle = typeof args.query === "string" ? args.query.trim().toLocaleLowerCase() : ""

  const matches: { message: ChatMessage; text: string; lowerText: string }[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    const text = messageText(message)
    const lowerText = needle ? text.toLocaleLowerCase() : ""
    if (!needle || lowerText.includes(needle)) {
      matches.push({ message, text, lowerText })
    }
  }

  const cursorIndex = args.cursor === undefined ? -1 : matches.findIndex((entry) => entry.message.id === args.cursor)
  if (args.cursor !== undefined && cursorIndex < 0) throw new Error("BOT_HISTORY_CURSOR_INVALID")

  const pageEntries = matches.slice(cursorIndex + 1, cursorIndex + 21)
  const page = pageEntries.map(({ message, text, lowerText }) => {
    const { text: _text, ...entry } = document(message, text)
    const match = needle ? lowerText.indexOf(needle) : 0
    const start = Math.max(0, match - 100)
    return { ...entry, excerpt: text.slice(start, start + 800), truncated: start > 0 || text.length > start + 800 }
  })

  return { source: "current_bot_history", dataOnly: true,
    messages: page,
    nextCursor: matches.length > cursorIndex + 21 ? pageEntries.at(-1)!.message.id : null }
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
