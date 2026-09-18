import { useEffect, useState } from "react"
import type { ChatMessage } from "../../bots-storage"
import { getBotMemory, type BotInvocationRequest } from "../../lib/bot-api"
import type { BotMemory } from "../../../shared/bot-memory"
import { BotMemorySources } from "./BotMemorySources"

export function BotWorkPanel({ botId, token, status, attention, messages, invocations, names, onSelectMessage, onManageMemory, viewerSubjectId, onDecision }: {
  botId: string; token: string; status: string; attention?: string; messages: ChatMessage[]; invocations: BotInvocationRequest[]; names: Record<string, string>; onSelectMessage: (id: string) => void; onManageMemory: () => void; viewerSubjectId?: string; onDecision?: (id: string, decision: "APPROVE" | "DENY") => void | Promise<void>
}) {
  const [summaries, setSummaries] = useState<BotMemory[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [deciding, setDeciding] = useState<string | null>(null)
  const [decisionError, setDecisionError] = useState(false)
  const decide = async (id: string, decision: "APPROVE" | "DENY") => {
    if (deciding || !onDecision) return
    setDeciding(id); setDecisionError(false)
    try { await onDecision(id, decision) }
    catch { setDecisionError(true) }
    finally { setDeciding(null) }
  }
  useEffect(() => {
    let cancelled = false
    let pending = false
    setSummaries(null); setFailed(false)
    const load = async () => {
      if (pending) return
      pending = true
      try {
        const memory = await getBotMemory(token, botId)
        if (!cancelled) { setSummaries(memory.filter((entry) => entry.kind === "working_context")); setFailed(false) }
      } catch { if (!cancelled) setFailed(true) }
      finally { pending = false }
    }
    void load()
    const timer = setInterval(() => void load(), 5000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [botId, token])
  const related = invocations.filter((entry) => entry.callerBotId === botId || entry.targetBotId === botId)
  const active = related.filter((entry) => ["PENDING", "APPROVED", "RUNNING"].includes(entry.state))
  const recent = related.filter((entry) => !["PENDING", "APPROVED", "RUNNING"].includes(entry.state)).slice(0, 5)
  const lastRequest = messages.slice().reverse().find((message) => message.role === "user" && !message.clientMessageId?.startsWith("handoff-result:"))
  const labels: Record<string, string> = { PENDING: "等待擁有者核准", APPROVED: "已核准，等待執行", RUNNING: "處理中", COMPLETED: "已回覆", FAILED: "未完成", DENIED: "未獲核准", EXPIRED: "授權已過期" }
  const renderInvocation = (entry: BotInvocationRequest) => {
    const outgoing = entry.callerBotId === botId
    const peer = names[outgoing ? entry.targetBotId : entry.callerBotId] || "另一個 Bot"
    return <article key={entry.requestId} className="bot-memory-entry">
      <strong>{outgoing ? `交給 ${peer}` : `來自 ${peer}`}</strong><small>{labels[entry.state] || "狀態待確認"}</small>
      <p>{entry.task}</p>
      {entry.state === "PENDING" && viewerSubjectId === entry.targetOwnerSubjectId && onDecision && <div>
        <button type="button" className="primary-button" disabled={deciding !== null} onClick={() => void decide(entry.requestId, "APPROVE")}>允許這次交接</button>
        <button type="button" className="secondary-button" disabled={deciding !== null} onClick={() => void decide(entry.requestId, "DENY")}>拒絕這次交接</button>
        {deciding === entry.requestId && <p role="status">正在送出決定…</p>}
      </div>}
      {entry.resultSummary && <p>{entry.resultSummary}</p>}
    </article>
  }
  return <div className="right-panel-content bot-memory-panel bot-work-panel">
    <h3>目前狀態</h3><p role="status">{attention || status}</p>
    {lastRequest && <><h3>最近的要求</h3><button type="button" className="secondary-button" onClick={() => onSelectMessage(lastRequest.id)}>{lastRequest.text}</button></>}
    <h3>目前工作摘要</h3>
    {failed && <p role="alert">摘要更新暫停，稍後會自動重試。</p>}
    {summaries === null ? <p>正在載入摘要…</p> : summaries.length === 0 ? <p>尚未保存工作摘要。Bot 在重要工作進展後會嘗試整理目標、決策與下一步；尚未保存的內容仍可從聊天記錄查看。</p> : summaries.map((entry) => <article key={entry.id} className="bot-memory-entry"><strong>{entry.key}</strong><p style={{ whiteSpace: "pre-wrap" }}>{entry.content}</p><small>{entry.workSummary ? "Bot 整理 · " : entry.origin === "user" ? "使用者管理 · " : ""}更新於 {new Date(entry.updatedAt).toLocaleString("zh-TW")}</small>{entry.workSummary && <small>摘要依來源整理，未涵蓋完整歷史；完成狀態請對照實際結果。</small>}{Boolean(entry.sourceMessageIds?.length) && <BotMemorySources botId={botId} token={token} ids={entry.sourceMessageIds!} />}</article>)}
    <button type="button" className="secondary-button" onClick={onManageMemory}>管理工作摘要與記憶</button>
    {decisionError && <p role="alert">決定未送出，請確認連線後重試。</p>}
    <h3>待處理交接（{active.length}）</h3>{active.length ? active.map(renderInvocation) : <p>目前沒有待處理交接。</p>}
    <h3>最近交接</h3>{recent.length ? recent.map(renderInvocation) : <p>尚無已結束的交接。</p>}
  </div>
}
