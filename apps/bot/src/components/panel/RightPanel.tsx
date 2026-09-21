import { useState } from "react"
import { LegacyHistoryImport } from "./LegacyHistoryImport"
import { BotWorkPanel } from "./BotWorkPanel"
import { BotMemoryPanel } from "./BotMemoryPanel"
import {
  Activity,
  Brain,
  CheckCircle2,
  ExternalLink,
  FileText,
  Globe,
  MessageSquare,
  Monitor,
  MonitorOff,
  PanelRightClose,
  Plug,
  RefreshCw,
  Search,
  TerminalSquare,
  X,
} from "lucide-react"

import type { BotInstance, ChatMessage } from "../../bots-storage"
import type { ArtifactRef, BotInvocationRequest } from "../../lib/bot-api"
import { runtimeCanExec, type RuntimeDetails } from "../../lib/codex-client"
import {
  USER_SCOPED_COMPUTER_COPY,
  handsPreviewSummary,
  type HandsComputerView,
} from "../chat/hands-ui"
import { LoginWallCard } from "../modals/LoginWallCard"
import type { LoginWallView } from "../chat/hands-ui"
import { botCopy, botDisplayName, botStatusText, isEnglishBotLocale } from "../../lib/ui-copy"

export type RightPanelTab = "work" | "threads" | "memory" | "desktop" | "activities"

export interface ActivityEntry {
  id: string
  title: string
  detail: string
  status: "waiting" | "running" | "done" | "failed"
  kind: "runtime" | "mcp" | "command" | "file" | "web"
}

