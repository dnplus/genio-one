import type { BotServerContext } from "./context"
import type { GenioPrincipal } from "./runtime-broker"

export interface BotToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, boolean>
}

export interface BotToolExecution {
  context: BotServerContext
  botId: string
  principal: GenioPrincipal
  accessToken: string
}

export interface BotToolResponse {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>
  isError?: boolean
}

export function botToolText(value: unknown): BotToolResponse {
  return { content: [{ type: "text", text: JSON.stringify(value) }], isError: false }
}
