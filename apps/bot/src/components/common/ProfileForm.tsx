import { useState } from "react"
import { ChevronRight, ShieldCheck, Sparkles } from "lucide-react"

import { DEFAULT_BLOUB_AVATAR } from "../../avatar/bloub-avatar"
import { BloubCustomizer } from "../../avatar/bloub-customizer"
import type { BotProfile } from "../../bots-storage"
import { botCopy } from "../../lib/ui-copy"

const roleOptions = [
  ["Research assistant", "研究助理"],
  ["Operations partner", "營運夥伴"],
  ["Project executor", "專案執行者"],
] as const

export function ProfileForm({
  profile,
  submitLabel,
  onComplete,
}: {
  profile: BotProfile | null
  submitLabel: string
  onComplete(profile: BotProfile): void
}) {
  const [name, setName] = useState(profile?.name ?? "")
  const [title, setTitle] = useState(profile?.title ?? "")
  const [description, setDescription] = useState(profile?.description ?? profile?.role ?? "")
  const [avatar, setAvatar] = useState(profile?.avatar ?? DEFAULT_BLOUB_AVATAR)

  return (
    <form
      className="setup-card"
      onSubmit={(event) => {
        event.preventDefault()
        if (name.trim() && description.trim()) {
          const nextTitle = title.trim() || description.trim()
          const nextDescription = description.trim()
          onComplete({
            name: name.trim(),
            title: nextTitle,
            description: nextDescription,
            // legacy mirror only — not the profile SoT
            role: nextDescription,
            avatar,
          })
        }
      }}
    >
      <div className="setup-heading">
        <Sparkles />
        <span>
          <strong>{botCopy("Set up your Bot", "設定你的 Bot")}</strong>
          <small>{botCopy("You can update its name, title, work description, and appearance at any time.", "名字、職稱、工作說明與長相之後都可以隨時修改")}</small>
        </span>
      </div>

      <div className="setup-columns">
        <div className="setup-col-info">
          <label>
            <span>{botCopy("What should I call you?", "要怎麼稱呼我？")}</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder={botCopy("For example: Nova", "例如：Nova")} />
          </label>
          <label>
            <span>{botCopy("Title / primary work", "職稱／主要工作（title／job）")}</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={botCopy("For example: Operations and case coordination", "例如：營運與案件協調")} />
          </label>
          <label>
            <span>{botCopy("Work description and long-term rules", "工作說明與長期規則（description）")}</span>
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder={botCopy("For example: Be careful and reliable. Verify sources before acting. Never approve payments for me.", "例如：細心、可靠，先確認資料來源再執行。不要代為核准付款。")} />
          </label>
          <div className="role-section">
            <span className="role-section-label">{botCopy("Quickly apply a common style", "快速套用常見風格")}</span>
            <div className="role-row">
              {roleOptions.map(([english, traditionalChinese]) => {
                const value = botCopy(english, traditionalChinese)
                return (
                  <button
                    type="button"
                    key={traditionalChinese}
                    className={description === value ? "role-chip selected" : "role-chip"}
                    onClick={() => setDescription(value)}
                  >
                    {value}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="setup-preview-box">
            <Sparkles />
            <div>
              <strong>{name ? botCopy(`${name} is ready when you are`, `${name} 隨時待命`) : botCopy("Your enterprise companion", "你的企業夥伴")}</strong>
              <small>{title || description || botCopy("Choose a recommended style above or enter the work guidance you prefer.", "點選上方推薦風格或輸入你偏好的工作指引")}</small>
            </div>
          </div>
        </div>

        <div className="setup-col-appearance">
          <fieldset className="avatar-fieldset">
            <legend>{botCopy("Appearance and expression style", "長相與表情風格")}</legend>
            <BloubCustomizer value={avatar} onChange={setAvatar} />
          </fieldset>
        </div>
      </div>

      <div className="setup-footer">
        <span className="trust-line">
          <ShieldCheck />{botCopy("Uses your GenioOne identity and permissions", "沿用你的 GenioOne 身份與權限")}
        </span>
        <button className="primary-button" disabled={!name.trim() || !description.trim()} type="submit">
          {submitLabel} <ChevronRight />
        </button>
      </div>
    </form>
  )
}
