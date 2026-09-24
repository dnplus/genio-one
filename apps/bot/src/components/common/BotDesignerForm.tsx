import { useState } from "react"
import { ChevronRight, ShieldCheck, Sparkles } from "lucide-react"

import { DEFAULT_BLOUB_AVATAR } from "../../avatar/bloub-avatar"
import { BloubCustomizer } from "../../avatar/bloub-customizer"
import {
  type BotModelRoute,
  type BotDesignerDraft,
  type BotWakeMode,
  wakeLabel,
} from "../../../server/bot-designer"

const WAKE_OPTIONS: Array<{ value: BotWakeMode; hint: string }> = [
  { value: "chat", hint: wakeLabel("chat") },
  { value: "routine", hint: wakeLabel("routine") },
  { value: "both", hint: wakeLabel("both") },
]

export interface BotDesignerErrorCopy {
  title: string
  detail: string
  nextStep: string
}

function errorCode(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  if (typeof error === "string" && error.trim()) return error.trim()
  return "CREATE_FAILED"
}

export function botDesignerErrorCopy(error: unknown): BotDesignerErrorCopy {
  switch (errorCode(error)) {
    case "USE_CASE_REQUIRED":
      return {
        title: "公司模型需要 Use Case",
        detail: "這次沒有建立 Bot，因為目前登入帳號沒有可驗證的組織與 active Use Case。",
        nextStep: "請先在 Platform 補齊所屬組織，並建立或啟用 Use Case；表單內容會保留，完成後回到這裡按「建立並開始對話」重試。",
      }
    case "USE_CASE_SELECTION_REQUIRED":
      return {
        title: "請先確認公司模型用途",
        detail: "目前有多個 active Use Case，系統不會替你猜測這個 Bot 的用途。",
        nextStep: "Bot Designer 目前尚未提供 Use Case 選擇器；短期請管理員將你的可用範圍調整為單一 active Use Case，或在你的帳號有權限時改選「個人 Codex」後重試。",
      }
    case "USE_CASE_NOT_ALLOWED":
      return {
        title: "目前帳號不能使用這個 Use Case",
        detail: "這次沒有建立 Bot，因為 Use Case 不在目前登入帳號可驗證的組織範圍內。",
        nextStep: "請在 Platform 使用已授權且 active 的 Use Case，或改選「個人 Codex」後重試。",
      }
    case "USAGE_CONTEXT_LOOKUP_UNAVAILABLE":
    case "USAGE_CONTEXT_LOOKUP_INVALID":
      return {
        title: "暫時無法確認公司模型用途",
        detail: "這次沒有建立 Bot，因為 Platform 尚未回傳可驗證的組織與 Use Case 資訊。",
        nextStep: "請確認 Platform 可用後重試；如果問題持續，請聯絡管理員檢查組織與 Use Case 設定。",
      }
    default: {
      const code = errorCode(error)
      return {
        title: "Bot 尚未建立",
        detail: "建立沒有完成，這次輸入仍保留在表單中。",
        nextStep: `請修正設定後重試；若問題持續，請提供錯誤代碼 ${code} 給管理員。`,
      }
    }
  }
}

