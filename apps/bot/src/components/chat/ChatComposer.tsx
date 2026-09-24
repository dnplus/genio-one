import { VoiceInput } from "./VoiceInput"
import { useEffect, useMemo, useRef, useState, type RefObject } from "react"
import {
  Bot,
  ChevronDown,
  CircleStop,
  Compass,
  FileText,
  Headphones,
  HelpCircle,
  MessageSquare,
  Monitor,
  Plug,
  RefreshCw,
  Send,
  Sparkles,
  Terminal,
} from "lucide-react"

import { BloubAvatar } from "../../avatar/bloub-avatar"
import { ImagePicker, type DraftImage } from "./ImagePicker"
import type { BotMentionSpan } from "./composer-mentions"
import type { ChatMessage } from "../../bots-storage"
import type { CodexModel } from "../../lib/codex-client"
import type { GenioCatalog } from "../../lib/genio-one"
import { companyModelGroups } from "../../lib/catalog-surface"
import { COMPANY_MODEL_UNAVAILABLE_MESSAGE, isModelRouteFailure, type ModelRoute } from "../../lib/model-route"
import { botCopy } from "../../lib/ui-copy"
import { ApprovalCard, type ApprovalRequest } from "./ApprovalCard"
import { UserInputQuestionCard, type UserInputQuestionRequest } from "./UserInputQuestionCard"
import { InstallElicitationCard, type InstallElicitationRequest } from "./InstallElicitationCard"
import { LoginWallCard } from "../modals/LoginWallCard"
import type { LoginWallView } from "./hands-ui"
import {
  mentionToken,
  splitMentionSegments,
  type MentionItem,
} from "./composer-mentions"

export type { MentionItem }

export interface SlashCommandItem {
  id: string
  command: string
  label: string
  description: string
  badge: string
  action: "insert" | "clear" | "compact" | "desktop" | "headless" | "skills" | "help" | "request_help"
}

export const SLASH_COMMANDS: SlashCommandItem[] = [
  {
    id: "plan",
    command: "/plan",
    label: "規劃模式",
    description: "針對複雜任務產出詳細實施計畫與檢查點，不直接寫入變更",
    badge: "Plan",
    action: "insert",
  },
  {
    id: "review",
    command: "/review",
    label: "代碼與變更審查",
    description: "審查目前受控工作區的代碼變更、Git Diff 或 ServiceNow 工單歷程",
    badge: "Review",
    action: "insert",
  },
  {
    id: "skills",
    command: "/skills",
    label: "技能清單",
    description: "檢視當前助手載入的所有技能 (Skills) 與企業 MCP 授權工具",
    badge: "Skills",
    action: "skills",
  },
  {
    id: "compact",
    command: "/compact",
    label: "壓縮對話上下文",
    description: "縮減此對話累積的 Token 空間以提升後續回應速度",
    badge: "Optimize",
    action: "compact",
  },
  {
    id: "desktop",
    command: "/desktop",
    label: "受控電腦桌面",
    description: "展開右側工作面板切換至受控電腦 (Managed Desktop)",
    badge: "Desktop",
    action: "desktop",
  },
  {
    id: "request-help",
    command: "/request-help",
    label: "登入牆／人類接管",
    description: "請在共用電腦完成登入；不會收集密碼進聊天",
    badge: "Login",
    action: "request_help",
  },
  {
    id: "headless",
    command: "/headless",
    label: "啟用 Headless 工作區",
    description: "啟動無畫面的遠端執行環境，供檔案、指令與產物工作使用",
    badge: "Headless",
    action: "headless",
  },
  {
    id: "help",
    command: "/help",
    label: "操作說明與指引",
    description: "檢視歷史回溯 (↑/↓)、斜線指令與提及標籤說明",
    badge: "Help",
    action: "help",
  },
]

function ComposerMentionChip({ item }: { item: MentionItem }) {
  return (
    <span
      className={`composer-mention composer-mention--${item.kind}`}
      contentEditable={false}
      data-mention-token={mentionToken(item)}
      data-mention-kind={item.kind}
      data-mention-id={item.id}
      data-mention-name={item.name}
    >
      {item.kind === "bot" ? (
        item.avatar ? (
          <span className="composer-mention-avatar">
            <BloubAvatar value={item.avatar} label={item.name} animated={false} />
          </span>
        ) : (
          <span className="composer-mention-avatar"><Bot size={12} /></span>
        )
      ) : null}
      <span className="composer-mention-name">{item.kind === "bot" ? item.name : `@${item.id}`}</span>
    </span>
  )
}

