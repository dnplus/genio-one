import type { BotSidebarSummary } from "../../../shared/bot-roster"
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react"
import {
  ChevronDown,
  FolderPlus,
  LogOut,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  UserRound,
} from "lucide-react"

import type { BotInstance } from "../../bots-storage"
import type { GenioCatalog, GenioIdentity } from "../../lib/genio-one"
import type { BotGroupDto } from "../../lib/bot-api"
import type { StateId } from "../../vendor/bloub/bot/states"
import {
  projectRosterSidebarStatus,
  rosterStatusPreview,
} from "../../../server/bot-roster-status"
import { AppMark } from "../common/AppMark"
import { formatSidebarTime, getBotSummary, getSubjectDisplayName } from "../common/helpers"
import { botCopy, botDisplayName } from "../../lib/ui-copy"

const BOT_DRAG_MIME = "application/x-genio-bot-id"

export function Sidebar({
  bots,
  activeBot,
  onSelectBot,
  onAddBot,
  identity,
  catalog,
  statusState = "idle",
  unreadBotIds,
  workStates,
  summaries,
  groups = [],
  onAssignBotToGroup,
  onCreateGroupForBot,
  onRemoveBotFromGroup,
  onOpenSettings,
  onOpenSearch,
  onSignOut,
}: {
  bots: BotInstance[]
  activeBot: BotInstance | null
  onSelectBot: (botId: string) => void
  onAddBot: () => void
  identity?: GenioIdentity | null
  catalog?: GenioCatalog | null
  statusState?: StateId
  summaries?: Record<string, BotSidebarSummary>
  unreadBotIds?: Set<string>
  workStates?: Record<string, "idle" | "working" | "stopped">
  groups?: BotGroupDto[]
  onAssignBotToGroup?: (botId: string, groupId: string) => void
  onCreateGroupForBot?: (botId: string) => void
  onRemoveBotFromGroup?: (botId: string, groupId: string) => void
  onOpenSettings?: () => void
  onOpenSearch?: () => void
  onSignOut?: () => void
}) {
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [menu, setMenu] = useState<{ botId: string; x: number; y: number } | null>(null)
  const [dropGroupId, setDropGroupId] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const contextRef = useRef<HTMLDivElement>(null)
  const displayName = getSubjectDisplayName(identity ?? null, catalog)

  const groupedIds = useMemo(() => {
    const ids = new Set<string>()
    for (const group of groups) {
      for (const id of group.memberBotIds) ids.add(id)
    }
    return ids
  }, [groups])

  const ungroupedBots = useMemo(
    () => bots.filter((bot) => !groupedIds.has(bot.id)),
    [bots, groupedIds],
  )

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false)
      }
      if (contextRef.current && !contextRef.current.contains(e.target as Node)) {
        setMenu(null)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  const renderBotCard = (b: BotInstance) => {
    const displayBotName = botDisplayName(b)
    const summary: BotSidebarSummary = summaries === undefined ? getBotSummary(b) : summaries[b.id] ?? { preview: b.title || b.role || b.name }
    const isUnread = unreadBotIds?.has(b.id) ?? false
    const workState = workStates?.[b.id] || "idle"
    const state = { unread: isUnread, workState, waitingFor: summary.waitingFor }
    const projection = projectRosterSidebarStatus(state)
    const isWorking = projection.status === "working"
    const needsAttention = projection.status === "needs-attention"
    const isWaitingForApproval = needsAttention && state.waitingFor === "approval"
    const isWaitingForAnswer = needsAttention && state.waitingFor === "answer"
    const rosterPreview = rosterStatusPreview(state, summary.preview)
    let statusLabel = projection.statusLabel
    let statusPreview = rosterPreview
    if (isWorking) {
      statusLabel = botCopy("Working", projection.statusLabel ?? "工作中")
      statusPreview = botCopy("Working…", rosterPreview)
    } else if (isWaitingForApproval) {
      statusLabel = botCopy("Waiting for your confirmation", projection.statusLabel ?? "等待你確認")
      statusPreview = botCopy("Waiting for your confirmation", rosterPreview)
    } else if (isWaitingForAnswer) {
      statusLabel = botCopy("Waiting for your answer", projection.statusLabel ?? "等待你回答")
      statusPreview = botCopy("Waiting for your answer", rosterPreview)
    } else if (needsAttention) {
      statusLabel = botCopy("Needs attention", projection.statusLabel ?? "需要注意")
      statusPreview = botCopy("Stopped, no response", rosterPreview)
    } else if (projection.status === "unread") {
      statusLabel = botCopy("Unread activity", projection.statusLabel ?? "未讀動態")
      statusPreview = botCopy("Unread activity", rosterPreview)
    }
    const statusSuffix = statusLabel ? ` · ${statusLabel}` : ""
    return (
      <div
        key={b.id}
        className={`bot-list-card ${b.id === activeBot?.id ? "active" : ""} ${isWorking ? "working" : ""} ${needsAttention ? "needs-attention" : ""}`}
        data-work-state={workState}
        data-unread={isUnread ? "1" : "0"}
        data-roster-status={projection.status ?? "idle"}
        draggable
        onDragStart={(event: DragEvent) => {
          event.dataTransfer.setData(BOT_DRAG_MIME, b.id)
          event.dataTransfer.effectAllowed = "move"
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          setMenu({ botId: b.id, x: event.clientX, y: event.clientY })
        }}
      >
        <button
          type="button"
          className="bot-list-card-main"
          onClick={() => onSelectBot(b.id)}
          title={`${displayBotName} · ${b.title || b.description || b.role}${statusSuffix}`}
        >
          <AppMark profile={b} small animated={b.id === activeBot?.id || isWorking} state={b.id === activeBot?.id ? statusState : isWorking ? "orbit" : "idle"} />
          <div className="bot-card-info">
            <div className="bot-card-header">
              <strong>{displayBotName}</strong>
              {summary.timestamp && (
                <span className="bot-card-time">{formatSidebarTime(summary.timestamp)}</span>
              )}
            </div>
            <small>{statusPreview}</small>
          </div>
          {projection.status === "working" ? (
            <span className="bot-working-dot" title={statusLabel ?? botCopy("Working", "工作中")} />
          ) : projection.status === "needs-attention" ? (
            <span className="bot-attention-dot" title={statusLabel ?? projection.statusLabel ?? "需要注意"} />
          ) : b.id === activeBot?.id ? (
            <span className="bot-active-dot" />
          ) : projection.status === "unread" ? (
            <span className="bot-unread-dot" title={statusLabel ?? projection.statusLabel ?? "未讀動態"} />
          ) : null}
        </button>
        <button
          type="button"
          className="bot-list-card-menu"
          aria-label={`${displayBotName} ${botCopy("menu", "選單")}`}
          title={botCopy("Bot menu", "Bot 選單")}
          onClick={(event) => {
            event.stopPropagation()
            const rect = event.currentTarget.getBoundingClientRect()
            setMenu({ botId: b.id, x: rect.right, y: rect.bottom })
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
    )
  }

  const menuBot = menu ? bots.find((bot) => bot.id === menu.botId) : null
  const menuGroup = menuBot ? groups.find((group) => group.memberBotIds.includes(menuBot.id)) : null

  return (
    <aside className="sidebar" data-testid="bot-roster">
      <div className="sidebar-top-bar">
        <button type="button" className="search-button" onClick={onOpenSearch}>
          <Search /><span>{botCopy("Search conversations / Bots", "搜尋對話 / Bot")}</span><kbd>⌘K</kbd>
        </button>
        <button type="button" className="sidebar-top-add-btn" aria-label={botCopy("Create new Bot", "建立新 Bot")} title={botCopy("Create new Bot", "建立新 Bot")} onClick={onAddBot}>
          <Plus />
        </button>
      </div>

      <div className="sidebar-bot-section">
        <div className="sidebar-section-title">
          <span>{botCopy("Agent Bots", "代理 Bot 清單")} ({bots.length})</span>
        </div>
        <div className="sidebar-bot-list">
          {groups.map((group) => (
            <div
              key={group.groupId}
              className={`sidebar-bot-group ${dropGroupId === group.groupId ? "drop-target" : ""}`}
              onDragOver={(event) => {
                event.preventDefault()
                event.dataTransfer.dropEffect = "move"
                setDropGroupId(group.groupId)
              }}
              onDragLeave={() => {
                setDropGroupId((current) => current === group.groupId ? null : current)
              }}
              onDrop={(event) => {
                event.preventDefault()
                setDropGroupId(null)
                const botId = event.dataTransfer.getData(BOT_DRAG_MIME)
                if (botId) onAssignBotToGroup?.(botId, group.groupId)
              }}
            >
              <div className="sidebar-bot-group-header">
                <strong>{group.name}</strong>
                <small>{group.memberBotIds.length}</small>
              </div>
              {group.memberBotIds.map((id) => {
                const bot = bots.find((item) => item.id === id)
                return bot ? renderBotCard(bot) : null
              })}
            </div>
          ))}
          {ungroupedBots.map((b) => renderBotCard(b))}
        </div>
      </div>

      <div className="sidebar-spacer" />
      <div className="user-card-wrap" ref={menuRef}>
        <button type="button" className="user-card" onClick={() => setUserMenuOpen((v) => !v)}>
          <UserRound />
          <span>
            <strong>{displayName}</strong>
            <small>{identity?.role === "TENANT_ADMINISTRATOR" ? botCopy("Tenant administrator", "租戶管理員") : identity?.role === "USER" ? botCopy("Organization member", "企業成員") : identity?.role || (activeBot?.name ? `${botDisplayName(activeBot)} ${botCopy("owner", "的擁有者")}` : botCopy("Organization account", "企業帳號"))}</small>
          </span>
          <ChevronDown />
        </button>
        {userMenuOpen && (
          <div className="user-menu">
            <div className="user-menu-header">
              <strong>{displayName}</strong>
              <small>{botCopy("Account", "帳號")}：{identity?.email || identity?.subject_id || botCopy("Verified", "已驗證")}</small>
            </div>
            {onOpenSettings && (
              <button type="button" className="user-menu-item" onClick={() => { setUserMenuOpen(false); onOpenSettings(); }}>
                <Settings /> {botCopy("Bot settings", "Bot 設定")}
              </button>
            )}
            {onSignOut && (
              <button type="button" className="user-menu-item sign-out" onClick={() => { setUserMenuOpen(false); onSignOut(); }}>
                <LogOut /> {botCopy("Sign out of Bot", "登出 Bot")}
              </button>
            )}
          </div>
        )}
      </div>

      {menu && menuBot && (
        <div
          ref={contextRef}
          className="bot-context-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
        >
          <div className="bot-context-menu-label">{botCopy("Move to group", "移到分組")}</div>
          {groups.map((group) => (
            <button
              key={group.groupId}
              type="button"
              className="bot-context-menu-item"
              disabled={group.memberBotIds.includes(menuBot.id)}
              onClick={() => {
                onAssignBotToGroup?.(menuBot.id, group.groupId)
                setMenu(null)
              }}
            >
              {group.name}
            </button>
          ))}
          <button
            type="button"
            className="bot-context-menu-item"
            onClick={() => {
              onCreateGroupForBot?.(menuBot.id)
              setMenu(null)
            }}
          >
            <FolderPlus size={14} /> {botCopy("New group…", "新增分組…")}
          </button>
          {menuGroup && (
            <button
              type="button"
              className="bot-context-menu-item"
              onClick={() => {
                onRemoveBotFromGroup?.(menuBot.id, menuGroup.groupId)
                setMenu(null)
              }}
            >
              {botCopy(`Remove from “${menuGroup.name}”`, `從「${menuGroup.name}」移出`)}
            </button>
          )}
        </div>
      )}
    </aside>
  )
}
