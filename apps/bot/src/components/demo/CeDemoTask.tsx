import { LoaderCircle } from "lucide-react"

import type { CeDemoTaskDto } from "../../lib/bot-api"
import { botCopy } from "../../lib/ui-copy"

function failureMessage(error: string) {
  if (error === "USE_CASE_SELECTION_REQUIRED" || error === "USE_CASE_REQUIRED") return botCopy("The demo Bot needs a valid organization use case. No usable use case was found; finish the CE demo setup and retry, or return to My Bots.", "Gemini 示範 Bot 需要有效的組織使用情境。目前尚未找到可用情境；完成 CE demo 設定後可重新確認，或先返回我的 Bot。")
  if (error === "BOT_ACCESS_DENIED") return botCopy("This CE demo Bot does not have Platform access yet.", "這個 CE 示範 Bot 尚未取得 Platform 授權。")
  if (error === "BOT_CONNECTION_REQUIRED") return botCopy("A required connection for this CE demo Bot is not ready yet.", "這個 CE 示範 Bot 的必要連線尚未就緒。")
  if (error === "BOT_CATALOG_UNAVAILABLE") return botCopy("The Platform catalog is temporarily unavailable. Try again shortly.", "目前無法讀取 Platform catalog，請稍後重試。")
  return error
}

export function CeDemoTask({
  task,
  prompt,
  loading,
  installing,
  error,
  onPromptChange,
  onInstall,
  onStart,
  onRetry,
  onReturnToBots,
}: {
  task: CeDemoTaskDto | null
  prompt: string
  loading: boolean
  installing: boolean
  error: string
  onPromptChange(value: string): void
  onInstall(): void
  onStart(): void
  onRetry(): void
  onReturnToBots(): void
}) {
  return (
    <main className="ce-demo-launcher">
      <section className="ce-demo-card" aria-labelledby="ce-demo-title">
        <p className="ce-demo-eyebrow">GenioOne CE Demo</p>
        <h1 id="ce-demo-title">{task?.title ?? botCopy("Loading demo task", "載入示範任務")}</h1>
        {loading ? <p className="ce-demo-status"><LoaderCircle className="spin" />{botCopy("Checking your Platform access and demo Bot…", "正在確認你的 Platform 授權與示範 Bot…")}</p> : null}
        {task ? <p className="ce-demo-route">{botCopy("Model route", "模型路線")}：{task.modelRoute === "genio-gateway" ? botCopy("Managed Gemini", "受管 Gemini") : botCopy("My Codex subscription", "我的 Codex 訂閱")}</p> : null}
        {task ? (
          <label className="ce-demo-prompt">
            <span>{botCopy("Task prompt", "任務內容")}</span>
            <textarea value={prompt} onChange={(event) => onPromptChange(event.target.value)} rows={12} />
          </label>
        ) : null}
        {error ? <p className="ce-demo-error" role="alert">{failureMessage(error)}</p> : null}
        <div className="ce-demo-actions">
          {task ? <>
            <button type="button" className="primary-button" disabled={installing} onClick={onInstall}>
              {installing ? <><LoaderCircle className="spin" />{botCopy("Installing…", "安裝中")}</> : botCopy("Install my demo Bot", "安裝我的示範 Bot")}
            </button>
            <button type="button" className="secondary-button" disabled={installing || !prompt.trim()} onClick={onStart}>{botCopy("Continue with installed Bot", "使用已安裝的 Bot 繼續")}</button>
          </> : null}
          {error ? <button type="button" className="secondary-button" disabled={loading || installing} onClick={onRetry}>{botCopy("Check again", "重新確認")}</button> : null}
          <button type="button" className="secondary-button" disabled={installing} onClick={onReturnToBots}>{botCopy("Back to My Bots", "返回我的 Bot")}</button>
        </div>
      </section>
    </main>
  )
}