export function BotDesignerForm({
  submitLabel,
  busy = false,
  error = null,
  onComplete,
}: {
  submitLabel: string
  busy?: boolean
  error?: BotDesignerErrorCopy | null
  onComplete(draft: BotDesignerDraft): void
}) {
  const [name, setName] = useState("")
  const [oneJob, setOneJob] = useState("")
  const [antiJobs, setAntiJobs] = useState("")
  const [voice, setVoice] = useState("")
  const [wake, setWake] = useState<BotWakeMode>("chat")
  const [modelRoute, setModelRoute] = useState<BotModelRoute>("codex-subscription")
  const [avatar, setAvatar] = useState(DEFAULT_BLOUB_AVATAR)

  const ready = name.trim() && oneJob.trim() && antiJobs.trim() && voice.trim()

  return (
    <form
      className="setup-card designer-card"
      data-testid="bot-designer-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (!ready || busy) return
        onComplete({
          name: name.trim(),
          oneJob: oneJob.trim(),
          antiJobs: antiJobs.trim(),
          voice: voice.trim(),
          wake,
          modelRoute,
          avatar,
        })
      }}
    >
      <div className="setup-heading">
        <Sparkles />
        <span>
          <strong>Bot Designer</strong>
          <small>One job → anti-jobs → voice → wake。建立 private Bot，不偷偷裝插件／啟用 routine。</small>
        </span>
      </div>
      <div className="setup-columns">
        <div className="setup-col-info">
          <label>
            <span>名稱（短）</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：阿庫婭" disabled={busy} />
          </label>
          <label>
            <span>One job（每次醒來只做這一件）</span>
            <input value={oneJob} onChange={(e) => setOneJob(e.target.value)} placeholder="例如：把模糊需求收成可驗收切片" disabled={busy} />
          </label>
          <label>
            <span>Anti-jobs（被要求也不做）</span>
            <textarea value={antiJobs} onChange={(e) => setAntiJobs(e.target.value)} placeholder="例如：不代寄信、不擅自啟用 routine、不裝市集插件" disabled={busy} />
          </label>
          <label>
            <span>Voice（可辨識語氣）</span>
            <input value={voice} onChange={(e) => setVoice(e.target.value)} placeholder="例如：直球、短句、有點傲嬌但仍可靠" disabled={busy} />
          </label>
          <fieldset className="designer-wake">
            <legend>Wake</legend>
            <div className="role-row">
              {WAKE_OPTIONS.map((opt) => (
                <button
                  type="button"
                  key={opt.value}
                  className={wake === opt.value ? "role-chip selected" : "role-chip"}
                  onClick={() => setWake(opt.value)}
                  disabled={busy}
                >
                  {opt.value}
                </button>
              ))}
            </div>
            <small className="designer-wake-hint">{wakeLabel(wake)}</small>
          </fieldset>
          <fieldset className="designer-model-route">
            <legend>模型路線</legend>
            <label className={modelRoute === "codex-subscription" ? "model-route-option selected" : "model-route-option"}>
              <input
                type="radio"
                name="designer-model-route"
                value="codex-subscription"
                checked={modelRoute === "codex-subscription"}
                onChange={() => setModelRoute("codex-subscription")}
                disabled={busy}
              />
              <span>
                <strong>個人 Codex</strong>
                <small>使用你的 Codex 帳號；開始對話時需要登入。</small>
              </span>
            </label>
            <label className={modelRoute === "genio-gateway" ? "model-route-option selected" : "model-route-option"}>
              <input
                type="radio"
                name="designer-model-route"
                value="genio-gateway"
                checked={modelRoute === "genio-gateway"}
                onChange={() => setModelRoute("genio-gateway")}
                disabled={busy}
              />
              <span>
                <strong>公司模型（Genio Gateway）</strong>
                <small>使用公司核准且已完成連線設定的模型；建立前需有可驗證的組織與 active Use Case。</small>
              </span>
            </label>
          </fieldset>
          {error ? (
            <div className="designer-error" data-testid="bot-designer-error" role="alert">
              <strong>{error.title}</strong>
              <p>{error.detail}</p>
              <p>{error.nextStep}</p>
            </div>
          ) : null}
          <div className="setup-preview-box">
            <Sparkles />
            <div>
              <strong>{name ? `${name} · ${oneJob || "one job"}` : "你的 private Bot"}</strong>
              <small>建立後直接開始對話，設定隨時可以調整</small>
            </div>
          </div>
        </div>

        <div className="setup-col-appearance">
          <fieldset className="avatar-fieldset">
            <legend>長相與表情風格</legend>
            <BloubCustomizer value={avatar} onChange={setAvatar} />
          </fieldset>
        </div>
      </div>

      <div className="setup-footer">
        <span className="trust-line">
          <ShieldCheck />Private by default · 不自動裝技能／插件 · 不啟用 routine
        </span>
        <button className="primary-button" disabled={!ready || busy} type="submit">
          {busy ? "建立中…" : submitLabel} <ChevronRight />
        </button>
      </div>
    </form>
  )
}
