import { useState } from "react"
import type { BotInstance } from "../../bots-storage"
import type { GenioIdentity } from "../../lib/genio-one"
import type { BotProfileDto } from "../../lib/bot-api"
import type { BotDesignerDraft } from "../../../server/bot-designer"
import { AppMark } from "../common/AppMark"
import { botDesignerErrorCopy, BotDesignerForm, type BotDesignerErrorCopy } from "../common/BotDesignerForm"
import { Sidebar } from "./Sidebar"

export function Onboarding({
  identity,
  createAndVerify,
  onReady,
  onSignOut,
}: {
  identity?: GenioIdentity | null
  createAndVerify(draft: BotDesignerDraft): Promise<{ draft: BotDesignerDraft; live: BotProfileDto; bot: BotInstance }>
  onReady(bot: BotInstance): void
  onSignOut?: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<BotDesignerErrorCopy | null>(null)

  return (
    <div className="product-shell onboarding-shell">
      <Sidebar
        bots={[]}
        activeBot={null}
        onSelectBot={() => {}}
        onAddBot={() => {}}
        identity={identity}
        onSignOut={onSignOut}
      />
      <main className="chat-workspace onboarding-workspace" data-testid="onboarding-workspace">
        <header className="chat-header">
          <div className="chat-header-info">
            <div className="chat-header-title"><strong>你的 Genio Bot</strong></div>
            <small>Bot Designer · 建立第一個 private Bot</small>
          </div>
        </header>
        <div className="messages onboarding-messages">
          <p className="day-divider">今天</p>
          <div className="message assistant onboarding-greeting">
            <span className="message-avatar"><AppMark profile={null} small /></span>
            <div>
              <strong>嗨，第一次見面。</strong>
              <p>告訴我主要工作、做事風格，以及哪些事情不要做，建立後就能開始對話。</p>
            </div>
          </div>
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
        </div>
      </main>
    </div>
  )
}
