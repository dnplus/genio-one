import { runtimeBlockFromMessage } from "./bot-runtime-status"
import { useVisibleTimelineRead } from "./useVisibleTimelineRead"
import { splitMentionSegments } from "./composer-mentions"
import type { BotSidebarSummary } from "../../../shared/bot-roster"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  AVAILABLE_SKILLS,
  readBotMessages,
  readBotThreads,
  readInputHistory,
  readMessageFeedbacks,
  readSavedModel,
  saveBotMessages,
  saveInputHistory,
  saveMessageFeedbacks,
  saveSavedModel,
  type BotInstance,
  type ChatMessage,
} from "../../bots-storage"
import { runtimeCanExec } from "../../lib/codex-client"
import { isMcpToolCapability, isUsableEnterpriseCapability, type GenioCatalog, type GenioIdentity } from "../../lib/genio-one"
import {
  actOnBotQuestion,
  createBotGroup,
  importBotArtifact,
  listBotArtifacts,
  listBotGroups,
  getBotTimelineSnapshot,
  updateBotGroupMembers,
  type ArtifactRef,
  type BotGroupDto,
} from "../../lib/bot-api"
import type { StateId } from "../../vendor/bloub/bot/states"

import { Sidebar } from "../sidebar"
import { RightPanel, type RightPanelTab } from "../panel"
import {
  USER_SCOPED_COMPUTER_COPY,
  composerShouldBlockPassword,
  loginWallToChatMessage,
  type HandsComputerView,
  type LoginWallView,
} from "./hands-ui"
import { ChatMessageList } from "./ChatMessageList"
import { useImageDrafts } from "./image-drafts"
import { ChatComposer, type MentionItem, type SlashCommandItem } from "./ChatComposer"
import { useCodexSession } from "./useCodexSession"
import { modelRouteRequiresCodexLogin } from "../../lib/model-route"
import { botViewKey, captureReadingPosition, restoreReadingPosition, useBotViewState } from "./bot-view-state"
import { reconcileTimeline } from "./timeline-reconciliation"
import { WorkspaceHeader, getToolStatus } from "./WorkspaceHeader"
import { WorkspaceModals } from "./WorkspaceModals"
import { CreateGroupModal } from "../modals/CreateGroupModal"
import { useBotInvocations } from "./useBotInvocations"
import { extractMentionedBotIds, fanOutBlockedMessage } from "./handoff-ui"
import { RealtimeVoiceModal } from "./RealtimeVoiceModal"
import { botCopy, botDisplayName } from "../../lib/ui-copy"

