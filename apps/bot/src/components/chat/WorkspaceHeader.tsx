import { useMemo, useState } from "react"
import { LocalHandsModal } from "../modals/LocalHandsModal"
import { Monitor, MonitorOff, PanelRightOpen, Plus, Settings, Wrench } from "lucide-react"
import { AppMark } from "../common"
import { runtimeCanExec, type RuntimeDetails } from "../../lib/codex-client"
import type { BotInstance } from "../../bots-storage"
import type { StateId } from "../../vendor/bloub/bot/states"
import type { GenioCatalog } from "../../lib/genio-one"
import { boundEnterpriseToolCount } from "../../lib/catalog-surface"
import { botCopy, botDisplayName, botStatusText } from "../../lib/ui-copy"

export function getDesktopStatus(runtime: RuntimeDetails | null) {
  if (runtime?.kind === "endpoint") return { text: runtime.execReady ? "本機已連接" : "本機已離線", active: runtime.execReady, offline: !runtime.execReady, title: `本機工作資料夾：${runtime.cwd}` }
  if (runtime?.desktopUrl) {
    return { text: "受控電腦", active: true, offline: false, title: "遠端受控電腦已連線，點擊切換畫面" }
  }
  if (runtimeCanExec(runtime)) {
    return { text: "沙盒就緒", active: true, offline: true, title: "基礎遠端沙盒可執行；尚未開啟桌面畫面" }
  }
  return { text: "沙盒未啟動", active: false, offline: true, title: "對話與企業工具可用；執行程式時才會啟動遠端沙盒" }
}

export function getToolStatus(mcpStatus: string, catalog?: GenioCatalog | null, activeBot?: BotInstance) {
  const installedCount = boundEnterpriseToolCount(activeBot?.bindings, catalog?.capabilities ?? [])
  const runtimeReady = mcpStatus === "已連線" || mcpStatus.includes("個工具") || mcpStatus === "Connected" || mcpStatus.includes("tool")
  if (installedCount > 0) {
    return {
      text: botCopy(`${installedCount} ${installedCount === 1 ? "tool" : "tools"}`, `${installedCount} 個工具`),
      active: true,
      warning: !runtimeReady,
      title: runtimeReady ? botCopy("Enterprise tools installed for this Bot", "這個 Bot 已加入的企業工具") : botCopy("Tools are installed, but not attached to this conversation yet", "已加入工具，但這場對話還沒掛上"),
    }
  }
  return { text: botCopy("No tools installed", "尚未加入工具"), active: false, warning: false, title: botCopy("Open to add enterprise resources available to you", "打開後可把你能用的企業資源加入這個 Bot") }
}

export interface WorkspaceHeaderProps {
  token?: string
  activeBot: BotInstance
  effectiveStatus: { text: string; state: StateId; isReady: boolean }
  runtime: RuntimeDetails | null
  mcpStatus: string
  rightPanelOpen: boolean
  catalog?: GenioCatalog | null
  onOpenSettings?: () => void
  onOpenDesktop: () => void
  onOpenCatalog: () => void
  onOpenCorpCatalog?: () => void
  onOpenRightPanel: () => void
}

export function WorkspaceHeader({
  token,
  activeBot,
  effectiveStatus,
  runtime,
  mcpStatus,
  rightPanelOpen,
  catalog,
  onOpenSettings,
  onOpenDesktop,
  onOpenCatalog,
  onOpenCorpCatalog,
  onOpenRightPanel,
}: WorkspaceHeaderProps) {
  const [localHandsOpen, setLocalHandsOpen] = useState(false)
  const displayName = botDisplayName(activeBot)
  const desktopStatus = useMemo(() => getDesktopStatus(runtime), [runtime])
  const toolStatus = useMemo(() => getToolStatus(mcpStatus, catalog, activeBot), [mcpStatus, catalog, activeBot])

  return (
    <header className="chat-header">
      <div className="chat-header-left">
        <button
          type="button"
          className="chat-header-avatar chat-header-avatar--clickable"
          onClick={onOpenSettings}
          title={`${botCopy("Bot settings", "Bot 設定")} · ${displayName}`}
          aria-label={`${botCopy("Bot settings", "Bot 設定")} · ${displayName}`}
          style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer" }}
        >
          <AppMark key={activeBot.id} profile={activeBot} small animated={true} state={effectiveStatus.state} />
        </button>
        <div className="chat-header-info">
          <div className="chat-header-title-row">
            <h2>{displayName}</h2>
            {onOpenSettings && (
              <button
                type="button"
                className="icon-button header-settings-btn"
                onClick={onOpenSettings}
                title={`${botCopy("Bot settings", "Bot 設定")} · ${displayName}`}
                aria-label={`${botCopy("Bot settings", "Bot 設定")} · ${displayName}`}
              >
                <Settings size={15} />
              </button>
            )}
            <span className={`agent-state-chip agent-state-chip--${effectiveStatus.state}`} aria-live="polite">
              {botStatusText(effectiveStatus.text)}
            </span>
          </div>
          <div className="chat-header-actions">
            <button
              type="button"
              className="header-status-pill"
              onClick={() => setLocalHandsOpen(true)}
            >
              <Monitor /><span>{botCopy("Connect local endpoint", "連接本機")}</span>
            </button>
            <button
              type="button"
              className={`header-status-pill ${runtime?.desktopUrl ? "connected" : desktopStatus.offline ? "offline" : ""}`}
              onClick={onOpenDesktop}
              title={botStatusText(desktopStatus.title)}
            >
              {desktopStatus.offline ? <MonitorOff /> : <Monitor />}
              <span>{botStatusText(desktopStatus.text)}</span>
            </button>
            <button
              type="button"
              className={`header-status-pill ${toolStatus.warning ? "warning" : toolStatus.active ? "active" : ""}`}
              onClick={onOpenCatalog}
              title={toolStatus.title}
            >
              <Wrench />
              <span>{toolStatus.text}</span>
            </button>
            {onOpenCorpCatalog && (
              <button type="button" className="header-status-pill" onClick={onOpenCorpCatalog} title={botCopy("Browse and install enterprise Bot packages", "瀏覽並安裝企業 Bot 套件")}>
                <Plus />
                <span>{botCopy("Enterprise Bots", "企業 Bot")}</span>
              </button>
            )}
          </div>
        </div>
      </div>
      {!rightPanelOpen && (
        <button
          type="button"
          className="icon-button desktop-toggle"
          onClick={onOpenRightPanel}
          title={botCopy("Open right panel", "開啟右側選單")}
          aria-label={botCopy("Open right panel", "開啟右側選單")}
        >
          <PanelRightOpen />
        </button>
      )}
      {localHandsOpen && <LocalHandsModal key={activeBot.id} botId={activeBot.id} token={token ?? ""} runtime={runtime} onClose={() => setLocalHandsOpen(false)} />}
    </header>
  )
}
