import type { BotServerContext } from "./context"
import type { BotConnectionContinuation } from "./bot-connection-continuations"
import type { RuntimeSession } from "./runtime-broker"
import type { Turn } from "./generated/v2/Turn"
import { assertCapability, PERSONAL_BOT_USE } from "./capability-gate"
import { botTurnContext } from "./bot-context"
import { canonicalizeNativeParams } from "./native-runtime-params"
import { readNativeRuntimeExposure } from "./native-runtime-policy"
import { managedMcpConfig, type ManagedMcpMounts } from "./managed-mcp"
import { refreshManagedMcpConfiguration } from "./routes/codex"

const running = new WeakSet<BotServerContext>()
const automaticResources = new Set(["mail2000", "notion"])

function sourceState(context: BotServerContext, entry: BotConnectionContinuation) {
  const status = context.botRegistry.timeline.turnStatus(entry.botId, entry.sourceThreadId, entry.sourceTurnId)
  if (status === "completed") return "completed" as const
  if (status === "failed" || status === "interrupted") return "cancelled" as const
  return "waiting" as const
}

function sourceIsCurrent(context: BotServerContext, entry: BotConnectionContinuation) {
  return sourceState(context, entry) !== "cancelled" && !context.botRegistry.timeline.hasNewerTurn(entry.botId, entry.sourceThreadId, entry.sourceTurnId)
}

function sourceIsReady(context: BotServerContext, entry: BotConnectionContinuation) {
  return sourceState(context, entry) === "completed" && !context.botRegistry.timeline.hasRunningTurns(entry.botId) && sourceIsCurrent(context, entry)
}

function mcpFailed(statuses: Array<{ name?: unknown; runtimeStatus?: unknown; toolsError?: unknown }>, serverNames: string[]) {
  return serverNames.some((name) => statuses.some((status) => status.name === name && (["failed", "cancelled", "disabled", "authenticationRequired"].includes(String(status.runtimeStatus)) || typeof status.toolsError === "string" && status.toolsError.trim())))
}

function mcpReady(statuses: Array<{ name?: unknown; runtimeStatus?: unknown; toolsError?: unknown }>, serverNames: string[]) {
  return serverNames.length > 0 && serverNames.every((name) => statuses.some((status) => status.name === name && status.runtimeStatus === "connected" && !status.toolsError))
}

function principalFor(entry: BotConnectionContinuation) {
  return {
    tenant_id: entry.tenantId,
    subject_id: entry.ownerSubjectId,
    acting_client_id: "genio-one-bot",
    scopes: ["genioone-invocation"],
  }
}

async function resumeWithManagedMcp(context: BotServerContext, session: RuntimeSession, entry: BotConnectionContinuation, mounts: ManagedMcpMounts) {
  const principal = principalFor(entry)
  const bot = context.botRegistry.getOwned(entry.botId, principal)
  if (!bot) throw new Error("BOT_NOT_FOUND")
  const exposure = await readNativeRuntimeExposure({ runtimePolicy: context.runtimePolicy, session, botId: bot.id, accessToken: session.accessToken })
  const params = await canonicalizeNativeParams({
    method: "thread/resume",
    params: { threadId: entry.sourceThreadId, excludeTurns: true },
    session,
    botId: bot.id,
    exposure,
    environment: { hasRuntimeEnvironment: false, hasDesktopRuntime: false },
    botRegistry: context.botRegistry,
    modelDirectory: context.modelDirectory,
    accessToken: session.accessToken,
  })
  params.config = {
    ...(params.config as Record<string, unknown>),
    ...managedMcpConfig(session.id, bot.id, mounts),
    "mcp_servers.genio_bot": context.botToolSessions.config(bot.id, principal, session.id),
  }
  await context.runtimeBroker.request(session.id, "thread/resume", params)
}