function renderMentionIcon(mention: MentionItem) {
  if (mention.kind === "bot") {
    if (mention.avatar) {
      return (
        <div className="autocomplete-bot-avatar">
          <BloubAvatar value={mention.avatar} label={mention.name} animated={false} />
        </div>
      )
    }
    return (
      <div className="autocomplete-item-icon kind-bot">
        <Bot />
      </div>
    )
  }

  if (mention.kind === "skill") {
    return (
      <div className="autocomplete-item-icon kind-skill">
        <Sparkles />
      </div>
    )
  }

  if (mention.kind === "tool") {
    return (
      <div className="autocomplete-item-icon kind-plugin">
        <Plug />
      </div>
    )
  }

  return (
    <div className="autocomplete-item-icon kind-resource">
      <Monitor />
    </div>
  )
}

export function runtimeErrorPresentation(input: {
  runtimeError?: string
  runtimeErrorTitle?: string
  runtimeErrorDetail?: string
  models?: readonly CodexModel[]
  messages: readonly ChatMessage[]
  modelRoute: ModelRoute
}) {
  const interrupted = input.runtimeError === "執行中止"
  const noHealthyConnection = Boolean(input.runtimeError && /NO_HEALTHY_CONNECTION/i.test(input.runtimeError))
  let lastUserIndex = -1
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    if (input.messages[index]?.role === "user") {
      lastUserIndex = index
      break
    }
  }
  const hasPreservedPartialOutput = lastUserIndex >= 0 && input.messages.slice(lastUserIndex + 1).some((message) => message.role === "assistant" && !message.localOnly && !message.id.startsWith("interrupted-") && message.text.trim().length > 0)
  const companyModelUnavailable = !interrupted && input.modelRoute === "genio-gateway" && ((input.models?.length ?? 0) === 0 || (input.runtimeError ? isModelRouteFailure(input.runtimeError) || /model\.invoke|POLICY_SCOPE_NOT_ALLOWED/i.test(input.runtimeError) : false))
  return {
    title: input.runtimeErrorTitle || (interrupted
      ? botCopy("Reply stopped", "這次回覆已停止")
      : noHealthyConnection
        ? botCopy("Company model connection is not ready", "公司模型連線尚未就緒")
      : companyModelUnavailable
        ? botCopy("Company model unavailable", "公司模型目前不可用")
        : botCopy("Bot could not start", "Bot 無法啟動")),
    detail: input.runtimeErrorDetail || (interrupted
      ? hasPreservedPartialOutput
        ? botCopy("This reply was stopped; partial output is preserved. Reconnect and try again to generate a new reply.", "這次回覆已停止，部分輸出已保留。按「重新連線」後可重新生成。")
        : botCopy("This reply was stopped before visible output was produced. Reconnect and try again to generate a new reply.", "這次回覆已停止，尚未產生可顯示的回覆內容。按「重新連線」後可重新生成。")
      : noHealthyConnection
        ? botCopy("An administrator must verify the model Connection and republish the Resource. After the publication and Gateway Runtime are READY, reconnect and try again.", "請由管理員先驗證模型 Connection 並重新發佈 Resource；確認 Gateway Runtime READY 後，按「重新連線」再試。")
      : companyModelUnavailable
        ? botCopy("No company model is currently exposed to this Bot. Ask an administrator to restore the Runtime Policy access, then reconnect.", "目前沒有符合此 Bot Runtime Policy 曝光條件的公司模型。請聯絡管理員恢復群組或模型曝光授權後，按「重新連線」再試。")
        : input.runtimeError ?? ""),
    showTechnicalDetail: !interrupted && !noHealthyConnection,
  }
}

