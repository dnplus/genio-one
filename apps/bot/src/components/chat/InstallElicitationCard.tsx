import { useState } from "react"
import { ExternalLink, Layers, Save } from "lucide-react"

import { botCopy } from "../../lib/ui-copy"
import { InteractionCard } from "../common/InteractionCard"

export interface InstallElicitationSchemaProperty {
  type?: string
  title?: string
  description?: string
  default?: string | number | boolean
  format?: string
  enum?: string[]
}

export interface InstallElicitationRequest {
  id: number
  threadId?: string
  turnId?: string | null
  serverName: string
  message: string
  mode: "form" | "openai/form" | "openaiForm" | "url"
  properties?: Record<string, InstallElicitationSchemaProperty>
  url?: string
}

export interface InstallElicitationCardProps {
  request: InstallElicitationRequest
  onAccept: (content: Record<string, any>) => void
  onDecline: () => void
}

export function InstallElicitationCard({
  request,
  onAccept,
  onDecline,
}: InstallElicitationCardProps) {
  const [formData, setFormData] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    if (request.properties) {
      for (const [k, v] of Object.entries(request.properties)) {
        if (v.default !== undefined) {
          initial[k] = String(v.default)
        }
      }
    }
    return initial
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onAccept(formData)
  }

  const isUrlMode = request.mode === "url" && Boolean(request.url)
  const hasFields = Object.keys(request.properties ?? {}).length > 0
  const isBasicToolConfirmation = !isUrlMode && !hasFields
  const confirmationCopy = (english: string, traditionalChinese: string) => isBasicToolConfirmation ? botCopy(english, traditionalChinese) : traditionalChinese
  const memoryTool = request.message.includes('run tool "remember"') || request.message.includes('run tool "forget_memory"')
  const serverName = request.serverName === "genio_bot" ? memoryTool ? "Bot 記憶" : "隊友協作" : request.serverName
  const message = request.serverName === "genio_bot"
    ? request.message.includes('run tool "send_to_bot"') ? "允許這個 Bot 把工作交給隊友？"
      : request.message.includes('run tool "remember"') ? "允許這個 Bot 儲存這筆記憶？"
      : request.message.includes('run tool "forget_memory"') ? "允許這個 Bot 忘記這筆記憶？" : request.message
    : request.message

  return (
    <InteractionCard
      tone="setup"
      testId="install-elicitation-card"
      icon={<Layers size={18} />}
      title={`${isUrlMode ? "連接工具" : hasFields ? "補充資訊" : confirmationCopy("Confirm tool operation", "確認工具操作")} · ${serverName}`}
      subtitle={confirmationCopy("Review the following before responding", "請檢查下列內容後再回覆")}
      onDismiss={onDecline}
      dismissLabel={confirmationCopy("Cancel", "取消")}
    >
      <p className="install-elicitation-message">{message}</p>

      {isUrlMode ? (
        <div className="install-elicitation-url-block">
          <p>請開啟外部授權頁面完成登入：</p>
          <div className="interaction-card-actions">
            <a
              href={request.url}
              target="_blank"
              rel="noreferrer noopener"
              className="primary-button"
            >
              <ExternalLink size={14} /> 前往外部頁面完成授權
            </a>
            <button
              type="button"
              className="secondary-button"
              onClick={() => onAccept({})}
            >
              我已完成授權
            </button>
          </div>
        </div>
      ) : (
        <form className="install-elicitation-form" onSubmit={handleSubmit}>
          {request.properties &&
            Object.entries(request.properties).map(([key, prop]) => {
              const isSecret =
                prop.format === "password" ||
                /token|secret|key|password/i.test(key)
              return (
                <div key={key} className="install-elicitation-field">
                  <label htmlFor={`elicitation-${key}`}>
                    <strong>{prop.title || key}</strong>
                    {prop.description && <small>{prop.description}</small>}
                  </label>
                  <input
                    id={`elicitation-${key}`}
                    type={isSecret ? "password" : "text"}
                    className="install-elicitation-input"
                    value={formData[key] || ""}
                    placeholder={prop.default ? String(prop.default) : `請輸入 ${prop.title || key}`}
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, [key]: e.target.value }))
                    }
                  />
                </div>
              )
            })}

          <div className="interaction-card-actions">
            <button type="button" className="secondary-button" onClick={onDecline}>
              {confirmationCopy("Cancel", "取消")}
            </button>
            <button type="submit" className="primary-button">
              <Save size={14} /> {hasFields ? "送出資訊" : confirmationCopy("Allow this operation", "允許這次操作")}
            </button>
          </div>
        </form>
      )}
    </InteractionCard>
  )
}