async function startContinuation(context: BotServerContext, session: RuntimeSession, entry: BotConnectionContinuation) {
  const principal = principalFor(entry)
  const bot = context.botRegistry.getOwned(entry.botId, principal)
  if (!bot) throw new Error("BOT_NOT_FOUND")
  const exposure = await readNativeRuntimeExposure({ runtimePolicy: context.runtimePolicy, session, botId: bot.id, accessToken: session.accessToken })
  const params = await canonicalizeNativeParams({
    method: "turn/start",
    params: {
      threadId: entry.sourceThreadId,
      clientUserMessageId: entry.clientId,
      additionalContext: botTurnContext(context.botRegistry, bot.id, entry.sourceThreadId, {}, bot, principal),
      input: [{ type: "text", text: `The user completed the personal connection for ${entry.resourceName}. Continue the original user task with the newly available enterprise tools. This continuation is limited to approved read-only Mail2000 and Notion tools. Do not perform write, modification, or booking actions; use the normal explicit confirmation path before any such action. Do not repeat the connection setup.`, text_elements: [] }],
    },
    session,
    botId: bot.id,
    exposure,
    environment: { hasRuntimeEnvironment: false, hasDesktopRuntime: false },
    botRegistry: context.botRegistry,
    modelDirectory: context.modelDirectory,
    accessToken: session.accessToken,
  })
  return context.runtimeBroker.request(session.id, "turn/start", params) as Promise<{ turn?: { id?: unknown; status?: unknown }; turnId?: unknown }>
}

async function reconcileStartedContinuation(context: BotServerContext, session: RuntimeSession, entry: BotConnectionContinuation) {
  const turns: Turn[] = []
  let cursor: string | undefined
  do {
    const page = await context.runtimeBroker.request(session.id, "thread/turns/list", { threadId: entry.sourceThreadId, cursor, limit: 100, sortDirection: "desc", itemsView: "full" }) as { data?: unknown; nextCursor?: unknown }
    if (Array.isArray(page.data)) turns.push(...page.data as Turn[])
    const next = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : undefined
    if (next && next === cursor) throw new Error("CONNECTION_CONTINUATION_HISTORY_CURSOR_STALLED")
    cursor = next
  } while (cursor)
  return context.botRegistry.connectionContinuations.reconcile(entry, turns)
}

