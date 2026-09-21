import { gatewayModelsFromDirectory } from "../../lib/model-route"
import { preferredModel } from "../../../shared/model-selection"
import { readSavedModel } from "../../bots-storage"
import { primaryMcpServer } from "../../lib/primary-mcp-server"
import { isGenioSessionRejection } from "../../../shared/session-rejection"
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react"
import {
  CodexClient,
  runtimeCanExec,
  type CodexModel,
  type RuntimeDetails,
} from "../../lib/codex-client"
import { clearGenioTokens } from "../../lib/genio-one"
import { registerBotArtifactFromRuntime, type ArtifactRef } from "../../lib/bot-api"
import type { BotInstance, ChatMessage } from "../../bots-storage"
import type { StateId } from "../../vendor/bloub/bot/states"
import type { ActivityEntry } from "../panel/RightPanel"
import type { ApprovalRequest } from "./ApprovalCard"
import type { UserInputQuestionRequest } from "./UserInputQuestionCard"
import type { InstallElicitationRequest } from "./InstallElicitationCard"
import type { CodexLogin } from "./ChatMessageList"
import { modelRouteRequiresCodexLogin, runtimeFailureMessage, type ModelRoute } from "../../lib/model-route"
import { belongsToThread } from "./codex-event-scope"

export interface StreamListenerContext {
  isMounted: () => boolean
  safeTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  client: CodexClient
  tokenRef: RefObject<string>
  activeBotRef: RefObject<BotInstance>
  threadRef: RefObject<string | null>
  threadBotIdRef: RefObject<string | null>
  runtimeDetailsRef: MutableRefObject<RuntimeDetails | null>
  completedItemIdsRef: MutableRefObject<Set<string>>
  pendingArtifactRef: MutableRefObject<{ path: string; environmentId: string; tier: "headless" | "desktop" } | null>
  pendingExecutionRef: MutableRefObject<PendingExecution | null>
  isPendingExecutionCurrent?: (pending: PendingExecution) => boolean
  isRuntimePrepared?: (details: RuntimeDetails) => boolean
  modelDirectoryModelsRef: MutableRefObject<CodexModel[]>
  loggedInRef: MutableRefObject<boolean>
  isTurnRunningRef: MutableRefObject<boolean>
  setRuntime: Dispatch<SetStateAction<RuntimeDetails | null>>
  setRuntimeTiers: Dispatch<SetStateAction<Partial<Record<"none" | "headless" | "desktop", RuntimeDetails>>>>
  setRuntimeState: Dispatch<SetStateAction<string>>
  setModelDirectory: Dispatch<SetStateAction<ModelRoute | null>>
  setModels: Dispatch<SetStateAction<CodexModel[]>>
  setSelectedModel: Dispatch<SetStateAction<string>>
  setCodexLogin: Dispatch<SetStateAction<CodexLogin | null>>
  setAgentState: Dispatch<SetStateAction<StateId>>
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>
  setArtifacts: Dispatch<SetStateAction<ArtifactRef[]>>
  setActivities: Dispatch<SetStateAction<ActivityEntry[]>>
  setThreadReady: Dispatch<SetStateAction<boolean>>
  setChannelReady: Dispatch<SetStateAction<boolean>>
  setApproval: Dispatch<SetStateAction<ApprovalRequest | null>>
  setUserInputRequest: Dispatch<SetStateAction<UserInputQuestionRequest | null>>
  setElicitationRequest: Dispatch<SetStateAction<InstallElicitationRequest | null>>
  setMcpStatus: Dispatch<SetStateAction<string>>
  setDynamicSkills: Dispatch<SetStateAction<Array<{ id: string; name: string; description: string; path?: string }>>>
  setTurnRunning: (running: boolean) => void
  prepareCodexSession: () => Promise<void>
  attachRuntimeDesktop: (details: RuntimeDetails) => Promise<void>
  shouldPrepareRuntime?: (details: RuntimeDetails) => boolean
  onMarkBotUnread?: (botId: string) => void
  onBotWorkEvent?: (botId: string, type: "turn_started" | "turn_stopped" | "turn_idle") => void
  onPendingExecutionReady?: (task: string) => void
  onSignOut: () => void
  focusInput: () => void
  startThread: (details?: RuntimeDetails | null) => Promise<boolean>
  setIsCodexAuthenticated?: Dispatch<SetStateAction<boolean>>
}

