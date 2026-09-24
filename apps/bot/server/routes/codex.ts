import { observationContext, observeOperation } from "@genioone/telemetry/operation-observability"
import { traceIdentity } from "@genioone/telemetry/otlp-observability"
import { defaultRuntimeCapabilityAction } from "@genioone/protocol/runtime-capability-actions"
import { canonicalizeNativeParams } from "../native-runtime-params"
import { nativeRuntimeEnvironment, ownedRuntimeEnvironment } from "../native-runtime-environment"
import { createRuntimePolicyLifecycle } from "../runtime-policy-lifecycle"
import type { FastifyInstance } from "fastify"

import { assertCapability, CapabilityDeniedError, PERSONAL_BOT_COMPUTER_USE, PERSONAL_BOT_USE } from "../capability-gate"
import { desktopBrowserGrants, proxiedDesktopUrl } from "../desktop-proxy"
import { verifyGenioOneAccessToken } from "../auth"
import { configuredRuntimeKind, pendingRuntimeDetails, createCodexRuntime as defaultCreateCodexRuntime, type CodexRuntime, type RuntimeDetails, type RuntimeTier } from "../runtime"
import { setBotSelection, setManagedMcpMounts, type RuntimeSession } from "../runtime-broker"
import type { BotServerContext } from "../context"
import type { BotModelPlan } from "../model-directory"
import { botTurnContext } from "../bot-context"
import { BotUsageContextError, resolveBotUsageContext } from "../usage-context"
import { emitBotFeedbackLog } from "../telemetry"
import {
  type RuntimePolicyCapabilityId,
  type RuntimePolicyDecision,
  type RuntimePolicyExecutableAction,
} from "../runtime-policy-contract"
import { isManagedMcpServerName, managedMcpConfig, resolveManagedMcpMounts, type ManagedMcpMounts } from "../managed-mcp"
import { BotConnectionInteractions } from "../bot-connection-interactions"
import {
  readNativeRuntimeExposure,
  type NativeRuntimeEnvironment,
  type NativeRuntimeExposure,
} from "../native-runtime-policy"

const HOST_EXECUTION_REQUESTS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
])

const HOST_EXECUTION_COMMANDS = new Set([
  "command/exec",
  "command/exec/write",
  "command/exec/terminate",
  "command/exec/resize",
  "process/spawn",
  "process/writeStdin",
  "process/kill",
  "process/resizePty",
  "thread/shellCommand",
  "thread/backgroundTerminals/clean",
  "thread/backgroundTerminals/list",
  "thread/backgroundTerminals/terminate",
  "fs/readFile",
  "fs/writeFile",
  "fs/createDirectory",
  "fs/getMetadata",
  "fs/readDirectory",
  "fs/remove",
  "fs/copy",
  "fs/watch",
  "fs/unwatch",
])

const CODEX_SUBSCRIPTION_CAPABILITY = "codex.subscription" as const
const SHELL_EXEC_CAPABILITY = "shell.exec" as const

const SUPPORTED_CLIENT_METHODS = new Set([
  "initialize",
  "initialized",
  "genio/runtime/start",
  "genio/runtime/status",
  "genio/runtime/ensure",
  "genio/runtime/ensureExec",
  "genio/runtime/stop",
  "genio/bot/select",
  "genio/thread/pending",
  "genio/request/respond",
  "genio/personalConnection/complete",
  "genio/personalConnection/cancel",
  "model/list",
  "account/read",
  "account/login/start",
  "account/login/cancel",
  "thread/start",
  "thread/resume",
  "thread/read",
  "thread/turns/list",
  "thread/compact/start",
  "turn/start",
  "turn/interrupt",
  "thread/realtime/start",
  "thread/realtime/stop",
  "thread/realtime/appendAudio",
  "thread/realtime/appendText",
  "thread/realtime/appendSpeech",
  "thread/realtime/listVoices",
  "skills/list",
  "environment/add",
  "environment/info",
  "mcpServerStatus/list",
  "config/mcpServer/reload",
  "feedback/upload",
])

function hostExecutionCapability(method: string): RuntimePolicyCapabilityId {
  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") return "filesystem.write"
  return SHELL_EXEC_CAPABILITY
}

function runtimeExecutionAction(capabilityId: RuntimePolicyCapabilityId): RuntimePolicyExecutableAction {
  const action = defaultRuntimeCapabilityAction(capabilityId)
  if (!action) throw new Error("RUNTIME_POLICY_CAPABILITY_INVALID")
  return action
}

function nativeMethodRequiresSelection(method: string): boolean {
  return method === "model/list" || method === "mcpServerStatus/list" || method === "modelProvider/capabilities/read" || method.startsWith("account/")
}

function isAccountMethodAllowed(method: string, modelRoute: "codex-subscription" | "genio-gateway"): boolean {
  return modelRoute === "codex-subscription" && (method === "account/read" || method === "account/login/start" || method === "account/login/cancel")
}

function isManagedMcpConfigKey(key: string) {
  if (!key.startsWith("mcp_servers.")) return false
  return isManagedMcpServerName(key.slice("mcp_servers.".length).split(".", 1)[0])
}

