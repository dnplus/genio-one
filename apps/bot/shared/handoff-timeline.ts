import type { BotHandoffEvent } from "../server/bot-handoff"
import type { ChatMessage } from "./bot-timeline"

export function projectHandoffTimeline(botId: string, events: BotHandoffEvent[]): ChatMessage[] {
  const handoffs = new Map<string, ChatMessage>()
  for (const event of events) {
    const previous = handoffs.get(event.handoffId)
    const caller = event.fromBotId ? event.fromBotId === botId : event.type === "handoff.sent" || previous?.handoffThread?.fromBotId === botId
    handoffs.set(event.handoffId, {
      id: `handoff:${event.handoffId}`,
      role: "system",
      kind: "handoff",
      messageType: "bot_exchange",
      handoffId: event.handoffId,
      handoffState: event.state,
      visibility: event.visibility,
      replyToMessageId: caller ? event.sourceMessageId : undefined,
      handoffEventType: event.type,
      peerBotId: event.peerBotId,
      text: event.fact,
      createdAt: previous?.createdAt ?? event.createdAt,
      handoffThread: {
        kind: event.kind,
        sourceMessageId: event.sourceMessageId,
        fromBotId: caller ? botId : event.peerBotId,
        toBotId: caller ? event.peerBotId : botId,
        fromName: event.fromName ?? (caller ? "目前 Bot" : "對方 Bot"),
        toName: event.toName ?? (caller ? "對方 Bot" : "目前 Bot"),
        outbound: previous?.handoffThread?.outbound ?? event.fact,
        inbound: event.type === "handoff.replied" ? event.fact : previous?.handoffThread?.inbound,
      },
    })
  }
  return [...handoffs.values()]
}
