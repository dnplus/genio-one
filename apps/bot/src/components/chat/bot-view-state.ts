import { useCallback, useMemo, useSyncExternalStore } from "react"
import { moveBotMentionSpans, type BotMentionSpan } from "./composer-mentions"

export interface BotReadingPosition { anchorId?: string; offset: number; scrollTop: number; atBottom: boolean }
export interface BotViewState { handoffRequest?: { key: string; id: string }; draft: string; mentions?: BotMentionSpan[]; position?: BotReadingPosition; saveFailed?: boolean }
const empty = JSON.stringify({ draft: "" })
const cache = new Map<string, string>()
const listeners = new Set<() => void>()

export function botViewKey(tenantId: string, subjectId: string, botId: string) {
  return `genio.bot.view.${JSON.stringify([tenantId, subjectId, botId])}`
}

export function parseBotView(raw: string | null): BotViewState {
  try {
    const value = JSON.parse(raw ?? empty)
    const position = value.position
    return {
      ...(value.handoffRequest && typeof value.handoffRequest.key === "string" && typeof value.handoffRequest.id === "string" ? { handoffRequest: value.handoffRequest } : {}),
      draft: typeof value.draft === "string" ? value.draft : "",
      ...(Array.isArray(value.mentions) ? { mentions: value.mentions.filter((entry: BotMentionSpan) => entry && typeof entry.botId === "string" && Number.isSafeInteger(entry.start) && Number.isSafeInteger(entry.end) && entry.start >= 0 && entry.end > entry.start && typeof entry.token === "string" && typeof value.draft === "string" && value.draft.slice(entry.start, entry.end) === entry.token) } : {}),
      ...(position && Number.isFinite(position.offset) && Number.isFinite(position.scrollTop) && typeof position.atBottom === "boolean" ? { position: { anchorId: typeof position.anchorId === "string" ? position.anchorId : undefined, offset: position.offset, scrollTop: position.scrollTop, atBottom: position.atBottom } } : {}),
      saveFailed: value.saveFailed === true,
    }
  } catch { return { draft: "" } }
}

function snapshot(key: string) {
  if (!cache.has(key)) {
    try { cache.set(key, localStorage.getItem(key) ?? empty) }
    catch { cache.set(key, empty) }
  }
  return cache.get(key)!
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  const changed = (event: StorageEvent) => {
    if (event.key?.startsWith("genio.bot.view.")) { cache.delete(event.key); listener() }
  }
  window.addEventListener("storage", changed)
  return () => { listeners.delete(listener); window.removeEventListener("storage", changed) }
}

export function useBotViewState(key: string) {
  const raw = useSyncExternalStore(subscribe, () => snapshot(key), () => empty)
  const state = useMemo(() => parseBotView(raw), [raw])
  const update = useCallback((change: (current: BotViewState) => BotViewState) => {
    const next = { ...change(parseBotView(snapshot(key))), saveFailed: false }
    try { localStorage.setItem(key, JSON.stringify(next)) }
    catch { next.saveFailed = true }
    cache.set(key, JSON.stringify(next))
    for (const listener of listeners) listener()
  }, [key])
  const setDraft = useCallback((value: string | ((previous: string) => string)) => {
    update((current) => {
      const draft = typeof value === "function" ? value(current.draft) : value
      return { ...current, draft, mentions: moveBotMentionSpans(current.draft, draft, current.mentions) }
    })
  }, [update])
  const selectMention = useCallback((draft: string, mention: BotMentionSpan) => {
    update((current) => ({ ...current, draft, mentions: [...moveBotMentionSpans(current.draft, draft, current.mentions).filter((entry) => entry.end <= mention.start || entry.start >= mention.end), mention] }))
  }, [update])
  return { state, update, setDraft, selectMention }
}

export function captureReadingPosition(container: HTMLElement): BotReadingPosition {
  const top = container.getBoundingClientRect().top
  const anchor = [...container.querySelectorAll<HTMLElement>("[data-message-id]")].find((element) => element.getBoundingClientRect().bottom > top)
  return { anchorId: anchor?.dataset.messageId, offset: anchor ? anchor.getBoundingClientRect().top - top : 0, scrollTop: container.scrollTop, atBottom: container.scrollHeight - container.scrollTop - container.clientHeight <= 80 }
}

export function restoreReadingPosition(container: HTMLElement, position?: BotReadingPosition) {
  if (!position || position.atBottom) { container.scrollTop = container.scrollHeight; return }
  const anchor = position.anchorId ? container.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(position.anchorId)}"]`) : null
  container.scrollTop = anchor ? container.scrollTop + anchor.getBoundingClientRect().top - container.getBoundingClientRect().top - position.offset : position.scrollTop
}
