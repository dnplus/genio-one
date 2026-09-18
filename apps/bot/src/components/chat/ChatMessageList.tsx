import { AsyncQuestionCard } from "./AsyncQuestionCard"
import type { BotQuestion } from "../../../shared/bot-question"
import { runtimeActivityDetails } from "./codex-history"
import { MessageMedia } from "./MessageMedia"
import { McpHtmlArtifacts } from "./McpHtmlArtifacts"
import { useState, type RefObject } from "react"
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Database,
  KeyRound,
  RotateCcw,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react"

import type { BotInstance, ChatMessage } from "../../bots-storage"
import { FormattedMessage } from "../../formatted-message"
import type { StateId } from "../../vendor/bloub/bot/states"
import { AppMark, InteractionCard } from "../common"
import { formatDividerTime, formatMessageTime } from "../common/helpers"
import type { ActivityEntry } from "../panel/RightPanel"
import { modelRoutePresentation, modelRouteRequiresCodexLogin } from "../../lib/model-route"
import { botCopy, botDisplayName } from "../../lib/ui-copy"

export interface CodexLogin {
  verificationUrl: string
  userCode: string
}

export function ChatMessageList({
  messages,
  activeBot,
  bots,
  effectiveStatus,
  isAgentBusy,
  agentState,
  runningActivity,
  serviceNowCapability,
  codexLogin,
  messageFeedbacks,
  copiedMessageId,
  showScrollBottom,
  messagesContainerRef,
  onScroll,
  onScrollToBottom,
  onFeedback,
  onRetry,
  onCopyMessage,
  onStarterPromptClick,
  onNavigateMessage,
  navigationError,
  onQuestionAction,
}: {
  messages: ChatMessage[]
  activeBot: BotInstance
  bots?: BotInstance[]
  effectiveStatus: { text: string; state: StateId; isReady: boolean }
  isAgentBusy: boolean
  agentState: StateId
  runningActivity?: ActivityEntry
  serviceNowCapability?: { capability_id: string; capability_display_name: string } | null
  codexLogin: CodexLogin | null
  messageFeedbacks: Record<string, "positive" | "negative">
  copiedMessageId: string | null
  showScrollBottom: boolean
  messagesContainerRef: RefObject<HTMLDivElement | null>
  onScroll: () => void
  onScrollToBottom: () => void
  onFeedback: (messageId: string, feedback: "positive" | "negative") => void
  onRetry: (index: number) => void
  onCopyMessage: (id: string, text: string) => void
  onQuestionAction?: (question: BotQuestion, action: "answer" | "dismiss" | "retry", answer?: string, clientAnswerId?: string) => Promise<void>
  navigationError?: string
  onNavigateMessage?: (botId: string, messageId: string) => Promise<boolean>
  onStarterPromptClick: (text: string) => void
}) {
  const displayBotName = botDisplayName(activeBot)
  const [openHandoffId, setOpenHandoffId] = useState<string | null>(null)
  const openMessage = messages.find((message) => message.handoffId === openHandoffId && message.handoffThread)
  const openThread = openMessage?.handoffThread ? {
    ...openMessage.handoffThread,
    fromName: bots?.find((bot) => bot.id === openMessage.handoffThread?.fromBotId)?.name ?? openMessage.handoffThread.fromName,
    toName: bots?.find((bot) => bot.id === openMessage.handoffThread?.toBotId)?.name ?? openMessage.handoffThread.toName,
  } : null

  return (
    <>
    <div
      className="messages"
      ref={messagesContainerRef}
      onScroll={onScroll}
    >
      {messages.map((message, index) => {
        if (message.runtimeItem?.type === "agentMessage" && !message.text.trim()) return null
        const prev = messages[index - 1]
        const isFirst = index === 0
        const showTimeDivider = isFirst || Boolean(
          message.createdAt && prev?.createdAt && (message.createdAt - prev.createdAt > 10 * 60 * 1000)
        )
        const isLatestAssistant = !isAgentBusy && index === messages.length - 1 && message.role === "assistant"
        const isLoginWall = message.kind === "login_wall"
        const isHandoff = message.kind === "handoff"

        return (
          <div key={message.id} className="message-container" data-message-id={message.id} tabIndex={-1}>
            {message.legacySource && <div className="message-date-divider"><span>從瀏覽器匯入的舊記錄{!message.createdAt ? " · 原始時間未記錄" : ""}</span></div>}
            {showTimeDivider && message.createdAt && (
              <div className="message-date-divider">
                <span>{formatDividerTime(message.createdAt)}</span>
              </div>
            )}
            {message.question && onQuestionAction ? (
              <AsyncQuestionCard key={message.question.id} question={message.question} onAction={onQuestionAction} />
            ) : message.kind === "legacy" ? (
              <details className="message-row system">
                <summary>舊記錄：{message.text.slice(0, 60)}</summary>
                <div className="message-bubble">
                  <p>舊資料標示為{message.legacySource?.originalRole === "user" ? "使用者訊息" : message.legacySource?.originalRole === "assistant" ? "助手訊息" : "系統訊息"}；作者與時間沿用當時的瀏覽器記錄，尚未由執行歷史核對。</p>
                  <FormattedMessage text={message.text} />
                </div>
              </details>
            ) : isLoginWall ? (
              <div className="message-row system login-wall-event" data-login-wall-id={message.loginWallId} data-collects-password="false">
                <div className="message-bubble login-wall-bubble" role="status">
                  <span className="login-wall-bubble-label">{botCopy("Login wall", "登入牆")}</span>
                  <FormattedMessage text={message.text} />
                </div>
                <div className="message-meta-row">
                  {message.createdAt && (
                    <span className="message-time-label">
                      {formatMessageTime(message.createdAt)}
                    </span>
                  )}
                </div>
              </div>
            ) : message.kind === "activity" ? (
              <div className="message-row system mcp-tool-result" data-runtime-item-id={message.id}>
                <McpHtmlArtifacts item={message.runtimeItem} />
                <details>
                  <summary>{message.text === "工具執行" ? botCopy("Tool execution", message.text) : message.text}</summary>
                  <FormattedMessage text={runtimeActivityDetails(message.runtimeItem)} />
                </details>
              </div>
            ) : isHandoff ? (
              (() => {
                const isCallerChip = message.handoffEventType === "handoff.acked"
                  || message.handoffEventType === "handoff.sent"
                  || message.handoffEventType === "handoff.replied"
                if (isCallerChip && message.peerBotId === activeBot.id) return null
                const peerBot = message.peerBotId ? bots?.find((b) => b.id === message.peerBotId) : undefined
                let displayText = message.text
                if (message.handoffEventType === "handoff.read") {
                  displayText = message.handoffThread?.toBotId === activeBot.id ? `已讀取來自 ${peerBot?.name ?? message.handoffThread.fromName} 的 FYI` : `${peerBot?.name ?? message.handoffThread?.toName ?? "對方 Bot"} 已讀取 FYI`
                } else if (message.handoffEventType === "handoff.acked") {
                  displayText = peerBot ? `已接受交接給 ${peerBot.name}` : "交接已接受"
                } else if (message.handoffEventType === "handoff.replied") {
                  displayText = peerBot ? `${peerBot.name} 回覆了` : message.text
                } else if (message.handoffEventType === "handoff.queued") {
                  displayText = message.handoffThread?.toBotId === activeBot.id ? `等待空閒時處理來自 ${peerBot?.name ?? message.handoffThread.fromName} 的訊息` : peerBot ? `等待 ${peerBot.name} 處理` : "交接已排入佇列"
                } else if (message.handoffEventType === "handoff.delivered") {
                  const rawFact = message.text.replace(/^收到交接：/, "").trim()
                  displayText = peerBot ? `收到來自 ${peerBot.name} 的交接：${rawFact}` : message.text
                } else if (message.handoffEventType === "handoff.sent") {
                  displayText = peerBot ? `已送出交接給 ${peerBot.name}` : message.text
                }
                if (message.handoffState === "PENDING_APPROVAL") displayText = message.handoffThread?.toBotId === activeBot.id ? "收到待核准的交接，請到工作面板處理" : `等待 ${peerBot?.name ?? "對方 Bot"} 的擁有者核准`
                const thread = message.handoffThread ? {
                  ...message.handoffThread,
                  fromName: bots?.find((bot) => bot.id === message.handoffThread?.fromBotId)?.name ?? message.handoffThread.fromName,
                  toName: bots?.find((bot) => bot.id === message.handoffThread?.toBotId)?.name ?? message.handoffThread.toName,
                } : undefined
                return (
                  <div
                    className={`message-row system handoff-event handoff-${message.handoffEventType?.replace(".", "-") || "event"}`}
                    data-handoff-id={message.handoffId}
                  >
                    <button
                      type="button"
                      className={`handoff-compact-pill${thread ? " is-openable" : ""}`}
                      role="status"
                      title={thread ? "查看兩個 Bot 實際傳送的指令" : displayText}
                      onClick={() => thread && setOpenHandoffId(message.handoffId ?? null)}
                    >
                      {peerBot && (
                        <span className="handoff-bot-avatar" title={peerBot.name}>
                          <AppMark profile={peerBot} small={true} animated={false} />
                        </span>
                      )}
                      <span className="handoff-pill-text">{displayText}</span>
                      {message.createdAt && (
                        <span className="handoff-pill-time">
                          {formatMessageTime(message.createdAt)}
                        </span>
                      )}
                    </button>
                  </div>
                )
              })()
            ) : (
            <div className={`message-row ${message.role}`}>
              <div className="message-bubble">
                {message.messageType === "bot_update" && <small>進度更新</small>}
                {message.replyToMessageId && <button type="button" className="message-reply-link" disabled={!messages.some((entry) => entry.id === message.replyToMessageId)} onClick={() => {
                  const target = Array.from(messagesContainerRef.current?.querySelectorAll<HTMLElement>("[data-message-id]") ?? []).find((element) => element.dataset.messageId === message.replyToMessageId)
                  target?.scrollIntoView({ behavior: "smooth", block: "center" })
                  target?.focus({ preventScroll: true })
                }}>{message.handoffId ? "查看這次交接" : botCopy("View original message", "查看原訊息")}</button>}
                <MessageMedia item={message.runtimeItem} images={message.images} />
                <FormattedMessage
                  text={message.text}
                  mentions={message.role === "user" ? bots?.map((bot) => ({
                    id: bot.id,
                    name: bot.name,
                    description: bot.description ?? bot.role,
                    kind: "bot" as const,
                    avatar: bot.avatar,
                  })) : undefined}
                />
              </div>
              <div className="message-meta-row">
                {isLatestAssistant && (
                  <div className="message-latest-avatar-wrap" title={`${displayBotName} · ${effectiveStatus.text}`}>
                    <AppMark profile={activeBot} small animated={true} state={effectiveStatus.state} />
                  </div>
                )}
                {message.role === "assistant" && (
                  <div className="message-actions-bar" role="group" aria-label={botCopy("Message actions", "訊息操作")}>
                    <button
                      type="button"
                      className={`message-action-btn ${messageFeedbacks[message.id] === "positive" ? "active-positive" : ""}`}
                      title={botCopy("Like (positive feedback)", "讚 (正面反饋)")}
                      aria-label={botCopy("Like", "讚")}
                      onClick={() => onFeedback(message.id, "positive")}
                    >
                      <ThumbsUp />
                    </button>
                    <button
                      type="button"
                      className={`message-action-btn ${messageFeedbacks[message.id] === "negative" ? "active-negative" : ""}`}
                      title={botCopy("Dislike (negative feedback)", "倒讚 (負面反饋)")}
                      aria-label={botCopy("Dislike", "倒讚")}
                      onClick={() => onFeedback(message.id, "negative")}
                    >
                      <ThumbsDown />
                    </button>
                    <button
                      type="button"
                      className="message-action-btn"
                      title={botCopy("Regenerate (retry)", "重新生成 (重試)")}
                      aria-label={botCopy("Regenerate", "重新生成")}
                      onClick={() => onRetry(index)}
                    >
                      <RotateCcw />
                    </button>
                    <button
                      type="button"
                      className="message-action-btn"
                      title={copiedMessageId === message.id ? botCopy("Copied!", "已複製！") : botCopy("Copy content", "複製內容")}
                      aria-label={botCopy("Copy content", "複製內容")}
                      onClick={() => onCopyMessage(message.id, message.text)}
                    >
                      {copiedMessageId === message.id ? <Check className="action-copied-icon" /> : <Copy />}
                    </button>
                  </div>
                )}
                {message.createdAt && (
                  <span className="message-time-label">
                    {formatMessageTime(message.createdAt)}
                  </span>
                )}
              </div>
            </div>
            )}
          </div>
        )
      })}
      {isAgentBusy && (
        <div className="agent-inprogress-row" key="agent-inprogress" aria-live="polite">
          <div className="agent-inprogress-avatar-wrap">
            <AppMark profile={activeBot} small animated={true} state={agentState === "orbit" ? "orbit" : "thinking"} />
          </div>
          <div className="agent-inprogress-info">
            <span className="agent-inprogress-label">
              {runningActivity ? `${runningActivity.title}…` : botCopy("Thinking…", "思考中…")}
            </span>
          </div>
        </div>
      )}
      {messages.length === 1 && serviceNowCapability && (
        <button
          className="starter-prompt"
          type="button"
          onClick={() => onStarterPromptClick("幫我查看 ServiceNow Case CS001284 的狀態與最近更新")}
        >
          <span><Database /></span>
          <span>
            <strong>{botCopy("View a ServiceNow case", "查看一筆 ServiceNow Case")}</strong>
            <small>{botCopy("Read its status and latest updates without changing data", "讀取狀態與最近更新，不會修改資料")}</small>
          </span>
          <ChevronRight />
        </button>
      )}
      {codexLogin && modelRouteRequiresCodexLogin(activeBot.modelRoute) && (
        <InteractionCard
          tone="login"
          testId="codex-login-card"
          extraClassName="codex-connector"
          icon={<KeyRound size={18} />}
          title={modelRoutePresentation(activeBot.modelRoute).cardTitle}
          subtitle={
            <>
              {modelRoutePresentation(activeBot.modelRoute).loginInstruction}{" "}
              <code>{codexLogin.userCode}</code>
              ，完成後這裡會自動繼續
            </>
          }
          actions={(
            <a href={codexLogin.verificationUrl} target="_blank" rel="noreferrer" className="primary-button">
              {modelRoutePresentation(activeBot.modelRoute).loginAction}
            </a>
          )}
        />
      )}
      {showScrollBottom && (
        <div className="scroll-bottom-container">
          <button
            type="button"
            className="scroll-bottom-button"
            onClick={onScrollToBottom}
            aria-label={botCopy("Scroll to latest message", "捲動至最新訊息")}
            title={botCopy("Scroll to latest message", "捲動至最新訊息")}
          >
            <ChevronDown />
            <span>{botCopy("Back to latest", "回到底部")}</span>
          </button>
        </div>
      )}
    </div>
    {openThread && (
      <div className="profile-dialog-backdrop" role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpenHandoffId(null)
      }}>
        <section className="profile-dialog handoff-thread-dialog" role="dialog" aria-modal="true" aria-label="Bot 交接內容">
          <header>
            <span>
              <strong>兩個 Bot 實際傳送的指令</strong>
              <small>{openThread.fromName} → {openThread.toName}</small>
            </span>
            <button type="button" className="icon-button" onClick={() => setOpenHandoffId(null)} aria-label="關閉">
              <X />
            </button>
          </header>
          <div className="handoff-thread-body">
            {navigationError && <p role="alert">{navigationError}</p>}
            {openThread.sourceMessageId && onNavigateMessage && <button type="button" className="secondary-button" onClick={() => {
              void onNavigateMessage(openThread.fromBotId, openThread.sourceMessageId!).then((opened) => { if (opened) setOpenHandoffId(null) })
            }}>查看來源訊息</button>}
            {onNavigateMessage && openHandoffId && <button type="button" className="secondary-button" onClick={() => {
              void onNavigateMessage(openThread.toBotId, `handoff:${openHandoffId}`).then((opened) => { if (opened) setOpenHandoffId(null) })
            }}>查看接收 Bot 的記錄</button>}
            <div className="handoff-thread-turn">
              <strong>{openThread.fromName} 送給 {openThread.toName}</strong>
              <p>{openThread.outbound || "（無內容）"}</p>
            </div>
            <div className="handoff-thread-turn">
              {openThread.kind === "fyi" ? <p>{openMessage?.handoffEventType === "handoff.read" ? "FYI 已讀取，無需回覆。" : "FYI 會在對方空閒時讀取，可不回覆。"}</p> : <>
                <strong>{openThread.toName} 送回 {openThread.fromName}</strong>
                <p>{openThread.inbound || "對方還沒回傳。"}</p>
              </>}
            </div>
          </div>
        </section>
      </div>
    )}
    </>
  )
}
