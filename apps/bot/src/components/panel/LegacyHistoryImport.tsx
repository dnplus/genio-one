import { useState } from "react"
import { readLegacyHistory } from "../../../shared/legacy-history"
import { importLegacyBotHistory } from "../../lib/bot-api"

export function LegacyHistoryImport({ botId, token }: { botId: string; token: string }) {
  const [source] = useState(() => {
    try { return { entries: readLegacyHistory(localStorage, botId), error: "" } }
    catch { return { entries: [], error: "此瀏覽器的舊記錄無法讀取，原始資料仍保留。" } }
  })
  const [state, setState] = useState<"idle" | "running" | "done" | "failed">("idle")
  const [error, setError] = useState("")
  if (!source.entries.length && !source.error) return null
  const importHistory = async () => {
    setState("running")
    setError("")
    try {
      for (let offset = 0; offset < source.entries.length; offset += 100) {
        await importLegacyBotHistory(token, botId, source.entries.slice(offset, offset + 100))
      }
      setState("done")
    } catch {
      setState("failed")
      setError("匯入未完成，請重試。已匯入的部分不會重複新增，瀏覽器原始資料仍保留。")
    }
  }
  return <div className="threads-empty">
    <p>此瀏覽器有 {source.entries.length} 筆舊聊天記錄。匯入後會保存在目前 Bot，並標示來源；只恢復閱讀記錄，未驗證的舊內容不會自動加入模型上下文。</p>
    {source.error || error ? <p role="alert">{source.error || error}</p> : null}
    {!source.error && <button type="button" className="secondary-button" disabled={state === "running" || state === "done"} onClick={() => void importHistory()}>
      {state === "running" ? "正在匯入…" : state === "done" ? "舊記錄已匯入" : state === "failed" ? "重試匯入" : "匯入此瀏覽器的舊記錄"}
    </button>}
    {state === "done" && <p role="status">舊記錄已保存，聊天主線會自動更新。</p>}
  </div>
}
