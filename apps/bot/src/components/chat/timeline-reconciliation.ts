import type { ChatMessage } from "../../bots-storage"

export function reconcileTimeline(current: ChatMessage[], snapshot: ChatMessage[]): ChatMessage[] {
  const previous = new Map(current.map((message) => [message.id, message]))
  const ids = new Set(snapshot.map((message) => message.id))
  const acknowledged = new Set(snapshot.flatMap((message) => message.clientMessageId ? [message.clientMessageId] : []))
  const merged = snapshot.map((message) => {
    const live = previous.get(message.id)
    return live && (live.timelineRevision ?? 0) > (message.timelineRevision ?? 0) ? live : message
  })
  for (const message of current) {
    if (ids.has(message.id)) continue
    if (message.localOnly || message.timelineRevision !== undefined || (message.clientMessageId && !message.runtimeItem && !acknowledged.has(message.clientMessageId))) merged.push(message)
  }
  return merged
}
