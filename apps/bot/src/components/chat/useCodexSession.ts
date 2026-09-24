import { DEFAULT_CODEX_MODEL, preferredModel } from "../../../shared/model-selection"
import { primaryMcpServer } from "../../lib/primary-mcp-server"
import { isGenioSessionRejection } from "../../../shared/session-rejection"
import { BOT_MEMORY_GUIDANCE } from "../../../shared/bot-memory"
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react"
import {
  CodexClient,
  runtimeCanExec,
  type CodexModel,
  type RuntimeDetails,
} from "../../lib/codex-client"
import { clearGenioTokens } from "../../lib/genio-one"
import {
  codexThreadStorageKey,
  readSavedModel,
  type BotInstance,
  type ChatMessage,
} from "../../bots-storage"
import {
  getBotSession,
  getBotExecutionSegments,
  saveBotSession,
  type ArtifactRef,
} from "../../lib/bot-api"
import type { StateId } from "../../vendor/bloub/bot/states"
import type { ActivityEntry } from "../panel/RightPanel"
import type { ApprovalRequest } from "./ApprovalCard"
import type { UserInputQuestionRequest } from "./UserInputQuestionCard"
import type { InstallElicitationRequest } from "./InstallElicitationCard"
import type { CodexLogin } from "./ChatMessageList"
import { registerCodexStreamListeners, type PendingExecution } from "./codex-stream-listeners"
import { readCodexTurns, readEarlierCodexTurns } from "./codex-history"
import type { ThreadResumeResponse } from "../../../server/generated/v2/ThreadResumeResponse"
import { isMissingCodexThread } from "./codex-session-recovery"
import { gatewayModelsFromDirectory, canonicalModelRoute, COMPANY_MODEL_UNAVAILABLE_MESSAGE, isModelRouteFailure, isRuntimePolicyFailure, modelCatalogForRoute, modelProviderForRoute, modelRouteFailureMessage, modelRoutePresentation, runtimeFailureMessage, type ModelRoute } from "../../lib/model-route"

export interface UseCodexSessionOptions {
  activeBot: BotInstance
  activeThreadId: string
  token: string
  demo: boolean
  onSignOut: () => void
  onMarkBotUnread?: (botId: string) => void
  onBotWorkEvent?: (botId: string, type: "turn_started" | "turn_stopped" | "turn_idle") => void
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>
  setArtifacts: Dispatch<SetStateAction<ArtifactRef[]>>
  scrollToBottom: (smooth?: boolean) => void
  focusInput: () => void
  onPendingExecutionReady?: (task: string) => void
}

export interface CodexSession {
  clientRef: React.RefObject<CodexClient | null>
  threadRef: React.RefObject<string | null>
  runtime: RuntimeDetails | null
  runtimeTiers: Partial<Record<"none" | "headless" | "desktop", RuntimeDetails>>
  executionRuntime: RuntimeDetails | null
  runtimeState: string
  setRuntimeState: Dispatch<SetStateAction<string>>
  mcpStatus: string
  setMcpStatus: Dispatch<SetStateAction<string>>
  modelDirectory: ModelRoute | null
  codexLogin: CodexLogin | null
  isCodexAuthenticated: boolean
  threadReady: boolean
  channelReady: boolean
  models: CodexModel[]
  selectedModel: string
  setSelectedModel: Dispatch<SetStateAction<string>>
  agentState: StateId
  setAgentState: Dispatch<SetStateAction<StateId>>
  activities: ActivityEntry[]
  setActivities: Dispatch<SetStateAction<ActivityEntry[]>>
  approval: ApprovalRequest | null
  userInputRequest: UserInputQuestionRequest | null
  answerUserInput: (answers: Record<string, string[]>) => void
  dismissUserInput: () => void
  elicitationRequest: InstallElicitationRequest | null
  decideElicitation: (decision: "accept" | "decline", content?: Record<string, any>) => void
  dynamicSkills: Array<{ id: string; name: string; description: string; path?: string }>
  isTurnRunning: boolean
  startThread: (details?: RuntimeDetails | null) => Promise<boolean>
  requestRuntimeTier: (tier: "headless" | "desktop") => RuntimeDetails | null
  retryGenioMcp: () => Promise<void>
  refreshPendingInteractions: () => Promise<void>
  decideApproval: (decision: "accept" | "decline") => void
  interruptRunningTurn: () => Promise<void>
  executeCompact: () => void
  uploadFeedback: (messageId: string, classification: "positive" | "negative") => Promise<void>
  startTurn: (text: string, options: {
    clientMessageId?: string
    images?: string[]
    taskRuntime: RuntimeDetails | null
    mentionedSkills: Array<{ id: string; name: string; path?: string; kind: string }>
  }) => Promise<void>
  queuePendingExecution: (task: string, progressId: string, restoreDraft: PendingExecution["restoreDraft"]) => "queued" | "busy" | "stale"
  pendingExecutionStatus: () => "none" | "busy" | "stale"
}

export function selectedExecutionRuntime(
  tier: "headless" | null,
  runtimeTiers: Partial<Record<"none" | "headless" | "desktop", RuntimeDetails>>,
) {
  const runtime = tier ? runtimeTiers[tier] ?? null : null
  return runtimeCanExec(runtime) ? runtime : null
}

export function nativeExecutionEnvironments(runtime: RuntimeDetails | null) {
  if (!runtime?.environmentId || runtime.tier === "none") return []
  return [{
    environmentId: runtime.environmentId,
    cwd: runtime.cwd,
    runtimeWorkspaceRoots: [runtime.cwd],
  }]
}

function isCompanyModelPolicyFailure(error: unknown): boolean {
  const reason = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  return /model\.invoke|POLICY_SCOPE_NOT_ALLOWED/i.test(reason)
}

