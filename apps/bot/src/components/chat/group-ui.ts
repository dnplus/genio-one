/** UX P1-b helpers for group turn bubbles in the chat transcript (client-safe). */
import type { ChatMessage } from "../../bots-storage"

export const GROUP_PASS_TOKEN = "(pass)"

export interface GroupTurnMessageDto {
  messageId: string
  botId: string
  botName: string
  round: number
  text: string
  kind: "speak" | "pass"
  visible: boolean
  createdAt: number
}

export function isGroupPassText(text: string): boolean {
  return text.trim() === GROUP_PASS_TOKEN
}

/** Never project (pass) into the visible transcript. */
export function groupMessagesToChat(messages: GroupTurnMessageDto[]): ChatMessage[] {
  return messages
    .filter((m) => m.visible && m.kind === "speak" && !isGroupPassText(m.text))
    .map((m) => ({
      id: m.messageId,
      role: "assistant" as const,
      kind: "group" as const,
      peerBotId: m.botId,
      visibility: "visible" as const,
      text: `${m.botName}：${m.text}`,
      createdAt: m.createdAt,
    }))
}