export function requiresHeadlessRuntime(text: string) {
  const ownerTool = /\b(?:read_self|update_self|create_bot|list_owned_skills|read_owned_skill|write_owned_skill|revert_owned_skill|delete_owned_skill|list_schedules|list_schedule_runs|create_schedule|update_schedule|delete_schedule|list_bots|send_to_bot)\b/i
  const englishWord = (words: string) => String.raw`(?<![A-Za-z0-9_-])(?:${words})(?![A-Za-z0-9_-])`
  const englishTarget = (words: string) => String.raw`(?<![A-Za-z0-9_])(?:[A-Za-z][A-Za-z0-9_]*-)*(?:${words})(?![A-Za-z0-9_-])`
  const workspaceAction = new RegExp(String.raw`(?:讀取|列出|修改|寫入|建立|刪除|使用|${englishWord("read|list|modify|write|create|delete|use")})\s*[^。！？\n]{0,48}(?:工作區|${englishTarget("workspace")})`, "i")
  const executionAction = new RegExp(String.raw`(?:執行|運行|${englishWord("run|execute")})\s*[^。！？\n]{0,48}(?:指令|命令|${englishTarget("command|terminal|shell|script")})`, "i")
  const artifactAction = new RegExp(String.raw`(?:建立|產生|輸出|寫入|儲存|${englishWord("create|generate|make|write|save")})\s*[^。！？\n]{0,48}(?:檔案|文件|簡報|${englishTarget("artifact|document|file")}|${englishTarget("presentation")}(?:\.html)?|[A-Za-z0-9_-]+\.html\b)`, "i")
  for (const clause of text.split(/[，,。！？\n；;]/)) {
    if (/^\s*(?:(?:請|please|也|並且|and)\s*)?(?:不要|別|不需|無需|do not|don't)/i.test(clause)) continue
    if (executionAction.test(clause) || workspaceAction.test(clause)) return true
    if (artifactAction.test(clause) && !(ownerTool.test(clause) && /\bSKILL\.md\b/i.test(clause))) return true
  }
  return false
}

export function Workspace({
  bots,
  activeBot,
  onSelectBot,
  onAddBot,
  onUpdateBot,
  onToggleBinding,
  onDuplicateBot,
  onDeleteBot,
  onOpenCorpCatalog,
  token,
  demo,
  catalog,
  identity,
  unreadBotIds,
  workStates,
  summaries,
  onMarkBotUnread,
  onBotWorkEvent,
  onBotViewed,
  onSignOut,
  initialInput,
}: {
  bots: BotInstance[]
  activeBot: BotInstance
  onSelectBot: (botId: string) => void
  onAddBot: () => void
  onUpdateBot: (bot: BotInstance) => void | Promise<void>
  onToggleBinding: (botId: string, resourceId: string, capabilityId: string, currentlyInstalled: boolean) => Promise<void>
  onDuplicateBot?: (bot: BotInstance) => void
  onDeleteBot?: (bot: BotInstance) => void
  onOpenCorpCatalog?: () => void
  token: string
  demo: boolean
  catalog: GenioCatalog | null
  identity: GenioIdentity | null
  summaries?: Record<string, BotSidebarSummary>
  unreadBotIds?: Set<string>
  workStates?: Record<string, "idle" | "working" | "stopped">
  onBotViewed?: (botId: string) => void
  onMarkBotUnread?: (botId: string) => void
  onBotWorkEvent?: (botId: string, type: "turn_started" | "turn_stopped" | "turn_idle") => void
  onSignOut(): void
  initialInput?: { key: string; text: string }
}) {
  const isMountedRef = useRef(true)
  const displayBotName = botDisplayName(activeBot)
  const [messageDestination, setMessageDestination] = useState<{ botId: string; messageId?: string; position?: ReturnType<typeof captureReadingPosition> } | null>(null)
  const [messageOrigin, setMessageOrigin] = useState<{ botId: string; position: ReturnType<typeof captureReadingPosition>; panelOpen: boolean; panelTab: RightPanelTab } | null>(null)
  const [navigationError, setNavigationError] = useState("")
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  const [groups, setGroups] = useState<BotGroupDto[]>([])
  const [groupingBotId, setGroupingBotId] = useState<string | null>(null)
  const [groupCreateBusy, setGroupCreateBusy] = useState(false)
  const [groupCreateError, setGroupCreateError] = useState("")

  const persistDemoGroups = (next: BotGroupDto[]) => {
    if (demo) localStorage.setItem("genio.bot.groups", JSON.stringify(next))
    setGroups(next)
  }

  useEffect(() => {
    if (demo) {
      try {
        const stored = localStorage.getItem("genio.bot.groups")
        if (stored) {
          const parsed = JSON.parse(stored) as BotGroupDto[]
          if (Array.isArray(parsed)) setGroups(parsed)
        }
      } catch {}
      return
    }
    if (!token) return
    void listBotGroups(token).then((next) => {
      if (isMountedRef.current) setGroups(next)
    }).catch((error) => console.warn("List bot groups failed", error))
  }, [demo, token])

  const handleAssignBotToGroup = useCallback(async (botId: string, groupId: string) => {
    const target = groups.find((group) => group.groupId === groupId)
    if (!target || target.memberBotIds.includes(botId)) return
    const nextMembers = [...target.memberBotIds.filter((id) => id !== botId), botId]
    const withoutBot = groups.map((group) => (
      group.groupId === groupId
        ? group
        : { ...group, memberBotIds: group.memberBotIds.filter((id) => id !== botId) }
    ))
    if (demo) {
      persistDemoGroups(withoutBot.map((group) => (
        group.groupId === groupId ? { ...group, memberBotIds: nextMembers, updatedAt: Date.now() } : group
      )))
      return
    }
    try {
      for (const group of withoutBot) {
        if (group.groupId !== groupId && groups.find((g) => g.groupId === group.groupId)?.memberBotIds.includes(botId)) {
          await updateBotGroupMembers(token, group.groupId, group.memberBotIds)
        }
      }
      const updated = await updateBotGroupMembers(token, groupId, nextMembers)
      const listed = await listBotGroups(token)
      setGroups(listed.length ? listed : withoutBot.map((group) => group.groupId === groupId ? updated : group))
    } catch (error) {
      console.warn("Assign bot to group failed", error)
    }
  }, [demo, groups, token])

  const handleCreateGroupForBot = useCallback((botId: string) => {
    setGroupCreateError("")
    setGroupingBotId(botId)
  }, [])

  const handleConfirmCreateGroup = useCallback(async (name: string) => {
    const botId = groupingBotId
    if (!botId) return
    if (demo) {
      const created: BotGroupDto = {
        groupId: `bot-group-${crypto.randomUUID()}`,
        tenantId: "tenant-demo",
        ownerSubjectId: "demo-user",
        name,
        memberBotIds: [botId],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      persistDemoGroups([
        created,
        ...groups.map((group) => ({ ...group, memberBotIds: group.memberBotIds.filter((id) => id !== botId) })),
      ])
      setGroupingBotId(null)
      return
    }
    setGroupCreateBusy(true)
    setGroupCreateError("")
    try {
      await createBotGroup(token, { name, memberBotIds: [botId] })
      setGroups(await listBotGroups(token))
      setGroupingBotId(null)
    } catch (error) {
      setGroupCreateError(error instanceof Error ? error.message : "建立分組失敗")
    } finally {
      setGroupCreateBusy(false)
    }
  }, [demo, groupingBotId, groups, token])

  const handleRemoveBotFromGroup = useCallback(async (botId: string, groupId: string) => {
    const target = groups.find((group) => group.groupId === groupId)
    if (!target) return
    const nextMembers = target.memberBotIds.filter((id) => id !== botId)
    if (demo) {
      persistDemoGroups(groups.map((group) => (
        group.groupId === groupId ? { ...group, memberBotIds: nextMembers, updatedAt: Date.now() } : group
      )).filter((group) => group.memberBotIds.length > 0))
      return
    }
    try {
      if (nextMembers.length === 0) {
        await updateBotGroupMembers(token, groupId, [])
      } else {
        await updateBotGroupMembers(token, groupId, nextMembers)
      }
      setGroups(await listBotGroups(token))
    } catch (error) {
      console.warn("Remove bot from group failed", error)
    }
  }, [demo, groups, token])

  const safeTimeout = useCallback((fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timersRef.current.delete(timer)
      if (isMountedRef.current) fn()
    }, ms)
    timersRef.current.add(timer)
    return timer
  }, [])

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      for (const t of timersRef.current) clearTimeout(t)
      timersRef.current.clear()
    }
  }, [])

  const activeThreadId = `thread-${activeBot.id}-default`
  const [readSnapshot, setReadSnapshot] = useState<{ botId: string; version: string | null } | null>(null)
  const [timelineError, setTimelineError] = useState<{ botId: string; message: string } | null>(null)
  const retryTimelineRef = useRef<(() => Promise<void>) | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    if (!demo) return []
    const initialThread = demo ? (readBotThreads(activeBot.id)[0]?.id || `thread-${activeBot.id}-default`) : `thread-${activeBot.id}-default`
    const saved = readBotMessages(activeBot.id, initialThread)
    if (saved.length > 0) return saved
    return [
      { id: "welcome", role: "assistant", text: botCopy(`Hi, I’m ${displayBotName}. I work in the controlled Managed Desktop (${activeBot.workspacePath}) and use Resources according to your GenioOne permissions.`, `嗨，我是 ${activeBot.name}。我會在受控的 Managed Desktop (${activeBot.workspacePath}) 中工作，並依你的 GenioOne 權限使用 Resource。`), createdAt: Date.now() },
    ]
  })

  const [artifacts, setArtifacts] = useState<ArtifactRef[]>([])
  const viewKey = botViewKey(identity?.tenant_id ?? activeBot.tenantId ?? "demo", identity?.subject_id ?? activeBot.ownerSubjectId ?? "demo", activeBot.id)
  const { state: viewState, update: updateView, setDraft: setInput, selectMention } = useBotViewState(viewKey)
  const input = viewState.draft
  useEffect(() => {
    if (initialInput?.text.trim()) setInput(initialInput.text)
  }, [initialInput?.key])
  const [mentionError, setMentionError] = useState("")
  useEffect(() => setMentionError(""), [input, activeBot.id])
  const viewStateRef = useRef(viewState)
  viewStateRef.current = viewState
  const imageDraft = useImageDrafts(viewKey)
  const draftImages = imageDraft.images
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [inputHistory, setInputHistory] = useState<string[]>(() => readInputHistory(activeBot.id))
  const [rightPanelOpen, setRightPanelOpen] = useState(false)
  const [rightTab, setRightTab] = useState<RightPanelTab>((new URLSearchParams(location.search).get("tab") as RightPanelTab) || "threads")
  const [handsComputer, setHandsComputer] = useState<HandsComputerView | null>(null)
  const [loginWall, setLoginWall] = useState<LoginWallView | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [messageFeedbacks, setMessageFeedbacks] = useState<Record<string, "positive" | "negative">>(() => readMessageFeedbacks())
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const transcriptOwnerRef = useRef({ botId: activeBot.id, threadId: `thread-${activeBot.id}-default` })

  const messagesContainerRef = useRef<HTMLDivElement | null>(null)
  const shouldAutoScrollRef = useRef(true)
  const restoringPositionRef = useRef(true)
  const [showScrollBottom, setShowScrollBottom] = useState(false)
  const sendMessageRef = useRef<(text?: string) => void>(() => {})
  const focusInput = useCallback(() => {
    textareaRef.current?.focus()
  }, [])
  const onPendingExecutionReady = useCallback((task: string) => {
    sendMessageRef.current(task)
  }, [])

  const scrollToBottom = useCallback((smooth = false) => {
    if (!shouldAutoScrollRef.current) return
    const el = messagesContainerRef.current
    if (!el) return
    if (smooth) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
    } else {
      el.scrollTop = el.scrollHeight
    }
  }, [])

  const [isVoiceModalOpen, setIsVoiceModalOpen] = useState(false)

  const {
    clientRef,
    runtime,
    runtimeTiers,
    executionRuntime,
    runtimeState,
    setRuntimeState,
    mcpStatus,
    modelDirectory,
    codexLogin,
    isCodexAuthenticated,
    threadReady,
    channelReady,
    models,
    selectedModel,
    setSelectedModel,
    agentState,
    setAgentState,
    activities,
    setActivities,
    approval,
    userInputRequest,
    answerUserInput,
    dismissUserInput,
    elicitationRequest,
    decideElicitation,
    dynamicSkills,
    isTurnRunning,
    requestRuntimeTier,
    retryGenioMcp,
    refreshPendingInteractions,
    decideApproval,
    interruptRunningTurn,
    executeCompact,
    uploadFeedback,
    startTurn,
    queuePendingExecution,
    pendingExecutionStatus,
  } = useCodexSession({
    activeBot,
    activeThreadId,
    token,
    demo,
    onSignOut,
    onMarkBotUnread,
    onBotWorkEvent,
    setMessages,
    setArtifacts,
    scrollToBottom,
    focusInput,
    onPendingExecutionReady,
  })

  useEffect(() => {
    setInputHistory(readInputHistory(activeBot.id))
  }, [activeBot.id])

  useEffect(() => {
    if (demo || !token) {
      setArtifacts([])
      return
    }
    void listBotArtifacts(token, activeBot.id).then((res) => {
      if (isMountedRef.current) setArtifacts(res)
    }).catch(() => {
      if (isMountedRef.current) setArtifacts([])
    })
  }, [activeBot.id, demo, token])

  const allMentionItems = useMemo<MentionItem[]>(() => {
    const list: MentionItem[] = []

    for (const candidate of bots) {
      if (candidate.id === activeBot.id) continue
      const share = candidate.sharePolicy
      const sameOwner = !candidate.ownerSubjectId || !activeBot.ownerSubjectId || candidate.ownerSubjectId === activeBot.ownerSubjectId
      if (!sameOwner && (!share?.discoverable || !share.invocable)) continue
      list.push({
        id: candidate.id,
        name: candidate.name,
        description: candidate.description ?? candidate.role,
        kind: "bot",
        enabled: true,
        botId: candidate.id,
        ownerSubjectId: candidate.ownerSubjectId,
        avatar: candidate.avatar,
      })
    }

    for (const skill of AVAILABLE_SKILLS) {
      list.push({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        kind: "skill",
        enabled: activeBot.skills.includes(skill.id),
      })
    }

    for (const dynamic of dynamicSkills) {
      if (!list.some((item) => item.id === dynamic.id)) {
        list.push({
          id: dynamic.id,
          name: dynamic.name,
          description: dynamic.description,
          kind: "skill",
          enabled: true,
          path: dynamic.path,
        })
      }
    }

    if (catalog?.capabilities) {
      for (const cap of catalog.capabilities) {
        list.push({
          id: cap.capability_display_name,
          name: `${cap.resource_display_name} · ${cap.capability_display_name}`,
          description: "經 One Policy 驗證授權的企業工具",
          kind: "tool",
          enabled: isUsableEnterpriseCapability(cap),
        })
      }
    }

    list.push({
      id: "desktop",
      name: "受控工作區 (Managed Desktop)",
      description: activeBot.workspacePath || "隔離安全沙盒目錄",
      kind: "resource",
      enabled: Boolean(runtime),
    })

    return list
  }, [bots, catalog, dynamicSkills, activeBot.id, activeBot.skills, activeBot.workspacePath, runtime])

  const {
    botInvocations,
    handleBotInvocationDecision,
    handoffBot,
  } = useBotInvocations({
    activeBotId: activeBot.id,
    token,
    demo,
    isMountedRef,
    setMessages,
    setRuntimeState,
    setAgentState,
    bots,
    onMarkBotUnread,
  })

  const handleFeedback = useCallback(async (messageId: string, classification: "positive" | "negative") => {
    const currentVal = messageFeedbacks[messageId]
    const nextVal = currentVal === classification ? undefined : classification
    setMessageFeedbacks((prev) => {
      const next = { ...prev }
      if (nextVal) next[messageId] = nextVal
      else delete next[messageId]
      saveMessageFeedbacks(next)
      return next
    })
    if (!nextVal) return
    await uploadFeedback(messageId, classification)
  }, [messageFeedbacks, uploadFeedback])

  const handleCopyMessage = useCallback(async (messageId: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedMessageId(messageId)
      safeTimeout(() => {
        setCopiedMessageId((cur) => (cur === messageId ? null : cur))
      }, 2000)
    } catch {}
  }, [safeTimeout])

  const enterpriseToolCapabilities = useMemo(() => catalog?.capabilities.filter((capability) =>
    isMcpToolCapability(capability) && isUsableEnterpriseCapability(capability)
  ) ?? [], [catalog])
  const serviceNowCapability = useMemo(() => {
    const installed = activeBot.bindings?.some((b) =>
      b.state === "INSTALLED" && (b.resourceId.includes("servicenow") || b.capabilityId.includes("servicenow"))
    )
    if (!installed) return null
    return enterpriseToolCapabilities.find((capability) =>
      capability.resource_display_name.toLowerCase().includes("servicenow")
    )
  }, [activeBot.bindings, enterpriseToolCapabilities])

  useEffect(() => {
    if (demo) saveBotMessages(transcriptOwnerRef.current.botId, transcriptOwnerRef.current.threadId, messages)
  }, [demo, messages])

  const handleScroll = useCallback(() => {
    const el = messagesContainerRef.current
    if (!el || restoringPositionRef.current) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const atBottom = distanceFromBottom <= 80
    shouldAutoScrollRef.current = atBottom
    setShowScrollBottom(!atBottom && distanceFromBottom > 140)
    updateView((current) => ({ ...current, position: captureReadingPosition(el) }))
  }, [updateView])

  const handleScrollToBottomClick = useCallback(() => {
    restoringPositionRef.current = false
    shouldAutoScrollRef.current = true
    setShowScrollBottom(false)
    scrollToBottom(true)
  }, [scrollToBottom])

  useEffect(() => {
    const el = messagesContainerRef.current
    if (!el || !messages.length) return
    const frame = requestAnimationFrame(() => {
      if (restoringPositionRef.current) {
        restoreReadingPosition(el, viewStateRef.current.position)
        shouldAutoScrollRef.current = viewStateRef.current.position?.atBottom ?? true
        setShowScrollBottom(!shouldAutoScrollRef.current)
        restoringPositionRef.current = false
        return
      }
      if (shouldAutoScrollRef.current && messagesContainerRef.current) {
        messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [messages, agentState, activities])

  useVisibleTimelineRead(messagesContainerRef, activeBot.id, demo ? "" : token, readSnapshot?.botId === activeBot.id ? readSnapshot.version : null, onBotViewed)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setSearchOpen((v) => !v)
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [])

  const showHelpMessage = useCallback(() => {
    setMessages((curr) => [
      ...curr,
      {
        id: `help-${Date.now()}`,
        role: "assistant",
        text: `### 💡 對話輸入指引與快捷鍵

* **歷史輸入回溯**：在輸入框按 **↑（上鍵）** 可快速載入上一輪送出的提問，按 **↓（下鍵）** 前進或返回新輸入。
* **提及技能與資源 (\`@\`)**：輸入 \`@\` 喚出技能選單，支援如 \`@servicenow-csm\`、\`@code-review\`、\`@doc-search\`、\`@desktop\` 等。
* **快捷斜線指令 (\`/\`)**：輸入 \`/\` 喚出操作選單：
  * \`/plan <任務>\`：啟動規劃模式，引導 Codex 分步驟擬定架構計畫。
  * \`/review\`：審查工作區變更檔案或 Git Diff。
  * \`/skills\`：檢視目前助手啟用的技能清單。
  * \`/compact\`：壓縮當前對話歷史 Token。
  * \`/desktop\`：展開右側受控電腦桌面。
  * \`/help\`：顯示此說明。`,
        createdAt: Date.now(),
      },
    ])
  }, [])

  const showSkillsMessage = useCallback(() => {
    const activeSkillsList = activeBot.skills.map((id) => {
      const s = AVAILABLE_SKILLS.find((item) => item.id === id)
      return `* **@${id}** (${s?.name ?? id})：${s?.description ?? "企業技能"}`
    }).join("\n") || "*(目前尚未為此機器人預設特定技能，可在對話中用 @ 提及任何可用技能)*"

    const availableSkillsList = AVAILABLE_SKILLS.map((s) => `* **@${s.id}** (${s.name})：${s.description}`).join("\n")

    setMessages((curr) => [
      ...curr,
      {
        id: `skills-${Date.now()}`,
        role: "assistant",
        text: `### 🧩 目前可用技能與工具清單

**助手名稱**：${activeBot.name}（${activeBot.title || activeBot.description || activeBot.role}）
**工作環境**：\`${activeBot.workspacePath}\`

#### 本助手已啟用技能：
${activeSkillsList}

#### 企業全域可用技能：
${availableSkillsList}`,
        createdAt: Date.now(),
      },
    ])
  }, [activeBot.name, activeBot.title, activeBot.description, activeBot.role, activeBot.skills, activeBot.workspacePath])

  useEffect(() => {
    const initialThread = `thread-${activeBot.id}-default`
    const saved = demo ? readBotMessages(activeBot.id, initialThread) : []
    if (!demo || saved.length > 0) {
      setMessages(saved)
    } else {
      const initialMsg: ChatMessage[] = [
        { id: "welcome", role: "assistant", text: botCopy(`Hi, I’m ${displayBotName}. I work in the controlled Managed Desktop (${activeBot.workspacePath}) and use Resources according to your GenioOne permissions.`, `嗨，我是 ${activeBot.name}。我會在受控的 Managed Desktop (${activeBot.workspacePath}) 中工作，並依你的 GenioOne 權限使用 Resource。`), createdAt: Date.now() },
      ]
      setMessages(initialMsg)
    }
    const savedModel = readSavedModel(activeBot.id)
    setSelectedModel(savedModel ?? "")
    setActivities([])
    restoringPositionRef.current = true
    shouldAutoScrollRef.current = viewStateRef.current.position?.atBottom ?? true
    setShowScrollBottom(!shouldAutoScrollRef.current)
    transcriptOwnerRef.current = { botId: activeBot.id, threadId: initialThread }
  }, [activeBot.id, activeBot.name, activeBot.workspacePath, demo, displayBotName, safeTimeout, scrollToBottom, setActivities, setSelectedModel])

  useEffect(() => {
    if (demo || !token) return
    let cancelled = false
    let pending = false
    const refresh = async () => {
      if (pending || cancelled) return
      pending = true
      try {
        const snapshot = await getBotTimelineSnapshot(token, activeBot.id)
        const timeline = snapshot.messages
        if (!cancelled) setTimelineError(null)
        if (!cancelled) setReadSnapshot((current) => current?.botId === activeBot.id && current.version === snapshot.version ? current : { botId: activeBot.id, version: snapshot.version })
        if (!cancelled) setMessages((current) => {
          const next = reconcileTimeline(current, timeline)
          return JSON.stringify(current) === JSON.stringify(next) ? current : next
        })
      } catch {
        if (!cancelled) setTimelineError((current) => current?.botId === activeBot.id ? current : { botId: activeBot.id, message: "對話記錄暫時無法更新，畫面保留已載入的內容。" })
      } finally {
        pending = false
      }
    }
    retryTimelineRef.current = refresh
    void refresh()
    const timer = setInterval(() => { void refresh() }, 1000)
    return () => { cancelled = true; clearInterval(timer); if (retryTimelineRef.current === refresh) retryTimelineRef.current = null }
  }, [activeBot.id, demo, token])

  useEffect(() => {
    const welcomeText = runtimeCanExec(runtime)
      ? botCopy(`Hi, I’m ${displayBotName}. The remote sandbox is ready (${activeBot.workspacePath}); I use Resources according to your GenioOne permissions.`, `嗨，我是 ${activeBot.name}。遠端沙盒已就緒（${activeBot.workspacePath}），我會依你的 GenioOne 權限使用 Resource。`)
      : botCopy(`Hi, I’m ${displayBotName}. I’m currently operating through conversation and enterprise tools. The remote sandbox starts only when code execution or workspace access is needed; the managed desktop is separately authorized.`, `嗨，我是 ${activeBot.name}。目前以對話與企業工具運作；需要執行程式或讀寫工作區時才會啟動遠端沙盒。受控電腦畫面是另一項授權。`)
    setMessages((current) => current.map((message) => message.id === "welcome"
      ? { ...message, text: welcomeText }
      : message))
  }, [activeBot.name, activeBot.workspacePath, displayBotName, runtime])

  const sendMessage = useCallback((customText?: string) => {
    sendMessageRef.current = sendMessage
    const images = customText === undefined ? draftImages : []
    const text = (customText !== undefined ? customText : input).trim() || (images.length ? "請查看附加圖片。" : "")
    if (!text) return

    // UX P2: login wall never collects password into chat
    if (composerShouldBlockPassword(text, Boolean(loginWall && (loginWall.status === "pending" || loginWall.status === "takeover_open")))) {
      setMessages((prev) => [...prev, {
        id: `login-wall-reject-${Date.now()}`,
        role: "system",
        kind: "login_wall",
        text: "請在共用電腦的登入畫面輸入密碼，不要把密碼貼到聊天。",
        createdAt: Date.now(),
        loginWallId: loginWall?.id,
        collectsPassword: false,
      }])
      setInput("")
      return
    }

    if (!demo) {
      const pendingStatus = pendingExecutionStatus()
      if (pendingStatus !== "none") {
        setRuntimeState(pendingStatus === "busy"
          ? "正在準備前一項 Headless 工作；目前輸入已保留，請等待後再送出。"
          : "前一項 Headless 工作已取消並保留在輸入框，請重新送出。")
        setAgentState("orbit")
        return
      }
    }

    setInputHistory((prev) => {
      const next = prev[prev.length - 1] === text ? prev : [...prev, text].slice(-50)
      saveInputHistory(activeBot.id, next)
      return next
    })

    if (text === "/help") {
      setInput("")
      showHelpMessage()
      return
    }
    if (text === "/compact") {
      setInput("")
      executeCompact()
      return
    }
    if (text === "/skills") {
      setInput("")
      showSkillsMessage()
      return
    }
    if (text === "/desktop") {
      setInput("")
      setRightTab("desktop")
      setRightPanelOpen(true)
      requestRuntimeTier("desktop")
      return
    }

    if (text === "/request-help" || text === "/login-wall") {
      setInput("")
      const computerId = handsComputer?.computer_id ?? `user-computer-${identity?.subject_id || "local"}`
      if (!handsComputer) {
        setHandsComputer({
          computer_id: computerId,
          status: "idle",
          mock_preview_url: null,
          desktop_windows: [],
        })
      }
      const wall: LoginWallView = {
        id: `login-wall-${Date.now()}`,
        kind: "request_help",
        site_label: "需要登入的網站",
        reason: "Bot 需要你在共用電腦完成登入（人類接管）；不要把密碼貼到聊天。",
        bot_id: activeBot.id,
        computer_id: computerId,
        status: "pending",
        created_at: new Date().toISOString(),
      }
      setLoginWall(wall)
      setMessages((prev) => [...prev, loginWallToChatMessage(wall)])
      setRightPanelOpen(true)
      setRightTab("desktop")
      return
    }
    if (text === "/headless") {
      setInput("")
      setRightTab("activities")
      setRightPanelOpen(true)
      requestRuntimeTier("headless")
      return
    }

    // UX P1-a: Bot↔Bot async handoff — explicit @bot mention; refuse mindless multi fan-out.
    const mentionableBots = allMentionItems
      .filter((item) => item.kind === "bot" && item.botId)
      .map((item) => ({ id: item.botId!, name: item.name }))
    const mentionText = customText === undefined ? input : text
    const bindings = customText === undefined ? viewState.mentions : []
    if (splitMentionSegments(mentionText, allMentionItems, bindings).some((segment) => segment.type === "ambiguous")) {
      setMentionError("提及對象有同名或已不可用，請從 @ 選單重新選取明確的對象。")
      return
    }
    const mentionedBotIds = extractMentionedBotIds(mentionText, mentionableBots, bindings)
    if (images.length && mentionedBotIds.length) {
      setRuntimeState("圖片交接尚未接通；圖片與輸入已保留，請先直接傳給目前 Bot。")
      return
    }
    if (mentionedBotIds.length > 1) {
      const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", text, createdAt: Date.now() }
      setMessages((current) => [...current, userMessage, fanOutBlockedMessage(mentionedBotIds.length)])
      setRuntimeState("已阻止無腦 fan-out")
      setAgentState("alert")
      return
    }
    const mentionedBot = mentionedBotIds.length === 1
      ? allMentionItems.find((item) => item.kind === "bot" && item.botId === mentionedBotIds[0])
      : undefined
    if (mentionedBot?.botId) {
      const requestKey = JSON.stringify([activeBot.id, mentionedBot.botId, text])
      let clientRequestId = crypto.randomUUID() as string
      updateView((current) => {
        const pendingRequest = current.handoffRequest?.key === requestKey ? current.handoffRequest : { key: requestKey, id: clientRequestId }
        clientRequestId = pendingRequest.id
        return { ...current, handoffRequest: pendingRequest }
      })
      setAgentState("orbit")
      setRuntimeState("交接送出中")
      const kind = /\bfyi\b|僅供參考|供參考/i.test(text) ? "fyi" as const : "task" as const
      void handoffBot({
        clientRequestId,
        originalMessage: text,
        mentionedBot,
        text: mentionText,
        mentions: bindings,
        activeBotId: activeBot.id,
        kind,
      }).then((ack) => {
        if (!ack) return
        updateView((current) => current.handoffRequest?.id === clientRequestId ? { ...current, handoffRequest: undefined } : current)
        if (customText === undefined) setInput((current) => current === input ? "" : current)
      })
      return
    }

    const needsHeadless = requiresHeadlessRuntime(text)
    const taskRuntime = needsHeadless ? requestRuntimeTier("headless") : executionRuntime
    if (!demo && taskRuntime?.kind === "endpoint" && (!taskRuntime.execReady || taskRuntime.endpoint?.botId !== activeBot.id)) {
      setRuntimeState("本機連線無法使用，輸入已保留。請開啟「連接本機」重新配對。")
      return
    }
    if (!demo && needsHeadless && !runtimeCanExec(taskRuntime)) {
      if (images.length) {
        setRuntimeState("正在準備工作區，圖片與輸入已保留；就緒後請再送出。")
        return
      }
      const progressId = `runtime-provisioning-${Date.now()}`
      const queued = queuePendingExecution(text, progressId, () => {
        setInput((current) => {
          if (current.trim() === text.trim()) return current
          return current ? `${text}\n\n${current}` : text
        })
      })
      if (queued !== "queued") {
        setRuntimeState(queued === "busy" ? "正在準備前一項 Headless 工作；目前輸入已保留，請等待後再送出。" : "前一項 Headless 工作已取消並保留在輸入框，請重新送出。")
        setAgentState("orbit")
        return
      }
      setMessages((current) => [...current, {
        id: progressId,
        localOnly: true,
        role: "assistant",
        text: `正在準備 Headless 工作區，完成後會自動繼續這項工作：\n\n${text}`,
        createdAt: Date.now(),
      }])
      setInput("")
      setRuntimeState("等待 Headless 工作區")
      setAgentState("orbit")
      return
    }

    if (!demo && !threadReady) return
    const clientMessageId = crypto.randomUUID()
    setMessages((current) => [...current, { id: clientMessageId, clientMessageId, role: "user", text, images: images.map((image) => image.url), createdAt: Date.now() }])
    if (demo && customText === undefined) {
      setInput("")
    }
    shouldAutoScrollRef.current = true
    setShowScrollBottom(false)
    safeTimeout(() => scrollToBottom(true), 20)
    safeTimeout(() => {
      textareaRef.current?.focus()
    }, 0)

    if (demo) {
      const installedBindings = activeBot.bindings?.filter((b) => b.state === "INSTALLED") ?? []
      const hasServiceNow = installedBindings.some((b) =>
        b.resourceId.includes("servicenow") || b.capabilityId.includes("servicenow")
      )
      const asksForServiceNow = /servicenow|工單|csm|cs00|case/i.test(text)

      if (asksForServiceNow && hasServiceNow) {
        setRuntimeState("執行中")
        setAgentState("thinking")
        safeTimeout(() => {
          setActivities((current) => [{
            id: `activity-${Date.now()}`,
            kind: "mcp",
            title: "查詢 ServiceNow",
            detail: "讀取 CS001284",
            status: "done",
          }, ...current])
          setMessages((current) => [
            ...current,
            {
              id: `reply-${Date.now()}`,
              role: "assistant",
              text: `已為你查詢 ServiceNow Case CS001284：目前狀態為 **In Progress**，最新處理記錄由現場工程師回報，預計今日完成驗證。`,
              createdAt: Date.now(),
            },
          ])
          setRuntimeState("就緒")
          setAgentState("idle")
        }, 700)
        return
      }

      if (asksForServiceNow && !hasServiceNow) {
        setRuntimeState("執行中")
        setAgentState("thinking")
        safeTimeout(() => {
          setMessages((current) => [
            ...current,
            {
              id: `reply-${Date.now()}`,
              role: "assistant",
              text: `目前此 Bot 尚未透過 One Policy 授權或綁定 ServiceNow 工具（目前已授權工具為 0 個），無法調用工具查詢工單資料。\n\n若需要使用此能力，請點擊上方「0 個已授權工具」查看企業清單並啟用，或透過「+ 企業 Bot」新增已具備 One Policy 授權的企業服務台助手。`,
              createdAt: Date.now(),
            },
          ])
          setRuntimeState("就緒")
          setAgentState("idle")
        }, 500)
        return
      }

      setRuntimeState("執行中")
      setAgentState("thinking")
      safeTimeout(() => {
        setMessages((current) => [
          ...current,
          {
            id: `reply-${Date.now()}`,
            role: "assistant",
            text: `嗨！我是 ${activeBot.name}（${activeBot.title}）。收到您的訊息：「${text}」。目前此 Bot 尚未綁定外部企業工具（已授權工具：${installedBindings.length} 個），我會以一般對話模式為您解答與協作。`,
            createdAt: Date.now(),
          },
        ])
        setRuntimeState("就緒")
        setAgentState("idle")
      }, 600)
      return
    }

    const mentionedSkills = allMentionItems.filter((s) => text.includes(`@${s.id}`))
    const sentIds = new Set(images.map((image) => image.id))
    void startTurn(text, { taskRuntime, mentionedSkills, clientMessageId, images: images.map((image) => image.url) }).then(() => {
      if (customText === undefined) setInput((current) => current === input ? "" : current)
      void imageDraft.removeSent(sentIds)
    }).catch(() => {})
  }, [
    activeBot.bindings,
    activeBot.id,
    activeBot.name,
    activeBot.title,
    allMentionItems,
    demo,
    executeCompact,
    draftImages,
    imageDraft.removeSent,
    input,
    viewState.mentions,
    updateView,
    handoffBot,
    pendingExecutionStatus,
    queuePendingExecution,
    requestRuntimeTier,
    executionRuntime,
    safeTimeout,
    scrollToBottom,
    setActivities,
    setAgentState,
    setRuntimeState,
    showHelpMessage,
    showSkillsMessage,
    startTurn,
    threadReady,
    token,
    activeThreadId,
  ])

  sendMessageRef.current = sendMessage

  const handleRetry = useCallback((assistantMsgIndex: number) => {
    for (let i = assistantMsgIndex - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") {
        sendMessage(messages[i].text)
        return
      }
    }
  }, [messages, sendMessage])

  const handleImportArtifact = useCallback(async (artifact: ArtifactRef) => {
    if (demo) {
      setActivities((current) => [{
        id: `artifact-import-${artifact.artifactId}`,
        kind: "file",
        title: "Desktop 已匯入產物",
        detail: `${artifact.path} · Chrome 可開啟`,
        status: "done",
      }, ...current])
      return
    }
    if (!token) return
    const desktop = runtimeTiers.desktop ?? (runtime?.tier === "desktop" ? runtime : null)
    if (!desktop?.execReady || !desktop.environmentId) {
      setRuntimeState("請先啟用 Managed Desktop")
      return
    }
    try {
      const imported = await importBotArtifact(token, activeBot.id, artifact.artifactId, "desktop", {
        targetEnvironmentId: desktop.environmentId,
        targetPath: "/home/user/presentation.html",
        open: true,
      })
      if (!isMountedRef.current) return
      setActivities((current) => [{
        id: `artifact-import-${artifact.artifactId}`,
        kind: "file",
        title: imported.opened ? "Desktop 已開啟產物" : "Desktop 已匯入產物",
        detail: imported.targetPath,
        status: "done",
      }, ...current])
    } catch (error) {
      if (!isMountedRef.current) return
      setActivities((current) => [{
        id: `artifact-import-failed-${artifact.artifactId}`,
        kind: "file",
        title: "Desktop 產物匯入失敗",
        detail: error instanceof Error ? error.message : "ARTIFACT_IMPORT_FAILED",
        status: "failed",
      }, ...current])
    }
  }, [activeBot.id, demo, runtime, runtimeTiers.desktop, setActivities, setRuntimeState, token])

  const showCodexLogin = modelRouteRequiresCodexLogin(activeBot.modelRoute) && Boolean(codexLogin)

  const runtimeBlock = useMemo(() => runtimeBlockFromMessage(runtimeState), [runtimeState])
  const effectiveStatus = useMemo(() => {
    if (runtimeBlock) return { text: runtimeBlock.title, state: "alert" as StateId, isReady: false }
    if (demo) return { text: botCopy("Ready", "就緒"), state: "idle" as StateId, isReady: true }
    if (userInputRequest && userInputRequest.isBlocking !== false) return { text: botCopy("Waiting for answer", "等待回答"), state: "alert" as StateId, isReady: false }
    if (elicitationRequest) return { text: botCopy("Waiting for confirmation", "等待確認"), state: "alert" as StateId, isReady: false }
    if (approval) return { text: botCopy("Waiting for confirmation", "等待確認"), state: "alert" as StateId, isReady: false }
    if (agentState === "orbit") return { text: botCopy("Running tools", "執行工具中"), state: "orbit" as StateId, isReady: false }
    if (runtimeState === "執行中" || agentState === "thinking") return { text: botCopy("Thinking", "思考中"), state: "thinking" as StateId, isReady: false }
    if (agentState === "exclaim" || runtimeState.includes("失敗")) return { text: botCopy("Error", "發生錯誤"), state: "exclaim" as StateId, isReady: false }
    if (showCodexLogin) return { text: botCopy("Waiting for sign-in", "等待登入"), state: "alert" as StateId, isReady: false }
    if (!demo && !threadReady && channelReady) return { text: botCopy("Loading Bot", "載入 Bot"), state: "idle" as StateId, isReady: false }
    if (!demo && !threadReady) return { text: botCopy("Connecting", "連線中"), state: "orbit" as StateId, isReady: false }
    return { text: botCopy("Ready", "就緒"), state: "idle" as StateId, isReady: true }
  }, [demo, approval, runtimeState, agentState, showCodexLogin, threadReady, channelReady, runtimeBlock, userInputRequest, elicitationRequest])

  const isAgentBusy = (runtimeState === "執行中" || agentState === "thinking" || agentState === "orbit") && messages.at(-1)?.role === "user"
  const isInputDisabled = !demo && (showCodexLogin || (!threadReady && !channelReady))
  const isSendDisabled = !demo && (showCodexLogin || !threadReady)
  const runningActivity = activities.find((a) => a.status === "running")

  const handleExecuteSlashAction = useCallback((_action: SlashCommandItem["action"], command: SlashCommandItem) => {
    sendMessage(command.command)
  }, [sendMessage])

  const navigateMessage = async (botId: string, messageId: string) => {
    setNavigationError("")
    try {
      const snapshot = await getBotTimelineSnapshot(token, botId)
      if (!snapshot.messages.some((message) => message.id === messageId)) throw new Error("來源訊息已不存在；交接內容仍保留在詳細資料中。")
      if (!bots.some((bot) => bot.id === botId)) throw new Error("這個 Bot 的完整記錄無法在目前工作台開啟；請查看交接內容。")
      const container = messagesContainerRef.current
      if (container) setMessageOrigin({ botId: activeBot.id, position: captureReadingPosition(container), panelOpen: rightPanelOpen, panelTab: rightTab })
      setNavigationError("")
      setMessageDestination({ botId, messageId })
      onSelectBot(botId)
      return true
    } catch {
      setNavigationError("無法開啟來源記錄，可能沒有完整對話的存取權限或來源已不存在。交接內容仍可查看。")
      return false
    }
  }

  useEffect(() => {
    if (!messageDestination || messageDestination.botId !== activeBot.id || readSnapshot?.botId !== activeBot.id) return
    const container = messagesContainerRef.current
    if (!container) return
    const target = [...container.querySelectorAll<HTMLElement>("[data-message-id]")].find((node) => node.dataset.messageId === messageDestination.messageId)
    if (messageDestination.messageId && !target) return
    const frame = requestAnimationFrame(() => {
      if (target) { target.scrollIntoView({ block: "center" }); target.focus({ preventScroll: true }) }
      else restoreReadingPosition(container, messageDestination.position)
      shouldAutoScrollRef.current = false
      setMessageDestination(null)
    })
    return () => cancelAnimationFrame(frame)
  }, [activeBot.id, readSnapshot, messages, messageDestination])

  return (
    <div className={rightPanelOpen ? "product-shell" : "product-shell desktop-collapsed"} data-testid="workspace" data-shell="roster-conversation-inspector">
      <Sidebar
        bots={bots}
        activeBot={activeBot}
        onSelectBot={onSelectBot}
        onAddBot={onAddBot}
        groups={groups}
        onAssignBotToGroup={handleAssignBotToGroup}
        onCreateGroupForBot={handleCreateGroupForBot}
        onRemoveBotFromGroup={handleRemoveBotFromGroup}
        identity={identity}
        catalog={catalog}
        statusState={effectiveStatus.state}
        unreadBotIds={unreadBotIds}
        workStates={workStates}
        summaries={summaries}
        onOpenSettings={() => {
          setSettingsOpen(true)
          setAgentState("swirl")
        }}
        onOpenSearch={() => {
          setSearchOpen(true)
          setAgentState("wide")
        }}
        onSignOut={onSignOut}
      />
      <main className="chat-workspace" data-testid="conversation-pane">
        {navigationError && <div role="alert">{navigationError}<button type="button" onClick={() => setNavigationError("")}>關閉</button></div>}
        {messageOrigin && <button type="button" className="secondary-button" onClick={() => {
          setMessageDestination({ botId: messageOrigin.botId, position: messageOrigin.position })
          setRightPanelOpen(messageOrigin.panelOpen)
          setRightTab(messageOrigin.panelTab)
          onSelectBot(messageOrigin.botId)
          setMessageOrigin(null)
        }}>返回原本閱讀位置</button>}
        {messages.some((message) => message.question?.state === "pending") && <div role="status" className="async-question-summary">{isTurnRunning ? "處理中 · " : ""}{messages.filter((message) => message.question?.state === "pending").length} 個問題待回答</div>}
        <WorkspaceHeader
          token={demo ? undefined : token}
          activeBot={activeBot}
          effectiveStatus={effectiveStatus}
          runtime={runtime}
          mcpStatus={mcpStatus}
          rightPanelOpen={rightPanelOpen}
          catalog={catalog}
          onOpenSettings={() => {
            setSettingsOpen(true)
            setAgentState("swirl")
          }}
          onOpenDesktop={() => {
            setRightPanelOpen(true)
            setRightTab("desktop")
          }}
          onOpenCatalog={() => {
            setCatalogOpen(true)
            setAgentState("wide")
          }}
          onOpenCorpCatalog={onOpenCorpCatalog}
          onOpenRightPanel={() => setRightPanelOpen(true)}
        />

        <ChatMessageList
          onQuestionAction={async (question, action, answer, clientAnswerId) => {
            const updated = await actOnBotQuestion(token, question, action, answer, clientAnswerId)
            setMessages((current) => current.map((message) => message.question?.id === updated.id ? { ...message, question: updated } : message))
          }}
          navigationError={navigationError}
          onNavigateMessage={navigateMessage}
          messages={messages}
          activeBot={activeBot}
          bots={bots}
          effectiveStatus={effectiveStatus}
          isAgentBusy={isAgentBusy}
          agentState={agentState}
          runningActivity={runningActivity}
          serviceNowCapability={serviceNowCapability}
          codexLogin={codexLogin}
          messageFeedbacks={messageFeedbacks}
          copiedMessageId={copiedMessageId}
          showScrollBottom={showScrollBottom}
          messagesContainerRef={messagesContainerRef}
          onScroll={handleScroll}
          onScrollToBottom={handleScrollToBottomClick}
          onFeedback={(messageId, feedback) => void handleFeedback(messageId, feedback)}
          onRetry={handleRetry}
          onCopyMessage={(id, text) => void handleCopyMessage(id, text)}
          onStarterPromptClick={(prompt) => sendMessage(prompt)}
        />

        {viewState.saveFailed && <p role="status">草稿暫時無法保存到此瀏覽器；目前頁面仍保留內容，請先複製備份。</p>}
        {mentionError && <p role="alert">{mentionError}</p>}
        {timelineError?.botId === activeBot.id && <div role="status">{timelineError.message}<button type="button" className="secondary-button" onClick={() => void retryTimelineRef.current?.()}>重新載入對話記錄</button></div>}
        {imageDraft.error && <div role="status">{imageDraft.error}<button type="button" className="secondary-button" onClick={imageDraft.retry}>重試圖片草稿操作</button></div>}
        <ChatComposer
          key={viewKey}
          voiceToken={token || (demo ? "demo" : "")}
          isVoiceAvailable={demo || isCodexAuthenticated}
          onOpenVoiceCall={() => setIsVoiceModalOpen(true)}
          demo={demo}
          input={input}
          setInput={setInput}
          textareaRef={textareaRef}
          isInputDisabled={isInputDisabled}
          isSendDisabled={isSendDisabled || imageDraft.loading || imageDraft.saving}
          isRunning={runtimeState === "執行中" || isTurnRunning}
          activeBotName={displayBotName}
          hasCodexLogin={showCodexLogin}
          runtimeError={effectiveStatus.state === "exclaim" ? runtimeState : ""}
          runtimeErrorTitle={runtimeBlock?.title}
          runtimeErrorDetail={runtimeBlock?.detail}
          onReconnect={() => location.reload()}
          messages={messages}
          threadReady={demo || threadReady}
          channelReady={demo || channelReady}
          approval={approval}
          onDecideApproval={decideApproval}
          userInputRequest={userInputRequest}
          onAnswerUserInput={answerUserInput}
          onDismissUserInput={dismissUserInput}
          elicitationRequest={elicitationRequest}
          onAcceptElicitation={(content) => decideElicitation("accept", content)}
          onDeclineElicitation={() => decideElicitation("decline")}
          loginWall={loginWall}
          onLoginWallTakeover={() => {
            if (!loginWall) return
            setLoginWall({ ...loginWall, status: "takeover_open" })
            setRightTab("desktop")
            setRightPanelOpen(true)
          }}
          onLoginWallCompleted={() => {
            if (!loginWall) return
            setLoginWall({ ...loginWall, status: "completed" })
          }}
          onLoginWallDismiss={() => setLoginWall(null)}
          models={models}
          selectedModel={selectedModel}
          catalog={catalog}
          modelRoute={activeBot.modelRoute}
          onSelectModel={(model) => {
            setSelectedModel(model)
            saveSavedModel(model, activeBot.id)
          }}
          inputHistory={inputHistory}
          images={draftImages}
          imagesDisabled={imageDraft.loading || imageDraft.saving || Boolean(imageDraft.error)}
          onImagesChange={imageDraft.setImages}
          onSendMessage={sendMessage}
          onRefreshPending={() => void refreshPendingInteractions()}
          onInterrupt={() => void interruptRunningTurn()}
          allMentionItems={allMentionItems}
          botMentions={viewState.mentions}
          onSelectBotMention={selectMention}
          onExecuteSlashAction={handleExecuteSlashAction}
        />
      </main>

      {rightPanelOpen && (
        <RightPanel
          activeTab={rightTab}
          onTabChange={setRightTab}
          bot={activeBot}
          messages={messages}
          onSelectMessage={(id) => {
            shouldAutoScrollRef.current = false
            messagesContainerRef.current?.querySelector(`[data-message-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" })
          }}
          historyImportToken={demo ? undefined : token}
          runtime={runtime}
          runtimeTiers={runtimeTiers}
          status={runtimeState}
          mcpStatus={mcpStatus}
          activities={activities}
          artifacts={artifacts}
          botInvocations={botInvocations}
          botNames={Object.fromEntries(bots.map((bot) => [bot.id, bot.name]))}
          pendingAttention={userInputRequest ? "等待你回答問題" : approval || elicitationRequest ? "等待你確認操作" : messages.some((message) => message.question?.state === "pending") ? "有問題待回答，可繼續其他工作" : undefined}
          viewerSubjectId={identity?.subject_id}
          onClose={() => setRightPanelOpen(false)}
          onRetryMcp={() => void retryGenioMcp()}
          onEnsureRuntime={requestRuntimeTier}
          onImportArtifact={(artifact) => void handleImportArtifact(artifact)}
          onBotInvocationDecision={(requestId, decision) => handleBotInvocationDecision(requestId, decision)}
          handsComputer={handsComputer}
          onOpenHandsPreview={() => {
            // UX P2 mock allow path (PEP deny/allow proven in server tests).
            const computerId = handsComputer?.computer_id ?? `user-computer-${identity?.subject_id || "local"}`
            setHandsComputer({
              computer_id: computerId,
              status: "ready",
              mock_preview_url: `/api/hands/mock-preview/e2b-sess-mock?sandbox=mock-sandbox-local`,
              desktop_windows: [
                {
                  bot_id: activeBot.id,
                  window_id: `desk-win-${activeBot.id}`,
                  label: activeBot.name,
                },
                ...(handsComputer?.desktop_windows.filter((w) => w.bot_id !== activeBot.id) ?? []),
              ],
            })
            setRightTab("desktop")
            setRuntimeState(`Hands 預覽就緒（${USER_SCOPED_COMPUTER_COPY.securityNote}）`)
          }}
          loginWall={loginWall}
          onLoginWallTakeover={() => {
            if (!loginWall) return
            setLoginWall({ ...loginWall, status: "takeover_open" })
            setRightTab("desktop")
            setRightPanelOpen(true)
          }}
          onLoginWallCompleted={() => {
            if (!loginWall) return
            setLoginWall({ ...loginWall, status: "completed" })
          }}
          onLoginWallDismiss={() => setLoginWall(null)}
        />
      )}

      {groupingBotId && (
        <CreateGroupModal
          botName={bots.find((bot) => bot.id === groupingBotId)?.name || "這個 Bot"}
          busy={groupCreateBusy}
          error={groupCreateError}
          onClose={() => {
            if (!groupCreateBusy) {
              setGroupingBotId(null)
              setGroupCreateError("")
            }
          }}
          onCreate={(name) => void handleConfirmCreateGroup(name)}
        />
      )}

      <WorkspaceModals
        activeBot={activeBot}
        catalog={catalog}
        modelDirectory={modelDirectory}
        accessToken={demo ? undefined : token}
        messages={messages}
        toolStatusText={getToolStatus(mcpStatus, catalog, activeBot).text}
        mcpStatus={mcpStatus}
        settingsOpen={settingsOpen}
        searchOpen={searchOpen}
        catalogOpen={catalogOpen}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onCloseSettings={() => {
          setSettingsOpen(false)
          setAgentState("idle")
        }}
        onCloseSearch={() => {
          setSearchOpen(false)
          setAgentState("idle")
        }}
        onCloseCatalog={() => {
          setCatalogOpen(false)
          setAgentState("idle")
        }}
        onUpdateBot={onUpdateBot}
        onToggleBinding={onToggleBinding}
        onDuplicateBot={onDuplicateBot}
        onDeleteBot={onDeleteBot}
        onRetryMcp={() => void retryGenioMcp()}
      />

      <RealtimeVoiceModal
        isOpen={isVoiceModalOpen}
        onClose={() => setIsVoiceModalOpen(false)}
        activeBot={activeBot}
        threadId={demo ? activeThreadId : (activeThreadId || `thread-${activeBot.id}-default`)}
        clientRef={clientRef}
        demo={demo}
      />
    </div>
  )
}
