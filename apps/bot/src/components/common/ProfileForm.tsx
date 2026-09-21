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
  onChange,
  disabled = false,
}: {
  profile: BotProfile | null
  submitLabel: string
  onComplete(profile: BotProfile): void
  onChange?: (profile: BotProfile) => void
  disabled?: boolean
}) {
  const [name, setName] = useState(profile?.name ?? "")
  const [title, setTitle] = useState(profile?.title ?? "")
  const [description, setDescription] = useState(profile?.description ?? profile?.role ?? "")
  const [avatar, setAvatar] = useState(profile?.avatar ?? DEFAULT_BLOUB_AVATAR)
  const profileValue: BotProfile = onChange && profile ? profile : { name, title, description, role: description, avatar }

  const update = (next: Partial<BotProfile>) => {
    if (onChange && profile) {
      const nextDescription = typeof next.description === "string" ? next.description : profile.description
      onChange({ ...profile, ...next, description: nextDescription, role: nextDescription })
      return
    }
    if (typeof next.name === "string") setName(next.name)
    if (typeof next.title === "string") setTitle(next.title)
    if (typeof next.description === "string") setDescription(next.description)
    if (next.avatar) setAvatar(next.avatar)
  }

  return (
    <form
      className="setup-card"
      onSubmit={(event) => {
        event.preventDefault()
        if (!disabled && profileValue.name.trim() && profileValue.description.trim()) {
          const nextTitle = profileValue.title.trim() || profileValue.description.trim()
          const nextDescription = profileValue.description.trim()
          onComplete({
            name: profileValue.name.trim(),
            title: nextTitle,
            description: nextDescription,
            role: nextDescription,
            avatar: profileValue.avatar,
          })
        }
      }}
    >
      <fieldset disabled={disabled} style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}>
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
            <input value={profileValue.name} onChange={(event) => update({ name: event.target.value })} placeholder={botCopy("For example: Nova", "例如：Nova")} />
          </label>
          <label>
            <span>{botCopy("Title / primary work", "職稱／主要工作（title／job）")}</span>
            <input value={profileValue.title} onChange={(event) => update({ title: event.target.value })} placeholder={botCopy("For example: Operations and case coordination", "例如：營運與案件協調")} />
          </label>
          <label>
            <span>{botCopy("Work description and long-term rules", "工作說明與長期規則（description）")}</span>
            <textarea value={profileValue.description} onChange={(event) => update({ description: event.target.value })} placeholder={botCopy("For example: Be careful and reliable. Verify sources before acting. Never approve payments for me.", "例如：細心、可靠，先確認資料來源再執行。不要代為核准付款。")} />
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
                    className={profileValue.description === value ? "role-chip selected" : "role-chip"}
                    onClick={() => update({ description: value })}
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
              <strong>{profileValue.name ? botCopy(`${profileValue.name} is ready when you are`, `${profileValue.name} 隨時待命`) : botCopy("Your enterprise companion", "你的企業夥伴")}</strong>
              <small>{profileValue.title || profileValue.description || botCopy("Choose a recommended style above or enter the work guidance you prefer.", "點選上方推薦風格或輸入你偏好的工作指引")}</small>
            </div>
          </div>
        </div>

        <div className="setup-col-appearance">
          <fieldset className="avatar-fieldset">
            <legend>{botCopy("Appearance and expression style", "長相與表情風格")}</legend>
            <BloubCustomizer value={profileValue.avatar} onChange={(nextAvatar) => update({ avatar: nextAvatar })} />
          </fieldset>
        </div>
      </div>

      <div className="setup-footer">
        <span className="trust-line">
          <ShieldCheck />{botCopy("Uses your GenioOne identity and permissions", "沿用你的 GenioOne 身份與權限")}
        </span>
        <button className="primary-button" disabled={disabled || !profileValue.name.trim() || !profileValue.description.trim()} type="submit">
          {submitLabel} <ChevronRight />
        </button>
      </div>
      </fieldset>
    </form>
  )
}
