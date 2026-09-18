import { useEffect, useState } from "react"
import { BotMemorySources } from "./BotMemorySources"
import type { BotMemory, BotMemoryKind } from "../../../shared/bot-memory"
import { forgetBotMemory, getBotMemory, saveBotMemory } from "../../lib/bot-api"

const kinds: Record<BotMemoryKind, string> = { preference: "偏好", fact: "事實", decision: "已確認決策", working_context: "目前工作摘要" }

export function BotMemoryPanel({ botId, botName, token }: { botId: string; botName: string; token: string }) {
  const [memories, setMemories] = useState<BotMemory[]>([])
  const [includeForgotten, setIncludeForgotten] = useState(false)
  const [editing, setEditing] = useState<BotMemory | null>(null)
  const [key, setKey] = useState("")
  const [content, setContent] = useState("")
  const [kind, setKind] = useState<BotMemoryKind>("preference")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [status, setStatus] = useState("")
  const refresh = async () => setMemories(await getBotMemory(token, botId, includeForgotten))
  useEffect(() => {
    let cancelled = false
    let pending = false
    const load = async () => {
      if (pending) return
      pending = true
      try { const data = await getBotMemory(token, botId, includeForgotten); if (!cancelled) setMemories(data) }
      catch { if (!cancelled) setError("記憶載入失敗，請稍後重試。") }
      finally { pending = false }
    }
    void load()
    const timer = setInterval(() => void load(), 5000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [botId, token, includeForgotten])
  const failure = (error: unknown) => setError(error instanceof Error && error.message === "BOT_MEMORY_CONFLICT" ? "這筆記憶已被更新，請重新選取後再修改。" : "記憶未儲存，請確認內容與連線後重試。")
  return <div className="right-panel-content bot-memory-panel">
    <p>{botName} 的記憶獨立保存。忘記後不再載入該筆記憶，既有聊天記錄仍保留。</p>
    <form onSubmit={async (event) => {
      event.preventDefault(); setSaving(true); setError(""); setStatus("")
      try {
        await saveBotMemory(token, botId, { key, content, kind, ...(editing ? { expectedRevision: editing.revision } : {}) })
        setEditing(null); setKey(""); setContent(""); setStatus("記憶已儲存"); await refresh()
      } catch (error) { failure(error) }
      finally { setSaving(false) }
    }}>
      <label>記憶主題<input value={key} maxLength={80} disabled={saving || Boolean(editing)} onChange={(event) => setKey(event.target.value)} placeholder="例如：回覆偏好" required /></label>
      <label>類型<select disabled={saving} value={kind} onChange={(event) => setKind(event.target.value as BotMemoryKind)}>{Object.entries(kinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>內容<textarea disabled={saving} value={content} maxLength={2000} rows={4} onChange={(event) => setContent(event.target.value)} required /></label>
      <button type="submit" className="primary-button" disabled={saving}>{editing ? "更新記憶" : "新增記憶"}</button>
      {editing && <button type="button" className="secondary-button" disabled={saving} onClick={() => { setEditing(null); setKey(""); setContent("") }}>取消修改</button>}
    </form>
    {error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
    <label><input type="checkbox" checked={includeForgotten} onChange={(event) => setIncludeForgotten(event.target.checked)} />顯示已忘記的記憶</label>
    {memories.length === 0 && <p>目前沒有記憶。可在這裡新增，或在聊天中請 Bot 記住資訊。</p>}
    {memories.map((memory) => <article className="bot-memory-entry" key={memory.id}>
      <strong>{memory.key}</strong><small>{kinds[memory.kind]} · {memory.origin === "user" ? "使用者設定" : "Bot 記錄"}{memory.forgotten ? " · 已忘記" : ""} · {new Date(memory.updatedAt).toLocaleString("zh-TW")}</small>
      <p>{memory.content}</p>
      {Boolean(memory.sourceMessageIds?.length) && <BotMemorySources botId={botId} token={token} ids={memory.sourceMessageIds!} />}
      {!memory.forgotten && <button type="button" className="secondary-button" disabled={saving} onClick={() => { setEditing(memory); setKey(memory.key); setContent(memory.content); setKind(memory.kind); setError(""); setStatus("") }}>修改</button>}
      <button type="button" className="secondary-button" disabled={saving} onClick={async () => {
        try { await forgetBotMemory(token, botId, memory, !memory.forgotten); setStatus(memory.forgotten ? "記憶已恢復" : "已忘記這筆記憶"); await refresh() }
        catch (error) { failure(error) }
      }}>{memory.forgotten ? "恢復" : "忘記"}</button>
    </article>)}
  </div>
}
