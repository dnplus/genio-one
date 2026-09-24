import { useState } from "react"
import { X } from "lucide-react"

import type { BotInstance } from "../../bots-storage"
import type { BotProfileDto } from "../../lib/bot-api"
import type { BotDesignerDraft } from "../../../server/bot-designer"
import { botDesignerErrorCopy, BotDesignerForm, type BotDesignerErrorCopy } from "../common/BotDesignerForm"

export function CreateBotModal({
  onClose,
  createAndVerify,
  onReady,
}: {
  onClose(): void
  createAndVerify(draft: BotDesignerDraft): Promise<{ draft: BotDesignerDraft; live: BotProfileDto; bot: BotInstance }>
  onReady(bot: BotInstance): void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<BotDesignerErrorCopy | null>(null)

  return (
    <div
      className="profile-dialog-backdrop"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <section className="profile-dialog" role="dialog" aria-modal="true" aria-labelledby="create-dialog-title">
        <header>
          <span>
            <strong id="create-dialog-title">建立 Bot</strong>
            <small>設定工作、風格與模型，完成後直接開始對話。</small>
          </span>
          <button className="icon-button" aria-label="關閉" onClick={onClose} disabled={busy}><X /></button>
        </header>
        <BotDesignerForm
          submitLabel="建立並開始對話"
          busy={busy}
          onComplete={(draft) => {
            setBusy(true)
            setError(null)
            void createAndVerify(draft)
              .then((result) => onReady(result.bot))
              .catch((err) => setError(botDesignerErrorCopy(err)))
              .finally(() => setBusy(false))
          }}
          error={error}
        />
      </section>
    </div>
  )
}
