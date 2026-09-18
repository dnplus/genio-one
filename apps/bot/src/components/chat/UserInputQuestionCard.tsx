import { useState } from "react"
import { HelpCircle, Send } from "lucide-react"

import { InteractionCard } from "../common/InteractionCard"

export interface UserInputOption {
  label: string
  description?: string
}

export interface UserInputQuestion {
  id: string
  header?: string
  question: string
  isOther?: boolean
  isSecret?: boolean
  options?: UserInputOption[] | null
}

export interface UserInputQuestionRequest {
  isBlocking?: boolean
  id: number
  threadId?: string
  turnId?: string
  itemId?: string
  questions: UserInputQuestion[]
}

export interface UserInputQuestionCardProps {
  request: UserInputQuestionRequest
  onAnswer: (answers: Record<string, string[]>) => void
  onDismiss: () => void
}

export function UserInputQuestionCard({
  request,
  onAnswer,
  onDismiss,
}: UserInputQuestionCardProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [otherQuestions, setOtherQuestions] = useState<Set<string>>(new Set())
  const complete = request.questions.every((question) => answers[question.id]?.trim())
  const submit = () => {
    if (complete) onAnswer(Object.fromEntries(request.questions.map((question) => [question.id, [answers[question.id]!.trim()]])))
  }

  return (
    <InteractionCard
      tone="ask"
      testId="user-input-question-card"
      icon={<HelpCircle size={18} />}
      title="Bot 需要你的回答"
      subtitle="請選擇或輸入下一步指令以繼續執行"
      onDismiss={onDismiss}
      dismissLabel="略過問題"
    >
      {request.questions.map((q) => {
        const hasOptions = Array.isArray(q.options) && q.options.length > 0
        const isOtherActive = otherQuestions.has(q.id) || !hasOptions

        return (
          <div key={q.id} className="user-input-question-block" data-question-id={q.id}>
            {q.header && <h4 className="user-input-header-text">{q.header}</h4>}
            <p className="user-input-question-text">{q.question}</p>

            {hasOptions && (
              <div className="user-input-options-grid">
                {q.options!.map((opt, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className="user-input-option-btn"
                    aria-pressed={!isOtherActive && answers[q.id] === opt.label}
                    onClick={() => {
                      setAnswers((current) => ({ ...current, [q.id]: opt.label }))
                      setOtherQuestions((current) => { const next = new Set(current); next.delete(q.id); return next })
                    }}
                  >
                    <span className="user-input-option-label">{opt.label}</span>
                    {opt.description && (
                      <span className="user-input-option-desc">{opt.description}</span>
                    )}
                  </button>
                ))}
                {q.isOther && !isOtherActive && (
                  <button
                    type="button"
                    className="user-input-option-btn user-input-other-btn"
                    onClick={() => { setOtherQuestions((current) => new Set([...current, q.id])); setAnswers((current) => ({ ...current, [q.id]: "" })) }}
                  >
                    <span className="user-input-option-label">其他回答…</span>
                    <span className="user-input-option-desc">自行輸入具體需求或補充資訊</span>
                  </button>
                )}
              </div>
            )}

            {isOtherActive && (
              <div className="user-input-custom-row">
                <input
                  type={q.isSecret ? "password" : "text"}
                  className="user-input-text-field"
                  placeholder={hasOptions ? "請輸入自訂回答..." : "請在此輸入你的回答..."}
                  value={answers[q.id] || ""}
                  onChange={(e) =>
                    setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      submit()
                    }
                  }}
                />

              </div>
            )}
          </div>
        )
      })}
      <button type="button" className="primary-button user-input-submit-btn" disabled={!complete} onClick={submit}>
        <Send size={14} /> 送出回答
      </button>
    </InteractionCard>
  )
}
