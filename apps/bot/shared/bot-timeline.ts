import type { Turn } from "../server/generated/v2/Turn"
import type { ThreadItem } from "../server/generated/v2/ThreadItem"

export interface ChatMessage {
  question?: import("./bot-question").BotQuestion
  messageType?: "user_message" | "bot_reply" | "bot_update" | "bot_exchange" | "execution_activity" | "legacy"
  replyToMessageId?: string
  images?: string[]
  timelineRevision?: number
  localOnly?: boolean
  legacySource?: { sourceKey: string; position: number; originalRole: string }
  clientMessageId?: string
  runtimeThreadId?: string
  runtimeTurnId?: string
  runtimeItem?: ThreadItem
  id: string
  role: "user" | "assistant" | "system"
  text: string
  createdAt?: number
  kind?: "handoff" | "group" | "login_wall" | "activity" | "legacy"
  handoffEventType?: "handoff.read" | "handoff.sent" | "handoff.acked" | "handoff.queued" | "handoff.delivered" | "handoff.failed" | "handoff.replied"
  handoffId?: string
  handoffState?: string
  peerBotId?: string
  visibility?: "visible" | "silent"
  handoffThread?: {
    kind?: "task" | "fyi"
    sourceMessageId?: string
    fromBotId: string
    toBotId: string
    fromName: string
    toName: string
    outbound: string
    inbound?: string
  }
  loginWallId?: string
  collectsPassword?: false
}

export function runtimeActivityDetails(item: ThreadItem | undefined): string {
  if (!item) return ""
  switch (item.type) {
    case "commandExecution": return [item.command, item.aggregatedOutput].filter(Boolean).join("\n\n")
    case "mcpToolCall": return [item.tool, item.error?.message, ...(item.result?.content ?? []).flatMap((entry) => entry && typeof entry === "object" && !Array.isArray(entry) && typeof entry.text === "string" ? [entry.text] : [])].filter(Boolean).join("\n\n")
    case "dynamicToolCall": return [item.tool, ...(item.contentItems ?? []).flatMap((entry) => entry.type === "inputText" ? [entry.text] : [])].join("\n\n")
    case "fileChange": return item.changes.map((change) => change.path).join("\n")
    case "plan": return item.text
    case "webSearch": return item.query
    case "imageView": return item.path
    case "contextCompaction": return "先前的工作上下文已整理，對話記錄仍保留。"
    default: return "這筆活動已保留於對話記錄。"
  }
}


const activityTitles: Record<string, string> = {
  mcpToolCall: "工具執行",
  dynamicToolCall: "工具執行",
  commandExecution: "執行指令",
  fileChange: "檔案變更",
  webSearch: "網路搜尋",
  imageView: "檢視圖片",
  imageGeneration: "產生圖片",
  contextCompaction: "已整理工作上下文",
  plan: "工作計畫",
  collabAgentToolCall: "代理協作",
}

export function reconstructTurnMessages(turns: Turn[], completedItemIds: Set<string>, threadId = "") {
  const messages: ChatMessage[] = []
  for (const turn of turns) {
    let replyToMessageId: string | undefined
    for (const [index, item] of turn.items.entries()) {
      const id = `${threadId}:${item.id || `${turn.id}:${index}`}`
      if (turn.status !== "inProgress") completedItemIds.add(id)
      const createdAt = typeof turn.startedAt === "number" ? turn.startedAt * 1000 : undefined
      const common = { id, createdAt, runtimeThreadId: threadId, runtimeTurnId: turn.id }
      if (item.type === "userMessage") {
        replyToMessageId = id
        const text = item.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")
        messages.push({ ...common, messageType: "user_message", role: "user", text: text || "附件", runtimeItem: item, clientMessageId: item.clientId ?? undefined })
      } else if (item.type === "agentMessage") {
        if (turn.status !== "inProgress" && !item.text.trim()) continue
        messages.push({ ...common, messageType: item.phase === "commentary" ? "bot_update" : "bot_reply", replyToMessageId, role: "assistant", text: item.text, runtimeItem: item })
      } else if (activityTitles[item.type]) {
        messages.push({ ...common, messageType: "execution_activity", role: "system", text: activityTitles[item.type]!, kind: "activity", runtimeItem: item })
      }
    }
  }
  return messages
}
