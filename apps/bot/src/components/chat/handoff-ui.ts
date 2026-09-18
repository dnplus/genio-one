/** UX P1-a helpers for handoff bubbles in the chat transcript (client-safe). */
import type { ChatMessage } from "../../bots-storage"
import type { BotHandoffAckDto, BotHandoffEventDto } from "../../lib/bot-api"
import { splitMentionSegments, type BotMentionSpan } from "./composer-mentions"

export function handoffBubbleText(event: Pick<BotHandoffEventDto, "type" | "kind" | "summary" | "fact">): string {
  if (event.type === "handoff.sent") {
    return event.kind === "fyi" ? `已送出 FYI（可靜默）` : `已送出交接：${event.summary}`
  }
  if (event.type === "handoff.acked") return `已確認送出（對方稍後處理）`
  if (event.type === "handoff.queued") return `交接已排入佇列，對方稍後處理`
  if (event.type === "handoff.delivered") return `收到交接：${event.fact}`
  if (event.type === "handoff.failed") return `交接失敗：${event.summary}`
  return event.summary
}

export function handoffEventsToMessages(events: BotHandoffEventDto[], opts?: { includeSilent?: boolean }): ChatMessage[] {
  return events
    .filter((event) => opts?.includeSilent || event.visibility === "visible")
    .filter((event) =>
      event.type === "handoff.sent"
      || event.type === "handoff.acked"
      || event.type === "handoff.delivered"
      || event.type === "handoff.failed")
    .map((event) => ({
      id: event.eventId,
      role: "system" as const,
      kind: "handoff" as const,
      handoffEventType: event.type,
      handoffId: event.handoffId,
      peerBotId: event.peerBotId,
      visibility: event.visibility,
      text: handoffBubbleText(event),
      createdAt: event.createdAt,
    }))
}

export function ackToCallerMessages(ack: BotHandoffAckDto): ChatMessage[] {
  const acked = ack.events.filter((event) => event.type === "handoff.acked")
  const events = acked.length > 0 ? acked : ack.events
  return handoffEventsToMessages(events, { includeSilent: false })
}

export function extractMentionedBotIds(
  text: string,
  botCandidates: string[] | Array<{ id: string; name?: string }>,
  bindings: BotMentionSpan[] = [],
): string[] {
  const items = botCandidates.map((candidate) => ({ id: typeof candidate === "string" ? candidate : candidate.id, name: typeof candidate === "string" ? candidate : candidate.name ?? candidate.id, description: "", kind: "bot" as const }))
  return [...new Set(splitMentionSegments(text, items, bindings).flatMap((segment) => segment.type === "mention" ? [segment.item.botId || segment.item.id] : []))]
}

export function stripHandoffDeliveryPrefix(summary: string): string {
  return summary.replace(/^Handoff delivered:\s*/i, "").trim()
}

export function restatementFromPeer(_peerName: string, outbound: string, inboundRaw: string): string | null {
  const inbound = stripHandoffDeliveryPrefix(inboundRaw).trim()
  const request = outbound.trim()
  if (!inbound) return null
  if (inbound === request) return null
  if (/^Handoff delivered:/i.test(inboundRaw.trim())) return null
  return inbound
}

export function peerReplyMessages(input: {
  requestId: string
  handoffId?: string
  peerBotId: string
  peerName: string
  fromBotId: string
  fromName: string
  outbound: string
  inbound: string
  createdAt?: number
}): ChatMessage[] {
  const createdAt = input.createdAt ?? Date.now()
  const thread = {
    fromBotId: input.fromBotId,
    toBotId: input.peerBotId,
    fromName: input.fromName,
    toName: input.peerName,
    outbound: input.outbound,
    inbound: stripHandoffDeliveryPrefix(input.inbound) || input.inbound,
  }
  const restatement = restatementFromPeer(input.peerName, input.outbound, input.inbound)
  const messages: ChatMessage[] = [
    {
      id: input.handoffId ? `handoff-status-${input.handoffId}` : `handoff-replied-${input.requestId}`,
      role: "system",
      kind: "handoff",
      handoffEventType: restatement ? "handoff.replied" : "handoff.acked",
      handoffId: input.handoffId,
      peerBotId: input.peerBotId,
      text: restatement ? `${input.peerName} 回覆了` : `已交給 ${input.peerName}，處理中`,
      createdAt,
      handoffThread: thread,
    },
  ]
  if (restatement) {
    messages.push({
      id: `invocation-result-${input.requestId}`,
      role: "assistant",
      text: restatement,
      createdAt: createdAt + 1,
      handoffId: input.handoffId,
      peerBotId: input.peerBotId,
      handoffThread: thread,
    })
  }
  return messages
}

export function targetSessionMessages(input: {
  handoffId: string
  fromBotId: string
  fromName: string
  toBotId: string
  outbound: string
  inbound: string
  createdAt?: number
}): ChatMessage[] {
  const createdAt = input.createdAt ?? Date.now()
  const inbound = restatementFromPeer(input.fromName, input.outbound, input.inbound)
  const thread = {
    fromBotId: input.fromBotId,
    toBotId: input.toBotId,
    fromName: input.fromName,
    toName: "",
    outbound: input.outbound,
    inbound: inbound || undefined,
  }
  const messages: ChatMessage[] = [
    {
      id: `handoff-inbox-${input.handoffId}`,
      role: "system",
      kind: "handoff",
      handoffEventType: "handoff.delivered",
      handoffId: input.handoffId,
      peerBotId: input.fromBotId,
      text: `收到來自 ${input.fromName} 的交接`,
      createdAt,
      handoffThread: { ...thread, toName: thread.toName },
    },
    {
      id: `handoff-inbox-user-${input.handoffId}`,
      role: "user",
      text: input.outbound,
      createdAt: createdAt + 1,
      handoffId: input.handoffId,
      peerBotId: input.fromBotId,
      handoffThread: thread,
    },
  ]
  if (inbound) {
    messages.push({
      id: `handoff-inbox-work-${input.handoffId}`,
      role: "assistant",
      text: inbound,
      createdAt: createdAt + 2,
      handoffId: input.handoffId,
      peerBotId: input.fromBotId,
      handoffThread: thread,
    })
  }
  return messages
}

/** Keep recipient inbox when Codex resume has not yet (or never) materialized the turn. */
export function mergeRecipientTranscript(current: ChatMessage[], reconstructed: ChatMessage[]): ChatMessage[] {
  const reconstructedUserTexts = new Set(
    reconstructed.filter((message) => message.role === "user").map((message) => message.text.trim()),
  )
  const reconstructedIds = new Set(reconstructed.map((message) => message.id))
  const keep = current.filter((message) => {
    if (reconstructedIds.has(message.id)) return false
    if (message.kind === "handoff" || message.kind === "login_wall") return true
    if (typeof message.id === "string" && message.id.startsWith("handoff-inbox")) {
      if (message.role === "user" && reconstructedUserTexts.has(message.text.trim())) return false
      return true
    }
    return false
  })
  return [...keep, ...reconstructed].sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0))
}

export function fanOutBlockedMessage(count: number): ChatMessage {
  return {
    id: `handoff-fanout-blocked-${Date.now()}`,
    role: "system",
    kind: "handoff",
    handoffEventType: "handoff.failed",
    text: `已阻止無腦 fan-out（提到 ${count} 個 Bot）。請一次只交接一個對象，或明示多播。`,
    createdAt: Date.now(),
    visibility: "visible",
  }
}