export async function codexRoutes(app: FastifyInstance, context: BotServerContext) {
  const { runtimeBroker, capabilityGate, modelDirectory, botRegistry, runtimePolicy } = context
  const makeCodexRuntime = context.createCodexRuntime ?? defaultCreateCodexRuntime
  const desktopUrl = (session: RuntimeSession, details: RuntimeDetails = session.details) => proxiedDesktopUrl(
    session.id,
    details.desktopUrl,
    desktopBrowserGrants.issue(runtimeBroker, session.id),
  )
  const runtimeDetailsForClient = (session: RuntimeSession, details: RuntimeDetails) => {
    if (details.tier !== "desktop") return details
    const desktop = session.leases.desktop
    return {
      ...details,
      desktopUrl: desktop?.details === details ? desktopUrl(session, desktop.details) : null,
    }
  }
  const runtimeDetailsForBot = (session: RuntimeSession, botId: string | null): RuntimeDetails => {
    const leases = Object.values(session.leases)
    const active = leases.find((lease) => lease?.details === session.details && lease.details.execReady && (lease.details.botId ?? lease.details.endpoint?.botId) === botId)
      ?? leases.find((lease) => lease?.details.execReady && (lease.details.botId ?? lease.details.endpoint?.botId) === botId)
    if (active) return active.details
    const workspace = botId ? context.workspaces.active(session.principal, botId) : null
    return { ...pendingRuntimeDetails(workspace?.provider ?? configuredRuntimeKind()), botId, workspaceId: workspace?.workspaceId ?? null, workspaceRevision: workspace?.revision ?? null }
  }

  app.get("/api/codex", { websocket: true }, (socket) => {
    let closed = false
    let runtimeSession: RuntimeSession | null = null
    let codexRuntime: CodexRuntime | null = null
    let sessionAccessToken: string | null = null
    let starting = false
    let selectedBotId: string | null = null
    const authorizeHandsUse = async (session: RuntimeSession, botId: string, details: RuntimeDetails) => {
      const actor = { principal: session.principal, botId, accessToken: sessionAccessToken ?? session.accessToken ?? "", sessionId: session.id }
      if (details.kind === "endpoint") return context.handsPlacement.authorizeLocalEndpoint(actor)
      if (details.kind !== "e2b-self-hosted" && details.kind !== "cloudflare-hands") return
      const workspace = details.workspaceId ? context.workspaces.get(session.principal, botId, details.workspaceId) : null
      if (!workspace || workspace.provider !== details.kind) throw new Error("RUNTIME_WORKSPACE_NOT_OWNED")
      await context.handsPlacement.authorizeUse(actor, workspace.provider)
    }
    let botSelectionVersion = 0
    const botRequests = new Map<number | string, { method: string; botId: string; session: RuntimeSession; threadId?: string; historyRevision: number; runtimeTier?: RuntimeTier; authorizations: RuntimePolicyDecision[] }>()
    const pendingHostAuthorizations = new Map<number | string, { session: RuntimeSession; botId: string; decision: RuntimePolicyDecision }>()
    const turnClaims = new Map<number | string, () => void>()
    const pendingInbound: string[] = []
    let bootstrapTimer: ReturnType<typeof setTimeout> | null = null
    let connectionUnsubscribe: (() => void) | null = null

    const subscribeConnectionInteractions = () => {
      connectionUnsubscribe?.()
      connectionUnsubscribe = null
      const session = runtimeSession
      const botId = selectedBotId
      if (!session || !botId) return
      const interactions = context.connectionInteractions ??= new BotConnectionInteractions()
      connectionUnsubscribe = interactions.subscribe({
        principal: session.principal,
        botId,
        runtimeSessionId: session.id,
        send: (request) => {
          if (closed || runtimeSession !== session || selectedBotId !== request.botId || socket.readyState !== socket.OPEN) return
          socket.send(JSON.stringify({ method: "genio/personalConnection/request", params: request }))
        },
        expire: (request) => {
          if (closed || runtimeSession !== session || socket.readyState !== socket.OPEN) return
          socket.send(JSON.stringify({ method: "genio/personalConnection/expired", params: { requestToken: request.requestToken, botId: request.botId, threadId: request.threadId } }))
        },
      })
    }

    const showRuntimeReportFailure = () => {
      if (socket.readyState !== socket.OPEN) return
      socket.send(JSON.stringify({ method: "genio/runtime/error", params: { message: "RUNTIME_POLICY_REPORT_UNAVAILABLE" } }))
      socket.send(JSON.stringify({ method: "genio/runtimeError", params: { message: "RUNTIME_POLICY_REPORT_UNAVAILABLE" } }))
    }

    const { authorize: authorizeRuntime, report: reportRuntimeDecision } = createRuntimePolicyLifecycle({
      policy: runtimePolicy,
      accessToken: () => sessionAccessToken,
      onReportFailure: showRuntimeReportFailure,
    })

    const authorizeManagedMcpExposure = async (
      session: RuntimeSession,
      botId: string,
      mounts: ManagedMcpMounts = {},
      isCurrent: () => boolean,
      outcome: "ALLOW" | "COMPLETED",
      reasonCode: string,
    ) => {
      const allowed: ManagedMcpMounts = {}
      for (const [resourceId, mount] of Object.entries(mounts)) {
        try {
          const decision = await authorizeRuntime(session, botId, "mcp.invoke", "expose", isCurrent)
          if (!await reportRuntimeDecision(session, botId, decision, outcome, reasonCode, isCurrent)) {
            throw new Error("RUNTIME_POLICY_REPORT_UNAVAILABLE")
          }
          allowed[resourceId] = mount
        } catch (error) {
          console.warn(JSON.stringify({
            event: "bot.managed-mcp.exposure_denied",
            runtime_session_id: session.id,
            bot_id: botId,
            resource_id: resourceId,
            reason: error instanceof Error ? error.message : "RUNTIME_POLICY_DENIED",
          }))
        }
      }
      return allowed
    }

    const sendRuntimePolicyError = (message: string, tier?: RuntimeTier, id?: number | string) => {
      if (socket.readyState !== socket.OPEN) return
      if (id !== undefined) socket.send(JSON.stringify({ id, error: { code: message, message } }))
      socket.send(JSON.stringify({ method: "genio/runtime/error", params: { ...(tier ? { tier } : {}), message } }))
      socket.send(JSON.stringify({ method: "genio/runtimeError", params: { message } }))
    }

    const runtimeCallbacks = {
      onMessage(runtimeMessage: string) {
        let parsed: { method?: string; id?: number | string; params?: any; result?: any; error?: { code?: number; message?: string } } | null = null
        try { parsed = JSON.parse(runtimeMessage) } catch {}
        let holdResponseForReport = false
        if (parsed?.id !== undefined && !parsed.method) {
          const release = turnClaims.get(parsed.id)
          turnClaims.delete(parsed.id)
          const pending = botRequests.get(parsed.id)
          if (pending?.method === "turn/start" && parsed.result?.turn && pending.threadId) botRegistry.recordRuntimeEvent(pending.session.principal, JSON.stringify({ method: "turn/started", params: { threadId: pending.threadId, turn: parsed.result.turn } }))
          release?.()
          botRequests.delete(parsed.id)
          if (pending?.authorizations.length) {
            const outcome = parsed.error !== undefined ? "FAILED" : parsed.result !== undefined ? "ALLOW" : "FAILED"
            holdResponseForReport = true
            const responsePayload = runtimeMessage
            void Promise.all(pending.authorizations.map((decision) => reportRuntimeDecision(pending.session, pending.botId, decision, outcome, parsed!.error?.message)))
              .then((reported) => {
                if (socket.readyState !== socket.OPEN) return
                if (reported.every(Boolean)) {
                  socket.send(responsePayload)
                } else {
                  socket.send(JSON.stringify({ id: parsed!.id, error: { code: "RUNTIME_POLICY_REPORT_UNAVAILABLE", message: "Runtime 執行結果尚未完成稽核確認。" } }))
                }
              })
          }
          if (pending?.threadId && parsed.error?.code === -32600 && /^no rollout found for thread id [a-zA-Z0-9-]+$/.test(parsed.error.message ?? "")) {
            botRegistry.setThreadHistoryStatus(pending.botId, pending.threadId, "unavailable")
          }
          if (pending?.method === "mcpServerStatus/list" && Array.isArray(parsed.result?.data)) {
            parsed = { ...parsed, result: { ...parsed.result, data: parsed.result.data.filter((server: any) => isManagedMcpServerName(server?.name)) } }
            runtimeMessage = JSON.stringify(parsed)
          }
          if (pending && parsed.result) {
            const threadId = parsed.result.thread?.id ?? pending.threadId
            if (pending.method === "turn/start" && parsed.result.turn?.id && threadId) botRegistry.saveSession({ botId: pending.botId, appServerThreadId: threadId, activeRuntimeTier: pending.runtimeTier })
            if (pending.method === "thread/start" && threadId) botRegistry.rememberThread(pending.botId, threadId)
            const turns = pending.method === "thread/turns/list" ? parsed.result.data : parsed.result.thread?.turns
            if (threadId && Array.isArray(turns)) {
              botRegistry.importRuntimeHistory(pending.botId, threadId, turns, pending.historyRevision)
              if (pending.method === "thread/turns/list" && !parsed.result.nextCursor) botRegistry.setThreadHistoryStatus(pending.botId, threadId, "ready")
            }
          }
        }
        if (holdResponseForReport) return
        if (parsed?.params?.threadId && runtimeSession && (!selectedBotId || !botRegistry.ownsThread(runtimeSession.principal, selectedBotId, parsed.params.threadId))) return
        if (parsed?.id !== undefined && parsed.method && parsed.params?.threadId && runtimeSession) {
          const pending = runtimeBroker.pendingInteractions(runtimeSession.id, parsed.params.threadId).find((entry) => entry.id === parsed!.id)
          if (pending) runtimeMessage = JSON.stringify(pending)
        }
        if (parsed?.method && ["item/agentMessage/delta", "item/started", "item/completed"].includes(parsed.method) && selectedBotId && typeof parsed.params?.threadId === "string" && typeof parsed.params?.turnId === "string") {
          const itemId = parsed.params.itemId ?? parsed.params.item?.id
          const item = botRegistry.timeline.readTurn(selectedBotId, parsed.params.threadId, parsed.params.turnId).find((item) => item.id === `${parsed.params.threadId}:${itemId}`)
          if (item) runtimeMessage = JSON.stringify({ ...parsed, params: { ...parsed.params, genioTimelineItem: item } })
        }
        if (parsed?.method && HOST_EXECUTION_REQUESTS.has(parsed.method) && runtimeSession?.details.tier === "none") {
          void codexRuntime?.send(JSON.stringify({ id: parsed.id, result: { decision: "decline" } }))
          const session = runtimeSession
          const botId = selectedBotId
          if (session && botId && parsed.id !== undefined) {
            const capabilityId = hostExecutionCapability(parsed.method)
            void authorizeRuntime(session, botId, capabilityId, runtimeExecutionAction(capabilityId))
              .then((decision) => reportRuntimeDecision(session, botId, decision, "FAILED", "REMOTE_RUNTIME_REQUIRED"))
              .catch(() => {})
          }
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ method: "genio/runtime/blockedHostCommand", params: { method: parsed.method, reason: "REMOTE_RUNTIME_REQUIRED" } }))
          }
          return
        }
        if (parsed?.method && HOST_EXECUTION_REQUESTS.has(parsed.method)) {
          const session = runtimeSession
          const botId = selectedBotId
          if (!session || !botId) {
            void codexRuntime?.send(JSON.stringify({ id: parsed.id, result: { decision: "decline" } }))
            if (socket.readyState === socket.OPEN) {
              socket.send(JSON.stringify({ method: "genio/runtime/blockedHostCommand", params: { method: parsed.method, reason: "BOT_REQUIRED" } }))
            }
            return
          }
          const requestId = parsed.id
          const capabilityId = hostExecutionCapability(parsed.method)
          void authorizeRuntime(session, botId, capabilityId, runtimeExecutionAction(capabilityId))
            .then(async (decision) => {
              if (requestId === undefined || socket.readyState !== socket.OPEN) {
                await reportRuntimeDecision(session, botId, decision, "FAILED", requestId === undefined ? "RUNTIME_HOST_REQUEST_ID_REQUIRED" : "RUNTIME_SOCKET_CLOSED")
                return
              }
              pendingHostAuthorizations.set(requestId, { session, botId, decision })
              try {
                socket.send(runtimeMessage)
              } catch (error) {
                pendingHostAuthorizations.delete(requestId)
                await reportRuntimeDecision(session, botId, decision, "FAILED", error instanceof Error ? error.message : "RUNTIME_HOST_REQUEST_FORWARD_FAILED")
              }
            })
            .catch((error) => {
              if (requestId !== undefined) void codexRuntime?.send(JSON.stringify({ id: requestId, result: { decision: "decline" } }))
              if (socket.readyState === socket.OPEN) {
                socket.send(JSON.stringify({ method: "genio/runtime/blockedHostCommand", params: { method: parsed.method, reason: error instanceof Error ? error.message : "RUNTIME_POLICY_DENIED" } }))
              }
            })
          return
        }
        if (socket.readyState === socket.OPEN) socket.send(runtimeMessage)
      },
      onExit(reason: string) {
        for (const release of turnClaims.values()) release()
        turnClaims.clear()
        if (socket.readyState === socket.OPEN) socket.close(1011, reason.slice(0, 120))
      },
    }

    const handleMessage = async (payload: unknown) => {
      let message: { id?: number | string; method?: string; params?: any; result?: any; error?: { code?: number; message?: string }; genioBotId?: string } | null = null
      try {
        message = JSON.parse(String(payload))
      } catch {}

      if (codexRuntime) {
        if (!message) {
          sendRuntimePolicyError("RUNTIME_MESSAGE_INVALID")
          return
        }
        if (message.method && !SUPPORTED_CLIENT_METHODS.has(message.method)) {
          sendRuntimePolicyError("RUNTIME_METHOD_NOT_ALLOWED", undefined, message.id)
          return
        }
        if (message) {
          const requestAuthorizations: RuntimePolicyDecision[] = []
          if (message.id !== undefined && !message.method) {
            const pendingHost = pendingHostAuthorizations.get(message.id)
            if (pendingHost) {
              pendingHostAuthorizations.delete(message.id)
              const { genioBotId: _botId, ...nativeResponse } = message
              const responseDecision = message.result?.decision
              const outcome = message.error !== undefined || responseDecision === "decline" || responseDecision === "denied"
                ? "FAILED"
                : message.result !== undefined ? "ALLOW" : "FAILED"
              const reported = await reportRuntimeDecision(pendingHost.session, pendingHost.botId, pendingHost.decision, outcome, outcome === "FAILED" ? "RUNTIME_HOST_APPROVAL_DECLINED" : undefined)
              if (outcome === "ALLOW" && !reported) {
                await codexRuntime.send(JSON.stringify({ id: message.id, result: { decision: "decline" } }))
                return
              }
              try {
                await codexRuntime.send(JSON.stringify(nativeResponse))
              } catch (error) {
                return
              }
              return
            }
          }
          if (message.method && nativeMethodRequiresSelection(message.method)) {
            if (!selectedBotId || !runtimeSession) {
              sendRuntimePolicyError("BOT_NOT_SELECTED", undefined, message.id)
              return
            }
            const selectedBot = botRegistry.getOwned(selectedBotId, runtimeSession.principal)
            if (!selectedBot || (message.method.startsWith("account/") && !isAccountMethodAllowed(message.method, selectedBot.modelRoute))) {
              sendRuntimePolicyError("RUNTIME_NATIVE_METHOD_FORBIDDEN", undefined, message.id)
              return
            }
            if (message.method.startsWith("account/") && selectedBot.modelRoute === "codex-subscription") {
              try {
                requestAuthorizations.push(await authorizeRuntime(runtimeSession, selectedBotId, CODEX_SUBSCRIPTION_CAPABILITY, "use"))
              } catch (error) {
                sendRuntimePolicyError(error instanceof Error ? error.message : "RUNTIME_POLICY_DENIED", undefined, message.id)
                return
              }
            }
          }
          if (message.method === "genio/thread/pending" || message.method === "genio/request/respond") {
            const botId = selectedBotId
            const threadId = message.params?.threadId
            if (!runtimeSession || !botId || typeof threadId !== "string" || !botRegistry.ownsThread(runtimeSession.principal, botId, threadId)) {
              socket.send(JSON.stringify({ id: message.id, error: { code: "BOT_THREAD_NOT_OWNED" } }))
              return
            }
            try {
              if (message.method === "genio/thread/pending") {
                const connectionRequests = context.connectionInteractions?.pendingRequests({ principal: runtimeSession.principal, botId, runtimeSessionId: runtimeSession.id, threadId }) ?? []
                socket.send(JSON.stringify({ id: message.id, result: [
                  ...runtimeBroker.pendingInteractions(runtimeSession.id, threadId),
                  ...connectionRequests.map((request) => ({ method: "genio/personalConnection/request", params: request })),
                ] }))
              } else {
                await runtimeBroker.respondToInteraction(runtimeSession.id, threadId, message.params?.requestToken, message.params?.result)
                socket.send(JSON.stringify({ id: message.id, result: { accepted: true } }))
              }
            } catch (error) {
              socket.send(JSON.stringify({ id: message.id, error: { code: error instanceof Error ? error.message : "BOT_INTERACTION_FAILED" } }))
            }
            return
          }
          if (message.method === "genio/personalConnection/complete" || message.method === "genio/personalConnection/cancel") {
            const session = runtimeSession
            const botId = selectedBotId
            if (!session || !botId || !botRegistry.getOwned(botId, session.principal)) {
              socket.send(JSON.stringify({ id: message.id, error: { code: "BOT_CONNECTION_REQUEST_FORBIDDEN" } }))
              return
            }
            const interactions = context.connectionInteractions ??= new BotConnectionInteractions()
            try {
              const base = {
                principal: session.principal,
                runtimeSessionId: session.id,
                requestToken: message.params?.requestToken,
                botId: message.params?.botId,
                threadId: message.params?.threadId,
              }
              if (message.method === "genio/personalConnection/cancel") {
                interactions.cancel(base)
                socket.send(JSON.stringify({ id: message.id, result: { cancelled: true } }))
              } else {
                await interactions.complete({
                  ...base,
                  resourceId: message.params?.resourceId,
                  connectionId: message.params?.connectionId,
                  status: message.params?.status,
                  accessToken: sessionAccessToken ?? session.accessToken ?? "",
                })
                socket.send(JSON.stringify({ id: message.id, result: { completed: true } }))
              }
            } catch (error) {
              socket.send(JSON.stringify({ id: message.id, error: { code: error instanceof Error ? error.message : "BOT_CONNECTION_INTERACTION_FAILED" } }))
            }
            return
          }
          if (message.id !== undefined && !message.method) {
            socket.send(JSON.stringify({ method: "genio/interaction/error", params: { message: "待處理項目需要重新載入，請重新連線後再回答。" } }))
            return
          }
          if (message.method === "genio/runtime/start") {
            if (typeof message.params?.accessToken !== "string" || !message.params.accessToken.trim()) {
              sendRuntimePolicyError("GENIO_ONE_SESSION_TOKEN_REQUIRED", undefined, message.id)
              return
            }
            const nextToken = message.params.accessToken.trim()
            try {
              const principal = await verifyGenioOneAccessToken(nextToken)
              if (!runtimeSession || principal.tenant_id !== runtimeSession.principal.tenant_id || principal.subject_id !== runtimeSession.principal.subject_id || principal.acting_client_id !== runtimeSession.principal.acting_client_id) {
                throw new Error("GENIO_ONE_SESSION_REJECTED")
              }
              await assertCapability(capabilityGate, principal, PERSONAL_BOT_USE, nextToken)
              sessionAccessToken = nextToken
              runtimeSession.accessToken = nextToken
              runtimeSession.principal = principal
              await codexRuntime.updateToken?.(nextToken)
              context.botSchedules.resumeAuthorized(principal)
              if (socket.readyState === socket.OPEN && message.id !== undefined) socket.send(JSON.stringify({ id: message.id, result: { ok: true } }))
            } catch (error) {
              const failure = error instanceof Error ? error.message : "GENIO_ONE_SESSION_REJECTED"
              sendRuntimePolicyError(failure, undefined, message.id)
              if (failure.includes("SESSION") && socket.readyState === socket.OPEN) socket.close(1008, failure.slice(0, 120))
            }
            return
          }
          if (message.method === "genio/runtime/status") {
            const session = runtimeSession
            if (!session) return
            if (socket.readyState === socket.OPEN) {
              socket.send(JSON.stringify({
                id: message.id,
                result: {
                  active: runtimeDetailsForClient(session, runtimeDetailsForBot(session, selectedBotId)),
                  tiers: Object.fromEntries(Object.entries(session.runtimeDetails)
                    .filter(([, details]) => details.tier !== "none" && (details.botId ?? details.endpoint?.botId) === selectedBotId)
                    .map(([tier, details]) => [tier, runtimeDetailsForClient(session, details)])),
                  runtimeSessionId: session.id,
                },
              }))
            }
            return
          }
          if (message.method === "genio/bot/select") {
            const session = runtimeSession
            const botId = typeof message.params?.botId === "string" ? message.params.botId : ""
            const selectionVersion = ++botSelectionVersion
            if (selectedBotId !== botId) {
              selectedBotId = null
              if (session) { setBotSelection(session, null); runtimeBroker.refreshWorkspaceDetails(session.id) }
              subscribeConnectionInteractions()
            }
            if (!session || !botId) {
              if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ id: message.id, error: { code: "BOT_REQUIRED", message: "A Bot must be selected" } }))
              return
            }
            const isCurrentSelection = () => !closed && runtimeSession === session && botSelectionVersion === selectionVersion
            const assertCurrentSelection = () => { if (!isCurrentSelection()) throw new Error("BOT_SELECTION_SUPERSEDED") }
            let codexDecision: RuntimePolicyDecision | null = null
            let codexReportAttempted = false
            try {
              const selectedBot = botRegistry.getOwned(botId, session.principal)
              if (!selectedBot) throw new Error("BOT_NOT_FOUND")
              await assertCapability(capabilityGate, session.principal, PERSONAL_BOT_USE, sessionAccessToken ?? undefined)
              assertCurrentSelection()
              const resolvedMcpMounts = await resolveManagedMcpMounts({
                bindings: selectedBot.bindings,
                tenantId: session.principal.tenant_id,
                accessToken: sessionAccessToken ?? session.accessToken,
                onDegraded: (reason) => console.warn(JSON.stringify({
                  event: "bot.managed-mcp.degraded",
                  runtime_session_id: session.id,
                  bot_id: selectedBot.id,
                  reason,
                })),
              })
              assertCurrentSelection()
              const mcpMounts = await authorizeManagedMcpExposure(session, selectedBot.id, resolvedMcpMounts, isCurrentSelection, "ALLOW", "MANAGED_MCP_MOUNT_EXPOSED")
              assertCurrentSelection()
              const usageContext = await resolveBotUsageContext({
                principal: session.principal,
                accessToken: sessionAccessToken ?? session.accessToken ?? "",
                ...(selectedBot.useCaseId ? { useCaseId: selectedBot.useCaseId } : {}),
              })
              assertCurrentSelection()
              if (selectedBot.modelRoute === "genio-gateway" && !usageContext) {
                throw new BotUsageContextError("USE_CASE_REQUIRED", 409)
              }
              if ((selectedBot.ownerOrganizationId || selectedBot.useCaseId) &&
                (!usageContext || selectedBot.ownerOrganizationId !== usageContext.consumerOrganizationId || selectedBot.useCaseId !== usageContext.useCaseId)) {
                throw new BotUsageContextError("USE_CASE_NOT_ALLOWED", 403)
              }
              if (usageContext && !selectedBot.ownerOrganizationId && !selectedBot.useCaseId) {
                botRegistry.setUsageContext(selectedBot.id, session.principal, {
                  ownerOrganizationId: usageContext.consumerOrganizationId,
                  useCaseId: usageContext.useCaseId,
                })
              }
              if (selectedBot.modelRoute === "codex-subscription") {
                codexDecision = await authorizeRuntime(session, selectedBot.id, CODEX_SUBSCRIPTION_CAPABILITY, "use", isCurrentSelection)
              }
              assertCurrentSelection()
              const modelRoute = selectedBot.modelRoute === "genio-gateway"
                ? { kind: "genio-gateway" as const, modelProvider: "genio_one" }
                : { kind: "codex-subscription" as const }
              if (!modelDirectory.supports(modelRoute)) throw new Error("BOT_MODEL_ROUTE_UNAVAILABLE")
              const modelExposure = modelRoute.kind === "genio-gateway"
                ? await runtimePolicy.resolve({
                  principal: session.principal,
                  botId: selectedBot.id,
                  runtimeId: "codex",
                  capabilityId: "model.invoke",
                  action: "expose",
                  sessionId: session.id,
                  accessToken: sessionAccessToken ?? session.accessToken,
                })
                : undefined
              const models = modelRoute.kind === "genio-gateway"
                ? await modelDirectory.resolve(session.principal, selectedBot.id, modelRoute, sessionAccessToken ?? session.accessToken, modelExposure).catch((error) => {
                  if (error instanceof Error && error.message === "BOT_MODEL_NOT_ENTITLED") return []
                  throw error
                })
                : []
              assertCurrentSelection()
              const materialized = botRegistry.materialize(botId, session.principal)
              if (materialized.skillRoots.length > 0) {
                await runtimeBroker.request(session.id, "skills/extraRoots/set", { extraRoots: materialized.skillRoots })
                assertCurrentSelection()
              }
              for (const plugin of materialized.plugins) {
                await runtimeBroker.request(session.id, "plugin/install", {
                  pluginName: plugin.name,
                  ...(plugin.marketplacePath ? { marketplacePath: plugin.marketplacePath } : { remoteMarketplaceName: plugin.marketplace }),
                })
                assertCurrentSelection()
              }
              if (materialized.plugins.length > 0) await runtimeBroker.request(session.id, "plugin/list", { cwds: [materialized.root] })
              if (materialized.skillRoots.length > 0 || materialized.plugins.length > 0) {
                await runtimeBroker.request(session.id, "skills/list", { cwds: [materialized.root], forceReload: true })
              }
              assertCurrentSelection()
              if (codexDecision) {
                codexReportAttempted = true
                if (!await reportRuntimeDecision(session, selectedBot.id, codexDecision, "ALLOW", undefined, isCurrentSelection)) throw new Error("RUNTIME_POLICY_REPORT_UNAVAILABLE")
              }
              assertCurrentSelection()
              selectedBotId = selectedBot.id
              setBotSelection(session, { botId: selectedBot.id, usageContext, mcpMounts })
              runtimeBroker.refreshWorkspaceDetails(session.id)
              subscribeConnectionInteractions()
              if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ id: message.id, result: {
                botId: selectedBot.id,
                modelDirectory: selectedBot.modelRoute,
                models,
                skillRoots: materialized.skillRoots,
                plugins: materialized.plugins.map((plugin) => plugin.name),
              } }))
            } catch (error) {
              if (codexDecision && !codexReportAttempted) await reportRuntimeDecision(session, botId, codexDecision, "FAILED", error instanceof Error ? error.message : "BOT_SELECT_FAILED", isCurrentSelection)
              if (isCurrentSelection()) {
                selectedBotId = null
                setBotSelection(session, null)
                runtimeBroker.refreshWorkspaceDetails(session.id)
                subscribeConnectionInteractions()
                sendRuntimePolicyError(error instanceof Error ? error.message : "BOT_SELECT_FAILED", undefined, message.id)
              } else if (socket.readyState === socket.OPEN) {
                socket.send(JSON.stringify({ id: message.id, error: { code: "BOT_SELECTION_SUPERSEDED", message: "BOT_SELECTION_SUPERSEDED" } }))
              }
            }
            return
          }
          if (message.method === "genio/runtime/ensure" || message.method === "genio/runtime/ensureExec") {
            if (!runtimeSession) {
              sendRuntimePolicyError("RUNTIME_SESSION_NOT_FOUND")
              return
            }
            const session = runtimeSession
            const requestedTier = message.method === "genio/runtime/ensureExec"
              ? "headless"
              : message.params?.tier
            if (requestedTier !== "desktop" && requestedTier !== "headless") {
              sendRuntimePolicyError("RUNTIME_TIER_INVALID")
              return
            }
            const tier: Exclude<RuntimeTier, "none"> = requestedTier
            const requestedBotId = typeof message.params?.botId === "string" ? message.params.botId : undefined
            if (!selectedBotId || (requestedBotId !== undefined && requestedBotId !== selectedBotId)) {
              sendRuntimePolicyError("BOT_NOT_SELECTED", tier)
              return
            }
            const botId = selectedBotId
            let provisionDecision: RuntimePolicyDecision | null = null
            let provisionReportAttempted = false
            const authorizeProvision = async () => {
              if (tier === "desktop") await assertCapability(capabilityGate, session.principal, PERSONAL_BOT_COMPUTER_USE, sessionAccessToken ?? undefined)
              provisionDecision = await authorizeRuntime(session, botId, SHELL_EXEC_CAPABILITY, "expose")
            }
            void authorizeProvision()
              .then(() => {
                if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ method: "genio/runtime/provisioning", params: { tier, botId } }))
                return runtimeBroker.ensure(session.id, tier, botId)
              })
              .then(async (nextSession) => {
                runtimeSession = nextSession
                if (provisionDecision) {
                  provisionReportAttempted = true
                  if (!await reportRuntimeDecision(session, botId, provisionDecision, socket.readyState === socket.OPEN ? "COMPLETED" : "FAILED", socket.readyState === socket.OPEN ? undefined : "RUNTIME_SOCKET_CLOSED")) throw new Error("RUNTIME_POLICY_REPORT_UNAVAILABLE")
                  if (socket.readyState !== socket.OPEN) throw new Error("RUNTIME_SOCKET_CLOSED")
                }
                if (socket.readyState === socket.OPEN) {
                  socket.send(JSON.stringify({
                    method: "genio/runtime/ready",
                    params: {
                      ...nextSession.details,
                      desktopUrl: desktopUrl(nextSession),
                      runtimeSessionId: nextSession.id,
                    },
                  }))
                  socket.send(JSON.stringify({ method: "genio/execReady", params: {
                    ...nextSession.details,
                    desktopUrl: desktopUrl(nextSession),
                    runtimeSessionId: nextSession.id,
                  } }))
                }
              })
              .catch((error) => {
                if (provisionDecision && !provisionReportAttempted) void reportRuntimeDecision(session, botId, provisionDecision, "FAILED", error instanceof Error ? error.message : "RUNTIME_PROVISION_FAILED")
                sendRuntimePolicyError(error instanceof Error ? error.message : tier === "desktop" ? "DESKTOP_START_FAILED" : "HEADLESS_START_FAILED", tier)
              })
            return
          }
          if (message.method === "genio/runtime/stop") {
            const session = runtimeSession
            if (!session) return
            const tier: "desktop" | "headless" | undefined = message.params?.tier === "desktop" || message.params?.tier === "headless" ? message.params.tier : undefined
            if (!selectedBotId) { sendRuntimePolicyError("BOT_NOT_SELECTED", tier, message.id); return }
            const targetLeases = tier ? [session.leases[tier]] : Object.values(session.leases)
            if (targetLeases.some((lease) => lease && (lease.details.botId ?? lease.details.endpoint?.botId) !== selectedBotId) || (!tier && runtimeBroker.hasOtherBotTurn(session.id, selectedBotId))) {
              sendRuntimePolicyError("RUNTIME_WORKSPACE_NOT_OWNED", tier, message.id)
              return
            }
            void runtimeBroker.stop(session.id, tier, selectedBotId)
              .then(() => {
                if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ method: "genio/runtime/stopped", params: {
                  tier: tier ?? "all",
                  active: runtimeSession ? runtimeDetailsForBot(runtimeSession, selectedBotId) : null,
                } }))
              })
              .catch((error) => {
                if (socket.readyState === socket.OPEN) {
                  const failure = error instanceof Error ? error.message : "RUNTIME_STOP_FAILED"
                  socket.send(JSON.stringify({ method: "genio/runtime/error", params: { message: failure } }))
                  socket.send(JSON.stringify({ method: "genio/runtimeError", params: { message: failure } }))
                }
              })
            return
          }
          if (message.method === "environment/add") {
            const params = message.params as { environmentId?: unknown; execServerUrl?: unknown } | undefined
            const owned = runtimeSession ? ownedRuntimeEnvironment(runtimeSession, params?.environmentId, params?.execServerUrl, selectedBotId) : null
            if (!owned) {
              if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ id: message.id, error: { code: runtimeSession?.details.tier === "none" ? "REMOTE_RUNTIME_REQUIRED" : "RUNTIME_ENVIRONMENT_NOT_OWNED", message: "Only a Runtime Broker provisioned environment may be attached" } }))
              return
            }
            if (runtimeSession && selectedBotId) {
              try { await authorizeHandsUse(runtimeSession, selectedBotId, owned) }
              catch (error) {
                if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ id: message.id, error: { code: error instanceof Error ? error.message : "RUNTIME_POLICY_DENIED" } }))
                return
              }
            }
            if (owned.kind === "endpoint") message.params = { ...message.params, execServerUrl: context.localHands!.executorUrl(owned.environmentId!) }
          }
          if (message.method === "environment/info") {
            const params = message.params as { environmentId?: unknown } | undefined
            if (!runtimeSession || !ownedRuntimeEnvironment(runtimeSession, params?.environmentId, undefined, selectedBotId)) {
              if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ id: message.id, error: { code: runtimeSession?.details.tier === "none" ? "REMOTE_RUNTIME_REQUIRED" : "RUNTIME_ENVIRONMENT_NOT_OWNED", message: "Only a Runtime Broker provisioned environment may be inspected" } }))
              return
            }
          }
          if (message.method === "thread/start" || message.method === "thread/resume" || message.method === "turn/start") {
            const environments = Array.isArray(message.params?.environments) ? message.params.environments : []
            if (environments.length > 0 && (!runtimeSession || environments.some((environment: unknown) => {
              if (!environment || typeof environment !== "object" || Array.isArray(environment)) return true
              return !ownedRuntimeEnvironment(runtimeSession!, (environment as { environmentId?: unknown }).environmentId, undefined, selectedBotId)
            }))) {
              if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ id: message.id, error: { code: runtimeSession?.details.tier === "none" ? "REMOTE_RUNTIME_REQUIRED" : "RUNTIME_ENVIRONMENT_NOT_OWNED", message: "The requested environment is not owned by this Runtime Broker session" } }))
              return
            }
          }
          if (message.method && HOST_EXECUTION_COMMANDS.has(message.method)) {
            if (socket.readyState === socket.OPEN) {
              socket.send(JSON.stringify({
                id: message.id,
                error: {
                  code: "HOST_EXECUTION_FORBIDDEN",
                  message: "Direct host execution is forbidden. All execution must be scoped within a sandboxed environment turn.",
                },
              }))
            }
            return
          }
          if (message.method === "initialize" && runtimeSession?.initialized) {
            if (socket.readyState === socket.OPEN) {
              socket.send(JSON.stringify({
                id: message.id,
                result: runtimeSession.initializeResult ?? {
                  capabilities: { experimentalApi: true },
                  serverInfo: { name: "codex-app-server", version: "0.1.0" },
                },
              }))
            }
            return
          }
          if (message.method === "initialized" && runtimeSession?.initialized) {
            return
          }
          if (message.method === "feedback/upload") {
            emitBotFeedbackLog(message.params)
          }
          if (message.method && (message.method === "thread/start" || typeof message.params?.threadId === "string")) {
            const requiresExecutionReport = message.method === "thread/start" || message.method === "thread/resume" || message.method === "turn/start"
            if (requiresExecutionReport && message.id === undefined) {
              sendRuntimePolicyError("RUNTIME_REQUEST_ID_REQUIRED")
              return
            }
            if ((message.method === "turn/start" || message.method === "turn/steer") && typeof message.params?.clientUserMessageId === "string" && /^(handoff-(result|task)|question-answer):/.test(message.params.clientUserMessageId)) {
              socket.send(JSON.stringify({ id: message.id, error: { code: "BOT_INTERNAL_INPUT_RESERVED" } }))
              return
            }
            const botId = selectedBotId
            const threadId = message.params?.threadId
            if (!runtimeSession || !botId || !botRegistry.getOwned(botId, runtimeSession.principal) || (threadId && !botRegistry.ownsThread(runtimeSession.principal, botId, threadId))) {
              socket.send(JSON.stringify({ id: message.id, error: { code: "BOT_THREAD_NOT_OWNED", message: "這個執行段不屬於目前的 Bot" } }))
              return
            }
            const authorizations: RuntimePolicyDecision[] = []
            const isNativeExecutionRequest = message.method === "thread/start" || message.method === "thread/resume" || message.method === "turn/start"
            let nativeExposure: NativeRuntimeExposure | null = null
            let nativeEnvironment: NativeRuntimeEnvironment | null = null
            try {
              await assertCapability(capabilityGate, runtimeSession.principal, PERSONAL_BOT_USE, sessionAccessToken ?? undefined)
              const selectedBot = botRegistry.getOwned(botId, runtimeSession.principal)
              if (!selectedBot) throw new Error("BOT_NOT_FOUND")
              if (selectedBot.modelRoute === "codex-subscription") {
                authorizations.push(await authorizeRuntime(runtimeSession, botId, CODEX_SUBSCRIPTION_CAPABILITY, "use"))
              }
              if (isNativeExecutionRequest) {
                nativeEnvironment = nativeRuntimeEnvironment(runtimeSession, message.params, botId)
                nativeExposure = await readNativeRuntimeExposure({
                  runtimePolicy,
                  session: runtimeSession,
                  botId,
                  accessToken: sessionAccessToken ?? runtimeSession.accessToken,
                })
              }
              if (isNativeExecutionRequest && nativeEnvironment?.hasRuntimeEnvironment) {
                const environments = Array.isArray(message.params?.environments) ? message.params.environments : []
                for (const environment of environments) {
                  const details = ownedRuntimeEnvironment(runtimeSession, environment?.environmentId, undefined, botId)
                  if (details) await authorizeHandsUse(runtimeSession, botId, details)
                }
                authorizations.push(await authorizeRuntime(runtimeSession, botId, SHELL_EXEC_CAPABILITY, runtimeExecutionAction(SHELL_EXEC_CAPABILITY)))
              }
            } catch (error) {
              await Promise.all(authorizations.map((decision) => reportRuntimeDecision(runtimeSession!, botId, decision, "FAILED", error instanceof Error ? error.message : "RUNTIME_POLICY_DENIED")))
              sendRuntimePolicyError(error instanceof Error ? error.message : "RUNTIME_POLICY_DENIED", undefined, message.id)
              return
            }
            if (message.method === "thread/start" || message.method === "thread/resume" || message.method === "turn/start") {
              try {
                if (!nativeExposure || !nativeEnvironment) throw new Error("RUNTIME_POLICY_RESPONSE_INVALID")
                message.params = await canonicalizeNativeParams({ method: message.method, params: message.params, session: runtimeSession, botId, exposure: nativeExposure, environment: nativeEnvironment, botRegistry, modelDirectory, accessToken: sessionAccessToken ?? runtimeSession.accessToken })
              } catch (error) {
                await Promise.all(authorizations.map((decision) => reportRuntimeDecision(runtimeSession!, botId, decision, "FAILED", error instanceof Error ? error.message : "RUNTIME_PARAMS_INVALID")))
                sendRuntimePolicyError(error instanceof Error ? error.message : "RUNTIME_PARAMS_INVALID", undefined, message.id)
                return
              }
            }
            if (message.method === "turn/start" && message.id !== undefined) {
              const release = runtimeBroker.claimBotTurn(botId, runtimeSession.id)
              if (!release || botRegistry.timeline.hasRunningTurns(botId)) {
                release?.()
                await Promise.all(authorizations.map((decision) => reportRuntimeDecision(runtimeSession!, botId, decision, "FAILED", "BOT_TURN_BUSY")))
                socket.send(JSON.stringify({ id: message.id, error: { code: "BOT_TURN_BUSY", message: "Bot 正在處理工作，請待完成後再送出；輸入已保留。" } }))
                return
              }
              turnClaims.set(message.id, release)
            }
            if (message.id !== undefined) botRequests.set(message.id, { method: message.method, botId, session: runtimeSession, threadId, historyRevision: botRegistry.timeline.revision(), runtimeTier: ownedRuntimeEnvironment(runtimeSession, message.params?.environments?.[0]?.environmentId, undefined, botId)?.tier ?? "none", authorizations })
            if (message.method === "turn/start") message.params.additionalContext = botTurnContext(botRegistry, botId, threadId, message.params.additionalContext ?? {}, botRegistry.getOwned(botId, runtimeSession.principal) ?? undefined, runtimeSession.principal)
            if ((message.method === "thread/start" || message.method === "thread/resume") && sessionAccessToken) {
              const session = runtimeSession
              if (!session) return
              const bot = botRegistry.getOwned(botId, session.principal)
              if (!bot) {
                await Promise.all(authorizations.map((decision) => reportRuntimeDecision(session, botId, decision, "FAILED", "BOT_NOT_FOUND")))
                sendRuntimePolicyError("BOT_NOT_FOUND", undefined, message.id)
                return
              }
              const resolvedMcpMounts = await resolveManagedMcpMounts({
                bindings: bot.bindings,
                tenantId: session.principal.tenant_id,
                accessToken: sessionAccessToken ?? session.accessToken,
                onDegraded: (reason) => console.warn(JSON.stringify({
                  event: "bot.managed-mcp.degraded",
                  runtime_session_id: session.id,
                  bot_id: bot.id,
                  reason,
                })),
              })
              const mcpMounts = await authorizeManagedMcpExposure(session, botId, resolvedMcpMounts, () => true, "COMPLETED", "MANAGED_MCP_CONFIG_INJECTED")
              setManagedMcpMounts(session, botId, mcpMounts)
              const config = { ...message.params.config }
              for (const key of Object.keys(config)) if (isManagedMcpConfigKey(key)) delete config[key]
              if (config.mcp_servers && typeof config.mcp_servers === "object") {
                config.mcp_servers = { ...config.mcp_servers }
                for (const name of Object.keys(config.mcp_servers)) if (isManagedMcpServerName(name)) delete config.mcp_servers[name]
              }
              message.params.config = {
                ...config,
                "features.memories": false,
                "mcp_servers.genio_bot": context.botToolSessions.config(botId, session.principal, session.id),
                ...managedMcpConfig(session.id, botId, mcpMounts),
              }
            }
          } else if (message.id !== undefined && requestAuthorizations.length > 0 && runtimeSession && selectedBotId) {
            botRequests.set(message.id, { method: message.method ?? "unknown", botId: selectedBotId, session: runtimeSession, historyRevision: botRegistry.timeline.revision(), authorizations: requestAuthorizations })
          }
        }
        const { genioBotId: _botId, ...nativeMessage } = message ?? {}
        void codexRuntime.send(JSON.stringify(nativeMessage))
        return
      }
      if (starting) {
        if (!message || (message.method !== "initialize" && message.method !== "initialized")) {
          socket.close(1008, "RUNTIME_BOOTSTRAP_METHOD_FORBIDDEN")
          return
        }
        if (pendingInbound.length >= 100) {
          socket.close(1008, "PENDING_INBOUND_OVERFLOW")
          return
        }
        pendingInbound.push(String(payload))
        return
      }
      if (!message) {
        socket.close(1008, "RUNTIME_BOOTSTRAP_INVALID")
        return
      }
      const accessToken = message.method === "genio/runtime/start" && typeof message.params?.accessToken === "string"
        ? message.params.accessToken.trim()
        : undefined
      if (!accessToken) {
        if (message.method !== "initialize" && message.method !== "initialized") {
          socket.close(1008, "RUNTIME_BOOTSTRAP_METHOD_FORBIDDEN")
          return
        }
        pendingInbound.push(String(payload))
        if (!bootstrapTimer) {
          bootstrapTimer = setTimeout(() => {
            if (!starting && !codexRuntime && socket.readyState === socket.OPEN) {
              socket.close(1008, "GENIO_ONE_SESSION_TOKEN_REQUIRED")
            }
          }, 5000)
        }
        return
      }
      if (bootstrapTimer) {
        clearTimeout(bootstrapTimer)
        bootstrapTimer = null
      }
      starting = true
      return verifyGenioOneAccessToken(accessToken)
        .then(async (principal) => {
          if (closed) throw new Error("SOCKET_CLOSED")
          sessionAccessToken = accessToken
          const policy = await assertCapability(capabilityGate, principal, PERSONAL_BOT_USE, accessToken)
          const bootstrapRoute = policy.model_route === "genio-gateway" && modelDirectory.supports({ kind: "genio-gateway", modelProvider: "genio_one" })
            ? "genio-gateway" as const
            : null
          const models: BotModelPlan[] = []
          const session = await runtimeBroker.start(
            principal,
            runtimeCallbacks,
            (sessionCallbacks, runtimeSessionId, relaySecret) => makeCodexRuntime(accessToken, sessionCallbacks, {
                tenantId: principal.tenant_id,
                subjectId: principal.subject_id,
                actingClientId: principal.acting_client_id,
                runtimeSessionId,
              }, relaySecret),
            accessToken,
          )
          runtimeSession = session
          runtimeSession.principal = principal
          context.botSchedules.resumeAuthorized(principal)
          runtimeSession.modelRoute = bootstrapRoute ?? undefined
          codexRuntime = runtimeBroker.channel(session.id, runtimeCallbacks)
          if (closed) {
            runtimeBroker.detach(session.id, runtimeCallbacks)
            pendingInbound.length = 0
            return
          }
          if (codexRuntime) {
            for (const queued of pendingInbound.splice(0)) {
              void codexRuntime.send(queued)
            }
          }
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({
              method: "genio/codexReady",
              params: { ok: true, models, ...(bootstrapRoute ? { modelDirectory: bootstrapRoute } : {}) },
            }))
            socket.send(JSON.stringify({
              method: "genio/runtimeReady",
              params: {
                ...session.details,
                desktopUrl: desktopUrl(session),
                runtimeSessionId: session.id,
                models,
                ...(bootstrapRoute ? { modelDirectory: bootstrapRoute } : {}),
              },
            }))
            socket.send(JSON.stringify({
              method: "genio/runtime/ready",
              params: {
                ...session.details,
                desktopUrl: desktopUrl(session),
                runtimeSessionId: session.id,
                models,
                ...(bootstrapRoute ? { modelDirectory: bootstrapRoute } : {}),
              },
            }))
          }
        })
        .catch((error) => {
          if (bootstrapTimer) {
            clearTimeout(bootstrapTimer)
            bootstrapTimer = null
          }
          pendingInbound.length = 0
          const failure = error instanceof Error ? error.message : "RUNTIME_START_FAILED"
          const isSessionError = failure.includes("SESSION")
          const isCapabilityDenied = error instanceof CapabilityDeniedError
          const code = isSessionError || isCapabilityDenied ? 1008 : 1011
          if (!codexRuntime && socket.readyState === socket.OPEN) {
            if (isCapabilityDenied) sendRuntimePolicyError(failure)
            socket.close(code, failure.slice(0, 120))
          } else if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ method: "genio/runtime/error", params: { message: failure } }))
            socket.send(JSON.stringify({
              method: "genio/runtimeError",
              params: { message: failure },
            }))
          }
        })
    }
    socket.on("message", payload => {
      let value: Record<string, unknown> | undefined
      try { value = JSON.parse(String(payload)) } catch {}
      const identity = traceIdentity(value?.genioTraceparent)
      if (value) delete value.genioTraceparent
      const tenantId = runtimeSession?.principal.tenant_id ?? process.env.GENIO_ONE_TENANT_ID ?? "unassigned"
      const run = () => observeOperation("genio-one-bot", `rpc.dispatch.${String(value?.method ?? "response")}`, { tenantId, message: value ?? { availability: "INVALID_JSON" } }, () => handleMessage(value ? JSON.stringify(value) : payload))
      if (identity.parentSpanId) void observationContext.run({ traceId: identity.traceId, spanId: identity.parentSpanId, correlationId: identity.traceId, tenantId }, run)
      else void observationContext.exit(run)
    })

    socket.on("close", () => {
      for (const release of turnClaims.values()) release()
      turnClaims.clear()
      closed = true
      if (bootstrapTimer) {
        clearTimeout(bootstrapTimer)
        bootstrapTimer = null
      }
      pendingInbound.length = 0
      for (const pending of botRequests.values()) {
        for (const decision of pending.authorizations) {
          void reportRuntimeDecision(pending.session, pending.botId, decision, "FAILED", "RUNTIME_SOCKET_CLOSED")
        }
      }
      botRequests.clear()
      for (const pendingHost of pendingHostAuthorizations.values()) {
        void reportRuntimeDecision(pendingHost.session, pendingHost.botId, pendingHost.decision, "FAILED", "RUNTIME_SOCKET_CLOSED")
      }
      pendingHostAuthorizations.clear()
      if (runtimeSession) runtimeBroker.detach(runtimeSession.id, runtimeCallbacks)
      connectionUnsubscribe?.()
      connectionUnsubscribe = null
    })
  })
}