export function RightPanel({
  activeTab,
  onTabChange,
  bot,
  messages,
  historyImportToken,
  onSelectMessage,
  runtime,
  runtimeTiers,
  status,
  mcpStatus,
  activities,
  artifacts,
  botInvocations,
  botNames = {},
  pendingAttention,
  viewerSubjectId,
  onClose,
  onRetryMcp,
  onEnsureRuntime,
  onImportArtifact,
  onBotInvocationDecision,
  handsComputer = null,
  onOpenHandsPreview,
  loginWall = null,
  onLoginWallTakeover,
  onLoginWallCompleted,
  onLoginWallDismiss,
}: {
  activeTab: RightPanelTab
  onTabChange: (tab: RightPanelTab) => void
  bot: BotInstance
  messages: ChatMessage[]
  historyImportToken?: string
  onSelectMessage: (id: string) => void
  runtime: RuntimeDetails | null
  runtimeTiers?: Partial<Record<"none" | "headless" | "desktop", RuntimeDetails>>
  status: string
  mcpStatus: string
  activities: ActivityEntry[]
  artifacts?: ArtifactRef[]
  botNames?: Record<string, string>
  pendingAttention?: string
  botInvocations?: BotInvocationRequest[]
  viewerSubjectId?: string
  onClose?: () => void
  onRetryMcp?: () => void
  onEnsureRuntime?: (tier: "headless" | "desktop") => void
  onImportArtifact?: (artifact: ArtifactRef) => void
  onBotInvocationDecision?: (requestId: string, decision: "APPROVE" | "DENY") => void | Promise<void>
  /** UX P2: user-scoped Hands mock computer (Epic E). */
  handsComputer?: HandsComputerView | null
  onOpenHandsPreview?: () => void
  loginWall?: LoginWallView | null
  onLoginWallTakeover?: () => void
  onLoginWallCompleted?: () => void
  onLoginWallDismiss?: () => void
}) {
  const [threadSearch, setThreadSearch] = useState("")
  const displayBotName = botDisplayName(bot)
  const desktopRuntime = runtimeTiers?.desktop ?? (runtime?.tier === "desktop" ? runtime : null)

  const filteredMessages = messages.filter((message) =>
    !threadSearch.trim() || message.text.toLowerCase().includes(threadSearch.toLowerCase())
  ).slice().reverse()

  return (
    <aside className="desktop-rail" data-testid="bot-inspector" data-panel="inspector">
      <header className="right-panel-header">
        <nav className={`right-panel-nav ${historyImportToken ? "right-panel-nav--with-work" : ""}`}>
          {historyImportToken && <button type="button" className={`right-tab-btn ${activeTab === "work" ? "active" : ""}`} onClick={() => onTabChange("work")} title={botCopy("Current work", "目前工作")}><CheckCircle2 /><span>{botCopy("Work", "工作")}</span></button>}
          {historyImportToken && <button type="button" className={`right-tab-btn ${activeTab === "memory" ? "active" : ""}`} onClick={() => onTabChange("memory")} title={botCopy("Bot memory", "Bot 記憶")}><Brain /><span>{botCopy("Memory", "記憶")}</span></button>}
          <button
            type="button"
            className={`right-tab-btn ${activeTab === "threads" ? "active" : ""}`}
            onClick={() => onTabChange("threads")}
            title={botCopy("Conversation history", "對話記錄")}
          >
            <MessageSquare />
            <span>{botCopy("History", "對話記錄")}</span>
          </button>
          <button
            type="button"
            className={`right-tab-btn ${activeTab === "desktop" ? "active" : ""}`}
            onClick={() => onTabChange("desktop")}
            title={botCopy("Managed Desktop", "受控電腦")}
          >
            <Monitor />
            <span>{botCopy("Desktop", "電腦")}</span>
            <span className={`status-dot ${runtime?.desktopUrl ? "online" : "offline"}`} />
          </button>
          <button
            type="button"
            className={`right-tab-btn ${activeTab === "activities" ? "active" : ""}`}
            onClick={() => onTabChange("activities")}
            title={botCopy("Activity", "執行活動")}
          >
            <Activity />
            <span>{botCopy("Activity", "活動")}</span>
          </button>
        </nav>
        {onClose && (
          <button className="icon-button" onClick={onClose} aria-label={botCopy("Close panel", "收合選單")} title={botCopy("Close panel", "收合選單")}>
            <PanelRightClose />
          </button>
        )}
      </header>
      {activeTab === "work" && historyImportToken && <BotWorkPanel key={bot.id} botId={bot.id} token={historyImportToken} status={status} attention={pendingAttention} messages={messages} invocations={botInvocations ?? []} names={botNames} viewerSubjectId={viewerSubjectId} onDecision={onBotInvocationDecision} onSelectMessage={onSelectMessage} onManageMemory={() => onTabChange("memory")} />}
      {activeTab === "memory" && historyImportToken && <BotMemoryPanel key={bot.id} botId={bot.id} botName={bot.name} token={historyImportToken} />}

      {activeTab === "threads" && (
        <div className="right-panel-content threads-panel">
          <div className="threads-top">
            <div className="threads-search-bar">
              <Search />
              <input
                type="text"
                placeholder={botCopy(`Search ${displayBotName} conversations...`, `搜尋 ${bot.name} 的對話...`)}
                value={threadSearch}
                onChange={(e) => setThreadSearch(e.target.value)}
              />
              {threadSearch && (
                <button type="button" className="clear-btn" onClick={() => setThreadSearch("")} aria-label={botCopy("Clear search", "清除搜尋")}>
                  <X />
                </button>
              )}
            </div>
          </div>

          <div className="threads-list">
            {historyImportToken && <LegacyHistoryImport key={bot.id} botId={bot.id} token={historyImportToken} />}
            <div className="threads-header-label">
              <span>{botCopy(`${displayBotName} history`, `${bot.name} 的聊天記錄`)} ({filteredMessages.length})</span>
            </div>
            {filteredMessages.map((message) => (
              <button type="button" key={message.id} className="thread-item" onClick={() => onSelectMessage(message.id)}>
                <MessageSquare />
                <span className="thread-info">
                  <strong>{message.text.slice(0, 100)}</strong>
                  {message.createdAt && <small>{new Date(message.createdAt).toLocaleString(isEnglishBotLocale() ? "en-US" : "zh-TW")}</small>}
                </span>
              </button>
            ))}
            {filteredMessages.length === 0 && <div className="threads-empty"><p>{threadSearch ? botCopy("No matching messages", "找不到符合的訊息") : botCopy("Your history will stay here after you start chatting.", "開始聊天後，記錄會持續保留在這裡。")}</p></div>}
          </div>
        </div>
      )}

      {activeTab === "desktop" && (
        <div className="right-panel-content desktop-panel">
          {runtime?.desktopUrl ? (
            <div className="desktop-view">
              <div className="desktop-frame">
                <iframe src={runtime.desktopUrl} title="E2B Managed Desktop" />
              </div>
              <div className="desktop-bar">
                <span><Monitor /> {botCopy("Remote sandbox connected", "遠端沙盒已連接")}</span>
                <div className="desktop-actions">
                  {onEnsureRuntime && (
                    <button type="button" className="activity-action" onClick={() => onEnsureRuntime("desktop")}>
                      <RefreshCw /> <span>{botCopy("Reconnect", "重新連線")}</span>
                    </button>
                  )}
                  <a href={runtime.desktopUrl} target="_blank" rel="noreferrer">
                    {botCopy("Open full screen", "另開全螢幕")} <ExternalLink />
                  </a>
                </div>
              </div>
            </div>
          ) : (
            <div className="desktop-offline-card">
              <div className="desktop-offline-icon">
                <MonitorOff />
              </div>
              <strong>{botCopy("Managed Desktop is not enabled", "受控電腦畫面尚未啟用")}</strong>
              <p>
                {botCopy("This desktop capability is authorized separately. Assigned Bots can still chat and use enterprise tools without a desktop view; code execution starts a basic remote sandbox instead of running commands on this browser host.", "這是獨立授權的桌面能力。沒有畫面時，已配發的 Bot 仍可對話與使用企業工具；需要執行程式時會另開基礎遠端沙盒，不會改在這台瀏覽器主機跑指令。")}
              </p>
              <small>{botCopy("computer_use access is checked before enabling the desktop.", "點選啟用電腦前，會先檢查 computer_use 授權。")}</small>
              {onEnsureRuntime && (
                <button type="button" className="primary-button" onClick={() => onEnsureRuntime("desktop")}>
                  <Monitor /> {botCopy("Enable Managed Desktop", "啟用 Managed Desktop")}
                </button>
              )}
            </div>
          )}
          <div className="hands-preview-panel" data-testid="hands-preview-panel">
            <div className="hands-preview-heading">
              <strong>Hands 預覽</strong>
              <small>{USER_SCOPED_COMPUTER_COPY.securityNote}</small>
            </div>
            {(() => {
              const summary = handsPreviewSummary(handsComputer ?? null)
              return (
                <>
                  <p className="hands-preview-status" data-hands-status={handsComputer?.status ?? "idle"}>
                    {summary.statusLabel}
                    {summary.computerId ? <small> · {summary.computerId}</small> : null}
                    {summary.windowCount > 0 ? <small> · {summary.windowCount} 個 Bot 視窗</small> : null}
                  </p>
                  <p className="hands-preview-copy">{USER_SCOPED_COMPUTER_COPY.body}</p>
                  {summary.previewUrl ? (
                    <div className="hands-preview-frame" data-testid="hands-mock-preview">
                      <div className="hands-mock-surface">
                        <Monitor />
                        <span>Mock Hands 預覽（Epic E e2b-mock）</span>
                        <code>{summary.previewUrl}</code>
                      </div>
                    </div>
                  ) : (
                    <div className="hands-preview-offline">
                      <small>尚未開啟 remote_hands.desktop 預覽。允許後可 mock 預覽／session；拒絕則無法開啟。</small>
                      {onOpenHandsPreview && (
                        <button type="button" className="primary-button" onClick={onOpenHandsPreview}>
                          <Monitor /> 開啟 Hands 預覽（mock）
                        </button>
                      )}
                    </div>
                  )}
                </>
              )
            })()}
            {loginWall && onLoginWallTakeover && onLoginWallCompleted && onLoginWallDismiss && (
              <LoginWallCard
                wall={loginWall}
                onTakeover={onLoginWallTakeover}
                onCompleted={onLoginWallCompleted}
                onDismiss={onLoginWallDismiss}
              />
            )}
          </div>

          {(artifacts?.length ?? 0) > 0 && (
            <div className="desktop-artifact-panel">
              <div className="desktop-artifact-heading"><strong>Server 產物</strong><small>跨 sandbox 必須明確匯入</small></div>
              {artifacts!.map((artifact) => (
                <div className="desktop-artifact-row" key={artifact.artifactId}>
                  <span><FileText /><strong>{artifact.path.split("/").at(-1) || artifact.artifactId}</strong></span>
                  <button type="button" className="secondary-button" disabled={!desktopRuntime?.execReady || !onImportArtifact} onClick={() => onImportArtifact?.(artifact)}>
                    在 Desktop 開啟
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === "activities" && (
        <div className="right-panel-content activities-panel">
          <section className="activity-panel">
            <div className="activity-heading">
            <h3>{botCopy("Environment connection status", "環境連線狀態")}</h3>
              <span className="runtime-state active">{botStatusText(status)}</span>
            </div>
            <div className="activity-step">
              <span className={runtimeCanExec(runtime) ? "done" : ""}>
                <Monitor />
              </span>
              <p>
                <strong>{botCopy("Remote sandbox", "遠端沙盒")}</strong>
                <small>{runtimeCanExec(runtime) ? botCopy(`${runtime?.tier === "desktop" ? "Desktop" : "Headless"} ready for execution`, `${runtime?.tier === "desktop" ? "Desktop" : "Headless"} 可執行`) : botCopy("Not started (conversation and enterprise tools remain available)", "尚未啟動（對話與企業工具仍可用）")}</small>
              </p>
              {onEnsureRuntime && !runtimeTiers?.headless && (
                <button type="button" className="activity-action" onClick={() => onEnsureRuntime("headless")}>
                  <TerminalSquare /> <span>{botCopy("Enable Headless", "啟用 Headless")}</span>
                </button>
              )}
            </div>
            <div className="activity-step">
              <span className={mcpStatus.includes("工具") || mcpStatus === "已連線" ? "done" : ""}>
                <Plug />
              </span>
              <p>
                <strong>{botCopy("GenioOne enterprise tools", "GenioOne 企業工具")}</strong>
                <small>{botStatusText(mcpStatus)}</small>
              </p>
              {onRetryMcp && (
                <button
                  type="button"
                  className="activity-action"
                  onClick={onRetryMcp}
                  aria-label={botCopy("Recheck enterprise tools", "重新檢查企業工具")}
                  title={botCopy("Recheck and connect GenioOne enterprise tools", "重新檢查並連接 GenioOne 企業工具")}
                >
                  <RefreshCw />
                  <span>{botCopy("Recheck", "重新檢查")}</span>
                </button>
              )}
            </div>

            <div className="activity-section-divider">{botCopy("Recent conversation activity", "近期對話執行歷程")}</div>

            {activities.map((activity) => (
              <div className="activity-step" key={activity.id}>
                <span className={activity.status}>
                  {activity.kind === "web" ? <Globe /> : activity.kind === "command" ? <TerminalSquare /> : activity.kind === "file" ? <FileText /> : activity.status === "done" ? <CheckCircle2 /> : <Plug />}
                </span>
                <p>
                  <strong>{activity.title}</strong>
                  <small>{activity.detail}</small>
                </p>
              </div>
            ))}
            {activities.length === 0 && (
              <div className="activities-empty">{botCopy("No external tools or commands have run yet", "目前尚無執行的外部工具或指令")}</div>
            )}
            {(botInvocations?.length ?? 0) > 0 && (
              <>
                <div className="activity-section-divider">{botCopy("Bot collaboration requests", "Bot 協作請求")}</div>
                {botInvocations!.slice(0, 5).map((invocation) => (
                  <div className="bot-invocation-card" key={invocation.requestId}>
                    <div className="bot-invocation-heading">
                      <strong>@{invocation.targetBotId}</strong>
                      <span className={`invocation-state invocation-state--${invocation.state.toLowerCase()}`}>{invocation.state}</span>
                    </div>
                    <p>{invocation.task}</p>
                    <small>已選取 {invocation.selectedContextRefs.length} 個上下文 · {new Date(invocation.createdAt).toLocaleTimeString("zh-TW")}</small>
                    {invocation.state === "PENDING" && viewerSubjectId === invocation.targetOwnerSubjectId && onBotInvocationDecision && (
                      <div className="bot-invocation-actions">
                        <button type="button" className="primary-button" onClick={() => onBotInvocationDecision(invocation.requestId, "APPROVE")}>允許這次</button>
                        <button type="button" className="secondary-button" onClick={() => onBotInvocationDecision(invocation.requestId, "DENY")}>拒絕</button>
                      </div>
                    )}
                    {invocation.resultSummary && <div className="bot-invocation-result">{invocation.resultSummary}</div>}
                  </div>
                ))}
              </>
            )}
          </section>
        </div>
      )}
    </aside>
  )
}
