import { useState } from "react"
import { HelpCircle } from "lucide-react"
import type { BotQuestion } from "../../../shared/bot-question"
import { InteractionCard } from "../common/InteractionCard"

export function AsyncQuestionCard({ question, onAction }: {
  question: BotQuestion
  onAction: (question: BotQuestion, action: "answer" | "dismiss" | "retry", answer?: string, clientAnswerId?: string) => Promise<void>
}) {
  const draftKey = `genio.bot.question.${question.botId}.${question.id}`
  const [draft, setDraft] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey) ?? "null")
      return saved && typeof saved.answer === "string" && typeof saved.clientAnswerId === "string" ? saved : { answer: "", clientAnswerId: crypto.randomUUID() }
    }
    catch { return { answer: "", clientAnswerId: crypto.randomUUID() } }
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const change = (answer: string) => {
    const next = { answer, clientAnswerId: crypto.randomUUID() }
    setDraft(next)
    try { localStorage.setItem(draftKey, JSON.stringify(next)) }
    catch { setError("草稿暫時無法保存，請保留此頁面。") }
  }
  const submit = async (action: "answer" | "dismiss" | "retry") => {
    setBusy(true)
    setError("")
    try {
      await onAction(question, action, draft.answer, draft.clientAnswerId)
      try { localStorage.removeItem(draftKey) } catch {}
    } catch (error) { setError(error instanceof Error ? error.message : "回答未保存，請重試。") }
    finally { setBusy(false) }
  }
  const pending = question.state === "pending"
  const status = pending ? "你可以稍後回答，Bot 會繼續不依賴答案的工作。"
    : question.state === "dismissed" ? "已略過；這不代表核准任何操作。"
    : question.state === "superseded" ? "問題已被取代。"
    : question.delivery === "delivered" ? "答案已送入工作。"
    : question.delivery === "uncertain" ? "答案已保存，送達結果待確認。"
    : question.delivery === "failed" ? "答案已保存，目前無法接續。"
    : "答案已保存，等待送入工作；若 Bot 正在處理新的工作，會在完成後接續。"
  return <InteractionCard icon={<HelpCircle />} title={question.title} subtitle={status} testId="async-question-card" actions={
    pending ? <>
      <button type="button" disabled={busy || !draft.answer.trim()} onClick={() => void submit("answer")}>{busy ? "保存中…" : "送出回答"}</button>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => void submit("dismiss")}>略過問題</button>
    </> : question.delivery === "failed" || question.delivery === "uncertain" ? <button type="button" disabled={busy} onClick={() => void submit("retry")}>核對後重試</button> : undefined
  }>
    {pending ? <>
      <div className="async-question-options">{question.options.map((option) => <button type="button" key={option} className="secondary-button" aria-pressed={draft.answer === option} disabled={busy} onClick={() => change(option)}>{option}</button>)}</div>
      <label>你的回答<textarea value={draft.answer} maxLength={8192} disabled={busy} onChange={(event) => change(event.target.value)} placeholder="選擇上方選項，或自行輸入" /></label>
    </> : question.answer ? <p>{question.answer}</p> : null}
    {(error || question.error) && <p role="alert">{error || question.error}</p>}
  </InteractionCard>
}