export interface PendingExecution {
  task: string
  progressId: string
  botId: string
  connectionGeneration: number
  modelRoute: ModelRoute
  restoreDraft: () => void
}

export function registerCodexStreamListeners(ctx: StreamListenerContext): () => void {
  const {
    isMounted,
    safeTimeout,
    client,
    tokenRef,
    activeBotRef,
    runtimeDetailsRef,
    completedItemIdsRef,
    pendingArtifactRef,
    pendingExecutionRef,
    modelDirectoryModelsRef,
    loggedInRef,
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
    onMarkBotUnread,
    onBotWorkEvent,
    onPendingExecutionReady,
    onSignOut,
    focusInput,
  } = ctx
  let runtimeFailure: string | null = null
  let runtimeFailureReason: string | null = null

  const unsubscribeMessage = client.onMessage((message) => {
    if (!isMounted()) return
    if (!belongsToThread(message, ctx.threadBotIdRef.current === activeBotRef.current.id ? ctx.threadRef.current : null)) return

    if (message.method === "genio/pending/reset") {
      setApproval(null)
      setUserInputRequest(null)
      setElicitationRequest(null)
    }
    if (message.method === "serverRequest/resolved") {
      const requestId = (message.params as { requestId?: number }).requestId
      setApproval((current) => current?.id === requestId ? null : current)
      setUserInputRequest((current) => current?.id === requestId ? null : current)
      setElicitationRequest((current) => current?.id === requestId ? null : current)
    }

    if (message.method === "genio/codexReady") {
      const params = message.params as {
        modelDirectory?: string
        models?: Array<{ publicModelId?: string; displayName?: string }>
      } | undefined
      if (params?.modelDirectory === "codex-subscription" || params?.modelDirectory === "genio-gateway") {
        setModelDirectory(params.modelDirectory)
      }
      if (params?.modelDirectory === "genio-gateway" && Array.isArray(params.models)) {
        const directoryModels = gatewayModelsFromDirectory(params.models)
        modelDirectoryModelsRef.current = directoryModels
        setModels(directoryModels)
        setSelectedModel(preferredModel(directoryModels, readSavedModel(activeBotRef.current.id), null))
      }
      void prepareCodexSession().catch((error) => {
        if (isMounted()) {
          setRuntimeState(runtimeFailureMessage(error))
          setAgentState("exclaim")
        }
      })
    }

    if (message.method === "genio/runtime/ready" || message.method === "genio/runtimeReady" || message.method === "genio/execReady") {
      const details = message.params as RuntimeDetails
      if (details.endpoint && details.endpoint.botId !== activeBotRef.current.id) return
      if (details.modelDirectory === "codex-subscription" || details.modelDirectory === "genio-gateway") {
        setModelDirectory(details.modelDirectory)
      }
      const previous = runtimeDetailsRef.current
      const isDuplicateReady = previous?.tier === details.tier &&
        previous.environmentId === details.environmentId &&
        previous.sandboxId === details.sandboxId &&
        previous.execReady === details.execReady
      runtimeDetailsRef.current = details
      setRuntime(details)
      setRuntimeTiers((current) => ({ ...current, [details.tier]: details }))
      runtimeFailure = null
      runtimeFailureReason = null
      if (isDuplicateReady && !ctx.shouldPrepareRuntime?.(details)) return
      setAgentState("idle")
      void (async () => {
        try {
          await attachRuntimeDesktop(details)
          if ((details.tier === "headless" || details.tier === "desktop") && pendingExecutionRef.current) {
            const pendingTask = pendingExecutionRef.current
            safeTimeout(() => {
              if (pendingExecutionRef.current !== pendingTask) return
              if ((ctx.isPendingExecutionCurrent && !ctx.isPendingExecutionCurrent(pendingTask)) ||
                (ctx.isRuntimePrepared && !ctx.isRuntimePrepared(details))) {
                pendingExecutionRef.current = null
                pendingTask.restoreDraft()
                if (activeBotRef.current.id === pendingTask.botId) {
                  setMessages((current) => [...current.filter((m) => m.id !== pendingTask.progressId), {
                    id: `${pendingTask.progressId}-canceled`,
                    localOnly: true,
                    role: "system",
                    text: `工作區狀態已變更；以下工作尚未執行，請重新送出。\n\n${pendingTask.task}`,
                    createdAt: Date.now(),
                  }])
                }
                return
              }
              pendingExecutionRef.current = null
              setMessages((current) => current.filter((m) => m.id !== pendingTask.progressId))
              onPendingExecutionReady?.(pendingTask.task)
            }, 0)
          }
        } catch (error) {
          if (isMounted()) setRuntimeState(error instanceof Error ? error.message : "沙盒連接失敗")
        }
      })()
    }

    if (message.method === "genio/runtime/provisioning") {
      const tier = (message.params as { tier?: string } | undefined)?.tier
      setRuntimeState(tier === "desktop" ? "Desktop 啟動中" : "Headless 啟動中")
      setAgentState("orbit")
    }

    if (message.method === "genio/runtime/stopped") {
      const params = message.params as { tier?: string; active?: RuntimeDetails } | undefined
      const tier = params?.tier
      if (tier === "desktop" || tier === "headless") {
        setRuntimeTiers((current) => {
          const next = { ...current }
          delete next[tier]
          return next
        })
      }
      if (params?.active) {
        setRuntime(params.active)
        setRuntimeTiers((current) => ({ ...current, [params.active!.tier]: params.active! }))
      } else {
        setRuntime((current) => current?.tier === tier ? null : current)
      }
      runtimeFailure = null
      runtimeFailureReason = null
      setRuntimeState("就緒")
    }

    if (message.method === "genio/runtimeError") {
      const params = message.params as { message?: string }
      const reason = params.message || "遠端 runtime 無法使用"
      if (runtimeFailureReason === reason) return
      console.warn("Desktop runtime unavailable:", params.message)
      runtimeFailureReason = reason
      runtimeFailure = runtimeFailureMessage(reason, /\bcodex(?:[._-]?subscription)?\b/i.test(reason) ? "codex" : "request")
      setRuntimeState(runtimeFailure)
      setAgentState("exclaim")
    }

    if (message.method === "genio/runtime/error") {
      const params = message.params as { tier?: string; message?: string }
      const reason = params.message || "runtime 已中斷"
      if (reason.startsWith("LOCAL_HANDS_")) {
        const local = runtimeDetailsRef.current
        if (local?.kind === "endpoint") {
          const disconnected = { ...local, execReady: false }
          runtimeDetailsRef.current = disconnected
          setRuntime(disconnected)
          setRuntimeTiers((current) => ({ ...current, headless: disconnected }))
        }
      }
      runtimeFailureReason = reason
      runtimeFailure = runtimeFailureMessage(reason, params.tier ? "runtime" : /\bcodex(?:[._-]?subscription)?\b/i.test(reason) ? "codex" : "request")
      setRuntimeState(`${params.tier === "desktop" ? "Desktop" : "Headless"}：${runtimeFailure}`)
      if (reason === "BOT_CONNECTION_DISABLED" || reason.startsWith("PERSONAL_BOT") || /\bcodex(?:[._-]?subscription)?\b/i.test(reason)) {
        setThreadReady(false)
        setChannelReady(false)
        setTurnRunning(false)
      }
      setAgentState("exclaim")
    }

    if (message.method === "account/login/completed") {
      const params = message.params as { success: boolean }
      if (params.success && modelRouteRequiresCodexLogin(activeBotRef.current.modelRoute)) {
        loggedInRef.current = true
        setIsCodexAuthenticated?.(true)
        setCodexLogin(null)
        if (runtimeDetailsRef.current) {
          void attachRuntimeDesktop(runtimeDetailsRef.current).catch((error) => {
            if (isMounted()) setRuntimeState(error instanceof Error ? error.message : "啟動失敗")
          })
        } else {
          setRuntimeState("就緒 (等待電腦環境)")
        }
      }
    }

    if (message.method === "item/agentMessage/delta") {
      setAgentState("thinking")
      const payload = message.params as { threadId: string; itemId: string; delta: string; genioTimelineItem?: ChatMessage }
      const params = { ...payload, itemId: `${payload.threadId}:${payload.itemId}` }
      if (completedItemIdsRef.current.has(params.itemId)) return
      setMessages((current) => {
        const existing = current.find((item) => item.id === params.itemId)
        if (payload.genioTimelineItem) {
          const canonical = payload.genioTimelineItem
          if (existing && (existing.timelineRevision ?? 0) >= (canonical.timelineRevision ?? 0)) return current
          return existing ? current.map((item) => item.id === canonical.id ? canonical : item) : [...current, canonical]
        }
        if (existing) return current.map((item) => item.id === params.itemId ? { ...item, text: item.text + params.delta } : item)
        return [...current, { id: params.itemId, role: "assistant", text: params.delta, createdAt: Date.now() }]
      })
    }

    if (message.method === "item/reasoning/textDelta" || message.method === "item/reasoning/summaryTextDelta") {
      setAgentState("thinking")
    }

    if (message.method === "turn/completed") {
      setTurnRunning(false)
      {
        const botId = activeBotRef.current?.id || ""
        const paramsEarly = message.params as { turn?: { status?: string; error?: unknown } }
        const failedEarly = paramsEarly.turn?.status === "failed"
        const interruptedEarly = paramsEarly.turn?.status === "interrupted"
        if (failedEarly || interruptedEarly) onBotWorkEvent?.(botId, "turn_stopped")
        else if (typeof document !== "undefined" && document.hidden) onMarkBotUnread?.(botId)
        else onBotWorkEvent?.(botId, "turn_idle")
      }
      const params = message.params as { turn?: { status?: string; error?: unknown } }
      const failed = params.turn?.status === "failed"
      const interrupted = params.turn?.status === "interrupted"
      const artifactIntent = pendingArtifactRef.current
      if (failed || interrupted) pendingArtifactRef.current = null
      setRuntimeState(failed ? runtimeFailureMessage(params.turn?.error ?? "執行失敗") : interrupted ? "執行中止" : "就緒")
      if (failed || interrupted) {
        setAgentState("exclaim")
        if (interrupted) {
          setMessages((current) => {
            const lastMsg = current[current.length - 1]
            if (lastMsg && lastMsg.role === "user") {
              return [
                ...current,
                {
                  id: `interrupted-${Date.now()}`,
                  role: "assistant",
                  text: "⚠️ 此輪執行已中止（連線中斷或伺服器重新啟動）。請重新送出提問。",
                  createdAt: Date.now(),
                },
              ]
            }
            return current
          })
        }
      } else {
        setAgentState("wink")
        if (artifactIntent && tokenRef.current && activeBotRef.current) {
          pendingArtifactRef.current = null
          void registerBotArtifactFromRuntime(tokenRef.current, activeBotRef.current.id, {
            sourceTier: artifactIntent.tier,
            sourceEnvironmentId: artifactIntent.environmentId,
            path: artifactIntent.path,
            contentType: "text/html",
          }).then((artifact) => {
            if (!isMounted()) return
            setArtifacts((current) => [artifact, ...current.filter((item) => item.artifactId !== artifact.artifactId)])
            setActivities((current) => [{
              id: artifact.artifactId,
              kind: "file",
              title: "已保存 Server 產物",
              detail: `${artifact.path} · ${artifact.digest.slice(0, 18)}`,
              status: "done",
            }, ...current])
          }).catch((error) => {
            if (!isMounted()) return
            setActivities((current) => [{
              id: `artifact-failed-${Date.now()}`,
              kind: "file",
              title: "產物保存失敗",
              detail: error instanceof Error ? error.message : "ARTIFACT_CAPTURE_FAILED",
              status: "failed",
            }, ...current])
          })
        }
        safeTimeout(() => {
          setAgentState((current) => (current === "wink" ? "idle" : current))
        }, 1600)
      }
      safeTimeout(focusInput, 50)
    }

    if (message.method === "turn/started") {
      setTurnRunning(true)
      setAgentState("thinking")
      onBotWorkEvent?.(activeBotRef.current?.id || "", "turn_started")
    }

    if (message.method === "item/commandExecution/requestApproval" || message.method === "item/fileChange/requestApproval") {
      const hasExec = runtimeCanExec(runtimeDetailsRef.current)
      if (!hasExec) {
        void client.respond(message.id as number, { decision: "decline" }).catch((error) => setRuntimeState(error instanceof Error ? error.message : "回覆未送出"))
        setActivities((current) => [{
          id: `cmd-denied-${Date.now()}`,
          kind: "command",
          title: "已攔截主機指令",
          detail: "遠端沙盒尚未就緒：禁止在 Bot 主機執行指令",
          status: "done",
        }, ...current])
        return
      }
      const params = message.params as { reason?: string }
      setApproval({
        id: message.id as number,
        method: message.method,
        reason: params.reason || "Codex 要執行受保護的操作",
        acceptResult: { decision: "accept" },
        declineResult: { decision: "decline" },
      })
      setAgentState("alert")
    }

    if (message.method === "item/tool/requestUserInput") {
      const params = message.params as {
        isBlocking?: boolean
        threadId?: string
        turnId?: string
        itemId?: string
        questions?: Array<{
          id: string
          header?: string
          question: string
          isOther?: boolean
          isSecret?: boolean
          options?: Array<{ label: string; description?: string }> | null
        }>
      }
      if (params?.questions && params.questions.length > 0) {
        setUserInputRequest({
          id: message.id as number,
          threadId: params.threadId,
          turnId: params.turnId,
          itemId: params.itemId,
          questions: params.questions,
          isBlocking: params.isBlocking !== false,
        })
        setAgentState("alert")
      }
    }

    if (message.method === "mcpServer/elicitation/request") {
      const params = message.params as {
        threadId?: string
        turnId?: string | null
        serverName?: string
        message?: string
        mode?: "form" | "openai/form" | "openaiForm" | "url"
        requestedSchema?: {
          properties?: Record<string, {
            type?: string
            title?: string
            description?: string
            default?: any
            format?: string
            enum?: string[]
          }>
        }
        url?: string
      }
      if (params) {
        setElicitationRequest({
          id: message.id as number,
          threadId: params.threadId,
          turnId: params.turnId,
          serverName: params.serverName || "MCP",
          message: params.message || "此工具需要補充設定資訊",
          mode: params.mode || "form",
          properties: params.requestedSchema?.properties,
          url: params.url,
        })
        setAgentState("alert")
      }
    }

    if (message.method === "mcpServer/startupStatus/updated") {
      const params = message.params as { name: string; status: string; error?: string | null }
      if (params.name === primaryMcpServer(activeBotRef.current.bindings)) {
        setMcpStatus(params.status === "ready" ? "已連線" : params.error || params.status)
      }
    }

    if (message.method === "skills/changed") {
      client.request("skills/list", {}).then((res: unknown) => {
        const resData = (res as { data?: Array<{ skills?: Array<{ name: string; description: string; path: string }> }> })?.data
        if (resData && isMounted()) {
          const mapped = resData.flatMap((d) => d.skills || []).map((s) => ({
            id: s.name,
            name: s.name,
            description: s.description,
            path: s.path,
          }))
          setDynamicSkills(mapped)
        }
      }).catch(() => {})
    }

    if (message.method === "item/started" || message.method === "item/completed") {
      const params = message.params as {
        genioTimelineItem?: ChatMessage
        item?: {
          id?: string
          type?: string
          server?: string
          tool?: string
          command?: string
          content?: Array<{ type?: string; text?: string }>
          text?: string
          query?: string
          action?: { type?: string; query?: string; url?: string; queries?: string[] }
        }
      }
      const nativeItem = params.item
      const item = nativeItem ? { ...nativeItem, id: `${ctx.threadRef.current}:${nativeItem.id}` } : undefined
      if (params.genioTimelineItem) {
        const canonical = params.genioTimelineItem
        setMessages((current) => {
          const existing = current.find((entry) => entry.id === canonical.id)
          if (existing && (existing.timelineRevision ?? 0) >= (canonical.timelineRevision ?? 0)) return current
          const accepted = current.filter((entry) => !canonical.clientMessageId || entry.clientMessageId !== canonical.clientMessageId || entry.id === canonical.id)
          return existing ? accepted.map((entry) => entry.id === canonical.id ? canonical : entry) : [...accepted, canonical]
        })
      }
      if (message.method === "item/completed" && item?.id && (item.type === "agentMessage" || item.type === "AgentMessage")) {
        completedItemIdsRef.current.add(item.id)
        const fullText = item.text || item.content?.map((c) => c.text ?? "").join("") || ""
        if (fullText && !params.genioTimelineItem) {
          setMessages((current) => {
            const existing = current.find((msg) => msg.id === item.id)
            if (existing) return current.map((msg) => msg.id === item.id ? { ...msg, text: fullText } : msg)
            return [...current, { id: item.id!, role: "assistant", text: fullText, createdAt: Date.now() }]
          })
        }
      }
      const isWebSearch = item?.type === "webSearch" || item?.type === "WebSearch"
      if (!item?.id || !item.type || (!["mcpToolCall", "commandExecution", "fileChange"].includes(item.type) && !isWebSearch)) return

      let kind: ActivityEntry["kind"] = "mcp"
      let title = "外部操作"
      let detail = ""

      if (isWebSearch) {
        kind = "web"
        const queryText = item.query || item.action?.query || item.action?.url || "即時資訊"
        title = `網路檢索 · ${queryText}`
        detail = item.action?.type === "open_page" ? "開啟外部網頁分析內容" : "搜尋即時新聞與公開資料"
      } else if (item.type === "mcpToolCall") {
        kind = "mcp"
        title = `${item.server ?? "MCP"} · ${item.tool ?? "tool"}`
        detail = "經 One Policy 執行"
      } else if (item.type === "commandExecution") {
        kind = "command"
        title = "執行指令"
        detail = item.command ?? "Managed Desktop"
      } else {
        kind = "file"
        title = "更新檔案"
        detail = "Managed Desktop workspace"
      }

      const activity: ActivityEntry = { id: item.id, title, detail, status: message.method === "item/completed" ? "done" : "running", kind }
      setActivities((current) => [activity, ...current.filter((entry) => entry.id !== item.id)].slice(0, 6))
      setAgentState(message.method === "item/started" ? "orbit" : "thinking")
      if (isWebSearch && message.method === "item/started") {
        setRuntimeState("網路搜尋中...")
      }
    }
  })

  const unsubscribeStatus = client.onStatusChange((status) => {
    if (!isMounted()) return
    if (status === "connecting") {
      runtimeFailure = null
      runtimeFailureReason = null
    } else if (status === "reconnecting") {
      runtimeFailure = null
      runtimeFailureReason = null
      setRuntimeState("網路重連中...")
      setThreadReady(false)
      setAgentState("comet")

    } else if (status === "disconnected") {
      if (runtimeFailure) {
        setRuntimeState(runtimeFailure)
        setAgentState("exclaim")
      } else {
        setRuntimeState("連線中斷")
        setAgentState("sleep")
      }

    } else if (status === "connected") {
      runtimeFailure = null
      runtimeFailureReason = null
      setAgentState("idle")
      setRuntimeState("正在恢復連線")
    }
  })

  const unsubscribeClose = client.onClose((event) => {
    if (isGenioSessionRejection(event.reason)) {
      console.warn("Session rejected by server, signing out...")
      clearGenioTokens()
      onSignOut()
    } else if (event.code === 1008) {
      console.warn(JSON.stringify({ event: "bot.runtime.access_blocked", reason: event.reason }))
      setRuntimeState(event.reason?.startsWith("PERSONAL_BOT") ? "目前帳號尚未取得 Bot 使用權限" : event.reason || "執行環境暫時無法使用")
    }
  })

  return () => {
    unsubscribeMessage()
    unsubscribeStatus()
    unsubscribeClose()
  }
}
