import type { BloubAvatarValue } from "../../avatar/bloub-avatar"

export interface MentionItem {
  id: string
  name: string
  description: string
  kind: "skill" | "resource" | "tool" | "bot"
  enabled?: boolean
  path?: string
  botId?: string
  ownerSubjectId?: string
  avatar?: BloubAvatarValue
}

export interface BotMentionSpan { botId: string; start: number; end: number; token: string }

export function moveBotMentionSpans(previous: string, next: string, spans: BotMentionSpan[] = []): BotMentionSpan[] {
  let prefix = 0
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix++
  let suffix = 0
  while (suffix < previous.length - prefix && suffix < next.length - prefix && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++
  const delta = next.length - previous.length
  return spans.flatMap((span) => {
    const moved = span.end <= prefix ? span : span.start >= previous.length - suffix ? { ...span, start: span.start + delta, end: span.end + delta } : null
    return moved && moved.start >= 0 && moved.end > moved.start && next.slice(moved.start, moved.end) === moved.token ? [moved] : []
  })
}

export type ComposerSegment =
  | { type: "text"; value: string }
  | { type: "mention"; item: MentionItem; token: string }
  | { type: "ambiguous"; token: string }

export function mentionToken(item: MentionItem): string {
  return item.kind === "bot" ? `@${item.name}` : `@${item.id}`
}

export function splitMentionSegments(text: string, items: MentionItem[], bindings: BotMentionSpan[] = []): ComposerSegment[] {
  if (!text) return [{ type: "text", value: "" }]
  const grouped = new Map<string, MentionItem[]>()
  for (const item of items) for (const token of new Set([mentionToken(item), ...(item.kind === "bot" ? [`@${item.botId || item.id}`] : [])])) {
    const group = grouped.get(token) ?? []
    if (!group.some((entry) => entry.kind === item.kind && (entry.botId || entry.id) === (item.botId || item.id))) group.push(item)
    grouped.set(token, group)
  }
  const tokens: Array<{ token: string; items: MentionItem[]; start?: number }> = [...grouped].map(([token, candidates]) => ({ token, items: candidates }))
  for (const binding of bindings) {
    const item = items.find((entry) => entry.kind === "bot" && (entry.botId || entry.id) === binding.botId)
    if (text.slice(binding.start, binding.end) === binding.token) tokens.push({ token: binding.token, items: item ? [item] : [], start: binding.start })
  }
  tokens.sort((a, b) => Number(b.start !== undefined) - Number(a.start !== undefined) || b.token.length - a.token.length)
  const boundary = (value: string | undefined) => value === undefined || /[\s()[\]{}，。！？、：；,.!?;:「」『』]/u.test(value)
  const segments: ComposerSegment[] = []
  let offset = 0
  while (offset < text.length) {
    let earliest = -1
    let hit: (typeof tokens)[number] | undefined
    for (const entry of tokens) {
      let index = entry.start ?? text.indexOf(entry.token, offset)
      while (index >= offset && index >= 0) {
        if (boundary(text[index - 1]) && boundary(text[index + entry.token.length])) break
        if (entry.start !== undefined) { index = -1; break }
        index = text.indexOf(entry.token, index + entry.token.length)
      }
      if (index < offset || index < 0) continue
      if (earliest < 0 || index < earliest) { earliest = index; hit = entry }
    }
    if (!hit) { segments.push({ type: "text", value: text.slice(offset) }); break }
    if (earliest > offset) segments.push({ type: "text", value: text.slice(offset, earliest) })
    segments.push(hit.items.length === 1 ? { type: "mention", item: hit.items[0]!, token: hit.token } : { type: "ambiguous", token: hit.token })
    offset = earliest + hit.token.length
  }
  return segments
}

export function stripBotMention(text: string, item: MentionItem, bindings: BotMentionSpan[] = []): string {
  return splitMentionSegments(text, [item], bindings).map((segment) => segment.type === "text" ? segment.value : segment.type === "ambiguous" ? segment.token : "").join("").trim()
}

export function serializeComposerNode(root: HTMLElement): string {
  let out = ""
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? ""
      return
    }
    if (!(node instanceof HTMLElement)) return
    if (node.dataset.mentionToken) {
      out += node.dataset.mentionToken
      return
    }
    if (node.tagName === "BR") {
      out += "\n"
      return
    }
    if (node.tagName === "DIV" && node !== root) {
      if (out.length > 0 && !out.endsWith("\n")) out += "\n"
    }
    for (const child of Array.from(node.childNodes)) walk(child)
  }
  walk(root)
  return out.replace(/\u00a0/g, " ")
}
