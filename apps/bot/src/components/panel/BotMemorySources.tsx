import { useEffect, useState } from "react"
import { getBotTimeline } from "../../lib/bot-api"
import type { ChatMessage } from "../../../shared/bot-timeline"

export function BotMemorySources({ botId, token, ids }: { botId: string; token: string; ids: string[] }) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[] | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const sourceKey = JSON.stringify(ids)
  useEffect(() => {
    let cancelled = false
    setMessages(null)
    setError(false)
    if (open) void getBotTimeline(token, botId).then((history) => {
      if (!cancelled) setMessages(history)
    }).catch(() => { if (!cancelled) setError(true) })
    return () => { cancelled = true }
  }, [open, token, botId, sourceKey, attempt])
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>查看 {ids.length} 則來源</summary>
    {open && (error ? <div role="alert">來源載入失敗。<button type="button" onClick={() => setAttempt((value) => value + 1)}>重新載入來源</button></div>
      : messages === null ? <p role="status">正在載入來源…</p>
      : ids.map((id) => {
        const message = messages.find((entry) => entry.id === id)
        return <blockquote key={id}>
          {message ? <><small>{message.role === "user" ? "使用者" : message.role === "assistant" ? "Bot" : "系統"}{message.createdAt ? ` · ${new Date(message.createdAt).toLocaleString("zh-TW")}` : ""}</small><p>{message.text}</p>{Boolean(message.images?.length) && <p>這則來源包含圖片；請至對話記錄查看完整內容。</p>}</> : <p>這則來源目前無法取得，記憶內容仍保留。</p>}
        </blockquote>
      }))}
  </details>
}