export function useCodexSession({
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
}: UseCodexSessionOptions): CodexSession {
  const isMountedRef = useRef(true)
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())

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

  const clientRef = useRef<CodexClient | null>(null)
  const threadRef = useRef<string | null>(null)
  const activeBotRef = useRef(activeBot)
  if (activeBotRef.current.id !== activeBot.id) threadRef.current = null
  activeBotRef.current = activeBot
  const tokenRef = useRef(token)
  tokenRef.current = token
  const activeThreadIdRef = useRef(activeThreadId)
  activeThreadIdRef.current = activeThreadId

  const loggedInRef = useRef(false)
  const isTurnRunningRef = useRef(false)
  const [isTurnRunningState, setIsTurnRunningState] = useState(false)
  const runtimeDetailsRef = useRef<RuntimeDetails | null>(null)
  const selectedExecutionTierRef = useRef<"headless" | null>(null)
  const executionRuntimeRef = useRef<RuntimeDetails | null>(null)
  const preparedExecutionEnvironmentRef = useRef<string | null>(null)
  const completedItemIdsRef = useRef<Set<string>>(new Set())
  const threadStartsRef = useRef(new Map<string, Promise<boolean>>())
  const threadBotIdRef = useRef<string | null>(null)
  const startThreadRef = useRef<(details?: RuntimeDetails | null, options?: { skipResume?: boolean }) => Promise<boolean>>(async () => false)
  const selectBotRef = useRef<(botId: string) => Promise<void>>(async () => {})
  const prepareBotRef = useRef<() => Promise<void>>(async () => {})
  const pendingExecutionRef = useRef<PendingExecution | null>(null)
  const pendingArtifactRef = useRef<{ path: string; environmentId: string; tier: "headless" | "desktop" } | null>(null)
  const modelDirectoryModelsRef = useRef<CodexModel[]>([])

  const [runtime, setRuntime] = useState<RuntimeDetails | null>(null)
  const [runtimeTiers, setRuntimeTiers] = useState<Partial<Record<"none" | "headless" | "desktop", RuntimeDetails>>>({})
  const [executionRuntime, setExecutionRuntimeState] = useState<RuntimeDetails | null>(null)
  const [runtimeState, setRuntimeState] = useState(demo ? "展示模式" : "啟動中")
  const [mcpStatus, setMcpStatus] = useState(demo ? "展示模式" : `等待 ${modelRoutePresentation(activeBot.modelRoute).providerLabel} runtime`)
  const [modelDirectory, setModelDirectory] = useState<ModelRoute | null>(null)
  const [codexLogin, setCodexLogin] = useState<CodexLogin | null>(null)
  const [isCodexAuthenticated, setIsCodexAuthenticated] = useState(demo)
  const [threadReady, setThreadReady] = useState(false)
  const [channelReady, setChannelReady] = useState(demo)
  const [models, setModels] = useState<CodexModel[]>([])
  const [modelsRoute, setModelsRoute] = useState<ModelRoute>(() => canonicalModelRoute(activeBot.modelRoute))
  const modelsRef = useRef<CodexModel[]>([])
  const [selectedModel, setSelectedModel] = useState(() => readSavedModel(activeBot.id) || "")
  const [agentState, setAgentState] = useState<StateId>("idle")
  const [activities, setActivities] = useState<ActivityEntry[]>([])
  const [approval, setApproval] = useState<ApprovalRequest | null>(null)
  const [userInputRequest, setUserInputRequest] = useState<UserInputQuestionRequest | null>(null)
  const [elicitationRequest, setElicitationRequest] = useState<InstallElicitationRequest | null>(null)
  const [dynamicSkills, setDynamicSkills] = useState<Array<{ id: string; name: string; description: string; path?: string }>>([])

  const setTurnRunning = useCallback((running: boolean) => {
    isTurnRunningRef.current = running
    if (isMountedRef.current) setIsTurnRunningState(running)
  }, [])

  const setExecutionRuntime = useCallback((next: RuntimeDetails | null) => {
    executionRuntimeRef.current = next
    if (isMountedRef.current) setExecutionRuntimeState(next)
  }, [])

  const clearExecutionRuntime = useCallback(() => {
    selectedExecutionTierRef.current = null
    preparedExecutionEnvironmentRef.current = null
    setExecutionRuntime(null)
  }, [setExecutionRuntime])

  const restorePendingExecution = useCallback((notice = "工作區狀態已變更；原工作已保留在輸入框，請重新送出。") => {
    const pending = pendingExecutionRef.current
    if (!pending) return false
    pendingExecutionRef.current = null
    pending.restoreDraft()
    if (pending.botId === activeBotRef.current.id) {
      setMessages((current) => [...current.filter((message) => message.id !== pending.progressId), {
        id: `${pending.progressId}-canceled`,
        localOnly: true,
        role: "system",
        text: notice,
        createdAt: Date.now(),
      }])
    }
    return true
  }, [setMessages])

  useEffect(() => {
    const selected = selectedExecutionRuntime(selectedExecutionTierRef.current, runtimeTiers)
    const current = executionRuntimeRef.current
    if (!current) return
    if (!selected || current.environmentId !== selected.environmentId || current.tier !== selected.tier) {
      preparedExecutionEnvironmentRef.current = null
      setExecutionRuntime(null)
      return
    }
    if (current !== selected) setExecutionRuntime(selected)
  }, [runtimeTiers, setExecutionRuntime])

  useEffect(() => {
    const pending = pendingExecutionRef.current
    if (pending && (pending.botId !== activeBot.id || pending.modelRoute !== canonicalModelRoute(activeBot.modelRoute))) restorePendingExecution()
    clearExecutionRuntime()
  }, [activeBot.id, activeBot.modelRoute, clearExecutionRuntime, restorePendingExecution])

  const botInstructions = useCallback((bot: BotInstance, hasExec: boolean, tier: RuntimeDetails["tier"] = "none") => {
    // Preference only — never an auth control. No binding ⇒ none (not default-all).
    const installed = bot.bindings?.filter((binding) => binding.state === "INSTALLED").map((binding) => binding.capabilityId) ?? []
    const tools = bot.allowedTools === undefined
      ? (installed.length ? installed.join(", ") : "none until Add creates a BotBinding")
      : (bot.allowedTools.length === 0 ? "none" : bot.allowedTools.join(", "))
    const bindings = installed.join(", ") || "none"
    const execConstraint = hasExec
      ? `Remote ${tier === "desktop" ? "desktop" : "headless"} execution sandbox (${bot.workspacePath}) is ACTIVE. You may use shell commands and workspace files inside that isolated sandbox. Do not execute on the Bot host.`
      : `CRITICAL RESTRICTION - EXEC SANDBOX IS NOT READY: There is NO remote execution environment attached. You MUST NOT execute any local shell commands, host terminal tools, or command execution tools (such as exec_command, write_stdin, bash, or editing host files). Host command execution is strictly forbidden and blocked. You are operating as a conversational and enterprise MCP agent only until the remote sandbox is provisioned.`
    const defaultToolsGuidance = BOT_MEMORY_GUIDANCE + " Teammate collaboration: When the user requests delegation, use the genio_bot list_bots and send_to_bot tools when available. Use returned Bot IDs, send only the necessary task facts, and do not fan out without explicit user direction. A sent acknowledgement is not completion; the teammate result will wake this Bot later. Do not create acknowledgement loops. Default capabilities: You have built-in interactive tools to ask questions with structured choice options (request_user_input) when clarifying requirements or selecting next steps, and request missing configuration parameters or credentials (mcpServer/elicitation) when installing or connecting tools."
    return `You are ${bot.name}, an enterprise personal agent acting on behalf of the user. Your working style is: ${bot.description ?? bot.role}. Assigned workspace: ${bot.workspacePath}. Enabled skills: ${bot.skills.join(", ") || "none"}. Installed Bot bindings: ${bindings}. External tool preference: ${tools}; this is not an authorization control and does not disable the built-in genio_bot history, memory or work-summary tools. ${defaultToolsGuidance} ${execConstraint} Treat GenioOne resource authorization as authoritative and never infer access.`
  }, [])

  const refreshGenioMcp = useCallback(async (client: CodexClient, threadId: string) => {
    await client.request("config/mcpServer/reload", undefined)
    const status = await client.request("mcpServerStatus/list", {
      threadId,
      detail: "toolsAndAuthOnly",
    }) as { data: Array<{ name: string; runtimeStatus: string | null; authStatus: string; tools: Record<string, unknown> }> }
    const genioOne = status.data.find((server) => server.name === primaryMcpServer(activeBotRef.current.bindings))
    if (!genioOne) throw new Error("GENIO_ONE_MCP_NOT_CONFIGURED")
    if (!isMountedRef.current) return
    if (genioOne.runtimeStatus === "connected") {
      setMcpStatus(`${Object.keys(genioOne.tools).length} 個工具 · GenioOne SSO`)
      return
    }
    if (genioOne.authStatus === "notLoggedIn" || genioOne.runtimeStatus === "authenticationRequired") {
      setMcpStatus("GenioOne SSO session 無法使用")
      return
    }
    throw new Error("GENIO_ONE_MCP_UNAVAILABLE")
  }, [])

  const connectionGenerationRef = useRef(0)
  const modelRouteGenerationRef = useRef(0)
  const prepareModelProvider = useCallback(async (client: CodexClient, route: ModelRoute, generation = modelRouteGenerationRef.current, options: { skipResume?: boolean } = {}) => {
    const isCurrentRoute = () => isMountedRef.current && modelRouteGenerationRef.current === generation && canonicalModelRoute(activeBotRef.current.modelRoute) === route
    if (!isCurrentRoute()) return
    const presentation = modelRoutePresentation(route)
    if (!presentation.requiresLogin) {
      loggedInRef.current = true
      setIsCodexAuthenticated(true)
      setCodexLogin(null)
      setChannelReady(true)
      setRuntimeState(presentation.waitingState)
      if (runtimeDetailsRef.current) {
        await startThreadRef.current(runtimeDetailsRef.current, options)
      } else {
        setRuntimeState("就緒 (等待電腦環境)")
      }
      return
    }
    loggedInRef.current = false
    setIsCodexAuthenticated(false)
    const account = await client.request("account/read", { refreshToken: true }) as { account: unknown }
    if (!isCurrentRoute()) return
    if (account.account) {
      loggedInRef.current = true
      setIsCodexAuthenticated(true)
      setCodexLogin(null)
      setChannelReady(true)
      if (runtimeDetailsRef.current) {
          await startThreadRef.current(runtimeDetailsRef.current, options)
      } else {
        setRuntimeState("就緒 (等待電腦環境)")
      }
      return
    }
    const login = await client.request("account/login/start", { type: "chatgptDeviceCode" }) as { verificationUrl: string; userCode: string }
    if (!isCurrentRoute()) return
    setCodexLogin(login)
    setIsCodexAuthenticated(false)
    setRuntimeState(presentation.waitingState)
  }, [])

  const startThread = useCallback((details?: RuntimeDetails | null, options: { skipResume?: boolean } = {}) => {
    const r = details ?? runtimeDetailsRef.current
    const client = clientRef.current
    if (!r || !loggedInRef.current || !client) return Promise.resolve(false)

    const bot = activeBotRef.current
    const pending = threadStartsRef.current.get(bot.id)
    if (pending) return pending
    const generation = connectionGenerationRef.current
    const isCurrent = () => isMountedRef.current && activeBotRef.current.id === bot.id && canonicalModelRoute(activeBotRef.current.modelRoute) === canonicalModelRoute(bot.modelRoute) && clientRef.current === client && connectionGenerationRef.current === generation
    const uiThreadId = demo ? activeThreadIdRef.current : `thread-${bot.id}-default`
    const storageKey = codexThreadStorageKey(bot.id, uiThreadId)
    const selectedRuntime = selectedExecutionTierRef.current === r.tier && runtimeCanExec(r) ? r : null
    const currentExecutionRuntime = selectedRuntime ?? executionRuntimeRef.current
    const hasExec = runtimeCanExec(currentExecutionRuntime)
    const environments = nativeExecutionEnvironments(currentExecutionRuntime)
    const executionTier = currentExecutionRuntime?.tier ?? "none"
    const hydrateEarlierSegments = async (currentThreadId: string) => {
      const segments = await getBotExecutionSegments(tokenRef.current, bot.id)
      for (const segment of segments) {
        if (!isCurrent()) return
        if (segment.threadId === currentThreadId || segment.historyStatus !== "pending") continue
        try {
          await readEarlierCodexTurns(client, segment.threadId, bot.id)
        } catch (error) {
          if (!isMissingCodexThread(error)) throw error
        }
      }
    }
    const importHistory = (threadId: string) => {
      void hydrateEarlierSegments(threadId).catch((error) => {
        if (isCurrent()) setActivities((current) => [{ id: "history-recovery", kind: "runtime", title: "較早的記錄尚未恢復", detail: error instanceof Error ? error.message : "重新連線後會再嘗試", status: "failed" }, ...current.filter((item) => item.id !== "history-recovery")])
      })
    }

    let threadStarting!: Promise<boolean>
    threadStarting = (async () => {
      if (isCurrent()) setThreadReady(false)
      const route = canonicalModelRoute(bot.modelRoute)
      const cachedModels = modelCatalogForRoute(route, modelDirectoryModelsRef.current, modelsRef.current)
      const catalog = cachedModels.length > 0
        ? cachedModels
        : route === "genio-gateway"
          ? []
          : (await client.request("model/list", { limit: 100, includeHidden: false }) as { data: CodexModel[] }).data
      if (!isCurrent()) return false
      modelsRef.current = catalog
      setModels(catalog)
      if (catalog.length === 0) {
        setSelectedModel("")
        setThreadReady(false)
        setChannelReady(false)
        setRuntimeState(route === "genio-gateway" ? COMPANY_MODEL_UNAVAILABLE_MESSAGE : "目前沒有可用的 Codex 模型，請確認訂閱與登入狀態後重新連線。")
        setAgentState("exclaim")
        return false
      }
      const activeModel = preferredModel(catalog, readSavedModel(bot.id), route === "codex-subscription" ? DEFAULT_CODEX_MODEL : null)
      setSelectedModel(activeModel)
      let storedThreadId = sessionStorage.getItem(storageKey)?.trim() || ""
      let persistedThreadId = ""
      const isDefaultUiThread = !demo || uiThreadId === `thread-${bot.id}-default`
      if (isDefaultUiThread && !options.skipResume) {
          const persisted = await getBotSession(tokenRef.current, bot.id)
          const serverThreadId = persisted?.appServerThreadId?.trim() || ""
          persistedThreadId = serverThreadId
          storedThreadId = serverThreadId
          if (serverThreadId) {
            sessionStorage.setItem(storageKey, serverThreadId)
          } else sessionStorage.removeItem(storageKey)
      }

      if (storedThreadId) {
        if (!isCurrent()) return false
        try {
          const resumed = await client.requestRaw("thread/resume", {
              threadId: storedThreadId,
              excludeTurns: true,
              model: activeModel,
              ...(modelProviderForRoute(bot.modelRoute) ? { modelProvider: modelProviderForRoute(bot.modelRoute) } : {}),
              approvalPolicy: "on-request",
              sandbox: hasExec ? "danger-full-access" : "read-only",
              baseInstructions: botInstructions(bot, hasExec, executionTier),
              environments,
            }, bot.id) as ThreadResumeResponse
          resumed.thread.turns = await readCodexTurns(client, resumed.thread.id, bot.id)
          if (!isCurrent()) return false
          threadBotIdRef.current = bot.id
          threadRef.current = resumed.thread.id
          sessionStorage.setItem(storageKey, resumed.thread.id)
          if (resumed.thread.turns.length > 0) await saveBotSession(tokenRef.current, bot.id, { appServerThreadId: resumed.thread.id, activeRuntimeTier: executionTier })
          if (!isCurrent()) return false
          safeTimeout(() => scrollToBottom(false), 50)
          importHistory(resumed.thread.id)
          setThreadReady(true)
          setChannelReady(true)
          setRuntimeState("就緒")
          setTurnRunning(resumed.thread.turns.some((turn) => turn.status === "inProgress"))
          await client.restorePending(resumed.thread.id, bot.id)
          void refreshGenioMcp(client, resumed.thread.id).catch((error) => {
            if (isMountedRef.current) setMcpStatus(error instanceof Error ? error.message : "GENIO_ONE_MCP_UNAVAILABLE")
          })
          return true
        } catch (error) {
          if (!isMissingCodexThread(error)) throw error
          if (!isCurrent()) return false
          if (persistedThreadId) await saveBotSession(tokenRef.current, bot.id, { appServerThreadId: null })
          if (persistedThreadId) setMessages((current) => current.some((message) => message.id === `session-unavailable-${storedThreadId}`) ? current : [...current, {
            id: `session-unavailable-${storedThreadId}`,
            role: "system",
            text: "先前的執行狀態已無法恢復。已保留現有對話記錄，接下來會建立新的執行段。",
            createdAt: Date.now(),
          }])
        }
      }

      const started = await client.request("thread/start", {
        model: activeModel,
        ...(modelProviderForRoute(bot.modelRoute) ? { modelProvider: modelProviderForRoute(bot.modelRoute) } : {}),
        approvalPolicy: "on-request",
        sandbox: hasExec ? "danger-full-access" : "read-only",
        serviceName: "genio-one-bot",
        baseInstructions: botInstructions(bot, hasExec, executionTier),
        environments,
      }, bot.id) as { thread: { id: string } }

      sessionStorage.setItem(storageKey, started.thread.id)
      if (!isCurrent()) return false
      threadBotIdRef.current = bot.id
      threadRef.current = started.thread.id
      importHistory(started.thread.id)
      setThreadReady(true)
      setChannelReady(true)
      setRuntimeState("就緒")
      void refreshGenioMcp(client, started.thread.id).catch((error) => {
        if (isMountedRef.current) setMcpStatus(error instanceof Error ? error.message : "GENIO_ONE_MCP_UNAVAILABLE")
      })
      return true
    })().catch((error) => {
      if (!isCurrent()) return false
      console.warn(JSON.stringify({ event: "bot.session.restore_failed", bot_id: bot.id, reason: error instanceof Error ? error.message : "UNKNOWN" }))
      const modelFailure = isModelRouteFailure(error)
      if (currentExecutionRuntime && !modelFailure && isRuntimePolicyFailure(error)) {
        clearExecutionRuntime()
        const pending = pendingExecutionRef.current
        if (pending?.botId === bot.id && pending.connectionGeneration === generation && pending.modelRoute === canonicalModelRoute(bot.modelRoute)) {
          restorePendingExecution("Headless 工作區未獲授權；原工作已保留在輸入框，請取得授權後重新送出。")
        }
        return new Promise<boolean>((resolve) => {
          safeTimeout(() => {
            if (!isCurrent()) {
              resolve(false)
              return
            }
            if (threadStartsRef.current.get(bot.id) === threadStarting) threadStartsRef.current.delete(bot.id)
            void startThreadRef.current(r, options).then(resolve)
          }, 0)
        })
      }
      setRuntimeState(modelFailure ? modelRouteFailureMessage(canonicalModelRoute(bot.modelRoute), error) : runtimeFailureMessage(error))
      setAgentState("exclaim")
      return false
    }).finally(() => {
      if (threadStartsRef.current.get(bot.id) === threadStarting) threadStartsRef.current.delete(bot.id)
    })
    threadStartsRef.current.set(bot.id, threadStarting)

    return threadStarting
  }, [botInstructions, clearExecutionRuntime, demo, refreshGenioMcp, restorePendingExecution, safeTimeout, scrollToBottom, setMessages])

  startThreadRef.current = startThread

  useEffect(() => {
    if (demo) return
    const client = new CodexClient()
    clientRef.current = client
    let initialized = false
    const resetConnection = client.onStatusChange((status) => {
      if (status === "connecting" || status === "reconnecting" || status === "disconnected") {
        initialized = false
        loggedInRef.current = false
        connectionGenerationRef.current++
        restorePendingExecution()
        threadStartsRef.current.clear()
        clearExecutionRuntime()
        setThreadReady(false)
        setChannelReady(false)
      }
    })

    const prepareCodexSession = async () => {
      if (!initialized) {
        await client.initialize()
        initialized = true
      }
      try {
        const runtimeStatus = await client.requestRaw("genio/runtime/status") as {
          active?: RuntimeDetails | null
          tiers?: Partial<Record<"none" | "headless" | "desktop", RuntimeDetails>>
        }
        if (runtimeStatus.active) {
          runtimeDetailsRef.current = runtimeStatus.active
          if (isMountedRef.current) setRuntime(runtimeStatus.active)
        }
        if (runtimeStatus.tiers && isMountedRef.current) setRuntimeTiers(runtimeStatus.tiers)
      } catch {}

      await selectBotRef.current(activeBotRef.current.id)
      try {
        const skillsRes = await client.request("skills/list", {}) as {
          data?: Array<{ skills?: Array<{ name: string; description: string; path: string }> }>
        }
        if (skillsRes?.data && isMountedRef.current) {
          const mapped = skillsRes.data.flatMap((d) => d.skills || []).map((s) => ({
            id: s.name,
            name: s.name,
            description: s.description,
            path: s.path,
          }))
          setDynamicSkills(mapped)
        }
      } catch {}

      await prepareModelProvider(client, canonicalModelRoute(activeBotRef.current.modelRoute))
    }

    prepareBotRef.current = async () => {
      if (initialized) await prepareCodexSession()
    }
    let selectionVersion = 0
    selectBotRef.current = async (botId: string) => {
      if (!initialized || !clientRef.current) return
      const generation = modelRouteGenerationRef.current
      const version = ++selectionVersion
      const isCurrent = () => isMountedRef.current && activeBotRef.current.id === botId && modelRouteGenerationRef.current === generation && clientRef.current === client && selectionVersion === version
      const selected = await client.requestRaw("genio/bot/select", { botId }).catch((error) => {
        if (!isCurrent()) return null
        throw error
      }) as { modelDirectory?: string; models?: Array<{ publicModelId?: string; displayName?: string }> } | null
      if (!isCurrent() || !selected) return
      if (selected.modelDirectory === "codex-subscription" || selected.modelDirectory === "genio-gateway") {
        setModelDirectory(selected.modelDirectory)
        modelDirectoryModelsRef.current = selected.modelDirectory === "genio-gateway" ? gatewayModelsFromDirectory(selected.models ?? []) : []
        if (selected.modelDirectory === "genio-gateway") {
          modelsRef.current = modelDirectoryModelsRef.current
          setModels(modelDirectoryModelsRef.current)
          setSelectedModel(preferredModel(modelDirectoryModelsRef.current, readSavedModel(botId), null))
        }
      }
    }

    const attachRuntimeDesktop = async (details: RuntimeDetails) => {
      const bot = activeBotRef.current
      const route = canonicalModelRoute(bot.modelRoute)
      const generation = connectionGenerationRef.current
      const isCurrent = () => isMountedRef.current && activeBotRef.current.id === bot.id && canonicalModelRoute(activeBotRef.current.modelRoute) === route && clientRef.current === client && connectionGenerationRef.current === generation
      runtimeDetailsRef.current = details
      if (details.execReady && details.environmentId && details.execServerUrl) {
        await client.request("environment/add", {
          environmentId: details.environmentId,
          execServerUrl: details.execServerUrl,
          connectTimeoutMs: 30_000,
        })
        await client.request("environment/info", { environmentId: details.environmentId })
      }
      if (!isCurrent()) return
      const threadStarted = initialized && loggedInRef.current
        ? await startThreadRef.current(details)
        : false
      if (threadStarted && isCurrent() && selectedExecutionTierRef.current === details.tier && runtimeCanExec(details) && details.environmentId) {
        preparedExecutionEnvironmentRef.current = details.environmentId
        setExecutionRuntime(details)
      }
    }

    const unsubscribe = registerCodexStreamListeners({
      isMounted: () => isMountedRef.current,
      safeTimeout,
      client,
      tokenRef,
      activeBotRef,
      threadRef,
      threadBotIdRef,
      runtimeDetailsRef,
      completedItemIdsRef,
      pendingArtifactRef,
      pendingExecutionRef,
      isPendingExecutionCurrent: (pending) => pending.botId === activeBotRef.current.id && pending.connectionGeneration === connectionGenerationRef.current && pending.modelRoute === canonicalModelRoute(activeBotRef.current.modelRoute),
      isRuntimePrepared: (details) => selectedExecutionTierRef.current === details.tier && executionRuntimeRef.current?.environmentId === details.environmentId && preparedExecutionEnvironmentRef.current === details.environmentId,
      modelDirectoryModelsRef,
      loggedInRef,
      isTurnRunningRef,
      setRuntime,
      setRuntimeTiers,
      setRuntimeState,
      setModelDirectory,
      setModels,
      setSelectedModel,
      setCodexLogin,
      setIsCodexAuthenticated,
      setAgentState,
      setMessages,
      setArtifacts,
      setActivities,
      setThreadReady,
      setChannelReady,
      setApproval,
      setUserInputRequest,
      setElicitationRequest,
      setMcpStatus,
      setDynamicSkills,
      setTurnRunning,
      prepareCodexSession,
      attachRuntimeDesktop,
      shouldPrepareRuntime: (details) => selectedExecutionTierRef.current === details.tier && runtimeCanExec(details) && preparedExecutionEnvironmentRef.current !== details.environmentId,
      onMarkBotUnread,
      onBotWorkEvent,
      onPendingExecutionReady,
      onSignOut,
      focusInput,
      startThread: (details) => startThreadRef.current(details),
    })

    void client.connect(tokenRef.current).catch((error) => {
      if (!isMountedRef.current) return
      const message = error instanceof Error ? error.message : "連線失敗"
      setRuntimeState(runtimeFailureMessage(error))
      setAgentState("exclaim")
      if (isGenioSessionRejection(message)) {
        clearGenioTokens()
        onSignOut()
      }
    })

    return () => {
      setThreadReady(false)
      setChannelReady(false)
      startThreadRef.current = async () => false
      selectBotRef.current = async () => {}
      prepareBotRef.current = async () => {}
      unsubscribe()
      resetConnection()
      client.close()
    }
  }, [clearExecutionRuntime, demo, focusInput, onMarkBotUnread, onBotWorkEvent, onPendingExecutionReady, onSignOut, prepareModelProvider, restorePendingExecution, safeTimeout, setArtifacts, setExecutionRuntime, setMessages, setTurnRunning])

  const botModelRoute = canonicalModelRoute(activeBot.modelRoute)
  const botConfigurationKey = JSON.stringify([activeBot.id, activeBot.name, activeBot.description, activeBot.role, activeBot.workspacePath, activeBot.skills, activeBot.bindings, activeBot.allowedTools])

  useEffect(() => {
    if (demo) return
    setThreadReady(false)
    setApproval(null)
    setUserInputRequest(null)
    setElicitationRequest(null)
    setTurnRunning(false)
    void prepareBotRef.current()
      .catch((error) => {
        if (isMountedRef.current) setRuntimeState(error instanceof Error ? error.message : "Bot 載入失敗")
      })
  }, [demo, botConfigurationKey])

  const previousModelRouteRef = useRef(botModelRoute)

  useEffect(() => {
    if (demo) return
    const previousRoute = previousModelRouteRef.current
    previousModelRouteRef.current = botModelRoute
    if (previousRoute === botModelRoute) return
    const generation = ++modelRouteGenerationRef.current
    const botId = activeBot.id
    const isCurrentRoute = () => isMountedRef.current && modelRouteGenerationRef.current === generation && activeBotRef.current.id === botId && canonicalModelRoute(activeBotRef.current.modelRoute) === botModelRoute
    loggedInRef.current = false
    setModelsRoute(botModelRoute)
    setCodexLogin(null)
    setModelDirectory(null)
    modelsRef.current = []
    setModels([])
    setSelectedModel("")
    setThreadReady(false)
    setChannelReady(false)
    setMcpStatus(`等待 ${modelRoutePresentation(botModelRoute).providerLabel} runtime`)
    setApproval(null)
    setUserInputRequest(null)
    setElicitationRequest(null)
    setTurnRunning(false)
    setAgentState("idle")
    setRuntimeState(modelRoutePresentation(botModelRoute).waitingState)
    threadRef.current = null
    threadBotIdRef.current = null
    threadStartsRef.current.delete(botId)
    sessionStorage.removeItem(codexThreadStorageKey(botId, `thread-${botId}-default`))
    const client = clientRef.current
    if (!client) return
    void (async () => {
      await saveBotSession(tokenRef.current, botId, { appServerThreadId: null }).catch(() => {})
      if (!isCurrentRoute()) return
      await selectBotRef.current(botId)
      await prepareModelProvider(client, botModelRoute, generation, { skipResume: true })
    })().catch((error) => {
      if (isCurrentRoute()) {
        setRuntimeState(modelRouteFailureMessage(botModelRoute, error))
        setAgentState("exclaim")
      }
    })
  }, [activeBot.id, botModelRoute, demo, prepareModelProvider, setTurnRunning])

  useEffect(() => {
    if (demo || !token) return
    clientRef.current?.updateAccessToken(token)
  }, [demo, token])

  const requestRuntimeTier = useCallback((tier: "headless" | "desktop") => {
    if (tier === "headless") {
      selectedExecutionTierRef.current = "headless"
      const selected = selectedExecutionRuntime("headless", runtimeTiers)
      if (selected && executionRuntimeRef.current?.environmentId === selected.environmentId && preparedExecutionEnvironmentRef.current === selected.environmentId) return selected
    }
    if (demo) {
      const simulated: RuntimeDetails = {
        kind: "e2b-self-hosted",
        tier,
        cwd: activeBotRef.current.workspacePath,
        desktopUrl: tier === "desktop" ? "about:blank" : null,
        sandboxId: `demo-${tier}`,
        workspaceId: null,
        workspaceRevision: null,
        leaseId: null,
        environmentId: `demo-${tier}`,
        execServerUrl: null,
        execReady: true,
      }
      setRuntime(simulated)
      setRuntimeTiers((current) => ({ ...current, [tier]: simulated }))
      if (tier === "headless") {
        preparedExecutionEnvironmentRef.current = simulated.environmentId
        setExecutionRuntime(simulated)
      }
      setRuntimeState(`${tier === "desktop" ? "Desktop" : "Headless"} 就緒`)
      return tier === "headless" ? simulated : null
    }
    const client = clientRef.current
    if (!client) {
      setRuntimeState("Codex app-server 尚未連線")
      return null
    }
    setRuntimeState(`${tier === "desktop" ? "Desktop" : "Headless"} 啟動中`)
    setAgentState("orbit")
    client.notifyRaw("genio/runtime/ensure", { tier, botId: activeBotRef.current.id })
    return null
  }, [demo, runtimeTiers, setExecutionRuntime])

  const retryGenioMcp = useCallback(async () => {
    const client = clientRef.current
    const threadId = threadRef.current
    if (!client || !threadId) return
    setMcpStatus("重新連線中")
    try {
      await client.request("config/mcpServer/reload", undefined)
      await refreshGenioMcp(client, threadId)
    } catch (error) {
      if (isMountedRef.current) setMcpStatus(error instanceof Error ? error.message : "MCP reload failed")
    }
  }, [refreshGenioMcp])

  const submitInteraction = useCallback((id: number, result: unknown) => {
    const client = clientRef.current
    if (!client) return
    const botId = activeBotRef.current.id
    setAgentState("thinking")
    void client.respond(id, result).catch(() => {
      if (isMountedRef.current && activeBotRef.current.id === botId) {
        setRuntimeState("回覆未送出或問題已失效。請重新連線確認目前待處理事項。")
        setAgentState("alert")
      }
    })
  }, [])

  const refreshPendingInteractions = useCallback(async () => {
    const client = clientRef.current
    const threadId = threadRef.current
    if (!client || !threadId) return
    try { await client.restorePending(threadId, activeBotRef.current.id) }
    catch { setRuntimeState("待處理事項尚未載入，請確認連線後重試。") }
  }, [])

  const decideApproval = useCallback((decision: "accept" | "decline") => {
    if (approval) submitInteraction(approval.id, decision === "accept" ? approval.acceptResult : approval.declineResult)
  }, [approval, submitInteraction])

  const answerUserInput = useCallback((answers: Record<string, string[]>) => {
    if (!userInputRequest) return
    const payloadAnswers: Record<string, { answers: string[] }> = {}
    for (const [qid, vals] of Object.entries(answers)) payloadAnswers[qid] = { answers: vals }
    submitInteraction(userInputRequest.id, { answers: payloadAnswers })
  }, [userInputRequest, submitInteraction])

  const dismissUserInput = useCallback(() => {
    if (userInputRequest) submitInteraction(userInputRequest.id, { answers: {} })
  }, [userInputRequest, submitInteraction])

  const decideElicitation = useCallback((decision: "accept" | "decline", content?: Record<string, any>) => {
    if (elicitationRequest) submitInteraction(elicitationRequest.id, decision === "accept" ? { action: "accept", content: content || {} } : { action: "decline" })
  }, [elicitationRequest, submitInteraction])

  const interruptRunningTurn = useCallback(async () => {
    const client = clientRef.current
    const threadId = threadRef.current
    if (!client || !threadId) return
    const result = await client.request("thread/read", { threadId, includeTurns: true }) as {
      thread: { turns: Array<{ id: string; status: string }> }
    }
    const activeTurn = result.thread.turns.slice().reverse().find((turn) => turn.status === "inProgress")
    if (!activeTurn) {
      if (isMountedRef.current) setRuntimeState("就緒")
      return
    }
    await client.request("turn/interrupt", { threadId, turnId: activeTurn.id })
    if (isMountedRef.current) setRuntimeState("就緒")
  }, [])

  const executeCompact = useCallback(() => {
    const client = clientRef.current
    const threadId = threadRef.current
    if (!client || !threadId) return
    client.request("thread/compact/start", { threadId }).catch((error) => {
      console.warn("Compact thread failed:", error)
    })
  }, [])

  const uploadFeedback = useCallback(async (messageId: string, classification: "positive" | "negative") => {
    const client = clientRef.current
    const threadId = threadRef.current
    if (!client) return
    try {
      await client.request("feedback/upload", {
        classification,
        reason: classification === "positive" ? "用戶對此回答表示滿意" : "用戶對此回答表示不滿意",
        threadId: threadId || null,
        tags: {
          botId: activeBotRef.current.id,
          messageId,
        },
      })
    } catch (err) {
      console.warn("Feedback upload failed", err)
    }
  }, [])

  const startTurn = useCallback(async (text: string, options: {
    clientMessageId?: string
    images?: string[]
    taskRuntime: RuntimeDetails | null
    mentionedSkills: Array<{ id: string; name: string; path?: string; kind: string }>
  }) => {
    const client = clientRef.current
    const threadId = threadRef.current
    const bot = activeBotRef.current
    if (!client || !threadId) return

    setTurnRunning(true)
    const taskRuntime = options.taskRuntime
    pendingArtifactRef.current = /(?:presentation\.html|簡報|投影片)/i.test(text) &&
      taskRuntime?.environmentId && taskRuntime.tier !== "none"
      ? { path: "/home/user/presentation.html", environmentId: taskRuntime.environmentId, tier: taskRuntime.tier }
      : null

    setAgentState("thinking")
    setRuntimeState("執行中")

    const userInputs: Array<{ type: string; text?: string; text_elements?: unknown[]; name?: string; path?: string; url?: string }> = [
      { type: "text", text, text_elements: [] },
    ]
    for (const url of options.images ?? []) userInputs.push({ type: "image", url })
    for (const s of options.mentionedSkills) {
      if (s.kind === "skill") {
        userInputs.push({ type: "skill", name: s.id, path: s.path || s.id })
      } else {
        userInputs.push({ type: "mention", name: s.id, path: s.id })
      }
    }

    try {
      await client.request("turn/start", {
        threadId,
        clientUserMessageId: options.clientMessageId,
        model: selectedModel,
        ...(modelProviderForRoute(activeBotRef.current.modelRoute) ? { modelProvider: modelProviderForRoute(activeBotRef.current.modelRoute) } : {}),
        input: userInputs as any,
        environments: taskRuntime?.environmentId && taskRuntime.tier !== "none" ? [{
          environmentId: taskRuntime.environmentId,
          cwd: taskRuntime.cwd,
          runtimeWorkspaceRoots: [taskRuntime.cwd],
        }] : [],
      }, bot.id)
    } catch (error) {
      setTurnRunning(false)
      pendingArtifactRef.current = null
      const modelRoute = canonicalModelRoute(activeBotRef.current.modelRoute)
      const modelFailure = isModelRouteFailure(error) || (modelRoute === "genio-gateway" && isCompanyModelPolicyFailure(error))
      if (executionRuntimeRef.current?.environmentId === taskRuntime?.environmentId && !modelFailure && isRuntimePolicyFailure(error)) clearExecutionRuntime()
      if (isMountedRef.current) {
        setRuntimeState(modelFailure ? modelRouteFailureMessage(modelRoute, error) : error instanceof Error ? error.message : "執行失敗")
        setAgentState("exclaim")
      }
      throw error
    }
  }, [clearExecutionRuntime, selectedModel, setTurnRunning])

  const queuePendingExecution = useCallback((task: string, progressId: string, restoreDraft: PendingExecution["restoreDraft"]) => {
    const pending = pendingExecutionRef.current
    const botId = activeBotRef.current.id
    const generation = connectionGenerationRef.current
    const modelRoute = canonicalModelRoute(activeBotRef.current.modelRoute)
    if (pending) {
      const isCurrent = pending.botId === botId && pending.connectionGeneration === generation && pending.modelRoute === modelRoute
      if (isCurrent) return "busy"
      const staleSameBot = pending.botId === botId
      restorePendingExecution()
      if (staleSameBot) return "stale"
      pendingExecutionRef.current = {
        task,
        progressId,
        botId,
        connectionGeneration: generation,
        modelRoute,
        restoreDraft,
      }
      return "queued"
    }
    pendingExecutionRef.current = {
      task,
      progressId,
      botId,
      connectionGeneration: generation,
      modelRoute,
      restoreDraft,
    }
    return "queued"
  }, [restorePendingExecution])

  const pendingExecutionStatus = useCallback(() => {
    const pending = pendingExecutionRef.current
    if (!pending) return "none"
    const botId = activeBotRef.current.id
    const isCurrent = pending.botId === botId
      && pending.connectionGeneration === connectionGenerationRef.current
      && pending.modelRoute === canonicalModelRoute(activeBotRef.current.modelRoute)
    if (isCurrent) return "busy"
    const staleSameBot = pending.botId === botId
    restorePendingExecution()
    return staleSameBot ? "stale" : "none"
  }, [restorePendingExecution])

  return {
    clientRef,
    threadRef,
    runtime,
    runtimeTiers,
    executionRuntime,
    runtimeState,
    setRuntimeState,
    mcpStatus,
    setMcpStatus,
    modelDirectory,
    codexLogin,
    isCodexAuthenticated,
    threadReady,
    channelReady,
    models: modelsRoute === botModelRoute ? models : [],
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
    isTurnRunning: isTurnRunningState,
    startThread,
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
  }
}