export function ChatComposer({
  voiceToken = "",
  input,
  setInput,
  textareaRef,
  isInputDisabled,
  isSendDisabled = false,
  isRunning,
  activeBotName,
  hasCodexLogin,
  runtimeError,
  runtimeErrorTitle,
  runtimeErrorDetail,
  onReconnect,
  messages,
  threadReady,
  channelReady = false,
  approval,
  onDecideApproval,
  userInputRequest = null,
  onAnswerUserInput,
  onDismissUserInput,
  elicitationRequest = null,
  onAcceptElicitation,
  onDeclineElicitation,
  loginWall = null,
  onLoginWallTakeover,
  onLoginWallCompleted,
  onLoginWallDismiss,
  models,
  selectedModel,
  onSelectModel,
  catalog = null,
  modelRoute = "codex-subscription",
  inputHistory,
  onSendMessage,
  onRefreshPending,
  images = [],
  imagesDisabled = false,
  onImagesChange,
  onInterrupt,
  allMentionItems,
  botMentions = [],
  onSelectBotMention,
  onExecuteSlashAction,
  isVoiceAvailable = false,
  onOpenVoiceCall,
  demo = false,
}: {
  voiceToken?: string
  isVoiceAvailable?: boolean
  onOpenVoiceCall?: () => void
  demo?: boolean
  input: string
  setInput: (value: string | ((prev: string) => string)) => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
  isInputDisabled: boolean
  isSendDisabled?: boolean
  isRunning: boolean
  activeBotName: string
  hasCodexLogin: boolean
  runtimeError?: string
  runtimeErrorTitle?: string
  runtimeErrorDetail?: string
  onReconnect?: () => void
  messages: readonly ChatMessage[]
  threadReady: boolean
  channelReady?: boolean
  approval: ApprovalRequest | null
  onDecideApproval: (decision: "accept" | "decline") => void
  userInputRequest?: UserInputQuestionRequest | null
  onAnswerUserInput?: (answers: Record<string, string[]>) => void
  onDismissUserInput?: () => void
  elicitationRequest?: InstallElicitationRequest | null
  onAcceptElicitation?: (content: Record<string, any>) => void
  onDeclineElicitation?: () => void
  loginWall?: LoginWallView | null
  onLoginWallTakeover?: () => void
  onLoginWallCompleted?: () => void
  onLoginWallDismiss?: () => void
  models: CodexModel[]
  selectedModel: string
  onSelectModel: (model: string) => void
  catalog?: GenioCatalog | null
  modelRoute?: ModelRoute
  inputHistory: string[]
  onSendMessage: (text?: string) => void
  onRefreshPending?: () => void
  images?: DraftImage[]
  imagesDisabled?: boolean
  onImagesChange?: (images: DraftImage[]) => void
  onInterrupt: () => void
  allMentionItems: MentionItem[]
  botMentions?: BotMentionSpan[]
  onSelectBotMention?: (text: string, mention: BotMentionSpan) => void
  onExecuteSlashAction: (action: SlashCommandItem["action"], command: SlashCommandItem) => void
}) {
  const [speechBusy, setSpeechBusy] = useState(false)
  const [cursorPos, setCursorPos] = useState<number>(0)
  const [readingImages, setReadingImages] = useState(false)
  const [menuSelectedIndex, setMenuSelectedIndex] = useState<number>(0)
  const [menuDismissed, setMenuDismissed] = useState<boolean>(false)
  const historyIndexRef = useRef<number>(-1)
  const draftInputRef = useRef<string>("")
  const mentionChips = useMemo(
    () => splitMentionSegments(input, allMentionItems, botMentions).filter((segment) => segment.type === "mention" && segment.item.kind === "bot"),
    [input, allMentionItems, botMentions],
  )

  useEffect(() => {
    historyIndexRef.current = -1
    draftInputRef.current = ""
  }, [activeBotName])

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
      textareaRef.current.style.height = `${Math.max(28, Math.min(textareaRef.current.scrollHeight, 160))}px`
    }
  }, [input, textareaRef])

  const autocompleteState = (() => {
    if (menuDismissed || !input) return null
    const textBefore = input.slice(0, cursorPos)

    if (textBefore.startsWith("/") && !textBefore.includes(" ")) {
      const query = textBefore.slice(1).toLowerCase()
      const matches = SLASH_COMMANDS.filter((cmd) =>
        cmd.command.slice(1).toLowerCase().startsWith(query) ||
        cmd.label.toLowerCase().includes(query) ||
        cmd.description.toLowerCase().includes(query)
      )
      if (matches.length > 0) {
        return {
          type: "slash" as const,
          query,
          items: matches,
          startIndex: 0,
          endIndex: textBefore.length,
        }
      }
    }

    const lastAtIndex = textBefore.lastIndexOf("@")
    if (lastAtIndex !== -1) {
      const charBeforeAt = lastAtIndex > 0 ? textBefore[lastAtIndex - 1] : " "
      if (charBeforeAt === " " || charBeforeAt === "\n" || lastAtIndex === 0) {
        const query = textBefore.slice(lastAtIndex + 1).toLowerCase()
        if (!query.includes(" ") && !query.includes("\n")) {
          const matches = allMentionItems.filter((item) =>
            item.id.toLowerCase().includes(query) ||
            item.name.toLowerCase().includes(query) ||
            item.description.toLowerCase().includes(query)
          )
          if (matches.length > 0) {
            return {
              type: "mention" as const,
              query,
              items: matches,
              startIndex: lastAtIndex,
              endIndex: textBefore.length,
            }
          }
        }
      }
    }

    return null
  })()

  const applyAutocompleteItem = (item: SlashCommandItem | MentionItem) => {
    if (!autocompleteState) return

    if (autocompleteState.type === "slash") {
      const cmd = item as SlashCommandItem
      if (cmd.action === "insert") {
        const textAfter = input.slice(autocompleteState.endIndex)
        const template = cmd.id === "plan" ? "/plan 針對任務制定明確的分階段實施步驟：" : "/review 請審查此變更並列出檢查清單："
        const nextInput = `${template} ${textAfter}`
        setInput(nextInput)
        setMenuDismissed(true)
        setTimeout(() => {
          if (textareaRef.current) {
            textareaRef.current.focus()
            textareaRef.current.setSelectionRange(nextInput.length, nextInput.length)
          }
        }, 0)
      } else {
        setMenuDismissed(true)
        onExecuteSlashAction(cmd.action, cmd)
      }
      return
    }

    const mention = item as MentionItem
    const before = input.slice(0, autocompleteState.startIndex)
    const after = input.slice(autocompleteState.endIndex)
    const insertText = mention.kind === "bot" ? `@${mention.name} ` : `@${mention.id} `
    const nextInput = `${before}${insertText}${after}`
    if (mention.kind === "bot" && onSelectBotMention) onSelectBotMention(nextInput, { botId: mention.botId || mention.id, start: before.length, end: before.length + insertText.trimEnd().length, token: insertText.trimEnd() })
    else setInput(nextInput)
    setMenuDismissed(true)
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus()
        const newPos = before.length + insertText.length
        textareaRef.current.setSelectionRange(newPos, newPos)
        setCursorPos(newPos)
      }
    }, 0)
  }

  const companyModels = useMemo(() => companyModelGroups(catalog?.capabilities ?? []), [catalog])
  const companySelectable = modelRoute === "genio-gateway"
  const runtimeErrorView = useMemo(() => runtimeErrorPresentation({ runtimeError, runtimeErrorTitle, runtimeErrorDetail, models, messages, modelRoute }), [messages, modelRoute, models, runtimeError, runtimeErrorDetail, runtimeErrorTitle])
  const pickerModels = models.length
    ? models
    : modelRoute === "genio-gateway"
      ? []
      : selectedModel
      ? [{ id: selectedModel, displayName: selectedModel, description: "", supportedReasoningEfforts: [] }]
      : []

  return (
    <div className="composer-wrap">
      {(approval || userInputRequest || elicitationRequest) && onRefreshPending && <button type="button" className="secondary-button" onClick={onRefreshPending}>{botCopy("Reload pending items", "重新載入待處理事項")}</button>}
      {runtimeError && <div className="runtime-error-card" role="alert">
        <div>
          <strong>{runtimeErrorView.title}</strong>
          <p>{runtimeErrorView.detail}</p>
          {runtimeErrorView.showTechnicalDetail && runtimeErrorDetail !== runtimeError && <code>{runtimeError}</code>}
        </div>
        {onReconnect && <button type="button" className="secondary-button" onClick={onReconnect}>{botCopy("Reconnect", "重新連線")}</button>}
      </div>}
      {approval && <ApprovalCard approval={approval} onDecide={onDecideApproval} />}
      {userInputRequest && onAnswerUserInput && onDismissUserInput && (
        <UserInputQuestionCard
          key={`${userInputRequest.threadId}:${userInputRequest.id}`}
          request={userInputRequest}
          onAnswer={onAnswerUserInput}
          onDismiss={onDismissUserInput}
        />
      )}
      {elicitationRequest && onAcceptElicitation && onDeclineElicitation && (
        <InstallElicitationCard
          request={elicitationRequest}
          onAccept={onAcceptElicitation}
          onDecline={onDeclineElicitation}
        />
      )}
      {loginWall && onLoginWallTakeover && onLoginWallCompleted && onLoginWallDismiss && (
        <LoginWallCard
          wall={loginWall}
          onTakeover={onLoginWallTakeover}
          onCompleted={onLoginWallCompleted}
          onDismiss={onLoginWallDismiss}
        />
      )}
      <div className="composer-stack">
      {autocompleteState && autocompleteState.items.length > 0 && (
        <div className="composer-autocomplete-menu" role="listbox">
          <div className="autocomplete-header">
            {autocompleteState.type === "slash" ? botCopy("Commands", "快捷指令") : botCopy("Mention Bots, skills, and resources", "提及 Bot、技能與資源")}
          </div>
          <div className="autocomplete-list">
            {autocompleteState.items.map((item, idx) => {
              const isSelected = idx === menuSelectedIndex
              if (autocompleteState.type === "slash") {
                const cmd = item as SlashCommandItem
                return (
                  <button
                    type="button"
                    key={cmd.id}
                    className={`autocomplete-item ${isSelected ? "selected" : ""}`}
                    onClick={() => applyAutocompleteItem(cmd)}
                    onMouseEnter={() => setMenuSelectedIndex(idx)}
                  >
                    <div className="autocomplete-item-icon kind-command">
                      {cmd.id === "plan" ? (
                        <Compass />
                      ) : cmd.id === "review" ? (
                        <FileText />
                      ) : cmd.id === "skills" ? (
                        <Sparkles />
                      ) : cmd.id === "compact" ? (
                        <RefreshCw />
                      ) : cmd.id === "clear" ? (
                        <MessageSquare />
                      ) : cmd.id === "desktop" ? (
                        <Monitor />
                      ) : cmd.id === "headless" ? (
                        <Terminal />
                      ) : (
                        <HelpCircle />
                      )}
                    </div>
                    <div className="autocomplete-item-content">
                      <div className="autocomplete-item-title-row">
                        <span className="autocomplete-item-title">{cmd.command} · {cmd.label}</span>
                        <span className="autocomplete-item-badge command">{botCopy("Command", "指令")}</span>
                      </div>
                      <span className="autocomplete-item-desc">{cmd.description}</span>
                    </div>
                  </button>
                )
              }
              const mention = item as MentionItem
              return (
                <button
                  type="button"
                  key={mention.id}
                  className={`autocomplete-item ${isSelected ? "selected" : ""}`}
                  onClick={() => applyAutocompleteItem(mention)}
                  onMouseEnter={() => setMenuSelectedIndex(idx)}
                >
                  {renderMentionIcon(mention)}
                  <div className="autocomplete-item-content">
                    <div className="autocomplete-item-title-row">
                      {mention.kind === "bot" ? (
                        <>
                          <span className="autocomplete-item-title">@{mention.name}</span>
                          <span className="autocomplete-item-badge bot">Bot</span>
                        </>
                      ) : (
                        <>
                          <span className="autocomplete-item-title" title={mention.name && mention.name !== mention.id ? `@${mention.id}（${mention.name}）` : `@${mention.id}`}>
                            @{mention.id}{mention.name && mention.name !== mention.id ? `（${mention.name}）` : ""}
                          </span>
                          {mention.kind === "skill" && (
                            <span className={`autocomplete-item-badge ${mention.enabled ? "active" : "skill"}`}>
                              {mention.enabled ? botCopy("Skill · loaded", "技能 · 已載入") : botCopy("Skill", "技能")}
                            </span>
                          )}
                          {mention.kind === "tool" && (
                            <span className="autocomplete-item-badge plugin">{botCopy("Tool", "插件")}</span>
                          )}
                          {mention.kind === "resource" && (
                            <span className="autocomplete-item-badge resource">{botCopy("Resource", "資源")}</span>
                          )}
                        </>
                      )}
                    </div>
                    <span className="autocomplete-item-desc">{mention.description}</span>
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      )}
      <div className="composer">
        {mentionChips.length > 0 && (
          <div className="composer-mention-row">
            {mentionChips.map((segment, index) => (
              segment.type === "mention" ? (
                <ComposerMentionChip key={`${segment.token}-${index}`} item={segment.item} />
              ) : null
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          rows={1}
          value={input}
          disabled={isInputDisabled}
          onChange={(event) => {
            const nextVal = event.target.value
            setInput(nextVal)
            setCursorPos(event.target.selectionStart ?? nextVal.length)
            setMenuDismissed(false)
            if (historyIndexRef.current !== -1) {
              historyIndexRef.current = -1
            }
          }}
          onSelect={(event) => {
            const target = event.target as HTMLTextAreaElement
            setCursorPos(target.selectionStart ?? 0)
          }}
          onClick={(event) => {
            const target = event.target as HTMLTextAreaElement
            setCursorPos(target.selectionStart ?? 0)
          }}
          onKeyUp={(event) => {
            if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
              const target = event.target as HTMLTextAreaElement
              setCursorPos(target.selectionStart ?? 0)
            }
          }}
          onKeyDown={(event) => {
            if (autocompleteState && autocompleteState.items.length > 0) {
              if (event.key === "ArrowDown") {
                event.preventDefault()
                setMenuSelectedIndex((prev) => (prev + 1) % autocompleteState.items.length)
                return
              }
              if (event.key === "ArrowUp") {
                event.preventDefault()
                setMenuSelectedIndex((prev) => (prev - 1 + autocompleteState.items.length) % autocompleteState.items.length)
                return
              }
              if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault()
                const selected = autocompleteState.items[menuSelectedIndex]
                if (selected) {
                  applyAutocompleteItem(selected)
                }
                return
              }
              if (event.key === "Escape") {
                event.preventDefault()
                setMenuDismissed(true)
                return
              }
            }

            if (event.key === "ArrowUp") {
              const el = textareaRef.current
              const isAtStart = el ? el.selectionStart === 0 && el.selectionEnd === 0 : true
              const isSingleLine = !input.includes("\n")
              if ((isAtStart || isSingleLine) && inputHistory.length > 0) {
                event.preventDefault()
                let nextIdx = historyIndexRef.current
                if (nextIdx === -1) {
                  draftInputRef.current = input
                  nextIdx = inputHistory.length - 1
                } else if (nextIdx > 0) {
                  nextIdx -= 1
                }
                historyIndexRef.current = nextIdx
                const val = inputHistory[nextIdx] ?? ""
                setInput(val)
                setCursorPos(val.length)
                requestAnimationFrame(() => {
                  if (textareaRef.current) {
                    textareaRef.current.selectionStart = val.length
                    textareaRef.current.selectionEnd = val.length
                  }
                })
                return
              }
            }

            if (event.key === "ArrowDown" && historyIndexRef.current !== -1) {
              const el = textareaRef.current
              const isAtEnd = el ? el.selectionStart === input.length : true
              const isSingleLine = !input.includes("\n")
              if (isAtEnd || isSingleLine) {
                event.preventDefault()
                const nextIdx = historyIndexRef.current + 1
                if (nextIdx >= inputHistory.length) {
                  historyIndexRef.current = -1
                  const val = draftInputRef.current
                  setInput(val)
                  setCursorPos(val.length)
                } else {
                  historyIndexRef.current = nextIdx
                  const val = inputHistory[nextIdx] ?? ""
                  setInput(val)
                  setCursorPos(val.length)
                }
                requestAnimationFrame(() => {
                  if (textareaRef.current) {
                    textareaRef.current.focus()
                    textareaRef.current.selectionStart = input.length
                    textareaRef.current.selectionEnd = input.length
                  }
                })
                return
              }
            }

            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault()
              if (isRunning || isSendDisabled || speechBusy || readingImages || imagesDisabled) return
              onSendMessage()
            }
          }}
          placeholder={
            runtimeError
              ? runtimeErrorView.detail
              : modelRoute === "genio-gateway" && models.length === 0
              ? botCopy("No company model is available for this route yet.", COMPANY_MODEL_UNAVAILABLE_MESSAGE)
              : hasCodexLogin
              ? botCopy("Select the sign-in card above to connect your model provider…", "請先點擊上方卡片完成模型提供者登入…")
              : !threadReady
                ? channelReady
                  ? botCopy("Loading this Bot…", "正在載入這個 Bot…")
                  : botCopy("Starting the conversation session…", "正在建立對話工作階段…")
                : isRunning
                  ? botCopy(`${activeBotName} is replying… (you can draft the next message)`, `${activeBotName} 回覆中… (可先預先輸入下一則訊息)`)
                  : botCopy(`Message ${activeBotName}… (use / commands, @ mentions, or ↑ history)`, `傳訊息給 ${activeBotName}… (輸入 / 指令、@ 提及、↑ 歷史)`)
          }
        />
        <div className="composer-footer">
          <div className="composer-footer-left">
            {onImagesChange && <ImagePicker images={images} onChange={onImagesChange} onReadingChange={setReadingImages} disabled={isInputDisabled || imagesDisabled} />}
            <div className="composer-model-picker" title={companySelectable ? botCopy("Select model", "選擇模型") : botCopy("This Bot currently uses Codex; switch routes to select a company model", "這個 Bot 目前走 Codex；公司模型要改路線後才能選")}>
              <Sparkles className="model-picker-icon" />
              <select
                value={selectedModel}
                onChange={(event) => {
                  const next = event.target.value
                  if (next.startsWith("company:") && !companySelectable) return
                  onSelectModel(next)
                }}
                disabled={(modelRoute === "genio-gateway" && models.length === 0) || (pickerModels.length === 0 && companyModels.length === 0)}
              >
                <optgroup label={modelRoute === "genio-gateway" ? botCopy("Company models (current route)", "公司模型（目前路線）") : botCopy("My Codex", "我的 Codex")}>
                  {pickerModels.map((model) => (
                    <option key={model.id} value={model.id}>{model.displayName}</option>
                  ))}
                </optgroup>
                {companyModels.length > 0 && modelRoute !== "genio-gateway" ? (
                  <optgroup label={botCopy("Company models (switch to company route)", "公司模型（需改用公司路線）")}>
                    {companyModels.map((group) => (
                      <option key={group.resourceId} value={`company:${group.resourceId}`} disabled>
                        {group.title}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </select>
              <ChevronDown className="model-picker-chevron" />
            </div>
          </div>
          <div className="composer-footer-actions">
            <VoiceInput
              token={voiceToken}
              disabled={isInputDisabled}
              onBusyChange={setSpeechBusy}
              demo={demo}
              onTranscript={(text) => {
                setInput((current) => current ? `${current}${/\s$/.test(current) ? "" : " "}${text}` : text)
                textareaRef.current?.focus()
              }}
            />
            <button
              type="button"
              className="voice-call-trigger-button"
              disabled={isInputDisabled || (!isVoiceAvailable && !hasCodexLogin)}
              onClick={() => {
                if (isVoiceAvailable) {
                  onOpenVoiceCall?.()
                }
              }}
              aria-label={botCopy("Realtime voice conversation", "即時語音對話 (Realtime Voice)")}
              title={isVoiceAvailable ? botCopy("Open realtime voice conversation", "開啟即時語音對話 (Realtime Voice)") : botCopy("Sign in to Codex / ChatGPT subscription to use realtime voice", "需登入 Codex / ChatGPT 訂閱以使用即時語音對話")}
            >
              <Headphones size={18} />
            </button>
            <button
              type="button"
              className="send-button"
              disabled={isInputDisabled || isSendDisabled || speechBusy || (!isRunning && (readingImages || imagesDisabled || (!input.trim() && !images.length)))}
              onClick={() => isRunning ? onInterrupt() : onSendMessage()}
              aria-label={isRunning ? botCopy("Stop", "停止") : botCopy("Send", "送出")}
              title={isRunning ? botCopy("Stop running", "停止執行") : botCopy("Send (Enter)", "送出 (Enter)")}
            >
              {isRunning ? <CircleStop /> : <Send />}
            </button>
          </div>
        </div>
      </div>
      </div>
    </div>
  )
}
