import { useEffect, useRef, type RefObject } from "react"
import { postBotSessionEvent } from "../../lib/bot-api"

export function useVisibleTimelineRead(container: RefObject<HTMLDivElement | null>, botId: string, token: string, version: string | null, onViewed?: (botId: string) => void) {
  const acknowledged = useRef("")
  useEffect(() => {
    if (!version || !token) return
    const element = container.current
    if (!element) return
    let pending = false
    let cancelled = false
    const key = `${botId}:${version}`
    const check = () => {
      if (cancelled || pending || acknowledged.current === key || document.visibilityState !== "visible" || element.scrollHeight - element.scrollTop - element.clientHeight > 4) return
      pending = true
      void postBotSessionEvent(token, botId, "viewed", version).then(() => {
        if (!cancelled) { acknowledged.current = key; onViewed?.(botId) }
      }).catch(() => {}).finally(() => { pending = false })
    }
    const frame = requestAnimationFrame(check)
    element.addEventListener("scroll", check)
    document.addEventListener("visibilitychange", check)
    const timer = setInterval(check, 2000)
    return () => { cancelled = true; cancelAnimationFrame(frame); clearInterval(timer); element.removeEventListener("scroll", check); document.removeEventListener("visibilitychange", check) }
  }, [container, botId, token, version, onViewed])
}