export async function continuePersonalConnections(context: BotServerContext) {
  if (running.has(context)) return
  running.add(context)
  try {
    for (let entry of context.botRegistry.connectionContinuations.pending()) {
      if (!automaticResources.has(entry.resourceId)) {
        context.botRegistry.connectionContinuations.cancel(entry.requestToken, "CONNECTION_CONTINUATION_RESOURCE_NOT_ALLOWED")
        continue
      }
      const principal = principalFor(entry)
      const session = context.runtimeBroker.findByPrincipal(principal)
      if (!session && entry.state === "guarded") {
        context.botRegistry.connectionContinuations.fail(entry.requestToken, "CONNECTION_CONTINUATION_RUNTIME_GONE")
        console.warn(JSON.stringify({ event: "bot.connection.continuation.runtime_gone", bot_id: entry.botId, request_token: entry.requestToken }))
        continue
      }
      if (!session?.initialized || !session.accessToken) continue
      const bot = context.botRegistry.getOwned(entry.botId, principal)
      if (!bot || !context.botRegistry.ownsThread(principal, entry.botId, entry.sourceThreadId)) continue
      if (entry.state === "starting" || entry.state === "running" || entry.state === "guarded") {
        try {
          const reconciled = await reconcileStartedContinuation(context, session, entry)
          if (!reconciled && entry.state === "starting") context.botRegistry.connectionContinuations.retryStarting(entry.requestToken)
        } catch {}
        continue
      }
      const state = sourceState(context, entry)
      if (state === "cancelled" || !sourceIsCurrent(context, entry)) {
        context.botRegistry.connectionContinuations.cancel(entry.requestToken, "CONNECTION_SOURCE_SUPERSEDED")
        continue
      }
      if (!sourceIsReady(context, entry)) continue
      const release = context.runtimeBroker.claimBotTurn(entry.botId, session.id)
      if (!release) continue
      try {
        if (!sourceIsCurrent(context, entry)) {
          context.botRegistry.connectionContinuations.cancel(entry.requestToken, "CONNECTION_SOURCE_SUPERSEDED")
          continue
        }
        if (entry.state === "queued") {
          const access = await assertCapability(context.capabilityGate, principal, PERSONAL_BOT_USE, session.accessToken)
          if (access.model_route !== bot.modelRoute) {
            context.botRegistry.connectionContinuations.fail(entry.requestToken, "BOT_MODEL_ROUTE_CHANGED")
            continue
          }
          const isCurrent = () => context.runtimeBroker.findByPrincipal(principal) === session && sourceIsCurrent(context, entry)
          const mounts = await refreshManagedMcpConfiguration({
            context,
            session,
            botId: bot.id,
            accessToken: session.accessToken,
            isCurrent,
            claimAlreadyHeld: true,
            selectMounts: (available) => Object.fromEntries(Object.entries(available).filter(([resourceId]) => automaticResources.has(resourceId))),
            onReportFailure: () => console.warn(JSON.stringify({ event: "bot.connection.continuation.audit_deferred", bot_id: bot.id, request_token: entry.requestToken })),
          })
          if (!isCurrent()) {
            context.botRegistry.connectionContinuations.cancel(entry.requestToken, "CONNECTION_SOURCE_SUPERSEDED")
            continue
          }
          const serverNames = Object.values(mounts).map((mount) => mount.serverName)
          if (serverNames.length === 0) {
            context.botRegistry.connectionContinuations.fail(entry.requestToken, "MANAGED_MCP_NOT_CONFIGURED")
            continue
          }
          const read = await context.runtimeBroker.request(session.id, "thread/read", { threadId: entry.sourceThreadId })
          if (read.thread?.status?.type === "active" || !isCurrent()) {
            if (!sourceIsCurrent(context, entry)) context.botRegistry.connectionContinuations.cancel(entry.requestToken, "CONNECTION_SOURCE_SUPERSEDED")
            continue
          }
          await resumeWithManagedMcp(context, session, entry, mounts)
          if (!isCurrent()) {
            context.botRegistry.connectionContinuations.cancel(entry.requestToken, "CONNECTION_SOURCE_SUPERSEDED")
            continue
          }
          entry = context.botRegistry.connectionContinuations.markMcpReloaded(entry.requestToken, serverNames)
        }
        if ((entry.state !== "awaiting_mcp" && entry.state !== "retrying") || !sourceIsCurrent(context, entry)) {
          if (!sourceIsCurrent(context, entry)) context.botRegistry.connectionContinuations.cancel(entry.requestToken, "CONNECTION_SOURCE_SUPERSEDED")
          continue
        }
        const status = await context.runtimeBroker.request(session.id, "mcpServerStatus/list", { threadId: entry.sourceThreadId, detail: "toolsAndAuthOnly", limit: 100 }) as { data?: Array<{ name?: unknown; runtimeStatus?: unknown; toolsError?: unknown }> }
        const servers = Array.isArray(status.data) ? status.data : []
        if (mcpFailed(servers, entry.serverNames)) {
          context.botRegistry.connectionContinuations.fail(entry.requestToken, "MANAGED_MCP_UNAVAILABLE")
          continue
        }
        if (!mcpReady(servers, entry.serverNames)) continue
        if (!sourceIsCurrent(context, entry) || !context.botRegistry.connectionContinuations.claim(entry.requestToken)) {
          if (!sourceIsCurrent(context, entry)) context.botRegistry.connectionContinuations.cancel(entry.requestToken, "CONNECTION_SOURCE_SUPERSEDED")
          continue
        }
        try {
          const result = await startContinuation(context, session, entry)
          const turnId = typeof result.turn?.id === "string" ? result.turn.id : typeof result.turnId === "string" ? result.turnId : null
          if (!turnId) throw new Error("CONNECTION_CONTINUATION_TURN_MISSING")
          context.botRegistry.connectionContinuations.started(entry.requestToken, entry.sourceThreadId, turnId)
          context.botRegistry.recordRuntimeEvent(principal, JSON.stringify({ method: "turn/started", params: { threadId: entry.sourceThreadId, turn: { id: turnId, status: result.turn?.status ?? "inProgress", items: [] } } }))
          console.info(JSON.stringify({ event: "bot.connection.continued", bot_id: bot.id, request_token: entry.requestToken, thread_id: entry.sourceThreadId, turn_id: turnId }))
        } catch {
        }
      } catch (error) {
        const code = error instanceof Error ? error.message : "CONNECTION_CONTINUATION_FAILED"
        if (code === "MCP_REFRESH_SUPERSEDED" || code === "MCP_REFRESH_TURN_ACTIVE") context.botRegistry.connectionContinuations.cancel(entry.requestToken, "CONNECTION_SOURCE_SUPERSEDED")
        else console.warn(JSON.stringify({ event: "bot.connection.continuation_deferred", bot_id: entry.botId, request_token: entry.requestToken, reason: code }))
      } finally {
        release()
      }
    }
  } finally {
    running.delete(context)
  }
}
