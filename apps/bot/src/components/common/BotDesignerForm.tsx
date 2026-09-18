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

export function BotDesignerForm({
  submitLabel,
  busy = false,
  onComplete,
}: {
  submitLabel: string
  busy?: boolean
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
                <small>使用公司核准且已完成連線設定的模型。</small>
              </span>
            </label>
          </fieldset>
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
