import { ShieldCheck, X } from "lucide-react"
import { BloubAvatar } from "../../avatar/bloub-avatar"
import type { BotPackageManifest } from "../../lib/bot-api"

export function CorpBotCatalogModal({
  packages,
  message,
  onClose,
  onInstall,
}: {
  packages: BotPackageManifest[]
  message?: string
  onClose(): void
  onInstall(packageInfo: BotPackageManifest): void
}) {
  return (
    <div className="profile-dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="profile-dialog catalog-dialog" role="dialog" aria-modal="true" aria-labelledby="corp-bot-catalog-title">
        <header>
          <span>
            <strong id="corp-bot-catalog-title">企業 Bot 套件</strong>
            <small>由 GenioOne 管理員發布，安裝後仍受 One Policy 控管</small>
          </span>
          <button type="button" className="icon-button" aria-label="關閉企業 Bot 套件" onClick={onClose}><X /></button>
        </header>
        <div className="catalog-content">
          {message ? <div className="catalog-alert"><span><ShieldCheck />{message}</span></div> : null}
          {packages.length === 0 ? <div className="search-empty">目前沒有可安裝的企業 Bot</div> : packages.map((packageInfo) => (
            <div className="corp-bot-package-card" key={`${packageInfo.resourceId}:${packageInfo.version}`}>
              <div className="corp-bot-package-avatar"><BloubAvatar value={packageInfo.profile.avatar as any} label={`${packageInfo.profile.title} 頭像`} animated /></div>
              <div className="corp-bot-package-copy">
                <div className="corp-bot-package-title"><strong>{packageInfo.profile.title}</strong><span>v{packageInfo.version}</span></div>
                <p>{packageInfo.profile.description}</p>
                <small>{packageInfo.skills.length} 個技能 · {packageInfo.plugins.length} 個 Plugin · {packageInfo.resourceBindings.length} 個企業 Resource</small>
                <small className="corp-bot-package-access">{packageInfo.accessStatus === "ENTITLED" ? "已授權" : packageInfo.accessStatus === "AUTO_GRANT" ? "可直接啟用" : packageInfo.accessStatus === "REQUEST" ? "需要申請" : packageInfo.accessStatus === "DENIED" ? "無法使用" : "待檢查授權"}{packageInfo.connectionStatus === "NEEDS_CONNECTION" ? " · 需要連線" : packageInfo.connectionStatus === "CONNECTED" ? " · Connection 已連線" : ""}</small>
              </div>
              <button type="button" className="primary-button" disabled={packageInfo.accessStatus === "DENIED"} onClick={() => onInstall(packageInfo)}>{packageInfo.accessStatus === "REQUEST" ? "申請後 Add" : "Add"}</button>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
