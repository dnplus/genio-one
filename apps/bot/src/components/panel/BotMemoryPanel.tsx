import { useEffect, useMemo, useState } from "react"
import { BotMemorySources } from "./BotMemorySources"
import type { BotMemory } from "../../../shared/bot-memory"
import { getBotMemory, hardDeleteLegacyBotMemory, importLegacyBotMemory, type LegacyBotMemoryImport } from "../../lib/bot-api"

const kinds: Record<BotMemory["kind"], string> = { preference: "偏好", fact: "事實", decision: "已確認決策", working_context: "目前工作摘要" }

function failureMessage(error: unknown) {
  const code = error instanceof Error ? error.message : ""
  if (code === "PERSONAL_MEMORY_UNAVAILABLE") return "Platform 個人記憶沒有有效授權（grant）或目前無法使用；沒有改用舊 Bot 記憶。"
  if (code === "BOT_LEGACY_MEMORY_NOT_IMPORTABLE") return "只有仍為 active 的舊 Bot 長期記憶可以匯入。"
  if (code === "BOT_MEMORY_CONFLICT") return "記憶已被更新，請重新載入後再操作。"
  return "操作失敗，請稍後重試。"
}

export function selectedAfterLegacyImport(current: ReadonlySet<string>, imported: readonly { legacyMemory: { id: string } }[]) {
  const succeeded = new Set(imported.map((entry) => entry.legacyMemory.id))
  return new Set([...current].filter((id) => !succeeded.has(id)))
}

export function BotMemoryPanel({ botId, botName, token }: { botId: string; botName: string; token: string }) {
  const [memories, setMemories] = useState<BotMemory[]>([])
  const [includeForgotten, setIncludeForgotten] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState(false)
  const [imports, setImports] = useState<LegacyBotMemoryImport[]>([])
  const [error, setError] = useState("")
  const [status, setStatus] = useState("")
  const refresh = async () => {
    const data = await getBotMemory(token, botId, includeForgotten)
    setMemories(data)
    setSelected((current) => new Set([...current].filter((id) => data.some((memory) => memory.id === id && !memory.forgotten && memory.kind !== "working_context"))))
  }
  useEffect(() => {
    let cancelled = false
    let loading = false
    const load = async () => {
      if (loading) return
      loading = true
      try { const data = await getBotMemory(token, botId, includeForgotten); if (!cancelled) setMemories(data) }
      catch { if (!cancelled) setError("記憶載入失敗，請稍後重試。") }
      finally { loading = false }
    }
    void load()
    const timer = setInterval(() => void load(), 5000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [botId, token, includeForgotten])
  const legacy = useMemo(() => memories.filter((memory) => memory.kind !== "working_context"), [memories])
  const active = legacy.filter((memory) => !memory.forgotten)
  const selectedActive = active.filter((memory) => selected.has(memory.id))
  const failure = (value: unknown) => setError(failureMessage(value))
  const importSelected = async () => {
    if (pending || selectedActive.length === 0) return
    setPending(true); setError(""); setStatus(""); setImports([])
    try {
      const result = await importLegacyBotMemory(token, botId, selectedActive.map((memory) => memory.id))
      setImports(result.imported)
      setSelected((current) => selectedAfterLegacyImport(current, result.imported))
      if (result.failed.length) {
        const codes = new Set(result.failed.map((entry) => entry.error))
        const unverified = result.failed.find((entry) => entry.writeResult)
        setError(unverified?.writeResult
          ? `Platform 已回傳寫入結果（ID：${unverified.writeResult.id} · revision ${unverified.writeResult.revision}），但讀回驗證失敗；請先到 Platform 個人記憶確認，不要重複匯入。`
          : codes.has("PERSONAL_MEMORY_UNAVAILABLE")
          ? "Platform 個人記憶沒有有效授權（grant）或目前無法使用；沒有改用舊 Bot 記憶。"
          : `${result.failed.length} 筆舊 Bot 記憶未匯入，原始資料與勾選都會保留。`)
      } else setStatus(`已匯入 ${result.imported.length} 筆 Platform 個人記憶。`)
    } catch (reason) { failure(reason) }
    finally { setPending(false) }
  }
  const deleteMemory = async (memory: BotMemory) => {
    if (pending || !window.confirm(`永久刪除「${memory.key}」？此動作無法復原。`)) return
    setPending(true); setError(""); setStatus("")
    try {
      await hardDeleteLegacyBotMemory(token, botId, memory)
      setSelected((current) => { const next = new Set(current); next.delete(memory.id); return next })
      setStatus("舊 Bot 記憶已永久刪除。")
      await refresh()
    } catch (reason) { failure(reason) }
    finally { setPending(false) }
  }
  return <div className="right-panel-content bot-memory-panel">
    <h3>舊 Bot 記憶</h3>
    <p>{botName} 的舊 Bot 記憶不再自動用於對話，也不會自動遷移。這裡只提供預覽；明確匯入後才會寫入目前擁有者的 Platform 個人記憶。</p>
    <p>目前工作摘要在「工作」頁獨立管理，不屬於可匯入的長期記憶。</p>
    {error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
    <label><input type="checkbox" checked={includeForgotten} onChange={(event) => setIncludeForgotten(event.target.checked)} />顯示已忘記記憶</label>
    {active.length > 0 && <div>
      <label><input type="checkbox" checked={selectedActive.length === active.length} disabled={pending} onChange={(event) => setSelected(event.target.checked ? new Set(active.map((memory) => memory.id)) : new Set())} />全選 active 記憶</label>
      <button type="button" className="primary-button" disabled={pending || selectedActive.length === 0} onClick={() => void importSelected()}>匯入選取的 {selectedActive.length} 筆</button>
    </div>}
    {legacy.length === 0 && <p>尚無可預覽的舊 Bot 長期記憶。</p>}
    {legacy.map((memory) => <article className="bot-memory-entry" key={memory.id}>
      <label><input type="checkbox" checked={selected.has(memory.id)} disabled={pending || memory.forgotten} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(memory.id); else next.delete(memory.id); return next })} />選取匯入</label>
      <strong>{memory.key}</strong><small>{kinds[memory.kind]} · {memory.origin === "user" ? "使用者設定" : "Bot 記錄"}{memory.forgotten ? " · 已忘記，無法匯入" : " · active"} · {new Date(memory.updatedAt).toLocaleString("zh-TW")}</small>
      <p>{memory.content}</p>
      {Boolean(memory.sourceMessageIds?.length) && <BotMemorySources botId={botId} token={token} ids={memory.sourceMessageIds!} />}
      <button type="button" className="secondary-button" disabled={pending} onClick={() => void deleteMemory(memory)}>永久刪除</button>
    </article>)}
    {imports.length > 0 && <section>
      <h4>Platform 匯入 read-back</h4>
      {imports.map((entry) => <article className="bot-memory-entry" key={entry.legacyMemory.id}>
        <strong>{entry.platformMemory.key}</strong><small>Platform ID：{entry.platformMemory.id} · revision {entry.platformMemory.revision}</small>
        <p>{entry.platformMemory.content}</p>
        <small>來源：舊 Bot 記憶 {entry.source.memoryId}（revision {entry.source.revision}）· {entry.source.referenceId}</small>
      </article>)}
    </section>}
  </div>
}
